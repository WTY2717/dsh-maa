/**
 * 抄作业编排：找作业（prts.plus + 练度容差）→ 落盘 → MaaCore 直连执行 → 截图验收。
 *
 * 验收口径（用户定）：任务返回的 done/failed 只代表任务链结束，**必须再截图看是否三星**。
 * 代理指挥锁、干员等级过低弹窗这些坑见 docs/tools/maa-copilot.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import { queryJobs, fetchJob } from './prts/api.js';
import { applyTolerance, summarizeOpers } from './prts/match.js';
import { scanCandidates } from './prts/select.js';
import { resolveStageId, loadStages, displayCode } from './stages.js';
import { loadRoster } from './roster.js';
import { CoreWorker } from './core/driver.js';
import { classify, summarize } from './core/callbacks.js';
import { resolveAdbPath, screencap, ensureConnected } from './adb.js';

/** matchMode 的人话解释（工具输出里直接给模型看）。 */
const MATCH_NOTES = {
  strict: '有完全达标的作业：本结果**没有放宽**任何练度要求',
  relaxed: '没有完全达标的作业：已按容差口径放宽，逐条看 relaxedBecause 与 toleranceNotes',
  none: '严格匹配与放宽都没有命中：换关卡/换时间再找，或核对练度文件',
};

/** 一条作业在工具输出里的脸面。 */
function jobRow({ id, views, job, stageId, patched, file }) {
  return {
    id,
    views,
    title: job?.doc?.title ?? '',
    details: job?.doc?.details ?? '',
    stageId,
    stageName: job?.stage_name ?? stageId,
    opers: (job?.opers ?? []).length,
    actions: (job?.actions ?? []).length,
    patchedRequirements: patched ?? 0,
    operSummary: summarizeOpers(job ?? {}),
    file: file ?? null,
  };
}

/**
 * 按关卡找可抄作业（不消耗理智，只读作业站 + 本地练度表）。
 * @param {object} args
 * @param {string} args.stage 关卡代号（`1-7` / `PR-D-2`）或内部 stageId
 * @param {object} args.cfg 已解析的插件配置
 * @param {number} [args.limit] 最多返回几条（默认 8）
 * @param {boolean} [args.writeFiles] 是否落盘作业文件（默认 true）
 */
export async function findJobs({ stage, cfg, limit = 8, writeFiles = true }) {
  const stages = loadStages(cfg.maaInstallPath);
  if (!stages.ok) return { ok: false, error: `${stages.error}。先用 maa_doctor 检查 MAA 路径` };
  const found = resolveStageId(stages, stage);
  if (!found.stageId) return { ok: false, error: found.error };
  const roster = loadRoster(cfg.rosterPathResolved);
  if (!roster.ok) {
    return { ok: false, error: `练度文件不可用：${roster.error ?? roster.problems.join('；')}`, roster: { path: roster.path, problems: roster.problems } };
  }

  const { items, total } = await queryJobs(found.stageId);
  // 先完全达标、实在没有才放宽（见 src/prts/select.js 顶部注释）
  const { mode, picked, scanned } = scanCandidates({
    items,
    rosterByName: roster.byName,
    stageId: found.stageId,
    stage,
    limit,
  });

  const rows = [];
  if (writeFiles) fs.mkdirSync(cfg.jobsDir, { recursive: true });
  for (const p of picked) {
    if (rows.length >= limit) break;
    let job;
    try { job = await fetchJob(p.id); } catch (e) {
      rows.push({ id: p.id, views: p.views, title: p.title, error: `拉取全文失败: ${e.message}` });
      continue;
    }
    if (!(job.actions ?? []).length) continue; // 列表接口的元数据作业喂 MAA 会 CopilotFileReadError
    // 严格命中时原样落盘（压根不放宽）；只有 relaxed 模式才改 requirements
    const tol = mode === 'relaxed' ? applyTolerance(job) : { applied: 0, notes: [] };
    let file = null;
    if (writeFiles) {
      file = path.join(cfg.jobsDir, `${String(stage).replace(/[^\w-]/g, '_')}_${p.id}.json`);
      fs.writeFileSync(file, JSON.stringify(job));
    }
    rows.push({
      ...jobRow({ id: p.id, views: p.views, job, stageId: found.stageId, patched: tol.applied, file }),
      relaxedBecause: mode === 'relaxed' ? (p.strictReason ?? null) : null,
      toleranceNotes: tol.notes,
    });
  }

  return {
    ok: true,
    stage: { input: stage, stageId: found.stageId, code: displayCode(stages, found.stageId), matchedBy: found.from },
    matchMode: mode,
    matchNote: MATCH_NOTES[mode] ?? null,
    scanned: { ...scanned, reportedTotal: total ?? null },
    roster: { path: roster.path, format: roster.format, total: roster.total, owned: roster.owned },
    count: rows.length,
    jobs: rows,
  };
}

/**
 * 跑一条作业（MaaCore 直连）。
 * 前置：模拟器在跑、游戏已登录、**停在目标关卡的详情页或编队页**、「代理指挥」是关的。
 */
export async function runCopilot({ jobFile, cfg, dryRun = false, formation = true, formationIndex, timeoutSeconds, popupGuard, onEvent }) {
  const abs = path.resolve(jobFile);
  if (!fs.existsSync(abs)) return { ok: false, error: `作业文件不存在: ${abs}` };
  let job;
  try {
    job = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return { ok: false, error: `作业文件不是合法 JSON: ${e.message}` };
  }
  if (!(job.actions ?? []).length) {
    return { ok: false, error: '作业没有 actions（很可能存的是列表接口的元数据）。用 maa_copilot_find 重新落盘' };
  }
  const params = {
    filename: abs,
    formation: Boolean(formation),
    formation_index: Number(formationIndex) || 0,
  };
  const adb = resolveAdbPath({ configured: cfg.adbPath, hintPath: cfg.maaHint?.adbPath });
  if (!adb.ok) return { ok: false, error: adb.error };
  const extras = connectionExtras(cfg, adb.path);

  const progress = [];
  const worker = new CoreWorker({
    logDir: cfg.logDir,
    nodePath: cfg.nodePath,
    onEvent: (ev) => {
      if (ev.event === 'cb') {
        const info = classify(ev.id, ev.text || '');
        progress.push({ at: new Date().toISOString(), line: summarize(info), failure: info.failure });
        if (progress.length > 400) progress.splice(0, 200);
      }
      onEvent?.(ev);
    },
  });
  const progressLines = () => progress.slice(-40);
  try {
    await worker.start();
    await worker.open({ installDir: cfg.maaInstallPath, userDir: cfg.coreUserDir, extras: { config: cfg.adbConfig, json: extras } });

    if (dryRun) {
      const appended = await worker.append('Copilot', params);
      return {
        ok: true,
        dryRun: true,
        appended,
        params,
        note: '只校验 core 能解析这条作业：没有连接模拟器、没有消耗理智',
      };
    }

    const conn = await worker.connect({
      adbPath: adb.path,
      address: cfg.adbAddress,
      config: cfg.adbConfig,
      extras,
      timeoutMs: 45000,
    });
    if (!conn.connected) {
      return {
        ok: false,
        error: `连接模拟器失败（${cfg.adbAddress}）。确认 MuMu 在跑、adb 地址正确；MAA GUI 同时开着也能连，但别两边跑同一关`,
        progress: progressLines(),
        logFile: worker.logFile,
      };
    }

    const appended = await worker.append('Copilot', params);
    await worker.startTask();
    // 任务结束（成功/失败/超时）后就不该再补点击了：guardClick 每 500ms 检查一次这个标志
    let runFinished = false;
    if (popupGuard ?? cfg.popupGuard) {
      // 「干员等级过低」弹窗必须由另一个核心会话点掉（docs/tools/maa-copilot.md 故障 5）
      // 兜底点击是「发出去不管」的：必须自己吞掉拒绝，否则宿主进程会被未捕获拒绝带走
      void guardClick({
        cfg, adbPath: adb.path, extras, delayMs: 12000,
        shouldRun: () => !runFinished,
      }).catch(() => {});
    }
    const result = await worker.wait((timeoutSeconds ?? cfg.copilotTimeoutSeconds) * 1000);
    runFinished = true;
    const shot = await screencap({ adbPath: adb.path, address: cfg.adbAddress, outFile: path.join(cfg.shotsDir, `copilot-${Date.now()}.png`) });
    // 判定口径：只有「看到任务链完成回调」且没有失败才算 ok；
    // 仅靠 idleExit（连续 5 秒没在跑）可能压根没开打，不能当成功。
    const sawCompletion = result.sawCompletion ?? false;
    const status = result.failed ? 'failed'
      : sawCompletion ? 'completed'
        : result.timedOut ? 'timeout'
          : result.idleExit ? 'idle-exit(unknown)'
            : 'ended-unknown';
    return {
      ok: !result.failed && sawCompletion,
      status,
      done: result.done,
      failed: result.failed,
      running: result.running,
      timedOut: result.timedOut ?? false,
      idleExit: result.idleExit ?? false,
      sawCompletion,
      callbacks: result.callbacks,
      taskId: appended.taskId,
      job: {
        file: abs,
        stage: job.stage_name,
        title: job.doc?.title ?? '',
        opers: (job.opers ?? []).length,
        actions: job.actions.length,
        operSummary: summarizeOpers(job),
      },
      screenshot: shot.ok ? { file: shot.file, bytes: shot.bytes } : { error: shot.error },
      verifyHint: '任务返回只代表任务链结束：用 read_image 看截图确认是否三星；不是三星就换作业（不要重跑同一条）',
      progress: progressLines(),
      logFile: worker.logFile,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), code: e?.code, progress: progressLines(), logFile: worker.logFile };
  } finally {
    // AsstDestroy 可能阻塞，close 内部有 kill 兜底
    await worker.close().catch(() => {});
  }
}

/**
 * 独立会话点一次画面中央（绕过「干员等级过低」弹窗）。
 * `shouldRun()` 在等待与点击前各检查一次：主任务已经结束就不要再点，
 * 否则这一击可能落在结算页/别的界面上（误操作）。
 */
async function guardClick({ cfg, adbPath, extras, delayMs = 12000, shouldRun = () => true }) {
  // 分段睡，等待期间任务结束就立刻退出
  const step = 500;
  for (let waited = 0; waited < delayMs; waited += step) {
    if (!shouldRun()) return;
    await new Promise((r) => setTimeout(r, Math.min(step, delayMs - waited)));
  }
  if (!shouldRun()) return;
  const w = new CoreWorker({ logDir: cfg.logDir, nodePath: cfg.nodePath });
  try {
    await w.start();
    if (!shouldRun()) return;
    await w.open({ installDir: cfg.maaInstallPath, userDir: cfg.coreUserDir, extras: { config: cfg.adbConfig, json: extras } });
    const conn = await w.connect({ adbPath, address: cfg.adbAddress, config: cfg.adbConfig, extras, timeoutMs: 30000 });
    if (conn.connected && shouldRun()) await w.click(640, 360, 1200);
  } catch { /* 兜底点击失败不影响主流程 */ } finally {
    await w.close({ graceMs: 1500 }).catch(() => {});
  }
}

/**
 * 连接 extras：插件设置优先；否则用 MAA gui.new.json 里记的模拟器目录；
 * 再否则从 adb 路径推导（`…\shell\adb.exe` → `…`）。
 */
export function connectionExtras(cfg, adbPath) {
  if (cfg.connectExtras) return cfg.connectExtras;
  const inst = cfg.maaHint?.emulatorPath
    ?? (adbPath && /[\\/]shell[\\/]adb(\.exe)?$/i.test(adbPath) ? path.dirname(path.dirname(adbPath)) : null);
  const clientType = cfg.maaHint?.clientType || 'Official';
  return JSON.stringify({ ...(inst ? { path: inst } : {}), touch: false, client_type: clientType });
}

/** 截图验收（不跑作业，只出图）。 */
export async function verifyScreenshot({ cfg }) {
  const adb = resolveAdbPath({ configured: cfg.adbPath, hintPath: cfg.maaHint?.adbPath });
  if (!adb.ok) return { ok: false, error: adb.error };
  const conn = await ensureConnected(adb.path, cfg.adbAddress);
  const shot = await screencap({ adbPath: adb.path, address: cfg.adbAddress, outFile: path.join(cfg.shotsDir, `verify-${Date.now()}.png`) });
  if (!shot.ok) return { ok: false, error: shot.error, adb: adb.path, connect: conn.output };
  return { ok: true, file: shot.file, bytes: shot.bytes, adb: adb.path, hint: '用 read_image 看这张图判断是否三星' };
}

/** 单次点击（1280×720 坐标系），用独立核心会话。 */
export async function clickScreen({ x, y, cfg, onEvent }) {
  const adb = resolveAdbPath({ configured: cfg.adbPath, hintPath: cfg.maaHint?.adbPath });
  if (!adb.ok) return { ok: false, error: adb.error };
  const extras = connectionExtras(cfg, adb.path);
  const w = new CoreWorker({ logDir: cfg.logDir, nodePath: cfg.nodePath, onEvent });
  try {
    await w.start();
    await w.open({ installDir: cfg.maaInstallPath, userDir: cfg.coreUserDir, extras: { config: cfg.adbConfig, json: extras } });
    const conn = await w.connect({ adbPath: adb.path, address: cfg.adbAddress, config: cfg.adbConfig, extras, timeoutMs: 45000 });
    if (!conn.connected) return { ok: false, error: '连接模拟器失败，没有点击' };
    const r = await w.click(x, y, 1500);
    return { ok: true, clicked: r.clicked, coordinateSystem: '1280x720' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), code: e?.code };
  } finally {
    await w.close().catch(() => {});
  }
}
