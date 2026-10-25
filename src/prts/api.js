/**
 * 作业站（prts.plus）查询。实测契约：
 *   GET /copilot/query?page&limit(≤50)&desc=true&level_keyword=<stageId>
 *       → { status_code, data: { has_next, page, total, data: [ { id, views, content(只有元数据) } ] } }
 *   GET /copilot/get/{id} → data.content 是**字符串**，parse 后才是完整作业
 *
 * 列表接口的 content 里 actions 是空的，直接喂 MAA 会 CopilotFileReadError，
 * 所以必须再 get 一次拿全文（见 docs/tools/maa-copilot.md）。
 */
export const API_BASE = 'https://prts.maa.plus';
const UA = 'dsh-maa-plugin/1.0 (+https://prts.maa.plus)';

async function getJson(url, { timeoutMs = 20000, signal } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

/** 按 stageId 拉全部候选（最多 maxPages 页，每页 50）。 */
export async function queryJobs(stageId, { maxPages = 12, fetchJson = getJson } = {}) {
  const items = [];
  let total = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `${API_BASE}/copilot/query?page=${page}&limit=50&desc=true&level_keyword=${encodeURIComponent(stageId)}`;
    let json;
    try { json = await fetchJson(url); } catch (e) {
      if (page === 0) throw e;
      break;
    }
    const data = json?.data;
    if (!data || !Array.isArray(data.data)) break;
    if (total == null) total = data.total ?? null;
    items.push(...data.data);
    if (!data.has_next) break;
  }
  return { items, total, pages: Math.ceil(items.length / 50) };
}

/** 一条作业的全文（含 actions）。 */
export async function fetchJob(id, { fetchJson = getJson } = {}) {
  const json = await fetchJson(`${API_BASE}/copilot/get/${id}`);
  const content = json?.data?.content;
  if (content == null) throw new Error(`作业 ${id} 返回体里没有 data.content`);
  if (typeof content !== 'string') return content;
  try { return JSON.parse(content); } catch (e) { throw new Error(`作业 ${id} 的 content 不是合法 JSON: ${e.message}`); }
}
