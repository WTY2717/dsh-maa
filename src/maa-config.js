/**
 * 读 MAA GUI 自己的配置（`config\gui.new.json`）里的**连接参数**。
 *
 * 为什么读它：这是「用户已经配好的模拟器连接」的权威来源（Adb 路径、地址、连接配置名、
 * MuMu 实例目录），比我们瞎猜常见路径可靠得多。它属于公开配置文件，
 * 不是 `debug\asst.log` 那种内部日志，所以不违反「不解析内部日志」的约束。
 *
 * 读不到/结构变了就返回 null，调用方退回自动探测——MAA 改配置结构也不会崩。
 */
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map(); // absPath → { mtimeMs, value }

/** @returns {null | {adbPath, address, configName, emulatorPath, clientType, touchMode, source}} */
export function readMaaGuiConfig(installDir) {
  if (!installDir) return null;
  const candidates = [
    path.join(installDir, 'config', 'gui.new.json'),
    path.join(installDir, 'config', 'gui.json'),
  ];
  for (const file of candidates) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.value;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      continue;
    }
    const gui = json?.Configurations?.Default?.Gui ?? json?.Configurations?.Default?.Gui;
    const cs = gui?.ConnectSettings;
    if (!cs) continue;
    const configName = typeof cs.Config === 'string' ? cs.Config : null;
    const extras = configName ? cs.Extras?.[configName] : null;
    // Extras 在 .NET 里是对象；序列化后可能是字符串（老格式）
    let emulatorPath = null;
    if (extras && typeof extras === 'object') emulatorPath = extras.EmulatorPath ?? null;
    if (!emulatorPath && typeof extras === 'string') {
      const m = /EmulatorPath=([^;\]]*)/.exec(extras);
      if (m) emulatorPath = m[1];
    }
    const value = {
      adbPath: typeof cs.AdbPath === 'string' && cs.AdbPath ? cs.AdbPath : null,
      address: typeof cs.Address === 'string' && cs.Address ? cs.Address : null,
      configName,
      emulatorPath: emulatorPath && String(emulatorPath).trim() ? String(emulatorPath).trim() : null,
      clientType: gui?.RuntimeSettings?.ClientType ?? null,
      touchMode: cs.TouchMode ?? null,
      source: file,
    };
    cache.set(file, { mtimeMs: stat.mtimeMs, value });
    return value;
  }
  return null;
}

/** 给 doctor 用的一小段摘要（不泄漏无关配置）。 */
export function describeMaaConfigHint(hint) {
  if (!hint) return { available: false, note: '没读到 MAA 的 gui.new.json（用自动探测/插件设置）' };
  return {
    available: true,
    source: hint.source,
    adbPath: hint.adbPath,
    address: hint.address,
    configName: hint.configName,
    emulatorPath: hint.emulatorPath,
    clientType: hint.clientType,
    touchMode: hint.touchMode,
  };
}
