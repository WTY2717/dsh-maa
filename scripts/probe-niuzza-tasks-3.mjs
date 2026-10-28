// 牛杂探针第三组：确认「不是 core 任务类型」的几个名字（EventShop/SecretFront/UserDataUpdate/DepotMaintain），
// 以及 Custom / OperProgress 的边界。只 append，不 connect、不 startTask。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const { resolveConfig } = await import(new URL('../src/config.js', import.meta.url));
const { CoreWorker } = await import(new URL('../src/core/driver.js', import.meta.url));
const cfg = resolveConfig({}, PLUGIN);

const CASES = [
  { name: 'type=EventShop {}', type: 'EventShop', params: {}, expect: 'reject' },
  { name: 'type=SecretFront {}', type: 'SecretFront', params: {}, expect: 'reject' },
  { name: 'type=UserDataUpdate {}', type: 'UserDataUpdate', params: {}, expect: 'reject' },
  { name: 'type=DepotMaintain {}', type: 'DepotMaintain', params: {}, expect: 'reject' },
  { name: 'type=MaterialSynthesis {}', type: 'MaterialSynthesis', params: {}, expect: 'reject' },
  { name: 'Custom: task_names=[]（空数组）', type: 'Custom', params: { task_names: [] }, expect: '?' },
  { name: 'Custom: SecretFront 未知结局 EndingZ', type: 'Custom', params: { task_names: ['MiniGame@SecretFront@Begin@EndingZ'] }, expect: '?' },
  { name: 'Custom: EventShop blacklist 是字符串', type: 'Custom', params: { task_names: ['SS@Store@Begin'], params: { event_shop: { blacklist: '龙门币' } } }, expect: '?' },
  { name: 'OperProgress: elite=3（非法）', type: 'OperProgress', params: { plans: [{ role: 'Sniper', name: '能天使', elite: 3 }] }, expect: 'reject' },
  { name: 'OperProgress: skill_level=1（非法）', type: 'OperProgress', params: { plans: [{ role: 'Sniper', name: '能天使', skill_level: 1 }] }, expect: 'reject' },
  { name: 'OperProgress: 多余字段 level=90', type: 'OperProgress', params: { plans: [{ role: 'Sniper', name: '能天使', level: 90 }] }, expect: 'reject' },
  { name: 'OperProgress: skill_mastery 越界 4', type: 'OperProgress', params: { plans: [{ role: 'Sniper', name: '能天使', skill_mastery: [4, 0, 0] }] }, expect: 'reject' },
  { name: 'OperProgress: plans=[]（空）', type: 'OperProgress', params: { plans: [] }, expect: '?' },
];

const worker = new CoreWorker({ logDir: path.join(PLUGIN, 'data', 'logs'), nodePath: cfg.nodePath, onEvent: () => {} });
const out = [];
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
  total: out.filter((r) => r.name).length,
  accepted: out.filter((r) => r.got === 'ok').length,
  rejected: out.filter((r) => r.got === 'reject').length,
  unexpected: out.filter((r) => r.name && r.expect !== '?' && r.expect !== r.got).map((r) => `${r.name}: 期望 ${r.expect}，实际 ${r.got}`),
};
const file = path.join(PLUGIN, 'data', 'logs', `probe-niuzza3-${Date.now()}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), results: out, summary }, null, 1));
console.log(JSON.stringify(summary, null, 1));
for (const r of out) {
  if (!r.name) { console.log('FATAL', r.fatal); continue; }
  console.log(`${(r.got === 'ok' ? `OK taskId=${r.taskId}` : r.got.toUpperCase()).padEnd(16)} ${r.name}`);
}
console.log('dump:', file);
