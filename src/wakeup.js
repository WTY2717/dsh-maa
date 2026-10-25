/**
 * 唤醒游戏到主界面：模拟器起来之后，用 MAA 的「开始唤醒」（`LinkStart-WakeUp`）代替人工点界面。
 *
 * 实测（2026-10-25，MAA v6.20.1 / MuMu12）：
 *  - `LinkStart-WakeUp` **可以单独下发**，不需要先跑整套「一键长草」（`LinkStart`）；
 *  - 模拟器刚启动（游戏还没开）时下发：任务 一次性 dispatched→done，约 60~110 秒游戏停在主界面；
 *  - 全程 0 理智消耗；`SUCCESS` 只代表任务链结束，是否真的在主界面要看截图。
 *
 * 为什么值得单独做：模拟器启动后如果让模型自己截图找「开始唤醒」按钮/点公告，
 * 既慢又容易点错；MAA 已经写了这套识别，直接复用。
 *
 * 本模块只做编排（不抛异常），截图能力由调用方注入，便于单测。
 */
import { ensureEmulator } from './emulator.js';

const POLL_CHUNK_MS = 15_000;

/**
 * @param {object} args
 * @param {object} args.cfg 已解析配置
 * @param {object} args.bridge 远程控制桥（必须有）
 * @param {number} [args.timeoutMs] 等唤醒完成的上限
 * @param {boolean} [args.skipEmulator] true = 不检查/不启动模拟器
 * @param {object} [args.deps] 单测注入 { ensureEmulator, capture, now }
 * @returns {Promise<object>} 永远 resolve
 */
export async function wakeupGame({ cfg, bridge, timeoutMs = 240_000, skipEmulator = false, deps = {} } = {}) {
  const ensure = deps.ensureEmulator ?? ensureEmulator;
  const capture = deps.capture ?? (async () => ({ via: 'none', ok: false, error: '未提供截图能力' }));
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const steps = [];

  if (!skipEmulator) {
    let emu;
    try {
      emu = await ensure({ cfg });
    } catch (e) {
      emu = { ok: false, error: String(e?.message || e) };
    }
    steps.push({
      step: 'emulator',
      ok: Boolean(emu?.ok),
      started: emu?.started ?? null,
      launched: emu?.launched ?? null,
      bootMs: emu?.bootMs ?? null,
      error: emu?.error ?? null,
    });
    if (!emu?.ok) return { ok: false, error: `模拟器起不来，先解决它：${emu?.error ?? '未知原因'}`, steps };
  }

  if (!bridge || typeof bridge.enqueue !== 'function') {
    return { ok: false, error: '远程控制桥不可用：MAA 没在跑或「远程控制」端点没配好（先 maa_doctor / maa_health）', steps };
  }

  let task;
  try {
    task = bridge.enqueue('LinkStart-WakeUp');
  } catch (e) {
    return { ok: false, error: `下发唤醒任务失败: ${e?.message || e}`, steps };
  }
  steps.push({ step: 'wakeup', taskId: task.id });

  const deadline = startedAt + timeoutMs;
  let r = task;
  for (;;) {
    const remain = deadline - now();
    const chunk = Math.min(POLL_CHUNK_MS, Math.max(1000, remain));
    r = await bridge.waitFor(task, chunk);
    if (r.state === 'done' || r.state === 'lost') break;
    if (now() >= deadline) break;
  }

  const shot = await capture({ cfg, bridge }).catch((e) => ({ via: 'none', ok: false, error: String(e?.message || e) }));
  const done = r.state === 'done';
  return {
    ok: done,
    wakeup: {
      taskId: task.id,
      state: r.state, // done | lost | dispatched（超时仍未结束）
      result: r.status ?? null, // SUCCESS / FAILED
      note: r.note ?? null,
      elapsedMs: now() - startedAt,
    },
    screenshot: shot,
    hint: done
      ? '唤醒任务链已结束：用 read_image 看 screenshot 确认停在主界面；不在主界面就 maa_screenshot 再看现场'
      : `唤醒没等到结束（state=${r.state}）：可以再调一次 maa_wakeup（会重新下发），或用 maa_wait 继续等这条`,
    steps,
  };
}
