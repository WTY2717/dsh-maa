/**
 * MaaCore 子进程：唯一持有 MaaCore 句柄的地方。
 *
 * 为什么要子进程（实测结论，别改成同进程）：
 *  1) `AsstDestroy` 在“已 Append 但未 Start”的状态下会阻塞（实测挂住不返回），
 *     放在 Host 进程里会冻住整个 DSH；
 *  2) MaaCore 是 6 MB 原生库 + 200 MB 资源，崩溃/卡死必须可被 kill；
 *  3) 「干员等级过低」弹窗必须由**另一个核心会话**点掉（见 docs/tools/maa-copilot.md 故障 5），
 *     另起一个本文件即是一个独立会话。
 *
 * 协议：stdin/stdout 上按行 JSON。
 *   请求  { "id": 1, "op": "connect", "args": { ... } }
 *   应答  { "id": 1, "ok": true, "result": { ... } } / { "id": 1, "ok": false, "error": "..." }
 *   事件  { "event": "cb", "id": 10002, "what": "...", "details": {...} } / { "event": "log", "text": "..." }
 * stdout 只走协议，日志走 stderr。
 */
import readline from 'node:readline';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { classify } from './callbacks.js';

const require = createRequire(import.meta.url);

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const log = (...a) => process.stderr.write(`[maa-core] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────── koffi 绑定 ────────────────────── */

let koffi = null;
let lib = null;
let handle = null;
let cbPtr = null;
let cbProto = null;
let connected = false;
let done = false;
let failed = false;
let sawCompletion = false;
let running = false;
let lastError = null;
let cbCount = 0;
let loadedInstallKey = null;
const fns = {};

const SIG = {
  AsstSetUserDir: ['bool', ['str']],
  AsstLoadResource: ['bool', ['str']],
  AsstSetConnectionExtras: ['bool', ['str', 'str']],
  AsstAsyncConnect: ['int', ['void *', 'str', 'str', 'str', 'bool']],
  AsstConnected: ['bool', ['void *']],
  AsstAsyncClick: ['int', ['void *', 'int', 'int', 'bool']],
  AsstAppendTask: ['int', ['void *', 'str', 'str']],
  AsstStart: ['bool', ['void *']],
  AsstStop: ['bool', ['void *']],
  AsstRunning: ['bool', ['void *']],
  AsstDestroy: ['bool', ['void *']],
  AsstGetVersion: ['str', []],
};

function loadKoffi() {
  if (koffi) return koffi;
  try {
    koffi = require('koffi');
    return koffi;
  } catch (e) {
    const err = new Error(
      `MaaCore 直连后端不可用：缺少 koffi 模块（${e.message}）。请在插件目录执行 pnpm install 安装依赖后重启 DSH。`,
    );
    err.code = 'KOFFI_MISSING';
    throw err;
  }
}

function ensureLib(installDir) {
  const k = loadKoffi();
  const key = installDir.toLowerCase();
  if (lib && loadedInstallKey === key) return;
  process.env.PATH = `${installDir}${path.delimiter}${process.env.PATH ?? ''}`;
  lib = k.load(path.join(installDir, 'MaaCore.dll'));
  loadedInstallKey = key;
  // koffi 按名字缓存 proto：同名重复定义会抛 Duplicate type name，所以只定义一次
  cbProto = k.proto('void MaaCallback(int msg, const char *details, void *arg)');
  for (const [name, [ret, args]] of Object.entries(SIG)) {
    try { fns[name] = lib.func(name, ret, args); } catch { fns[name] = null; }
  }
  try {
    fns.AsstCreateEx = lib.func('AsstCreateEx', 'void *', [k.pointer(cbProto), 'void *']);
  } catch {
    fns.AsstCreateEx = null;
  }
  if (!fns.AsstCreateEx) throw new Error('MaaCore.dll 没有 AsstCreateEx（版本过旧或文件损坏）');
  if (!fns.AsstLoadResource || !fns.AsstAppendTask || !fns.AsstStart) {
    throw new Error('MaaCore.dll 缺少必需符号（AsstLoadResource / AsstAppendTask / AsstStart）');
  }
}

function onCallback(msg, details) {
  cbCount += 1;
  const text = details ? String(details) : '';
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  const what = parsed?.what || parsed?.taskchain || '';
  // 语义判定统一走数据表（src/core/callbacks.js），别在这里另写一份硬编码：
  // 否则改 callbacks.js 只影响展示层，任务成败判定还是旧的。
  let info = { what, failure: false, semantic: null };
  try { info = classify(msg, text); } catch { /* 分类失败也不能影响回调线程 */ }
  if (info.semantic === 'connected') connected = true;
  if (info.semantic === 'chain-done') { done = true; sawCompletion = true; }
  if (info.semantic === 'chain-stopped') { done = true; sawCompletion = true; }
  if (info.failure) { failed = true; lastError = what || String(msg); }
  if (what === 'ConnectFailed') lastError = 'ConnectFailed';
  write({ event: 'cb', id: msg, what, details: parsed, text: text.slice(0, 400) });
}

/** 可选符号守卫：缺符号时给可读原因，而不是 `fns.X is not a function`。 */
function need(name) {
  const fn = fns[name];
  if (typeof fn !== 'function') {
    throw new Error(`当前 MaaCore 缺少符号 ${name}（版本过旧或文件不完整）：请升级 MAA，或改用远程控制后端（maa_run / maa_screenshot）`);
  }
  return fn;
}

/* ────────────────────── 操作 ────────────────────── */

function open({ installDir, userDir, extras }) {
  if (!installDir) throw new Error('未指定 MAA 安装目录');
  ensureLib(installDir);
  mkdirSync(userDir, { recursive: true });
  if (!need('AsstSetUserDir')(userDir)) log(`AsstSetUserDir 返回 false: ${userDir}`);
  if (!need('AsstLoadResource')(installDir)) {
    throw new Error(`AsstLoadResource 失败：${installDir}（要传安装目录，core 自己拼 resource；确认 resource\\stages.json 存在）`);
  }
  if (!handle) {
    const k = loadKoffi();
    cbPtr = k.register(onCallback, k.pointer(cbProto));
    handle = need('AsstCreateEx')(cbPtr, null);
    if (!handle) throw new Error('AsstCreateEx 返回空句柄');
  }
  if (extras && typeof fns.AsstSetConnectionExtras === 'function') {
    try { fns.AsstSetConnectionExtras(String(extras.config), String(extras.json)); } catch (e) { log('SetConnectionExtras 失败', e.message); }
  }
  return { loaded: true, connected, callbacks: cbCount };
}

async function connect({ adbPath, address, config, extras, timeoutMs = 45000 }) {
  if (!handle) throw new Error('核心会话未打开');
  if (extras && typeof fns.AsstSetConnectionExtras === 'function') {
    try { fns.AsstSetConnectionExtras(String(config), String(extras)); } catch (e) { log('SetConnectionExtras 失败', e.message); }
  }
  const asstConnected = need('AsstConnected');
  const tid = need('AsstAsyncConnect')(handle, String(adbPath ?? ''), String(address ?? ''), String(config ?? ''), false);
  log(`AsstAsyncConnect -> ${tid} adb=${adbPath} addr=${address} cfg=${config}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (asstConnected(handle)) { connected = true; return { connected: true, taskId: tid }; }
    await sleep(250);
  }
  return { connected: false, taskId: tid, lastError };
}

async function wait({ timeoutMs = 600000, idleChecks = 5 }) {
  const deadline = Date.now() + timeoutMs;
  const asstRunning = need('AsstRunning');
  let idle = 0;
  while (Date.now() < deadline) {
    running = Boolean(asstRunning(handle));
    if (done) return { done: true, failed, running, callbacks: cbCount, sawCompletion };
    // 只是「连续 5 秒没在跑」不等于任务成功：可能压根没开始。单独标记，由上层判 ok。
    if (running) idle = 0;
    else if (++idle >= idleChecks) {
      done = true;
      return { done: true, failed, running: false, callbacks: cbCount, idleExit: true, sawCompletion };
    }
    await sleep(1000);
  }
  return { done, failed, running, callbacks: cbCount, timedOut: true, sawCompletion };
}

async function click({ x, y, waitMs = 1200, maxWaitMs = 15000 }) {
  if (!handle) throw new Error('核心会话未打开');
  const asstRunning = need('AsstRunning');
  const tid = need('AsstAsyncClick')(handle, Math.round(x), Math.round(y), true);
  need('AsstStart')(handle);
  // 点击任务要截屏 + 注入触摸，耗时不定；只固定 sleep 容易在任务没执行完时就被 teardown 掉（实测点了没反应）
  await sleep(waitMs);
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (!asstRunning(handle)) break;
    await sleep(200);
  }
  const stillRunning = Boolean(asstRunning(handle));
  return { taskId: tid, clicked: [Math.round(x), Math.round(y)], stillRunning };
}

const OPS = {
  open,
  connect,
  append: ({ type, params }) => {
    if (!handle) throw new Error('核心会话未打开');
    const tid = need('AsstAppendTask')(handle, String(type), JSON.stringify(params ?? {}));
    if (!tid) throw new Error(`AsstAppendTask(${type}) 返回 0：参数被 core 拒绝（作业文件读不到 / JSON 结构不对 / 任务名不支持）`);
    return { taskId: tid };
  },
  start: () => {
    if (!handle) throw new Error('核心会话未打开');
    done = false; failed = false; lastError = null; sawCompletion = false;
    if (!need('AsstStart')(handle)) throw new Error('AsstStart 失败（可能已在运行）');
    return { started: true };
  },
  wait,
  stop: () => {
    if (!handle) throw new Error('核心会话未打开');
    const ok = need('AsstStop')(handle);
    done = true;
    return { stopped: ok };
  },
  click,
  info: () => ({
    connected: handle && fns.AsstConnected ? Boolean(fns.AsstConnected(handle)) : false,
    running: handle && fns.AsstRunning ? Boolean(fns.AsstRunning(handle)) : false,
    done, failed, lastError, callbacks: cbCount, sawCompletion,
  }),
  async quit() {
    try {
      if (handle) {
        try { fns.AsstStop?.(handle); } catch { /* ignore */ }
        // AsstDestroy 可能永久阻塞（已 Append 未 Start 时实测挂住），因此不等待它
        Promise.resolve().then(() => fns.AsstDestroy?.(handle)).catch(() => {});
        await sleep(300);
        handle = null;
      }
    } finally {
      process.exit(0);
    }
  },
};

/* ────────────────────── 主循环 ────────────────────── */

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try { req = JSON.parse(text); } catch { return; }
  const op = OPS[req.op];
  if (!op) return write({ id: req.id, ok: false, error: `未知操作: ${req.op}` });
  try {
    const result = await op(req.args ?? {});
    write({ id: req.id, ok: true, result: result ?? null });
  } catch (e) {
    write({ id: req.id, ok: false, error: String(e?.message || e), code: e?.code });
  }
});

rl.on('close', () => { OPS.quit().catch(() => process.exit(0)); });

process.on('uncaughtException', (e) => {
  write({ event: 'fatal', error: String(e?.message || e) });
  process.exit(1);
});
