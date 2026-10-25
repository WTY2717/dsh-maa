/**
 * 后端 A：`adb shell input`（实测可用，MAA 插件默认滑动通道）。
 *
 * 关键结论（2026-10-25 本机 MuMu 实测）：
 *   - `input swipe` **能拖动**这个 Unity 游戏的地图/列表；旧文档说「无效」是坐标错误（详见 ./coords.js）。
 *   - `input swipe` 是单进程、内部按 duration 线性插值（约 200 次/秒 MOVE），**手势最平滑**，默认走它。
 *   - `input motionevent DOWN/MOVE/UP` 受支持（Android 12），但每次注入都要起一个 adb 进程，
 *     只用于需要「按下先停住」的长按拖动（holdMs > 0）；异常时 finally 一定补一个 UP，避免指针卡住。
 *
 * 本文件只做「探测显示尺寸」和「注入一次手势」，参数校验/互斥/截图在 ./index.js。
 */
import { adbRun } from '../adb.js';
import { gameToDevice, validateGamePoint, viewFromProbe, clampDevice } from './coords.js';

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `adb shell wm size` 与 `dumpsys input` 的输出拿逻辑显示尺寸。结果按 adb+address 缓存 30 秒。 */
const displayCache = new Map();
const DISPLAY_TTL_MS = 30_000;

export function clearDisplayCache() {
  displayCache.clear();
}

/**
 * 探测当前逻辑显示尺寸（换算的基准）。
 * @returns {Promise<{ok:true, view:{width:number,height:number}, source:string, physical?:object, rotation?:number}|{ok:false, error:string}>}
 */
export async function probeDisplay({ adbPath, address, deps = {}, force = false } = {}) {
  const run = deps.run ?? adbRun;
  if (!adbPath) return { ok: false, error: '未定位到 adb（先 maa_doctor 看 adb 段）' };
  const key = `${adbPath}|${address ?? ''}`;
  const hit = displayCache.get(key);
  if (!force && hit && Date.now() - hit.at < DISPLAY_TTL_MS) return hit.value;

  const base = address ? ['-s', address] : [];
  const wm = await run(adbPath, [...base, 'shell', 'wm', 'size'], { timeoutMs: 15000 });
  if (!wm.ok) {
    return { ok: false, error: `adb shell wm size 失败：${wm.error || wm.stderr || '未知原因'}（设备掉线或地址不对）` };
  }
  const input = await run(adbPath, [...base, 'shell', 'dumpsys', 'input'], { timeoutMs: 20000 });
  const merged = viewFromProbe({ wmText: wm.stdout ?? '', inputText: input.ok ? (input.stdout ?? '') : '' });
  if (!merged.ok) {
    return { ok: false, error: merged.error, physical: merged.physical ?? null };
  }
  const value = { ok: true, view: merged.view, source: merged.source };
  displayCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * 注入一次滑动手势。
 * @param {object} args
 * @param {string} args.adbPath
 * @param {string} [args.address]
 * @param {{x:number,y:number}} args.from 1280×720 系
 * @param {{x:number,y:number}} args.to   1280×720 系
 * @param {{width:number,height:number}} args.view 逻辑显示尺寸
 * @param {number} args.durationMs 按下→抬起总时长
 * @param {number} [args.steps] 仅在 motionevent 模式下生效（MOVE 次数）
 * @param {number} [args.holdMs] >0 时改用 motionevent（按下后先停）
 * @param {object} [args.deps] 单测注入 { run, sleep }
 */
export async function swipeAdbInput({
  adbPath,
  address,
  from,
  to,
  view,
  durationMs = 200,
  steps = 8,
  holdMs = 0,
  deps = {},
} = {}) {
  const run = deps.run ?? adbRun;
  const sleep = deps.sleep ?? realSleep;
  if (!adbPath) return { ok: false, error: '未定位到 adb' };

  const base = address ? ['-s', address] : [];
  let p1;
  let p2;
  try {
    p1 = clampDevice(gameToDevice(from, view), view);
    p2 = clampDevice(gameToDevice(to, view), view);
  } catch (e) {
    return { ok: false, error: `坐标换算失败: ${e.message}` };
  }
  const device = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };

  if (holdMs > 0) {
    return motioneventGesture({ run, sleep, base, adbPath, p1, p2, durationMs, steps, holdMs, device });
  }

  const r = await run(
    adbPath,
    [...base, 'shell', 'input', 'swipe', String(p1.x), String(p1.y), String(p2.x), String(p2.y), String(Math.round(durationMs))],
    { timeoutMs: Math.max(15000, Math.round(durationMs) + 10000) },
  );
  return {
    ok: r.ok,
    via: 'input swipe',
    device,
    durationMs: Math.round(durationMs),
    error: r.ok ? null : `adb input swipe 失败：${(r.stderr || r.error || '').trim() || '未知原因'}`,
  };
}

/**
 * 按下后停顿再拖动：只能靠多次 `input motionevent` 拼（每次一个 adb 进程，慢但可控）。
 * finally 里补 UP —— 否则指针停在按下状态，后续所有点击都会变成拖拽。
 */
async function motioneventGesture({ run, sleep, base, adbPath, p1, p2, durationMs, steps, holdMs, device }) {
  const inject = (action, x, y) => run(
    adbPath,
    [...base, 'shell', 'input', 'motionevent', action, String(x), String(y)],
    { timeoutMs: 12000 },
  );
  const n = Math.max(2, Math.min(60, Math.round(steps)));
  const stepSleep = Math.max(0, Math.round(durationMs / n));
  const trail = [];
  const down = await inject('DOWN', p1.x, p1.y);
  if (!down.ok) {
    return {
      ok: false,
      via: 'input motionevent',
      device,
      durationMs: Math.round(durationMs),
      error: `motionevent DOWN 失败：${(down.stderr || down.error || '').trim() || '未知原因'}`,
    };
  }
  let error = null;
  try {
    if (holdMs > 0) await sleep(Math.round(holdMs));
    for (let i = 1; i <= n; i += 1) {
      const t = i / n;
      const x = Math.round(p1.x + (p2.x - p1.x) * t);
      const y = Math.round(p1.y + (p2.y - p1.y) * t);
      const mv = await inject('MOVE', x, y);
      trail.push({ x, y, ok: mv.ok });
      if (!mv.ok) { error = `motionevent MOVE 失败：${(mv.stderr || mv.error || '').trim() || '未知原因'}`; break; }
      if (stepSleep > 0 && i < n) await sleep(stepSleep);
    }
  } finally {
    // 无论中间怎么失败，都必须抬起
    await inject('UP', p2.x, p2.y);
  }
  return {
    ok: !error,
    via: 'input motionevent',
    device,
    durationMs: Math.round(durationMs),
    steps: n,
    holdMs: Math.round(holdMs),
    moves: trail.length,
    error,
  };
}

export { validateGamePoint };
