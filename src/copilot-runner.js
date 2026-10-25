/**
 * 后台跑作业（+ 中途可观测/可打断）。
 *
 * 为什么要后台模式：抄作业的**危险窗口在战斗中途**——目标生命值掉了就必须立刻退出关卡
 * （结束前退出会返还全部理智；结算完再退就白花理智、还拿不满奖励）。
 * 阻塞式调用期间模型什么都做不了，只能等结算，等于放弃了这个窗口。
 * 所以：`background:true` 起跑 → 模型每隔 ~10s `maa_copilot_status` + `maa_screenshot` 看画面
 * → 发现掉血就 `maa_copilot_stop` 停掉 MAA 任务，再自己点「暂停 → 退出行动」。
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
   * 起跑（不等待结束）。
   * @returns {{ok:true, runId:string, state:string, jobFile:string, hint:string}}
   */
  const start = ({ jobFile, cfg, options = {} } = {}) => {
    const id = `run-${++seq}`;
    const entry = {
      id,
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
        const r = await run({
          jobFile,
          cfg,
          ...options,
          onEvent: (ev) => {
            if (ev?.event === 'cb') entry.lastCallbackAt = Date.now();
          },
          onReady: (ctl) => {
            entry.ctl = ctl;
            entry.taskId = ctl.taskId ?? null;
            entry.state = 'running';
            log('copilot background run ready', JSON.stringify({ id, taskId: entry.taskId }));
          },
        });
        entry.result = r;
        entry.state = 'done';
        entry.finishedAt = Date.now();
        if (!r?.ok) log('copilot background run failed', JSON.stringify({ id, status: r?.status ?? null }));
        return r;
      } catch (e) {
        entry.error = String(e?.message || e);
        entry.state = 'error';
        entry.finishedAt = Date.now();
        log('copilot background run threw', entry.error);
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
      state: entry.state,
      jobFile,
      hint:
        '后台已起跑。之后每隔约 10 秒做一次：`maa_copilot_status({runId})` 看进度 + `maa_screenshot` 后 read_image 看画面。' +
        '重点看**目标生命值**：一旦掉血，立刻 `maa_copilot_stop({runId})`，再点「暂停 → 退出行动」把理智退回来。',
    };
  };

  /** 查一条（不给 runId 就查最近一条）。 */
  const status = (runId) => {
    const entry = runId ? runs.get(runId) : newest();
    if (!entry) {
      return {
        ok: false,
        error: runId ? `没有这个 runId: ${runId}` : '当前没有作业在跑（也没留下记录）；用 maa_copilot_run({background:true}) 起一条',
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

  /** 停掉正在跑的那条（AsstStopTask）。停在「游戏还在战斗」是正常的：退出关卡要模型自己点。 */
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
    return {
      ok: true,
      stopped: true,
      run: summary(entry),
      hint:
        'MAA 任务已停（它不再注入触摸）。**游戏还在战斗里**：用 maa_screenshot 看画面 → 点「暂停」→ 点「退出行动」→ 确认；' +
        '结算前退出会返还全部理智。退出后再换作业重来。',
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

  return { start, status, stop, dispose, list: () => [...runs.values()].map(summary) };
}
