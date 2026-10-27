#!/usr/bin/env node
/**
 * 任务状态文件（src/task-state.js）单测：不碰 MAA / 模拟器 / 网络 / 真时钟，只读写临时目录。
 *
 * 为什么单独锁：`task-state.json` 是**跨插件契约**（QQ 机器人 /liw 登录排队按
 * docs/plans/qqbot-side-integration-spec.md §3 实现，已经按 v1 字段写完），
 * 改这里的字段/语义等于改两个插件之间的接口。
 *
 * 锁住的口径：
 *  1. 字段齐全（v1）、只增不减；`coverage:"plugin-observable"`。
 *  2. 白名单：只统计 LinkStart* / Copilot / AccountSwitch；截图/心跳/StopTask/Settings、Toolbox 等短任务不算。
 *  3. sequence：开始/结束各 +1；`lastFinishedSeq` 指向最近一次结束；两次 tick 之间开始又结束的短任务靠它补漏。
 *  4. running 聚合：同时两个任务 = running；`source:"mixed"`；`active[]` 逐条列出。
 *  5. epoch 每次加载都变；重载后 sequence 归零、文件 epoch 更新。
 *  6. 原子写：临时文件 + rename，不留 .tmp 残留，JSON 永远可解析；写盘失败不抛。
 *  7. 心跳（heartbeatMs）与状态变化写盘（writeThrottleMs 节流）。
 *  8. waitForChange：状态变化唤醒、超时 changed=false、dispose 也能唤醒。
 *  9. 后台 runner 钩子 / 阻塞式 MaaCore 埋点（beginTask/endTask）。
 * 10. 桥任务从列表消失（被 KEEP_TASKS 挤掉）→ 当失败收尾，不会永远 running。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTaskState,
  isMeaningfulBridgeTask,
  runnerLabelToTaskType,
  taskStateFile,
  HANDOFF_TASK_TYPES,
  TASK_STATE_VERSION,
  COVERAGE,
  makeEpoch,
} from '../src/task-state.js';
import { createCopilotRunner } from '../src/copilot-runner.js';

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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'maa-task-state-'));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeClock = (start = 1_700_000_000_000) => {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; return t; } };
};

/** 造一个任务状态机 + 假 bridge 任务列表。 */
function make({ clock = fakeClock(), tasks = [], writeThrottleMs = 0, heartbeatMs = 5000, epoch, noBridge = false, extra = {} } = {}) {
  const dir = tmpDir();
  const file = taskStateFile(dir);
  const state = createTaskState({
    stateFile: file,
    pluginVersion: '2.1.0',
    epoch,
    now: clock.now,
    interval: false,
    writeThrottleMs,
    heartbeatMs,
    getBridgeTasks: noBridge ? null : () => tasks,
    ...extra,
  });
  return { state, file, dir, clock, tasks };
}

const bridgeTask = (over = {}) => ({
  id: 'task-1',
  type: 'LinkStart-Combat',
  state: 'queued',
  status: null,
  createdAt: 1_700_000_000_000,
  finishedAt: null,
  ...over,
});

section('1. 契约字段');
await test('字段齐全（v1）且初始为空闲', () => {
  const { state, file } = make();
  const snap = state.snapshot();
  assert.equal(snap.version, TASK_STATE_VERSION);
  assert.equal(TASK_STATE_VERSION, 1);
  assert.match(snap.epoch, /^p-\d+-/);
  assert.equal(snap.pluginVersion, '2.1.0');
  assert.equal(snap.known, true);
  assert.equal(snap.running, false);
  assert.equal(snap.taskType, null);
  assert.equal(snap.source, null);
  assert.equal(snap.startedAt, null);
  assert.equal(snap.finishedAt, null);
  assert.deepEqual(snap.active, []);
  assert.equal(snap.sequence, 0);
  assert.equal(snap.lastFinishedSeq, 0);
  assert.equal(snap.lastFinished, null);
  assert.equal(snap.coverage, COVERAGE);
  assert.equal(snap.coverage, 'plugin-observable');
  assert.equal(snap.stateFile, file);
  const onDisk = readJson(file);
  assert.equal(onDisk.epoch, snap.epoch);
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.updatedAt, snap.updatedAt);
  assert.ok(onDisk.updatedAt > 0);
  assert.ok(onDisk.heartbeatAt >= onDisk.updatedAt - 1000);
});

section('2. 白名单（只统计有意义任务）');
await test('LinkStart / LinkStart-* 才算；截图/心跳/StopTask/Settings/Toolbox 都不算', () => {
  for (const t of ['LinkStart', 'LinkStart-Base', 'LinkStart-WakeUp', 'LinkStart-Combat', 'LinkStart-AutoRoguelike']) {
    assert.equal(isMeaningfulBridgeTask(t), true, t);
  }
  for (const t of ['CaptureImage', 'CaptureImageNow', 'HeartBeat', 'StopTask', 'Settings-Stage1', 'Toolbox-GachaOnce', 'click', 'swipe']) {
    assert.equal(isMeaningfulBridgeTask(t), false, t);
  }
});
await test('桥里混着短任务时只把 LinkStart* 记进 active', () => {
  const tasks = [
    bridgeTask({ id: 'a', type: 'LinkStart-Combat', state: 'dispatched' }),
    bridgeTask({ id: 'b', type: 'LinkStart-WakeUp', state: 'queued', createdAt: 1_700_000_000_001 }),
    bridgeTask({ id: 'c', type: 'CaptureImage', state: 'dispatched' }),
    bridgeTask({ id: 'd', type: 'HeartBeat', state: 'dispatched' }),
    bridgeTask({ id: 'e', type: 'Settings-Stage1', state: 'queued' }),
    bridgeTask({ id: 'f', type: 'Toolbox-GachaOnce', state: 'queued' }),
  ];
  const { state } = make({ tasks });
  state.tick();
  const snap = state.snapshot();
  assert.equal(snap.running, true);
  assert.equal(snap.active.length, 2);
  assert.deepEqual(snap.active.map((a) => a.type).sort(), ['LinkStart-Combat', 'LinkStart-WakeUp']);
  assert.equal(snap.taskType, 'LinkStart-Combat');
  assert.equal(snap.source, 'bridge');
  assert.equal(snap.sequence, 2);
});

section('3. 开始/结束计数与 lastFinished');
await test('开始 → running=true，结束 → lastFinished + lastFinishedSeq', () => {
  const clock = fakeClock();
  const tasks = [];
  const { state } = make({ clock, tasks });
  tasks.push(bridgeTask({ state: 'dispatched', createdAt: clock.now() }));
  state.tick();
  let snap = state.snapshot();
  assert.equal(snap.running, true);
  assert.equal(snap.taskType, 'LinkStart-Combat');
  assert.equal(snap.startedAt, clock.now());
  assert.equal(snap.sequence, 1);
  assert.equal(snap.lastFinishedSeq, 0);

  clock.advance(90_000);
  tasks[0] = { ...tasks[0], state: 'done', status: 'SUCCESS', finishedAt: clock.now() };
  state.tick();
  snap = state.snapshot();
  assert.equal(snap.running, false);
  assert.equal(snap.sequence, 2);
  assert.equal(snap.lastFinishedSeq, 2);
  assert.deepEqual(snap.lastFinished, { type: 'LinkStart-Combat', status: 'SUCCESS', at: clock.now() });
  assert.equal(snap.finishedAt, clock.now());
  assert.equal(snap.startedAt, null);
  assert.deepEqual(snap.active, []);
});
await test('两次 tick 之间开始又结束（短任务漏看）→ 也补一个结束事件（lastFinishedSeq 变大）', () => {
  const clock = fakeClock();
  const tasks = [bridgeTask({ state: 'done', status: 'SUCCESS', finishedAt: clock.now() })];
  const { state } = make({ clock, tasks });
  state.tick();
  const snap = state.snapshot();
  assert.equal(snap.running, false);
  assert.equal(snap.sequence, 1);
  assert.equal(snap.lastFinishedSeq, 1);
  assert.equal(snap.lastFinished.type, 'LinkStart-Combat');
  assert.equal(snap.lastFinished.status, 'SUCCESS');
  // 同一个任务不会被重复计数
  state.tick();
  assert.equal(state.snapshot().lastFinishedSeq, 1);
});
await test('lost / 任务从桥列表消失 → FAILED 收尾，不会永远 running', () => {
  const clock = fakeClock();
  const tasks = [];
  const { state } = make({ clock, tasks });
  tasks.push(bridgeTask({ state: 'dispatched' }));
  state.tick();
  assert.equal(state.snapshot().running, true);
  tasks[0] = { ...tasks[0], state: 'lost' };
  state.tick();
  let snap = state.snapshot();
  assert.equal(snap.running, false);
  assert.equal(snap.lastFinished.status, 'FAILED');

  tasks.length = 0;
  tasks.push(bridgeTask({ id: 'task-2', state: 'dispatched' }));
  state.tick();
  assert.equal(state.snapshot().running, true);
  tasks.length = 0; // 被 KEEP_TASKS 挤掉
  state.tick();
  snap = state.snapshot();
  assert.equal(snap.running, false);
  assert.equal(snap.lastFinished.status, 'FAILED');
});

section('4. 多任务聚合');
await test('Copilot（core）+ LinkStart（bridge）同时跑 → running、source=mixed、active 两条', () => {
  const tasks = [];
  const { state, clock } = make({ tasks });
  const token = state.beginTask({ type: 'Copilot', source: 'core' });
  tasks.push(bridgeTask({ state: 'dispatched', createdAt: clock.now() }));
  state.tick();
  let snap = state.snapshot();
  assert.equal(snap.running, true);
  assert.equal(snap.source, 'mixed');
  assert.equal(snap.active.length, 2);
  assert.equal(snap.taskType, 'Copilot');
  state.endTask({ token, status: 'SUCCESS' });
  snap = state.snapshot();
  assert.equal(snap.source, 'bridge');
  assert.equal(snap.taskType, 'LinkStart-Combat');
});

section('5. epoch / 重载');
await test('每次创建 epoch 都不同；同一文件重载后 sequence 归零、文件 epoch 更新', () => {
  const { state: a, file } = make();
  const e1 = a.snapshot().epoch;
  a.beginTask({ type: 'Copilot', source: 'core' });
  a.dispose();
  const b = createTaskState({ stateFile: file, pluginVersion: '2.1.0', interval: false, writeThrottleMs: 0 });
  const snap = b.snapshot();
  assert.notEqual(snap.epoch, e1);
  assert.equal(snap.sequence, 0);
  assert.equal(snap.running, false);
  const onDisk = readJson(file);
  assert.equal(onDisk.epoch, snap.epoch);
  assert.match(makeEpoch(1000), /^p-\d+-/);
  b.dispose();
});

section('6. 写盘（原子 / 节流 / 失败不抛）');
await test('原子写：临时文件 + rename，无 .tmp 残留，JSON 可解析', () => {
  const { state, dir, file } = make();
  state.beginTask({ type: 'Copilot', source: 'core' });
  state.endTask({ token: state.beginTask({ type: 'Copilot', source: 'core' }), status: 'FAILED' });
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  assert.equal(readJson(file).lastFinished.status, 'FAILED');
});
await test('状态变化写盘节流：250ms 内的连发先不写，tick 到点补写', () => {
  const clock = fakeClock();
  const { state, file } = make({ clock, writeThrottleMs: 250 });
  assert.equal(readJson(file).running, false);
  state.beginTask({ type: 'Copilot', source: 'core' });
  assert.equal(readJson(file).running, false, '节流窗口内不应写盘');
  clock.advance(300);
  state.tick();
  assert.equal(readJson(file).running, true);
  assert.equal(state.snapshot().updatedAt, clock.now());
});
await test('心跳：heartbeatMs 到了刷新 updatedAt/heartbeatAt；没到不写', () => {
  const clock = fakeClock();
  const { state, file } = make({ clock, heartbeatMs: 5000 });
  const first = readJson(file).updatedAt;
  clock.advance(4000);
  state.tick();
  assert.equal(readJson(file).updatedAt, first);
  clock.advance(2000);
  state.tick();
  const after = readJson(file);
  assert.equal(after.updatedAt, clock.now());
  assert.equal(after.heartbeatAt, clock.now());
});
await test('写盘失败只记日志，不抛，snapshot 仍可用', () => {
  const dir = tmpDir();
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'not a dir');
  const state = createTaskState({
    stateFile: path.join(blocker, 'task-state.json'),
    interval: false,
    writeThrottleMs: 0,
  });
  assert.ok(state.writeError, '应记录写盘失败原因');
  const snap = state.snapshot();
  assert.equal(snap.running, false);
  assert.equal(snap.known, true);
  state.beginTask({ type: 'Copilot', source: 'core' });
  assert.equal(state.snapshot().running, true);
  state.dispose();
});

section('7. waitForChange（给 agent 长轮询用）');
await test('状态变化会唤醒等待者', async () => {
  const { state } = make();
  const p = state.waitForChange(5000);
  state.beginTask({ type: 'Copilot', source: 'core' });
  const r = await p;
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'change');
});
await test('超时返回 changed=false；dispose 也能唤醒', async () => {
  const { state } = make();
  const r = await state.waitForChange(20);
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'timeout');
  const p = state.waitForChange(5000);
  state.dispose();
  const d = await p;
  assert.equal(d.changed, false);
  assert.equal(d.reason, 'dispose');
});

section('8. 三类数据源接线');
await test('后台 runner 钩子：开始记 Copilot、结束记 SUCCESS', async () => {
  const { state } = make();
  const runner = createCopilotRunner({
    run: async () => ({ ok: true }),
    onBegin: (entry) => state.beginTask({
      type: runnerLabelToTaskType(entry.label),
      source: 'core',
      token: `runner:${entry.id}`,
      startedAt: entry.startedAt,
    }),
    onFinish: (entry) => state.endTask({
      token: `runner:${entry.id}`,
      status: entry.state === 'done' && entry.result?.ok !== false ? 'SUCCESS' : 'FAILED',
      at: entry.finishedAt,
    }),
  });
  runner.start({ jobFile: 'job.json', cfg: {} });
  assert.equal(state.snapshot().running, true);
  assert.equal(state.snapshot().taskType, 'Copilot');
  await sleep(30);
  const snap = state.snapshot();
  assert.equal(snap.running, false);
  assert.equal(snap.lastFinished.type, 'Copilot');
  assert.equal(snap.lastFinished.status, 'SUCCESS');
  await runner.dispose();
});
await test('阻塞式 MaaCore 埋点：AccountSwitch 属于交接任务（ends 不算用户服务结束）', () => {
  const { state } = make();
  const token = state.beginTask({ type: 'AccountSwitch', source: 'core' });
  let snap = state.snapshot();
  assert.equal(snap.running, true);
  assert.equal(snap.taskType, 'AccountSwitch');
  assert.equal(snap.source, 'core');
  state.endTask({ token, status: 'FAILED' });
  snap = state.snapshot();
  assert.equal(snap.running, false);
  assert.equal(snap.lastFinished.type, 'AccountSwitch');
  assert.equal(snap.lastFinished.status, 'FAILED');
  assert.deepEqual(HANDOFF_TASK_TYPES, ['AccountSwitch', 'LinkStart-WakeUp']);
  assert.equal(runnerLabelToTaskType('copilot'), 'Copilot');
  assert.equal(runnerLabelToTaskType('account-switch'), 'AccountSwitch');
});

console.log('');
if (fails.length) {
  console.error(`失败 ${fails.length} 项：`);
  for (const f of fails) console.error(` - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`全部通过: ${pass} 通过 / 0 失败`);
