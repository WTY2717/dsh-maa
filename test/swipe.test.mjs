#!/usr/bin/env node
/**
 * 滑动（maa_swipe）单测：不联网、不连模拟器、不发真手势。
 *
 * 覆盖：
 *  1. 坐标换算（横向 1920×1080 / 竖向 1080×1920）、参数校验、越界不钳制
 *  2. adb 输出解析（wm size / SurfaceOrientation / logicalFrame）
 *  3. `input swipe` 与 `input motionevent` 的命令序列（假 adb 记录参数）
 *  4. 后端探测：auto → adb-input；maatouch/minitouch 明确拒绝
 *  5. 与 MAA 任务互斥（忙就拒）
 *  6. H 关别名（规则推导 + Tile-Pos 文件名校验 + stages.json 兜底）
 *
 * 跑法：`node test/swipe.test.mjs`（在插件目录下）。
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

const coords = await imp('src/input/coords.js');
const adbInput = await imp('src/input/adb-input.js');
const backendMod = await imp('src/input/backend.js');
const inputIndex = await imp('src/input/index.js');
const stagesMod = await imp('src/stages.js');
const stagesHard = await imp('src/stages-hard.js');

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };

/* ────────────────────── 1. 坐标与校验 ────────────────────── */

section('1. 坐标换算');

await test('横向 1920×1080：×1.5，不换轴', () => {
  const p = coords.gameToDevice({ x: 640, y: 360 }, LANDSCAPE);
  assert.deepEqual({ x: p.x, y: p.y }, { x: 960, y: 540 });
  assert.equal(p.swapped, false);
  assert.equal(p.scaleX, 1.5);
  const edge = coords.gameToDevice({ x: 0, y: 0 }, LANDSCAPE);
  assert.deepEqual({ x: edge.x, y: edge.y }, { x: 0, y: 0 });
  const corner = coords.gameToDevice({ x: 1279, y: 719 }, LANDSCAPE);
  assert.ok(corner.x < 1920 && corner.y < 1080, `右上角要落在显示范围内: ${JSON.stringify(corner)}`);
});

await test('竖向 1080×1920：交换轴（游戏 x 沿长边）', () => {
  const p = coords.gameToDevice({ x: 640, y: 360 }, PORTRAIT);
  assert.deepEqual({ x: p.x, y: p.y }, { x: 540, y: 960 });
  assert.equal(p.swapped, true);
});

await test('显示尺寸非法 → 抛错（不猜）', () => {
  assert.throws(() => coords.gameToDevice({ x: 1, y: 1 }, { width: 0, height: 0 }));
  assert.throws(() => coords.gameToDevice({ x: 1, y: 1 }, null));
});

await test('validateGamePoint：合法/越界/缺字段', () => {
  assert.equal(coords.validateGamePoint({ x: 0, y: 719 }).ok, true);
  assert.equal(coords.validateGamePoint({ x: 1280, y: 100 }).ok, false);
  assert.equal(coords.validateGamePoint({ x: 100, y: 720 }).ok, false);
  assert.equal(coords.validateGamePoint({ x: -1, y: 100 }).ok, false);
  assert.equal(coords.validateGamePoint(null).ok, false);
  assert.equal(coords.validateGamePoint({ x: 'abc', y: 1 }).ok, false);
  const r = coords.validateGamePoint({ x: 10.6, y: 20.4 });
  assert.deepEqual(r.value, { x: 11, y: 20 });
});

await test('clampDevice：只处理取整溢出', () => {
  const v = coords.clampDevice({ x: 1919.6, y: 1080 }, LANDSCAPE);
  assert.deepEqual(v, { x: 1919, y: 1079 });
});

/* ────────────────────── 2. adb 输出解析 ────────────────────── */

section('2. adb 输出解析');

await test('parseWmSize：Override 优先于 Physical', () => {
  assert.deepEqual(coords.parseWmSize('Physical size: 1080x1920\n'), { width: 1080, height: 1920, override: false });
  assert.deepEqual(coords.parseWmSize('Physical size: 1080x1920\nOverride size: 720x1280\n'), { width: 720, height: 1280, override: true });
  assert.equal(coords.parseWmSize('garbage'), null);
});

await test('parseSurfaceOrientation / parseLogicalFrame', () => {
  assert.equal(coords.parseSurfaceOrientation('  SurfaceOrientation: 1\n'), 1);
  assert.equal(coords.parseSurfaceOrientation('nope'), null);
  assert.deepEqual(
    coords.parseLogicalFrame('Viewport INTERNAL: displayId=0, orientation=1, logicalFrame=[0, 0, 1920, 1080], deviceSize=[1920, 1080]'),
    { width: 1920, height: 1080 },
  );
  assert.equal(coords.parseLogicalFrame('nope'), null);
});

await test('logicalFromPhysical：旋转 90/270 交换宽高', () => {
  assert.deepEqual(coords.logicalFromPhysical({ width: 1080, height: 1920 }, 1), { width: 1920, height: 1080 });
  assert.deepEqual(coords.logicalFromPhysical({ width: 1080, height: 1920 }, 3), { width: 1920, height: 1080 });
  assert.deepEqual(coords.logicalFromPhysical({ width: 1080, height: 1920 }, 0), { width: 1080, height: 1920 });
  assert.equal(coords.logicalFromPhysical(null, 1), null);
});

await test('viewFromProbe：logicalFrame 最优先；缺旋转就报错不猜', () => {
  const a = coords.viewFromProbe({ wmText: 'Physical size: 1080x1920', inputText: 'logicalFrame=[0, 0, 1920, 1080]' });
  assert.equal(a.ok, true);
  assert.deepEqual(a.view, { width: 1920, height: 1080 });
  const b = coords.viewFromProbe({ wmText: 'Physical size: 1080x1920', inputText: 'SurfaceOrientation: 1' });
  assert.deepEqual(b.view, { width: 1920, height: 1080 });
  const c = coords.viewFromProbe({ wmText: 'Physical size: 1080x1920', inputText: '' });
  assert.equal(c.ok, false);
  assert.match(c.error, /SurfaceOrientation/);
});

/* ────────────────────── 3. 命令序列 ────────────────────── */

section('3. adb 手势命令序列');

/** 假 adb：记录每次调用的 args。 */
function fakeRun({ failOn = (args) => false } = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    const bad = failOn(args);
    return bad ? { ok: false, error: bad, stderr: bad, stdout: '' } : { ok: true, stdout: '', stderr: '', error: null };
  };
  return { run, calls };
}

await test('holdMs=0 → 单条 input swipe（系统自己插值，最平滑）', async () => {
  const { run, calls } = fakeRun();
  const r = await adbInput.swipeAdbInput({
    adbPath: 'C:/fake/adb.exe',
    address: '127.0.0.1:16384',
    from: { x: 1000, y: 400 },
    to: { x: 250, y: 400 },
    view: LANDSCAPE,
    durationMs: 180,
    deps: { run, sleep: async () => {} },
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'input swipe');
  assert.deepEqual(r.device, { x1: 1500, y1: 600, x2: 375, y2: 600 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    '-s', '127.0.0.1:16384', 'shell', 'input', 'swipe', '1500', '600', '375', '600', '180',
  ]);
});

await test('holdMs>0 → DOWN → MOVE×steps → UP，且 UP 一定发', async () => {
  const { run, calls } = fakeRun();
  const r = await adbInput.swipeAdbInput({
    adbPath: 'C:/fake/adb.exe',
    from: { x: 100, y: 100 },
    to: { x: 1100, y: 100 },
    view: LANDSCAPE,
    durationMs: 200,
    steps: 4,
    holdMs: 250,
    deps: { run, sleep: async () => {} },
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'input motionevent');
  const kinds = calls.map((c) => c.args[c.args.length - 3]);
  assert.equal(kinds[0], 'DOWN');
  assert.equal(kinds[kinds.length - 1], 'UP');
  assert.equal(kinds.filter((k) => k === 'MOVE').length, 4);
  assert.deepEqual(calls[0].args, ['shell', 'input', 'motionevent', 'DOWN', '150', '150']);
});

await test('MOVE 失败也要补 UP（否则指针卡在按下状态）', async () => {
  const { run, calls } = fakeRun({ failOn: (args) => (args.includes('MOVE') ? 'inject failed' : false) });
  const r = await adbInput.swipeAdbInput({
    adbPath: 'C:/fake/adb.exe',
    from: { x: 100, y: 100 },
    to: { x: 1100, y: 100 },
    view: LANDSCAPE,
    durationMs: 200,
    steps: 4,
    holdMs: 10,
    deps: { run, sleep: async () => {} },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /MOVE/);
  const last = calls[calls.length - 1].args;
  assert.equal(last[last.length - 3], 'UP');
});

await test('DOWN 失败 → 不发 MOVE/UP，直接报错', async () => {
  const { run, calls } = fakeRun({ failOn: (args) => (args.includes('DOWN') ? 'no device' : false) });
  const r = await adbInput.swipeAdbInput({
    adbPath: 'C:/fake/adb.exe',
    from: { x: 10, y: 10 },
    to: { x: 100, y: 100 },
    view: LANDSCAPE,
    holdMs: 5,
    deps: { run, sleep: async () => {} },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /DOWN/);
  assert.equal(calls.length, 1);
});

/* ────────────────────── 4. 后端探测 ────────────────────── */

section('4. 后端探测');

const adbOk = {
  resolveAdbPath: () => ({ ok: true, path: 'C:/fake/adb.exe', source: 'config' }),
  ensureConnected: async () => ({ ok: true, output: 'connected' }),
  probeDisplay: async () => ({ ok: true, view: LANDSCAPE, source: 'logicalFrame' }),
};
const cfgStub = { adbPath: '', adbAddress: '127.0.0.1:16384', maaHint: null, shotsDir: os.tmpdir() };

await test('auto → adb-input', async () => {
  backendMod.clearBackendCache();
  const r = await backendMod.detectInputBackend({ cfg: cfgStub, force: 'auto', deps: adbOk });
  assert.equal(r.ok, true);
  assert.equal(r.backend, 'adb-input');
  assert.deepEqual(r.view, LANDSCAPE);
});

await test('maatouch / minitouch → 明确拒绝（不装半套）', async () => {
  for (const f of ['maatouch', 'minitouch']) {
    const r = await backendMod.detectInputBackend({ cfg: cfgStub, force: f, deps: adbOk });
    assert.equal(r.ok, false);
    assert.match(r.error, /未实现/);
  }
});

await test('未知后端 → 报错', async () => {
  const r = await backendMod.detectInputBackend({ cfg: cfgStub, force: 'win32-mouse', deps: adbOk });
  assert.equal(r.ok, false);
  assert.match(r.error, /未知后端/);
});

await test('没有 adb → 报错带原因', async () => {
  const r = await backendMod.detectInputBackend({
    cfg: cfgStub,
    force: 'auto',
    deps: { ...adbOk, resolveAdbPath: () => ({ ok: false, path: null, error: '没找到 adb' }) },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /没找到 adb/);
});

/* ────────────────────── 5. 互斥与整体流程 ────────────────────── */

section('5. 互斥与整体流程');

await test('maaBusy：有排队/在跑 → 拒；空闲 → 放行', () => {
  const busy = inputIndex.maaBusy({ health: () => ({ online: true }), list: () => [{ type: 'LinkStart', state: 'dispatched', ageMs: 1000 }] });
  assert.equal(busy.pending, 1);
  const idle = inputIndex.maaBusy({ health: () => ({ online: true }), list: () => [{ type: 'HeartBeat', state: 'done', note: '', ageMs: 1000 }] });
  assert.equal(idle.pending, 0);
  assert.deepEqual(idle.running, []);
  assert.equal(inputIndex.maaBusy(null).known, false);
});

await test('MAA 忙时拒绝滑动并给理由', async () => {
  const bridge = { health: () => ({ online: true }), list: () => [{ type: 'LinkStart', state: 'dispatched', ageMs: 500 }] };
  const r = await inputIndex.swipe({ cfg: cfgStub, bridge, from: { x: 1000, y: 400 }, to: { x: 250, y: 400 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /MAA 正在跑任务/);
});

await test('参数非法：越界坐标 / 同点 / duration 超范围', async () => {
  const deps = { detectInputBackend: async () => ({ ok: true, backend: 'adb-input', adb: { path: 'C:/fake/adb.exe', address: '127.0.0.1:16384' }, view: LANDSCAPE }) };
  const base = { cfg: cfgStub, bridge: null, deps };
  assert.match((await inputIndex.swipe({ ...base, from: { x: 2000, y: 10 }, to: { x: 10, y: 10 } })).error, /越界/);
  assert.match((await inputIndex.swipe({ ...base, from: { x: 10, y: 10 }, to: { x: 10, y: 10 } })).error, /同一个点/);
  assert.match((await inputIndex.swipe({ ...base, from: { x: 10, y: 10 }, to: { x: 100, y: 10 }, durationMs: 10 })).error, /durationMs/);
  assert.match((await inputIndex.swipe({ ...base, from: { x: 10, y: 10 }, to: { x: 100, y: 10 }, steps: 1 })).error, /steps/);
});

await test('正常滑一次：换算 → 注入 → 返回设备坐标与截图字段', async () => {
  const { run, calls } = fakeRun();
  // 截图走 adb 会 spawn 一个不存在的 adb.exe（失败也算走到了截图分支）
  const r = await inputIndex.swipe({
    cfg: cfgStub,
    bridge: null,
    from: { x: 1000, y: 400 },
    to: { x: 250, y: 400 },
    durationMs: 180,
    settleMs: 0,
    deps: {
      run,
      sleep: async () => {},
      detectInputBackend: async () => ({ ok: true, backend: 'adb-input', adb: { path: 'C:/fake/adb.exe', address: '127.0.0.1:16384' }, view: LANDSCAPE }),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.backend, 'adb-input');
  assert.equal(r.mode, 'swipe');
  assert.deepEqual(r.device, { x1: 1500, y1: 600, x2: 375, y2: 600 });
  assert.ok(r.screenshot, '必须带 screenshot 字段（验收只看截图）');
  assert.deepEqual(r.from, { x: 1000, y: 400 });
  assert.equal(calls.length, 1);
});

/* ────────────────────── 6. H 关别名 ────────────────────── */

section('6. H 关别名');

await test('hardCodeToStageId：规则推导', () => {
  assert.equal(stagesHard.hardCodeToStageId('H12-2'), 'hard_12-02');
  assert.equal(stagesHard.hardCodeToStageId('h12-2'), 'hard_12-02');
  assert.equal(stagesHard.hardCodeToStageId('H 12 - 2'), 'hard_12-02');
  assert.equal(stagesHard.hardCodeToStageId('H5-1'), 'hard_05-01');
  assert.equal(stagesHard.hardCodeToStageId('H12－2'), 'hard_12-02');
  assert.equal(stagesHard.hardCodeToStageId('12-2'), null);
  assert.equal(stagesHard.hardCodeToStageId('hard_12-02'), null);
  assert.equal(stagesHard.hardCodeToStageId('H12'), null);
});

await test('resolveHardStage：Tile-Pos 校验 / 未校验 / 不存在', () => {
  const aliases = { ok: true, ids: new Set(['hard_12-02', 'main_12-02']), hard: ['hard_12-02'], source: 'x' };
  assert.deepEqual(stagesHard.resolveHardStage('H12-2', aliases), { stageId: 'hard_12-02', via: 'hard-alias', verified: true });
  assert.deepEqual(stagesHard.resolveHardStage('hard_12-02', aliases), { stageId: 'hard_12-02', via: 'tilepos-id', verified: true });
  const missing = stagesHard.resolveHardStage('H12-9', aliases);
  assert.equal(missing.stageId, null);
  assert.match(missing.error, /hard_12-09/);
  const unverified = stagesHard.resolveHardStage('H12-2', { ok: false, ids: new Set(), hard: [], source: null, error: 'no dir' });
  assert.equal(unverified.stageId, 'hard_12-02');
  assert.equal(unverified.verified, false);
});

await test('loadHardAliases：从文件名反推（不解析内容）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-tilepos-'));
  const dir = path.join(tmp, 'resource', 'Arknights-Tile-Pos');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of [
    'hard_12-02-obt-hard-level_hard_12-02.json',
    'easy_12-02-obt-main-level_easy_12-02.json',
    'main_01-07-obt-main-level_main_01-07.json',
    'notes.txt',
  ]) fs.writeFileSync(path.join(dir, n), '{}');
  stagesHard.clearHardCache();
  const r = stagesHard.loadHardAliases(tmp);
  assert.equal(r.ok, true);
  assert.deepEqual(r.hard, ['hard_12-02']);
  assert.ok(r.ids.has('main_01-07') && r.ids.has('easy_12-02'));
  const bad = stagesHard.loadHardAliases(path.join(tmp, 'nope'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /读不到/);
});

await test('resolveStageId：stages.json 查不到时用 H 别名兜底', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-stages-'));
  fs.mkdirSync(path.join(tmp, 'resource', 'Arknights-Tile-Pos'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'resource'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'resource', 'stages.json'), JSON.stringify({
    'main_01-07': { code: '1-7', stageId: 'main_01-07' },
  }));
  fs.writeFileSync(path.join(tmp, 'resource', 'Arknights-Tile-Pos', 'hard_12-02-obt-hard-level_hard_12-02.json'), '{}');
  stagesHard.clearHardCache();
  const stages = stagesMod.loadStages(tmp);
  assert.equal(stages.ok, true);
  assert.deepEqual(stagesMod.resolveStageId(stages, '1-7'), { stageId: 'main_01-07', from: 'code' });
  assert.deepEqual(stagesMod.resolveStageId(stages, 'H12-2'), { stageId: 'hard_12-02', from: 'hard-alias' });
  const miss = stagesMod.resolveStageId(stages, 'H12-9');
  assert.equal(miss.stageId, null);
  assert.match(miss.error, /stages\.json 里没有/);
  assert.match(miss.error, /Tile-Pos/);
  assert.equal(stagesMod.displayCode(stages, 'hard_12-02'), 'H12-2');
});

/* ────────────────────── 汇总 ────────────────────── */

console.log(`\n${fails.length ? '失败' : '全部通过'}: ${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
