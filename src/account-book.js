/**
 * 本地账号簿：手机号 ↔ 明日方舟昵称（一台电脑给多个用户用时记录「谁是谁」）。
 *
 * 为什么需要它：MAA 的「账号切换」只认**本机登录记录里的登录名**（官服就是手机号），
 * 模型没法自己知道哪个昵称对应哪个手机号；所以把用户第一次说的「手机号 + 昵称」存下来，
 * 下次这个用户再来（或换人）时就能查到该切到哪个号，查不到就按新用户走登录流程。
 *
 * 三条硬约束（多用户共用一台电脑）：
 *  1. **只存本地**：`<dataRoot>/accounts.json` —— data/ 已 gitignore，不进仓库、不上传。
 *  2. **验证码绝不落盘**：本模块只认手机号/昵称/登录方式，没有任何存验证码的字段。
 *  3. **列表一律打码**：`list` 只回 `138****8000` 这种；完整手机号只在 `find` / `register`
 *     的结果里给模型（用来输入、切号），不要把别人的手机号念给其他用户。
 *
 * 读写都容错：文件坏了不抛异常（坏文件备份成 `.bad-<时间戳>`，下次注册覆盖），
 * 写盘用「临时文件 + rename」保证不会写出半个 JSON。
 */
import fs from 'node:fs';
import path from 'node:path';

export const BOOK_VERSION = 1;
/** 账号簿上限：这是家用电脑的账号列表，不是数据库。 */
export const MAX_ACCOUNTS = 100;
/** 支持的登录方式：验证码 / 扫码 / MAA 账号切换 / 未知。 */
export const LOGIN_METHODS = ['code', 'qr', 'switch', 'unknown'];

const PHONE_RE = /^\d{6,20}$/;
const nowIso = () => new Date().toISOString();

/** `<dataRoot>/accounts.json`。 */
export function accountBookFile(dataRoot) {
  return path.join(String(dataRoot || ''), 'accounts.json');
}

function emptyBook() {
  return { version: BOOK_VERSION, updatedAt: nowIso(), accounts: [] };
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

function clip(value, max) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > max ? s.slice(0, max).trim() : s;
}

/**
 * 登录名归一化。
 *  - 纯数字（官服手机号）：去空格/横线/括号，去 `+`/`00`/`86` 国际前缀，要求 6~20 位。
 *  - 其它（B 服昵称、繁中/韩服邮箱）：只做基本清洗，要求 2~64 字符、不含空白/控制字符。
 *    （MAA 的账号切换是拿「登录名」做 OCR 模糊匹配的；B 服例子就是昵称。）
 * @returns {{ok:true, phone:string}|{ok:false, error:string}}
 */
export function normalizePhone(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { ok: false, error: '登录名/手机号必须是字符串（例如 "13800138000"）' };
  }
  const raw = String(value).trim();
  const digits = raw.replace(/[\s\-()（）]/g, '');
  if (/^\+?\d+$/.test(digits)) {
    let s = digits;
    if (s.startsWith('+')) s = s.slice(1);
    if (s.startsWith('00')) s = s.slice(2);
    // 国内号码带国家码：8613800138000 → 13800138000（只在国内手机号长度范围内处理）
    if (s.startsWith('86') && s.length > 11) s = s.slice(2);
    if (PHONE_RE.test(s)) return { ok: true, phone: s };
    return { ok: false, error: `手机号格式不对：${JSON.stringify(raw.slice(0, 24))}（要求 6~20 位数字）` };
  }
  const login = raw.replace(/[\u0000-\u001f\u007f]/g, '');
  if (login.length >= 2 && login.length <= 64 && !/\s/.test(login)) return { ok: true, phone: login };
  return {
    ok: false,
    error: `登录名格式不对：${JSON.stringify(raw.slice(0, 24))}（2~64 字符、不含空白；官服填手机号，B服/繁中/韩服填登录名）`,
  };
}

/** 打码：13800138000 → 138****8000；邮箱/昵称 → 前 2 后 2。 */
export function maskPhone(phone) {
  const s = String(phone ?? '');
  if (/^\d+$/.test(s)) {
    if (s.length >= 8) return `${s.slice(0, 3)}****${s.slice(-4)}`;
    if (s.length >= 4) return `****${s.slice(-4)}`;
    return '****';
  }
  if (s.length >= 4) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return '****';
}

/** 昵称归一化：去控制字符、压长度；空昵称拒绝（主界面左上角医生名 / 登录页显示名都行）。 */
export function normalizeNickname(value) {
  const raw = typeof value === 'string' ? value : '';
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) return { ok: false, error: '昵称不能为空（明日方舟主界面左上角的医生名）' };
  if (s.length > 40) return { ok: false, error: `昵称太长（${s.length} 字），确认一下是不是贴错了` };
  return { ok: true, nickname: s };
}

/** 登录方式归一化；未知的一律 unknown（不因为写错就失败）。 */
export function normalizeLoginMethod(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return LOGIN_METHODS.includes(v) ? v : 'unknown';
}

function cleanRecord(raw) {
  const phoneRaw = clip(raw?.phone, 64);
  const nickname = clip(raw?.nickname, 40);
  const p = normalizePhone(phoneRaw);
  if (!p.ok || !nickname) return null;
  const phone = p.phone;
  const loginMethods = Array.isArray(raw?.loginMethods)
    ? uniq(raw.loginMethods.map(normalizeLoginMethod).filter((m) => m !== 'unknown'))
    : [];
  return {
    phone,
    nickname,
    server: clip(raw?.server, 16) || 'Official',
    loginMethods,
    createdAt: clip(raw?.createdAt, 32) || nowIso(),
    updatedAt: clip(raw?.updatedAt, 32) || null,
    lastLoginAt: clip(raw?.lastLoginAt, 32) || null,
    lastLoginMethod: LOGIN_METHODS.includes(raw?.lastLoginMethod) ? raw.lastLoginMethod : null,
    note: clip(raw?.note, 200),
  };
}

/**
 * 读账号簿。不抛异常：不存在 = 空簿；坏了 = problems + 空簿（坏文件先备份）。
 * @returns {{path:string, ok:boolean, missing:boolean, problems:string[], book:object}}
 */
export function readBook(file) {
  const state = { path: file, ok: false, missing: false, problems: [], book: emptyBook() };
  if (!file) {
    state.problems.push('账号簿路径为空（dataRoot 没解析出来）');
    return state;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') {
      state.ok = true;
      state.missing = true;
      return state;
    }
    state.problems.push(`读账号簿失败：${e?.message || e}`);
    return state;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    state.problems.push(`账号簿不是合法 JSON（${e?.message || e}）：已忽略旧内容，下次注册会重建`);
    try { fs.copyFileSync(file, `${file}.bad-${Date.now()}`); } catch { /* 备份失败不影响主流程 */ }
    return state;
  }
  state.ok = true;
  const rows = Array.isArray(raw?.accounts) ? raw.accounts : [];
  state.book = {
    version: Number(raw?.version) || BOOK_VERSION,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    accounts: rows.map(cleanRecord).filter(Boolean).slice(-MAX_ACCOUNTS),
  };
  return state;
}

/** 原子写账号簿（临时文件 + rename）。 */
export function saveBook(file, book) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = {
      version: BOOK_VERSION,
      updatedAt: nowIso(),
      accounts: (book?.accounts ?? []).slice(-MAX_ACCOUNTS),
    };
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, path: file, count: data.accounts.length };
  } catch (e) {
    return { ok: false, error: `写账号簿失败：${e?.message || e}` };
  }
}

/** 按手机号/昵称找账号（不写盘）。 */
export function findAccounts(book, { phone, nickname } = {}) {
  const accounts = book?.accounts ?? [];
  const out = { phone: null, nicknameMatches: [], exactNickname: null };
  if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
    const p = normalizePhone(phone);
    if (p.ok) out.phone = accounts.find((a) => a.phone === p.phone) ?? null;
    else out.phoneError = p.error;
  }
  const n = typeof nickname === 'string' ? nickname.trim().toLowerCase() : '';
  if (n) {
    out.nicknameMatches = accounts.filter((a) => a.nickname.toLowerCase().includes(n));
    out.exactNickname = accounts.find((a) => a.nickname.toLowerCase() === n) ?? null;
  }
  return out;
}

/**
 * 注册/更新一条关联。同手机号 = 更新昵称；昵称被别的手机号占用 = 拒绝（除非 overwrite）。
 * @returns {{ok:true, action:'created'|'updated', account:object}|{ok:false, code?:string, error:string}}
 */
export function upsertAccount(book, { phone, nickname, loginMethod = 'unknown', server = 'Official', note = '', overwrite = false } = {}) {
  const p = normalizePhone(phone);
  if (!p.ok) return { ok: false, error: p.error };
  const n = normalizeNickname(nickname);
  if (!n.ok) return { ok: false, error: n.error };
  const accounts = book.accounts;
  const existing = accounts.find((a) => a.phone === p.phone) ?? null;
  const conflict = accounts.find(
    (a) => a.phone !== p.phone && a.nickname.toLowerCase() === n.nickname.toLowerCase(),
  );
  if (conflict && !overwrite) {
    return {
      ok: false,
      code: 'nickname-conflict',
      error:
        `昵称「${n.nickname}」已经登记在另一个手机号（${maskPhone(conflict.phone)}）名下。` +
        '先跟用户确认：是同一个人换了手机号就加 overwrite:true；否则换昵称/手机号再登记。',
      conflict: { phoneMasked: maskPhone(conflict.phone), nickname: conflict.nickname },
    };
  }
  const method = normalizeLoginMethod(loginMethod);
  const stamp = nowIso();
  if (existing) {
    const previousNickname = existing.nickname;
    existing.nickname = n.nickname;
    existing.server = clip(server, 16) || existing.server || 'Official';
    if (method !== 'unknown') existing.loginMethods = uniq([...(existing.loginMethods ?? []), method]);
    if (note) existing.note = clip(note, 200);
    existing.updatedAt = stamp;
    return { ok: true, action: 'updated', account: { ...existing }, previousNickname };
  }
  const account = {
    phone: p.phone,
    nickname: n.nickname,
    server: clip(server, 16) || 'Official',
    loginMethods: method === 'unknown' ? [] : [method],
    createdAt: stamp,
    updatedAt: stamp,
    lastLoginAt: null,
    lastLoginMethod: null,
    note: clip(note, 200),
  };
  accounts.push(account);
  if (accounts.length > MAX_ACCOUNTS) accounts.splice(0, accounts.length - MAX_ACCOUNTS);
  return { ok: true, action: 'created', account: { ...account } };
}

/** 记一次成功登录/切换（更新 lastLoginAt / lastLoginMethod）。 */
export function touchAccount(book, { phone, loginMethod = 'unknown' } = {}) {
  const p = normalizePhone(phone);
  if (!p.ok) return { ok: false, error: p.error };
  const account = book.accounts.find((a) => a.phone === p.phone) ?? null;
  if (!account) {
    return { ok: false, code: 'not-found', error: `账号簿里没有 ${maskPhone(p.phone)}（先用 register 登记手机号+昵称）` };
  }
  const method = normalizeLoginMethod(loginMethod);
  account.lastLoginAt = nowIso();
  account.updatedAt = account.lastLoginAt;
  if (method !== 'unknown') {
    account.lastLoginMethod = method;
    account.loginMethods = uniq([...(account.loginMethods ?? []), method]);
  }
  return { ok: true, account: { ...account } };
}

/** 删除一条（按手机号；只给昵称时要求唯一）。 */
export function removeAccount(book, { phone, nickname } = {}) {
  let target = null;
  if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
    const p = normalizePhone(phone);
    if (!p.ok) return { ok: false, error: p.error };
    target = book.accounts.find((a) => a.phone === p.phone) ?? null;
  } else if (typeof nickname === 'string' && nickname.trim()) {
    const n = nickname.trim().toLowerCase();
    const hits = book.accounts.filter((a) => a.nickname.toLowerCase() === n);
    if (hits.length > 1) return { ok: false, code: 'ambiguous', error: `昵称「${nickname}」对应 ${hits.length} 个账号，用 phone 指定` };
    target = hits[0] ?? null;
  } else {
    return { ok: false, error: '要给 phone（或唯一的 nickname）' };
  }
  if (!target) return { ok: false, code: 'not-found', error: '账号簿里没有这条记录' };
  book.accounts = book.accounts.filter((a) => a !== target);
  return { ok: true, removed: { phoneMasked: maskPhone(target.phone), nickname: target.nickname } };
}

/** 列表（默认打码）。 */
export function listAccounts(book, { masked = true } = {}) {
  return (book?.accounts ?? []).map((a) => ({
    phone: masked ? maskPhone(a.phone) : a.phone,
    nickname: a.nickname,
    server: a.server,
    loginMethods: a.loginMethods,
    createdAt: a.createdAt,
    lastLoginAt: a.lastLoginAt,
    lastLoginMethod: a.lastLoginMethod,
    note: a.note || null,
  }));
}

export const internals = { cleanRecord, emptyBook, uniq };
