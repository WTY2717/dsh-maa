/**
 * 定位本机 MAA、读版本、探测能力。零打包：不复制 MaaCore.dll / resource。
 *
 * 只依赖稳定契约：
 *   - `<MAA>\MaaCore.dll` 与 `<MAA>\resource\stages.json` 同时存在才算有效安装；
 *   - `MAA.exe` 的 FileVersion（PE 版本资源）作为版本号，`resource\version.json` 作为资源版本；
 *   - `MaaCore.dll` 导出表里的 `Asst*` 符号作为能力表。
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readFileVersion, readExportNames } from './pe.js';

/**
 * 我们真正会调用的符号（与 src/core/worker.mjs 的 SIG 对齐）。
 * 缺失即降级；`need()` 会给出可读原因而不是 TypeError。
 * 「信息类」符号（`AsstGetVersion` 等）不列进来，免得能力表把没用的符号报成缺失。
 */
export const CORE_SYMBOLS = [
  'AsstSetUserDir',
  'AsstLoadResource',
  'AsstCreateEx',
  'AsstDestroy',
  'AsstSetConnectionExtras',
  'AsstAsyncConnect',
  'AsstConnected',
  'AsstAsyncClick',
  'AsstAppendTask',
  'AsstStart',
  'AsstStop',
  'AsstRunning',
];

const isDir = (p) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

/** 一份安装目录是否可用：MaaCore.dll + resource\stages.json 都在。 */
export function validateInstallDir(dir) {
  const problems = [];
  if (!dir) return { ok: false, problems: ['未指定目录'] };
  if (!isDir(dir)) return { ok: false, problems: [`目录不存在: ${dir}`] };
  const dll = path.join(dir, 'MaaCore.dll');
  const stages = path.join(dir, 'resource', 'stages.json');
  if (!existsSync(dll)) problems.push(`缺少 MaaCore.dll`);
  if (!existsSync(stages)) problems.push(`缺少 resource\\stages.json（资源未安装或路径给成了 resource 子目录）`);
  return { ok: problems.length === 0, problems };
}

/** 从 adb 路径推出 MuMu 实例目录（`…\shell\adb.exe` → `…`）。 */
export function instanceDirFromAdb(adbPath) {
  if (!adbPath) return null;
  const shell = path.dirname(adbPath);
  if (path.basename(shell).toLowerCase() !== 'shell') return null;
  return path.dirname(shell);
}

/** 常见安装位置候选（父目录 + 深度 1/2 里名字带 MAA 的目录）。 */
function scanRoots() {
  const home = os.homedir();
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    'C:\\',
    'D:\\',
    'E:\\',
    'D:\\MUMU',
    'D:\\Games',
    home ? path.join(home, 'Desktop') : null,
    home ? path.join(home, 'Downloads') : null,
  ].filter(Boolean);
  return [...new Set(roots)].filter(isDir);
}

const looksLikeMaa = (name) => /^maa/i.test(name) || /[-_ ]maa/i.test(name);

/** 扫一遍候选目录，返回所有通过校验的安装（按版本/时间排序）。 */
export function discoverInstalls({ extraDirs = [] } = {}) {
  const found = new Map();
  const consider = (dir) => {
    const key = path.resolve(dir).toLowerCase();
    if (found.has(key)) return;
    if (validateInstallDir(dir).ok) found.set(key, path.resolve(dir));
  };
  for (const d of extraDirs) consider(d);
  for (const root of scanRoots()) {
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(root, e.name);
      if (looksLikeMaa(e.name)) consider(full);
      // 常见父目录里再下一层：D:\MUMU\MAA-*、C:\Program Files\某个套件\MAA
      if (/mumu|games?|program|tools|arknights/i.test(e.name) || root === 'C:\\' || /^[A-Z]:\\$/.test(root)) {
        let sub;
        try { sub = readdirSync(full, { withFileTypes: true }); } catch { continue; }
        for (const s of sub) if (s.isDirectory() && looksLikeMaa(s.name)) consider(path.join(full, s.name));
      }
    }
  }
  return [...found.values()].map((dir) => describeInstall(dir));
}

/**
 * 一个安装的静态事实：版本、资源版本、能力表。
 * 按 `MaaCore.dll` 的 mtime 缓存：doctor / 每次 resolveConfig 都会问它，不缓存等于反复读 ~12 MB。
 */
const describeCache = new Map(); // dir → { mtimeMs, value }
export function describeInstall(dir) {
  const dll = path.join(dir, 'MaaCore.dll');
  let dllMtime = 0;
  try { dllMtime = statSync(dll).mtimeMs; } catch { /* 文件缺失时走非缓存路径 */ }
  const hit = describeCache.get(dir);
  if (hit && dllMtime && hit.mtimeMs === dllMtime) return hit.value;

  const exe = path.join(dir, 'MAA.exe');
  const version = existsSync(exe) ? readFileVersion(exe) : null;
  let resource = null;
  try {
    const v = JSON.parse(readFileSync(path.join(dir, 'resource', 'version.json'), 'utf8'));
    resource = { lastUpdated: v.last_updated ?? null, activity: v.activity?.name ?? null, gacha: v.gacha?.pool ?? null };
  } catch { /* 资源版本只是信息，缺了不影响能力 */ }
  let exportsList = [];
  try { exportsList = readExportNames(dll); } catch { /* 同上 */ }
  const exportSet = new Set(exportsList);
  const capabilities = Object.fromEntries(CORE_SYMBOLS.map((s) => [s, exportSet.has(s)]));
  const value = { dir, version, resource, capabilities, symbolCount: exportsList.length, hasExportTable: exportsList.length > 0, mtime: dllMtime };
  if (dllMtime) describeCache.set(dir, { mtimeMs: dllMtime, value });
  return value;
}

/** 版本字符串比较（`6.20.1` > `6.9.0`）；不可比时退化成 0。 */
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * 决定用哪个安装：配置项优先；否则按版本号新→旧，版本相同按 MaaCore.dll 时间新→旧。
 * @returns {{ chosen: object|null, candidates: object[], source: string, problems: string[] }}
 */
export function resolveInstall({ configured = '' } = {}) {
  const problems = [];
  if (configured) {
    const v = validateInstallDir(configured);
    if (v.ok) {
      return { chosen: describeInstall(configured), candidates: [describeInstall(configured)], source: 'config', problems };
    }
    problems.push(`配置的 maaInstallPath 不可用（${configured}）：${v.problems.join('；')}`);
  }
  const candidates = discoverInstalls();
  candidates.sort((a, b) => cmpVersion(b.version, a.version) || b.mtime - a.mtime);
  return { chosen: candidates[0] ?? null, candidates, source: candidates.length ? 'auto' : 'none', problems };
}

export { cmpVersion };

/** 目录扫描比读单个文件贵，缓存一小段时间；配置变化时 key 变了自然会重算。 */
const installCache = new Map(); // key → { at, value }
const INSTALL_TTL_MS = 15_000;

/**
 * resolveInstall 的带缓存版本（工具调用会频繁解析配置，不该每次扫盘）。
 * @returns {{ chosen: object|null, candidates: object[], source: string, problems: string[] }}
 */
export function resolveInstallCached({ configured = '' } = {}) {
  const key = configured.toLowerCase();
  const hit = installCache.get(key);
  if (hit && Date.now() - hit.at < INSTALL_TTL_MS) return hit.value;
  const value = resolveInstall({ configured });
  installCache.set(key, { at: Date.now(), value });
  return value;
}
