/**
 * 后台任务 runner：抄作业（+ 中途可观测/可打断）以及账号切换等其它 MaaCore 任务。
 *
 * 为什么要后台模式（抄作业）：**危险窗口在战斗中途**——目标生命值掉了就必须立刻退出关卡
 * （结束前退出会返还全部理智；结算完再退就白花理智、还拿不满奖励）。
 * 阻塞式调用期间模型什么都做不了，只能等结算，等于放弃了这个窗口。
 * 所以：`background:true` 起跑 → 模型每隔 ~10s `maa_copilot_status` + `maa_screenshot` 看画面
 * → 发现掉血就 `maa_copilot_stop` 停掉 MAA 任务，再自己点「暂停 → 退出行动」。
 *
 * 账号切换也用同一套：切换/登录流程要能「随时取消」，后台跑 + status/stop 才做得到。
 *
 * 进程安全：每个后台 run 都是一个 MaaCore 子进程；插件卸载/重载时必须全部收掉（dispose）。
 */
import { runCopilot } from './copilot.js';

/** 内存里最多留几条已结束的记录（给 status 回看）。 */
const MAX_KEEP_FINISHED = 5;

export function createCopilotRunner({ log = () => {}, run = runCopilot } = {}) {
  /** @type {Map<string, object>} */
  const runs = new Map();
  let seq = 0;

  const newest = () => [...runs.values()].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

  const summary = (entry) => {
    if (!entry) return null;
    const now = Date.now();
    return {
      runId: entry.id,
      label: entry.label,
      state: entry.state, // starting | running | done | error
      taskId: entry.taskId ?? null,
      jobFile: entry.jobFile,
      startedAt: new Date(entry.startedAt).toISOString(),
      elapsedMs: (entry.finishedAt ?? now) - entry.startedAt,
      lastCallbackAt: entry.lastCallbackAt ? new Date(entry.lastCallbackAt).toISOString() : null,
      error: entry.error ?? null,
    };
  };

  /**
   * 起一条后台任务（不等待结束）。
   * @param {object} args
   * @param {string} args.label 给模型看的任务类型（copilot / account-switch / …）
   * @param {string|null} [args.jobFile] 抄作业时的作业文件（其它任务为 null）
   * @param {(hooks:{onEvent:Function,onReady:Function}) => Promise<any>} args.execute 真正跑任务的函数
   * @param {string|((id:string)=>string)} [args.hint]
   */
  const begin = ({ label = 'job', jobFile = null, execute, hint = '' } = {}) => {
    const id = `run-${++seq}`;
    const entry = {
      id,
      label,
      jobFile,
      startedAt: Date.now(),
      finishedAt: null,
      state: 'starting',
      taskId: null,
      ctl: null,
      result: null,
      error: null,
      lastCallbackAt: null,
    };
    runs.set(id, entry);

    entry.promise = (async () => {
      try {
        const r = await execute({
          onEvent: (ev) => {
            if (ev?.event === 'cb') entry.lastCallbackAt = Date.now();
          },
          onReady: (ctl) => {
            entry.ctl = ctl;
            entry.taskId = ctl?.taskId ?? null;
            entry.state = 'running';
            log('background run ready', JSON.stringify({ id, label: entry.label, taskId: entry.taskId }));
          },
        });
        entry.result = r;
        entry.state = 'done';
        entry.finishedAt = Date.now();
        if (!r?.ok) log('background run failed', JSON.stringify({ id, label: entry.label, status: r?.status ?? null }));
        return r;
      } catch (e) {
        entry.error = String(e?.message || e);
        entry.state = 'error';
        entry.finishedAt = Date.now();
        log('background run threw', entry.error);
        return null;
      } finally {
        const finished = [...runs.values()]
          .filter((x) => x.state === 'done' || x.state === 'error')
          .sort((a, b) => a.startedAt - b.startedAt);
        for (const x of finished.slice(0, Math.max(0, finished.length - MAX_KEEP_FINISHED))) runs.delete(x.id);
      }
    })();

    return {
      ok: true,
      runId: id,
      label,
      state: entry.state,
      jobFile: entry.jobFile,
      hint: typeof hint === 'function' ? hint(id) : hint,
    };
  };

  /**
   * 起一条抄作业（不等待结束）。
   * @returns {{ok:true, runId:string, state:string, jobFile:string, hint:string}}
   */
  const start = ({ jobFile, cfg, options = {} } = {}) => begin({
    label: 'copilot',
    jobFile,
    execute: (hooks) => run({ jobFile, cfg, ...options, ...hooks }),
    hint:
      '后台已起跑。之后每隔约 10 秒做一次：`maa_copilot_status({runId})` 看进度 + `maa_screenshot` 后 read_image 看画面。' +
      '重点看**目标生命值**：一旦掉血，立刻 `maa_copilot_stop({runId})`，再点「暂停 → 退出行动」把理智退回来。',
  });

  /**
   * 起一条通用后台任务（账号切换等）。execute 拿 {onEvent,onReady}，返回任务结果。
   * stop/status 与抄作业共用同一套工具：用 runId 指定即可。
   */
  const startJob = ({ label = 'job', run: execute, hint = '' } = {}) => begin({
    label,
    execute,
    hint:
      typeof hint === 'function'
        ? hint
        : (id) =>
            `后台任务已起跑（runId=${id}）。用 \`maa_copilot_status({runId:"${id}"})\` 看进度、\`maa_copilot_stop({runId:"${id}"})\` 随时取消；` +
            '中途用 maa_screenshot + read_image 看画面。',
  });

  /** 查一条（不给 runId 就查最近一条）。 */
  const status = (runId) => {
    const entry = runId ? runs.get(runId) : newest();
    if (!entry) {
      return {
        ok: false,
        error: runId
          ? `没有这个 runId: ${runId}`
          : '当前没有后台任务在跑（也没留下记录）；抄作业用 maa_copilot_run({background:true})、账号切换用 maa_account_switch({background:true}) 起一条',
      };
    }
    let progressTail = entry.result?.progress ?? null;
    if (!progressTail && entry.ctl?.progressLines) {
      try { progressTail = entry.ctl.progressLines() ?? null; } catch { progressTail = null; }
    }
    return {
      ok: true,
      ...summary(entry),
      finished: entry.state === 'done' || entry.state === 'error',
      result: entry.result,
      progressTail,
    };
  };

  /** 停掉正在跑的那条（AsstStopTask）。 */
  const stop = async (runId) => {
    const entry = runId ? runs.get(runId) : newest();
    if (!entry) return { ok: false, error: `没有这个 runId: ${runId ?? '(最近一条)'}` };
    if (entry.state !== 'running' && entry.state !== 'starting') {
      return { ok: false, error: `这条已经结束了（state=${entry.state}）`, run: summary(entry) };
    }
    const ctl = entry.ctl;
    if (!ctl?.stopTask) {
      return { ok: false, error: '任务还没进入可停止状态（还在连接/加载），等一两秒再试', run: summary(entry) };
    }
    try {
      await ctl.stopTask();
    } catch (e) {
      return { ok: false, error: `AsstStopTask 失败: ${e?.message || e}`, run: summary(entry) };
    }
    // 等 run 收尾（wait 会因 TaskChainStopped 返回），最多 10 秒
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (entry.state === 'running' || entry.state === 'starting')) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const isCopilot = entry.label === 'copilot';
    return {
      ok: true,
      stopped: true,
      run: summary(entry),
      hint: isCopilot
        ? 'MAA 任务已停（它不再注入触摸）。**游戏还在战斗里**：用 maa_screenshot 看画面 → 点「暂停」→ 点「退出行动」→ 确认；' +
          '结算前退出会返还全部理智。退出后再换作业重来。'
        : '后台任务已停（MaaCore 任务链停止）。用 maa_screenshot 看画面确认停在哪一屏，再决定下一步（别在登录/切换中途重复下发）。',
    };
  };

  /** 插件卸载/重载时把所有后台 run 收掉（子进程不能留给宿主）。 */
  const dispose = async () => {
    for (const entry of runs.values()) {
      try { if (entry.ctl?.stopTask) await entry.ctl.stopTask(); } catch { /* 已结束 */ }
      try { if (entry.ctl?.worker?.close) await entry.ctl.worker.close({ graceMs: 1000 }); } catch { /* 已退出 */ }
    }
    runs.clear();
  };

  return { start, startJob, status, stop, dispose, list: () => [...runs.values()].map(summary) };
}
