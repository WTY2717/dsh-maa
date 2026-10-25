/**
 * 自检（`maa_doctor`）：MAA 定位 / 版本 / 能力表 / 练度文件解析 / adb / 桥状态。
 *
 * 要求 2 的落地：所有报错都带版本号，定位不到就说清楚试过哪些地方，
 * 缺 resource 之类的降级也要给出可读结论而不是崩。
 */
import path from 'node:path';
import fs from 'node:fs';
import { resolveInstallCached, describeInstall, validateInstallDir, instanceDirFromAdb } from './maa.js';
import { describeMaaConfigHint } from './maa-config.js';
import { loadRoster } from './roster.js';
import { loadStages } from './stages.js';
import { loadHardAliases } from './stages-hard.js';
import { resolveAdbPath, listDevices } from './adb.js';
import { connectionExtras } from './copilot.js';
import { detectInputBackend } from './input/backend.js';
import { resolveMuMuManager, queryInstance, lastEmulatorRun } from './emulator.js';

/** 能力表里视为「必需」的符号；缺一个就说明这个 MaaCore 用不了。 */
const REQUIRED = ['AsstSetUserDir', 'AsstLoadResource', 'AsstCreateEx', 'AsstAppendTask', 'AsstStart', 'AsstConnected', 'AsstDestroy'];

/**
 * @param {object} args
 * @param {object} args.cfg 已解析的插件配置
 * @param {object} [args.bridge] Bridge 实例（可空）
 * @param {string} [args.bridgeError] 桥启动失败的原因（可空）
 * @param {string} [args.pkgVersion] 插件版本
 */
export async function doctor({ cfg, bridge = null, bridgeError = null, pkgVersion = '0.0.0', ui = null }) {
  const problems = [];
  const warnings = [];

  /* MAA 安装：路径在 resolveConfig 里已经定好（配置优先，否则自动探测） */
  problems.push(...(cfg.maaInstallProblems ?? []));
  const maa = cfg.maaInstallPath ? describeInstall(cfg.maaInstallPath) : null;
  const candidates = resolveInstallCached({ configured: '' }).candidates;
  if (!maa) {
    problems.push('没找到可用的 MAA 安装（判定标准：目录里同时有 MaaCore.dll 和 resource\\stages.json）。在插件设置里填 maaInstallPath');
  } else {
    const missing = REQUIRED.filter((s) => !maa.capabilities[s]);
    if (missing.length) problems.push(`MaaCore.dll 缺少必需符号: ${missing.join(', ')}（版本 ${maa.version ?? '未知'}）`);
    const optionalMissing = Object.entries(maa.capabilities).filter(([k, v]) => !v && !REQUIRED.includes(k)).map(([k]) => k);
    if (optionalMissing.length) warnings.push(`可选符号缺失（已降级）: ${optionalMissing.join(', ')}`);
    if (!maa.hasExportTable) warnings.push('读不到 MaaCore.dll 的导出表（文件被替换或不是 PE？能力表不可信）');
    const v = validateInstallDir(maa.dir);
    if (!v.ok) problems.push(`安装目录校验失败: ${v.problems.join('；')}`);
  }

  /* 资源版本 */
  const resource = maa?.resource ?? null;
  if (maa && !resource) warnings.push('缺 resource\\version.json（资源版本未知，不影响跑任务）');

  /* 关卡表 */
  const stages = loadStages(maa?.dir);
  if (maa && !stages.ok) problems.push(`关卡表不可用: ${stages.error}`);
  const hardAliases = loadHardAliases(maa?.dir);

  /* 练度文件 */
  const roster = loadRoster(cfg.rosterPathResolved);
  if (!roster.ok) problems.push(`练度文件不可用: ${roster.error ?? roster.problems.join('；')}`);

  /* adb */
  const adb = resolveAdbPath({ configured: cfg.adbPath, hintPath: cfg.maaHint?.adbPath });
  if (!adb.ok) warnings.push(adb.error);
  let devices = null;
  if (adb.ok) {
    try { devices = await listDevices(adb.path); } catch { devices = { ok: false, error: 'adb devices 失败' }; }
    if (devices.ok && devices.devices.length === 0) warnings.push('adb 里没有设备：模拟器没开，或地址不是 127.0.0.1:16384');
    if (devices.ok && devices.devices.length && !devices.devices.includes(cfg.adbAddress)) {
      warnings.push(`adb 里的设备（${devices.devices.join(', ')}）和配置的 adbAddress（${cfg.adbAddress}）不一致`);
    }
  }

  /* 滑动输入后端（maa_swipe）：探测一次就够，失败只降级成 warning —— 不滑动也能用别的工具 */
  let input = null;
  try {
    const r = await detectInputBackend({ cfg, force: 'auto' });
    input = r.ok
      ? { backend: r.backend, view: r.view, viewSource: r.viewSource ?? null, adb: r.adb, reason: r.reason }
      : { backend: null, error: r.error };
    if (!r.ok && adb.ok) warnings.push(`滑动手势不可用（maa_swipe）: ${r.error}`);
  } catch (e) {
    input = { backend: null, error: String(e?.message || e) };
    warnings.push(`滑动手势后端探测失败: ${e?.message || e}`);
  }

  /* 模拟器（MuMu）：插件启动时会自动拉起，这里只报状态，不启动 */
  let emulator = null;
  try {
    const manager = resolveMuMuManager({ cfg });
    const state = manager.ok
      ? await queryInstance({ managerPath: manager.path, index: manager.instanceIndex })
      : { ok: false, error: manager.error };
    emulator = {
      autoStart: cfg.autoStartEmulator !== false,
      manager: manager.ok ? manager.path : null,
      managerSource: manager.ok ? manager.source : null,
      index: manager.instanceIndex ?? null,
      name: state.ok ? state.name : null,
      started: state.ok ? state.started : null,
      error: state.ok ? null : (state.error ?? manager.error ?? null),
      lastRun: lastEmulatorRun(),
    };
  } catch (e) {
    emulator = { error: String(e?.message || e) };
  }

  /* MaaCore 子进程依赖 */
  let koffi = null;
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    koffi = require('koffi/package.json').version;
  } catch {
    warnings.push('koffi 未安装：maa_copilot_run / maa_click 的 MaaCore 直连后端不可用（远程控制工具不受影响）');
  }
  let nodeExe = null;
  try {
    const { resolveNodeBinary } = await import('./core/driver.js');
    nodeExe = await resolveNodeBinary(cfg.nodePath);
  } catch (e) {
    problems.push(`找不到运行 MaaCore 子进程的 node: ${e.message}`);
  }

  /* 桥 */
  const bridgeInfo = bridge
    ? bridge.health()
    : { listening: false, online: false, error: bridgeError, note: bridgeError ? '启动失败' : '桥未启动' };

  /* 目录可写性 */
  const dirs = { dataRoot: cfg.dataRoot, jobsDir: cfg.jobsDir, shotsDir: cfg.shotsDir, coreUserDir: cfg.coreUserDir };
  const dirState = {};
  for (const [k, dir] of Object.entries(dirs)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      dirState[k] = { path: dir, ok: true };
    } catch (e) {
      dirState[k] = { path: dir, ok: false, error: e.message };
      problems.push(`目录不可写: ${dir}（${e.message}）`);
    }
  }

  return {
    ok: problems.length === 0,
    plugin: { name: '@local/dsh-maa', version: pkgVersion },
    maa: maa
      ? {
          path: maa.dir,
          source: cfg.maaInstallSource,
          version: maa.version,
          resource: maa.resource,
          capabilities: maa.capabilities,
          symbolCount: maa.symbolCount,
          candidates: candidates.map((c) => ({ path: c.dir, version: c.version })),
        }
      : { path: null, candidates: candidates.map((c) => ({ path: c.dir, version: c.version })) },
    stages: stages.ok
      ? {
          path: stages.path,
          count: stages.count,
          hardAliases: hardAliases.ok ? hardAliases.hard.length : null,
          hardAliasSource: hardAliases.ok ? hardAliases.source : hardAliases.error,
          hardAliasNote: 'H 关（hard_*）不在 stages.json 里，靠 Arknights-Tile-Pos 文件名反推；maa_copilot_find 支持 H12-2 这种写法',
        }
      : { error: stages.error },
    maaConfigHint: describeMaaConfigHint(cfg.maaHint),
    roster: {
      path: roster.path,
      ok: roster.ok,
      format: roster.format,
      parsed: roster.total ?? 0,
      owned: roster.owned ?? 0,
      problems: roster.problems,
      source: cfg.rosterPath ? 'config' : 'auto',
    },
    adb: {
      path: adb.path,
      source: adb.ok ? adb.source : null,
      error: adb.ok ? null : adb.error,
      devices: devices?.devices ?? null,
      address: cfg.adbAddress,
      config: cfg.adbConfig,
      extras: connectionExtras(cfg, adb.path),
      instanceDir: adb.ok ? instanceDirFromAdb(adb.path) : null,
    },
    emulator,
    input: input
      ? {
          backend: input.backend,
          view: input.view ?? null,
          viewSource: input.viewSource ?? null,
          adb: input.adb ?? null,
          reason: input.reason ?? null,
          error: input.error ?? null,
          note: input.backend ? 'maa_swipe 走 adb input（1280×720 → 设备坐标由插件换算）' : 'maa_swipe 不可用，其余工具不受影响',
        }
      : null,
    core: {
      koffi: koffi ?? null,
      node: nodeExe ? { bin: nodeExe.bin, label: nodeExe.label } : null,
      userDir: cfg.coreUserDir,
    },
    bridge: { ...bridgeInfo, port: cfg.bridgePort },
    settingsPage: ui
      ? {
          route: ui.route,
          routeInstalled: Boolean(ui.routeInstalled),
          error: ui.error,
          settingsFile: cfg.settingsFile ?? null,
          where: '设置 → 插件 → 顶部分页「MAA 助手」（首选）；或设置 → 插件 → 已安装 → @local/dsh-maa → 该行「配置」',
          note: '设置页的值存在 data/settings.json，保存后下一次工具调用即生效，不需要重启',
        }
      : null,
    dirs: dirState,
    problems,
    warnings,
    nextSteps: problems.length
      ? ['按 problems 逐条修：MAA 路径 / 练度文件 / adb / node', '改完设置直接重跑 maa_doctor，不需要重启']
      : ['练度与作业站都通了就可以 maa_copilot_find(关卡)，再 maa_copilot_run 作业文件'],
    logDir: cfg.logDir,
  };
}
