#!/usr/bin/env node
/**
 * 加固自测（2026-10-25 崩溃事故后新增）：不装插件、不联网、不起宿主。
 *
 * 覆盖：
 *  1. resolveConfig 面对任何输入都不抛，且输出字段类型安全（volatile 包装对象那类坑）
 *  2. settings-store：白名单、类型清洗、原子写、读回合并
 *  3. 覆盖值优先级：设置页值 > 行 config > 默认
 *  4. installConfigRoute 在没有 webServer 时安全退化为 no-op
 *  5. client.js：factory 不抛、注册键正确、summary/page 渲染不炸
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(HERE);
const imp = (rel) => import(new URL(`../${rel}`, import.meta.url).href);

let pass = 0;
const fails = [];
const test = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); } catch (e) { fails.push({ name, error: String(e?.message || e) }); console.log(`  FAIL ${name}: ${e?.message || e}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const { resolveConfig } = await imp('src/config.js');
const store = await imp('src/settings-store.js');
const { installConfigRoute } = await imp('src/ui-config.js');

/* 用临时目录当插件目录，避免污染真实 data/settings.json */
const tmpPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-pkg-'));

section('1. resolveConfig 绝不抛 / 类型安全');
const vol = { get() { return 'C:/evil.md'; } }; // 模拟 cosmokit Volatile 包装
const adversarial = [
  ['空对象', {}],
  ['null', null],
  ['undefined', undefined],
  ['字符串', 'not-an-object'],
  ['数组', [1, 2, 3]],
  ['Volatile 包装对象', { maaInstallPath: vol, rosterPath: vol, adbPath: vol, bridgePort: vol, popupGuard: vol }],
  ['错误类型', { bridgePort: 'abc', formationIndex: -5, popupGuard: 'yes', copilotTimeoutSeconds: {} }],
  ['null 字段', { maaInstallPath: null, rosterPath: null, dataDir: null, nodePath: null }],
  ['超长怪值', { dataDir: 'x'.repeat(5000), connectExtras: '[]', adbAddress: 0 }],
];
for (const [label, input] of adversarial) {
  await test(`不抛：${label}`, () => {
    const cfg = resolveConfig(input, tmpPkg);
    assert.equal(typeof cfg, 'object');
    for (const key of ['maaInstallPath', 'rosterPath', 'adbPath', 'adbAddress', 'adbConfig', 'dataDir', 'nodePath', 'connectExtras']) {
      assert.equal(typeof cfg[key], 'string', `${key} 应该是 string，实际 ${typeof cfg[key]}`);
    }
    for (const key of ['bridgePort', 'formationIndex', 'copilotTimeoutSeconds']) {
      assert.equal(typeof cfg[key], 'number', `${key} 应该是 number，实际 ${typeof cfg[key]}`);
      assert.ok(Number.isFinite(cfg[key]) && cfg[key] >= 0, `${key} 应该非负有限，实际 ${cfg[key]}`);
    }
    assert.equal(typeof cfg.popupGuard, 'boolean');
    assert.equal(typeof cfg.rosterPathResolved, 'string');
    assert.ok(cfg.dataRoot && typeof cfg.dataRoot === 'string');
  });
}

/* ───────────── 2. settings-store ───────────── */
section('2. settings-store');
await test('默认读不到就是空对象', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-empty-'));
  assert.deepEqual(store.readOverrides(empty), {});
});
await test('写入→读回，只留下白名单字段', () => {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-store-'));
  const merged = store.writeOverrides(pkg, { rosterPath: 'C:/a.md', bridgePort: 19000, evil: 'x', popupGuard: true });
  assert.deepEqual(merged, { rosterPath: 'C:/a.md', bridgePort: 19000, popupGuard: true });
  assert.deepEqual(store.readOverrides(pkg), { rosterPath: 'C:/a.md', bridgePort: 19000, popupGuard: true });
});
await test('类型不对的字段被丢弃', () => {
  const clean = store.sanitizePatch({ rosterPath: 123, bridgePort: 'x', popupGuard: 'yes', adbConfig: 'MuMuEmulator12' });
  assert.deepEqual(clean, { adbConfig: 'MuMuEmulator12' });
});
await test('数字字符串被接受（表单常传字符串）', () => {
  assert.deepEqual(store.sanitizePatch({ bridgePort: '18888' }), { bridgePort: 18888 });
});
await test('第二次写入是合并而不是覆盖', () => {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-store2-'));
  store.writeOverrides(pkg, { rosterPath: 'C:/a.md' });
  const merged = store.writeOverrides(pkg, { bridgePort: 19001 });
  assert.deepEqual(merged, { rosterPath: 'C:/a.md', bridgePort: 19001 });
});
await test('损坏的 JSON 不影响使用', () => {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-store3-'));
  fs.mkdirSync(path.join(pkg, 'data'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'data', 'settings.json'), '{ this is not json');
  assert.deepEqual(store.readOverrides(pkg), {});
  const cfg = resolveConfig({}, pkg);
  assert.equal(typeof cfg.bridgePort, 'number');
});

/* ───────────── 3. 优先级 ───────────── */
section('3. 配置优先级：设置页 > 行 config > 默认');
await test('设置页值覆盖行 config', () => {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-prio-'));
  store.writeOverrides(pkg, { rosterPath: 'C:/from-ui.md' });
  const cfg = resolveConfig({ rosterPath: 'C:/from-row.md', bridgePort: 19002 }, pkg);
  assert.equal(cfg.rosterPath, 'C:/from-ui.md');
  assert.equal(cfg.bridgePort, 19002);
});
await test('撤掉覆盖值后回到行 config', () => {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-prio2-'));
  const cfg = resolveConfig({ rosterPath: 'C:/from-row.md' }, pkg);
  assert.equal(cfg.rosterPath, 'C:/from-row.md');
});

/* ───────────── 4. 路由安全退化 ───────────── */
section('4. 设置页路由');
await test('没有 webServer 时返回 no-op，不抛', () => {
  const dispose = installConfigRoute({ sctx: {}, getConfig: () => ({}), pkgDir: tmpPkg });
  assert.equal(typeof dispose, 'function');
  dispose();
});
await test('webServer.register 抛错时被吞掉', () => {
  const sctx = { webServer: { register() { throw new Error('Duplicate (kind, path)'); } } };
  const dispose = installConfigRoute({ sctx, getConfig: () => ({}), pkgDir: tmpPkg });
  assert.equal(typeof dispose, 'function');
  dispose();
});
await test('正常注册返回可用 disposer', () => {
  let disposed = 0;
  const sctx = { webServer: { register(route) { assert.equal(route.path, '/maa/api/config'); assert.equal(route.kind, 'exact'); return () => { disposed += 1; }; } } };
  const dispose = installConfigRoute({ sctx, getConfig: () => ({}), pkgDir: tmpPkg });
  dispose();
  assert.equal(disposed, 1);
});

/* ───────────── 5. client.js 冒烟 ───────────── */
section('5. client.js（浏览器模块冒烟）');
await test('factory 不抛、两个入口都注册、渲染不炸', async () => {
  const src = fs.readFileSync(path.join(PKG, 'client.js'), 'utf8');
  let captured = null;
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  const fakeWindow = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
  // 在沙箱里执行 client.js：只提供 window 与 require
  const fn = new Function('window', 'require', src);
  fn(fakeWindow, (name) => {
    if (name === 'react') return fakeReact;
    throw new Error(`unexpected require ${name}`);
  });
  assert.ok(captured, '没有调用 __ModuleLoader__.load');
  assert.equal(captured.id, '@local/dsh-maa');
  const mod = captured.factory((name) => fakeReact);
  assert.equal(typeof mod.apply, 'function');
  const registered = [];
  const ctx = { slots: { inject: (slot, cb) => { cb(); }, register: (opts, comp) => { registered.push({ opts, comp }); return () => {}; } } };
  mod.apply(ctx);
  assert.equal(registered.length, 2);
  // 快捷入口：设置 → 插件 → MAA 助手
  const tab = registered.find((r) => r.opts.name === 'settings.plugins.tab');
  assert.ok(tab, '没有注册设置页快捷入口');
  assert.equal(tab.opts.id, 'maa');
  assert.equal(tab.opts.label, 'MAA 助手');
  // 深链：插件管理页那一行
  const row = registered.find((r) => r.opts.name === 'plugins.row.config');
  assert.ok(row, '没有注册插件行配置');
  assert.equal(row.opts.key, '@local/dsh-maa#maa-plugin');
  const summary = row.comp({ view: 'summary' });
  assert.equal(typeof summary, 'string');
  // page 视图：不 fetch（node 里没有相对 URL 的 fetch），只要同步不抛即可
  const page = row.comp({ view: 'page' });
  assert.ok(page && typeof page === 'object');
  const tabPage = tab.comp({});
  assert.ok(tabPage && typeof tabPage === 'object');
});
await test('没有 React 时退化成空模块（不炸模块图）', async () => {
  const src = fs.readFileSync(path.join(PKG, 'client.js'), 'utf8');
  let captured = null;
  const fn = new Function('window', 'require', src);
  fn({ __ModuleLoader__: { load: (e) => { captured = e; } } }, () => { throw new Error('no react'); });
  const mod = captured.factory(() => { throw new Error('no react'); });
  assert.deepEqual(mod.inject, []);
  assert.doesNotThrow(() => mod.apply({}));
});

section('结果');
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
for (const f of fails) console.log(`  - ${f.name}: ${f.error}`);
process.exit(fails.length ? 1 : 0);
