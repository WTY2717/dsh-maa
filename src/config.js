/**
 * 插件配置（schemastery）。
 *
 * 三条铁律（都来自本次崩溃事故）：
 *  1. **字段不要 `.volatile()`**：本机 DSH 里 volatile 字段 resolve 出来是 cosmokit 的
 *     Volatile 包装对象（`{ get(), [symbol.write]() }`），当字符串用会 TypeError →
 *     在「发出去不管」的异步调用里变成未捕获 Promise 拒绝 → Node 直接退出进程（DSH 崩溃）。
 *  2. **行 config 只当默认值/兼容层**；用户在设置页改的值存在 `data/settings.json`
 *     （见 settings-store.js），优先级最高，改完下一次工具调用就生效。
 *  3. **resolveConfig 绝不抛**：任何异常都退回「默认值 + 自动探测」，原因记进 problems。
 *
 * 所有路径留空 = 自动探测；每个字段都带中文说明。
 */
import Schema from '@deepseek-ai/schemastery';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMaaGuiConfig } from './maa-config.js';
import { resolveInstallCached } from './maa.js';
import { readOverrides, EDITABLE_FIELDS } from './settings-store.js';

/** 与下面 schema 的默认值保持一致：配置项等于默认值时，允许被 MAA 自己的配置覆盖。 */
const DEFAULTS = {
  maaInstallPath: '',
  rosterPath: '',
  adbPath: '',
  adbAddress: '127.0.0.1:16384',
  adbConfig: 'MuMuEmulator12',
  formationIndex: 0,
  bridgePort: 18764,
  dataDir: '',
  nodePath: '',
  connectExtras: '',
  popupGuard: false,
  copilotTimeoutSeconds: 900,
};

export const Config = Schema.object({
  maaInstallPath: Schema.string().description('MAA 安装目录（含 MaaCore.dll 与 resource\\）。留空自动探测').default(''),
  rosterPath: Schema.string().description('干员练度文件：用户导出表（.md）或 {own_opers:[…]} 的 .json。留空自动探测').default(''),
  adbPath: Schema.string().description('adb 路径。留空自动探测（MuMu 为 <实例>\\shell\\adb.exe）').default(''),
  adbAddress: Schema.string().description('模拟器 adb 地址').default('127.0.0.1:16384'),
  adbConfig: Schema.string().description('MaaCore 连接配置名（MuMu12 用 MuMuEmulator12）').default('MuMuEmulator12'),
  formationIndex: Schema.natural().description('自动编队用哪个栏位，0=当前编队').default(0),
  bridgePort: Schema.natural().description('远程控制桥端口（MAA 的「远程控制」端点要填同一个）').default(18764),
  dataDir: Schema.string().description('截图/作业/核心用户目录的根（留空=插件目录下 data）').default(''),
  nodePath: Schema.string().description('跑 MaaCore 子进程的 node 可执行文件。留空自动（Electron 用 ELECTRON_RUN_AS_NODE）').default(''),
  connectExtras: Schema.string().description('MaaCore 连接 extras（JSON）。留空按 adbPath 自动推导 MuMu 实例目录').default(''),
  popupGuard: Schema.boolean().description('抄作业开打后自动补点画面中央，绕过「干员等级过低」弹窗（人少作业才需要）').default(false),
  copilotTimeoutSeconds: Schema.natural().description('单次抄作业的最长等待时间（秒）').default(900),
});

/** 值可能是 Volatile 包装/别的类型：只接受标量，否则用默认值。 */
function scalar(value, fallback) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return fallback;
}
const asString = (value, fallback = '') => {
  const v = scalar(value, fallback);
  return typeof v === 'string' ? v : String(v ?? '');
};
const asNumber = (value, fallback = 0, min = 0) => {
  const v = scalar(value, fallback);
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
};
const asBool = (value, fallback = false) => {
  const v = scalar(value, fallback);
  return typeof v === 'boolean' ? v : fallback;
};

/** 练度文件的自动探测顺序。 */
export function detectRosterPath() {
  const home = os.homedir();
  const guesses = [
    path.join(home, 'Documents', 'Arknights_OperBox_Export.md'),
    path.join(home, 'Documents', 'Arknights_OperBox_Export.json'),
    path.join(process.env.USERPROFILE ?? home, 'Arknights_OperBox_Export.md'),
  ];
  for (const g of guesses) {
    try { if (fs.statSync(g).isFile()) return g; } catch { /* next */ }
  }
  return '';
}

/**
 * 把原始 config + 设置页覆盖值变成后续模块要用的形状。
 * **绝不抛异常**：任何一步失败都退回默认值，并把原因记进 problems。
 * @param {object} raw Loader 传来的插件 config（只当默认值/兼容层）
 * @param {string} pkgDir 插件包目录（data/settings.json 与默认 data 根都在它下面）
 */
export function resolveConfig(raw = {}, pkgDir = process.cwd()) {
  const problems = [];
  let cfg;
  try {
    const overrides = readOverrides(pkgDir);
    const fromRow = raw && typeof raw === 'object' ? raw : {};
    cfg = {};
    for (const [key] of EDITABLE_FIELDS) {
      cfg[key] = Object.hasOwn(overrides, key) ? overrides[key] : (Object.hasOwn(fromRow, key) ? fromRow[key] : DEFAULTS[key]);
    }
  } catch (e) {
    problems.push(`读取配置失败（用默认值）: ${e?.message || e}`);
    cfg = { ...DEFAULTS };
  }

  const maaInstallPath = asString(cfg.maaInstallPath, '');
  const dataDirRaw = asString(cfg.dataDir, '');
  const dataRoot = dataDirRaw ? path.resolve(dataDirRaw) : path.join(pkgDir, 'data');

  // MAA 安装目录：配置优先，否则自动探测（缓存 15 秒；扫描失败也不抛）
  let install = { chosen: null, source: 'none', problems: [] };
  try {
    install = resolveInstallCached({ configured: maaInstallPath });
  } catch (e) {
    problems.push(`自动探测 MAA 安装失败: ${e?.message || e}`);
  }
  const installDir = install.chosen?.dir ?? maaInstallPath;

  // MAA GUI 自己的连接配置是权威来源（多开时它才知道用的是哪个实例）
  let hint = null;
  try {
    hint = readMaaGuiConfig(installDir);
  } catch (e) {
    problems.push(`读 MAA 配置失败（退回自动探测）: ${e?.message || e}`);
  }

  const rowAddress = asString(cfg.adbAddress, DEFAULTS.adbAddress);
  const rowConfig = asString(cfg.adbConfig, DEFAULTS.adbConfig);
  const adbAddress = rowAddress && rowAddress !== DEFAULTS.adbAddress ? rowAddress : (hint?.address || rowAddress || DEFAULTS.adbAddress);
  const adbConfig = rowConfig && rowConfig !== DEFAULTS.adbConfig ? rowConfig : (hint?.configName || rowConfig || DEFAULTS.adbConfig);

  const rosterRaw = asString(cfg.rosterPath, '');
  let rosterPathResolved = '';
  try {
    rosterPathResolved = rosterRaw ? path.resolve(rosterRaw) : detectRosterPath();
  } catch (e) {
    problems.push(`练度文件路径非法: ${e?.message || e}`);
  }

  return {
    ...cfg,
    // 把可编辑字段全部换成清洗后的标量：raw 可能是 Volatile 包装对象之类的脏值，
    // 直接 spread 出去会让下游（doctor / 工具）拿到 object 再当字符串用 —— 那正是本次崩溃的根源。
    // maaInstallPath 回填的是**解析后的安装目录**（配置为空时就是自动探测结果）；
    // 用户原本填的值另存 maaInstallPathConfigured，用于区分来源。
    maaInstallPath: installDir,
    maaInstallPathConfigured: maaInstallPath,
    rosterPath: rosterRaw,
    adbPath: asString(cfg.adbPath, ''),
    adbAddress,
    adbConfig,
    formationIndex: asNumber(cfg.formationIndex, 0),
    bridgePort: asNumber(cfg.bridgePort, 18764, 1),
    dataDir: dataDirRaw,
    nodePath: asString(cfg.nodePath, ''),
    connectExtras: asString(cfg.connectExtras, ''),
    popupGuard: asBool(cfg.popupGuard, false),
    copilotTimeoutSeconds: asNumber(cfg.copilotTimeoutSeconds, 900, 1),
    maaInstallSource: maaInstallPath ? 'config' : install.source,
    maaInstallProblems: [...(install.problems ?? []), ...problems],
    maaHint: hint,
    dataRoot,
    jobsDir: path.join(dataRoot, 'jobs'),
    shotsDir: path.join(dataRoot, 'shots'),
    coreUserDir: path.join(dataRoot, 'core-user'),
    logDir: path.join(dataRoot, 'logs'),
    rosterPathResolved,
    settingsFile: path.join(pkgDir, 'data', 'settings.json'),
  };
}
