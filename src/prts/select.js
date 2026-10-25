/**
 * 从作业站候选里挑「本号能抄」的作业：**先找完全达标的，实在没有才用容差放宽**。
 *
 * 为什么不是一上来就放宽（2026-10-25 用户口径调整）：
 * 作业站同一关常有几十条作业，练度要求差别很大。默认按容差匹配会把「要求精二 90」的作业
 * 当成可抄，实际打起来可能翻车；而站里往往存在「要求精二 60」的作业能完全达标。
 * 所以顺序是：严格匹配（原要求）→ 一条都没有时，才按 `match.js` 的容差口径放宽，
 * 并在结果里标出 `matchMode:'relaxed'` 与每条作业的 `strictReason`（差在哪）。
 *
 * 本文件只做纯计算（无网络、无文件），便于单测；网络与落盘在 copilot.js。
 */
import { jobMatches } from './match.js';

/** 拒绝原因归类（与旧版 scanned.rejected 的键保持一致，文档里的读法不作废）。 */
export function classifyReject(reason) {
  const r = String(reason ?? '');
  if (/未拥有/.test(r)) return 'notOwned';
  if (/requirements|干员要求/.test(r)) return 'noRequirements';
  return 'notEnough';
}

const emptyRejected = () => ({ notOwned: 0, notEnough: 0, noRequirements: 0 });

/**
 * 扫一遍候选，返回挑选结果。
 * @param {object} args
 * @param {Array<{id:number,views?:number,content?:string|object}>} args.items 作业站 /copilot/query 的 data.data
 * @param {Map<string, object>} args.rosterByName 已拥有干员
 * @param {string} args.stageId 内部 stageId（如 hard_12-02）
 * @param {string} [args.stage] 用户原始输入（用于 stage_name 兜底比对）
 * @param {number} [args.limit] 最多返回几条
 * @returns {{
 *   mode:'strict'|'relaxed'|'none',
 *   picked:Array<{id:number,views:number,title:string,strictReason?:string}>,
 *   scanned:{candidates:number,sameStage:number,strictPass:number,relaxedOnlyPass:number,rejected:object}
 * }}
 */
export function scanCandidates({ items = [], rosterByName, stageId, stage, limit = Number.POSITIVE_INFINITY } = {}) {
  const seen = new Set();
  let sameStage = 0;
  const strict = [];
  const relaxedOnly = [];
  const strictRejected = emptyRejected();
  const relaxedRejected = emptyRejected();

  for (const item of items) {
    if (!item || (item.id != null && seen.has(item.id))) continue;
    if (item.id != null) seen.add(item.id);
    let job;
    try {
      job = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
    } catch {
      continue; // 列表里 occasional 坏 JSON：直接跳过
    }
    if (!job) continue;
    // 作业站偶尔把别的关混进 level_keyword 结果里（老文档记的 43677 条就是这个坑）
    if (job.stage_name && job.stage_name !== stageId && job.stage_name !== stage) continue;
    sameStage += 1;

    const row = { id: item.id, views: item.views ?? 0, title: job?.doc?.title ?? '' };
    const strictRes = jobMatches(job, rosterByName, { relax: false });
    if (strictRes.ok) {
      strict.push(row);
      continue;
    }
    strictRejected[classifyReject(strictRes.reason)] += 1;

    const relaxedRes = jobMatches(job, rosterByName, { relax: true });
    if (relaxedRes.ok) relaxedOnly.push({ ...row, strictReason: strictRes.reason ?? null });
    else relaxedRejected[classifyReject(relaxedRes.reason)] += 1;
  }

  const byViews = (a, b) => b.views - a.views;
  let mode = 'none';
  let chosen = [];
  let rejected = relaxedRejected;
  if (strict.length) {
    mode = 'strict';
    chosen = [...strict].sort(byViews);
    rejected = strictRejected;
  } else if (relaxedOnly.length) {
    mode = 'relaxed';
    chosen = [...relaxedOnly].sort(byViews);
    rejected = relaxedRejected;
  }

  return {
    mode,
    picked: chosen.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : chosen.length),
    scanned: {
      candidates: items.length,
      sameStage,
      strictPass: strict.length,
      relaxedOnlyPass: relaxedOnly.length,
      rejected,
    },
  };
}
