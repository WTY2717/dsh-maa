// 牛杂（MAA 小工具）任务参数探针：只 append、不 connect、不 startTask —— 零消耗、不动存档。
// 用法：node scripts/probe-niuzza-tasks.mjs
// 覆盖：Custom（含 EventShop/SecretFront/MaterialSynthesis/PixelPaint/AutoRaisePotential 的短任务名）、
//       SwitchTheme / SingleStep / OperProgress / Reclamation / Roguelike / OperBox / Depot。
// 参数来源见 docs/plans/maa-plugin-plan.md §25（官方协议文档 + MaaCore dev-v2 源码）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const { resolveConfig } = await import(new URL('../src/config.js', import.meta.url));
const { CoreWorker } = await import(new URL('../src/core/driver.js', import.meta.url));

const cfg = resolveConfig({}, PLUGIN);

const CASES = [
  // ── 已确认可用的基线 ──
  { name: 'Custom: Award+Mall', type: 'Custom', params: { task_names: ['Award', 'Mall'] }, expect: 'ok' },
  { name: 'OperBox: {}', type: 'OperBox', params: {}, expect: 'ok' },
  { name: 'Depot: {}', type: 'Depot', params: {}, expect: 'ok' },

  // ── 活动商店（Custom 短任务名 SS@Store@Begin） ──
  { name: 'Custom: EventShop 带黑名单', type: 'Custom', params: { task_names: ['SS@Store@Begin'], params: { event_shop: { blacklist: ['龙门币'] } } }, expect: 'ok' },
  { name: 'Custom: EventShop 空黑名单（不注册插件，仅跑入口链）', type: 'Custom', params: { task_names: ['SS@Store@Begin'], params: { event_shop: { blacklist: [] } } }, expect: 'ok' },
  { name: 'Custom: EventShop 黑名单非字符串', type: 'Custom', params: { task_names: ['SS@Store@Begin'], params: { event_shop: { blacklist: [1] } } }, expect: '?' },

  // ── 隐秘战线（Custom 短任务名，结局/事件编码在任务名里） ──
  { name: 'Custom: SecretFront 基础', type: 'Custom', params: { task_names: ['MiniGame@SecretFront@Begin'] }, expect: 'ok' },
  { name: 'Custom: SecretFront EndingC', type: 'Custom', params: { task_names: ['MiniGame@SecretFront@Begin@EndingC'] }, expect: 'ok' },
  { name: 'Custom: SecretFront EndingA + 事件名', type: 'Custom', params: { task_names: ['MiniGame@SecretFront@Begin@EndingA@测试事件'] }, expect: 'ok' },

  // ── 其它小游戏 ──
  { name: 'Custom: MaterialSynthesis', type: 'Custom', params: { task_names: ['MiniGame@MaterialSynthesis@Begin'] }, expect: 'ok' },
  { name: 'Custom: AutoRaisePotential', type: 'Custom', params: { task_names: ['MiniGame@AutoRaisePotential@Begin'] }, expect: 'ok' },
  { name: 'Custom: AutoRaisePotential 用普通信物', type: 'Custom', params: { task_names: ['MiniGame@AutoRaisePotential@Begin'], params: { auto_raise_potential: { use_normal_token: true } } }, expect: 'ok' },
  { name: 'Custom: PixelPaint 1 组 1 点', type: 'Custom', params: { task_names: ['MiniGame@PixelPaint@Begin'], params: { pixel_paint: { swipe: true, groups: [{ color: 1, points: [[0, 0]] }] } } }, expect: 'ok' },
  { name: 'Custom: GachaOnce', type: 'Custom', params: { task_names: ['GachaOnce'] }, expect: '?' },
  { name: 'Custom: 不存在的任务名', type: 'Custom', params: { task_names: ['NoSuchTask@Begin'] }, expect: 'reject' },
  { name: 'Custom: task_names 缺失', type: 'Custom', params: {}, expect: 'reject' },

  // ── 更换主题 ──
  { name: 'SwitchTheme: themes=["夜间"]', type: 'SwitchTheme', params: { themes: ['夜间'] }, expect: 'ok' },
  { name: 'SwitchTheme: themes=[]（跳过）', type: 'SwitchTheme', params: { themes: [] }, expect: 'ok' },
  { name: 'SwitchTheme: 缺 themes', type: 'SwitchTheme', params: {}, expect: 'reject' },
  { name: 'SwitchTheme: 旧猜测 theme="Fire"', type: 'SwitchTheme', params: { theme: 'Fire' }, expect: 'reject' },

  // ── 单步任务（自动战斗逐步） ──
  { name: 'SingleStep: copilot/stage', type: 'SingleStep', params: { type: 'copilot', subtype: 'stage', details: { stage_name: '1-7' } }, expect: 'ok' },
  { name: 'SingleStep: copilot/start', type: 'SingleStep', params: { type: 'copilot', subtype: 'start' }, expect: 'ok' },
  { name: 'SingleStep: 空参数', type: 'SingleStep', params: {}, expect: 'reject' },

  // ── 干员培养 ──
  { name: 'OperProgress: plans=[{name:阿米娅}]', type: 'OperProgress', params: { plans: [{ name: '阿米娅' }] }, expect: '?' },
  { name: 'OperProgress: 带 role/elite/skill', type: 'OperProgress', params: { plans: [{ role: 'Caster', name: '阿米娅', elite: 2, skill_level: 7, skill_mastery: [1, 0, 0] }] }, expect: '?' },
  { name: 'OperProgress: 不存在的干员', type: 'OperProgress', params: { plans: [{ name: '这干员不存在' }] }, expect: 'reject' },
  { name: 'OperProgress: 缺 plans', type: 'OperProgress', params: {}, expect: 'reject' },

  // ── 生息演算 ──
  { name: 'Reclamation: Tales/0', type: 'Reclamation', params: { theme: 'Tales', mode: 0 }, expect: 'ok' },
  { name: 'Reclamation: Tales/1 + 制造', type: 'Reclamation', params: { theme: 'Tales', mode: 1, tools_to_craft: ['荧光棒'], num_craft_batches: 2, increment_mode: 0, clear_store: false }, expect: 'ok' },
  { name: 'Reclamation: RelaunchAnchor RA-1 (mode=16)', type: 'Reclamation', params: { theme: 'RelaunchAnchor', mode: 16 }, expect: 'ok' },
  { name: 'Reclamation: RelaunchAnchor RA-4 (mode=48)', type: 'Reclamation', params: { theme: 'RelaunchAnchor', mode: 48 }, expect: 'ok' },
  { name: 'Reclamation: RelaunchAnchor RA-15 (mode=32)', type: 'Reclamation', params: { theme: 'RelaunchAnchor', mode: 32 }, expect: 'ok' },
  { name: 'Reclamation: RelaunchAnchor 用 Tales 的 mode=0', type: 'Reclamation', params: { theme: 'RelaunchAnchor', mode: 0 }, expect: 'reject' },
  { name: 'Reclamation: 旧字段 tool_to_craft', type: 'Reclamation', params: { theme: 'Tales', mode: 1, tool_to_craft: '荧光棒', max_craft_count_per_round: 2 }, expect: '?' },
  { name: 'Reclamation: theme=Fire（已下线，append 成功但立刻 Stop）', type: 'Reclamation', params: { theme: 'Fire' }, expect: 'ok' },
  { name: 'Reclamation: 未知 theme', type: 'Reclamation', params: { theme: 'Nope' }, expect: 'reject' },

  // ── 自动肉鸽 ──
  { name: 'Roguelike: Sami mode=0 starts=2', type: 'Roguelike', params: { theme: 'Sami', mode: 0, starts_count: 2 }, expect: '?' },
  { name: 'Roguelike: Phantom mode=1 投资', type: 'Roguelike', params: { theme: 'Phantom', mode: 1, investments_count: 999 }, expect: '?' },
  { name: 'Roguelike: 未知 theme', type: 'Roguelike', params: { theme: 'Nope', mode: 0 }, expect: 'reject' },
];

const worker = new CoreWorker({ logDir: path.join(PLUGIN, 'data', 'logs'), nodePath: cfg.nodePath, onEvent: () => {} });
const out = [];
try {
  await worker.start();
  // 不 connect：append 不校验模拟器，只校验任务名与参数
  await worker.open({ installDir: cfg.maaInstallPath, userDir: cfg.coreUserDir, extras: null });
  for (const c of CASES) {
    let got;
    let error = null;
    try {
      const r = await worker.append(c.type, c.params);
      got = 'ok';
      out.push({ name: c.name, type: c.type, params: c.params, got, taskId: r.taskId, expect: c.expect, match: c.expect === 'ok' || c.expect === '?' });
      continue;
    } catch (e) {
      got = 'reject';
      error = String(e?.message || e);
    }
    out.push({ name: c.name, type: c.type, params: c.params, got, error, expect: c.expect, match: c.expect === 'reject' || c.expect === '?' });
  }
} catch (e) {
  console.error('probe failed:', e?.message || e);
  out.push({ fatal: String(e?.message || e) });
} finally {
  try { await worker.close(); } catch { /* ignore */ }
}

const report = {
  at: new Date().toISOString(),
  maaInstallPath: cfg.maaInstallPath,
  results: out,
  summary: {
    total: out.filter((r) => r.name).length,
    accepted: out.filter((r) => r.got === 'ok').length,
    rejected: out.filter((r) => r.got === 'reject').length,
    unexpected: out.filter((r) => r.name && !r.match).map((r) => `${r.name}: 期望 ${r.expect}，实际 ${r.got}`),
  },
};
const file = path.join(PLUGIN, 'data', 'logs', `probe-niuzza-${Date.now()}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.summary, null, 1));
for (const r of out) {
  if (!r.name) continue;
  const status = r.got === 'ok' ? `OK taskId=${r.taskId}` : 'REJECT';
  const flag = r.match ? '' : '  <<< 与预期不符';
  console.log(`${status.padEnd(16)} ${r.name}${flag}`);
  if (r.error) console.log(`    ${r.error.slice(0, 200)}`);
}
console.log('dump:', file);
