/**
 * MaaCore 回调语义表（数据表，可覆盖；未知 id 一律忽略，不抛错）。
 *
 * 判语义只看 `details.what`，id 只作为辅助信息——MAA 不同版本会改 id 归属，
 * 但 `what` 字符串是任务名派生的，跨版本稳定得多。
 * v6.20.1 实测见 docs/plans/maa-plugin-plan.md 4.2。
 */
export const CALLBACK_IDS = new Map([
  [1, 'InternalError'],
  [2, 'ConnectionInfo'],
  [3, 'AllTasksCompleted'],
  [4, 'ConnectionOrClick'],
  [10000, 'TaskChainError'],
  [10001, 'TaskChainStart'],
  [10002, 'TaskChainCompleted'],
  [10003, 'TaskChainExtraInfo'],
  [10004, 'TaskChainStopped'],
  [20000, 'SubTaskError'],
  [20001, 'SubTaskStart'],
  [20002, 'SubTaskCompleted'],
  [20003, 'SubTaskExtraInfo'],
  [20004, 'SubTaskStopped'],
]);

/** 失败类回调 id：出现任意一个即判失败（早先只认 1 会把失败任务链报成成功）。 */
const FAILURE_IDS = new Set([1, 10000, 20000]);

/** `what` → 语义。只有这里列出的才有程序含义，其它一律当信息。 */
const WHAT = {
  Connected: 'connected',
  ConnectFailed: 'connect-failed',
  AllTasksCompleted: 'chain-done',
  TaskChainStopped: 'chain-stopped',
  TaskChainError: 'chain-error',
  TaskChainCompleted: 'chain-completed',
  CopilotListLoadTaskFileSuccess: 'copilot-loaded',
  CopilotListLoadTaskFileFailed: 'copilot-load-failed',
  BattleFormationOperUnavailable: 'formation-unavailable',
  BattleFormationSelected: 'formation-selected',
  BattleFormationCompleted: 'formation-done',
  StageDrops: 'drops',
};

/**
 * 归一化一条回调。
 * @param {number} msg 回调 id
 * @param {string} details JSON 字符串
 * @returns {{ id:number, name:string|null, what:string, semantic:string|null, details:object, text:string, failure:boolean }}
 */
export function classify(msg, details) {
  let parsed = {};
  if (details) {
    try { parsed = JSON.parse(details); } catch { parsed = { raw: details }; }
  }
  const what = parsed?.what || parsed?.taskchain || '';
  return {
    id: msg,
    name: CALLBACK_IDS.get(msg) ?? null,
    what,
    semantic: WHAT[what] ?? null,
    details: parsed,
    text: details || '',
    failure: FAILURE_IDS.has(msg) || what === 'ConnectFailed' || what === 'TaskChainError',
  };
}

/** 一行人类可读的摘要（用于工具输出的 progress 数组）。 */
export function summarize(c) {
  const tail = c.what || c.name || String(c.id);
  const parts = [`[${c.id}${c.name ? ' ' + c.name : ''}] ${tail}`];
  for (const key of ['taskchain', 'taskid', 'oper_name', 'requirement_type', 'stage']) {
    const v = c.details?.[key];
    if (v != null && v !== '') parts.push(`${key}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return parts.join(' ');
}
