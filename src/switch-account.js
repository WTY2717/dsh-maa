/**
 * 「账号切换」：用 MaaCore 直连下发 **StartUp 任务 + account_name**（= MAA 界面里
 * 开始唤醒 → 账号切换 的同一套逻辑），但账号名由工具动态传入，不用改 MAA 的配置。
 *
 * 为什么不用远程控制的 `LinkStart-WakeUp`：`LinkStart-WakeUp` 只读 MAA 当前配置里那一条
 * 开始唤醒任务的设置，**不接受参数**（见 RemoteControlService.cs 的 LinkStart 实现），
 * 所以没法「这次切 A、下次切 B」。MaaCore 直连可以每次下发不同的 account_name。
 *
 * 限制（来自 MAA 源码，不是本插件的取舍）：
 *  - 只能切到**本机登录记录里已有**的账号（登录名模糊匹配，官服就是手机号）；
 *  - 只有官服 / B服 / 繁中服 / 韩服支持（EN/JP 与 PC 端直连都不支持）；
 *  - 登录已过期 / 账号不在记录里 → 任务会失败，这时按「新用户登录流程（逻辑1）」重来。
 */
import path from 'node:path';
import { CoreWorker } from './core/driver.js';
import { classify, summarize } from './core/callbacks.js';
import { resolveAdbPath, screencap } from './adb.js';
import { connectionExtras } from './copilot.js';
import { normalizePhone, maskPhone } from './account-book.js';
import { maaBusy } from './input/index.js';

/** MAA 的账号切换只支持这几个客户端（AccountSwitchTask.cpp 的 SupportedClientType）。 */
export const SUPPORTED_SWITCH_CLIENTS = ['Official', 'Bilibili', 'txwy', 'YoStarKR'];

/** 从插件配置猜客户端类型（MAA gui.new.json 的 ClientType；缺省官服）。 */
export function clientTypeFromCfg(cfg) {
  const hinted = cfg?.maaHint?.clientType;
  return typeof hinted === 'string' && hinted ? hinted : 'Official';
}

/**
 * 构造 `StartUp` 任务参数（MaaCore 的任务类型就叫 StartUp，不是 LinkStart-WakeUp）。
 * @returns {{ok:true, params:object}|{ok:false, error:string}}
 */
export function buildStartUpParams({ phone, clientType = 'Official', startGame = true } = {}) {
  const p = normalizePhone(phone);
  if (!p.ok) return { ok: false, error: p.error };
  const ct = String(clientType || 'Official');
  if (!SUPPORTED_SWITCH_CLIENTS.includes(ct)) {
    return {
      ok: false,
      error:
        `当前客户端 ${ct} 不支持账号切换（MAA 只支持 ${SUPPORTED_SWITCH_CLIENTS.join(' / ')}；` +
        'EN/JP 与 PC 端直连都没有这个功能）。这种号只能走手动登录（逻辑1），或让用户自己在 MAA 里切。',
    };
  }
  return {
    ok: true,
    params: {
      client_type: ct,
      start_game_enabled: Boolean(startGame),
      account_name: p.phone,
    },
  };
}

/** 失败时对模型/用户的口径（成功返回 null）。 */
export function switchAdvice({ ok, connectionFailed = false, failed = false, timedOut = false, sawAccountSwitch = false } = {}) {
  if (ok) return null;
  if (connectionFailed) {
    return {
      verdict: 'emulator-unreachable',
      message: '连不上模拟器：先 maa_emulator status / maa_doctor 看 adb 与地址，模拟器没开就 maa_emulator start；不要按「登录过期」处理。',
    };
  }
  if (timedOut) {
    return {
      verdict: 'timeout',
      message:
        '账号切换超时（截图看卡在哪一屏）：能重试一次；还不行就按新用户登录流程（逻辑1）处理。' +
        '注意频繁登出/登录可能触发验证码。',
    };
  }
  if (failed && !sawAccountSwitch) {
    return {
      verdict: 'switch-unavailable',
      message:
        '没看到账号切换的动作（大概率是这个账号不在本机登录记录里 / 登录已过期 / 当前界面无法登出）。' +
        '把该用户当新用户：走逻辑1（手机号+验证码，或扫码登录）。',
    };
  }
  return {
    verdict: 'switch-failed',
    message: '切换任务失败：截图确认现在停在哪一屏；能重试一次，否则按新用户登录流程（逻辑1）处理。',
  };
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 执行一次账号切换（阻塞；超时上限 timeoutSeconds）。
 * @param {object} args
 * @param {object} args.cfg 已解析配置
 * @param {string} args.phone 目标账号登录名（官服=手机号）
 * @param {string} [args.clientType] 默认取 MAA 配置
 * @param {boolean} [args.startGame] 游戏没开时是否让 MAA 启动（默认 true）
 * @param {number} [args.timeoutSeconds] 默认 240，范围 60~300
 * @param {object|null} [args.bridge] 远程控制桥（用于和 MAA GUI 的任务互斥，可空）
 * @param {(ev:any)=>void} [args.onEvent]
 * @param {(ctl:object)=>void} [args.onReady] 后台模式拿 worker/taskId/stopTask
 * @param {object} [args.deps] 单测注入 { CoreWorker, resolveAdbPath, connectionExtras, screencap, maaBusy }
 */
export async function switchAccount({
  cfg,
  phone,
  clientType,
  startGame = true,
  timeoutSeconds = 240,
  bridge = null,
  onEvent,
  onReady,
  deps = {},
} = {}) {
  const ct = clientType || clientTypeFromCfg(cfg);
  const built = buildStartUpParams({ phone, clientType: ct, startGame });
  if (!built.ok) return { ok: false, status: 'invalid', error: built.error, advice: null };

  // 和 MAA GUI 抢触摸会点飞：它正在跑任务时先不切（由上层去让请求者稍等）
  const busyFn = deps.maaBusy ?? maaBusy;
  const busy = busyFn(bridge);
  if (busy?.known && ((busy.pending ?? 0) > 0 || (busy.running ?? []).length > 0)) {
    return {
      ok: false,
      status: 'maa-busy',
      error: `MAA 正在跑任务（${(busy.running?.length ? busy.running : busy.pendingTypes || []).join(', ')}），现在切换会跟它的触摸注入打架：等它跑完再切`,
      maa: busy,
      advice: { verdict: 'maa-busy', message: '让请求者稍等，轮到这个用户时再切号；别 maa_stop 别人的任务。' },
    };
  }

  const adbFn = deps.resolveAdbPath ?? resolveAdbPath;
  const adb = adbFn({ configured: cfg.adbPath, hintPath: cfg.maaHint?.adbPath });
  if (!adb.ok) return { ok: false, status: 'invalid', error: adb.error, advice: switchAdvice({ connectionFailed: true }) };
  const extrasFn = deps.connectionExtras ?? connectionExtras;
  const extras = extrasFn(cfg, adb.path);

  const progress = [];
  let accountSwitch = { seen: false, target: null, at: null };
  const Worker = deps.CoreWorker ?? CoreWorker;
  const worker = new Worker({
    logDir: cfg.logDir,
    nodePath: cfg.nodePath,
    onEvent: (ev) => {
      if (ev?.event === 'cb') {
        let info = null;
        try { info = classify(ev.id, ev.text || ''); } catch { info = null; }
        if (info) {
          progress.push({ at: new Date().toISOString(), line: summarize(info), failure: info.failure });
          if (progress.length > 300) progress.splice(0, 150);
          if (info.what === 'AccountSwitch') {
            accountSwitch = {
              seen: true,
              target: info.details?.details?.account_name ?? null,
              at: new Date().toISOString(),
            };
          }
        }
      }
      onEvent?.(ev);
    },
  });
  const progressLines = () => progress.slice(-40);

  try {
    await worker.start();
    await worker.open({ installDir: cfg.maaInstallPath, userDir: cfg.coreUserDir, extras: { config: cfg.adbConfig, json: extras } });
    const conn = await worker.connect({
      adbPath: adb.path,
      address: cfg.adbAddress,
      config: cfg.adbConfig,
      extras,
      timeoutMs: 45000,
    });
    if (!conn.connected) {
      return {
        ok: false,
        status: 'unreachable',
        error: `连接模拟器失败（${cfg.adbAddress}）：模拟器没开/掉线/地址不对`,
        progress: progressLines(),
        logFile: worker.logFile,
        advice: switchAdvice({ connectionFailed: true }),
      };
    }

    const appended = await worker.append('StartUp', built.params);
    await worker.startTask();
    if (typeof onReady === 'function') {
      try {
        onReady({
          worker,
          taskId: appended.taskId,
          progressLines,
          stopTask: () => worker.stop(),
        });
      } catch (e) {
        onEvent?.({ event: 'onReady-failed', error: String(e?.message || e) });
      }
    }
    const seconds = Math.min(Math.max(Number(timeoutSeconds) || 240, 60), 300);
    const result = await worker.wait(seconds * 1000);
    const shotFn = deps.screencap ?? screencap;
    const shot = await shotFn({
      adbPath: adb.path,
      address: cfg.adbAddress,
      outFile: path.join(cfg.shotsDir, `switch-${Date.now()}.png`),
    });
    const sawCompletion = Boolean(result.sawCompletion);
    const ok = sawCompletion && !result.failed;
    const status = ok ? 'switched' : result.timedOut ? 'timeout' : 'failed';
    return {
      ok,
      status,
      sawCompletion,
      failed: Boolean(result.failed),
      timedOut: Boolean(result.timedOut),
      idleExit: Boolean(result.idleExit),
      taskId: appended.taskId,
      target: { phoneMasked: maskPhone(phone), nickname: null },
      clientType: ct,
      startGame: Boolean(startGame),
      accountSwitch,
      callbacks: result.callbacks,
      progress: progressLines(),
      screenshot: shot.ok ? { file: shot.file, bytes: shot.bytes } : { error: shot.error },
      logFile: worker.logFile,
      advice: ok ? null : switchAdvice({ ok, failed: result.failed, timedOut: result.timedOut, sawAccountSwitch: accountSwitch.seen }),
      hint: ok
        ? '切换任务链已结束：用 read_image 看截图确认停在主界面、左上角医生名是目标账号；确认后再 maa_account_book({action:"touch"}) 记一次登录。'
        : '任务链没成功：看 advice 与截图决定重试 / 走新用户登录流程（逻辑1）。',
    };
  } catch (e) {
    return {
      ok: false,
      status: 'error',
      error: String(e?.message || e),
      code: e?.code,
      progress: progressLines(),
      logFile: worker.logFile,
      advice: switchAdvice({ ok: false, failed: true, sawAccountSwitch: accountSwitch.seen }),
    };
  } finally {
    await worker.close().catch(() => {});
  }
}
