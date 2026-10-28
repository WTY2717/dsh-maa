// 牛杂探针第二组：补测 Roguelike / OperProgress role / 库存保持的 Fight/drops / Reclamation 崩溃边界。
// 只 append、不 connect、不 startTask。危险用例（会让 core 崩）排最后。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const { resolveConfig } = await import(new URL('../src/config.js', import.meta.url));
const { CoreWorker } = await import(new URL('../src/core/driver.js', import.meta.url));
const cfg = resolveConfig({}, PLUGIN);

const CASES = [
  // Roguelike 常用字段
  { name: 'Roguelike: Sami mode=0 starts=2', type: 'Roguelike', params: { theme: 'Sami', mode: 0, starts_count: 2 }, expect: 'ok' },
  { name: 'Roguelike: mode=1 投资 999', type: 'Roguelike', params: { theme: 'Phantom', mode: 1, investments_count: 999, investment_enabled: true }, expect: 'ok' },
  { name: 'Roguelike: 6 主题全覆盖（JieGarden/BlackFlow）', type: 'Roguelike', params: { theme: 'BlackFlow', mode: 0 }, expect: 'ok' },
  { name: 'Roguelike: 未知 theme', type: 'Roguelike', params: { theme: 'Nope', mode: 0 }, expect: 'reject' },
  { name: 'Roguelike: mode=2（已移除）', type: 'Roguelike', params: { theme: 'Sami', mode: 2 }, expect: 'reject' },
  { name: 'Roguelike: 带分队/干员', type: 'Roguelike', params: { theme: 'Sami', mode: 0, squad: '指挥分队', roles: '取长补短', core_char: '能天使' }, expect: 'ok' },

  // OperProgress：role 与歧义名
  { name: 'OperProgress: 能天使（无 role）', type: 'OperProgress', params: { plans: [{ name: '能天使' }] }, expect: '?' },
  { name: 'OperProgress: 能天使 + Sniper', type: 'OperProgress', params: { plans: [{ role: 'Sniper', name: '能天使', elite: 2 }] }, expect: 'ok' },
  { name: 'OperProgress: 错误 role', type: 'OperProgress', params: { plans: [{ role: 'NoSuchRole', name: '能天使' }] }, expect: '?' },

  // 库存保持：Depot 识别 + Fight(drops)
  { name: 'Fight: drops 库存保持风格', type: 'Fight', params: { stage: '1-7', medicine: 0, stone: 0, times: 9999, series: 1, drops: { '30011': 10 } }, expect: 'ok' },

  // Custom 组合
  { name: 'Custom: Award + EventShop 混合', type: 'Custom', params: { task_names: ['Award', 'SS@Store@Begin'], params: { event_shop: { blacklist: ['家具零件'] } } }, expect: 'ok' },
  { name: 'Custom: event_shop 非对象', type: 'Custom', params: { task_names: ['SS@Store@Begin'], params: { event_shop: 'x' } }, expect: '?' },

  // Reclamation 边界
  { name: 'Reclamation: Tales/1 + tools_to_craft=[]（空数组）', type: 'Reclamation', params: { theme: 'Tales', mode: 1, tools_to_craft: [], num_craft_batches: 1 }, expect: 'ok' },
  { name: 'Reclamation: Tales/1 + increment_mode=1（长按）', type: 'Reclamation', params: { theme: 'Tales', mode: 1, tools_to_craft: ['荧光棒'], num_craft_batches: 1, increment_mode: 1 }, expect: 'ok' },
  { name: 'Reclamation: Tales/1 + increment_mode=9（非法）', type: 'Reclamation', params: { theme: 'Tales', mode: 1, tools_to_craft: ['荧光棒'], increment_mode: 9 }, expect: 'ok' },
  { name: 'Reclamation: theme=Fire', type: 'Reclamation', params: { theme: 'Fire' }, expect: 'ok' },
  { name: 'Reclamation: 未知 theme', type: 'Reclamation', params: { theme: 'Nope' }, expect: 'reject' },
  // ↓ 会让 core 崩（ReclamationCraftTaskPlugin::load_params 里 optional::value() 空值），放最后
  { name: 'Reclamation: Tales/1 不带 tools_to_craft（预期崩）', type: 'Reclamation', params: { theme: 'Tales', mode: 1, num_craft_batches: 2 }, expect: 'crash' },
];

const worker = new CoreWorker({ logDir: path.join(PLUGIN, 'data', 'logs'), nodePath: cfg.nodePath, onEvent: () => {} });
const out = [];
let crashed = false;
try {
  await worker.start();
  await worker.open({ installDir: cfg.maaInstallPath, userDir: cfg.coreUserDir, extras: null });
  for (const c of CASES) {
    try {
      const r = await worker.append(c.type, c.params);
      out.push({ name: c.name, type: c.type, params: c.params, got: 'ok', taskId: r.taskId, expect: c.expect });
    } catch (e) {
      const msg = String(e?.message || e);
      const crash = /子进程已退出|子进程未运行/.test(msg);
      if (crash) crashed = true;
      out.push({ name: c.name, type: c.type, params: c.params, got: crash ? 'crash' : 'reject', error: msg, expect: c.expect });
      if (crash) break;
    }
  }
} catch (e) {
  out.push({ fatal: String(e?.message || e) });
} finally {
  try { await worker.close(); } catch { /* ignore */ }
}

const report = {
  at: new Date().toISOString(),
  maaInstallPath: cfg.maaInstallPath,
  crashed,
  results: out,
  summary: {
    total: out.filter((r) => r.name).length,
    accepted: out.filter((r) => r.got === 'ok').length,
    rejected: out.filter((r) => r.got === 'reject').length,
    crashed: out.filter((r) => r.got === 'crash').length,
    unexpected: out.filter((r) => r.name && r.expect !== '?' && r.expect !== r.got).map((r) => `${r.name}: 期望 ${r.expect}，实际 ${r.got}`),
  },
};
const file = path.join(PLUGIN, 'data', 'logs', `probe-niuzza2-${Date.now()}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.summary, null, 1));
for (const r of out) {
  if (!r.name) { console.log('FATAL', r.fatal); continue; }
  console.log(`${(r.got === 'ok' ? `OK taskId=${r.taskId}` : r.got.toUpperCase()).padEnd(16)} ${r.name}`);
}
console.log('dump:', file);
