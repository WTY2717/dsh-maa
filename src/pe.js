/**
 * 纯 JS 的 PE 映像读取：版本资源（FileVersion）与导出表。
 *
 * 为什么自己解析而不是 shell 调 PowerShell：
 *  - `maa_doctor` 要在任意 MAA 版本上工作，MaaCore.dll 没有版本资源、MAA.exe 才有，
 *    所以「读哪个文件的版本」这件事必须由我们决定；
 *  - 导出表是能力探测（Asst* 符号是否存在）的唯一不依赖 FFI 的来源，
 *    即使 koffi 没装好也能报能力表。
 */
import { openSync, readSync, closeSync, statSync } from 'node:fs';

const IMAGE_DIRECTORY_ENTRY_EXPORT = 0;
const IMAGE_DIRECTORY_ENTRY_RESOURCE = 2;
const RT_VERSION = 16;

/** 只读文件的一段，避免整文件读入（MaaCore.dll 6 MB）。 */
function readRange(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const got = readSync(fd, buf, 0, length, offset);
  return got === length ? buf : buf.subarray(0, got);
}

/** 解析 PE 头，返回区段表与数据目录偏移。 */
export function parsePe(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error('不是 PE 文件（缺少 MZ）');
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.length < peOff + 24 || buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('不是 PE 文件（缺少 PE 签名）');
  const coff = peOff + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const sizeOfOptional = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const dataDirOff = opt + (magic === 0x20b ? 112 : 96);
  const sections = [];
  const secOff = opt + sizeOfOptional;
  for (let i = 0; i < numSections; i++) {
    const o = secOff + i * 40;
    if (o + 40 > buf.length) break;
    sections.push({
      virtualSize: buf.readUInt32LE(o + 8),
      virtualAddress: buf.readUInt32LE(o + 12),
      rawSize: buf.readUInt32LE(o + 16),
      rawPointer: buf.readUInt32LE(o + 20),
    });
  }
  const rvaToOffset = (rva) => {
    for (const s of sections) {
      const span = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
        return rva - s.virtualAddress + s.rawPointer;
      }
    }
    return null;
  };
  const dataDirectory = (index) => {
    const o = dataDirOff + index * 8;
    if (o + 8 > buf.length) return { rva: 0, size: 0 };
    return { rva: buf.readUInt32LE(o), size: buf.readUInt32LE(o + 4) };
  };
  return { rvaToOffset, dataDirectory, sections };
}

const align4 = (n) => (n + 3) & ~3;

/** 读取一段以 UTF-16LE、双字节 0 结尾的字符串。 */
function readUtf16z(buf, off, end) {
  let out = '';
  for (let p = off; p + 1 < end; p += 2) {
    const code = buf.readUInt16LE(p);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/**
 * 递归遍历 VS_VERSIONINFO 结构，收集 key → 值。
 * 结构：wLength / wValueLength / wType / szKey / padding / Value / padding / Children。
 */
function walkVersionInfo(buf, start, end, sink) {
  let p = start;
  while (p + 6 <= end) {
    const wLength = buf.readUInt16LE(p);
    if (wLength < 6 || p + wLength > end) break;
    const wValueLength = buf.readUInt16LE(p + 2);
    const wType = buf.readUInt16LE(p + 4);
    const key = readUtf16z(buf, p + 6, p + wLength);
    const valueStart = align4(p + 6 + (key.length + 1) * 2);
    if (wValueLength > 0 && wType === 1) sink.set(key, readUtf16z(buf, valueStart, p + wLength));
    const valueBytes = wType === 1 ? wValueLength * 2 : wValueLength;
    const childStart = align4(valueStart + valueBytes);
    if (childStart + 6 <= p + wLength) walkVersionInfo(buf, childStart, p + wLength, sink);
    p = align4(p + wLength);
  }
}

/** 版本资源里所有字符串项（FileVersion / ProductVersion / FileDescription …）。 */
export function readVersionStrings(filePath) {
  const size = statSync(filePath).size;
  const fd = openSync(filePath, 'r');
  try {
    const head = readRange(fd, 0, Math.min(size, 8192));
    const pe = parsePe(head);
    const res = pe.dataDirectory(IMAGE_DIRECTORY_ENTRY_RESOURCE);
    if (!res.rva) return null;
    // 资源目录可能不在文件头 8 KB 内，整读一份（DLL 6 MB，仅在 doctor 里偶发调用）
    const buf = readRange(fd, 0, size);
    const pe2 = parsePe(buf);
    const root = pe2.rvaToOffset(res.rva);
    if (root == null) return null;
    const entryAt = (dirOff, index, countNamed, countId) => {
      const total = countNamed + countId;
      if (index >= total) return null;
      const o = dirOff + 16 + index * 8;
      return { name: buf.readUInt32LE(o), data: buf.readUInt32LE(o + 4) };
    };
    const subdir = (entry) => (entry && entry.data & 0x80000000 ? root + (entry.data & 0x7fffffff) : null);
    const counts = (dirOff) => [buf.readUInt16LE(dirOff + 12), buf.readUInt16LE(dirOff + 14)];
    // 层 1：找 RT_VERSION
    const [n0, i0] = counts(root);
    let typeDir = null;
    for (let i = 0; i < n0 + i0; i++) {
      const e = entryAt(root, i, n0, i0);
      if (e && !(e.name & 0x80000000) && e.name === RT_VERSION) { typeDir = subdir(e); break; }
    }
    if (typeDir == null) return null;
    // 层 2 / 3：取第一个名字项和第一个语言项
    const [n1, i1] = counts(typeDir);
    const nameEntry = entryAt(typeDir, 0, n1, i1);
    const nameDir = subdir(nameEntry);
    if (nameDir == null) return null;
    const [n2, i2] = counts(nameDir);
    const langEntry = entryAt(nameDir, 0, n2, i2);
    if (!langEntry || langEntry.data & 0x80000000) return null;
    // 资源树里所有偏移都相对资源目录基址（root），不是相对当前目录
    const dataEntryOff = root + langEntry.data;
    const dataRva = buf.readUInt32LE(dataEntryOff);
    const dataOff = pe2.rvaToOffset(dataRva);
    if (dataOff == null) return null;
    const sink = new Map();
    walkVersionInfo(buf, dataOff, buf.length, sink);
    return sink;
  } finally {
    closeSync(fd);
  }
}

/** `MAA.exe` 的 FileVersion；MaaCore.dll 本身没有版本资源，返回 null。 */
export function readFileVersion(filePath) {
  try {
    const strings = readVersionStrings(filePath);
    return strings?.get('FileVersion') || null;
  } catch {
    return null;
  }
}

/** 导出表里的符号名集合（能力探测用）。 */
export function readExportNames(filePath) {
  const size = statSync(filePath).size;
  const fd = openSync(filePath, 'r');
  try {
    const buf = readRange(fd, 0, size);
    const pe = parsePe(buf);
    const exp = pe.dataDirectory(IMAGE_DIRECTORY_ENTRY_EXPORT);
    if (!exp.rva) return [];
    const dir = pe.rvaToOffset(exp.rva);
    if (dir == null || dir + 40 > buf.length) return [];
    const count = buf.readUInt32LE(dir + 24);
    const namesRva = buf.readUInt32LE(dir + 32);
    const namesOff = pe.rvaToOffset(namesRva);
    if (namesOff == null || count > 20000) return [];
    const out = [];
    for (let i = 0; i < count; i++) {
      const strRva = buf.readUInt32LE(namesOff + i * 4);
      const strOff = pe.rvaToOffset(strRva);
      if (strOff == null) continue;
      let end = strOff;
      while (end < buf.length && buf[end] !== 0) end++;
      out.push(buf.toString('ascii', strOff, end));
    }
    return out;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

