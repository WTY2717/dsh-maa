/**
 * 小工具（`maa_toolbox` 的实现）：干员识别 / 仓库识别 / 视频识别 / 抽卡糖。
 *
 * 干员识别与仓库识别都是 MaaCore 的「扫一屏 → 回调一次」型任务：
 *  - `OperBox`：id=20003、class=asst::OperBoxRecognitionTask、`details.all_opers`（全量 400+ 条，
 *    很慢地扫过整个列表；本机 2026-10-28 端到端实测 463 条 / 177 已拥有 / 28.6s——超时仍给足）；
 *  - `Depot`：id=20003、class=asst::DepotRecognitionTask、`details.data` 是 JSON **字符串**
 *    （物品 id → 数量）、`details.done` 表示是否扫完；完整结果在最后一条回调里。
 *
 * 视频识别（`VideoRecognition`）：参数键是 `filename`，core 会先检查文件是否存在
 * （不存在时 AsstAppendTask 返回 0）；成功后发 id=20003、what="Finished"，
 * `details.filename` 指向 `<MAA user dir>/cache/CombatRecord/MaaAI_*.json`（就是 Copilot 作业）。
 * 本机没有可用的游戏录像，**成功路径未真机验证**（失败路径已探针确认，见 docs/plans/maa-plugin-plan.md §24）。
 *
 * 抽卡（`gacha`）走已有的远程控制桥（`Toolbox-GachaOnce` / `GachaTenTimes`），不新造轮子；
 * 回执 payload 会被桥落盘成 PNG，返回截图路径给模型 read_image。
 *
 * 所有函数都返回对象、**不抛未捕获异常**；CoreWorker 一律 finally close。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CoreWorker } from './core/driver.js';
import { createEventCollector, parseOperBox, parseDepot, parseVideoResult, loadItemIndex, writeDump } from './core/parsers.js';
import { resolveAdbPath } from './adb.js';
import { connectionExtras } from './copilot.js';

/** 工具支持的动作。 */
export const TOOLBOX_ACTIONS = ['operbox', 'depot', 'video', 'gacha'];

/** 各动作的默认等待秒数（干员/仓库扫描很慢，视频识别更慢）。 */
export const TOOLBOX_TIMEOUT_DEFAULTS = { operbox: 600, depot: 600, video: 900 };

const TIMEOUT_MIN = 30;
const TIMEOUT_MAX = 1800;

/** 秒数钳制：默认值 + 30~1800 秒。 */
export function clampTimeoutSeconds(value, def) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.max(Math.round(n), TIMEOUT_MIN), TIMEOUT_MAX);
}

/** limit 钳制：0（不返回列表）~500，默认 50。 */
function clampLimit(value, def = 50) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(Math.round(n), 500);
}

/**
 * 跑单个 MaaCore 任务，收集完整回调（`structured` 里的 details 未被截断）。
 * `connect=false` 用于视频识别：它只读本地视频文件，不需要模拟器/游戏在线。
 * @returns {Promise<object>} 不抛；失败/超时都在返回值里
 */
async function runOneTask({ cfg, taskType, params, timeoutSeconds, connect = true, onEvent, onReady, deps = {} } = {}) {
  let adb = null;
  let extras = null;
  if (connect) {
    const adbFn = deps.resolveAdbPath ?? resolveAdbPath;
    adb = adbFn({ configured: cfg?.adbPath, hintPath: cfg?.maaHint?.adbPath });
    if (!adb.ok) return { ok: false, status: 'invalid', error: adb.error, events: [], progress: [], callbacks: 0 };
    const extrasFn = deps.connectionExtras ?? connectionExtras;
    extras = extrasFn(cfg, adb.path);
  }
  const collector = createEventCollector({ onEvent });
  const Worker = deps.CoreWorker ?? CoreWorker;
  const worker = new Worker({ logDir: cfg.logDir, nodePath: cfg.nodePath, onEvent: (ev) => collector.push(ev) });
  const startedAt = Date.now();
  const progress = () => collector.progressLines();

  try {
    await worker.start();
    await worker.open({ installDir: cfg.maaInstallPath, userDir: cfg.coreUserDir, extras: connect ? { config: cfg.adbConfig, json: extras } : null });
    if (connect) {
      const conn = await worker.connect({
        adbPath: adb.path,
        address: cfg.adbAddress,
        config: cfg.adbConfig,
        extras,
        timeoutMs: 45000,
      });
      if (!conn.connected) {
        return { ok: false, status: 'unreachable', error: `连接模拟器失败（${cfg.adbAddress}）：模拟器没开/掉线/地址不对`, events: [], progress: progress(), callbacks: 0, logFile: worker.logFile ?? null, elapsedMs: Date.now() - startedAt };
      }
    }
    const appended = await worker.append(taskType, params);
    await worker.startTask();
    if (typeof onReady === 'function') {
      try {
        onReady({ worker, taskId: appended.taskId, progressLines: progress, stopTask: () => worker.stop() });
      } catch (e) {
        onEvent?.({ event: 'onReady-failed', error: String(e?.message || e) });
      }
    }

    const deadline = startedAt + timeoutSeconds * 1000;
    let last = null;
    let timedOut = false;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) { timedOut = !collector.allCompleted() && !collector.failure(); break; }
      last = await worker.wait(Math.min(5_000, Math.max(500, remain)));
      if (collector.allCompleted() || collector.failure() || last?.failed) break;
      if (last?.idleExit) break;
    }
    const failed = Boolean(collector.failure() || last?.failed);
    const completed = Boolean(collector.allCompleted() || last?.sawCompletion);
    const status = failed ? 'failed' : completed ? 'completed' : timedOut ? 'timeout' : last?.idleExit ? 'idle-exit' : 'ended-unknown';
    return {
      ok: completed && !failed,
      status,
      taskId: appended.taskId,
      failed,
      completed,
      timedOut,
      stopped: collector.taskStopped(),
      taskCompleted: collector.taskCompleted(),
      failure: collector.failure(),
      events: collector.structured(),
      callbacks: collector.callbacks(),
      progress: progress(),
      logFile: worker.logFile ?? null,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (e) {
    return {
      ok: false,
      status: 'error',
      error: String(e?.message || e),
      code: e?.code ?? null,
      events: collector.structured(),
      progress: progress(),
      callbacks: collector.callbacks(),
      logFile: worker.logFile ?? null,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await worker.close().catch(() => {});
  }
}

/** 失败时给模型的统一口径（成功返回 null）。 */
function toolboxAdvice({ ok, status, failure } = {}) {
  if (ok) return null;
  if (status === 'unreachable') {
    return '连不上模拟器：先 maa_doctor / maa_emulator({action:"start"})，不要重试到死。';
  }
  if (status === 'timeout') {
    return '等待超时，但任务可能还在跑：先 maa_screenshot 看画面、maa_current 问 MAA；确认卡死再 maa_stop。干员识别本机实测约 30s、仓库约 19s，慢的时候可以调大 timeoutSeconds。';
  }
  if (failure) {
    return `core 报了任务错误（${failure.what ?? failure.id}）：截图确认停在哪一屏；干员/仓库识别要求游戏已登录并在主界面（工具会自己导航，但登录页/公告会挡住）。`;
  }
  return '任务没有正常完成：看 progress 尾部与 logFile；先截图确认界面，再决定是否重试。';
}

/**
 * 干员识别（OperBox）。
 * @param {object} args
 * @param {object} args.cfg 已解析配置
 * @param {number} [args.timeoutSeconds] 默认 600，钳制 30~1800
 * @param {number} [args.limit] 返回多少条（默认 50，0=不返回列表只给 summary）
 * @param {boolean} [args.ownedOnly] 只返回已拥有（默认 false）
 * @param {object} [args.deps] 单测注入 { CoreWorker, resolveAdbPath, connectionExtras }
 */
export async function recognizeOperBox({ cfg, timeoutSeconds, limit, ownedOnly = false, onEvent, onReady, deps = {} } = {}) {
  const timeout = clampTimeoutSeconds(timeoutSeconds, TOOLBOX_TIMEOUT_DEFAULTS.operbox);
  const lim = clampLimit(limit);
  const base = await runOneTask({ cfg, taskType: 'OperBox', params: {}, timeoutSeconds: timeout, onEvent, onReady, deps });
  if (!base.ok) {
    return {
      ok: false,
      action: 'operbox',
      status: base.status,
      error: base.error ?? failureText(base, '干员识别没有完成'),
      ...pickRunMeta(base),
      advice: toolboxAdvice({ ok: false, status: base.status, failure: base.failure }),
    };
  }
  const parsed = parseOperBox(base.events);
  if (!parsed) {
    return {
      ok: false,
      action: 'operbox',
      status: base.status,
      error: '没有从回调里解析到干员列表（id=20003、class=asst::OperBoxRecognitionTask、details.all_opers）',
      ...pickRunMeta(base),
      advice: '识别任务链结束了但没拿到列表：截图看是不是卡在登录/公告/干员列表加载；可重试一次。',
    };
  }
  const byRarity = {};
  const ownedByRarity = {};
  for (const c of parsed.chars) {
    const key = String(c.rarity || 0);
    byRarity[key] = (byRarity[key] ?? 0) + 1;
    if (c.own) ownedByRarity[key] = (ownedByRarity[key] ?? 0) + 1;
  }
  const selected = (ownedOnly ? parsed.chars.filter((c) => c.own) : parsed.chars).slice(0, lim);
  const dump = writeDump(cfg.logDir, 'toolbox-operbox', {
    action: 'operbox',
    at: new Date().toISOString(),
    taskId: base.taskId,
    total: parsed.total,
    ownedCount: parsed.ownedCount,
    // 完整数据（含 name_jp/name_kr/name_tw）：工具结果只给前 N 条，其余从这里读
    all_opers: parsed.raw,
  });
  return {
    ok: true,
    action: 'operbox',
    status: base.status,
    total: parsed.total,
    ownedCount: parsed.ownedCount,
    returned: selected.length,
    limit: lim,
    ownedOnly: Boolean(ownedOnly),
    summary: {
      total: parsed.total,
      ownedCount: parsed.ownedCount,
      missingCount: parsed.total - parsed.ownedCount,
      byRarity,
      ownedByRarity,
    },
    chars: selected,
    dumpFile: dump.ok ? dump.file : null,
    dumpError: dump.ok ? null : dump.error,
    ...pickRunMeta(base),
    ...(partialScanWarning({ action: 'operbox', callbacks: base.callbacks }) ?? {}),
    note: `完整 ${parsed.total} 条在 dumpFile（JSON：all_opers，含日/韩/繁中名）；chars 只返回${ownedOnly ? '已拥有的 ' : ''}前 ${lim} 条。`,
  };
}

function pickRunMeta(base) {
  return {
    taskId: base.taskId ?? null,
    callbacks: base.callbacks ?? 0,
    elapsedMs: base.elapsedMs ?? 0,
    logFile: base.logFile ?? null,
    progress: base.progress ?? [],
    timedOut: Boolean(base.timedOut),
    failure: base.failure ?? null,
  };
}

/**
 * 识别完整性粗判（不是硬判据）：扫完整列表会有几十上百条回调，只扫第一屏时条数很少。
 * 2026-10-28 实测：从主界面跑 OperBox 有 81 条回调/177 个拥有；从干员页直接跑只有 24 条/13 个。
 * 回调数明显偏少时给模型一句 warning，别把不完整的识别结果当准数。
 */
function partialScanWarning({ action, callbacks = 0 } = {}) {
  const threshold = action === 'depot' ? 30 : 40;
  const n = Number(callbacks) || 0;
  if (n >= threshold) return null;
  return {
    warning: `识别只收到 ${n} 条回调（正常应 ≥${threshold}）：很可能只扫了第一屏，结果不完整。请先把游戏切回**主界面**（左上角返回键退到主界面）再重跑一次。`,
    advice: '回主界面后重试；若回调仍明显偏少，用 maa_screenshot 看是不是卡在登录页/公告/弹窗。',
  };
}

/** 失败文案：带上 core 报的失败回调（what / id），不给模型一句没信息量的「没完成」。 */
function failureText(base, fallback) {
  if (base.failure) return `${fallback}：core 报了失败回调（id=${base.failure.id}${base.failure.what ? `, what=${base.failure.what}` : ''}）`;
  if (base.status === 'timeout') return `${fallback}：等待超时（任务可能还在跑，先截图确认）`;
  return fallback;
}

/**
 * 仓库识别（Depot）。物品名从 MAA 的 `resource/item_index.json` 补（读不到就只有 id）。
 * @param {object} args
 * @param {object} args.cfg
 * @param {number} [args.timeoutSeconds] 默认 600，钳制 30~1800
 * @param {number} [args.limit] 返回多少条（默认 50）
 * @param {object} [args.deps] 可注入 `itemIndex` 覆盖（{ok,names,count}）
 */
export async function recognizeDepot({ cfg, timeoutSeconds, limit, onEvent, onReady, deps = {} } = {}) {
  const timeout = clampTimeoutSeconds(timeoutSeconds, TOOLBOX_TIMEOUT_DEFAULTS.depot);
  const lim = clampLimit(limit);
  const index = deps.itemIndex ?? loadItemIndex(cfg?.maaInstallPath);
  const base = await runOneTask({ cfg, taskType: 'Depot', params: {}, timeoutSeconds: timeout, onEvent, onReady, deps });
  if (!base.ok) {
    return {
      ok: false,
      action: 'depot',
      status: base.status,
      error: base.error ?? failureText(base, '仓库识别没有完成'),
      ...pickRunMeta(base),
      advice: toolboxAdvice({ ok: false, status: base.status, failure: base.failure }),
    };
  }
  const parsed = parseDepot(base.events, index?.names ?? null);
  if (!parsed) {
    return {
      ok: false,
      action: 'depot',
      status: base.status,
      error: '没有从回调里解析到仓库数据（id=20003、class=asst::DepotRecognitionTask、details.data）',
      ...pickRunMeta(base),
      advice: '识别任务链结束了但没拿到 data：截图看是不是停在仓库以外的界面（进仓库 → 材料页），可重试一次。',
    };
  }
  const dump = writeDump(cfg.logDir, 'toolbox-depot', {
    action: 'depot',
    at: new Date().toISOString(),
    taskId: base.taskId,
    totalTypes: parsed.totalTypes,
    totalCount: parsed.totalCount,
    done: parsed.done,
    items: parsed.items,
  });
  return {
    ok: true,
    action: 'depot',
    status: base.status,
    totalTypes: parsed.totalTypes,
    totalCount: parsed.totalCount,
    done: parsed.done,
    returned: Math.min(lim, parsed.items.length),
    limit: lim,
    items: parsed.items.slice(0, lim),
    itemIndex: { loaded: Boolean(index?.ok), count: index?.count ?? 0, file: index?.file ?? null },
    dumpFile: dump.ok ? dump.file : null,
    dumpError: dump.ok ? null : dump.error,
    ...pickRunMeta(base),
    ...(partialScanWarning({ action: 'depot', callbacks: base.callbacks }) ?? {}),
    note: `完整 ${parsed.totalTypes} 种物品在 dumpFile；items 按数量倒序返回前 ${lim} 条（物品 id 由 MAA 判定，名称来自 MAA resource/item_index.json）。`,
  };
}

/** 常见视频扩展名（其余扩展名直接拒绝，省得 core 白跑一趟）。 */
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.m4v', '.wmv']);

/**
 * 视频识别（VideoRecognition）：把一段游戏战斗录像转成 Copilot 作业 JSON。
 * 成功后把 core 产出的作业复制到 `cfg.jobsDir`，返回可给 `maa_copilot_run` 用的绝对路径。
 * @param {object} args
 * @param {object} args.cfg
 * @param {string} args.file 视频绝对路径（或相对当前工作目录）
 * @param {number} [args.timeoutSeconds] 默认 900，钳制 30~1800
 */
export async function recognizeVideo({ cfg, file, timeoutSeconds, onEvent, onReady, deps = {} } = {}) {
  const raw = typeof file === 'string' ? file.trim() : '';
  if (!raw) return { ok: false, action: 'video', status: 'invalid', error: '必须给 file（本地游戏录像的绝对路径）' };
  const abs = path.resolve(raw);
  let stat = null;
  try { stat = fs.statSync(abs); } catch { stat = null; }
  if (!stat || !stat.isFile()) return { ok: false, action: 'video', status: 'invalid', error: `视频文件不存在或不是文件: ${abs}` };
  const ext = path.extname(abs).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) {
    return { ok: false, action: 'video', status: 'invalid', error: `不是支持的视频格式（${ext || '无扩展名'}）：只接受 ${[...VIDEO_EXTS].join(' / ')}` };
  }
  const timeout = clampTimeoutSeconds(timeoutSeconds, TOOLBOX_TIMEOUT_DEFAULTS.video);
  const startedAt = Date.now();
  const base = await runOneTask({
    cfg,
    taskType: 'VideoRecognition',
    params: { filename: abs },
    timeoutSeconds: timeout,
    // 视频识别只读本地文件：不连模拟器也能跑（实测 2026-10-28：无 connect 时仍会跑
    // CombatRecordRecognitionTask 并给出 20001/20000/10000 回调）
    connect: false,
    onEvent,
    onReady,
    deps,
  });
  if (!base.ok) {
    return {
      ok: false,
      action: 'video',
      status: base.status,
      error: base.error ?? failureText(base, '视频识别没有完成'),
      videoFile: abs,
      ...pickRunMeta(base),
      advice:
        base.status === 'failed'
          ? 'core 拒绝/识别失败：确认视频是**游戏内战斗录像**（能看到编队、关卡名、战斗过程，横屏 16:9），不是录屏软件的低码率文件。失败路径已探针确认（非视频文件 → CombatRecordRecognitionTask 直接 SubTaskError）。'
          : toolboxAdvice({ ok: false, status: base.status, failure: base.failure }),
    };
  }
  const hit = parseVideoResult(base.events);
  let sourceFile = hit?.file ?? null;
  if (!sourceFile || !fs.existsSync(sourceFile)) {
    // 兜底：有的版本回调不带 filename / 文件被清理，扫 core 用户目录里本次任务之后生成的作业
    sourceFile = findNewestCombatRecord(cfg.coreUserDir, startedAt) ?? sourceFile;
  }
  if (!sourceFile || !fs.existsSync(sourceFile)) {
    return {
      ok: false,
      action: 'video',
      status: base.status,
      error: 'core 没有产出 Copilot 作业 JSON（没有 what="Finished" + details.filename，也没在 core-user/cache/CombatRecord 下找到新文件）',
      videoFile: abs,
      ...pickRunMeta(base),
      advice: '视频识别成功路径**未真机验证**：本机没有可用的游戏录像。先确认识别流程（MAA GUI 的「视频识别」能出作业），再报这个错。',
    };
  }
  let copied = null;
  let copyError = null;
  try {
    fs.mkdirSync(cfg.jobsDir, { recursive: true });
    copied = path.join(cfg.jobsDir, `video-${Date.now()}.json`);
    fs.copyFileSync(sourceFile, copied);
  } catch (e) {
    copyError = String(e?.message || e);
    copied = sourceFile;
  }
  const job = readJobSummary(copied);
  return {
    ok: true,
    action: 'video',
    status: base.status,
    videoFile: abs,
    jobFile: copied,
    sourceFile,
    ...(copyError ? { copyError } : {}),
    ...job,
    ...pickRunMeta(base),
    note: '作业已复制到 jobsDir，可直接给 maa_copilot_run({file: jobFile})；**成功路径未真机验证**（本机没有游戏录像），真跑前先看 jobFile 里的 stage_name/actions 是否符合预期。',
  };
}

/** 作业 JSON 摘要（读失败只返回 warning，不影响文件路径）。 */
function readJobSummary(file) {
  try {
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      stage: typeof job.stage_name === 'string' ? job.stage_name : null,
      title: job.doc?.title ?? null,
      minimumRequired: job.minimum_required ?? null,
      actions: Array.isArray(job.actions) ? job.actions.length : 0,
      opers: Array.isArray(job.opers) ? job.opers.length : 0,
    };
  } catch (e) {
    return { warning: `作业 JSON 解析失败: ${e?.message || e}`, stage: null, actions: 0, opers: 0 };
  }
}

/** 找 core 用户目录里本次任务之后生成的 CombatRecord 作业（视频识别回调缺 filename 时的兜底）。 */
function findNewestCombatRecord(coreUserDir, sinceMs) {
  const dir = path.join(String(coreUserDir || ''), 'cache', 'CombatRecord');
  try {
    const rows = fs.readdirSync(dir)
      .filter((f) => /^MaaAI_.*\.json$/i.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .filter((r) => r.mtime >= sinceMs - 5_000)
      .sort((a, b) => b.mtime - a.mtime);
    return rows[0]?.full ?? null;
  } catch {
    return null;
  }
}

/**
 * 抽卡糖（走远程控制桥，不直连 core）。
 * @param {object} args
 * @param {object} args.bridge 远程控制桥实例
 * @param {1|10} [args.times] 1 或 10（默认 1）
 * @param {number} [args.timeoutSeconds] 默认 120，钳制 30~300
 * @returns {Promise<object>} 回执后返回截图文件（桥会把 payload 落盘成 PNG）
 */
export async function runGacha({ bridge, times = 1, timeoutSeconds } = {}) {
  const n = Number(times);
  if (n !== 1 && n !== 10) return { ok: false, action: 'gacha', status: 'invalid', error: `times 只支持 1 或 10（收到 ${JSON.stringify(times)}）` };
  if (!bridge || typeof bridge.enqueue !== 'function' || typeof bridge.waitFor !== 'function') {
    return { ok: false, action: 'gacha', status: 'invalid', error: '远程控制桥不可用（MAA 的「远程控制」端点没配好）：先 maa_health / maa_doctor' };
  }
  let health = null;
  try { health = typeof bridge.health === 'function' ? bridge.health() : null; } catch { health = null; }
  if (health && health.online === false) {
    return {
      ok: false,
      action: 'gacha',
      status: 'offline',
      error: 'MAA 没有在轮询本机桥（超过 5 秒没取任务）：MAA 没开或「远程控制」端点没配成本机地址',
      bridge: health,
      advice: '如实告诉用户，不要反复重试；抽卡会消耗游戏内资源，先确认 MAA 在线再动手。',
    };
  }
  const type = n === 10 ? 'Toolbox-GachaTenTimes' : 'Toolbox-GachaOnce';
  const seconds = Math.min(Math.max(Number(timeoutSeconds) || 120, 30), 300);
  try {
    const task = bridge.enqueue(type);
    const r = await bridge.waitFor(task, seconds * 1000);
    if (r.state === 'done') {
      const ok = r.status === 'SUCCESS' || r.status == null;
      return {
        ok,
        action: 'gacha',
        status: 'done',
        times: n,
        type,
        taskId: r.id,
        result: r.status ?? null,
        file: r.file ?? null,
        note: ok
          ? '抽卡回执成功：截图是抽卡结果页（用 read_image 看），产物/合成玉变化以游戏为准。'
          : `MAA 回报 ${r.status ?? '未知状态'}：看截图确认停在哪一屏。`,
      };
    }
    if (r.state === 'lost') {
      return { ok: false, action: 'gacha', status: 'lost', times: n, type, taskId: r.id, note: r.note ?? 'MAA 没有回执（任务丢了）', advice: '先 maa_screenshot 看画面；不要连续重发抽卡（可能已经抽了，重发会再花资源）。' };
    }
    return { ok: false, action: 'gacha', status: 'timeout', times: n, type, taskId: r.id, note: `等待抽卡回执超过 ${seconds}s（state=${r.state}）`, advice: '抽卡动画可能还在跑：先 maa_screenshot 看画面，别直接重发。' };
  } catch (e) {
    return { ok: false, action: 'gacha', status: 'error', times: n, type, error: String(e?.message || e), advice: '桥/队列异常：先 maa_health 看 MAA 是否在线。' };
  }
}
