#!/usr/bin/env node
/**
 * 后台抄作业（`background:true` / `maa_copilot_status` / `maa_copilot_stop`）单测。
 *
 * 锁住的口径（用户 2026-10-25 新增规则）：
 *  1. 后台起跑后立刻能查 status（state/taskId），**不阻塞**；
 *  2. stop 必须真的调用 AsstStopTask，并让 run 收尾 → 模型才能接着去点退出关卡；
 *  3. 放宽档失败必须给出「没有找到这个账号可以抄的作业」这句口径；
 *  4. sidecar 元数据（严格/放宽档）能写能读，且不影响作业 JSON 本身；
 *  5. dispose 收掉所有后台 run（插件重载不能留子进程）。
 *
 * 全程用假 run / 假 ctl，不碰 MaaCore、不连模拟器。
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

const runnerMod = await imp('src/copilot-runner.js');
const copilot = await imp('src/copilot.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────── 1. 后台运行 / 查询 / 停止 ────────────────────── */

section('1. 后台运行');

/** 假 runCopilot：调 onReady 给 ctl，然后挂起直到外部 release。 */
function fakeRunFactory() {
  const state = { released: false, stopCalls: 0, started: 0 };
  const run = async ({ onReady }) => {
    state.started += 1;
    let release;
    const gate = new Promise((r) => { release = r; });
    state.release = async () => { state.released = true; release(); };
    onReady({
      taskId: 7,
      stopTask: async () => { state.stopCalls += 1; release(); },
      progressLines: () => [{ line: 'cb: CopilotAction' }],
      worker: { close: async () => {} },
    });
    await gate;
    return { ok: true, status: 'completed', callbacks: 3 };
  };
  return { run, state };
}

await test('起跑立刻返回 runId，status 能看到 running + taskId', async () => {
  const fake = fakeRunFactory();
  const runner = runnerMod.createCopilotRunner({ run: fake.run });
  const started = runner.start({ jobFile: 'C:/tmp/job.json', cfg: {}, options: {} });
  assert.equal(started.ok, true);
  assert.match(started.runId, /^run-\d+$/);
  await sleep(20);
  const st = runner.status(started.runId);
  assert.equal(st.ok, true);
  assert.equal(st.state, 'running');
  assert.equal(st.taskId, 7);
  assert.ok(Array.isArray(st.progressTail));
  await fake.state.release();
  await sleep(20);
  const done = runner.status(started.runId);
  assert.equal(done.state, 'done');
  assert.equal(done.finished, true);
  assert.equal(done.result.status, 'completed');
  await runner.dispose();
});

await test('stop 调用 AsstStopTask 并把 run 收尾（游戏还在战斗是预期）', async () => {
  const fake = fakeRunFactory();
  const runner = runnerMod.createCopilotRunner({ run: fake.run });
  const started = runner.start({ jobFile: 'C:/tmp/job.json', cfg: {}, options: {} });
  await sleep(20);
  const stopped = await runner.stop(started.runId);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);
  assert.equal(fake.state.stopCalls, 1);
  assert.match(stopped.hint, /退出行动/);
  await sleep(300);
  assert.equal(runner.status(started.runId).state, 'done');
  await runner.dispose();
});

await test('stop 已结束的 run → 明确报错；不存在的 runId → 报错', async () => {
  const fake = fakeRunFactory();
  const runner = runnerMod.createCopilotRunner({ run: fake.run });
  const started = runner.start({ jobFile: 'C:/tmp/job.json', cfg: {}, options: {} });
  await sleep(20);
  await fake.state.release();
  await sleep(20);
  const r = await runner.stop(started.runId);
  assert.equal(r.ok, false);
  assert.match(r.error, /已经结束/);
  assert.equal(runner.status('run-999').ok, false);
  await runner.dispose();
});

await test('没给 runId 时 status/stop 指向最近一条', async () => {
  const fake = fakeRunFactory();
  const runner = runnerMod.createCopilotRunner({ run: fake.run });
  runner.start({ jobFile: 'C:/tmp/a.json', cfg: {}, options: {} });
  await sleep(10);
  const second = runner.start({ jobFile: 'C:/tmp/b.json', cfg: {}, options: {} });
  await sleep(20);
  assert.equal(runner.status().runId, second.runId);
  await runner.dispose();
});

await test('dispose 收掉正在跑的 run（插件重载不留子进程）', async () => {
  const fake = fakeRunFactory();
  const runner = runnerMod.createCopilotRunner({ run: fake.run });
  runner.start({ jobFile: 'C:/tmp/job.json', cfg: {}, options: {} });
  await sleep(20);
  await runner.dispose();
  assert.equal(fake.state.stopCalls, 1, 'dispose 应先 AsstStopTask');
  assert.equal(runner.status().ok, false, 'dispose 后不该还有记录');
});

/* ────────────────────── 2. 失败口径 ────────────────────── */

section('2. 失败后的对用户口径');

await test('放宽档失败 → 「没有找到这个账号可以抄的作业」', () => {
  const a = copilot.failureAdvice({ matchMode: 'relaxed', relaxedBecause: 'A: 等级 60 < 90（原要求）' });
  assert.equal(a.verdict, 'no-job-for-this-account');
  assert.match(a.message, /没有找到这个账号可以抄的作业/);
  assert.match(a.message, /等级 60 < 90/);
  assert.match(a.message, /不要建议提升练度/);
});

await test('严格档失败 → 换下一条，不是「没有作业」', () => {
  const a = copilot.failureAdvice({ matchMode: 'strict' });
  assert.equal(a.verdict, 'strict-job-failed');
  assert.match(a.message, /换下一条/);
});

await test('没有 sidecar（老作业/手工落盘）→ 按严格档口径兜底', () => {
  const a = copilot.failureAdvice(null);
  assert.equal(a.verdict, 'strict-job-failed');
});

/* ────────────────────── 3. sidecar 元数据 ────────────────────── */

section('3. sidecar 元数据');

await test('写/读 sidecar，且不碰作业 JSON 本身', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-jobs-'));
  const jobFile = path.join(dir, 'H12-2_1.json');
  const job = { stage_name: 'hard_12-02', actions: [{ type: 'Deploy' }] };
  fs.writeFileSync(jobFile, JSON.stringify(job));
  copilot.writeJobMeta(jobFile, { matchMode: 'relaxed', relaxedBecause: 'x', toleranceNotes: ['a'], stageId: 'hard_12-02' });
  const meta = copilot.readJobMeta(jobFile);
  assert.equal(meta.matchMode, 'relaxed');
  assert.deepEqual(meta.toleranceNotes, ['a']);
  assert.ok(meta.writtenAt, '应带时间戳');
  assert.deepEqual(JSON.parse(fs.readFileSync(jobFile, 'utf8')), job, '作业 JSON 不能被 sidecar 污染');
  assert.ok(fs.existsSync(copilot.jobMetaPath(jobFile)));
});

await test('sidecar 不存在/坏 JSON → 返回 null 不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maa-jobs2-'));
  const f = path.join(dir, 'nope.json');
  assert.equal(copilot.readJobMeta(f), null);
  fs.writeFileSync(copilot.jobMetaPath(f), '{bad');
  assert.equal(copilot.readJobMeta(f), null);
});

/* ────────────────────── 汇总 ────────────────────── */

console.log(`\n${fails.length ? '失败' : '全部通过'}: ${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
