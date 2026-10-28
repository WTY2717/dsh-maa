#!/usr/bin/env node
/**
 * 可编程任务链（src/chain.js）与小工具（src/toolbox.js）单测：**不连 MAA / 不连模拟器**。
 *
 * 用假 CoreWorker 喂真实回调 fixture（`test/fixtures/operbox-20003.json` 是 2026-10-28
 * 真机 OperBox 回调：工具端到端跑完的最后一条 20003，463 个干员、177 个已拥有；depot 同理）。
 *
 * 锁住的口径：
 *  1. `maa_chain` 白名单校验、params 必须是对象、dryRun 只 append 不 startTask/不 connect；
 *  2. 任务按顺序 append 到**同一个** worker，startTask 只调一次；
 *  3. 结束判定认 id=3（AllTasksCompleted 没有 `what` 字段，实测）；
 *  4. 失败/超时/append 拒绝都不抛，CoreWorker 必须 close；
 *  5. OperBox/Depot 结果解析（最后一条 20003）、结果裁剪与完整落盘；
 *  6. background 走 runner（label=chain），工具层不重复埋点；阻塞链埋一次 Custom；
 *  7. 抽卡走远程桥（Toolbox-GachaOnce/TenTimes），不直连 core。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChain, validateChainTasks, CORE_TASK_TYPES, chainHint } from '../src/chain.js';
import { recognizeOperBox, recognizeDepot, recognizeVideo, runGacha, clampTimeoutSeconds, TOOLBOX_TIMEOUT_DEFAULTS } from '../src/toolbox.js';
import { createTools } from '../src/tools.js';
import { runnerLabelToTaskType } from '../src/task-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(HERE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-toolbox-'));
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
const OPERBOX_EVENT = { id: 20003, details: readFixture('operbox-20003.json') };
const DEPOT_EVENT = { id: 20003, details: readFixture('depot-20003.json') };

let pass = 0;
const fails = [];
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fails.push({ name, error: String(e?.message || e) });
    console.log(`  FAIL ${name}: ${e?.message || e}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);

/* ────────────────────── 假 CoreWorker ────────────────────── */

class FakeWorker {
  static created = 0;
  static last = null;
  static nextWaitHook = null;
  static nextConnect = null;
  static nextAppendError = null;

  constructor(opts = {}) {
    FakeWorker.created += 1;
    FakeWorker.last = this;
    this.opts = opts;
    this.logFile = 'fake-core.log';
    this.appended = [];
    this.started = false;
    this.startedTask = false;
    this.connected = false;
    this.closed = false;
    this.sleepMs = 0;
    this.connectResult = FakeWorker.nextConnect ?? { connected: true };
    this.appendError = FakeWorker.nextAppendError;
    this.onWait = FakeWorker.nextWaitHook;
    FakeWorker.nextWaitHook = null;
    FakeWorker.nextConnect = null;
    FakeWorker.nextAppendError = null;
  }
  async start() { this.started = true; }
  async open(args) { this.opened = args; }
  async connect(args) { this.connectArgs = args; this.connected = true; return this.connectResult; }
  async append(type, params) {
    if (this.appendError && this.appendError[type]) throw new Error(this.appendError[type]);
    this.appended.push({ type, params });
    return { taskId: this.appended.length };
  }
  async startTask() { this.startedTask = true; }
  async wait(ms) {
    this.waitedMs = ms;
    if (this.onWait) { const fn = this.onWait; this.onWait = null; fn(this); }
    if (this.sleepMs) await new Promise((r) => setTimeout(r, this.sleepMs));
    return { sawCompletion: false, failed: false };
  }
  async close() { this.closed = true; }
  emit(id, details) { this.opts.onEvent?.({ event: 'cb', id, text: JSON.stringify(details ?? {}), details: details ?? {} }); }
}

const cfg = {
  adbPath: '',
  adbAddress: '127.0.0.1:16384',
  adbConfig: 'MuMuEmulator12',
  maaInstallPath: path.join(TMP, 'fake-maa'),
  maaHint: { adbPath: 'D:/fake/adb.exe', clientType: 'Official' },
  coreUserDir: path.join(TMP, 'core-user'),
  logDir: path.join(TMP, 'logs'),
  jobsDir: path.join(TMP, 'jobs'),
  nodePath: '',
};
const deps = (overrides = {}) => ({
  CoreWorker: FakeWorker,
  resolveAdbPath: () => ({ ok: true, path: 'D:/fake/adb.exe', source: 'test' }),
  connectionExtras: () => '{}',
  ...overrides,
});
const emitAll = (w, pairs) => { for (const [id, details] of pairs) w.emit(id, details); };
const resetWorker = () => { FakeWorker.nextWaitHook = null; FakeWorker.nextConnect = null; FakeWorker.nextAppendError = null; };

/* ────────────────────── 1. 参数校验 ────────────────────── */
section('1. maa_chain 参数校验');
await test('合法任务：params 省略归一成 {}，类型白名单齐全', () => {
  const r = validateChainTasks([{ type: 'Infrast' }, { type: 'Recruit', params: { times: 4 } }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks, [{ type: 'Infrast', params: {} }, { type: 'Recruit', params: { times: 4 } }]);
  for (const t of ['StartUp', 'CloseDown', 'Fight', 'Recruit', 'Infrast', 'Mall', 'Award', 'Roguelike', 'Copilot', 'SSSCopilot', 'Depot', 'OperBox', 'VideoRecognition', 'Reclamation', 'Custom', 'SingleStep']) {
    assert.ok(CORE_TASK_TYPES.includes(t), `白名单缺 ${t}`);
  }
});
await test('未知类型直接拒绝，并列可用类型', () => {
  const r = validateChainTasks([{ type: 'Fight' }, { type: 'Nope' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /tasks\[1\]\.type 不支持/);
  assert.ok(r.available.includes('Fight'));
});
await test('params 必须是对象（数组/字符串都拒绝）', () => {
  assert.equal(validateChainTasks([{ type: 'Fight', params: [] }]).ok, false);
  assert.equal(validateChainTasks([{ type: 'Fight', params: 'stage=1-7' }]).ok, false);
});
await test('空数组 / 非数组 / 超过 32 条都拒绝', () => {
  assert.equal(validateChainTasks([]).ok, false);
  assert.equal(validateChainTasks('Fight').ok, false);
  assert.equal(validateChainTasks(Array.from({ length: 33 }, () => ({ type: 'Award' }))).ok, false);
});
await test('危险任务在 dangers/hint 里点名（Fight/StartUp/CloseDown）', () => {
  const r = validateChainTasks([{ type: 'Fight' }, { type: 'StartUp' }, { type: 'CloseDown' }, { type: 'Award' }]);
  assert.deepEqual(r.dangers.map((d) => d.type), ['Fight', 'StartUp', 'CloseDown']);
  const hint = chainHint({ tasks: r.tasks, dryRun: true });
  assert.match(hint, /消耗理智/);
  assert.match(hint, /切换账号/);
  assert.match(hint, /关闭游戏/);
});

/* ────────────────────── 2. 任务链编排 ────────────────────── */
section('2. maa_chain 编排（假 worker）');
await test('dryRun：只 append，不 connect / 不 startTask / 不执行（adb 不可用也能校验）', async () => {
  resetWorker();
  const r = await runChain({
    tasks: [{ type: 'Fight', params: { stage: '1-7', times: 3 } }, { type: 'Award' }],
    dryRun: true,
    cfg,
    deps: deps({ resolveAdbPath: () => ({ ok: false, error: 'no-adb' }) }),
  });
  const w = FakeWorker.last;
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.appended, [{ type: 'Fight', taskId: 1 }, { type: 'Award', taskId: 2 }]);
  assert.equal(w.connected, false, 'dryRun 不应 connect');
  assert.equal(w.startedTask, false, 'dryRun 不应 startTask');
  assert.deepEqual(w.appended.map((a) => a.type), ['Fight', 'Award']);
  assert.equal(w.closed, true);
  assert.match(r.hint, /绝不会执行/);
});
await test('正常链：同一会话按顺序 append、startTask 一次、id=3 判完成', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => emitAll(w, [
    [10001, { taskchain: 'Infrast', taskid: 1 }],
    [10002, { taskchain: 'Infrast', taskid: 1 }],
    [10001, { taskchain: 'Recruit', taskid: 2 }],
    [10002, { taskchain: 'Recruit', taskid: 2 }],
    [3, { finished_tasks: [1, 2], taskchain: 'Recruit' }], // 实测没有 what 字段
  ]);
  const r = await runChain({ tasks: [{ type: 'Infrast' }, { type: 'Recruit', params: { times: 4 } }], cfg, deps: deps() });
  const w = FakeWorker.last;
  assert.equal(r.ok, true);
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.taskIds, [1, 2]);
  assert.deepEqual(w.appended, [{ type: 'Infrast', params: {} }, { type: 'Recruit', params: { times: 4 } }]);
  assert.equal(w.startedTask, true);
  assert.equal(w.closed, true);
  assert.equal(r.taskCompleted, 2);
  assert.equal(r.callbacks, 5);
});
await test('失败回调（TaskChainError 10000）→ status failed，不抛', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => emitAll(w, [[10000, { taskchain: 'Fight', taskid: 1 }], [3, { finished_tasks: [1] }]]);
  const r = await runChain({ tasks: [{ type: 'Fight' }], cfg, deps: deps() });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.ok(r.failure);
  assert.equal(FakeWorker.last.closed, true);
  assert.match(r.hint, /不要自动重试 Fight/);
});
await test('超时：status timeout，worker 仍 close（任务可能还在跑，不自动重试）', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => { w.sleepMs = 400; };
  const r = await runChain({ tasks: [{ type: 'Fight' }], timeoutSeconds: 1, cfg, deps: deps() });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'timeout');
  assert.equal(r.timeout, true);
  assert.equal(FakeWorker.last.closed, true);
  assert.match(r.hint, /可能还在跑/);
});
await test('append 被 core 拒绝：status append-failed，保留已 append 的前缀', async () => {
  resetWorker();
  FakeWorker.nextAppendError = { Recruit: 'AsstAppendTask 返回 0' };
  const r = await runChain({ tasks: [{ type: 'Infrast' }, { type: 'Recruit' }], cfg, deps: deps() });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'append-failed');
  assert.equal(r.failedTask, 'Recruit');
  assert.deepEqual(r.tasks.map((t) => t.type), ['Infrast']);
  assert.equal(FakeWorker.last.startedTask, false);
  assert.equal(FakeWorker.last.closed, true);
});
await test('连不上模拟器：status unreachable，不 append / 不 startTask', async () => {
  resetWorker();
  FakeWorker.nextConnect = { connected: false };
  const r = await runChain({ tasks: [{ type: 'Award' }], cfg, deps: deps() });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'unreachable');
  assert.equal(FakeWorker.last.appended.length, 0);
  assert.equal(FakeWorker.last.startedTask, false);
  assert.equal(FakeWorker.last.closed, true);
});
await test('OperBox 链：structured 只给摘要（463 / 177）', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => emitAll(w, [[20003, OPERBOX_EVENT.details], [3, { finished_tasks: [1] }]]);
  const r = await runChain({ tasks: [{ type: 'OperBox' }], cfg, deps: deps() });
  assert.equal(r.structured.operbox.total, 463);
  assert.equal(r.structured.operbox.ownedCount, 177);
  assert.equal(r.structured.operbox.chars, undefined, '链结果不该带完整数组');
});
await test('Depot 链：structured 摘要（85 种 / done=true）', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => emitAll(w, [[20003, DEPOT_EVENT.details], [3, { finished_tasks: [1] }]]);
  const r = await runChain({ tasks: [{ type: 'Depot' }], cfg, deps: deps() });
  assert.equal(r.structured.depot.totalTypes, 85);
  assert.equal(r.structured.depot.done, true);
  assert.equal(r.structured.depot.totalCount, 1489003);
});
await test('VideoRecognition 链：structured.video 给出作业路径', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => emitAll(w, [
    [20003, { what: 'Finished', class: 'asst::CombatRecordRecognitionTask', details: { filename: 'C:/x/cache/CombatRecord/MaaAI_1-7_a.json' } }],
    [3, { finished_tasks: [1] }],
  ]);
  const r = await runChain({ tasks: [{ type: 'VideoRecognition', params: { filename: 'C:/v/a.mp4' } }], cfg, deps: deps() });
  assert.equal(r.structured.video.file, 'C:/x/cache/CombatRecord/MaaAI_1-7_a.json');
});

/* ────────────────────── 3. 小工具：结果解析与裁剪 ────────────────────── */
section('3. maa_toolbox：识别结果解析');
await test('OperBox：默认 summary + 前 N 条，完整 JSON 落盘', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => emitAll(w, [[20003, OPERBOX_EVENT.details], [3, { finished_tasks: [1] }]]);
  const r = await recognizeOperBox({ cfg, limit: 5, deps: deps() });
  assert.equal(r.ok, true);
  assert.equal(r.total, 463);
  assert.equal(r.ownedCount, 177);
  assert.equal(r.returned, 5);
  assert.equal(r.chars.length, 5);
  assert.equal(r.summary.missingCount, 286);
  assert.match(r.dumpFile, /toolbox-operbox-\d+\.json$/);
  const dump = JSON.parse(fs.readFileSync(r.dumpFile, 'utf8'));
  assert.equal(dump.all_opers.length, 463);
  assert.equal(dump.all_opers[0].name_jp, 'ブレイズ', '完整数据要保留日文名');
});
await test('OperBox：ownedOnly + limit 过滤，只返回已拥有', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => emitAll(w, [[20003, OPERBOX_EVENT.details], [3, {}]]);
  const r = await recognizeOperBox({ cfg, limit: 3, ownedOnly: true, deps: deps() });
  assert.equal(r.ok, true);
  assert.equal(r.returned, 3);
  assert.ok(r.chars.every((c) => c.own === true));
});
await test('OperBox：任务链结束但没拿到列表 → ok false + 可执行建议', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => emitAll(w, [[3, {}]]);
  const r = await recognizeOperBox({ cfg, deps: deps() });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有从回调里解析到干员列表/);
  assert.match(r.advice, /截图/);
});
await test('Depot：按数量倒序、物品名来自 item_index、dump 全量', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => emitAll(w, [[20003, DEPOT_EVENT.details], [3, {}]]);
  const r = await recognizeDepot({ cfg, limit: 3, deps: deps({ itemIndex: { ok: true, count: 482, names: { 4001: '龙门币', 4003: '合成玉' } } }) });
  assert.equal(r.ok, true);
  assert.equal(r.totalTypes, 85);
  assert.equal(r.totalCount, 1489003);
  assert.equal(r.done, true);
  assert.deepEqual(r.items.map((i) => i.id), ['4001', '4003', '2002']);
  assert.equal(r.items[0].name, '龙门币');
  assert.equal(r.itemIndex.loaded, true);
  const dump = JSON.parse(fs.readFileSync(r.dumpFile, 'utf8'));
  assert.equal(dump.items.length, 85);
});
await test('超时钳制：默认 600/900，范围 30~1800', () => {
  assert.equal(clampTimeoutSeconds(undefined, TOOLBOX_TIMEOUT_DEFAULTS.operbox), 600);
  assert.equal(clampTimeoutSeconds(1, TOOLBOX_TIMEOUT_DEFAULTS.video), 30);
  assert.equal(clampTimeoutSeconds(99999, TOOLBOX_TIMEOUT_DEFAULTS.depot), 1800);
});
await test('VideoRecognition：文件不存在直接拒绝，不创建 core 会话', async () => {
  resetWorker();
  const before = FakeWorker.created;
  const r = await recognizeVideo({ cfg, file: path.join(TMP, 'no-such.mp4'), deps: deps() });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'invalid');
  assert.match(r.error, /不存在/);
  assert.equal(FakeWorker.created, before);
});
await test('VideoRecognition：回执 filename → 复制到 jobsDir 并解析作业摘要', async () => {
  resetWorker();
  const srcDir = path.join(TMP, 'core-user', 'cache', 'CombatRecord');
  fs.mkdirSync(srcDir, { recursive: true });
  const video = path.join(TMP, 'battle.mp4');
  fs.writeFileSync(video, 'fake-video');
  const jobFile = path.join(srcDir, 'MaaAI_1-7_battle_20261028.json');
  fs.writeFileSync(jobFile, JSON.stringify({ stage_name: '1-7', minimum_required: 'v4.0.0', doc: { title: 'MAA AI - 1-7' }, opers: [{ name: 'A' }], actions: [{ type: 'Deploy' }, { type: 'Skill' }] }));
  FakeWorker.nextWaitHook = (w) => emitAll(w, [
    [20003, { what: 'Finished', class: 'asst::CombatRecordRecognitionTask', details: { filename: jobFile } }],
    [3, { finished_tasks: [1] }],
  ]);
  const r = await recognizeVideo({
    cfg,
    file: video,
    // 视频识别是纯本地处理：即使 adb 不可用也应该能跑
    deps: deps({ resolveAdbPath: () => ({ ok: false, error: 'no-adb' }) }),
  });
  assert.equal(r.ok, true);
  assert.equal(FakeWorker.last.connected, false, '视频识别不应连接模拟器');
  assert.equal(r.stage, '1-7');
  assert.equal(r.actions, 2);
  assert.equal(r.opers, 1);
  assert.notEqual(r.jobFile, jobFile, '应复制到 jobsDir');
  assert.ok(fs.existsSync(r.jobFile));
  assert.ok(r.jobFile.startsWith(cfg.jobsDir));
});

/* ────────────────────── 4. 抽卡（走桥） ────────────────────── */
section('4. maa_toolbox：抽卡走远程桥');
const fakeBridge = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    health: () => ({ online: true }),
    enqueue(type) { calls.push(type); return { id: 't1', type }; },
    async waitFor(task) { return { ...task, state: 'done', status: 'SUCCESS', file: 'C:/shots/gacha.png' }; },
    ...overrides,
  };
};
await test('times=10 → Toolbox-GachaTenTimes，返回截图路径', async () => {
  const bridge = fakeBridge();
  const r = await runGacha({ bridge, times: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.type, 'Toolbox-GachaTenTimes');
  assert.equal(r.file, 'C:/shots/gacha.png');
  assert.deepEqual(bridge.calls, ['Toolbox-GachaTenTimes']);
});
await test('times 只允许 1/10', async () => {
  const r = await runGacha({ bridge: fakeBridge(), times: 5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /1 或 10/);
});
await test('MAA 不在线 → 拒绝（不 enqueue）', async () => {
  const bridge = fakeBridge({ health: () => ({ online: false }) });
  const r = await runGacha({ bridge, times: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'offline');
  assert.equal(bridge.calls.length, 0);
});
await test('任务丢失 / 等待超时 → ok false 且提示别重发', async () => {
  const lost = await runGacha({ bridge: fakeBridge({ waitFor: async (t) => ({ ...t, state: 'lost', note: 'MAA 没回执' }) }) });
  assert.equal(lost.ok, false);
  assert.match(lost.advice, /不要连续重发/);
  const timeout = await runGacha({ bridge: fakeBridge({ waitFor: async (t) => ({ ...t, state: 'dispatched' }) }), times: 1 });
  assert.equal(timeout.status, 'timeout');
});

/* ────────────────────── 5. 工具层：后台 runner + 任务状态埋点 ────────────────────── */
section('5. maa_chain 工具层（runner / task-state）');
const makeTools = ({ runner = null, state = null, toolDeps = deps() } = {}) => createTools({
  getConfig: () => ({ dataDir: path.join(TMP, 'data') }),
  pkgDir: PKG,
  getBridge: async () => ({}),
  pkgVersion: 'test',
  copilotRunner: runner,
  taskState: state,
  deps: toolDeps,
});

await test('background=true 走 runner（label=chain），不在工具层重复 beginTask', async () => {
  resetWorker();
  const started = [];
  const begin = [];
  const runner = { startJob: (args) => { started.push(args); return { ok: true, runId: 'run-1', label: args.label }; } };
  const tool = makeTools({ runner, state: { beginTask: (...a) => begin.push(a), endTask: () => {} } }).find((t) => t.name === 'maa_chain');
  const r = await tool.execute({ tasks: [{ type: 'Award' }], background: true });
  assert.equal(r.runId, 'run-1');
  assert.equal(started.length, 1);
  assert.equal(started[0].label, 'chain');
  assert.equal(begin.length, 0, '后台链由 runner 钩子记账，工具层不能再 begin');
  assert.match(r.hint, /maa_copilot_status/);
});
await test('阻塞链：taskState 埋点 1 次 begin + 1 次 end（type=Custom，SUCCESS）', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => emitAll(w, [[3, { finished_tasks: [1] }]]);
  const calls = { begin: [], end: [] };
  const state = {
    beginTask: (a) => { calls.begin.push(a); return 'tok-1'; },
    endTask: (a) => { calls.end.push(a); },
  };
  const tool = makeTools({ state }).find((t) => t.name === 'maa_chain');
  const r = await tool.execute({ tasks: [{ type: 'Recruit' }], timeoutSeconds: 30 });
  assert.equal(r.ok, true);
  assert.equal(calls.begin.length, 1);
  assert.deepEqual(calls.begin[0], { type: 'Custom', source: 'core' });
  assert.deepEqual(calls.end, [{ token: 'tok-1', status: 'SUCCESS' }]);
});
await test('dryRun 不埋点（不把校验当成服务任务）', async () => {
  resetWorker();
  const calls = { begin: 0, end: 0 };
  const state = { beginTask: () => { calls.begin += 1; return 't'; }, endTask: () => { calls.end += 1; } };
  const tool = makeTools({ state }).find((t) => t.name === 'maa_chain');
  const r = await tool.execute({ tasks: [{ type: 'Award' }], dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(calls.begin, 0);
  assert.equal(calls.end, 0);
});
await test('runnerLabelToTaskType 增加 chain → Custom（契约不新增枚举）', () => {
  assert.equal(runnerLabelToTaskType('chain'), 'Custom');
  assert.equal(runnerLabelToTaskType('copilot'), 'Copilot');
  assert.equal(runnerLabelToTaskType('account-switch'), 'AccountSwitch');
});

console.log('');
if (fails.length) {
  console.error(`失败 ${fails.length} 项：`);
  for (const f of fails) console.error(` - ${f.name}: ${f.error}`);
  process.exit(1);
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
console.log(`全部通过: ${pass} 通过 / 0 失败`);
