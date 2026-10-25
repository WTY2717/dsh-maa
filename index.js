/**
 * MAA 插件入口（Host 侧）。
 *
 * 一个 bundle 只有一行 Loader 插件（见 cordis.patch.yml）：
 *   - 启动远程控制桥（MAA 反向轮询的那一端，默认 127.0.0.1:18764）；
 *   - **启动时先看 MuMu 模拟器开没开，没开就拉起来**（可在设置里关 `autoStartEmulator`）；
 *   - 注册设置页读写路由（/maa/api/config）；
 *   - 注册 15 个工具：远程控制 8 个、抄作业 3 个、自检 1 个、点击 1 个、滑动 1 个、模拟器 1 个。
 *
 * 稳定性红线（2026-10-25 崩溃事故的教训）：
 *   - **任何 Promise 都不许裸奔**：Node 24 里未捕获的 Promise 拒绝会直接退出进程，
 *     而 DSH 就是那个进程。所以每个 `void xxx()` 都必须带 `.catch`。
 *   - apply 里不允许抛异常：所有可能失败的动作都包 try/catch，失败记进 uiState/日志。
 *   - 不用 schemastery 的 `.volatile()`（会 resolve 成包装对象，见 src/config.js）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createTools } from './src/tools.js';
import { Bridge } from './src/remote/bridge.js';
import { resolveConfig, Config } from './src/config.js';
import { installConfigRoute } from './src/ui-config.js';
import { ensureEmulator } from './src/emulator.js';

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 插件版本（doctor 里回显，方便对齐问题现场）。 */
function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const name = 'maa-plugin';
/** 工具注册表是硬依赖；其余服务都是可选的。 */
export const inject = ['tools'];
export { Config };

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 插件行配置（schemastery 校验后的 Config）
 */
export function apply(ctx, config) {
  let currentConfig = config && typeof config === 'object' ? config : {};
  const pkgVersion = packageVersion();
  const recent = [];
  const remember = (...args) => {
    try {
      recent.push(`${new Date().toISOString()} ${args.map(String).join(' ')}`);
      if (recent.length > 200) recent.shift();
    } catch { /* 日志永远不许影响主流程 */ }
  };
  /** 所有「发出去不管」的异步动作都走这里：绝不允许未捕获拒绝。 */
  const fireAndForget = (label, promise) => {
    try {
      Promise.resolve(promise).catch((e) => remember(`${label} failed`, String(e?.message || e)));
    } catch (e) {
      remember(`${label} threw`, String(e?.message || e));
    }
  };

  const uiState = {
    routeInstalled: false,
    route: '/maa/api/config',
    error: null,
    report: null,
  };

  /* ── 远程控制桥：懒启动 + 失败可重试 ── */
  let bridge = null;
  let starting = null;
  let lastBridgeError = null;
  /** 插件已被销毁：启动过程中被禁用/重载时，别把监听端口漏在宿主里。 */
  let disposed = false;

  const startBridge = async () => {
    if (disposed) return null;
    // resolveConfig 本身不抛，但这里再兜一层：它曾经是崩溃点
    let cfg;
    try {
      cfg = resolveConfig(currentConfig, PKG_DIR);
    } catch (e) {
      lastBridgeError = `解析配置失败: ${e?.message || e}`;
      remember('resolveConfig failed', String(e?.message || e));
      return null;
    }
    try {
      if (bridge?.listening && bridge.port === cfg.bridgePort) return bridge;
      if (bridge && bridge.port !== cfg.bridgePort) {
        fireAndForget('bridge.stop', bridge.stop());
        bridge = null;
      }
      if (bridge?.listening) return bridge;
      if (starting) return starting;
      starting = (async () => {
        try {
          fs.mkdirSync(cfg.shotsDir, { recursive: true });
        } catch { /* 目录问题在 doctor 里报 */ }
        const b = new Bridge({ port: cfg.bridgePort, shotsDir: cfg.shotsDir, log: (...a) => remember(...a) });
        try {
          await b.start();
          if (disposed) {
            // 启动期间插件被卸载：不能把已监听的桥留在宿主里（否则下一次启用会 EADDRINUSE）
            remember('bridge started after dispose, stopping');
            await b.stop().catch(() => {});
            return null;
          }
          bridge = b;
          lastBridgeError = null;
          remember('bridge started', `port=${cfg.bridgePort}`);
          return b;
        } catch (e) {
          lastBridgeError = String(e?.message || e);
          remember('bridge start failed', lastBridgeError);
          bridge = null;
          return null;
        } finally {
          starting = null;
        }
      })();
      return starting;
    } catch (e) {
      lastBridgeError = String(e?.message || e);
      remember('startBridge threw', lastBridgeError);
      return null;
    }
  };

  /** 给工具用的取桥入口：启动失败时抛出带原因的错误（端口被占用是最常见的那个）。 */
  const getBridge = async () => {
    if (bridge?.listening) return bridge;
    const started = await startBridge();
    if (started?.listening) return started;
    let port = 18764;
    try { port = resolveConfig(currentConfig, PKG_DIR).bridgePort; } catch { /* 用默认 */ }
    throw new Error(`远程控制桥启动失败（端口 ${port}）：${lastBridgeError ?? '未知原因'}`);
  };

  // 启动即尝试一次；失败不阻塞插件加载（设置页仍要能改端口）
  fireAndForget('startBridge(initial)', startBridge());

  /* ── 模拟器自启：先看开没开，没开就拉起（设置里可关）──
   * 为什么放在启动时：MAA 不会自己开模拟器，用户点一次工具前还要手动开模拟器太蠢。
   * 语义：只探测 + 必要时 launch + 等 adb 能连上；不碰游戏、不消费理智。
   * 失败只记日志（比如本机根本没装 MuMu），绝不影响插件加载与其他工具。 */
  const ensureEmulatorOnStart = async () => {
    let cfg;
    try {
      cfg = resolveConfig(currentConfig, PKG_DIR);
    } catch (e) {
      remember('resolveConfig(emulator) failed', String(e?.message || e));
      return null;
    }
    if (!cfg.autoStartEmulator) {
      remember('emulator auto-start disabled');
      return { ok: false, skipped: true, reason: 'autoStartEmulator=false' };
    }
    const r = await ensureEmulator({ cfg });
    remember('emulator ensure', JSON.stringify({ ok: r.ok, started: r.started ?? null, launched: r.launched ?? null, bootMs: r.bootMs ?? null, error: r.error ?? null }));
    return r;
  };
  fireAndForget('ensureEmulator(initial)', ensureEmulatorOnStart());

  ctx.effect(() => () => {
    disposed = true;
    if (bridge) fireAndForget('bridge.stop(dispose)', bridge.stop());
    bridge = null;
    uiState.routeInstalled = false;
  });

  /* ── 设置页读写路由 ── */
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sctx) => {
        try {
          const dispose = installConfigRoute({ sctx, getConfig: () => currentConfig, pkgDir: PKG_DIR, log: remember });
          if (typeof sctx.effect === 'function') sctx.effect(() => dispose);
          uiState.routeInstalled = true;
          uiState.report = { webServer: true };
        } catch (e) {
          uiState.error = String(e?.message || e);
          remember('config route install failed', uiState.error);
        }
      });
    } else {
      uiState.error = 'ctx.inject 不可用（没有 webServer）';
    }
  } catch (e) {
    uiState.error = `注册设置页路由失败: ${e?.message || e}`;
    remember('inject failed', uiState.error);
  }

  /* ── 工具注册 ── */
  try {
    const tools = createTools({
      getConfig: () => currentConfig,
      pkgDir: PKG_DIR,
      getBridge,
      pkgVersion,
      getUiState: () => uiState,
    });
    /**
     * 工具返回值必须是「无损 JSON」：带 undefined 会让注册表拒绝整个结果
     * （实测报 value is not lossless JSON），所以统一过一遍 JSON。
     */
    const lossless = (value) => {
      try {
        return value === undefined ? null : JSON.parse(JSON.stringify(value));
      } catch (e) {
        return { ok: false, error: `结果无法序列化成 JSON: ${e?.message || e}` };
      }
    };
    for (const tool of tools) {
      const execute = tool.execute.bind(tool);
      const wrapped = {
        ...tool,
        async execute(args, exec) {
          try {
            return lossless(await execute(args, exec));
          } catch (e) {
            // 只给模型可执行的信息，不给栈
            const err = new Error(`${e?.message || e}${e?.code ? ` [${e.code}]` : ''}`);
            err.toolName = tool.name;
            throw err;
          }
        },
      };
      ctx.effect(() => ctx.tools.register(wrapped));
    }
    remember('plugin applied', `v${pkgVersion} tools=${tools.length}`);
    return;
  } catch (e) {
    // 工具注册失败也不要连累宿主
    remember('tool registration failed', String(e?.message || e));
  }
}

/** 供外部诊断（不暴露工具）。 */
export function diagnostics() {
  return { pkgDir: PKG_DIR, version: packageVersion() };
}
