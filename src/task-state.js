/**
 * 任务状态快照（给外部排队用）：原子写 `<dataRoot>/task-state.json`。
 *
 * 为什么要有它：MAA 对外的任务状态只活在本插件进程里，另一个插件（QQ 机器人的 `/liw`
 * 登录排队）看不到。用一个**只读契约文件**解耦：MAA 写、外部读，两边不 import 彼此。
 *
 * 契约（v1，QQ 侧已按它实现，只增不减；见 docs/plans/qqbot-side-integration-spec.md §3）：
 *   version / epoch / pluginVersion / updatedAt / heartbeatAt / known / running / taskType /
 *   source / startedAt / finishedAt / sequence / lastFinishedSeq /
 *   lastFinished{type,status,at} / active[] / coverage
 *
 * 口径（2026-10-27 与 QQ 侧一起冻结）：
 *  - 只统计「有意义的任务」：远程控制桥的 `LinkStart` / `LinkStart-*`、MaaCore 直连的
 *    `Copilot` / `AccountSwitch`（含后台 runner，阻塞调用由工具层埋点）；截图 / 心跳 /
 *    StopTask / Settings-* / Toolbox-* / 点击 / 滑动 / 输入都不算。
 *  - `sequence` 在每次「开始」和「结束」各 +1，进程内单调；`lastFinishedSeq` 是最近一次
 *    「结束」时的 sequence。短任务（两次轮询之间开始又结束）靠 `lastFinishedSeq` 变大补漏。
 *  - `epoch` 每次插件加载都会变（重载/重启后 sequence 归零，外部必须按 epoch 重置缓存）。
 *  - 写盘用「临时文件 + rename」：外部永远读不到半个 JSON。
 *  - `coverage:"plugin-observable"`：**MAA 界面里手点的任务不可见**（只覆盖经本插件下发的）。
 *  - `AccountSwitch` / `LinkStart-WakeUp` 属于交接任务：QQ 侧据此判断「切号结束不算用户服务结束」。
 *
 * 边界：本模块不读 QQ 队列、不发消息、不碰 MaaCore（用户的硬边界）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const TASK_STATE_VERSION = 1;
export const TASK_STATE_FILE = 'task-state.json';
export const COVERAGE = 'plugin-observable';

/** 远程控制桥里算「有意义任务」的类型：`LinkStart` 与 `LinkStart-*`。 */
export const BRIDGE_TASK_TYPE_RE = /^LinkStart(-(Base|WakeUp|Combat|Recruiting|Mall|Mission|AutoRoguelike|Reclamation))?$/;

/** 交接/登录辅助任务（QQ 侧固定字符串比较，见 spec §3.4）。 */
export const HANDOFF_TASK_TYPES = ['AccountSwitch', 'LinkStart-WakeUp'];

/** 远程控制桥任务是否算「有意义」（白名单，spec §3.3）。 */
export function isMeaningfulBridgeTask(type) {
  return BRIDGE_TASK_TYPE_RE.test(String(type ?? ''));
}

/** 后台 runner 的 label → 规范 taskType（Copilot / AccountSwitch / chain 与 niuzza→Custom）。 */
export function runnerLabelToTaskType(label) {
  const s = String(label ?? '');
  if (s === 'copilot') return 'Copilot';
  if (s === 'account-switch') return 'AccountSwitch';
  // 可编程任务链（maa_chain background）在契约里归到 Custom：它可能是任意任务组合，
  // 没有更准确的原生类型；不要在外部契约里新增 'chain'（QQ 侧只认既有枚举）。
  if (s === 'chain') return 'Custom';
  // 牛杂（maa_niuzza background）同样归到 Custom：它的动作最终都是 Custom / OperBox / Depot /
  // Fight / SwitchTheme / OperProgress / Roguelike / Reclamation 的组合，契约里同样不新增 'niuzza'。
  if (s === 'niuzza') return 'Custom';
  return s || 'Job';
}

/** `<dataRoot>/task-state.json`（默认路径；QQ 侧配置可覆盖）。 */
export function taskStateFile(dataRoot) {
  return path.join(String(dataRoot || ''), TASK_STATE_FILE);
}

/** 进程实例 id：每次插件加载都不同（重载/重启即变）。 */
export function makeEpoch(now = Date.now()) {
  return `p-${process.pid}-${Number(now).toString(36)}-${randomBytes(2).toString('hex')}`;
}

/**
 * 建一个任务状态机（内存态 + 定时落盘）。
 *
 * 数据来源三路：
 *  1. 远程控制桥：`getBridgeTasks()` 每 tick 拉一次 `bridge.list(200)`，按状态变化判定开始/结束；
 *  2. 后台 runner：由 index.js 注入 `onBegin/onFinish` 钩子（`beginTask/endTask`）；
 *  3. 阻塞式 MaaCore 调用（抄作业 / 账号切换）：工具层手动 `beginTask({source:'core'})` 埋点。
 *
 * 所有可注入项都是为了单测（假时钟 / 假 bridge / 不开定时器）。
 */
export function createTaskState({
  stateFile,
  pluginVersion = '0.0.0',
  log = () => {},
  now = () => Date.now(),
  epoch = null,
  heartbeatMs = 5000,
  tickMs = 1000,
  writeThrottleMs = 250,
  getBridgeTasks = null,
  interval = true,
} = {}) {
  const file = String(stateFile || '');
  const ep = String(epoch || makeEpoch(now()));
  const hbMs = Math.max(1000, Number(heartbeatMs) || 5000);
  const throttleMs = Math.max(0, Number(writeThrottleMs) || 0);

  /** @type {Map<string, {type:string, source:string, startedAt:number}>} 当前活跃任务（多任务 = running） */
  const active = new Map();
  let sequence = 0;
  let lastFinishedSeq = 0;
  let lastFinished = null;
  let lastSource = null;
  let lastWriteAt = 0;
  let lastHeartbeatAt = 0;
  let pendingWriteAt = 0;
  let writeTimer = null;
  let tickTimer = null;
  let disposed = false;
  let tokenSeq = 0;
  let writeCount = 0;
  let writeError = null;
  /** @type {Map<string, 'active'|'finished'>} 桥任务上次观测到的归类（短任务漏看时靠它补一个「结束」） */
  const seenBridge = new Map();
  /** @type {Map<Function, NodeJS.Timeout>} 长轮询等待者 → 超时定时器（dispose 时要清掉） */
  const waiters = new Map();

  /** 当前内存态（`updatedAt` 用调用方给的写入时刻，避免「先写后变」的歧义）。 */
  const aggregate = (updatedAt = lastWriteAt) => {
    const list = [...active.values()];
    const running = list.length > 0;
    const sources = [...new Set(list.map((a) => a.source))];
    return {
      version: TASK_STATE_VERSION,
      epoch: ep,
      pluginVersion: String(pluginVersion || '0.0.0'),
      updatedAt: updatedAt || null,
      heartbeatAt: lastHeartbeatAt || null,
      known: true,
      running,
      taskType: running ? list[0].type : (lastFinished?.type ?? null),
      source: running ? (sources.length === 1 ? sources[0] : 'mixed') : (lastSource ?? null),
      startedAt: running ? Math.min(...list.map((a) => a.startedAt)) : null,
      finishedAt: lastFinished?.at ?? null,
      sequence,
      lastFinishedSeq,
      lastFinished: lastFinished ? { ...lastFinished } : null,
      active: list.map((a) => ({ type: a.type, source: a.source, startedAt: a.startedAt })),
      coverage: COVERAGE,
      stateFile: file || null,
    };
  };

  /** 立刻原子写盘；失败只记日志（绝不抛，宿主稳定性红线）。 */
  const writeNow = (reason = 'update') => {
    if (!file) return false;
    const at = Number(now()) || 0;
    // 每次成功写盘都算一次「存活心跳」：外部只看文件里的时间戳判 MAA 插件活没活
    lastHeartbeatAt = at;
    const snap = aggregate(at);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${at}`;
      fs.writeFileSync(tmp, `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
      lastWriteAt = at;
      lastHeartbeatAt = at;
      pendingWriteAt = 0;
      writeCount += 1;
      writeError = null;
      return true;
    } catch (e) {
      writeError = String(e?.message || e);
      log(`task-state write failed (${reason}): ${writeError}`);
      return false;
    }
  };

  const flushPending = () => {
    if (!pendingWriteAt) return;
    if (Number(now()) < pendingWriteAt) return;
    writeNow('change');
  };

  /** 状态变化：节流落盘 + 叫醒长轮询方。 */
  const bump = () => {
    if (!file) return;
    const t = Number(now()) || 0;
    if (t - lastWriteAt >= throttleMs) {
      writeNow('change');
    } else if (!pendingWriteAt) {
      pendingWriteAt = lastWriteAt + throttleMs;
      const delay = Math.max(0, pendingWriteAt - t);
      writeTimer = setTimeout(() => {
        writeTimer = null;
        flushPending();
      }, delay);
      writeTimer.unref?.();
    }
    for (const fn of [...waiters.keys()]) {
      try { fn('change'); } catch { /* 回调失败不影响主流程 */ }
    }
  };

  /**
   * 记一个任务开始。
   * @param {object} args
   * @param {string} args.type 规范 taskType（协议 type 原样，或 Copilot / AccountSwitch）
   * @param {string} [args.source] bridge | core
   * @param {string} [args.token] 稳定标识（桥任务 = `bridge:<taskId>`，runner = `runner:<runId>`）；不传则自动生成
   * @param {number} [args.startedAt] 任务实际开始时间（默认 now）
   * @returns {string|null} token（给 endTask 用）
   */
  const beginTask = ({ type, source = 'bridge', token = null, startedAt = null } = {}) => {
    if (disposed) return null;
    const t = String(type ?? '').trim();
    if (!t) return null;
    const key = token ? String(token) : `${source}:${t}:${++tokenSeq}`;
    if (active.has(key)) return key;
    sequence += 1;
    active.set(key, {
      type: t,
      source: String(source || 'bridge'),
      startedAt: Number(startedAt) || Number(now()) || 0,
    });
    bump();
    return key;
  };

  /**
   * 记一个任务结束（只有还活跃的 token 才算）。
   * @returns {object|null} 最近一次结束的 {type,status,at}
   */
  const endTask = ({ token, status = 'SUCCESS', at = null } = {}) => {
    if (!token) return null;
    const key = String(token);
    const a = active.get(key);
    if (!a) return null;
    active.delete(key);
    sequence += 1;
    lastFinishedSeq = sequence;
    const finishedAt = Number(at) || Number(now()) || 0;
    lastFinished = { type: a.type, status: String(status || 'SUCCESS'), at: finishedAt };
    lastSource = a.source;
    bump();
    return { ...lastFinished };
  };

  /**
   * 记一次「结束」事件（不要求有对应的活跃 token）：用于两次轮询之间开始又结束的短任务
   * （桥里直接看到 done，但没看到它 running 过）——外部靠 `lastFinishedSeq` 变大补漏。
   */
  const recordFinished = ({ type, source = 'bridge', status = 'SUCCESS', at = null } = {}) => {
    if (disposed) return null;
    const t = String(type ?? '').trim();
    if (!t) return null;
    sequence += 1;
    lastFinishedSeq = sequence;
    lastFinished = { type: t, status: String(status || 'SUCCESS'), at: Number(at) || Number(now()) || 0 };
    lastSource = String(source || 'bridge');
    bump();
    return { ...lastFinished };
  };

  /** 拉桥任务列表，按状态变化同步 active（queued/dispatched = 在跑，done/lost = 结束）。 */
  const pollBridge = () => {
    if (typeof getBridgeTasks !== 'function') return;
    let tasks;
    try {
      tasks = getBridgeTasks() ?? [];
    } catch (e) {
      log(`task-state bridge poll failed: ${e?.message || e}`);
      return;
    }
    if (!Array.isArray(tasks)) return;
    const present = new Set();
    for (const t of tasks) {
      if (!t || !isMeaningfulBridgeTask(t.type)) continue;
      const token = `bridge:${t.id}`;
      present.add(token);
      if (t.state === 'queued' || t.state === 'dispatched') {
        seenBridge.set(t.id, 'active');
        if (!active.has(token)) {
          beginTask({ type: t.type, source: 'bridge', token, startedAt: t.createdAt ?? t.dispatchedAt ?? null });
        }
      } else if (t.state === 'done' || t.state === 'lost') {
        const status = t.state === 'lost' ? 'FAILED' : (t.status || 'SUCCESS');
        if (active.has(token)) {
          endTask({ token, status, at: t.finishedAt ?? null });
        } else if (seenBridge.get(t.id) !== 'finished') {
          // 两次 tick 之间开始又结束（短任务漏看）：补一个结束事件，让 lastFinishedSeq 变大
          recordFinished({ type: t.type, source: 'bridge', status, at: t.finishedAt ?? null });
        }
        seenBridge.set(t.id, 'finished');
      }
    }
    // 还活跃但已经不在桥列表里的（被 KEEP_TASKS 挤掉/丢了）：当作失败收尾，避免永远 running。
    for (const token of [...active.keys()]) {
      if (token.startsWith('bridge:') && !present.has(token)) endTask({ token, status: 'FAILED', at: null });
    }
    // 桥只保留最近 200 条；观测表跟着清理，避免长会话无限增长
    if (seenBridge.size > 500) {
      for (const key of [...seenBridge.keys()].slice(0, seenBridge.size - 500)) seenBridge.delete(key);
    }
  };

  /** 定时器一次 tick：拉桥 + 心跳。 */
  const tick = () => {
    if (disposed) return { skipped: true, reason: 'disposed' };
    pollBridge();
    const t = Number(now()) || 0;
    if (t - lastHeartbeatAt >= hbMs) writeNow('heartbeat');
    else flushPending();
    return { running: active.size > 0, sequence, writeCount };
  };

  /** 长轮询：等下一次「开始/结束」（最多 ms 毫秒）。 */
  const waitForChange = (ms = 55_000) => new Promise((resolve) => {
    const limit = Math.min(Math.max(Number(ms) || 0, 0), 59_000);
    if (limit <= 0 || disposed) {
      resolve({ changed: false, reason: 'immediate', waitedMs: 0 });
      return;
    }
    const started = Number(now()) || 0;
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      const timer = waiters.get(finish);
      if (timer) clearTimeout(timer);
      waiters.delete(finish);
      resolve({ changed: reason === 'change', reason, waitedMs: Math.max(0, (Number(now()) || 0) - started) });
    };
    // 定时器不 unref：等待期间进程要活着（dispose 会清掉，不会拖住宿主退出）
    waiters.set(finish, setTimeout(() => finish('timeout'), limit));
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    for (const [fn, timer] of [...waiters]) {
      clearTimeout(timer);
      try { fn('dispose'); } catch { /* ignore */ }
    }
    waiters.clear();
    // 最后写一次（心跳随后自然过期，外部按 updatedAt/heartbeatAt 判死）
    writeNow('dispose');
  };

  if (file) writeNow('init');
  if (interval) {
    tickTimer = setInterval(() => {
      try { tick(); } catch (e) { log(`task-state tick failed: ${e?.message || e}`); }
    }, Math.max(250, Number(tickMs) || 1000));
    tickTimer.unref?.();
  }

  return {
    file,
    epoch: ep,
    snapshot: () => aggregate(),
    beginTask,
    endTask,
    tick,
    waitForChange,
    dispose,
    /** 仅供 doctor/调试：最近一次写盘失败原因。 */
    get writeError() { return writeError; },
  };
}
