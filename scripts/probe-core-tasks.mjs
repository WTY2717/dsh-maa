// 一次性探针：直连 MaaCore 跑 OperBox / Depot，dump 回调结构，确认结果返回方式。
// 用法：node probe-core-tasks.mjs <TaskType> [jsonParams]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = 'C:\\Users\\wty23\\Documents\\deepseek-harness\\default-workspace\\plugins\\maa-plugin';
const { resolveConfig } = await import('file:///' + path.join(PLUGIN, 'src', 'config.js').replace(/\\/g, '/'));
const { resolveAdbPath } = await import('file:///' + path.join(PLUGIN, 'src', 'adb.js').replace(/\\/g, '/'));
const { connectionExtras } = await import('file:///' + path.join(PLUGIN, 'src', 'copilot.js').replace(/\\/g, '/'));
const { CoreWorker } = await import('file:///' + path.join(PLUGIN, 'src', 'core', 'driver.js').replace(/\\/g, '/'));

const taskType = process.argv[2] || 'OperBox';
// 参数也可以走环境变量 PROBE_PARAMS：PowerShell 调外部程序时会吃掉参数里的引号，JSON 直接传参不可靠
const params = process.env.PROBE_PARAMS ? JSON.parse(process.env.PROBE_PARAMS) : (process.argv[3] ? JSON.parse(process.argv[3]) : {});

const cfg = resolveConfig({}, PLUGIN);
const adb = resolveAdbPath({ configured: cfg.adbPath, hintPath: cfg.maaHint?.adbPath });
if (!adb.ok) { console.error('adb not found:', adb.error); process.exit(1); }
const extras = connectionExtras(cfg, adb.path);

const events = [];
const worker = new CoreWorker({
  logDir: path.join(PLUGIN, 'data', 'logs'),
  nodePath: cfg.nodePath,
  onEvent: (ev) => {
    if (ev?.event === 'cb') {
      // details 是 worker 解析后的完整对象（text 在 worker 侧截到 400 字符，长数组会丢，探针必须存 details）
      events.push({ at: Date.now(), id: ev.id, what: ev.what ?? null, details: ev.details ?? null, text: ev.text });
    }
  },
});

const t0 = Date.now();
try {
  await worker.start();
  await worker.open({ installDir: cfg.maaInstallPath, userDir: cfg.coreUserDir, extras: { config: cfg.adbConfig, json: extras } });
  const conn = await worker.connect({ adbPath: adb.path, address: cfg.adbAddress, config: cfg.adbConfig, extras, timeoutMs: 45000 });
  console.log('connected:', conn.connected);
  if (!conn.connected) process.exit(2);
  const appended = await worker.append(taskType, params);
  await worker.startTask();
  console.log('appended taskId:', appended.taskId);
  const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS) || 600000;
  const deadline = Date.now() + timeoutMs;
  let result = null;
  // 每 15 秒轮询一次；worker.wait 的 timedOut 只是「这一片等完了」，不是整体超时，
  // 不能像旧版那样遇到就 break（会让 OperBox/Depot 提前关会话，只看到半截结果）。
  // 结束条件：整链完成（id=3 没有 what，worker 看不到，自己查 events）/ 失败 / 核心已空闲 / 到总超时。
  for (;;) {
    const remain = deadline - Date.now();
    if (remain <= 0) {
      result = { ...(result ?? {}), timedOut: true, sawCompletion: false, failed: Boolean(result?.failed) };
      break;
    }
    result = await worker.wait(Math.min(15000, remain));
    if (result.sawCompletion || result.failed || result.idleExit) break;
    if (events.some((e) => e.id === 3)) break;
  }
  console.log('result:', JSON.stringify({ sawCompletion: result.sawCompletion, failed: result.failed, timedOut: result.timedOut, idleExit: result.idleExit, callbacks: result.callbacks }));
} catch (e) {
  console.error('probe failed:', e?.message || e);
} finally {
  try { await worker.close(); } catch { /* ignore */ }
  const out = path.join(PLUGIN, 'data', 'logs', `probe-${taskType}-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ taskType, params, elapsedMs: Date.now() - t0, events }, null, 1));
  console.log('events:', events.length, 'dump:', out);
  const interesting = events.filter((e) => /OperBox|Depot|VideoRecognition|SubTaskExtraInfo|TaskChain/i.test(e.text));
  for (const e of interesting.slice(-40)) console.log('---', e.id, (e.text || '').slice(0, 700));
}
