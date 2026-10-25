#!/usr/bin/env node
/**
 * 作业挑选逻辑单测（离线、不联网、不碰 MAA）。
 *
 * 用户口径（2026-10-25 补充）：**先找完全达标的作业，只有在所有候选都做不到完全达标时才放宽**。
 * 本文件锁住这条优先级，避免以后又被"一上来就容差"改回去。
 *
 * 覆盖：
 *  1. `operMatches` / `jobMatches` 的严格（relax:false）与容差（relax:true）两档
 *  2. `scanCandidates` 的三态：strict / relaxed / none
 *  3. 去重、stage_name 过滤、按 views 排序、limit、拒绝原因归类
 */
import assert from 'node:assert/strict';

const imp = (rel) => import(new URL(`../${rel}`, import.meta.url).href);

let pass = 0;
const fails = [];
const test = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); } catch (e) { fails.push({ name, error: String(e?.message || e) }); console.log(`  FAIL ${name}: ${e?.message || e}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const { operMatches, jobMatches, toleranceLevel } = await imp('src/prts/match.js');
const { scanCandidates, classifyReject } = await imp('src/prts/select.js');

/* ────────────────────── 数据 ────────────────────── */

const roster = new Map([
  ['A', { elite: 2, level: 60, potential: 1 }],
  ['C', { elite: 1, level: 70, potential: 0 }],
]);
const mkJob = (name, req, stage = 'hard_12-02') => ({
  stage_name: stage,
  doc: { title: `${name} @ ${stage}` },
  opers: [{ name: 'A', requirements: req }],
  actions: [{ type: 'Deploy' }],
});
const item = (id, job, views = 0) => ({ id, views, content: JSON.stringify(job) });

/* ────────────────────── 1. 两档匹配 ────────────────────── */

section('1. 严格 / 容差两档');

await test('容差档：精二 90 要求 → 门槛 60（现有 60 可过）', () => {
  const req = { elite: 2, level: 90 };
  assert.equal(toleranceLevel(req), 60);
  assert.equal(operMatches(req, roster.get('A'), { relax: true }).ok, true);
});

await test('严格档：精二 90 要求 → 60 级不达标（原要求 90）', () => {
  const req = { elite: 2, level: 90 };
  const r = operMatches(req, roster.get('A'), { relax: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /原要求/);
});

await test('严格档：刚好达标算过（边界）', () => {
  assert.equal(operMatches({ elite: 2, level: 60 }, roster.get('A'), { relax: false }).ok, true);
});

await test('严格档：精二 120 要求 → 容差档也过不了（90 > 60）', () => {
  const req = { elite: 2, level: 120 };
  assert.equal(operMatches(req, roster.get('A'), { relax: true }).ok, false);
  assert.equal(operMatches(req, roster.get('A'), { relax: false }).ok, false);
});

await test('精一要求不下浮：两档相同', () => {
  const req = { elite: 1, level: 70 };
  assert.equal(operMatches(req, roster.get('C'), { relax: false }).ok, true);
  assert.equal(operMatches(req, roster.get('C'), { relax: true }).ok, true);
  assert.equal(operMatches({ elite: 1, level: 71 }, roster.get('C'), { relax: true }).ok, false);
});

await test('jobMatches 支持 relax 选项；默认仍是容差档（兼容旧调用）', () => {
  const job = mkJob('x', { elite: 2, level: 90 });
  assert.equal(jobMatches(job, roster, { relax: false }).ok, false);
  assert.equal(jobMatches(job, roster).ok, true, '不传时保持容差口径，避免破坏既有调用');
});

/* ────────────────────── 2. 挑选三态 ────────────────────── */

section('2. 挑选三态（strict 优先）');

const strictJob = mkJob('严格达标', { elite: 2, level: 55 }, 'hard_12-02');
const relaxedJob = mkJob('需放宽', { elite: 2, level: 90 }, 'hard_12-02');
const tooHigh = mkJob('够不着', { elite: 2, level: 120 }, 'hard_12-02');
const noReq = { stage_name: 'hard_12-02', doc: { title: '老作业' }, opers: [{ name: 'A' }], actions: [] };
const otherStage = mkJob('别的关', { elite: 2, level: 1 }, 'hard_12-01');
const notOwned = { stage_name: 'hard_12-02', doc: { title: '缺人' }, opers: [{ name: 'Z', requirements: { elite: 1, level: 1 } }] };

await test('有完全达标的 → mode=strict，且只给完全达标的', () => {
  const r = scanCandidates({
    items: [item(1, relaxedJob, 100), item(2, strictJob, 10)],
    rosterByName: roster,
    stageId: 'hard_12-02',
  });
  assert.equal(r.mode, 'strict');
  assert.deepEqual(r.picked.map((p) => p.id), [2]);
  assert.equal(r.picked[0].strictReason, undefined);
  assert.equal(r.scanned.strictPass, 1);
  assert.equal(r.scanned.relaxedOnlyPass, 1);
});

await test('没有完全达标的 → mode=relaxed，并带上差在哪（strictReason）', () => {
  const r = scanCandidates({
    items: [item(1, relaxedJob, 100), item(2, tooHigh, 50)],
    rosterByName: roster,
    stageId: 'hard_12-02',
  });
  assert.equal(r.mode, 'relaxed');
  assert.deepEqual(r.picked.map((p) => p.id), [1]);
  assert.match(r.picked[0].strictReason, /原要求/);
  assert.equal(r.scanned.rejected.notEnough, 1, 'tooHigh 在放宽档也不达标');
});

await test('两档都空 → mode=none', () => {
  const r = scanCandidates({ items: [item(1, tooHigh)], rosterByName: roster, stageId: 'hard_12-02' });
  assert.equal(r.mode, 'none');
  assert.equal(r.picked.length, 0);
});

await test('拒绝原因归类：未拥有 / 缺 requirements / 练度不够', () => {
  assert.equal(classifyReject('Z: 未拥有'), 'notOwned');
  assert.equal(classifyReject('A: 作业缺 requirements（老版本作业）'), 'noRequirements');
  assert.equal(classifyReject('作业没有干员要求（actions 可能是元数据）'), 'noRequirements');
  assert.equal(classifyReject('A: 等级 60 < 90（原要求）'), 'notEnough');
  const r = scanCandidates({
    items: [item(1, notOwned), item(2, noReq), item(3, tooHigh)],
    rosterByName: roster,
    stageId: 'hard_12-02',
  });
  assert.equal(r.mode, 'none');
  assert.equal(r.scanned.rejected.notOwned, 1);
  assert.equal(r.scanned.rejected.noRequirements, 1);
  assert.equal(r.scanned.rejected.notEnough, 1);
});

/* ────────────────────── 3. 过滤 / 排序 / 限量 ────────────────────── */

section('3. 过滤、排序、限量');

await test('stage_name 不符的被过滤，sameStage 只数同关', () => {
  const r = scanCandidates({
    items: [item(1, strictJob), item(2, otherStage)],
    rosterByName: roster,
    stageId: 'hard_12-02',
    stage: 'H12-2',
  });
  assert.equal(r.scanned.sameStage, 1);
  assert.equal(r.scanned.candidates, 2);
  assert.deepEqual(r.picked.map((p) => p.id), [1]);
});

await test('同 id 去重', () => {
  const r = scanCandidates({ items: [item(7, strictJob), item(7, strictJob)], rosterByName: roster, stageId: 'hard_12-02' });
  assert.equal(r.scanned.sameStage, 1);
  assert.equal(r.picked.length, 1);
});

await test('按 views 从高到低 + limit 生效', () => {
  const a = mkJob('a', { elite: 2, level: 1 });
  const b = mkJob('b', { elite: 2, level: 2 });
  const c = mkJob('c', { elite: 2, level: 3 });
  const r = scanCandidates({
    items: [item(1, a, 5), item(2, b, 9), item(3, c, 1)],
    rosterByName: roster,
    stageId: 'hard_12-02',
    limit: 2,
  });
  assert.deepEqual(r.picked.map((p) => p.id), [2, 1]);
});

await test('坏 JSON / null 候选被跳过，不炸', () => {
  const r = scanCandidates({
    items: [null, { id: 1, views: 1, content: '{bad json' }, item(2, strictJob)],
    rosterByName: roster,
    stageId: 'hard_12-02',
  });
  assert.equal(r.mode, 'strict');
  assert.deepEqual(r.picked.map((p) => p.id), [2]);
});

await test('没给 items 也不炸', () => {
  const r = scanCandidates({ rosterByName: roster, stageId: 'hard_12-02' });
  assert.equal(r.mode, 'none');
  assert.equal(r.scanned.candidates, 0);
});

/* ────────────────────── 汇总 ────────────────────── */

console.log(`\n${fails.length ? '失败' : '全部通过'}: ${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
