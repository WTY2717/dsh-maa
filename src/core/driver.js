/**
 * MaaCore 子进程的父侧管理器：spawn / JSON 行 RPC / 超时 / 收尸。
 *
 * 关键约束：Host 是 Electron 进程，`process.execPath` 指向 Electron 而不是 node，
 * 所以子进程必须用 `ELECTRON_RUN_AS_NODE=1` 启动（NAPI 让 koffi 与宿主 ABI 无关）。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'worker.mjs');

let resolvedNode = null;

/**
 * 找一个能跑 worker 的 node：Electron 用 ELECTRON_RUN_AS_NODE，否则依次试候选。
 * 缓存按 `configured` 分键：设置页改了 nodePath 要能立刻生效（不能吃老结果）。
 */
const nodeCache = new Map();
export async function resolveNodeBinary(configured = '') {
  const cacheKey = String(configured || '');
  const cached = nodeCache.get(cacheKey) ?? (cacheKey === '' ? resolvedNode : null);
  if (cached) return cached;
  const candidates = [];
  const push = (bin, env, label) => candidates.push({ bin, env, label });
  if (configured) push(configured, {}, 'config.nodePath');
  if (process.versions.electron) push(process.execPath, { ELECTRON_RUN_AS_NODE: '1' }, 'electron-as-node');
  else push(process.execPath, {}, 'host-node');
  const home = os.homedir();
  const runtimes = path.join(home, '.dsh', 'dsh-runtimes');
  try {
    for (const d of fs.readdirSync(runtimes)) {
      const bin = path.join(runtimes, d, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
      if (fs.existsSync(bin)) push(bin, {}, `dsh-runtime:${d}`);
    }
  } catch { /* 没有 runtime 目录就跳过 */ }
  push('node', {}, 'PATH:node');

  const errors = [];
  for (const c of candidates) {
    const ok = await probeNode(c);
    if (ok) { resolvedNode = c; nodeCache.set(cacheKey, c); return c; }
    errors.push(`${c.label}: 探测失败`);
  }
  const err = new Error(`找不到可用的 node 可执行文件来运行 MaaCore 子进程（试过 ${errors.join('；')}）。可在插件设置里填 nodePath。`);
  err.code = 'NODE_NOT_FOUND';
  throw err;
}

function probeNode(c) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(c.bin, ['-e', 'process.stdout.write(process.versions.node)'], {
        env: { ...process.env, ...c.env },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(false); }, 8000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && /^\d+\./.test(out.trim()));
    });
  });
}

/** 一条会话（一个 MaaCore 句柄）的父侧代理。 */
export class CoreWorker {
  constructor({ logDir = null, onEvent = null, nodePath = '' } = {}) {
    this.logDir = logDir;
    this.onEvent = onEvent;
    this.nodePath = nodePath;
    this.child = null;
    this.pending = new Map();
    this.callbacks = [];
    this.stderrLines = [];
    this.closed = false;
    this.logFile = null;
  }

  async start() {
    if (this.child) return this;
    const node = await resolveNodeBinary(this.nodePath);
    if (this.logDir) {
      try {
        fs.mkdirSync(this.logDir, { recursive: true });
        this.logFile = path.join(this.logDir, `core-${Date.now()}.log`);
      } catch { this.logFile = null; }
    }
    this.child = spawn(node.bin, [WORKER], {
      cwd: HERE,
      env: { ...process.env, ...node.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.#onLine(line));
    const rlErr = readline.createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    rlErr.on('line', (line) => {
      this.stderrLines.push(line);
      if (this.stderrLines.length > 500) this.stderrLines.shift();
      if (this.logFile) { try { fs.appendFileSync(this.logFile, line + '\n'); } catch { /* ignore */ } }
      this.#emit({ type: 'log', text: line });
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      const err = new Error(`MaaCore 子进程已退出（code=${code}${signal ? ` signal=${signal}` : ''}）`);
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    });
    this.child.on('error', (e) => {
      const err = new Error(`MaaCore 子进程启动失败: ${e.message}`);
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    });
    return this;
  }

  /** onEvent 是外部回调：它抛异常不能顺着事件循环把宿主带走。 */
  #emit(evt) {
    try { this.onEvent?.(evt); } catch { /* 忽略观察者的异常 */ }
  }

  #onLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.event) {
      if (msg.event === 'cb') this.callbacks.push(msg);
      this.#emit(msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else {
      const err = new Error(msg.error || 'MaaCore 操作失败');
      if (msg.code) err.code = msg.code;
      p.reject(err);
    }
  }

  rpc(op, args = {}, timeoutMs = 60000) {
    if (!this.child || this.closed) return Promise.reject(new Error('MaaCore 子进程未运行'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MaaCore 操作超时（${op} > ${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, op });
      try {
        this.child.stdin.write(JSON.stringify({ id, op, args }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  open(args) { return this.rpc('open', args, 180000); }
  connect(args) { return this.rpc('connect', args, (args?.timeoutMs ?? 45000) + 15000); }
  append(type, params) { return this.rpc('append', { type, params }, 60000); }
  startTask() { return this.rpc('start', {}, 30000); }
  wait(timeoutMs) { return this.rpc('wait', { timeoutMs }, timeoutMs + 15000); }
  stop() { return this.rpc('stop', {}, 15000); }
  click(x, y, waitMs) { return this.rpc('click', { x, y, waitMs }, 30000); }
  info() { return this.rpc('info', {}, 10000); }

  /** 收尸：先礼后兵，超时就 kill（AsstDestroy 会阻塞，所以必须有 kill 兜底）。 */
  async close({ graceMs = 3000 } = {}) {
    if (!this.child || this.closed) return;
    try { this.child.stdin.write(JSON.stringify({ id: 'quit', op: 'quit', args: {} }) + '\n'); } catch { /* ignore */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { this.child.kill(); } catch { /* ignore */ }
        resolve();
      }, graceMs);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.closed = true;
  }
}
