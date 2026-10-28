// 牛杂探针第四组：把「牛杂」页剩下 7 个条目对应的 core payload 全部 append 一遍（零消耗）。
// 只 worker.start → open → append，不 connect、不 startTask，因此不花任何资源、不动游戏。
//
// 覆盖（GUI 源码 MaaWpfGui 6.21-beta 为准，见 docs/plans/maa-niuzza-scope.md「实现映射结果」）：
//   黑流树海刷钱   Custom{task_names:["BlackFlowTemporary@Begin"]}
//   绿票商店       Custom{task_names:["GreenTicket@Store@Begin"]}      ← Store@Begin 的隐式前缀模板
//   黄票商店       Custom{task_names:["YellowTicket@Store@Begin"]}
//   生息演算商店   Custom{task_names:["RA@Store@Begin"]}
//   刷傀影皇冠     Custom{task_names:["MiniGame@CursedRelic@Begin"]}
//   自动提升潜能   Custom{task_names:["MiniGame@AutoRaisePotential@Begin"],params:{...use_normal_token}}
//   缺口材料合成   Custom{task_names:["MiniGame@MaterialSynthesis@Begin"]}
//
// 用法：node scripts/probe-niuzza-tasks-4.mjs
//   加 --no-cache 可对比「只加载 resource、不加载 cache/resource」时的差异（默认两者都加载，与 GUI 一致）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const { resolveConfig } = await import(new URL('../src/config.js', import.meta.url));
const { CoreWorker } = await import(new URL('../src/core/driver.js', import.meta.url));
const cfg = resolveConfig({}, PLUGIN);
const noCache = process.argv.includes('--no-cache');

const CASES = [
  // ── 基线（已在 v2.3.0 验证过） ──
  { name: 'Custom: Store@Begin（绿/黄票的公共入口）', type: 'Custom', params: { task_names: ['Store@Begin'] }, expect: 'ok' },
  { name: 'Custom: SS@Store@Begin（活动商店）', type: 'Custom', params: { task_names: ['SS@Store@Begin'], params: { event_shop: { blacklist: ['龙门币'] } } }, expect: 'ok' },

  // ── 1. 黑流树海刷钱 ──
  { name: 'Custom: BlackFlowTemporary@Begin（黑流刷钱）', type: 'Custom', params: { task_names: ['BlackFlowTemporary@Begin'] }, expect: '?' },

  // ── 4/5/6. 三个票种商店 ──
  { name: 'Custom: GreenTicket@Store@Begin（绿票）', type: 'Custom', params: { task_names: ['GreenTicket@Store@Begin'] }, expect: '?' },
  { name: 'Custom: YellowTicket@Store@Begin（黄票）', type: 'Custom', params: { task_names: ['YellowTicket@Store@Begin'] }, expect: '?' },
  { name: 'Custom: RA@Store@Begin（生息演算商店）', type: 'Custom', params: { task_names: ['RA@Store@Begin'] }, expect: '?' },
  { name: 'Custom: 不存在的票种 RedTicket@Store@Begin', type: 'Custom', params: { task_names: ['RedTicket@Store@Begin'] }, expect: '?' },

  // ── 7/8. 自动提升潜能 / 缺口材料合成 ──
  { name: 'Custom: AutoRaisePotential 默认（不消耗普通信物）', type: 'Custom', params: { task_names: ['MiniGame@AutoRaisePotential@Begin'] }, expect: 'ok' },
  { name: 'Custom: AutoRaisePotential + use_normal_token', type: 'Custom', params: { task_names: ['MiniGame@AutoRaisePotential@Begin'], params: { auto_raise_potential: { use_normal_token: true } } }, expect: 'ok' },
  { name: 'Custom: MaterialSynthesis', type: 'Custom', params: { task_names: ['MiniGame@MaterialSynthesis@Begin'] }, expect: 'ok' },

  // ── 9. 刷傀影维多利亚皇冠 ──
  { name: 'Custom: CursedRelic（傀影皇冠）', type: 'Custom', params: { task_names: ['MiniGame@CursedRelic@Begin'] }, expect: '?' },

  // ── 负例：名字写错必须被拒（证明 append 真在校验任务名） ──
  { name: 'Custom: GreenTicket@Store@Begin@Nope', type: 'Custom', params: { task_names: ['GreenTicket@Store@Begin@Nope'] }, expect: 'reject' },
  { name: 'Custom: MiniGame@CursedRelic@Nope', type: 'Custom', params: { task_names: ['MiniGame@CursedRelic@Nope'] }, expect: 'reject' },
  { name: 'Custom: BlackFlowTemporary@Nope', type: 'Custom', params: { task_names: ['BlackFlowTemporary@Nope'] }, expect: 'reject' },
];

const worker = new CoreWorker({ logDir: path.join(PLUGIN, 'data', 'logs'), nodePath: cfg.nodePath, onEvent: () => {} });
const out = [];
try {
  await worker.start();
  await worker.open({ installDir: cfg.maaInstallPath, userDir: cfg.coreUserDir, extras: null, loadCache: !noCache });
  for (const c of CASES) {
    try {
      const r = await worker.append(c.type, c.params);
      out.push({ name: c.name, type: c.type, params: c.params, got: 'ok', taskId: r.taskId, expect: c.expect });
    } catch (e) {
      const msg = String(e?.message || e);
      const crash = /子进程已退出|子进程未运行/.test(msg);
      out.push({ name: c.name, type: c.type, params: c.params, got: crash ? 'crash' : 'reject', error: msg, expect: c.expect });
      if (crash) break;
    }
  }
} catch (e) {
  out.push({ fatal: String(e?.message || e) });
} finally {
  try { await worker.close(); } catch { /* ignore */ }
}

const summary = {
  at: new Date().toISOString(),
  maaInstallPath: cfg.maaInstallPath,
  loadCache: !noCache,
  total: out.filter((r) => r.name).length,
  accepted: out.filter((r) => r.got === 'ok').length,
  rejected: out.filter((r) => r.got === 'reject').length,
  unexpected: out.filter((r) => r.name && r.expect !== '?' && r.expect !== r.got).map((r) => `${r.name}: 期望 ${r.expect}，实际 ${r.got}`),
};
const file = path.join(PLUGIN, 'data', 'logs', `probe-niuzza4-${noCache ? 'nocache-' : ''}${Date.now()}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ ...summary, results: out }, null, 1));
console.log(JSON.stringify(summary, null, 1));
for (const r of out) {
  if (!r.name) { console.log('FATAL', r.fatal); continue; }
  const status = r.got === 'ok' ? `OK taskId=${r.taskId}` : r.got.toUpperCase();
  console.log(`${status.padEnd(16)} ${r.name}`);
  if (r.error) console.log(`    ${r.error.slice(0, 160)}`);
}
console.log('dump:', file);
