/**
 * 关卡代号 ↔ 内部 stageId 的反查（数据来自 `<MAA>\resource\stages.json`）。
 *
 * 实测：作业站的 `level_keyword` 只认内部 stageId（`main_01-07`、`pro_d_2`），
 * 不认显示代号（`1-7`、`PR-D-2`）；返回体里的 `stage_name` 也是 stageId。
 */
import fs from 'node:fs';
import path from 'node:path';

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

/** 用户输入（`1-7` / `PR-D-2` / `main_01-07`）→ 内部 stageId。 */
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
  return { stageId: null, error: `stages.json 里没有这个关卡代号: ${raw}` };
}

/** 显示代号（有就用 code，没有就 stageId），用于回显。 */
export function displayCode(stages, stageId) {
  const entry = stages?.byId?.get(stageId);
  return entry?.code || stageId;
}
