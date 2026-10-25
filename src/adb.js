/**
 * adb 辅助：定位 adb、连通模拟器、直接截图。
 *
 * 存在的理由：MAA GUI 没开时（或 MaaCore 直连后端在处理别的任务时），
 * 唯一能观察游戏画面的手段就是 `adb exec-out screencap -p`（见 docs/tools/maa-copilot.md）。
 *
 * 关于 `input tap/swipe`（2026-10-25 复测修正）：**它们是可用的**，旧结论「对这个 Unity 游戏无效」
 * 是坐标错误造成的假象 —— adb 吃的是设备坐标（本机 1920×1080），当年直接喂了 1280×720 的坐标。
 * 滑动实现在 src/input/（换算见 src/input/coords.js）；这里只提供 adb 进程执行与截图。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 跑一条 adb 命令（永不 reject，失败在返回值里）。给 input/ 复用，便于单测注入假实现。 */
export const adbRun = (cmd, args, { timeoutMs = 20000, encoding = 'utf8' } = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, error: error ? String(error.message || error) : null, stdout, stderr: String(stderr ?? '') });
    });
  });

/** 本文件内部沿用短名字。 */
const run = adbRun;

const isFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

/**
 * adb 定位顺序：插件设置 → MAA 自己的 gui.new.json（AdbPath）→ ANDROID_HOME → MuMu 实例目录 → 常见 SDK 路径。
 * 之所以要读 MAA 的配置：MuMu 多开时每个实例都有自己的 `shell\adb.exe`，
 * 目录扫描只会按字母序命中第一个，而 MAA 配置里写的是用户真正在用的那个实例。
 */
export function resolveAdbPath({ configured = '', hintPath = '' } = {}) {
  const candidates = [];
  if (configured) candidates.push(configured);
  if (hintPath) candidates.push(hintPath);
  if (process.env.ANDROID_HOME) candidates.push(path.join(process.env.ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  if (process.env.ANDROID_SDK_ROOT) candidates.push(path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  for (const root of ['D:\\MUMU', 'C:\\Program Files\\Netease\\MuMuPlayer-12.0', 'C:\\Program Files\\Netease\\MuMuPlayer', path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools')]) {
    if (!fs.existsSync(root)) continue;
    if (root.endsWith('platform-tools')) { candidates.push(path.join(root, exe)); continue; }
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      candidates.push(path.join(root, e.name, 'shell', exe));
      candidates.push(path.join(root, e.name, 'shell', 'adb.exe'));
    }
  }
  for (const c of candidates) if (c && isFile(c)) return { ok: true, path: c, source: c === configured ? 'config' : c === hintPath ? 'maa-config' : 'auto' };
  return { ok: false, path: configured || null, error: `没找到 adb（试过 ${candidates.filter(Boolean).length} 个位置）；可在插件设置里填 adbPath` };
}

/** `adb devices -l`。 */
export async function listDevices(adbPath) {
  if (!adbPath) return { ok: false, error: '未定位到 adb', devices: [] };
  const r = await run(adbPath, ['devices', '-l']);
  if (!r.ok) return { ok: false, error: r.error, devices: [] };
  const devices = r.stdout.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(/\s+/)[0]);
  return { ok: true, devices, raw: r.stdout.trim() };
}

/** 确保 `adb connect <address>` 已执行（MuMu 的多开端口需要这一步）。 */
export async function ensureConnected(adbPath, address) {
  if (!adbPath || !address) return { ok: false, error: 'adb 或地址缺失' };
  const r = await run(adbPath, ['connect', address], { timeoutMs: 15000 });
  return { ok: r.ok, output: (r.stdout || r.error || '').trim() };
}

/**
 * 直接截图到文件。
 * @returns {{ ok:boolean, file?:string, bytes?:number, error?:string }}
 */
export async function screencap({ adbPath, address, outFile, timeoutMs = 25000 }) {
  if (!adbPath) return { ok: false, error: '未定位到 adb' };
  if (address) await ensureConnected(adbPath, address);
  const args = address ? ['-s', address, 'exec-out', 'screencap', '-p'] : ['exec-out', 'screencap', '-p'];
  let r = await run(adbPath, args, { encoding: 'buffer', timeoutMs });
  const firstByte = Buffer.isBuffer(r.stdout) ? r.stdout[0] : null;
  if (!r.ok || firstByte !== 0x89) {
    // 老 adb / 个别机型 `exec-out` 不支持，退回 pull
    const tmp = path.join(os.tmpdir(), `maa-shot-${Date.now()}.png`);
    const one = await run(adbPath, address ? ['-s', address, 'shell', 'screencap', '-p', '/sdcard/dsh-maa.png'] : ['shell', 'screencap', '-p', '/sdcard/dsh-maa.png']);
    const two = await run(adbPath, address ? ['-s', address, 'pull', '/sdcard/dsh-maa.png', tmp] : ['pull', '/sdcard/dsh-maa.png', tmp]);
    if (!one.ok || !two.ok || !isFile(tmp)) {
      return { ok: false, error: r.error || one.error || two.error || '截图失败' };
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.copyFileSync(tmp, outFile);
    return { ok: true, file: outFile, bytes: fs.statSync(outFile).size };
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, r.stdout);
  return { ok: true, file: outFile, bytes: r.stdout.length };
}
