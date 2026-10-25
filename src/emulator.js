/**
 * MuMu 模拟器自启：**先看开没开，没开就拉起来，再等它能连上**。
 *
 * 实测事实（2026-10-25 本机，MuMu 12 多开实例）：
 *  - 实例安装目录 = MAA `gui.new.json` 里的 emulatorPath（本机 `D:\MUMU\YXArkNights-12.0-1`），
 *    `MuMuManager.exe` 就在它的 `shell\` 下（和 `adb.exe` 同目录）。
 *  - 判断开没开：`MuMuManager.exe info -v <index>` 输出 JSON，`is_process_started` 就是答案
 *    （`info -v all` 实测无输出，只能逐个 index 问）。
 *  - 拉起：`MuMuManager.exe control -v <index> launch` → `{"errcode":0,"errmsg":""}`，
 *    **185ms 就返回**（不等开机）；之后快照恢复约 **10 秒**就能 `adb connect` + `getprop sys.boot_completed=1`。
 *  - 因此「launch 返回」≠「能用了」：必须自己轮询 adb，否则下一步 adb/copilot 会立刻失败。
 *
 * 设计约束（都是崩溃事故的教训）：
 *  - 本模块所有函数**不抛异常**，失败一律放进返回值；
 *  - 同一时刻只允许一个启动流程（模块级 inflight），避免「插件启动 + 工具调用」双开；
 *  - 只读文件、只跑 MuMuManager/adb，不改 MAA 配置、不碰游戏。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adbRun, resolveAdbPath, ensureConnected } from './adb.js';

const IS_WIN = process.platform === 'win32';
const MANAGER_EXE = IS_WIN ? 'MuMuManager.exe' : 'MuMuManager';

/** 没开模拟器时，最多等多久（毫秒）。实测 10s 可连，给足冷启动余量。 */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3000;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

/** 模块级：正在进行的启动流程（避免并发双开）。 */
let inflight = null;
/** 上一次启动结果（给 doctor / 工具做展示，不参与判断）。 */
let lastRun = null;

export function lastEmulatorRun() {
  return lastRun ? { ...lastRun } : null;
}

/**
 * 定位 `MuMuManager.exe` 与实例 index。
 * 顺序：插件设置 → MAA 的 emulatorPath → adb 所在目录（…\shell\adb.exe）→ 常见安装根。
 * @returns {{ok:true, path:string, instanceIndex:number, source:string}|{ok:false, error:string, tried:string[]}}
 */
export function resolveMuMuManager({ cfg = {}, deps = {} } = {}) {
  const tried = [];
  const candidates = [];
  const configured = typeof cfg.mumuManagerPath === 'string' ? cfg.mumuManagerPath.trim() : '';
  if (configured) candidates.push({ p: configured, source: 'config' });

  const instanceDir = cfg.maaHint?.emulatorPath || '';
  if (instanceDir) candidates.push({ p: path.join(instanceDir, 'shell', MANAGER_EXE), source: 'maa-config' });
  if (instanceDir) candidates.push({ p: path.join(instanceDir, MANAGER_EXE), source: 'maa-config-root' });

  // adb 通常在 <安装>\shell\adb.exe ⇒ <安装>\shell\MuMuManager.exe
  const adb = deps.adb ?? resolveAdbPath({ configured: cfg.adbPath ?? '', hintPath: cfg.maaHint?.adbPath });
  if (adb?.ok && adb.path) {
    const shellDir = path.dirname(adb.path);
    candidates.push({ p: path.join(shellDir, MANAGER_EXE), source: 'adb-dir' });
    candidates.push({ p: path.join(path.dirname(shellDir), 'shell', MANAGER_EXE), source: 'adb-parent' });
  }

  // 常见安装根（MuMu 12 / MuMu 新版；目录名随版本变化，按层扫描而不是写死）
  const roots = [
    'D:\\MUMU',
    'C:\\Program Files\\Netease\\MuMuPlayer-12.0',
    'C:\\Program Files\\Netease\\MuMuPlayer',
    path.join(os.homedir(), 'AppData', 'Local', 'MuMuPlayer'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    candidates.push({ p: path.join(root, 'shell', MANAGER_EXE), source: `scan:${root}` });
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      candidates.push({ p: path.join(root, e.name, 'shell', MANAGER_EXE), source: `scan:${root}\\${e.name}` });
      candidates.push({ p: path.join(root, e.name, 'nx_main', MANAGER_EXE), source: `scan:${root}\\${e.name}\\nx_main` });
    }
  }

  for (const c of candidates) {
    tried.push(c.p);
    if (c.p && exists(c.p)) {
      return { ok: true, path: c.p, instanceIndex: Number.isInteger(cfg.mumuInstanceIndex) ? cfg.mumuInstanceIndex : 0, source: c.source };
    }
  }
  return { ok: false, error: `没找到 MuMuManager.exe（试过 ${tried.length} 个位置；可在插件设置里填 mumuManagerPath）`, tried };
}

/**
 * 问一次某个实例的状态。
 * @returns {{ok:true, index:number, name:string|null, started:boolean}|{ok:false, error:string, index:number}}
 */
export async function queryInstance({ managerPath, index = 0, deps = {} } = {}) {
  const run = deps.run ?? adbRun;
  if (!managerPath) return { ok: false, index, error: '未定位到 MuMuManager.exe' };
  const r = await run(managerPath, ['info', '-v', String(index)], { timeoutMs: 20000 });
  if (!r.ok) return { ok: false, index, error: `MuMuManager info 失败：${(r.stderr || r.error || '').trim() || '未知原因'}` };
  let json;
  try { json = JSON.parse(String(r.stdout ?? '').replace(/^\uFEFF/, '')); } catch {
    return { ok: false, index, error: `MuMuManager info 输出不是 JSON：${String(r.stdout ?? '').slice(0, 120)}` };
  }
  if (json?.error_code && json.error_code !== 0) {
    return { ok: false, index, error: `MuMuManager 报 error_code=${json.error_code}（实例 index 可能不对）` };
  }
  return { ok: true, index, name: json?.name ?? null, started: Boolean(json?.is_process_started) };
}

/**
 * 确保模拟器在跑：没开就 launch，然后轮询到能连上为止。
 * @param {object} args
 * @param {object} args.cfg 已解析的插件配置
 * @param {boolean} [args.autoLaunch] false 时只探测不启动
 * @param {number} [args.timeoutMs]
 * @param {object} [args.deps] 单测注入 { run, sleep }
 * @returns {Promise<object>} 永远 resolve
 */
export async function ensureEmulator({ cfg = {}, autoLaunch = true, timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS, deps = {} } = {}) {
  if (inflight) {
    try { return await inflight; } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }
  inflight = runEnsure({ cfg, autoLaunch, timeoutMs, deps });
  try {
    return await inflight;
  } catch (e) {
    const failed = { ok: false, error: `模拟器流程异常: ${e?.message || e}` };
    lastRun = failed;
    return failed;
  } finally {
    inflight = null;
  }
}

async function runEnsure({ cfg, autoLaunch, timeoutMs, deps }) {
  const startedAt = Date.now();
  const finish = (value) => {
    lastRun = { at: Date.now(), elapsedMs: Date.now() - startedAt, ...value };
    return lastRun;
  };
  const sleep = deps.sleep ?? realSleep;
  const run = deps.run ?? adbRun;
  const connect = deps.ensureConnected ?? ensureConnected;
  const pollMs = Number.isFinite(deps.pollIntervalMs) ? deps.pollIntervalMs : POLL_INTERVAL_MS;

  const manager = resolveMuMuManager({ cfg, deps });
  if (!manager.ok) return finish({ ok: false, error: manager.error, tried: manager.tried });

  const state = await queryInstance({ managerPath: manager.path, index: manager.instanceIndex, deps });
  if (!state.ok) return finish({ ok: false, error: state.error, manager: manager.path, index: manager.instanceIndex });

  const address = cfg.adbAddress || '127.0.0.1:16384';
  const adb = deps.adb ?? resolveAdbPath({ configured: cfg.adbPath ?? '', hintPath: cfg.maaHint?.adbPath });

  // 已经在跑：顺手 ensureConnected，省得后面 adb 工具报 device not found
  if (state.started) {
    if (adb?.ok) await connect(adb.path, address).catch(() => {});
    return finish({
      ok: true,
      started: true,
      launched: false,
      manager: manager.path,
      index: manager.instanceIndex,
      name: state.name,
      address,
      note: '模拟器本来就在跑',
    });
  }

  if (!autoLaunch) {
    return finish({ ok: false, started: false, launched: false, manager: manager.path, index: manager.instanceIndex, address, error: '模拟器没开，且当前不允许自动启动（autoLaunch=false）' });
  }

  // 拉起
  const launch = await run(manager.path, ['control', '-v', String(manager.instanceIndex), 'launch'], { timeoutMs: 60000 });
  if (!launch.ok) {
    return finish({ ok: false, started: false, launched: false, manager: manager.path, index: manager.instanceIndex, address, error: `启动失败：${(launch.stderr || launch.error || '').trim() || '未知原因'}` });
  }
  let launchJson = null;
  try { launchJson = JSON.parse(String(launch.stdout ?? '')); } catch { /* 有的版本不返回 JSON */ }
  if (launchJson && Number(launchJson.errcode ?? 0) !== 0) {
    return finish({ ok: false, started: false, launched: false, manager: manager.path, index: manager.instanceIndex, address, error: `启动被拒绝：errcode=${launchJson.errcode} ${launchJson.errmsg ?? ''}` });
  }

  // 等它能连上：launch 返回只是「命令收到」，不是「开机完成」
  const deadline = Date.now() + timeoutMs;
  let ticks = 0;
  while (Date.now() < deadline) {
    ticks += 1;
    if (adb?.ok) {
      await connect(adb.path, address).catch(() => {});
      const boot = await run(adb.path, ['-s', address, 'shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 10000 });
      if (boot.ok && String(boot.stdout ?? '').trim() === '1') {
        return finish({
          ok: true,
          started: true,
          launched: true,
          manager: manager.path,
          index: manager.instanceIndex,
          name: state.name,
          address,
          bootMs: Date.now() - startedAt,
          note: `已启动并等到开机完成（${Math.round((Date.now() - startedAt) / 1000)}s，轮询 ${ticks} 次）`,
        });
      }
    }
    await sleep(pollMs);
  }
  return finish({
    ok: false,
    started: false,
    launched: true,
    manager: manager.path,
    index: manager.instanceIndex,
    address,
    error: `已下达启动命令，但 ${Math.round(timeoutMs / 1000)}s 内没等到模拟器可连接（轮询 ${ticks} 次）；到模拟器窗口看是不是卡在启动/掉驱动`,
  });
}
