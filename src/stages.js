/**
 * 关卡代号 ↔ 内部 stageId 的反查（数据来自 `<MAA>\resource\stages.json`）。
 *
 * 实测：作业站的 `level_keyword` 只认内部 stageId（`main_01-07`、`pro_d_2`），
 * 不认显示代号（`1-7`、`PR-D-2`）；返回体里的 `stage_name` 也是 stageId。
 *
 * H 关（绝境作战）**不在** stages.json 里（没有掉落），靠 ./stages-hard.js 的别名兜底。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadHardAliases, resolveHardStage } from './stages-hard.js';

const cache = new Map(); // absPath → { mtimeMs, byCode, byId }

/** 读 stages.json，建 code → stageId 与 stageId → 条目 两张表。 */
export function loadStages(installDir) {
  if (!installDir) return { ok: false, error: '未定位到 MAA 安装目录', byCode: null, byId: null };
  const abs = path.join(installDir, 'resource', 'stages.json');
  let stat;
  try { stat = fs.statSync(abs); } catch {
    return { ok: false, error: `缺少 resource\\stages.json: ${abs}`, byCode: null, byId: null };
  }
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.value;
  let json;
  try { json = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) {
    return { ok: false, error: `stages.json 解析失败: ${e.message}`, byCode: null, byId: null };
  }
  const byCode = new Map();
  const byId = new Map();
  for (const [key, v] of Object.entries(json)) {
    if (!v || typeof v !== 'object') continue;
    const stageId = v.stageId || key;
    byId.set(stageId, v);
    if (v.code) byCode.set(String(v.code).toLowerCase(), stageId);
  }
  const value = { ok: true, error: null, byCode, byId, path: abs, count: byId.size };
  cache.set(abs, { mtimeMs: stat.mtimeMs, value });
  return value;
}

/** 用户输入（`1-7` / `PR-D-2` / `main_01-07` / `H12-2`）→ 内部 stageId。 */
export function resolveStageId(stages, input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { stageId: null, error: '关卡为空' };
  if (!stages?.ok) return { stageId: null, error: stages?.error ?? '关卡表不可用' };
  const byCode = stages.byCode.get(raw.toLowerCase());
  if (byCode) return { stageId: byCode, from: 'code' };
  if (stages.byId.has(raw)) return { stageId: raw, from: 'stageId' };
  const dashed = raw.replace(/[－—–]/g, '-').replace(/\s+/g, '');
  const again = stages.byCode.get(dashed.toLowerCase());
  if (again) return { stageId: again, from: 'code' };

  // 兜底：H 关别名（stages.json 里没有 H 关，见 stages-hard.js）
  const installDir = stages.path ? path.dirname(path.dirname(stages.path)) : '';
  const aliases = loadHardAliases(installDir);
  const hard = resolveHardStage(raw, aliases);
  if (hard.stageId) {
    const out = { stageId: hard.stageId, from: hard.via };
    if (hard.verified === false) {
      out.note = `别名 ${hard.stageId} 是按规则推导的，没能在 ${aliases.source ?? 'Tile-Pos 目录'} 里校验（目录读不到）`;
    }
    return out;
  }
  const extra = hard.error ? `；${hard.error}` : '';
  return {
    stageId: null,
    error: `stages.json 里没有这个关卡代号: ${raw}，也没在 Arknights-Tile-Pos 文件名里找到${extra}（H 关写法示例：H12-2 或 hard_12-02）`,
  };
}

/** 显示代号（有就用 code，没有就 stageId；H 关反推成 H12-2 这种写法）。 */
export function displayCode(stages, stageId) {
  const entry = stages?.byId?.get(stageId);
  if (entry?.code) return entry.code;
  const m = /^hard_(\d{2})-(\d{2})$/.exec(String(stageId ?? ''));
  if (m) return `H${Number(m[1])}-${Number(m[2])}`;
  return stageId;
}
