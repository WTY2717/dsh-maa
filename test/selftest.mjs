#!/usr/bin/env node
/**
 * 本地自测（不装插件、不动 profile、不消耗理智）：
 *   node test/selftest.mjs [--maa <安装目录>] [--roster <练度文件>] [--online]
 *
 * 覆盖：
 *   1. PE 版本 + 导出表（能力表的事实来源）
 *   2. 练度文件解析（Markdown 导出表 / JSON）
 *   3. stages.json 反查
 *   4. 作业站查询 + 容差匹配（--online 才跑，走网络）
 *   5. MaaCore 子进程：加载资源 + Append Copilot（dryRun，不连接、不消耗理智）
 *   6. 远程桥：假 MAA 轮询器 + 回报，验证队列/回执/截图落盘
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(HERE);
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const ONLINE = args.includes('--online');

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

const imp = (rel) => import(new URL(`../${rel}`, import.meta.url).href);
const { readFileVersion, readExportNames } = await imp('src/pe.js');
const { resolveInstall } = await imp('src/maa.js');
const { parseRoster, loadRoster, parseMarkdownTable } = await imp('src/roster.js');
const { loadStages, resolveStageId } = await imp('src/stages.js');
const { applyTolerance, jobMatches, toleranceLevel } = await imp('src/prts/match.js');
const { Bridge } = await imp('src/remote/bridge.js');
const { CoreWorker } = await imp('src/core/driver.js');
const { resolveConfig } = await imp('src/config.js');

const maaDir = argOf('--maa') || resolveInstall({}).chosen?.dir || '';
// 默认练度表放用户 Documents 下（不要写死某个用户名，仓库要能公开）
const rosterPath = argOf('--roster')
  || path.join(process.env.USERPROFILE ?? os.homedir(), 'Documents', 'Arknights_OperBox_Export.md');

/* ───────────── 1. PE ───────────── */
section('PE 版本与导出表');
await test('MAA.exe 能读出 FileVersion', () => {
  const exe = path.join(maaDir, 'MAA.exe');
  const v = readFileVersion(exe);
  assert.match(String(v), /^\d+\.\d+/, `FileVersion=${v}`);
  console.log(`       MAA.exe FileVersion = ${v}  (${maaDir})`);
});
await test('MaaCore.dll 导出表里有 Asst* 符号', () => {
  const names = readExportNames(path.join(maaDir, 'MaaCore.dll'));
  // 实测 v6.20.1 只有 33 个导出（MaaCore 是薄壳，真正逻辑在 MaaUtils 等 DLL 里）
  assert.ok(names.length >= 30, `导出符号只有 ${names.length} 个`);
  for (const s of ['AsstAppendTask', 'AsstStart', 'AsstSetUserDir', 'AsstCreateEx', 'AsstLoadResource']) {
    assert.ok(names.includes(s), `缺 ${s}`);
  }
  console.log(`       ${names.length} 个导出符号，其中 Asst* ${names.filter((n) => n.startsWith('Asst')).length} 个`);
});
await test('MaaCore.dll 没有版本资源（说明必须读 MAA.exe）', () => {
  const v = readFileVersion(path.join(maaDir, 'MaaCore.dll'));
  assert.equal(v, null);
});

/* ───────────── 2. 练度 ───────────── */
section('练度文件解析');
await test(`Markdown 导出表解析出拥有干员（${rosterPath}）`, () => {
  const r = loadRoster(rosterPath);
  assert.ok(r.ok, r.error ?? r.problems.join('；'));
  assert.ok(r.owned >= 250, `只解析出 ${r.owned} 个拥有干员`);
  console.log(`       共 ${r.total} 行，拥有 ${r.owned} 个，格式 ${r.format}`);
});
await test('JSON roster 解析', () => {
  const r = parseRoster(JSON.stringify({ own_opers: [{ name: '娜仁图亚', elite: 2, level: 90, potential: 1 }] }));
  assert.equal(r.owned, 1);
  assert.equal(r.opers[0].elite, 2);
});
await test('表头缺列时给出可读错误', () => {
  const r = parseMarkdownTable('| 干员 | 星级 |\n| - | - |\n| 阿米娅 | 5 |');
  assert.equal(r.opers.length, 0);
  assert.match(r.problems[0], /表头缺少列/);
});
await test('不存在的路径返回可读错误而不是抛', () => {
  const r = loadRoster('C:/definitely/not/here.md');
  assert.equal(r.ok, false);
  assert.match(r.error, /不存在/);
});

/* ───────────── 3. 关卡 ───────────── */
section('stages.json 反查');
const stages = loadStages(maaDir);
await test('stages.json 可读', () => {
  assert.ok(stages.ok, stages.error);
  assert.ok(stages.count > 300, `只解析出 ${stages.count} 个关卡`);
  console.log(`       ${stages.count} 个关卡`);
});
await test('1-7 → main_01-07', () => {
  const r = resolveStageId(stages, '1-7');
  assert.equal(r.stageId, 'main_01-07');
});
await test('PR-D-2 → pro_d_2', () => {
  const r = resolveStageId(stages, 'PR-D-2');
  assert.equal(r.stageId, 'pro_d_2');
});
await test('内部 stageId 直接通过', () => {
  assert.equal(resolveStageId(stages, 'main_01-07').stageId, 'main_01-07');
});
await test('不存在的关卡给可读错误', () => {
  const r = resolveStageId(stages, 'ZZ-99');
  assert.equal(r.stageId, null);
  assert.match(r.error, /没有这个关卡代号/);
});

/* ───────────── 4. 容差匹配 ───────────── */
section('练度容差口径');
await test('专精要求降到 7 级技能', () => {
  const job = { opers: [{ name: 'A', requirements: { elite: 2, level: 80, skill_level: 10 } }] };
  applyTolerance(job);
  assert.equal(job.opers[0].requirements.skill_level, 7);
  assert.equal(job.opers[0].requirements.level, 60, '80-30=50 → 不低于 60');
});
await test('精二等级下浮 30 但不低于 60', () => {
  assert.equal(toleranceLevel({ elite: 2, level: 90 }), 60);
  assert.equal(toleranceLevel({ elite: 2, level: 120 }), 90);
  assert.equal(toleranceLevel({ elite: 1, level: 70 }), 70, '精一不下浮');
});
await test('练度不足时不通过', () => {
  const roster = new Map([['A', { elite: 1, level: 50, potential: 1 }]]);
  const job = { opers: [{ name: 'A', requirements: { elite: 2, level: 60 } }] };
  assert.equal(jobMatches(job, roster).ok, false);
});
await test('未拥有时不通过', () => {
  const job = { opers: [{ name: 'B', requirements: { elite: 0, level: 1 } }] };
  assert.equal(jobMatches(job, new Map()).ok, false);
});

/* ───────────── 5. 作业站（--online）───────────── */
if (ONLINE) {
  section('作业站查询（联网）');
  const { findJobs } = await imp('src/copilot.js');
  await test('1-7 能找到可抄作业（与 find_job.mjs 口径一致）', async () => {
    const cfg = resolveConfig({ maaInstallPath: maaDir, rosterPath }, PKG);
    const r = await findJobs({ stage: '1-7', cfg, limit: 8 });
    assert.ok(r.ok, r.error);
    assert.equal(r.stage.stageId, 'main_01-07');
    console.log(`       候选 ${r.scanned.candidates} 条，同关 ${r.scanned.sameStage} 条，通过 ${r.count} 条；拒绝分布 ${JSON.stringify(r.scanned.rejected)}`);
    for (const j of r.jobs.slice(0, 5)) console.log(`       id=${j.id} views=${j.views} ${j.opers}人 ${j.actions}动作 降容差${j.patchedRequirements} ${j.title}`);
    assert.ok(r.count > 0, '一条都没找到');
    for (const j of r.jobs) assert.ok(fs.existsSync(j.file), `作业文件没落盘: ${j.file}`);
  });
} else {
  section('作业站查询（跳过，加 --online 才联网）');
}

/* ───────────── 6. 远程桥 ───────────── */
section('远程控制桥（假 MAA 轮询器）');
const PORT = 18999;
const shotsDir = path.join(os.tmpdir(), `maa-selftest-shots-${Date.now()}`);
await test('getTask / reportStatus 全链路', async () => {
  const bridge = new Bridge({ port: PORT, shotsDir, log: () => {} });
  await bridge.start();
  try {
    const task = bridge.enqueue('CaptureImageNow');
    // 假 MAA：取任务
    const got = await (await fetch(`http://127.0.0.1:${PORT}/maa/getTask`, { method: 'POST', body: '{}' })).json();
    assert.equal(got.tasks.length, 1, 'getTask 没返回任务');
    assert.equal(got.tasks[0].type, 'CaptureImageNow');
    // 假 MAA：回报一张 1x1 PNG
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wH+D7eQAAAAAElFTkSuQmCC';
    await fetch(`http://127.0.0.1:${PORT}/maa/reportStatus`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: task.id, status: 'SUCCESS', payload: png }),
    });
    const r = await bridge.waitFor(task, 3000);
    assert.equal(r.state, 'done');
    assert.equal(r.status, 'SUCCESS');
    assert.ok(fs.existsSync(r.file), '截图没落盘');
    assert.ok(bridge.health().online, 'health.online 应为 true');
  } finally {
    await bridge.stop();
  }
});
await test('未知任务类型被拒', async () => {
  const bridge = new Bridge({ port: PORT + 1, shotsDir, log: () => {} });
  assert.throws(() => bridge.enqueue('Copilot', {}), /未知任务类型/);
  assert.throws(() => bridge.enqueue('Settings-Stage1'), /需要 params/);
});
await test('立即任务无回执 → 3 次后置 lost', async () => {
  const bridge = new Bridge({ port: PORT + 2, shotsDir, log: () => {} });
  await bridge.start();
  try {
    const task = bridge.enqueue('HeartBeat');
    for (let i = 0; i < 4; i++) {
      await fetch(`http://127.0.0.1:${PORT + 2}/maa/getTask`, { method: 'POST', body: '{}' });
      await new Promise((r) => setTimeout(r, 20));
      // 手动把 dispatchedAt 往前推，绕开 5 秒等待
      if (task.state === 'dispatched') task.dispatchedAt = Date.now() - 6000;
    }
    assert.equal(task.state, 'lost');
  } finally {
    await bridge.stop();
  }
});

/* ───────────── 7. MaaCore 子进程（不连接）───────────── */
section('MaaCore 子进程（dryRun：加载资源 + Append Copilot）');

/** 沙箱里的 shell 不允许管道 spawn（EPERM），这两节只能在非沙箱环境跑。 */
const canSpawnPiped = await (async () => {
  const { spawn } = await import('node:child_process');
  try {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("1")'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.on('error', () => {});
    await new Promise((r) => setTimeout(r, 300));
    child.kill();
    return true;
  } catch {
    return false;
  }
})();

const jobForCore = (() => {
  const dir = path.join(PKG, 'data', 'jobs');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (files.length) return path.join(dir, files[0]);
  } catch { /* 还没有 data/jobs */ }
  // 兼容旧脚本目录（可选的 --job 更明确；找不到就跳过 core 那两节）
  const legacy = argOf('--job');
  return legacy && fs.existsSync(legacy) ? legacy : null;
})();

if (!canSpawnPiped) {
  console.log('  skip 当前 shell 禁止管道 spawn（沙箱 EPERM）；这两节请在 Host 工具调用或非沙箱终端里跑');
} else if (!jobForCore) {
  console.log('  skip 没有作业文件可用（先跑 --online 或准备一份 copilot JSON）');
} else {
  await test(`core 接受 Copilot 任务（${path.basename(jobForCore)}）`, async () => {
    const worker = new CoreWorker({ logDir: path.join(PKG, 'data', 'logs') });
    try {
      await worker.start();
      const open = await worker.open({ installDir: maaDir, userDir: path.join(PKG, 'data', 'core-user-selftest') });
      assert.ok(open.loaded);
      const appended = await worker.append('Copilot', { filename: jobForCore, formation: true, formation_index: 0 });
      assert.ok(appended.taskId > 0, 'AppendTask 返回 0');
      const info = await worker.info();
      assert.equal(info.connected, false, '本测试不应该连接模拟器');
      console.log(`       taskId=${appended.taskId}（资源加载与解析成功，未连接、未消耗理智）`);
    } finally {
      await worker.close().catch(() => {});
    }
  });
  await test('core 拒绝坏作业（返回 0 → 报错）', async () => {
    const worker = new CoreWorker({ logDir: path.join(PKG, 'data', 'logs') });
    try {
      await worker.start();
      await worker.open({ installDir: maaDir, userDir: path.join(PKG, 'data', 'core-user-selftest') });
      await assert.rejects(
        () => worker.append('Copilot', { filename: 'C:/definitely/not/a/job.json' }),
        /返回 0/,
      );
    } finally {
      await worker.close().catch(() => {});
    }
  });
}

/* ───────────── 汇总 ───────────── */
section('结果');
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
for (const f of fails) console.log(`  - ${f.name}: ${f.error}`);
process.exit(fails.length ? 1 : 0);
