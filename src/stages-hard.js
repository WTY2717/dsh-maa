/**
 * H 关（绝境作战 / `hard_*`）代号 → 内部 stageId 的别名表。
 *
 * 为什么单独一份：作业站（prts.plus）只认内部 stageId，而 `<MAA>\resource\stages.json` 里
 * **没有 H 关**（这些关卡没有掉落，MAA 的关卡表只收有掉落的关卡，606 条里一条 `H*` 都没有）。
 * 实测作业站 `level_keyword=hard_12-02` 有 45 条作业 ⇒ H12-2 的 stageId 就是 `hard_12-02`。
 *
 * 两级来源：
 *  1. 规则推导：`H<章>-<序>` → `hard_<章补两位>-<序补两位>`；
 *  2. 存在性校验：扫 `<MAA>\resource\Arknights-Tile-Pos\*.json` 的**文件名**（4320 个），
 *     文件名规律是 `<stageId>-<zone>-level_<stageId>.json`
 *     （如 `hard_12-02-obt-hard-level_hard_12-02.json`），取 `-level_` 之后那段就是 stageId
 *     —— 注意不能取第一个 `-` 之前，stageId 自己就带 `-`。这一步只读文件名，不解析内容，几十毫秒。
 *
 * 明确不做：往 stages.json 里塞假条目。那是第三方资源文件，MAA 更新会覆盖，还会污染 MaaCore 的关卡识别。
 */
import fs from 'node:fs';
import path from 'node:path';

const CACHE_TTL_MS = 60_000;
const cache = new Map();

/** 清缓存（单测用）。 */
export function clearHardCache() {
  cache.clear();
}

/**
 * `H12-2` / `h12-2` / `H 12 - 2` → `hard_12-02`。不是 H 关格式就返回 null。
 * @returns {string|null}
 */
export function hardCodeToStageId(code) {
  const raw = String(code ?? '').trim();
  if (!raw) return null;
  const m = /^h\s*(\d{1,2})\s*[-－—–]\s*(\d{1,2})$/i.exec(raw);
  if (!m) return null;
  const chapter = String(Number(m[1])).padStart(2, '0');
  const index = String(Number(m[2])).padStart(2, '0');
  return `hard_${chapter}-${index}`;
}

/**
 * 扫 Tile-Pos 文件名，拿到所有「关卡表里没有」的 stageId 集合。
 * @param {string} installDir MAA 安装目录
 * @returns {{ok:boolean, ids:Set<string>, hard:string[], source:string|null, error:string|null}}
 */
export function loadHardAliases(installDir) {
  if (!installDir) {
    return { ok: false, ids: new Set(), hard: [], source: null, error: '未定位到 MAA 安装目录' };
  }
  const dir = path.join(installDir, 'resource', 'Arknights-Tile-Pos');
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    const value = {
      ok: false,
      ids: new Set(),
      hard: [],
      source: dir,
      error: `读不到 ${dir}（${e.message}）——不影响普通关卡，只影响 H 关别名自动补全`,
    };
    cache.set(dir, { at: Date.now(), value });
    return value;
  }

  const ids = new Set();
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    // 文件名 = `<stageId>-<zone>-level_<stageId>.json`，以 `-level_` 为分隔取尾部（stageId 自身含 `-`）
    const m = /-level_([\w#-]+)\.json$/i.exec(name);
    if (m) ids.add(m[1]);
  }
  const hard = [...ids].filter((id) => id.startsWith('hard_')).sort();
  const value = { ok: true, ids, hard, source: dir, error: null };
  cache.set(dir, { at: Date.now(), value });
  return value;
}

/**
 * 把用户输入解析成 H 关 stageId（含 `hard_*` 直给的情况）。
 * @param {string} input
 * @param {{ok:boolean, ids:Set<string>, error?:string}|null} aliases loadHardAliases 的结果
 * @returns {{stageId:string|null, via?:string, verified?:boolean, error?:string}}
 */
export function resolveHardStage(input, aliases) {
  const raw = String(input ?? '').trim();
  if (!raw) return { stageId: null };
  // 已经给了内部 stageId
  if (aliases?.ok && aliases.ids.has(raw)) return { stageId: raw, via: 'tilepos-id', verified: true };

  const derived = hardCodeToStageId(raw);
  if (!derived) return { stageId: null };
  if (aliases?.ok && aliases.ids.has(derived)) return { stageId: derived, via: 'hard-alias', verified: true };
  if (!aliases?.ok) {
    // 没有 Tile-Pos 可校验：规则足够可靠，照样给出，但标注未校验
    return { stageId: derived, via: 'hard-alias-unverified', verified: false };
  }
  return { stageId: null, error: `推导出 ${derived}，但 ${aliases.source} 里没有这个关卡文件（确认章节/序号）` };
}
