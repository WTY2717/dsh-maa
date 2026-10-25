#!/usr/bin/env node
/**
 * 「开始唤醒」单测：不连 MAA、不碰模拟器。
 *
 * 锁住的结论（2026-10-25 实测）：
 *  1. `LinkStart-WakeUp` 是**单独可下发**的任务类型，不需要先跑整套「一键长草」；
 *  2. 编排顺序是「模拟器就绪 → 下发唤醒 → 轮询到 done/lost → 截图」；
 *  3. 模拟器起不来就不下发唤醒；没桥就明确报错；超时要给可读提示；
 *  4. 全程不抛异常。
 */
import assert from 'node:assert/strict';

const imp = (rel) => import(new URL(`../${rel}`, import.meta.url).href);

let pass = 0;
const fails = [];
const test = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); } catch (e) { fails.push({ name, error: String(e?.message || e) }); console.log(`  FAIL ${name}: ${e?.message || e}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const { wakeupGame } = await imp('src/wakeup.js');

/** 假桥：记录下发类型，waitFor 按预设状态序列返回。 */
function fakeBridge(states = ['done']) {
  const calls = [];
  let i = 0;
  return {
    calls,
    enqueue(type) {
      calls.push({ op: 'enqueue', type });
      return { id: 'task-1', type, state: 'queued' };
    },
    async waitFor(task) {
      calls.push({ op: 'waitFor' });
      const state = states[Math.min(i, states.length - 1)];
      i += 1;
      return { ...task, state, status: state === 'done' ? 'SUCCESS' : null };
    },
  };
}
const fakeCapture = async () => ({ via: 'maa-remote', file: 'C:/shots/main.png', bytes: 123 });
const cfg = { adbAddress: '127.0.0.1:16384' };

/* ────────────────────── 1. 正常唤醒 ────────────────────── */

section('1. 正常唤醒');

await test('模拟器就绪 → 下发 LinkStart-WakeUp → done → 截图', async () => {
  const bridge = fakeBridge(['dispatched', 'done']);
  const r = await wakeupGame({
    cfg,
    bridge,
    timeoutMs: 60_000,
    deps: { ensureEmulator: async () => ({ ok: true, started: true, launched: true, bootMs: 9500 }), capture: fakeCapture },
  });
  assert.equal(r.ok, true);
  assert.equal(r.wakeup.state, 'done');
  assert.equal(r.wakeup.result, 'SUCCESS');
  assert.equal(r.screenshot.file, 'C:/shots/main.png');
  assert.deepEqual(bridge.calls.filter((c) => c.op === 'enqueue').map((c) => c.type), ['LinkStart-WakeUp'], '只下发唤醒这一种任务');
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].step, 'emulator');
  assert.equal(r.steps[0].bootMs, 9500);
  assert.equal(r.steps[1].step, 'wakeup');
});

await test('skipEmulator=true：不碰模拟器，直接唤醒', async () => {
  let ensured = 0;
  const bridge = fakeBridge(['done']);
  const r = await wakeupGame({
    cfg,
    bridge,
    skipEmulator: true,
    deps: { ensureEmulator: async () => { ensured += 1; return { ok: true }; }, capture: fakeCapture },
  });
  assert.equal(r.ok, true);
  assert.equal(ensured, 0);
  assert.equal(r.steps.length, 1, '没有 emulator 步骤');
});

/* ────────────────────── 2. 失败路径 ────────────────────── */

section('2. 失败路径');

await test('模拟器起不来 → 不下发唤醒', async () => {
  const bridge = fakeBridge(['done']);
  const r = await wakeupGame({
    cfg,
    bridge,
    deps: { ensureEmulator: async () => ({ ok: false, error: '没找到 MuMuManager.exe' }), capture: fakeCapture },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /模拟器起不来/);
  assert.equal(bridge.calls.filter((c) => c.op === 'enqueue').length, 0);
});

await test('没有桥 → 明确报错（MAA 没跑/端点没配）', async () => {
  const r = await wakeupGame({ cfg, bridge: null, skipEmulator: true, deps: { capture: fakeCapture } });
  assert.equal(r.ok, false);
  assert.match(r.error, /远程控制桥不可用/);
});

await test('一直 dispatched → 超时给提示，不抛', async () => {
  const bridge = fakeBridge(['dispatched']);
  const r = await wakeupGame({
    cfg,
    bridge,
    timeoutMs: 20,
    skipEmulator: true,
    deps: { capture: fakeCapture },
  });
  assert.equal(r.ok, false);
  assert.equal(r.wakeup.state, 'dispatched');
  assert.match(r.hint, /没等到结束/);
});

await test('lost（MAA 无回执）也算失败，不抛', async () => {
  const bridge = fakeBridge(['lost']);
  const r = await wakeupGame({ cfg, bridge, skipEmulator: true, timeoutMs: 10_000, deps: { capture: fakeCapture } });
  assert.equal(r.ok, false);
  assert.equal(r.wakeup.state, 'lost');
});

await test('截图失败不影响唤醒结论', async () => {
  const bridge = fakeBridge(['done']);
  const r = await wakeupGame({
    cfg,
    bridge,
    skipEmulator: true,
    deps: { capture: async () => { throw new Error('adb 掉线'); } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.wakeup.state, 'done');
  assert.match(r.screenshot.error, /adb 掉线/);
});

/* ────────────────────── 汇总 ────────────────────── */

console.log(`\n${fails.length ? '失败' : '全部通过'}: ${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
