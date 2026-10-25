/**
 * 练度容差匹配（口径由用户定，见 docs/tools/maa-copilot.md；不要自行放宽或收紧）。
 *
 *  **优先级（2026-10-25 用户补充）**：先找**完全达标**的作业；只有当所有候选都做不到完全达标时，
 *  才用容差口径放宽——放宽是兜底，不是默认。
 *
 *  1) 作业要求专精（skill_level > 7）→ 按 7 级技能代替，不再降；
 *  2) 精二要求 → 等级允许下浮 30，但不低于精二 60（精一要求不下浮）；
 *  3) 模组「一致或更高」→ 原样保留，交给 MAA 用游戏内真实数据校验；
 *  4) 练度不够 → 换作业，不提练度；导出表是唯一事实来源。
 */

/** 容差后的等级门槛。 */
export function toleranceLevel(req) {
  const level = req.level ?? 1;
  if ((req.elite ?? 0) >= 2) return Math.max(60, level - 30);
  return level;
}

/**
 * 把一条作业的 requirements 按容差口径放宽（原地改副本）。
 * @returns {{ applied:number, notes:string[] }}
 */
export function applyTolerance(job) {
  let applied = 0;
  const notes = [];
  for (const op of job.opers ?? []) {
    const req = { ...(op.requirements ?? {}) };
    if ((req.skill_level ?? 0) > 7) {
      notes.push(`${op.name}: 专精 ${req.skill_level} → 按 7 级技能`);
      req.skill_level = 7;
      applied++;
    }
    if ((req.elite ?? 0) >= 2 && (req.level ?? 0) > toleranceLevel(req)) {
      notes.push(`${op.name}: 精二 Lv${req.level} → Lv${toleranceLevel(req)}`);
      req.level = toleranceLevel(req);
      applied++;
    }
    op.requirements = req;
  }
  return { applied, notes };
}

/**
 * 单个干员是否满足要求。
 * @param {object} req 作业要求
 * @param {object} mine 导出表里的练度
 * @param {{relax?:boolean}} [opts] relax=false 时按**原要求**判断（完全达标），true 时按容差口径
 */
export function operMatches(req, mine, { relax = true } = {}) {
  if (!mine) return { ok: false, reason: '未拥有' };
  if (!req || req.elite == null || req.level == null) return { ok: false, reason: '作业缺 requirements（老版本作业）' };
  if ((mine.elite ?? 0) < req.elite) return { ok: false, reason: `精英化 ${mine.elite} < ${req.elite}` };
  const need = relax ? toleranceLevel(req) : (req.level ?? 1);
  if ((mine.level ?? 0) < need) {
    return { ok: false, reason: relax ? `等级 ${mine.level} < ${need}（容差后）` : `等级 ${mine.level} < ${need}（原要求）` };
  }
  const needPot = req.potentiality ?? 0;
  if (needPot > (mine.potential ?? 0)) return { ok: false, reason: `潜能 ${mine.potential} < ${needPot}` };
  return { ok: true };
}

/**
 * 一条作业面对本号练度是否可抄。
 * @param {object} job 作业全文
 * @param {Map<string, object>} roster 已拥有干员（名字 → 练度）
 * @param {{relax?:boolean}} [opts] relax=false = 完全达标（原要求）
 * @returns {{ ok:boolean, reason?:string, opers:Array<{name:string,ok:boolean,reason?:string}> }}
 */
export function jobMatches(job, roster, { relax = true } = {}) {
  const opers = job.opers ?? [];
  if (!opers.length) return { ok: false, reason: '作业没有干员要求（actions 可能是元数据）', opers: [] };
  const detail = [];
  for (const op of opers) {
    const r = operMatches(op.requirements, roster.get(op.name), { relax });
    detail.push({ name: op.name, ...r });
    if (!r.ok) return { ok: false, reason: `${op.name}: ${r.reason}`, opers: detail };
  }
  return { ok: true, opers: detail };
}

/** 打印用的一行干员摘要。 */
export function summarizeOpers(job) {
  return (job.opers ?? [])
    .map((o) => {
      const r = o.requirements ?? {};
      const skill = r.skill_level ? `/S${r.skill_level}` : '';
      return `${o.name} E${r.elite ?? '?'}L${r.level ?? '?'}${skill}`;
    })
    .join(' | ');
}
