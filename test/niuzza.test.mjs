#!/usr/bin/env node
/**
 * 牛杂（src/niuzza.js + `maa_niuzza` 工具）单测：**不连 MAA / 不连模拟器**。
 *
 * 参数口径全部来自 2026-10-28 的查证与探针（MaaCore 6.20.1 真机 append + dev-v2 源码）：
 *  - 官方协议文档：https://docs.maa.plus/zh-cn/protocol/integration.html
 *  - 源码：src/MaaCore/Task/Interface/{CustomTask,SwitchThemeTask,SingleStepTask,OperProgressTask}.cpp、
 *          src/MaaCore/Task/Reclamation/ReclamationConfig.h、src/MaaCore/Task/MiniGame/EventShopTaskPlugin.cpp、
 *          src/MaaWpfGui/Models/AsstTasks/Asst*.cs
 *  - 探针脚本：scripts/probe-niuzza-tasks*.mjs（append 只校验、零消耗）
 *
 * 锁住的口径：
 *  1. GUI 选项 → core 参数的映射（含 EventShop/SecretFront 的 Custom 短任务名编码、库存保持的 Fight/drops）；
 *  2. dryRun **默认 true**：不 connect、不 startTask、不埋点；显式 dryRun:false 才执行；
 *  3. 生息演算 Tales/mode=1 必须补齐 tools_to_craft（缺了会让 MaaCore 6.20.1 崩溃）；
 *  4. 各动作的必填/取值校验（含 core 会拒绝的写法：Fire 主题、mode=2、OperProgress 多余键…）；
 *  5. append 被 core 拒绝时的错误口径；background 走 runner（label=niuzza，工具层不重复埋点）；
 *  6. 任务状态埋点：阻塞真跑 1 次 begin + 1 次 end（type=Custom），dryRun/后台都不在工具层埋点；
 *  7. **牛杂页 9 个条目全覆盖**（v2.3.0 补全）：action ↔ Custom 短任务名 ↔ 前置界面 ↔ 代价，
 *     以及「黑流刷钱的任务名只在 cache/resource 热更资源里」这条必须靠 worker 额外加载 cache 才成立。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNiuzzaPlan,
  runNiuzza,
  clampNiuzzaTimeout,
  niuzzaHint,
  NIUZZA_ACTIONS,
  NIUZZA_TIMEOUT,
  NIUZZA_PRESET_TASKS,
  NIUZZA_PREREQ,
  NIUZZA_COSTS,
  NIUZZA_TASK_ALIASES,
  RECLAMATION_ANCHOR_MODES,
  ROGUELIKE_THEMES,
  SECRET_FRONT_EVENTS,
} from '../src/niuzza.js';
import { CORE_TASK_TYPES } from '../src/chain.js';
import { createTools } from '../src/tools.js';
import { runnerLabelToTaskType } from '../src/task-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(HERE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-niuzza-'));

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
  async wait() {
    if (this.onWait) { const fn = this.onWait; this.onWait = null; fn(this); }
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
const resetWorker = () => { FakeWorker.nextWaitHook = null; FakeWorker.nextConnect = null; FakeWorker.nextAppendError = null; };
const plan = (action, call = {}) => buildNiuzzaPlan({ action, call, cfg });
const expectInvalid = (action, call, pattern) => {
  const r = plan(action, call);
  assert.equal(r.ok, false, `${action} ${JSON.stringify(call)} 应该被拒绝`);
  if (pattern) assert.match(r.error, pattern);
  return r;
};

/* ────────────────────── 1. 自定任务（Custom） ────────────────────── */
section('1. custom：task_names + params');
await test('custom：短任务名别名映射成 tasks.json 任务名', () => {
  const r = plan('custom', { taskNames: ['event-shop', 'secret-front'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks, [{ type: 'Custom', params: { task_names: ['SS@Store@Begin', 'MiniGame@SecretFront@Begin'] } }]);
  assert.deepEqual(r.plan.aliased, { 'event-shop': 'SS@Store@Begin', 'secret-front': 'MiniGame@SecretFront@Begin' });
});
await test('custom：完整任务名原样保留，params 放进 params 字段', () => {
  const r = plan('custom', { taskNames: ['Award', 'Mall'], params: { foo: 1 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].params, { task_names: ['Award', 'Mall'], params: { foo: 1 } });
  assert.equal(r.plan.hasParams, true);
});
await test('custom：空数组 / 非数组 / 非字符串项都拒绝', () => {
  expectInvalid('custom', { taskNames: [] }, /至少 1 项/);
  expectInvalid('custom', { taskNames: 'Award' }, /必须是字符串数组/);
  expectInvalid('custom', { taskNames: ['Award', ''] }, /taskNames\[1\]/);
  expectInvalid('custom', { taskNames: ['Award'], params: ['x'] }, /params 必须是对象/);
});

/* ────────────────────── 2. 单步任务（SingleStep） ────────────────────── */
section('2. single-step：copilot stage/start/action');
await test('single-step(stage)：details.stage_name', () => {
  const r = plan('single-step', { subtype: 'stage', stageName: 'CE-6' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0], { type: 'SingleStep', params: { type: 'copilot', subtype: 'stage', details: { stage_name: 'CE-6' } } });
});
await test('single-step(start)：不需要 details', () => {
  const r = plan('single-step', { subtype: 'start' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].params, { type: 'copilot', subtype: 'start' });
});
await test('single-step：subtype 非法 / stage 缺 stageName / action 缺 actions 都拒绝', () => {
  expectInvalid('single-step', { subtype: 'nope' }, /subtype 必须是/);
  expectInvalid('single-step', { subtype: 'stage' }, /必须给 stageName/);
  expectInvalid('single-step', { subtype: 'action', details: { actions: [] } }, /actions 必须是非空数组/);
  expectInvalid('single-step', { subtype: 'action' }, /必须给 details/);
});

/* ────────────────────── 3. 更新数据（OperBox/Depot） ────────────────────── */
section('3. user-data-update：OperBox / Depot 识别');
await test('user-data-update：默认两条识别任务（不花资源）', () => {
  const r = plan('user-data-update', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks.map((t) => t.type), ['OperBox', 'Depot']);
  assert.match(r.dangers.find((d) => d.type === 'OperBox').note, /不花资源/);
});
await test('user-data-update：两个开关都关 → 拒绝；只关仓库 → 只剩 OperBox', () => {
  expectInvalid('user-data-update', { updateOperBox: false, updateDepot: false }, /不能同时为 false/);
  const r = plan('user-data-update', { updateDepot: false });
  assert.deepEqual(r.tasks.map((t) => t.type), ['OperBox']);
});

/* ────────────────────── 4. 更换主题（SwitchTheme） ────────────────────── */
section('4. switch-theme：键是 themes');
await test('switch-theme：单个 theme 字符串也转成 themes 数组', () => {
  const r = plan('switch-theme', { theme: '夜间' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0], { type: 'SwitchTheme', params: { themes: ['夜间'] } });
});
await test('switch-theme：缺参数 / 空数组 / 非字符串项都拒绝（空数组合法但工具拦下）', () => {
  expectInvalid('switch-theme', {}, /必须给 themes/);
  expectInvalid('switch-theme', { themes: [] }, /至少 1 项/);
  expectInvalid('switch-theme', { themes: [1] }, /themes\[0\]/);
});

/* ────────────────────── 5. 干员培养（OperProgress） ────────────────────── */
section('5. oper-progress：plans');
await test('oper-progress：camelCase 归一成 core 键，且只保留白名单键', () => {
  const r = plan('oper-progress', { plans: [{ role: 'Sniper', name: '能天使', elite: 2, skillLevel: 7, skillMastery: [3, 0, 0] }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].params.plans, [{ name: '能天使', role: 'Sniper', elite: 2, skill_level: 7, skill_mastery: [3, 0, 0] }]);
});
await test('oper-progress：缺 name / elite 越界 / skillLevel 越界 / 专精长度不对 都拒绝', () => {
  expectInvalid('oper-progress', { plans: [{ role: 'Sniper' }] }, /name 必填/);
  expectInvalid('oper-progress', { plans: [{ name: 'A', elite: 3 }] }, /elite 只能是 1 或 2/);
  expectInvalid('oper-progress', { plans: [{ name: 'A', skillLevel: 1 }] }, /skillLevel 只能是 2~7/);
  expectInvalid('oper-progress', { plans: [{ name: 'A', skillMastery: [1, 0] }] }, /必须是 3 个整数/);
  expectInvalid('oper-progress', { plans: [{ name: 'A', skillMastery: [4, 0, 0] }] }, /只能是 0~3/);
});
await test('oper-progress：core 不认识的键直接拒绝（core 会返回 0）', () => {
  expectInvalid('oper-progress', { plans: [{ name: '能天使', level: 90 }] }, /core 不认识的键: level/);
});
await test('oper-progress：file 读计划 JSON（{plans:[...]} 形式）', () => {
  const file = path.join(TMP, 'oper-progress.json');
  fs.writeFileSync(file, JSON.stringify({ plans: [{ name: '能天使', role: 'Sniper' }] }));
  const r = plan('oper-progress', { file });
  assert.equal(r.ok, true);
  assert.equal(r.plan.sourceFile, file);
  assert.deepEqual(r.tasks[0].params.plans, [{ name: '能天使', role: 'Sniper' }]);
});
await test('oper-progress：空 plans 拒绝；文件不存在给出可读错误', () => {
  expectInvalid('oper-progress', { plans: [] }, /不能为空/);
  const r = plan('oper-progress', { file: path.join(TMP, 'no-such.json') });
  assert.equal(r.ok, false);
  assert.match(r.error, /读不到\/解析不了计划文件/);
});

/* ────────────────────── 6. 库存保持（Depot + Fight） ────────────────────── */
section('6. depot-maintain：Depot 识别 + Fight(drops)');
await test('depot-maintain：先 Depot 再每计划一条 Fight，times 用满靠 drops 停', () => {
  const r = plan('depot-maintain', { plans: [{ stage: '1-7', dropId: '30011', dropCount: 10 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks.map((t) => t.type), ['Depot', 'Fight']);
  assert.deepEqual(r.tasks[1].params, { stage: '1-7', medicine: 0, stone: 0, times: 2147483647, series: 1, drops: { '30011': 10 } });
  assert.match(r.dangers.find((d) => d.type === 'Fight').note, /消耗理智/);
});
await test('depot-maintain：药/石头/次数可覆盖，updateDepot=false 时不发 Depot', () => {
  const r = plan('depot-maintain', { updateDepot: false, plans: [{ stage: 'CE-6', dropId: '4001', dropCount: 5, medicineCount: 2, stoneCount: 1, times: 100, series: 0 }] });
  assert.deepEqual(r.tasks.map((t) => t.type), ['Fight']);
  assert.deepEqual(r.tasks[0].params, { stage: 'CE-6', medicine: 2, stone: 1, times: 100, series: 0, drops: { '4001': 5 } });
});
await test('depot-maintain：缺 plans / 缺 stage / dropCount 非正 都拒绝', () => {
  expectInvalid('depot-maintain', {}, /必须给非空 plans/);
  expectInvalid('depot-maintain', { plans: [{ dropId: '30011', dropCount: 3 }] }, /stage 必填/);
  expectInvalid('depot-maintain', { plans: [{ stage: '1-7', dropId: '30011' }] }, /dropCount 必须是正整数/);
});

/* ────────────────────── 7. 活动商店（EventShop） ────────────────────── */
section('7. event-shop：Custom + SS@Store@Begin');
await test('event-shop：黑名单进 params.event_shop.blacklist', () => {
  const r = plan('event-shop', { blacklist: ['家具零件', '碳'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0], { type: 'Custom', params: { task_names: ['SS@Store@Begin'], params: { event_shop: { blacklist: ['家具零件', '碳'] } } } });
  assert.equal(r.plan.buysEverythingExceptBlacklist, true);
});
await test('event-shop：空黑名单不注册插件，给 warning 且不带 params', () => {
  const r = plan('event-shop', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].params, { task_names: ['SS@Store@Begin'] });
  assert.match(r.warnings.join(), /不会注册 EventShop 插件/);
});
await test('event-shop：黑名单不是字符串数组 → 拒绝（core 会静默不注册）', () => {
  expectInvalid('event-shop', { blacklist: '家具零件' }, /必须是字符串数组/);
  expectInvalid('event-shop', { blacklist: [1] }, /blacklist\[0\]/);
});

/* ────────────────────── 8. 隐秘战线（SecretFront） ────────────────────── */
section('8. secret-front：任务名编码结局/事件');
await test('secret-front：ending 归一 + event 编码进任务名', () => {
  const r = plan('secret-front', { ending: 'c', event: '游侠' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].params, { task_names: ['MiniGame@SecretFront@Begin@EndingC@游侠'] });
  assert.equal(r.plan.ending, 'C');
  assert.equal(r.plan.event, '游侠');
});
await test('secret-front：不传 ending 默认 E（资源里的默认入口），不传 event 不加后缀', () => {
  const r = plan('secret-front', {});
  assert.deepEqual(r.tasks[0].params, { task_names: ['MiniGame@SecretFront@Begin@EndingE'] });
  assert.equal(r.plan.event, null);
});
await test('secret-front：未知结局 / event 含 @ / 未知事件告警', () => {
  expectInvalid('secret-front', { ending: 'Z' }, /ending 只能是 A~E/);
  expectInvalid('secret-front', { event: 'a@b' }, /不能有 @/);
  const r = plan('secret-front', { ending: 'A', event: '不存在的事件' });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(), /不在内置事件表/);
  assert.deepEqual(SECRET_FRONT_EVENTS, ['支援作战平台', '游侠', '诡影迷踪']);
});

/* ────────────────────── 9. 生息演算（Reclamation） ────────────────────── */
section('9. reclamation：防崩 + 主题/模式编码');
await test('reclamation：Tales/mode=1 **总是**带 tools_to_craft（缺了会让 MaaCore 6.20.1 崩溃）', () => {
  const r = plan('reclamation', { theme: 'Tales', mode: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].params, { theme: 'Tales', mode: 1, tools_to_craft: ['荧光棒'], num_craft_batches: 16, increment_mode: 0 });
});
await test('reclamation：toolsToCraft 字符串/数组都接受，numCraftBatches/incrementMode 可覆盖', () => {
  const r = plan('reclamation', { theme: '沙洲遗闻', mode: 1, toolsToCraft: '荧光棒', numCraftBatches: 3, incrementMode: 1 });
  assert.deepEqual(r.tasks[0].params.tools_to_craft, ['荧光棒']);
  assert.equal(r.tasks[0].params.num_craft_batches, 3);
  assert.equal(r.tasks[0].params.increment_mode, 1);
});
await test('reclamation：重启锚点 mode 支持 RA-1/RA-4/RA-15 与数字编码', () => {
  assert.equal(plan('reclamation', { theme: 'RelaunchAnchor', mode: 'RA-1' }).tasks[0].params.mode, RECLAMATION_ANCHOR_MODES['RA-1']);
  assert.equal(plan('reclamation', { theme: 'RelaunchAnchor', mode: 'RA-15' }).tasks[0].params.mode, 32);
  assert.equal(plan('reclamation', { theme: 'RelaunchAnchor', mode: 48 }).tasks[0].params.mode, 48);
  assert.equal(plan('reclamation', { theme: 'RelaunchAnchor' }).tasks[0].params.mode, 16);
});
await test('reclamation：Fire（沙中之火）已下线 → 拒绝；未知主题/非法 mode 都拒绝', () => {
  expectInvalid('reclamation', { theme: 'Fire' }, /已下线/);
  expectInvalid('reclamation', { theme: '沙中之火' }, /已下线/);
  expectInvalid('reclamation', { theme: 'Nope' }, /只能是 Tales/);
  expectInvalid('reclamation', { theme: 'Tales', mode: 2 }, /只能是 0/);
  expectInvalid('reclamation', { theme: 'RelaunchAnchor', mode: 0 }, /RA-1\(16\)/);
  expectInvalid('reclamation', { theme: 'Tales', difficulty: 9 }, /difficulty 只能是/);
  expectInvalid('reclamation', { theme: 'Tales', incrementMode: 2 }, /incrementMode 只能是/);
});

/* ────────────────────── 10. 自动肉鸽（Roguelike） ────────────────────── */
section('10. roguelike：投资/刷钱常用字段');
await test('roguelike：常用字段 camelCase → core 键', () => {
  const r = plan('roguelike', { theme: 'Sami', mode: 5, startsCount: 2, investmentsCount: 999, investmentEnabled: true, squad: '指挥分队', coreChar: '能天使' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].params, {
    theme: 'Sami', mode: 5, starts_count: 2, investments_count: 999, squad: '指挥分队', core_char: '能天使', investment_enabled: true,
  });
});
await test('roguelike：主题白名单与已移除 mode 都被拦下', () => {
  expectInvalid('roguelike', { theme: 'Nope' }, /theme 只能是/);
  expectInvalid('roguelike', { theme: 'Sami', mode: 2 }, /已移除/);
  expectInvalid('roguelike', { theme: 'Sami', mode: 3 }, /不被 core 接受/);
  assert.ok(ROGUELIKE_THEMES.includes('BlackFlow'));
});
await test('roguelike：params 透传高级字段（如 expected_collapsal_paradigms）', () => {
  const r = plan('roguelike', { theme: 'Sami', mode: 5, params: { expected_collapsal_paradigms: ['目空一些'] } });
  assert.deepEqual(r.tasks[0].params.expected_collapsal_paradigms, ['目空一些']);
});
await test('未知 action → 拒绝并列出可用动作', () => {
  const r = expectInvalid('bogus', {}, /action 不认识/);
  assert.equal(r.advice, null);
  assert.ok(NIUZZA_ACTIONS.includes('event-shop'));
});

/* ────────────────────── 11. 牛杂页 9 个条目（v2.3.0 补全） ────────────────────── */
/* 依据：src/MaaWpfGui/Services/StageManager.cs 的 InitializeDefaultMiniGameEntries（常驻功能 7 条）、
 *       ViewModels/UI/ToolboxViewModel.cs 的 GetMiniGameTask（隐秘战线编码结局/事件）、
 *       Main/AsstProxy.cs 的 AsstMiniGame（统一 Custom 单任务名）、
 *       API 下发的 StageActivityV2.json miniGame[].Value（当期活动「黑流树海刷钱」）。
 * append 验证：scripts/probe-niuzza-tasks-4.mjs（14 例，零消耗）。 */
section('11. 牛杂页 9 个条目：action ↔ Custom 短任务名 ↔ 前置界面 ↔ 代价');

await test('9 个条目 action 按界面顺序排在最前，且都有 preset 任务名与前置界面', () => {
  assert.deepEqual(NIUZZA_ACTIONS.slice(0, 9), [
    'blackflow-money', 'secret-front', 'event-shop', 'green-shop', 'yellow-shop',
    'reclamation-shop', 'auto-raise-potential', 'material-synthesis', 'phantom-crown',
  ]);
  for (const a of NIUZZA_ACTIONS) {
    assert.ok(NIUZZA_PREREQ[a], `${a} 缺前置界面说明`);
    assert.ok(NIUZZA_COSTS[a], `${a} 缺代价说明`);
  }
  assert.deepEqual(NIUZZA_PRESET_TASKS, {
    'blackflow-money': 'BlackFlowTemporary@Begin',
    'secret-front': 'MiniGame@SecretFront@Begin',
    'event-shop': 'SS@Store@Begin',
    'green-shop': 'GreenTicket@Store@Begin',
    'yellow-shop': 'YellowTicket@Store@Begin',
    'reclamation-shop': 'RA@Store@Begin',
    'auto-raise-potential': 'MiniGame@AutoRaisePotential@Begin',
    'material-synthesis': 'MiniGame@MaterialSynthesis@Begin',
    'phantom-crown': 'MiniGame@CursedRelic@Begin',
  });
});

await test('blackflow-money：Custom + BlackFlowTemporary@Begin，写明热更资源与前置「开始探索」', () => {
  const r = plan('blackflow-money', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks, [{ type: 'Custom', params: { task_names: ['BlackFlowTemporary@Begin'] } }]);
  assert.equal(r.plan.needsHotfixResource, true);
  assert.match(r.plan.prereq, /开始探索/);
  assert.match(r.warnings.join(), /cache\\resource/);
  assert.match(r.warnings.join(), /roguelike/); // 指向新版自动肉鸽的刷源石锭策略
  assert.match(r.dangers.find((d) => d.type === 'Custom').note, /肉鸽刷钱/);
});

await test('blackflow-money：不给参数（GUI 没有可调项），多传参数直接拒绝', () => {
  expectInvalid('blackflow-money', { theme: 'BlackFlow' }, /不接受这些参数: theme/);
});

await test('green-shop：Custom + GreenTicket@Store@Begin（隐式前缀模板），买一层全部+二层两项', () => {
  const r = plan('green-shop', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].params, { task_names: ['GreenTicket@Store@Begin'] });
  assert.equal(r.plan.viaImplicitPrefixTask, true);
  assert.deepEqual(r.plan.buys, ['一层：全部商品', '二层：寻访凭证（单抽）、招聘许可']);
  assert.match(r.plan.prereq, /资质凭证区/);
  assert.match(r.warnings.join(), /隐式生成/);
  assert.match(r.dangers[0].note, /资质凭证/);
  expectInvalid('green-shop', { blacklist: ['家具零件'] }, /不接受这些参数/);
});

await test('yellow-shop：Custom + YellowTicket@Store@Begin，建议 258 张黄票', () => {
  const r = plan('yellow-shop', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].params, { task_names: ['YellowTicket@Store@Begin'] });
  assert.equal(r.plan.recommendedTickets, 258);
  assert.match(r.plan.prereq, /高级凭证区/);
  assert.match(r.dangers[0].note, /高级凭证/);
});

await test('reclamation-shop：Custom + RA@Store@Begin（RA 资源里显式定义，不是隐式前缀）', () => {
  const r = plan('reclamation-shop', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].params, { task_names: ['RA@Store@Begin'] });
  assert.equal(r.plan.viaImplicitPrefixTask, undefined);
  assert.match(r.plan.prereq, /生息演算商店/);
  assert.match(r.dangers[0].note, /生息演算代币/);
});

await test('auto-raise-potential：默认不带 params；useNormalToken 才带 auto_raise_potential', () => {
  const plain = plan('auto-raise-potential', {});
  assert.deepEqual(plain.tasks[0].params, { task_names: ['MiniGame@AutoRaisePotential@Begin'] });
  assert.equal(plain.plan.useNormalToken, false);
  const token = plan('auto-raise-potential', { useNormalToken: true });
  assert.deepEqual(token.tasks[0].params, {
    task_names: ['MiniGame@AutoRaisePotential@Begin'],
    params: { auto_raise_potential: { use_normal_token: true } },
  });
  assert.equal(token.plan.useNormalToken, true);
  assert.match(token.plan.prereq, /干员列表/);
});

await test('auto-raise-potential：snake_case 也接受；顶层别的键拒绝（core 只认 params 里那个）', () => {
  assert.equal(plan('auto-raise-potential', { use_normal_token: true }).plan.useNormalToken, true);
  expectInvalid('auto-raise-potential', { use_normal_token: 'x', auto_raise_potential: {} }, /不接受这些参数/);
});

await test('material-synthesis：Custom + MiniGame@MaterialSynthesis@Begin，前置「加工站合成页」', () => {
  const r = plan('material-synthesis', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].params, { task_names: ['MiniGame@MaterialSynthesis@Begin'] });
  assert.match(r.plan.prereq, /加工站/);
  assert.match(r.dangers[0].note, /龙门币/);
});

await test('phantom-crown：Custom + MiniGame@CursedRelic@Begin，前置「探索」按钮可见', () => {
  const r = plan('phantom-crown', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].params, { task_names: ['MiniGame@CursedRelic@Begin'] });
  assert.match(r.plan.prereq, /探索/);
  assert.match(r.warnings.join(), /维多利亚王冠/);
  assert.match(r.dangers[0].note, /放弃/);
});

await test('新增 5 个 action 名同时是 custom 的短任务名别名', () => {
  for (const a of ['blackflow-money', 'green-shop', 'yellow-shop', 'reclamation-shop', 'phantom-crown']) {
    assert.equal(NIUZZA_TASK_ALIASES[a], NIUZZA_PRESET_TASKS[a], `${a} 别名没对上`);
  }
  const r = plan('custom', { taskNames: ['green-shop', 'phantom-crown'] });
  assert.deepEqual(r.tasks[0].params.task_names, ['GreenTicket@Store@Begin', 'MiniGame@CursedRelic@Begin']);
});

await test('niuzzaHint：每条都带「前置界面」，且危险动作写明 Custom 的具体代价', () => {
  const r = plan('green-shop', {});
  const hint = niuzzaHint({ action: 'green-shop', plan: r.plan, dryRun: true, dangers: r.dangers });
  assert.match(hint, /前置界面/);
  assert.match(hint, /资质凭证区/);
  assert.match(hint, /花资质凭证/);
  const real = niuzzaHint({ action: 'blackflow-money', plan: plan('blackflow-money', {}).plan, dryRun: false });
  assert.match(real, /前置界面/);
  assert.match(real, /黑流树海肉鸽/);
});

await test('runNiuzza：green-shop dryRun 只 append Custom，不 connect / 不 startTask', async () => {
  resetWorker();
  const r = await runNiuzza({ action: 'green-shop', call: {}, cfg, dryRun: true, deps: deps() });
  const w = FakeWorker.last;
  assert.equal(r.ok, true);
  assert.equal(r.status, 'dry-run');
  assert.deepEqual(w.appended, [{ type: 'Custom', params: { task_names: ['GreenTicket@Store@Begin'] } }]);
  assert.equal(w.connected, false);
  assert.equal(w.startedTask, false);
  assert.equal(r.plan.taskName, 'GreenTicket@Store@Begin');
});

await test('worker.open 会额外加载 cache/resource（BlackFlowTemporary 只在热更资源里）', () => {
  const src = fs.readFileSync(path.join(PKG, 'src', 'core', 'worker.mjs'), 'utf8');
  assert.match(src, /cache/, 'worker 没提 cache（黑流刷钱 append 会返回 0）');
  assert.match(src, /AsstLoadResource/);
  // 先 resource 再 cache：注释与实现都要保留这个顺序说明
  assert.match(src, /loadCache/);
});

/* ────────────────────── 12. dryRun 默认 / 真跑 / 超时 ────────────────────── */
section('12. runNiuzza：dryRun 默认 true，真跑才 connect+start');
await test('runNiuzza：dryRun=true 只 append，不 connect / 不 startTask，worker 仍 close', async () => {
  resetWorker();
  const r = await runNiuzza({ action: 'event-shop', call: { blacklist: ['家具碎片'] }, cfg, dryRun: true, deps: deps() });
  const w = FakeWorker.last;
  assert.equal(r.ok, true);
  assert.equal(r.status, 'dry-run');
  assert.equal(r.dryRun, true);
  assert.equal(r.action, 'event-shop');
  assert.deepEqual(r.appended, [{ type: 'Custom', taskId: 1 }]);
  assert.equal(w.connected, false);
  assert.equal(w.startedTask, false);
  assert.equal(w.closed, true);
  assert.match(r.hint, /绝不会执行/);
  assert.match(r.hint, /真跑会/);
});
await test('runNiuzza：显式 dryRun:false 才 connect + startTask，并回传 taskIds', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => w.emit(3, { finished_tasks: [1] });
  const r = await runNiuzza({ action: 'switch-theme', call: { themes: ['夜间'] }, cfg, dryRun: false, deps: deps() });
  const w = FakeWorker.last;
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, false);
  assert.equal(w.connected, true);
  assert.equal(w.startedTask, true);
  assert.deepEqual(w.appended, [{ type: 'SwitchTheme', params: { themes: ['夜间'] } }]);
  assert.match(r.hint, /本次实际执行/);
});
await test('runNiuzza：参数非法时不创建 core 会话（直接 invalid）', async () => {
  resetWorker();
  const before = FakeWorker.created;
  const r = await runNiuzza({ action: 'switch-theme', call: {}, cfg, dryRun: false, deps: deps() });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'invalid');
  assert.equal(FakeWorker.created, before);
});
await test('runNiuzza：append 被 core 拒绝 → append-failed，带失败任务名', async () => {
  resetWorker();
  FakeWorker.nextAppendError = { Reclamation: 'AsstAppendTask 返回 0' };
  const r = await runNiuzza({ action: 'reclamation', call: { theme: 'Tales', mode: 0 }, cfg, dryRun: true, deps: deps() });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'append-failed');
  assert.equal(r.failedTask, 'Reclamation');
  assert.match(r.error, /append Reclamation 失败/);
  assert.equal(FakeWorker.last.closed, true);
});
await test('超时钳制：默认 900，范围 30~7200（生息演算能用长超时）', () => {
  assert.equal(clampNiuzzaTimeout(undefined), NIUZZA_TIMEOUT.default);
  assert.equal(clampNiuzzaTimeout(1), 30);
  assert.equal(clampNiuzzaTimeout(99999), 7200);
  assert.equal(clampNiuzzaTimeout(1800), 1800);
});
await test('niuzzaHint：dryRun / 真跑 / 后台三种口径，并写明本动作代价', () => {
  assert.match(niuzzaHint({ action: 'reclamation', dryRun: true, plan: { tasks: 'Reclamation' } }), /tools_to_craft/);
  assert.match(niuzzaHint({ action: 'event-shop', dryRun: false }), /花活动代币/);
  assert.match(niuzzaHint({ action: 'secret-front', dryRun: false, background: true }), /maa_copilot_stop/);
  assert.match(niuzzaHint({ action: 'roguelike', dryRun: false, status: 'timeout' }), /可能还在跑/);
});

/* ────────────────────── 13. 工具层：runner + 任务状态埋点 ────────────────────── */
section('13. maa_niuzza 工具层（runner / task-state）');
const makeTools = ({ runner = null, state = null, toolDeps = deps() } = {}) => createTools({
  getConfig: () => ({ dataDir: path.join(TMP, 'data') }),
  pkgDir: PKG,
  getBridge: async () => ({}),
  pkgVersion: 'test',
  copilotRunner: runner,
  taskState: state,
  deps: toolDeps,
});
const niuzzaTool = (opts) => makeTools(opts).find((t) => t.name === 'maa_niuzza');

await test('工具：不传 dryRun 时默认 true（不 connect、不 startTask、不埋点）', async () => {
  resetWorker();
  const calls = { begin: 0, end: 0 };
  const state = { beginTask: () => { calls.begin += 1; return 'tok'; }, endTask: () => { calls.end += 1; } };
  const r = await niuzzaTool({ state }).execute({ action: 'switch-theme', themes: ['夜间'] });
  assert.equal(r.dryRun, true);
  assert.equal(r.status, 'dry-run');
  assert.equal(FakeWorker.last.connected, false);
  assert.equal(FakeWorker.last.startedTask, false);
  assert.equal(calls.begin, 0);
  assert.equal(calls.end, 0);
});
await test('工具：dryRun:false 阻塞执行 → 1 次 begin(type=Custom,source=core) + 1 次 end', async () => {
  resetWorker();
  FakeWorker.nextWaitHook = (w) => w.emit(3, { finished_tasks: [1] });
  const calls = { begin: [], end: [] };
  const state = { beginTask: (a) => { calls.begin.push(a); return 'tok-9'; }, endTask: (a) => { calls.end.push(a); } };
  const r = await niuzzaTool({ state }).execute({ action: 'user-data-update', dryRun: false, updateDepot: false });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.begin, [{ type: 'Custom', source: 'core' }]);
  assert.deepEqual(calls.end, [{ token: 'tok-9', status: 'SUCCESS' }]);
});
await test('工具：background 走 runner（label=niuzza），工具层不重复 beginTask', async () => {
  resetWorker();
  const started = [];
  const begin = [];
  const runner = { startJob: (args) => { started.push(args); return { ok: true, runId: 'run-1', label: args.label }; } };
  const r = await niuzzaTool({ runner, state: { beginTask: (...a) => begin.push(a), endTask: () => {} } })
    .execute({ action: 'secret-front', ending: 'B', dryRun: false, background: true });
  assert.equal(r.runId, 'run-1');
  assert.equal(started[0].label, 'niuzza');
  assert.match(started[0].hint, /maa_copilot_stop/);
  assert.equal(begin.length, 0, '后台任务由 runner 钩子记账');
  assert.equal(r.dryRun, false);
  assert.deepEqual(r.tasks[0].params.task_names, ['MiniGame@SecretFront@Begin@EndingB']);
});
await test('工具：后台缺 runner 时给出可执行错误', async () => {
  const r = await niuzzaTool({}).execute({ action: 'reclamation', theme: 'Tales', dryRun: false, background: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /runner 未注入/);
});
await test('工具：参数非法直接 invalid，不建 core 会话也不埋点', async () => {
  resetWorker();
  const before = FakeWorker.created;
  let began = 0;
  const r = await niuzzaTool({ state: { beginTask: () => { began += 1; }, endTask: () => {} } })
    .execute({ action: 'event-shop', blacklist: 'not-an-array' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'invalid');
  assert.equal(FakeWorker.created, before);
  assert.equal(began, 0);
});
await test('runnerLabelToTaskType：niuzza → Custom（契约不新增枚举）', () => {
  assert.equal(runnerLabelToTaskType('niuzza'), 'Custom');
  assert.equal(runnerLabelToTaskType('chain'), 'Custom');
});
await test('chain 白名单包含牛杂要用的 core 类型（SwitchTheme / OperProgress）', () => {
  for (const t of ['Custom', 'SingleStep', 'SwitchTheme', 'OperProgress', 'Reclamation', 'Roguelike', 'OperBox', 'Depot', 'Fight']) {
    assert.ok(CORE_TASK_TYPES.includes(t), `白名单缺 ${t}`);
  }
  for (const t of ['EventShop', 'SecretFront', 'UserDataUpdate', 'DepotMaintain']) {
    assert.ok(!CORE_TASK_TYPES.includes(t), `${t} 不是 core 类型，不能进白名单`);
  }
});

console.log('');
if (fails.length) {
  console.error(`失败 ${fails.length} 项：`);
  for (const f of fails) console.error(` - ${f.name}: ${f.error}`);
  process.exit(1);
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
console.log(`全部通过: ${pass} 通过 / 0 失败`);
