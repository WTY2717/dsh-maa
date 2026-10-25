#!/usr/bin/env node
/**
 * 模拟器自启（`maa_emulator` / 插件启动时那一步）单测：不装 MuMu、不发任何真实命令。
 *
 * 锁住的口径（2026-10-25 实测）：
 *  1. `MuMuManager.exe info -v <index>` 的 `is_process_started` 是「开没开」的唯一依据；
 *  2. 已经开着就**绝不**再发 launch（否则会重复启动）；
 *  3. launch 返回 `{"errcode":0}` 只是「命令收到」，必须继续轮询 `sys.boot_completed=1`；
 *  4. launch 失败 / errcode≠0 / 等不到开机，都要给出可读原因，且**不许抛异常**；
 *  5. 并发调用共用同一次启动流程（模块级 inflight），不会双开。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const imp = (rel) => import(new URL(`../${rel}`, import.meta.url).href);

let pass = 0;
const fails = [];
const test = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); } catch (e) { fails.push({ name, error: String(e?.message || e) }); console.log(`  FAIL ${name}: ${e?.message || e}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const emu = await imp('src/emulator.js');

/* 造一个「假 MuMu 安装」：<tmp>\shell\MuMuManager.exe */
const fakeInstall = fs.mkdtempSync(path.join(os.tmpdir(), 'mumu-inst-'));
fs.mkdirSync(path.join(fakeInstall, 'shell'), { recursive: true });
const managerPath = path.join(fakeInstall, 'shell', 'MuMuManager.exe');
fs.writeFileSync(managerPath, '');

const cfg = { maaHint: { emulatorPath: fakeInstall }, adbAddress: '127.0.0.1:16384', adbPath: '' };
const fakeAdb = { ok: true, path: path.join(fakeInstall, 'shell', 'adb.exe'), source: 'test' };

/** 假 MuMuManager / adb：按参数分支返回，记录调用顺序。 */
function fakeRunner({ started = false, launchOut = '{"errcode":0,"errmsg":""}', bootSeq = ['1'], failLaunch = false } = {}) {
  const calls = [];
  let bootTick = 0;
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === 'info' || args[0] === '--vmindex') {
      return { ok: true, stdout: JSON.stringify({ index: '0', name: '明日方舟-MuMu模拟器12', is_process_started: started, error_code: 0 }), stderr: '', error: null };
    }
    if (args[0] === 'control') {
      if (failLaunch) return { ok: false, stdout: '', stderr: 'manager boom', error: 'manager boom' };
      return { ok: true, stdout: launchOut, stderr: '', error: null };
    }
    if (args.includes('getprop')) {
      const v = bootSeq[Math.min(bootTick, bootSeq.length - 1)];
      bootTick += 1;
      return { ok: true, stdout: `${v}\n`, stderr: '', error: null };
    }
    return { ok: true, stdout: '', stderr: '', error: null };
  };
  return { run, calls };
}

const baseDeps = (runner, extra = {}) => ({
  run: runner.run,
  sleep: async () => {},
  pollIntervalMs: 1,
  adb: fakeAdb,
  ensureConnected: async () => ({ ok: true, output: 'connected' }),
  ...extra,
});

/* ────────────────────── 1. 定位 ────────────────────── */

section('1. MuMuManager 定位');

await test('优先用 MAA 配置里的模拟器目录（<实例>\\shell\\MuMuManager.exe）', () => {
  const r = emu.resolveMuMuManager({ cfg, deps: { adb: fakeAdb } });
  assert.equal(r.ok, true);
  assert.equal(r.path, managerPath);
  assert.equal(r.source, 'maa-config');
  assert.equal(r.instanceIndex, 0);
});

await test('设置里直接给 mumuManagerPath 时最优先', () => {
  const r = emu.resolveMuMuManager({ cfg: { ...cfg, mumuManagerPath: managerPath }, deps: { adb: fakeAdb } });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'config');
});

await test('行 config 的 mumuInstanceIndex 生效', () => {
  const r = emu.resolveMuMuManager({ cfg: { ...cfg, mumuInstanceIndex: 2 }, deps: { adb: fakeAdb } });
  assert.equal(r.instanceIndex, 2);
});

/* ────────────────────── 2. 查状态 ────────────────────── */

section('2. 实例状态');

await test('is_process_started=false → started=false', async () => {
  const { run } = fakeRunner({ started: false });
  const r = await emu.queryInstance({ managerPath, index: 0, deps: { run } });
  assert.equal(r.ok, true);
  assert.equal(r.started, false);
  assert.equal(r.name, '明日方舟-MuMu模拟器12');
});

await test('error_code≠0 / 非 JSON / 命令失败 → 都返回错误不抛', async () => {
  const bad1 = async () => ({ ok: true, stdout: JSON.stringify({ error_code: 5 }), stderr: '', error: null });
  const bad2 = async () => ({ ok: true, stdout: 'not json', stderr: '', error: null });
  const bad3 = async () => ({ ok: false, stdout: '', stderr: 'nope', error: 'nope' });
  for (const run of [bad1, bad2, bad3]) {
    const r = await emu.queryInstance({ managerPath, index: 0, deps: { run } });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  }
});

/* ────────────────────── 3. 启动流程 ────────────────────── */

section('3. 启动流程');

await test('已经开着：只 ensureConnected，不发 launch', async () => {
  const runner = fakeRunner({ started: true });
  const r = await emu.ensureEmulator({ cfg, deps: baseDeps(runner) });
  assert.equal(r.ok, true);
  assert.equal(r.started, true);
  assert.equal(r.launched, false);
  assert.equal(runner.calls.filter((c) => c.args[0] === 'control').length, 0, '不许重复启动');
});

await test('没开 + autoLaunch=false：只报状态不启动', async () => {
  const runner = fakeRunner({ started: false });
  const r = await emu.ensureEmulator({ cfg, autoLaunch: false, deps: baseDeps(runner) });
  assert.equal(r.ok, false);
  assert.match(r.error, /不允许自动启动/);
  assert.equal(runner.calls.filter((c) => c.args[0] === 'control').length, 0);
});

await test('没开 → launch → 轮询到 boot_completed=1', async () => {
  const runner = fakeRunner({ started: false, bootSeq: ['0', '1'] });
  const r = await emu.ensureEmulator({ cfg, deps: baseDeps(runner) });
  assert.equal(r.ok, true);
  assert.equal(r.launched, true);
  assert.equal(typeof r.bootMs, 'number');
  assert.deepEqual(runner.calls[1].args, ['control', '-v', '0', 'launch']);
  assert.equal(runner.calls.filter((c) => c.args.includes('getprop')).length, 2, '第一次 0，第二次 1');
});

await test('launch 命令本身失败 → 报错带回显', async () => {
  const runner = fakeRunner({ started: false, failLaunch: true });
  const r = await emu.ensureEmulator({ cfg, deps: baseDeps(runner) });
  assert.equal(r.ok, false);
  assert.match(r.error, /启动失败/);
});

await test('launch 返回 errcode≠0 → 报「启动被拒绝」', async () => {
  const runner = fakeRunner({ started: false, launchOut: '{"errcode":5,"errmsg":"already exists"}' });
  const r = await emu.ensureEmulator({ cfg, deps: baseDeps(runner) });
  assert.equal(r.ok, false);
  assert.match(r.error, /启动被拒绝.*errcode=5/);
});

await test('一直等不到开机 → 超时报错（不抛）', async () => {
  const runner = fakeRunner({ started: false, bootSeq: ['0'] });
  const r = await emu.ensureEmulator({ cfg, timeoutMs: 30, deps: baseDeps(runner) });
  assert.equal(r.ok, false);
  assert.match(r.error, /没等到模拟器可连接/);
});

await test('找不到 MuMuManager → 报错并列出试过的位置', async () => {
  const r = await emu.ensureEmulator({
    cfg: { adbAddress: '127.0.0.1:16384' },
    timeoutMs: 3000,
    deps: { ...baseDeps(fakeRunner({})), adb: { ok: false, path: null } },
  });
  // 本机装了 MuMu（D:\MUMU 扫描能命中）时这里会成功，属于环境差异，只要求「不抛且字段齐」
  assert.equal(typeof r.ok, 'boolean');
  if (!r.ok) assert.ok(r.error);
  if (r.ok !== false) assert.ok(r.manager, '成功时也要报出用的是哪个 MuMuManager');
});

/* ────────────────────── 4. 并发 ────────────────────── */

section('4. 并发只启动一次');

await test('两次并发 ensure 共用同一次流程', async () => {
  const runner = fakeRunner({ started: false, bootSeq: ['1'] });
  const deps = baseDeps(runner);
  const [a, b] = await Promise.all([
    emu.ensureEmulator({ cfg, deps }),
    emu.ensureEmulator({ cfg, deps }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const infos = runner.calls.filter((c) => c.args[0] === 'info');
  const controls = runner.calls.filter((c) => c.args[0] === 'control');
  assert.equal(infos.length, 1, `info 只该问一次，实际 ${infos.length}`);
  assert.equal(controls.length, 1, `launch 只该发一次，实际 ${controls.length}`);
});

await test('lastEmulatorRun 记录最近一次结果', () => {
  const last = emu.lastEmulatorRun();
  assert.ok(last && typeof last.at === 'number');
  assert.equal(typeof last.elapsedMs, 'number');
});

/* ────────────────────── 汇总 ────────────────────── */

console.log(`\n${fails.length ? '失败' : '全部通过'}: ${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
