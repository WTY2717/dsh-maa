/**
 * MaaCore 回调汇总与结构化结果解析（OperBox / Depot / VideoRecognition）。
 *
 * 为什么单独一份：`maa_chain` 与 `maa_toolbox` 都要从同一批回调里取结果，
 * 判定口径必须一致。这里只做「数据 → 形状」的纯函数 + 一个事件收集器，
 * 不碰 CoreWorker、不连模拟器，方便单测直接用真实回调 fixture。
 *
 * 两个必须知道的实测事实（2026-10-28 探针，见 docs/plans/maa-plugin-plan.md §24）：
 *  1. **长数组在 worker 的 `text` 里被截到 400 字符**（worker.mjs 为了省内存），
 *     所以结构化解析一律用 `message.details`（driver 传给 onEvent 的已解析对象），
 *     不要用 `message.text`。
 *  2. MAA 6.20.1 的 `AllTasksCompleted`（id=3）回调里**没有 `what` 字段**，
 *     只有 `finished_tasks`。所以任务结束判定要认 id=3，不能只认 `what`。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 结构化回调里出现的 class（跨版本比 id 稳定）。 */
const STRUCTURED_CLASS_RE = /OperBoxRecognitionTask|DepotRecognitionTask|CombatRecordRecognitionTask/;

/** 明确表示失败的回调 id：InternalError / TaskChainError / SubTaskError。 */
const FAILURE_IDS = new Set([1, 10000, 20000]);

/** 取 MAA 回调的两层 details（`{what, details:{...}}` 的里层）。 */
function innerDetails(message) {
  const d = message?.details;
  if (!d || typeof d !== 'object') return {};
  const dd = d.details;
  return dd && typeof dd === 'object' && !Array.isArray(dd) ? dd : {};
}

/** 一条回调的可读摘要（进度数组用；不依赖 worker 截断后的 text）。 */
export function describeCallback(message) {
  const d = message?.details ?? {};
  const dd = innerDetails(message);
  const name = d.what || dd.task || '';
  const cls = d.class ? String(d.class).replace(/^asst::/, '') : '';
  const parts = [`[${message?.id ?? '?'}]`, name, cls].filter(Boolean);
  if (Array.isArray(dd.all_opers)) parts.push(`opers=${dd.all_opers.length}`);
  if (typeof dd.data === 'string') parts.push(`data=${dd.data.length}B`);
  if (typeof dd.filename === 'string') parts.push(`file=${path.basename(dd.filename)}`);
  if (d.taskchain && !name) parts.push(`taskchain=${d.taskchain}`);
  return parts.join(' ');
}

/**
 * 事件收集器：progress（可读摘要）+ structured（带完整 details 的结构化回调）。
 *
 * @param {object} [args]
 * @param {(ev:any)=>void} [args.onEvent] 外部观察者（异常会被吞掉，不能影响任务）
 * @param {number} [args.maxProgress] progress 上限（默认 300，超出丢最早的）
 * @param {number} [args.maxStructured] structured 上限（默认 40；OperBox 数组只留最后一条即可）
 */
export function createEventCollector({ onEvent = null, maxProgress = 300, maxStructured = 40 } = {}) {
  const progress = [];
  /** @type {Array<{id:number, at:string, details:object}>} */
  const structured = [];
  let callbacks = 0;
  let allCompleted = false;
  let taskCompleted = 0;
  let taskStopped = false;
  let failure = null;
  let lastEventAt = null;

  const remember = (arr, item, max) => {
    arr.push(item);
    if (arr.length > max) arr.splice(0, arr.length - max);
  };

  const push = (ev) => {
    try {
      if (ev?.event === 'cb') {
        callbacks += 1;
        lastEventAt = Date.now();
        const d = ev.details ?? {};
        const what = d.what ?? null;
        const dd = innerDetails(ev);
        if (ev.id === 3 || what === 'AllTasksCompleted') allCompleted = true;
        if (ev.id === 10002) taskCompleted += 1;
        if (ev.id === 10004 || what === 'TaskChainStopped') taskStopped = true;
        if ((FAILURE_IDS.has(ev.id) || what === 'TaskChainError' || what === 'ConnectFailed') && !failure) {
          failure = { id: ev.id, what: what ?? dd.task ?? null, at: new Date().toISOString() };
        }
        remember(progress, { at: new Date().toISOString(), id: ev.id, line: describeCallback(ev), failure: FAILURE_IDS.has(ev.id) }, maxProgress);
        if (STRUCTURED_CLASS_RE.test(String(d.class ?? '')) || dd.all_opers || dd.data || dd.filename) {
          remember(structured, { id: ev.id, at: new Date().toISOString(), details: d }, maxStructured);
        }
      }
    } catch { /* 观察者绝不能把宿主/任务带崩 */ }
    try { onEvent?.(ev); } catch { /* 外部观察者同理 */ }
  };

  return {
    push,
    progressLines: () => progress.slice(-40),
    structured: () => structured.slice(-maxStructured),
    callbacks: () => callbacks,
    allCompleted: () => allCompleted,
    taskCompleted: () => taskCompleted,
    taskStopped: () => taskStopped,
    failure: () => failure,
    lastEventAt: () => lastEventAt,
  };
}

/**
 * 解析 OperBox 回调（id=20003，class=asst::OperBoxRecognitionTask）。
 * 同一次识别会多次推送（每扫一屏一次），取**最后一条** `details.all_opers`。
 *
 * @param {Array<{id:number, details:object}>} events createEventCollector().structured()
 * @returns {null|{total:number, ownedCount:number, chars:Array<{id:string,name:string,nameEn:string,rarity:number,own:boolean}>, raw:object[], at:string|null}}
 */
export function parseOperBox(events = []) {
  let found = null;
  for (const ev of events) {
    const d = ev?.details ?? {};
    const cls = String(d.class ?? '');
    const dd = innerDetails(ev);
    if (!Array.isArray(dd.all_opers)) continue;
    if (!/OperBox/i.test(cls) && !dd.all_opers.length) continue;
    found = { ops: dd.all_opers, at: ev.at ?? null };
  }
  if (!found) return null;
  const seen = new Set();
  const chars = [];
  for (const op of found.ops) {
    if (!op || typeof op !== 'object') continue;
    const id = String(op.id ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    chars.push({
      id,
      name: typeof op.name === 'string' ? op.name : '',
      nameEn: typeof op.name_en === 'string' ? op.name_en : '',
      rarity: Number(op.rarity) || 0,
      own: Boolean(op.own),
    });
  }
  return {
    total: chars.length,
    ownedCount: chars.filter((c) => c.own).length,
    chars,
    raw: found.ops,
    at: found.at,
  };
}

/**
 * 解析 Depot 回调（id=20003，class=asst::DepotRecognitionTask）。
 * 实测结构：`details.data` 是 **JSON 字符串**（物品 id → 数量），`details.done` 表示是否扫完。
 * 同一次识别会多次推送（每滑一屏），取最后一条。
 *
 * @param {Array<{id:number, details:object}>} events
 * @param {Record<string,string>} [names] item_index.json 的 id → 中文名（找不到不影响解析）
 * @returns {null|{totalTypes:number,totalCount:number,done:boolean,items:Array<{id:string,name:string|null,count:number}>,at:string|null}}
 */
export function parseDepot(events = [], names = null) {
  let found = null;
  for (const ev of events) {
    const d = ev?.details ?? {};
    const cls = String(d.class ?? '');
    if (!/Depot/i.test(cls)) continue;
    const dd = innerDetails(ev);
    let data = dd.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { continue; }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    found = { data, done: dd.done === true, at: ev.at ?? null };
  }
  if (!found) return null;
  const items = [];
  for (const [id, count] of Object.entries(found.data)) {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) continue;
    items.push({ id: String(id), name: names?.[String(id)] ?? null, count: Math.round(n) });
  }
  items.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return {
    totalTypes: items.length,
    totalCount: items.reduce((sum, it) => sum + it.count, 0),
    done: found.done,
    items,
    at: found.at,
  };
}

/**
 * 解析视频识别产出的 Copilot 作业路径。
 * 实测（源码 CombatRecordRecognitionTask::_run）：识别成功会发 id=20003、what="Finished"、
 * `details.filename` = `<UserDir>/cache/CombatRecord/MaaAI_<关卡>_<视频名>_<时间>.json`。
 *
 * @param {Array<{id:number, details:object}>} events
 * @returns {null|{file:string, what:string|null, at:string|null}}
 */
export function parseVideoResult(events = []) {
  for (const ev of events) {
    const d = ev?.details ?? {};
    const dd = innerDetails(ev);
    const cls = String(d.class ?? '');
    if (!dd.filename || typeof dd.filename !== 'string') continue;
    if (!/CombatRecord|VideoRecognition/i.test(cls) && d.what !== 'Finished' && ev.id !== 20003) continue;
    if (!/\.json$/i.test(dd.filename)) continue;
    return { file: dd.filename, what: d.what ?? null, at: ev.at ?? null };
  }
  return null;
}

/**
 * 读 MAA 的 `resource/item_index.json`（仓库识别的 id → 中文名）。
 * 读不到只返回 `{ok:false}`，绝不抛（没有它仓库识别照样能用，只是没名字）。
 */
export function loadItemIndex(installDir) {
  const file = installDir ? path.join(String(installDir), 'resource', 'item_index.json') : '';
  if (!file) return { ok: false, file: '', names: {}, count: 0, error: '未配置 MAA 安装目录' };
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    const names = {};
    for (const [id, info] of Object.entries(rows ?? {})) {
      if (info && typeof info === 'object' && typeof info.name === 'string' && info.name) names[id] = info.name;
    }
    return { ok: true, file, names, count: Object.keys(names).length };
  } catch (e) {
    return { ok: false, file, names: {}, count: 0, error: String(e?.message || e) };
  }
}

/**
 * 把完整结果落盘（工具结果只返回摘要 + 前 N 条，完整数据给模型按需再读）。
 * 失败只返回错误，不影响工具本身的返回值。
 *
 * @param {string} dir 目标目录（通常是 cfg.logDir）
 * @param {string} prefix 文件名前缀（如 toolbox-operbox）
 * @param {any} payload 可 JSON 序列化的完整数据
 * @returns {{ok:true,file:string,bytes:number}|{ok:false,error:string}}
 */
export function writeDump(dir, prefix, payload) {
  const file = path.join(String(dir || '.'), `${prefix}-${Date.now()}.json`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify(payload, null, 1);
    fs.writeFileSync(file, text, 'utf8');
    return { ok: true, file, bytes: Buffer.byteLength(text) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), file: null, bytes: 0 };
  }
}
