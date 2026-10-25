/**
 * 输入后端探测（`maa_swipe` 用）。
 *
 * 结论先行：本机实测 **`adb shell input` 就能滑动这个游戏**，所以插件只实现 `adb-input` 一种通道。
 * maatouch / minitouch 那两个后端留给「adb input 哪天又被证明不行」的情况：
 * 保留 id 与拒绝理由，但不写半套实现（半套实现比没有更坑）。
 * 依据：docs/tools/maa.md「滑动」一节、docs/plans/maa-swipe-plan.md §3 方案 A。
 */
import { resolveAdbPath, ensureConnected } from '../adb.js';
import { probeDisplay } from './adb-input.js';

export const BACKEND_IDS = ['auto', 'adb-input', 'maatouch', 'minitouch'];

const CACHE_TTL_MS = 30_000;
const cache = new Map();

export function clearBackendCache() {
  cache.clear();
}

/**
 * @param {object} args
 * @param {object} args.cfg 已解析的插件配置
 * @param {string} [args.force] 调用方指定的后端（auto/adb-input/maatouch/minitouch）
 * @param {object} [args.deps] 单测注入 { resolveAdbPath, ensureConnected, probeDisplay }
 * @returns {Promise<{ok:true, backend:string, adb:{path:string,address:string,source:string}, view:{width:number,height:number}, reason:string}
 *                 |{ok:false, backend:string|null, error:string, adb?:object}>}
 */
export async function detectInputBackend({ cfg, force = 'auto', deps = {} } = {}) {
  const requested = String(force ?? 'auto').trim().toLowerCase() || 'auto';
  if (!BACKEND_IDS.includes(requested)) {
    return { ok: false, backend: null, error: `未知后端 ${JSON.stringify(force)}（可用：${BACKEND_IDS.join(' / ')}）` };
  }
  if (requested === 'maatouch' || requested === 'minitouch') {
    return {
      ok: false,
      backend: requested,
      error:
        `${requested} 后端未实现：本机实测 adb input swipe 可以直接滑动游戏，所以只带 adb-input 一种通道。` +
        '直接不传 backend（auto）即可',
    };
  }

  const resolve = deps.resolveAdbPath ?? resolveAdbPath;
  const connect = deps.ensureConnected ?? ensureConnected;
  const probe = deps.probeDisplay ?? probeDisplay;

  const adb = resolve({ configured: cfg.adbPath, hintPath: cfg.maaHint?.adbPath });
  if (!adb.ok) return { ok: false, backend: null, error: `没找到 adb：${adb.error}` };

  const address = cfg.adbAddress;
  const key = `${requested}|${adb.path}|${address}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const conn = await connect(adb.path, address);
  if (!conn.ok) {
    return { ok: false, backend: null, adb: { path: adb.path, address, source: adb.source }, error: `adb connect ${address} 失败：${conn.output || '未知原因'}` };
  }
  const display = await probe({ adbPath: adb.path, address, deps });
  if (!display.ok) {
    return { ok: false, backend: null, adb: { path: adb.path, address, source: adb.source }, error: `探测显示尺寸失败：${display.error}` };
  }

  const value = {
    ok: true,
    backend: 'adb-input',
    adb: { path: adb.path, address, source: adb.source },
    view: display.view,
    viewSource: display.source,
    reason: 'adb input 实测可用（本机 Unity 游戏接受注入触摸）',
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}
