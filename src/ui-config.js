/**
 * 插件设置页的读写通道（Host 侧 HTTP）。
 *
 *   GET  /maa/api/config  → { value, effective, editable, roster, settingsFile }
 *   POST /maa/api/config  → { patch }   写 data/settings.json（白名单 + 类型校验）
 *
 * 为什么不走 loader 行 config：见 src/settings-store.js 顶部注释（volatile 包装对象 →
 * 未捕获拒绝 → 进程退出）。写自己的 JSON 没有这条风险，也不需要重载插件行，
 * 下一次工具调用自动读新值。
 *
 * 所有异常都在内部吞掉并转成 JSON 错误响应：这个 handler 绝不允许把异常抛回事件循环。
 */
import { resolveConfig } from './config.js';
import { EDITABLE_FIELDS, readOverrides, sanitizePatch, settingsFilePath, writeOverrides } from './settings-store.js';
import { loadRoster } from './roster.js';
import { describeInstall } from './maa.js';

const MAX_BODY = 64 * 1024;

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      reject(new Error('请求体过大'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const sendJson = (res, code, obj) => {
  try {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    try { res.destroy(); } catch { /* ignore */ }
  }
};

/** 面板要显示的东西：可编辑字段 + 当前生效值 + 解析结果（改完路径能立刻看到对不对）。 */
function snapshot({ getConfig, pkgDir }) {
  const cfg = resolveConfig(getConfig() ?? {}, pkgDir);
  let roster = null;
  try {
    const r = loadRoster(cfg.rosterPathResolved);
    roster = { ok: r.ok, path: r.path, format: r.format ?? null, parsed: r.total ?? 0, owned: r.owned ?? 0, error: r.error ?? null };
  } catch (e) {
    roster = { ok: false, path: cfg.rosterPathResolved, error: String(e?.message || e) };
  }
  // 设置页顶部的状态卡要这几项：MAA 版本、练度解析、adb/端口
  let maa = null;
  try {
    if (cfg.maaInstallPath) {
      const d = describeInstall(cfg.maaInstallPath);
      maa = { path: cfg.maaInstallPath, version: d.version ?? null, source: cfg.maaInstallSource ?? null, resource: d.resource ?? null };
    }
  } catch { /* 状态卡缺 MAA 信息不影响表单 */ }
  // 表单回显「用户填的值」，不是「解析后的值」：
  // maaInstallPath 会被自动探测结果回填，直接回显会让用户以为那是自己填的（实测踩过）。
  const formValue = (key) => (key === 'maaInstallPath' ? (cfg.maaInstallPathConfigured ?? '') : cfg[key]);
  return {
    ok: true,
    value: Object.fromEntries(EDITABLE_FIELDS.map(([key]) => [key, formValue(key)])),
    editable: EDITABLE_FIELDS.map(([key, type]) => ({ key, type })),
    maa,
    effective: {
      maaInstallPath: cfg.maaInstallPath,
      rosterPath: cfg.rosterPathResolved,
      adbPath: cfg.maaHint?.adbPath ?? cfg.adbPath ?? null,
      bridgePort: cfg.bridgePort,
      dataRoot: cfg.dataRoot,
    },
    roster,
    problems: cfg.maaInstallProblems ?? [],
    settingsFile: settingsFilePath(pkgDir),
    overrides: readOverrides(pkgDir),
  };
}

/**
 * 注册路由。
 * @param {object} args
 * @param {import('@deepseek-ai/cordis').Context} args.sctx 带 webServer 的上下文
 * @param {() => object} args.getConfig
 * @param {string} args.pkgDir
 * @param {(s: string, e?: unknown) => void} [args.log]
 * @returns {() => void} disposer
 */
export function installConfigRoute({ sctx, getConfig, pkgDir, log = () => {} }) {
  const webServer = sctx?.webServer;
  if (!webServer || typeof webServer.register !== 'function') return () => {};

  const handler = async (req, res) => {
    try {
      if (req.method === 'GET') return sendJson(res, 200, snapshot({ getConfig, pkgDir }));
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 GET/POST' });

      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      const clean = sanitizePatch(body?.patch);
      if (!Object.keys(clean).length) {
        return sendJson(res, 400, { ok: false, error: `没有可写字段（允许：${EDITABLE_FIELDS.map(([k]) => k).join(', ')}）` });
      }
      writeOverrides(pkgDir, clean);
      log('settings updated', JSON.stringify(clean));
      return sendJson(res, 200, { ...snapshot({ getConfig, pkgDir }), saved: clean });
    } catch (e) {
      log('config route failed', String(e?.message || e));
      return sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
  };

  try {
    const dispose = webServer.register({ kind: 'exact', path: '/maa/api/config', handler });
    log('config route registered', '/maa/api/config');
    return () => { try { dispose(); } catch { /* 已卸载 */ } };
  } catch (e) {
    // 路径冲突/服务已卸载都不允许影响插件加载
    log('config route register failed', String(e?.message || e));
    return () => {};
  }
}
