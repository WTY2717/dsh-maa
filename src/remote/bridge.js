/**
 * 后端 A：MAA 远程控制协议的桥（移植自 plugins/maa-mcp/server.mjs，去掉 MCP 层）。
 *
 * 工作模式是**反向轮询**：MAA 主动 `POST /maa/getTask` 取任务，再 `POST /maa/reportStatus` 回报，
 * 我们不需要知道 MAA 怎么点游戏。协议依据：
 *   https://docs.maa.plus/zh-cn/protocol/remote-control-schema.html
 *
 * 重发策略（踩过的坑）：只对「立即执行」类任务（截图/停止/心跳）按 REDISPATCH_MS 重发；
 * LinkStart / CaptureImage / Settings / Toolbox 是排队任务，跑几分钟才回执是正常的，
 * 按同一套超时判 lost 会把正在跑的一键长草误判成失败。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 协议承认的任务类型（data 表；未知类型直接拒，避免 MAA 侧报错） */
export const ORDERED_TYPES = [
  /^LinkStart$/,
  /^LinkStart-(Base|WakeUp|Combat|Recruiting|Mall|Mission|AutoRoguelike|Reclamation)$/,
  /^Settings-(ConnectAddress|Stage1)$/,
  /^Toolbox-(GachaOnce|GachaTenTimes)$/,
  /^CaptureImage$/,
];
export const IMMEDIATE_TYPES = [/^CaptureImageNow$/, /^StopTask$/, /^HeartBeat$/];

const isKnownType = (t) => [...ORDERED_TYPES, ...IMMEDIATE_TYPES].some((re) => re.test(t));
const isImmediate = (t) => IMMEDIATE_TYPES.some((re) => re.test(t));

const REDISPATCH_MS = 5_000;
const MAX_ATTEMPTS = 3;
const KEEP_TASKS = 200;

/** 任务队列 + 等待回执。一个 profile 只应该有一个实例在监听 bridgePort。 */
export class Bridge {
  constructor({ host = '127.0.0.1', port = 18764, shotsDir, log = () => {} } = {}) {
    this.host = host;
    this.port = Number(port);
    this.shotsDir = shotsDir;
    this.log = log;
    this.tasks = new Map();
    this.waiters = new Map();
    this.lastPollAt = 0;
    this.pollCount = 0;
    this.lastError = null;
    this.server = null;
    this.listening = false;
    if (this.shotsDir) fs.mkdirSync(this.shotsDir, { recursive: true });
  }

  assertType(type, params) {
    if (typeof type !== 'string' || !type) throw new Error('type 必填');
    if (!isKnownType(type)) {
      throw new Error(`未知任务类型: ${type}（协议只支持 LinkStart* / CaptureImage / StopTask / HeartBeat / Toolbox-* / Settings-*）`);
    }
    if (type.startsWith('Settings-') && params == null) throw new Error(`${type} 需要 params`);
  }

  enqueue(type, params) {
    this.assertType(type, params);
    const task = {
      id: randomUUID(),
      type,
      params: params ?? null,
      state: 'queued', // queued | dispatched | done | lost
      createdAt: Date.now(),
      dispatchedAt: 0,
      attempts: 0,
      status: null,
      file: null,
      payloadLen: 0,
      note: null,
    };
    this.tasks.set(task.id, task);
    this.#prune();
    this.log('enqueue', type, task.id, params != null ? JSON.stringify(params) : '');
    return task;
  }

  #prune() {
    if (this.tasks.size <= KEEP_TASKS) return;
    const finished = [...this.tasks.values()]
      .filter((t) => t.state === 'done' || t.state === 'lost')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const t of finished.slice(0, this.tasks.size - KEEP_TASKS)) this.tasks.delete(t.id);
    // MAA 长时间不在线时，queued 任务会一直堆着：超过硬上限就丢最老的（并置 lost，别让它突然被中途执行）
    const HARD_LIMIT = KEEP_TASKS * 2;
    if (this.tasks.size <= HARD_LIMIT) return;
    const stale = [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, this.tasks.size - HARD_LIMIT);
    for (const t of stale) {
      t.state = 'lost';
      t.note = '队列溢出被丢弃（MAA 长时间没来取任务）';
      this.#settle(t, t.status);
      this.tasks.delete(t.id);
    }
  }

  #settle(task, status) {
    const set = this.waiters.get(task.id);
    if (!set) return;
    for (const fn of set) fn({ ...task, status });
    this.waiters.delete(task.id);
  }

  waitFor(task, ms) {
    if (task.state === 'done' || task.state === 'lost') return Promise.resolve(task);
    return new Promise((resolve) => {
      if (!this.waiters.has(task.id)) this.waiters.set(task.id, new Set());
      const done = (v) => { clearTimeout(timer); resolve(v); };
      this.waiters.get(task.id).add(done);
      const timer = setTimeout(() => {
        this.waiters.get(task.id)?.delete(done);
        resolve(task);
      }, Math.max(0, ms));
    });
  }

  get(taskId) {
    return this.tasks.get(taskId);
  }

  list(limit = 30) {
    return [...this.tasks.values()].slice(-limit).map(publicTask);
  }

  health() {
    return {
      online: Date.now() - this.lastPollAt < 5000,
      listening: this.listening,
      address: `http://${this.host}:${this.port}`,
      lastPollAt: this.lastPollAt || null,
      silentMs: this.lastPollAt ? Date.now() - this.lastPollAt : null,
      pollCount: this.pollCount,
      pending: [...this.tasks.values()].filter((t) => t.state === 'queued' || t.state === 'dispatched').length,
      lastError: this.lastError,
    };
  }

  /* ────────────────────── HTTP 层 ────────────────────── */

  async start() {
    if (this.server) return this;
    // 请求处理是「发出去不管」的：必须在这里收掉拒绝，否则宿主进程会被未捕获拒绝带走
    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((e) => {
        this.lastError = String(e?.message || e);
        this.log('handler failed:', this.lastError);
        try { res.destroy(); } catch { /* 已经断开 */ }
      });
    });
    await new Promise((resolve, reject) => {
      const onError = (e) => {
        this.lastError = e.code === 'EADDRINUSE'
          ? `端口 ${this.port} 已被占用（多半是旧的 mcp-maa 插件或另一个实例还在监听）；在插件设置里改 bridgePort，或禁用旧插件`
          : e.message;
        reject(new Error(this.lastError));
      };
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onError);
        this.server.on('error', (e) => { this.lastError = e.message; this.log('HTTP error:', e.message); });
        this.listening = true;
        this.log(`bridge on http://${this.host}:${this.port}  getTask=/maa/getTask  report=/maa/reportStatus  shots=${this.shotsDir}`);
        resolve(this);
      });
    });
    return this;
  }

  async stop() {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.listening = false;
    await new Promise((resolve) => {
      s.close(() => resolve());
      setTimeout(resolve, 1500).unref?.();
    });
  }

  async #handle(req, res) {
    const url = (req.url || '/').split('?')[0];
    let raw = '';
    try { raw = await readBody(req); } catch { return json(res, { error: 'read failed' }, 400); }

    // MAA 取任务
    if (url === '/maa/getTask') {
      this.lastPollAt = Date.now();
      this.pollCount += 1;
      const now = Date.now();
      const out = [];
      for (const t of this.tasks.values()) {
        if (t.state === 'queued') {
          t.state = 'dispatched';
          t.dispatchedAt = now;
          t.attempts += 1;
          out.push(wire(t));
        } else if (t.state === 'dispatched' && isImmediate(t.type) && now - t.dispatchedAt > REDISPATCH_MS) {
          if (t.attempts >= MAX_ATTEMPTS) {
            t.state = 'lost';
            t.note = `立即任务下发了 ${t.attempts} 次仍无回执`;
            this.log('LOST', t.type, t.id);
            this.#settle(t, t.status);
          } else {
            t.dispatchedAt = now;
            t.attempts += 1;
            out.push(wire(t));
          }
        }
      }
      return json(res, { tasks: out });
    }

    // MAA 汇报结果
    if (url === '/maa/reportStatus') {
      let body = null;
      try { body = JSON.parse(raw || '{}'); } catch { return json(res, { ok: false }); }
      const t = this.tasks.get(body.task);
      if (t) {
        t.state = 'done';
        t.status = body.status || 'SUCCESS';
        t.finishedAt = Date.now();
        const payload = typeof body.payload === 'string' ? body.payload : '';
        t.payloadLen = payload.length;
        if (t.type === 'HeartBeat') {
          t.note = payload; // 正在执行的 taskId，空串=空闲
        } else if (payload && this.shotsDir) {
          try {
            t.file = path.join(this.shotsDir, `${t.id}.png`);
            fs.writeFileSync(t.file, Buffer.from(payload, 'base64'));
          } catch (e) {
            t.note = `截图落盘失败: ${e.message}`;
          }
        }
        this.log('report', t.type, t.status, t.file ? `-> ${t.file}` : '');
        this.#settle(t, t.status);
      }
      return json(res, { ok: true }); // MAA 不读返回体
    }

    // 调试/兜底控制口（也给测试用）
    if (url.startsWith('/ctl/')) {
      const act = url.slice(5);
      try {
        if (act === 'health') return json(res, this.health());
        if (act === 'tasks') return json(res, { tasks: this.list() });
        if (act === 'run') { const b = JSON.parse(raw || '{}'); return json(res, { taskId: this.enqueue(b.type, b.params).id }); }
        if (act === 'stop') return json(res, { taskId: this.enqueue('StopTask').id });
        if (act === 'screenshot') return json(res, { taskId: this.enqueue('CaptureImageNow').id });
        if (act === 'wait') {
          const b = JSON.parse(raw || '{}');
          const t = this.tasks.get(b.taskId);
          if (!t) return json(res, { error: 'unknown taskId' }, 404);
          const r = await this.waitFor(t, Math.min(b.timeoutMs ?? 30_000, 120_000));
          return json(res, publicTask(r));
        }
        return json(res, { error: 'unknown ctl action' }, 404);
      } catch (e) {
        return json(res, { error: String(e.message || e) }, 400);
      }
    }

    return json(res, { error: 'not found' }, 404);
  }
}

/** 截图 base64 可能是几 MB（实测 2.7 MB PNG → 3.6 MB base64），给足上限但不无限吃内存。 */
const MAX_BODY = 64 * 1024 * 1024;

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      reject(new Error(`请求体超过 ${MAX_BODY} 字节上限`));
      try { req.destroy(); } catch { /* 已断 */ }
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const json = (res, obj, code = 200) => {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
};

const wire = (t) => ({ id: t.id, type: t.type, ...(t.params != null ? { params: t.params } : {}) });

export const publicTask = (t) => ({
  id: t.id,
  type: t.type,
  params: t.params,
  state: t.state,
  status: t.status,
  attempts: t.attempts,
  file: t.file,
  note: t.note,
  ageMs: Date.now() - t.createdAt,
});

export { isKnownType, isImmediate };
