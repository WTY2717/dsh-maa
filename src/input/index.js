/**
 * `maa_swipe` 的统一入口：参数校验 → 与 MAA 任务互斥 → 选后端 → 注入手势 → 落一张验收截图。
 *
 * 为什么这个能力非有不可：Copilot 只负责打，**不负责导航**（它要求游戏已经停在目标关卡的详情页）。
 * 像「主题曲 → 第十二章 → 磨难险地 → 关卡列表最右端 → H12-2」这种必须滑动才能到的关卡，
 * 没有滑动手势就永远到不了，`maa_copilot_run` 也就永远起不来。
 *
 * 安全口径（写进工具描述，不是可选建议）：
 *  1. 滑动本身不消耗理智，但**起点/终点若压在按钮上，按下就会触发**（开始行动/使用源石/抽卡）
 *     ⇒ 空白区域由调用方保证，本模块只负责按给定坐标滑动。
 *  2. MAA 正在跑任务时拒绝：两路触摸同时注入会点飞。
 *  3. 验收只看截图（同 Copilot 口径），不看 ok。
 */
import path from 'node:path';
import { resolveAdbPath, screencap } from '../adb.js';
import { detectInputBackend } from './backend.js';
import { swipeAdbInput, typeTextAdbInput, validateTypeText } from './adb-input.js';
import { validateGamePoint } from './coords.js';

const DEFAULTS = { durationMs: 200, steps: 8, holdMs: 0, settleMs: 400 };
const LIMITS = {
  durationMs: [50, 3000],
  steps: [2, 60],
  holdMs: [0, 3000],
  settleMs: [0, 5000],
};

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 数值参数：缺省用默认值，给了就必须是范围内的有限数（不静默钳制）。 */
function numberParam(value, key) {
  if (value === undefined || value === null) return { ok: true, value: DEFAULTS[key] };
  const n = Number(value);
  const [min, max] = LIMITS[key];
  if (!Number.isFinite(n) || n < min || n > max) {
    return { ok: false, error: `${key}=${JSON.stringify(value)} 非法（要求 ${min} ~ ${max} 的数字）` };
  }
  return { ok: true, value: Math.round(n) };
}

/**
 * 看 MAA 现在忙不忙（只读，不额外发心跳，避免每次滑动都多等一轮 MAA 轮询）。
 * 拿不到桥状态就返回 known:false —— 那时 MAA 没在跑，滑是安全的。
 */
export function maaBusy(bridge) {
  if (!bridge || typeof bridge.health !== 'function') return { known: false };
  let health;
  try { health = bridge.health(); } catch { return { known: false }; }
  let tasks = [];
  try { tasks = typeof bridge.list === 'function' ? bridge.list(40) ?? [] : []; } catch { tasks = []; }
  const pending = tasks.filter((t) => t && (t.state === 'queued' || t.state === 'dispatched'));
  const running = tasks
    .filter((t) => t && t.type === 'HeartBeat' && t.state === 'done' && t.note && Number(t.ageMs) < 25_000)
    .map((t) => String(t.note));
  return {
    known: true,
    online: Boolean(health.online),
    pending: pending.length,
    pendingTypes: pending.map((t) => t.type),
    running,
  };
}

/** 抬起 + settle 之后截一张图：桥在线时用 MAA（1280×720，和工具坐标同一套），否则退回 adb。 */
async function capture({ cfg, bridge, adbPath, settleMs, deps }) {
  const sleep = deps.sleep ?? realSleep;
  if (settleMs > 0) await sleep(settleMs);
  let online = false;
  try { online = Boolean(bridge?.health?.().online); } catch { online = false; }
  if (online) {
    try {
      const task = bridge.enqueue('CaptureImageNow');
      const r = await bridge.waitFor(task, Math.max(6000, settleMs + 8000));
      if (r?.state === 'done' && r.file) {
        return { via: 'maa', file: r.file, bytes: r.payloadLen ?? null, size: '1280x720' };
      }
    } catch { /* 桥抽风就退回 adb，截图失败不该让滑动本身判失败 */ }
  }
  const resolved = adbPath ? { ok: true, path: adbPath } : resolveAdbPath({ configured: cfg.adbPath, hintPath: cfg.maaHint?.adbPath });
  if (!resolved.ok) return { via: 'none', ok: false, error: '截图失败：没有 adb，且 MAA 桥不在线' };
  const shot = await screencap({
    adbPath: resolved.path,
    address: cfg.adbAddress,
    outFile: path.join(cfg.shotsDir, `swipe-${Date.now()}.png`),
  });
  if (!shot.ok) return { via: 'adb', ok: false, error: `截图失败：${shot.error}` };
  return {
    via: 'adb',
    file: shot.file,
    bytes: shot.bytes,
    size: '设备分辨率',
    note: 'adb 截图是设备分辨率（本机 1920×1080）；本工具坐标是 1280×720，看图时按 ×1.5 换算',
  };
}

/**
 * 滑一次。
 * @param {object} args
 * @param {object} args.cfg 已解析配置
 * @param {object|null} [args.bridge] 远程控制桥（用于互斥与截图，可空）
 * @param {{x:number,y:number}} args.from
 * @param {{x:number,y:number}} args.to
 * @param {number} [args.durationMs]
 * @param {number} [args.steps]
 * @param {number} [args.holdMs]
 * @param {number} [args.settleMs]
 * @param {string} [args.backend]
 * @param {object} [args.deps] 单测注入 { run, sleep, detectInputBackend }
 */
export async function swipe({ cfg, bridge = null, from, to, durationMs, steps, holdMs, settleMs, backend = 'auto', deps = {} } = {}) {
  const startedAt = Date.now();
  const sleep = deps.sleep ?? realSleep;

  const a = validateGamePoint(from, 'from');
  if (!a.ok) return { ok: false, error: a.error };
  const b = validateGamePoint(to, 'to');
  if (!b.ok) return { ok: false, error: b.error };
  const p1 = a.value;
  const p2 = b.value;
  if (p1.x === p2.x && p1.y === p2.y) return { ok: false, error: 'from 和 to 是同一个点：这不是滑动，要点击请用 maa_click' };

  const params = {};
  for (const key of ['durationMs', 'steps', 'holdMs', 'settleMs']) {
    const r = numberParam({ durationMs, steps, holdMs, settleMs }[key], key);
    if (!r.ok) return { ok: false, error: r.error };
    params[key] = r.value;
  }

  const busy = maaBusy(bridge);
  if (busy.known && (busy.pending > 0 || busy.running.length > 0)) {
    const what = busy.running.length ? busy.running.join(', ') : busy.pendingTypes.join(', ');
    return {
      ok: false,
      error: `MAA 正在跑任务（${what}），此时滑动会和它的触摸注入打架：先 maa_stop 或等它跑完，再滑`,
      maa: busy,
    };
  }

  const detect = deps.detectInputBackend ?? detectInputBackend;
  const detected = await detect({ cfg, force: backend, deps });
  if (!detected.ok) return { ok: false, error: detected.error, backend: detected.backend ?? null, maa: busy, requestedBackend: backend };

  const scrolled = params.holdMs > 0 ? 'motionevent' : 'swipe';
  const gesture = await swipeAdbInput({
    adbPath: detected.adb.path,
    address: detected.adb.address,
    from: p1,
    to: p2,
    view: detected.view,
    durationMs: params.durationMs,
    steps: params.steps,
    holdMs: params.holdMs,
    deps,
  });

  const shot = await capture({ cfg, bridge, adbPath: detected.adb.path, settleMs: params.settleMs, deps });

  const result = {
    ok: Boolean(gesture.ok),
    backend: detected.backend,
    mode: scrolled,
    from: p1,
    to: p2,
    view: detected.view,
    device: gesture.device ?? null,
    durationMs: params.durationMs,
    steps: params.steps,
    holdMs: params.holdMs,
    settleMs: params.settleMs,
    maa: busy,
    screenshot: shot,
    elapsedMs: Date.now() - startedAt,
  };
  if (!gesture.ok) result.error = gesture.error;
  else if (shot.via === 'none') result.note = '手势已注入，但没截到图：滑动本身是否生效要用别的办法确认（maa_screenshot）';
  return result;
}

/**
 * 往**当前已聚焦**的输入框打字（登录用：手机号 / 验证码）。
 *
 * 口径与滑动一致：MAA 跑任务时拒绝（两路触摸会打架）；打完截图验收（ok 只代表 adb 注入成功，
 * 有没有真的进框里要看截图）。点位聚焦由调用方先 maa_click。
 */
export async function typeText({ cfg, bridge = null, text, enter = false, settleMs = 400, deps = {} } = {}) {
  const startedAt = Date.now();
  const v = validateTypeText(text);
  if (!v.ok) return { ok: false, error: v.error };

  const busy = maaBusy(bridge);
  if (busy.known && ((busy.pending ?? 0) > 0 || (busy.running ?? []).length > 0)) {
    const what = busy.running.length ? busy.running.join(', ') : busy.pendingTypes.join(', ');
    return {
      ok: false,
      error: `MAA 正在跑任务（${what}），此时注入键盘会和它的触摸/点击打架：先 maa_stop 或等它跑完，再输入`,
      maa: busy,
    };
  }

  const resolve = deps.resolveAdbPath ?? resolveAdbPath;
  const resolved = resolve({ configured: cfg.adbPath, hintPath: cfg.maaHint?.adbPath });
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const typed = await typeTextAdbInput({
    adbPath: resolved.path,
    address: cfg.adbAddress,
    text: v.text,
    enter: Boolean(enter),
    deps,
  });
  const shot = await capture({ cfg, bridge, adbPath: resolved.path, settleMs, deps });

  const result = {
    ok: Boolean(typed.ok),
    backend: 'adb-input',
    chars: v.text.length,
    entered: Boolean(enter),
    maa: busy,
    screenshot: shot,
    elapsedMs: Date.now() - startedAt,
  };
  if (!typed.ok) result.error = typed.error;
  else if (shot.via === 'none') result.note = '文字已注入，但没截到图：用 maa_screenshot 确认是否真的进了输入框';
  return result;
}

export { DEFAULTS as SWIPE_DEFAULTS, LIMITS as SWIPE_LIMITS };
