#!/usr/bin/env node
/**
 * 本地账号簿（src/account-book.js）单测：不联网、不碰 MAA / 模拟器，只读写临时目录。
 *
 * 锁住的口径（多用户共用一台电脑）：
 *  1. 手机号归一化（空格/横线/+86）与格式拒绝；昵称去控制字符、拒空。
 *  2. 同手机号 = 更新；昵称被别的手机号占用 = 冲突（除非 overwrite）。
 *  3. 坏文件不抛异常：problems + 备份 .bad-*，下次注册覆盖。
 *  4. list 一律打码，find 才给完整手机号。
 *
 * 2026-10-27 起（QQ 侧登录排队）：账号簿**只存掩码登录名**（前三后四，MAA 账号切换只认这个形态），
 * 旧数据里的完整号在读取/保存时自动转换。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizePhone,
  maskPhone,
  toMaskedLoginName,
  normalizeNickname,
  normalizeLoginMethod,
  accountBookFile,
  readBook,
  saveBook,
  findAccounts,
  upsertAccount,
  touchAccount,
  removeAccount,
  listAccounts,
  MAX_ACCOUNTS,
} from '../src/account-book.js';

let pass = 0;
const fails = [];
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fails.push({ name, error: String(e?.message || e) });
    console.log(`  FAIL ${name}: ${e?.message || e}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'maa-book-'));
const emptyBook = () => ({ version: 1, updatedAt: new Date().toISOString(), accounts: [] });

section('1. 手机号归一化');
await test('11 位手机号通过', () => {
  const r = normalizePhone('13800138000');
  assert.equal(r.ok, true);
  assert.equal(r.phone, '13800138000');
});
await test('空格 / 横线 / 括号 会被去掉', () => {
  assert.equal(normalizePhone('138 0013 8000').phone, '13800138000');
  assert.equal(normalizePhone('138-0013-8000').phone, '13800138000');
  assert.equal(normalizePhone('（138）00138000').phone, '13800138000');
});
await test('+86 / 86 / 00 前缀会被去掉', () => {
  assert.equal(normalizePhone('+8613800138000').phone, '13800138000');
  assert.equal(normalizePhone('8613800138000').phone, '13800138000');
  assert.equal(normalizePhone('008613800138000').phone, '13800138000');
});
await test('6 位以上的非手机号登录名也能存（B服/繁中/韩服）', () => {
  assert.equal(normalizePhone('abc12345').ok, true);
  assert.equal(normalizePhone('ab@gmail.com').ok, true);
});
await test('非法：纯数字太短 / 含空白 / 空', () => {
  assert.equal(normalizePhone('12345').ok, false);
  assert.equal(normalizePhone('a b').ok, false);
  assert.equal(normalizePhone('').ok, false);
  assert.equal(normalizePhone(null).ok, false);
});
await test('打码：13800138000 → 138****8000；已掩码不二次打码', () => {
  assert.equal(maskPhone('13800138000'), '138****8000');
  assert.equal(maskPhone('123456'), '****3456');
  assert.equal(maskPhone(''), '****');
  assert.equal(maskPhone('173****8245'), '173****8245');
});

section('1b. 掩码登录名（MAA 账号切换只认前三后四）');
await test('11 位手机号 → 前 3 + **** + 后 4（幂等）', () => {
  assert.equal(toMaskedLoginName('13800138000'), '138****8000');
  assert.equal(toMaskedLoginName('138****8000'), '138****8000');
  assert.equal(toMaskedLoginName('138 0013 8000'), '138****8000');
  assert.equal(toMaskedLoginName('+8613800138000'), '138****8000');
});
await test('非 11 位数字 / 登录名原样返回（B服、繁中、韩服）', () => {
  assert.equal(toMaskedLoginName('abc12345'), 'abc12345');
  assert.equal(toMaskedLoginName('ab@gmail.com'), 'ab@gmail.com');
  assert.equal(toMaskedLoginName('12345'), '12345');
  assert.equal(toMaskedLoginName(''), '');
});

section('2. 昵称归一化');
await test('去首尾空格、去控制字符', () => {
  assert.deepEqual(normalizeNickname('  Dr.博士\u0000 '), { ok: true, nickname: 'Dr.博士' });
});
await test('空昵称拒绝', () => {
  assert.equal(normalizeNickname('   ').ok, false);
  assert.equal(normalizeNickname(undefined).ok, false);
});
await test('超长昵称拒绝', () => {
  assert.equal(normalizeNickname('字'.repeat(41)).ok, false);
});
await test('登录方式归一化', () => {
  assert.equal(normalizeLoginMethod('QR'), 'qr');
  assert.equal(normalizeLoginMethod('code'), 'code');
  assert.equal(normalizeLoginMethod('乱写'), 'unknown');
});

section('3. 读写与容错');
await test('文件不存在 = 空簿（ok + missing）', () => {
  const dir = tmpDir();
  const st = readBook(accountBookFile(dir));
  assert.equal(st.ok, true);
  assert.equal(st.missing, true);
  assert.equal(st.book.accounts.length, 0);
});
await test('save → read 往返', () => {
  const dir = tmpDir();
  const file = accountBookFile(dir);
  const book = emptyBook();
  upsertAccount(book, { phone: '13800138000', nickname: '博士A' });
  upsertAccount(book, { phone: '13900139000', nickname: '博士B' });
  const saved = saveBook(file, book);
  assert.equal(saved.ok, true);
  assert.equal(saved.count, 2);
  const st = readBook(file);
  assert.equal(st.ok, true);
  assert.equal(st.book.accounts.length, 2);
  assert.equal(st.book.accounts[0].nickname, '博士A');
  assert.equal(st.book.accounts[1].lastLoginAt, null);
});
await test('坏 JSON：不抛异常、备份坏文件、下次注册能重建', () => {
  const dir = tmpDir();
  const file = accountBookFile(dir);
  fs.writeFileSync(file, '{ this is not json');
  const st = readBook(file);
  assert.equal(st.ok, false);
  assert.ok(st.problems.length >= 1);
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('accounts.json.bad-'));
  assert.equal(backups.length, 1, `应有 1 个备份，实际 ${backups.join(',')}`);
  const book = st.book;
  upsertAccount(book, { phone: '13800138000', nickname: '博士A' });
  assert.equal(saveBook(file, book).ok, true);
  assert.equal(readBook(file).book.accounts.length, 1);
});
await test('容量上限：超过 MAX_ACCOUNTS 只留最近的', () => {
  const dir = tmpDir();
  const file = accountBookFile(dir);
  const book = emptyBook();
  for (let i = 0; i < MAX_ACCOUNTS + 3; i += 1) {
    upsertAccount(book, { phone: String(13000000000 + i), nickname: `博士${i}` });
  }
  saveBook(file, book);
  assert.equal(readBook(file).book.accounts.length, MAX_ACCOUNTS);
});

section('4. 注册 / 更新 / 冲突');
await test('新注册 → created，能查到', () => {
  const book = emptyBook();
  const r = upsertAccount(book, { phone: '13800138000', nickname: '博士A', loginMethod: 'qr' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'created');
  assert.equal(r.account.nickname, '博士A');
  assert.deepEqual(r.account.loginMethods, ['qr']);
  const found = findAccounts(book, { phone: '138-0013-8000' });
  assert.equal(found.phone.nickname, '博士A');
});
await test('同手机号再登记 = 更新昵称（action updated）', () => {
  const book = emptyBook();
  upsertAccount(book, { phone: '13800138000', nickname: '旧名' });
  const r = upsertAccount(book, { phone: '13800138000', nickname: '新名', loginMethod: 'code' });
  assert.equal(r.action, 'updated');
  assert.equal(r.previousNickname, '旧名');
  assert.equal(r.account.nickname, '新名');
  assert.deepEqual(r.account.loginMethods, ['code']);
  assert.equal(book.accounts.length, 1);
});
await test('昵称被别的手机号占用 → 冲突（除非 overwrite）', () => {
  const book = emptyBook();
  upsertAccount(book, { phone: '13800138000', nickname: '博士A' });
  const bad = upsertAccount(book, { phone: '13900139000', nickname: '博士A' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'nickname-conflict');
  assert.equal(bad.conflict.phoneMasked, '138****8000');
  const ok = upsertAccount(book, { phone: '13900139000', nickname: '博士A', overwrite: true });
  assert.equal(ok.ok, true);
  assert.equal(book.accounts.length, 2);
});

section('5. 查询 / 登录记录 / 删除 / 列表打码');
await test('按昵称模糊查（含精确匹配）', () => {
  const book = emptyBook();
  upsertAccount(book, { phone: '13800138000', nickname: '博士A' });
  upsertAccount(book, { phone: '13900139000', nickname: '博士AB' });
  const found = findAccounts(book, { nickname: '博士A' });
  assert.equal(found.exactNickname.phone, '138****8000');
  assert.equal(found.nicknameMatches.length, 2);
});
await test('按手机号查不到 = phone null', () => {
  const book = emptyBook();
  const found = findAccounts(book, { phone: '13800138000' });
  assert.equal(found.phone, null);
});
await test('touch 记一次登录；没登记报 not-found', () => {
  const book = emptyBook();
  assert.equal(touchAccount(book, { phone: '13800138000' }).code, 'not-found');
  upsertAccount(book, { phone: '13800138000', nickname: '博士A' });
  const r = touchAccount(book, { phone: '13800138000', loginMethod: 'switch' });
  assert.equal(r.ok, true);
  assert.match(r.account.lastLoginAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(r.account.lastLoginMethod, 'switch');
  assert.deepEqual(r.account.loginMethods, ['switch']);
});
await test('remove 按手机号 / 按唯一昵称；重名要求用手机号', () => {
  const book = emptyBook();
  upsertAccount(book, { phone: '13800138000', nickname: '博士A' });
  upsertAccount(book, { phone: '13900139000', nickname: '博士B' });
  assert.equal(removeAccount(book, { nickname: '博士A' }).ok, true);
  assert.equal(book.accounts.length, 1);
  assert.equal(removeAccount(book, { phone: '13800138000' }).code, 'not-found');
  assert.equal(removeAccount(book, { phone: '13900139000' }).ok, true);
  assert.equal(book.accounts.length, 0);
});
await test('list 打码；库里本身就是掩码（不存完整号）', () => {
  const book = emptyBook();
  upsertAccount(book, { phone: '13800138000', nickname: '博士A' });
  const listed = listAccounts(book);
  assert.equal(listed[0].phone, '138****8000');
  assert.equal(listAccounts(book, { masked: false })[0].phone, '138****8000');
  assert.equal(findAccounts(book, { phone: '13800138000' }).phone.phone, '138****8000');
});

await test('入库即掩码：完整手机号只存在入参里，落盘/查询都是前三后四', () => {
  const book = emptyBook();
  upsertAccount(book, { phone: '13800138000', nickname: '博士A' });
  assert.equal(book.accounts[0].phone, '138****8000');
  const listed = listAccounts(book);
  assert.equal(listed[0].phone, '138****8000');
  // 已掩码的记录，用完整手机号也能查到（旧数据/用户口述都兼容）
  assert.equal(findAccounts(book, { phone: '13800138000' }).phone.nickname, '博士A');
  assert.equal(findAccounts(book, { phone: '138****8000' }).phone.nickname, '博士A');
});
await test('旧数据（完整号）读取时自动转掩码，保存后文件里不再有完整号', () => {
  const dir = tmpDir();
  const file = accountBookFile(dir);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    updatedAt: '2026-10-26T00:00:00.000Z',
    accounts: [{ phone: '17307958245', nickname: '梧桐月', server: 'Official', loginMethods: ['qr'], createdAt: '2026-10-26T00:00:00.000Z' }],
  }));
  const st = readBook(file);
  assert.equal(st.book.accounts[0].phone, '173****8245');
  assert.equal(st.book.accounts[0].nickname, '梧桐月');
  assert.equal(saveBook(file, st.book).ok, true);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('17307958245'), false, '文件里不能留完整手机号');
  assert.equal(raw.includes('173****8245'), true);
  const again = readBook(file);
  assert.equal(again.book.accounts.length, 1);
  assert.equal(again.book.accounts[0].phone, '173****8245');
});

console.log('');
if (fails.length) {
  console.error(`失败 ${fails.length} 项：`);
  for (const f of fails) console.error(` - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`全部通过: ${pass} 通过 / 0 失败`);
