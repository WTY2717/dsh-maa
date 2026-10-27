#!/usr/bin/env node
/**
 * 账号切换（src/switch-account.js）单测：不连 MAA / 模拟器，用假 CoreWorker 验证下发参数与判定。
 *
 * 锁住的口径：
 *  1. 下发的是 MaaCore 的 `StartUp` 任务，参数 `{client_type, start_game_enabled, account_name}`；
 *  2. 只有官服/B服/繁中/韩服能切（EN/JP、PC 端不支持）；
 *  3. MAA 正在跑任务时拒绝切换（两路触摸会打架）；
 *  4. 失败给「按新用户登录流程处理」的口径，不让模型把过期账号当失败重试到死；
 *  5. 超时 60~300 秒钳制；worker 一定 close。
 */
import assert from 'node:assert/strict';
import {
  buildStartUpParams,
  clientTypeFromCfg,
  switchAdvice,
  switchAccount,
  SUPPORTED_SWITCH_CLIENTS,
} from '../src/switch-account.js';

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

const cfg = {
  adbPath: '',
  adbAddress: '127.0.0.1:16384',
  adbConfig: 'MuMuEmulator12',
  maaInstallPath: 'D:/fake-maa',
  maaHint: { adbPath: 'D:/mumu/shell/adb.exe', clientType: 'Official' },
  coreUserDir: 'tmp/core-user',
  logDir: 'tmp/logs',
  shotsDir: 'tmp/shots',
  nodePath: '',
};

class FakeWorker {
  static created = 0;
  static last = null;
  constructor(opts = {}) {
    FakeWorker.created += 1;
    FakeWorker.last = this;
    this.opts = opts;
    this.logFile = 'fake-core.log';
    this.connectResult = { connected: true };
    this.waitResult = { sawCompletion: true, failed: false, callbacks: 2 };
    this.emitDuringWait = null;
    this.closed = false;
  }
  async start() { this.started = true; }
  async open(args) { this.opened = args; }
  async connect(args) { this.connectArgs = args; return this.connectResult; }
  async append(type, params) { this.appended = { type, params }; return { taskId: 7 }; }
  async startTask() { this.startedTask = true; }
  async wait(ms) {
    this.waitedMs = ms;
    if (this.emitDuringWait) this.emitDuringWait(this.opts.onEvent);
    return this.waitResult;
  }
  async close() { this.closed = true; }
}

const deps = (overrides = {}) => ({
  CoreWorker: FakeWorker,
  resolveAdbPath: () => ({ ok: true, path: 'D:/fake/adb.exe', source: 'test' }),
  connectionExtras: () => '{}',
  screencap: async () => ({ ok: true, file: 'tmp/shots/switch.png', bytes: 1234 }),
  maaBusy: () => ({ known: false }),
  ...overrides,
});

section('1. 下发参数');
await test('官服手机号 → StartUp + account_name（自动转掩码：完整号匹配不上游戏登录页）', () => {
  const r = buildStartUpParams({ phone: '13800138000', clientType: 'Official', startGame: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.params, { client_type: 'Official', start_game_enabled: true, account_name: '138****8000' });
  const masked = buildStartUpParams({ phone: '138****8000' });
  assert.equal(masked.params.account_name, '138****8000');
});
await test('startGame=false 时不下发自动启动', () => {
  const r = buildStartUpParams({ phone: '13800138000', startGame: false });
  assert.equal(r.params.start_game_enabled, false);
});
await test('不支持的客户端拒绝（EN/JP 没有账号切换）', () => {
  assert.deepEqual(SUPPORTED_SWITCH_CLIENTS, ['Official', 'Bilibili', 'txwy', 'YoStarKR']);
  const r = buildStartUpParams({ phone: '13800138000', clientType: 'YoStarEN' });
  assert.equal(r.ok, false);
  assert.match(r.error, /不支持账号切换/);
});
await test('手机号非法拒绝', () => {
  const r = buildStartUpParams({ phone: '138' });
  assert.equal(r.ok, false);
});
await test('客户端类型从 MAA 配置取，缺省官服', () => {
  assert.equal(clientTypeFromCfg({}), 'Official');
  assert.equal(clientTypeFromCfg({ maaHint: { clientType: 'Bilibili' } }), 'Bilibili');
});

section('2. 失败口径');
await test('成功 → advice 为 null', () => {
  assert.equal(switchAdvice({ ok: true }), null);
});
await test('连不上模拟器 → emulator-unreachable', () => {
  assert.equal(switchAdvice({ ok: false, connectionFailed: true }).verdict, 'emulator-unreachable');
});
await test('超时 → timeout', () => {
  assert.equal(switchAdvice({ ok: false, timedOut: true }).verdict, 'timeout');
});
await test('失败且没看到切换动作 → switch-unavailable（当新用户处理）', () => {
  const a = switchAdvice({ ok: false, failed: true, sawAccountSwitch: false });
  assert.equal(a.verdict, 'switch-unavailable');
  assert.match(a.message, /新用户/);
});
await test('失败但看到账号切换动作 → switch-probably-succeeded（先截图核对，别让人重登）', () => {
  const a = switchAdvice({ ok: false, failed: true, sawAccountSwitch: true });
  assert.equal(a.verdict, 'switch-probably-succeeded');
  assert.match(a.message, /read_image/);
  assert.match(a.message, /不要仅凭 FAILED/);
});
await test('超时优先于「看到切换动作」→ 仍按 timeout 处理', () => {
  assert.equal(switchAdvice({ ok: false, timedOut: true, sawAccountSwitch: true }).verdict, 'timeout');
});

section('3. 编排（假 worker）');
await test('成功路径：StartUp 下发、截图、close', async () => {
  FakeWorker.last = null;
  const r = await switchAccount({ cfg, phone: '13800138000', deps: deps() });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'switched');
  assert.equal(r.taskId, 7);
  const w = FakeWorker.last;
  assert.equal(w.appended.type, 'StartUp');
  assert.equal(w.appended.params.account_name, '138****8000');
  assert.equal(w.appended.params.client_type, 'Official');
  assert.equal(w.closed, true);
  assert.equal(r.screenshot.file, 'tmp/shots/switch.png');
  assert.match(r.target.phoneMasked, /^138\*\*\*\*8000$/);
  assert.equal(r.accountSwitch.seen, false);
});
await test('看到 AccountSwitch 回调 → accountSwitch.seen / target', async () => {
  const R = FakeWorker;
  const origWait = R.prototype.wait;
  R.prototype.wait = async function wait(ms) {
    this.waitedMs = ms;
    this.opts.onEvent?.({
      event: 'cb',
      id: 20003,
      text: JSON.stringify({ what: 'AccountSwitch', details: { account_name: '138****8000' } }),
    });
    return { sawCompletion: true, failed: false, callbacks: 3 };
  };
  try {
    const r = await switchAccount({ cfg, phone: '13800138000', deps: deps() });
    assert.equal(r.ok, true);
    assert.equal(r.accountSwitch.seen, true);
    assert.equal(r.accountSwitch.target, '138****8000');
  } finally {
    R.prototype.wait = origWait;
  }
});
await test('失败路径：没看到切换动作 → switch-unavailable', async () => {
  const R = FakeWorker;
  const origWait = R.prototype.wait;
  R.prototype.wait = async function wait(ms) {
    this.waitedMs = ms;
    return { sawCompletion: false, failed: true, callbacks: 1 };
  };
  try {
    const r = await switchAccount({ cfg, phone: '13800138000', deps: deps() });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'failed');
    assert.equal(r.advice.verdict, 'switch-unavailable');
    assert.equal(R.last.closed, true);
  } finally {
    R.prototype.wait = origWait;
  }
});
await test('实机同款：回调看到账号切换但任务链 FAILED → probablySwitched + 截图核对口径', async () => {
  const R = FakeWorker;
  const origWait = R.prototype.wait;
  R.prototype.wait = async function wait(ms) {
    this.waitedMs = ms;
    this.opts.onEvent?.({
      event: 'cb',
      id: 20003,
      text: JSON.stringify({ what: 'AccountSwitch', details: { account_name: '138****8000' } }),
    });
    return { sawCompletion: false, failed: true, idleExit: true, callbacks: 2 }; // ← 2026-10-27 真机同款
  };
  try {
    const r = await switchAccount({ cfg, phone: '13800138000', deps: deps() });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'failed');
    assert.equal(r.probablySwitched, true);
    assert.equal(r.advice.verdict, 'switch-probably-succeeded');
    assert.match(r.hint, /大概率已经切成功/);
  } finally {
    R.prototype.wait = origWait;
  }
});
await test('超时路径 → status timeout / advice timeout', async () => {
  const R = FakeWorker;
  const oldWait = R.prototype.wait;
  R.prototype.wait = async function wait(ms) { this.waitedMs = ms; return { sawCompletion: false, failed: false, timedOut: true }; };
  try {
    const r = await switchAccount({ cfg, phone: '13800138000', deps: deps() });
    assert.equal(r.status, 'timeout');
    assert.equal(r.advice.verdict, 'timeout');
  } finally {
    R.prototype.wait = oldWait;
  }
});
await test('超时秒数钳制：1 → 60s，999 → 300s', async () => {
  const s1 = await switchAccount({ cfg, phone: '13800138000', timeoutSeconds: 1, deps: deps() });
  assert.equal(FakeWorker.last.waitedMs, 60_000);
  const s2 = await switchAccount({ cfg, phone: '13800138000', timeoutSeconds: 999, deps: deps() });
  assert.equal(FakeWorker.last.waitedMs, 300_000);
  assert.equal(s1.ok, true);
  assert.equal(s2.ok, true);
});
await test('连接失败 → unreachable，且不下发任务', async () => {
  const R = FakeWorker;
  const proto = R.prototype;
  const oldConnect = proto.connect;
  proto.connect = async function connect(args) { this.connectArgs = args; return { connected: false }; };
  try {
    const r = await switchAccount({ cfg, phone: '13800138000', deps: deps() });
    assert.equal(r.status, 'unreachable');
    assert.equal(r.advice.verdict, 'emulator-unreachable');
    assert.equal(R.last.appended, undefined);
    assert.equal(R.last.closed, true);
  } finally {
    proto.connect = oldConnect;
  }
});
await test('MAA 正在跑任务 → 拒绝（不创建 worker）', async () => {
  const before = FakeWorker.created;
  const r = await switchAccount({
    cfg,
    phone: '13800138000',
    deps: deps({ maaBusy: () => ({ known: true, pending: 1, pendingTypes: ['LinkStart'], running: [] }) }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'maa-busy');
  assert.equal(FakeWorker.created, before);
});
await test('非法手机号 → status invalid，不创建 worker', async () => {
  const before = FakeWorker.created;
  const r = await switchAccount({ cfg, phone: '1', deps: deps() });
  assert.equal(r.status, 'invalid');
  assert.equal(FakeWorker.created, before);
});

console.log('');
if (fails.length) {
  console.error(`失败 ${fails.length} 项：`);
  for (const f of fails) console.error(` - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`全部通过: ${pass} 通过 / 0 失败`);
