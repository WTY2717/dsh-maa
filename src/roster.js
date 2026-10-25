/**
 * 干员练度（roster）：用户导出表（Markdown）或 MAA 的 OperBoxData.json。
 *
 * 唯一事实来源是用户的导出表（表头固定，见 docs/tools/maa-copilot.md）：
 *   | 干员 | ID | 星级 | 精英化等级 | 等级 | 是否拥有 | 潜能 |
 * 导出表没有技能等级和模组，所以匹配只能到「精英化 + 等级 + 潜能」，其余交给 MAA 用游戏内数据复验。
 */
import fs from 'node:fs';
import path from 'node:path';

const COLS = {
  name: ['干员', 'name', '干员名'],
  id: ['ID', 'id', 'charId'],
  rarity: ['星级', 'rarity'],
  elite: ['精英化等级', '精英化', 'elite', 'evolve'],
  level: ['等级', 'level'],
  own: ['是否拥有', '拥有', 'own'],
  potential: ['潜能', 'potential', 'potentiality'],
};

const norm = (s) => String(s ?? '').trim();
const num = (v) => {
  const n = Number.parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

/** 一行一个干员的 Markdown 表 → 对象数组。 */
export function parseMarkdownTable(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return { opers: [], problems: ['没有找到 Markdown 表格行'] };
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(norm);
  const header = cells(lines[0]);
  const idx = {};
  for (const [key, aliases] of Object.entries(COLS)) {
    const at = header.findIndex((h) => aliases.some((a) => h.toLowerCase() === a.toLowerCase()));
    if (at >= 0) idx[key] = at;
  }
  const missing = ['name', 'elite', 'level'].filter((k) => idx[k] == null);
  if (missing.length) return { opers: [], problems: [`表头缺少列: ${missing.join(', ')}（实际表头: ${header.join(' | ')}）`], header };
  const opers = [];
  for (const line of lines.slice(1)) {
    const row = cells(line);
    if (row.length < 3 || /^:?-+:?$/.test(row[0])) continue; // 分隔行
    const pick = (k) => (idx[k] == null ? null : row[idx[k]]);
    const name = pick('name');
    if (!name) continue;
    const ownRaw = pick('own');
    opers.push({
      name,
      id: pick('id') || null,
      rarity: num(pick('rarity')),
      elite: num(pick('elite')) ?? 0,
      level: num(pick('level')) ?? 1,
      potential: num(pick('potential')) ?? 1,
      own: ownRaw == null ? true : /^(是|有|true|yes|1|√|✓)$/i.test(norm(ownRaw)),
    });
  }
  return { opers, problems: [], header };
}

/** MAA `OperBoxData.json` 或本项目 `roster.json` 的 `{own_opers:[…]}` 形态。 */
export function parseJsonRoster(text) {
  let json;
  try { json = JSON.parse(text); } catch (e) { return { opers: [], problems: [`JSON 解析失败: ${e.message}`] }; }
  const list = Array.isArray(json) ? json : json?.own_opers ?? json?.opers ?? json?.data?.own_opers;
  if (!Array.isArray(list)) return { opers: [], problems: ['JSON 里找不到 own_opers 数组'] };
  const opers = [];
  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const name = norm(o.name);
    if (!name) continue;
    const elite = o.elite ?? o.evolve ?? o.elite_level ?? 0;
    const level = o.level ?? o.lvl ?? 1;
    opers.push({
      name,
      id: o.id ?? o.charId ?? null,
      rarity: num(o.rarity),
      elite: num(elite) ?? 0,
      level: num(level) ?? 1,
      potential: num(o.potential ?? o.potentiality) ?? 1,
      own: o.own === undefined ? true : Boolean(o.own),
    });
  }
  return { opers, problems: [] };
}

/** 自动识别格式：以 `{`/`[` 开头当 JSON，否则当 Markdown 表。 */
export function parseRoster(text, { source = '' } = {}) {
  // 先统一去掉 UTF-8 BOM：带 BOM 时 JSON.parse 直接失败，
  // Markdown 表头第一个格子也会变成 "\uFEFF干员" 导致按列名匹配不到（实测踩过）
  const cleaned = text.replace(/^\uFEFF/, '');
  const isJson = cleaned.trimStart().startsWith('{') || cleaned.trimStart().startsWith('[');
  const parsed = isJson ? parseJsonRoster(cleaned) : parseMarkdownTable(cleaned);
  const opers = parsed.opers ?? [];
  const owned = opers.filter((o) => o.own);
  return {
    source,
    format: isJson ? 'json' : 'markdown',
    total: opers.length,
    owned: owned.length,
    opers,
    problems: parsed.problems ?? [],
    header: parsed.header ?? null,
  };
}

/* ────────────────────── 缓存 ────────────────────── */

const cache = new Map(); // absPath → { mtimeMs, size, parsed }

/**
 * 读练度文件（带 mtime+size 缓存）。
 * 缓存键包含 mtime/size，所以「改设置里的路径」和「改文件内容」都会立刻生效，不需要重启。
 * @returns {{ ok:boolean, path:string, format?:string, total?:number, owned?:number, byName?:Map<string,object>, problems:string[], error?:string }}
 */
export function loadRoster(filePath) {
  if (!filePath) {
    return { ok: false, path: '', problems: ['未配置 rosterPath（在插件设置里填导出表路径）'], error: '未配置 rosterPath' };
  }
  const abs = path.resolve(filePath);
  let stat;
  try { stat = fs.statSync(abs); } catch {
    return { ok: false, path: abs, problems: [`文件不存在: ${abs}`], error: `文件不存在: ${abs}` };
  }
  if (!stat.isFile()) return { ok: false, path: abs, problems: [`不是文件: ${abs}`], error: `不是文件: ${abs}` };
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) {
    return { ok: false, path: abs, problems: [`读取失败: ${e.message}`], error: `读取失败: ${e.message}` };
  }
  const parsed = parseRoster(text, { source: abs });
  const byName = new Map(parsed.opers.filter((o) => o.own).map((o) => [o.name, o]));
  const value = {
    ok: parsed.problems.length === 0 && parsed.owned > 0,
    path: abs,
    format: parsed.format,
    total: parsed.total,
    owned: parsed.owned,
    byName,
    problems: parsed.problems,
    error: parsed.owned === 0 ? '没解析出任何“已拥有”的干员' : null,
  };
  cache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}
