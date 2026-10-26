#!/usr/bin/env node
/**
 * 文字输入（src/input/adb-input.js: typeTextAdbInput / src/input/index.js: typeText）单测。
 * 不连模拟器：adb 命令用假 run 记录参数；截图用假 bridge（MAA 在线路径）。
 *
 * 锁住的口径：
 *  1. 只允许数字/字母与 @ . _ + -（中文、空格、引号一律拒绝，让用户自己输）；
 *  2. 先聚焦后输入 —— 输入前会检查 MAA 有没有在跑任务（两路注入会打架）；
 *  3. 打完截图验收（ok 只代表 adb 注入成功）。
 */
import assert from 'node:assert/strict';
import { validateTypeText, typeTextAdbInput } from '../src/input/adb-input.js';
import { typeText } from '../src/input/index.js';

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

const fakeRun = (result = { ok: true, stdout: '', stderr: '' }) => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    return result;
  };
  return { run, calls };
};

const cfg = {
  adbPath: '',
  adbAddress: '127.0.0.1:16384',
  maaHint: { adbPath: 'D:/mumu/shell/adb.exe' },
  shotsDir: 'tmp/shots',
};

const fakeBridge = ({ online = true, tasks = [] } = {}) => ({
  health: () => ({ online }),
  list: () => tasks,
  enqueue: (type) => ({ id: 1, type }),
  waitFor: async () => ({ state: 'done', file: 'tmp/shots/typed.png' }),
});

section('1. 输入内容校验');
await test('手机号 / 验证码 / 邮箱都能过', () => {
  assert.equal(validateTypeText('13800138000').ok, true);
  assert.equal(validateTypeText('A1b2C3').ok, true);
  assert.equal(validateTypeText('ab@gmail.com').ok, true);
});
await test('中文 / 空格 / 引号 拒绝（让用户自己输）', () => {
  assert.equal(validateTypeText('博士').ok, false);
  assert.equal(validateTypeText('138 0013').ok, false);
  assert.equal(validateTypeText("a'b").ok, false);
  assert.equal(validateTypeText('').ok, false);
  assert.equal(validateTypeText(null).ok, false);
});
await test('超长拒绝（最多 64 字符）', () => {
  assert.equal(validateTypeText('1'.repeat(64)).ok, true);
  assert.equal(validateTypeText('1'.repeat(65)).ok, false);
});

section('2. adb 命令构造');
await test('input text 命令参数正确', async () => {
  const { run, calls } = fakeRun();
  const r = await typeTextAdbInput({ adbPath: 'D:/fake/adb.exe', address: '127.0.0.1:16384', text: '13800138000', deps: { run } });
  assert.equal(r.ok, true);
  assert.equal(r.chars, 11);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['-s', '127.0.0.1:16384', 'shell', 'input', 'text', '13800138000']);
});
await test('enter=true 时补一次 keyevent 66', async () => {
  const { run, calls } = fakeRun();
  const r = await typeTextAdbInput({ adbPath: 'adb.exe', text: '123456', enter: true, deps: { run } });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ['shell', 'input', 'keyevent', '66']);
});
await test('adb 失败 → 错误可读', async () => {
  const { run } = fakeRun({ ok: false, error: 'device offline', stderr: 'error: device offline' });
  const r = await typeTextAdbInput({ adbPath: 'adb.exe', text: '123456', deps: { run } });
  assert.equal(r.ok, false);
  assert.match(r.error, /input text 失败.*device offline/);
});
await test('非法内容连 adb 都不调', async () => {
  const { run, calls } = fakeRun();
  const r = await typeTextAdbInput({ adbPath: 'adb.exe', text: '中文', deps: { run } });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

section('3. typeText 编排');
await test('成功：注入 + 截图验收（MAA 在线路径）', async () => {
  const { run, calls } = fakeRun();
  const r = await typeText({
    cfg,
    bridge: fakeBridge(),
    text: '13800138000',
    deps: { resolveAdbPath: () => ({ ok: true, path: 'D:/fake/adb.exe' }), run, sleep: async () => {} },
  });
  assert.equal(r.ok, true);
  assert.equal(r.chars, 11);
  assert.equal(calls.length, 1);
  assert.equal(r.screenshot.via, 'maa');
  assert.equal(r.screenshot.file, 'tmp/shots/typed.png');
});
await test('MAA 正在跑任务 → 拒绝（不注入）', async () => {
  const { run, calls } = fakeRun();
  const r = await typeText({
    cfg,
    bridge: fakeBridge({ tasks: [{ state: 'queued', type: 'LinkStart' }] }),
    text: '123456',
    deps: { resolveAdbPath: () => ({ ok: true, path: 'D:/fake/adb.exe' }), run, sleep: async () => {} },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /MAA 正在跑任务/);
  assert.equal(calls.length, 0);
});
await test('找不到 adb → 明确报错', async () => {
  const { run } = fakeRun();
  const r = await typeText({
    cfg,
    bridge: null,
    text: '123456',
    deps: { resolveAdbPath: () => ({ ok: false, error: '没找到 adb' }), run, sleep: async () => {} },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /没找到 adb/);
});
await test('设备离线 → 返回 adb 错误（不假装成功）', async () => {
  const { run } = fakeRun({ ok: false, error: 'device offline', stderr: 'error: device offline' });
  const r = await typeText({
    cfg,
    bridge: null,
    text: '123456',
    deps: {
      resolveAdbPath: () => ({ ok: true, path: 'D:/fake/adb.exe' }),
      run,
      sleep: async () => {},
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /device offline/);
});

console.log('');
if (fails.length) {
  console.error(`失败 ${fails.length} 项：`);
  for (const f of fails) console.error(` - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`全部通过: ${pass} 通过 / 0 失败`);
