/**
 * 可编程 MaaCore 任务链（`maa_chain` 的实现）。
 *
 * 为什么需要它：远程控制协议只能下发 MAA 配置里那套固定队列（`LinkStart`），
 * 想「只刷 1-7 三次不吃药」「只跑基建+公招」「先领奖再刷关」这类临时编排，
 * 只能直连 MaaCore 按顺序 `AsstAppendTask` 再 `AsstStart`。本模块就是这一层的编排：
 * **同一个会话** append 多条任务 → 一次 start → 等整条链结束 → 汇总回调。
 *
 * 口径（踩过的坑）：
 *  - `AllTasksCompleted`（id=3）在 6.20.1 里**没有 `what` 字段**，结束判定必须认 id；
 *    真实样本见 `src/core/parsers.js` 的注释与 docs/plans/maa-plugin- plan §24。
 *  - 失败看 id 1/10000/20000（InternalError / TaskChainError / SubTaskError）；
 *    超时只代表「等太久了」，**不代表任务没在跑**，所以返回值里给 timeout + 回调尾部，
 *    让模型先截图再决定，绝不自动重试（Fight 重发会重复扣理智）。
 *  - `dryRun` 只 append 不 startTask、不 connect：校验任务名/参数 core 能不能接受，
 *    绝不执行、不消耗理智。
 *  - CoreWorker 必须在 finally 里 close（AsstDestroy 可能阻塞，driver 里有 kill 兜底）。
 *
 * 危险任务（Fight / StartUp / CloseDown）只在描述与 hint 里提示，**不在代码里弹确认**：
 * 「真实消耗前先问用户」是模型侧文档口径，由工具描述与 SKILL 约束。
 */
import path from 'node:path';
import { CoreWorker } from './core/driver.js';
import { createEventCollector, parseOperBox, parseDepot, parseVideoResult } from './core/parsers.js';
import { resolveAdbPath } from './adb.js';
import { connectionExtras } from './copilot.js';

/** MaaCore 支持、且允许经 `maa_chain` 下发的任务类型（顺序同 dll 字符串）。 */
export const CORE_TASK_TYPES = [
  'StartUp',
  'CloseDown',
  'Fight',
  'Recruit',
  'Infrast',
  'Mall',
  'Award',
  'Roguelike',
  'Copilot',
  'SSSCopilot',
  'Depot',
  'OperBox',
  'VideoRecognition',
  'Reclamation',
  'Custom',
  'SingleStep',
];

/** 有真实代价/会改变游戏状态的任务：描述与 hint 里必须写明。 */
export const DANGEROUS_TASKS = {
  Fight: '会刷关**消耗理智**（吃药/碎石按 params 里的配置执行），也可能改变代理指挥',
  StartUp: '会启动/唤醒游戏，params 里带 account_name 时会**切换账号（登出当前账号）**',
  CloseDown: '会**关闭游戏**（当前界面/未结算的战斗会没）',
};

/** 单条链最多多少个子任务（防模型拼出几百条把一次会话挂死）。 */
export const MAX_CHAIN_TASKS = 32;

/** 链默认等待时间（秒）与钳制范围。 */
export const DEFAULT_CHAIN_TIMEOUT_SECONDS = 900;
const MIN_CHAIN_TIMEOUT_SECONDS = 1;
const MAX_CHAIN_TIMEOUT_SECONDS = 3600;

/** 校验并归一化任务数组：未知类型直接拒绝并列出可用类型；params 必须是对象。 */
export function validateChainTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return {
      ok: false,
      error: 'tasks 必须是非空数组：例如 [{"type":"Fight","params":{"stage":"1-7","times":3}}]',
      available: [...CORE_TASK_TYPES],
      tasks: [],
      dangers: [],
    };
  }
  if (tasks.length > MAX_CHAIN_TASKS) {
    return { ok: false, error: `tasks 最多 ${MAX_CHAIN_TASKS} 条（收到 ${tasks.length} 条）；拆成多次调用`, available: [...CORE_TASK_TYPES], tasks: [], dangers: [] };
  }
  const out = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const item = tasks[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `tasks[${i}] 必须是对象 {type, params?}`, available: [...CORE_TASK_TYPES], tasks: [], dangers: [] };
    }
    const type = typeof item.type === 'string' ? item.type.trim() : '';
    if (!CORE_TASK_TYPES.includes(type)) {
      return {
        ok: false,
        error: `tasks[${i}].type 不支持: ${JSON.stringify(item.type)}（可用：${CORE_TASK_TYPES.join(' / ')}）`,
        available: [...CORE_TASK_TYPES],
        tasks: [],
        dangers: [],
      };
    }
    let params = item.params;
    if (params === undefined || params === null) params = {};
    if (typeof params !== 'object' || Array.isArray(params)) {
      return { ok: false, error: `tasks[${i}].params 必须是对象（收到 ${Array.isArray(params) ? 'array' : typeof params}）`, available: [...CORE_TASK_TYPES], tasks: [], dangers: [] };
    }
    out.push({ type, params });
  }
  const dangers = out
    .filter((t) => DANGEROUS_TASKS[t.type])
    .map((t) => ({ type: t.type, note: DANGEROUS_TASKS[t.type] }));
  return { ok: true, tasks: out, dangers };
}

/** 给模型看的下一步口径（成功/失败/dryRun/后台各一套）。 */
export function chainHint({ tasks = [], dryRun = false, background = false, status = null } = {}) {
  const dangers = (Array.isArray(tasks) ? tasks : [])
    .filter((t) => DANGEROUS_TASKS[t?.type])
    .map((t) => `- ${t.type}：${DANGEROUS_TASKS[t.type]}`);
  const dangerText = dangers.length
    ? `\n危险任务（真实消耗/改变游戏状态，动手前必须先问用户）：\n${dangers.join('\n')}`
    : '';
  if (dryRun) {
    return (
      'dryRun=true：只把任务 append 给 core 校验（任务名/参数能否被接受），**没有 connect、没有 startTask，绝不会执行**。' +
      '确认 appended 都拿到 taskId 后，去掉 dryRun 再真跑；带 Fight 的链跑前先问用户。' +
      dangerText
    );
  }
  if (background) {
    return (
      '后台任务链已起跑：用 `maa_copilot_status({runId})` 看进度、`maa_copilot_stop({runId})` 随时取消；' +
      '中途用 maa_screenshot + read_image 看画面。**Fight 链掉血要立刻 stop 再去点「暂停 → 退出行动」**（结算前退全退理智）。' +
      dangerText
    );
  }
  if (status === 'timeout') {
    return (
      '等待超时，但**任务可能还在跑**：先 maa_screenshot 看画面、maa_current 问 MAA，别直接重发（Fight 重发会重复消耗理智）。' +
      '确认卡死再 maa_stop。' + dangerText
    );
  }
  if (status === 'failed' || status === 'error') {
    return (
      '任务链没正常完成：看 progress 尾部与 logFile 定位在哪一步；**不要自动重试 Fight**（可能已经打了一半/扣了理智）。' +
      '先用 maa_screenshot 看停在哪个界面。' + dangerText
    );
  }
  return (
    '任务链已结束（status=completed 只代表 core 任务链走完，不代表界面对）：用 maa_screenshot + read_image 验收。' +
    '结构化结果在 structured（OperBox / Depot / VideoRecognition 摘要；完整数据用 maa_toolbox）。' + dangerText
  );
}

/**
 * 执行一条可编程任务链（阻塞；超时上限 timeoutSeconds）。
 *
 * @param {object} args
 * @param {Array<{type:string, params?:object}>} args.tasks 任务数组（按顺序 append）
 * @param {boolean} [args.dryRun] 只 append 不 startTask（也不 connect）
 * @param {object} args.cfg 已解析配置
 * @param {number} [args.timeoutSeconds] 默认 900，钳制 1~3600
 * @param {(ev:any)=>void} [args.onEvent] 回调观察者（后台 runner / 调试用）
 * @param {(ctl:object)=>void} [args.onReady] 后台模式拿 worker/taskIds/stopTask
 * @param {object} [args.deps] 单测注入 { CoreWorker, resolveAdbPath, connectionExtras }
 * @returns {Promise<object>} 永远 resolve；失败/超时都在对象里（不抛未捕获异常）
 */
export async function runChain({ tasks, dryRun = false, cfg, timeoutSeconds, onEvent, onReady, deps = {} } = {}) {
  const checked = validateChainTasks(tasks);
  if (!checked.ok) return { ok: false, status: 'invalid', error: checked.error, available: checked.available, progress: [] };
  const normalized = checked.tasks;
  const dangers = checked.dangers;
  const timeout = Math.min(Math.max(Number(timeoutSeconds) || DEFAULT_CHAIN_TIMEOUT_SECONDS, MIN_CHAIN_TIMEOUT_SECONDS), MAX_CHAIN_TIMEOUT_SECONDS);

  // dryRun 不连模拟器，也就不需要 adb：先把 adb 解析放在需要连接的路径里
  let adb = null;
  let extras = null;
  if (!dryRun) {
    const adbFn = deps.resolveAdbPath ?? resolveAdbPath;
    adb = adbFn({ configured: cfg?.adbPath, hintPath: cfg?.maaHint?.adbPath });
    if (!adb.ok) return { ok: false, status: 'invalid', error: adb.error, tasks: normalized, progress: [] };
    const extrasFn = deps.connectionExtras ?? connectionExtras;
    extras = extrasFn(cfg, adb.path);
  }

  const collector = createEventCollector({ onEvent });
  const Worker = deps.CoreWorker ?? CoreWorker;
  const worker = new Worker({
    logDir: cfg.logDir,
    nodePath: cfg.nodePath,
    onEvent: (ev) => collector.push(ev),
  });
  const startedAt = Date.now();
  /** @type {Array<{type:string, params:object, taskId:number}>} */
  const appended = [];
  const base = () => ({
    tasks: appended,
    callbacks: collector.callbacks(),
    progress: collector.progressLines(),
    logFile: worker.logFile ?? null,
    elapsedMs: Date.now() - startedAt,
  });

  try {
    await worker.start();
    await worker.open({ installDir: cfg.maaInstallPath, userDir: cfg.coreUserDir, extras: dryRun ? null : { config: cfg.adbConfig, json: extras } });

    if (!dryRun) {
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
          status: 'unreachable',
          error: `连接模拟器失败（${cfg.adbAddress}）：模拟器没开/掉线/地址不对`,
          tasks: normalized,
          progress: collector.progressLines(),
          logFile: worker.logFile ?? null,
          elapsedMs: Date.now() - startedAt,
          hint: chainHint({ tasks: normalized, status: 'error' }),
        };
      }
    }

    for (const task of normalized) {
      try {
        const params = normalizeTaskParams(cfg, task.type, task.params);
        const a = await worker.append(task.type, params);
        appended.push({ type: task.type, params, taskId: a.taskId });
      } catch (e) {
        return {
          ok: false,
          status: 'append-failed',
          error: `append ${task.type} 失败: ${e?.message || e}`,
          failedTask: task.type,
          ...base(),
          hint: 'core 拒绝了这条任务：检查 params（例如 Copilot 的 filename 是否存在、Fight 的 stage 是否拼错）。dryRun=true 可以只验证不执行。',
        };
      }
    }

    if (dryRun) {
      return {
        ok: true,
        status: 'dry-run',
        dryRun: true,
        appended: appended.map((t) => ({ type: t.type, taskId: t.taskId })),
        ...base(),
        note: '只 append、没有 startTask、也没有连接模拟器：绝不会执行、不消耗理智',
        hint: chainHint({ tasks: normalized, dryRun: true }),
      };
    }

    await worker.startTask();
    if (typeof onReady === 'function') {
      try {
        onReady({
          worker,
          taskId: appended[0]?.taskId ?? null,
          taskIds: appended.map((t) => t.taskId),
          progressLines: collector.progressLines,
          stopTask: () => worker.stop(),
        });
      } catch (e) {
        onEvent?.({ event: 'onReady-failed', error: String(e?.message || e) });
      }
    }

    const deadline = startedAt + timeout * 1000;
    let last = null;
    let timedOut = false;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) { timedOut = !collector.allCompleted() && !collector.failure(); break; }
      // 5 秒切片：id=3 的结束回调没有 what，worker 的 done 标志看不到，只能靠收集器自己判
      last = await worker.wait(Math.min(5_000, Math.max(500, remain)));
      if (collector.allCompleted() || collector.failure() || last?.failed) break;
      if (last?.idleExit) break;
    }

    const failed = Boolean(collector.failure() || last?.failed);
    const completed = Boolean(collector.allCompleted() || last?.sawCompletion);
    const status = failed ? 'failed' : completed ? 'completed' : timedOut ? 'timeout' : last?.idleExit ? 'idle-exit' : 'ended-unknown';
    const ok = completed && !failed;

    const events = collector.structured();
    const operbox = parseOperBox(events);
    const depot = parseDepot(events);
    const video = parseVideoResult(events);
    const structured = {};
    if (operbox) structured.operbox = { total: operbox.total, ownedCount: operbox.ownedCount };
    if (depot) structured.depot = { totalTypes: depot.totalTypes, totalCount: depot.totalCount, done: depot.done };
    if (video) structured.video = { file: video.file };

    const result = {
      ok,
      status,
      dryRun: false,
      taskIds: appended.map((t) => t.taskId),
      ...base(),
      taskCompleted: collector.taskCompleted(),
      stopped: collector.taskStopped(),
      timeout: timedOut,
      failed,
      failure: collector.failure(),
      structured: Object.keys(structured).length ? structured : null,
      dangers: dangers.length ? dangers : null,
    };
    if (!ok) result.hint = chainHint({ tasks: normalized, status });
    else result.hint = chainHint({ tasks: normalized, status: 'completed' });
    return result;
  } catch (e) {
    return {
      ok: false,
      status: 'error',
      error: String(e?.message || e),
      code: e?.code ?? null,
      ...base(),
      hint: chainHint({ tasks: normalized, status: 'error' }),
    };
  } finally {
    await worker.close().catch(() => {});
  }
}

/** 供工具层把「最多等多久」写进描述/返回（避免两边各写一份）。 */
export const CHAIN_TIMEOUT_RANGE = { min: MIN_CHAIN_TIMEOUT_SECONDS, max: MAX_CHAIN_TIMEOUT_SECONDS, default: DEFAULT_CHAIN_TIMEOUT_SECONDS };

/** 任务链里 Copilot 的 filename 可能是相对路径：按插件 jobsDir 补全（相对路径对 core 无意义）。 */
export function normalizeTaskParams(cfg, type, params) {
  if (type !== 'Copilot' || !params?.filename) return params;
  const file = String(params.filename);
  if (path.isAbsolute(file)) return params;
  if (!cfg?.jobsDir) return params;
  return { ...params, filename: path.join(cfg.jobsDir, file) };
}
