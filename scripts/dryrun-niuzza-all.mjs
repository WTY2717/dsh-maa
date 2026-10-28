// 牛杂全动作 dryRun 验收：逐个 action 走 runNiuzza（dryRun=true）→ 只 append 校验，不 connect、不 startTask、零消耗。
// 用法：node scripts/dryrun-niuzza-all.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const { resolveConfig } = await import(new URL('../src/config.js', import.meta.url));
const { runNiuzza, NIUZZA_ACTIONS } = await import(new URL('../src/niuzza.js', import.meta.url));
const cfg = resolveConfig({}, PLUGIN);

const CALLS = {
  // 牛杂页 9 个条目
  'blackflow-money': {},
  'secret-front': { ending: 'C', event: '游侠' },
  'event-shop': { blacklist: ['家具零件'] },
  'green-shop': {},
  'yellow-shop': {},
  'reclamation-shop': {},
  'auto-raise-potential': { useNormalToken: true },
  'material-synthesis': {},
  'phantom-crown': {},
  // 通用动作
  custom: { taskNames: ['event-shop'], params: { event_shop: { blacklist: ['家具零件'] } } },
  'single-step': { subtype: 'stage', stageName: '1-7' },
  'user-data-update': {},
  'switch-theme': { themes: ['夜间'] },
  'oper-progress': { plans: [{ role: 'Sniper', name: '能天使', elite: 2, skillLevel: 7, skillMastery: [1, 0, 0] }] },
  'depot-maintain': { plans: [{ stage: '1-7', dropId: '30011', dropCount: 10 }] },
  reclamation: { theme: 'Tales', mode: 1, toolsToCraft: ['荧光棒'], numCraftBatches: 2 },
  roguelike: { theme: 'Sami', mode: 0, startsCount: 2, investmentsCount: 999 },
};

const rows = [];
for (const action of NIUZZA_ACTIONS) {
  const t0 = Date.now();
  const r = await runNiuzza({ action, call: CALLS[action] ?? {}, cfg, dryRun: true });
  rows.push({
    action,
    ok: r.ok,
    status: r.status,
    tasks: (r.tasks ?? []).map((t) => t.type),
    appended: r.appended ?? null,
    error: r.error ?? null,
    plan: r.plan ?? null,
    ms: Date.now() - t0,
  });
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${action.padEnd(17)} status=${String(r.status).padEnd(10)} tasks=${(r.tasks ?? []).map((t) => t.type).join(' + ')}`);
  if (!r.ok) console.log('     ', r.error);
}

const out = path.join(PLUGIN, 'data', 'logs', `niuzza-dryrun-all-${Date.now()}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), maaInstallPath: cfg.maaInstallPath, rows }, null, 1));
console.log('\nok/total:', rows.filter((r) => r.ok).length, '/', rows.length, '\ndump:', out);
