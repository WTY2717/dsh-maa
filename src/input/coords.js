/**
 * 1280×720 游戏坐标 ↔ 设备坐标的换算（纯函数，便于单测）。
 *
 * 为什么需要这一层：`maa_click` / `maa_swipe` 的坐标约定是 **MAA 的逻辑分辨率 1280×720**
 * （MAA 截图也是这个尺寸），而 `adb shell input` 吃的是**当前旋转后的显示坐标**
 * （本机 MuMu：逻辑 1920×1080 ⇒ 换算系数 1.5）。拿 1280 系的坐标直接喂 adb，
 * 落点会偏移到别处 —— 这正是早期「adb input 对这个 Unity 游戏无效」那个错误结论的真正原因
 * （2026-10-25 复测：换成设备坐标后 input swipe 立刻能拖动地图）。
 *
 * 换算只做纯计算，不碰 adb；探测命令在 ./adb-input.js。
 */

/** 工具坐标系的宽高（与 maa_click / MAA 截图一致）。 */
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

/**
 * 校验 1280×720 系坐标。
 * 越界直接报错，**不静默钳制**：钳制会把换算 bug 藏起来，表现为「滑了但没动」。
 * @returns {{ok:true, value:{x:number,y:number}}|{ok:false, error:string}}
 */
export function validateGamePoint(point, label = 'point') {
  if (!point || typeof point !== 'object' || Array.isArray(point)) {
    return { ok: false, error: `${label} 必须是 {x, y} 对象` };
  }
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: `${label}.x/.y 必须是数字（收到 ${JSON.stringify(point)}）` };
  }
  if (x < 0 || x >= GAME_WIDTH) return { ok: false, error: `${label}.x=${x} 越界（要求 0 ≤ x < ${GAME_WIDTH}）` };
  if (y < 0 || y >= GAME_HEIGHT) return { ok: false, error: `${label}.y=${y} 越界（要求 0 ≤ y < ${GAME_HEIGHT}）` };
  return { ok: true, value: { x: Math.round(x), y: Math.round(y) } };
}

/** 逻辑显示是否横向（宽 ≥ 高）。 */
export function isLandscape(view) {
  return Number(view?.width) >= Number(view?.height);
}

/**
 * 游戏坐标 → 设备坐标。
 * @param {{x:number,y:number}} point 1280×720 系
 * @param {{width:number,height:number}} view 当前**逻辑**显示尺寸（如 1920×1080）
 * @returns {{x:number,y:number,scaleX:number,scaleY:number,swapped:boolean}}
 */
export function gameToDevice(point, view) {
  const w = Number(view?.width);
  const h = Number(view?.height);
  if (!(w > 0) || !(h > 0)) throw new Error(`显示尺寸非法: ${JSON.stringify(view)}`);
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`坐标非法: ${JSON.stringify(point)}`);

  if (isLandscape({ width: w, height: h })) {
    // 横向逻辑显示：游戏横轴 = 显示横轴，直接按比例缩放
    const scaleX = w / GAME_WIDTH;
    const scaleY = h / GAME_HEIGHT;
    return { x: Math.round(x * scaleX), y: Math.round(y * scaleY), scaleX, scaleY, swapped: false };
  }
  // 竖向逻辑显示（横屏游戏跑在竖屏 logical 坐标系上）：游戏 x 沿长边、y 沿短边
  const scaleX = w / GAME_HEIGHT;
  const scaleY = h / GAME_WIDTH;
  return { x: Math.round(y * scaleX), y: Math.round(x * scaleY), scaleX, scaleY, swapped: true };
}

/** 把设备坐标钳进显示范围（只在浮点/取整溢出时生效，不是给越界输入兜底）。 */
export function clampDevice(point, view) {
  const maxX = Number(view?.width) - 1;
  const maxY = Number(view?.height) - 1;
  return {
    x: Math.min(Math.max(0, Math.round(point.x)), Number.isFinite(maxX) && maxX > 0 ? maxX : point.x),
    y: Math.min(Math.max(0, Math.round(point.y)), Number.isFinite(maxY) && maxY > 0 ? maxY : point.y),
  };
}

/* ────────────────────── adb 输出解析 ────────────────────── */

/**
 * `adb shell wm size` → { width, height, override }。
 * Override size 优先（用户手动改过分辨率时 Physical 不是真实值）。
 */
export function parseWmSize(text) {
  const s = String(text ?? '');
  const override = /Override size:\s*(\d+)x(\d+)/i.exec(s);
  const physical = /Physical size:\s*(\d+)x(\d+)/i.exec(s);
  const hit = override ?? physical;
  if (!hit) return null;
  return { width: Number(hit[1]), height: Number(hit[2]), override: Boolean(override) };
}

/** `dumpsys input` → SurfaceOrientation（0/1/2/3 = 0°/90°/180°/270°）。 */
export function parseSurfaceOrientation(text) {
  const m = /SurfaceOrientation:\s*(\d)/i.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 3 ? n : null;
}

/** `dumpsys input` 里的逻辑视口 `logicalFrame=[0, 0, 1920, 1080]`（最权威）。 */
export function parseLogicalFrame(text) {
  const m = /logicalFrame=\[\s*-?\d+,\s*-?\d+,\s*(\d+),\s*(\d+)\s*\]/i.exec(String(text ?? ''));
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

/** 物理尺寸 + 旋转 → 逻辑尺寸（旋转 90°/270° 时宽高互换）。 */
export function logicalFromPhysical(physical, rotation) {
  if (!physical) return null;
  const r = Number(rotation);
  const swap = r === 1 || r === 3;
  return swap
    ? { width: physical.height, height: physical.width }
    : { width: physical.width, height: physical.height };
}

/**
 * 合并探测结果：逻辑视口 > (物理尺寸 + 旋转) > 物理尺寸（最后兜底只用于竖屏判断失败时的提示）。
 * @returns {{ok:true, view:{width:number,height:number}, source:string}|{ok:false, error:string}}
 */
export function viewFromProbe({ wmText = '', inputText = '' } = {}) {
  const frame = parseLogicalFrame(inputText);
  if (frame) return { ok: true, view: frame, source: 'logicalFrame' };
  const physical = parseWmSize(wmText);
  const rotation = parseSurfaceOrientation(inputText);
  if (physical && rotation != null) {
    return { ok: true, view: logicalFromPhysical(physical, rotation), source: `wmSize+rotation${rotation}` };
  }
  if (physical) {
    return {
      ok: false,
      error: `只拿到物理尺寸 ${physical.width}x${physical.height}，读不到 SurfaceOrientation：无法确定横竖屏，不敢猜（` +
        'adb shell dumpsys input 里应该有「SurfaceOrientation: N」）',
      physical,
    };
  }
  return { ok: false, error: '读不到显示尺寸（`adb shell wm size` 没有输出 Physical size）' };
}
