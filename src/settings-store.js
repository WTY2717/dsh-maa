/**
 * 设置页的持久化存储（插件自己的一份 JSON，不碰 profile 文件）。
 *
 * 为什么不用 loader 行的 config + `.volatile()`：
 * 实测本机 DSH（0.2.1-rc.3 + @deepseek-ai/schemastery）里，`.volatile()` 字段 resolve 出来
 * 是 **cosmokit 的 Volatile 包装对象**（`{ get(), [symbol.write]() }`）而不是标量。
 * 把它当字符串拼路径 → TypeError → 在 `void startBridge()` 这种"发出去不管"的异步调用里
 * 变成未捕获 Promise 拒绝 → Node 默认退出进程，整个 DSH 崩掉（本次事故就是这么来的）。
 *
 * 所以：行 config 保持普通标量（只作为默认值/兼容旧写法），设置页的值写入本文件，
 * 优先级最高。文件写入用「临时文件 + rename」保证不会读到半个文件。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 允许用户在设置页改的字段（顺序即表单顺序）。 */
export const EDITABLE_FIELDS = [
  ['rosterPath', 'string'],
  ['maaInstallPath', 'string'],
  ['adbPath', 'string'],
  ['adbAddress', 'string'],
  ['adbConfig', 'string'],
  ['bridgePort', 'number'],
  ['formationIndex', 'number'],
  ['copilotTimeoutSeconds', 'number'],
  ['dataDir', 'string'],
  ['nodePath', 'string'],
  ['connectExtras', 'string'],
  ['popupGuard', 'boolean'],
];

const TYPE = Object.fromEntries(EDITABLE_FIELDS);

/** 按字段类型清洗；不合法就丢弃（返回 undefined，交给上层用默认值）。 */
export function sanitizeField(key, value) {
  const type = TYPE[key];
  if (!type) return undefined;
  if (type === 'string') return typeof value === 'string' ? value : undefined;
  if (type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}

/** 清洗整份 patch：只留白名单字段，且类型必须对。 */
export function sanitizePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const [key] of EDITABLE_FIELDS) {
    if (!Object.hasOwn(patch, key)) continue;
    const clean = sanitizeField(key, patch[key]);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

export function settingsFilePath(pkgDir) {
  return path.join(pkgDir, 'data', 'settings.json');
}

/** 读覆盖值；文件不存在/损坏都返回 {}（绝不抛）。 */
export function readOverrides(pkgDir) {
  const file = settingsFilePath(pkgDir);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return sanitizePatch(parsed);
  } catch {
    return {};
  }
}

/** 合并写入（原子替换），返回合并后的完整覆盖值。 */
export function writeOverrides(pkgDir, patch) {
  const file = settingsFilePath(pkgDir);
  const clean = sanitizePatch(patch);
  const merged = { ...readOverrides(pkgDir), ...clean };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return merged;
}
