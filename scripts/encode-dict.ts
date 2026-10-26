/**
 * dict.bin 编码器 —— 把 base.json.gz + extra.json.gz 打包为紧凑二进制字库
 * 布局与 moonbit/xtext_core/query.mbt 中定义的格式严格一致:
 *   [header 32B][记录表 56B/条][UTF-8 字符串池][释义倒排索引][trailer 8B = 索引区偏移]
 * 索引区与 trailer 为可选(旧引擎忽略尾部字节;新引擎检测不到则回退全表扫描)。
 * 传输压缩交给 CDN(按请求的 Accept-Encoding 自动协商),不在构建期 gzip。
 *
 * 用法：bun scripts/encode-dict.ts
 * 输入：src/assets/base.json.gz / extra.json.gz（由 scripts/fetch-dict-source.ts 从上游仓库下载）
 * 输出：src/assets/dict.bin
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

interface RawBase { z?: string; y?: string; p?: string; a?: string; s?: number; q?: number }
interface RawExtra { c?: string; m?: string; d?: [string, string[]]; e?: string; n?: string }

const base = JSON.parse(gunzipSync(readFileSync('src/assets/base.json.gz')).toString()) as RawBase[];
const extra = JSON.parse(gunzipSync(readFileSync('src/assets/extra.json.gz')).toString()) as RawExtra[];

if (base.length !== extra.length) throw new Error(`条目数不一致: ${base.length} vs ${extra.length}`);

const ABSENT = 0xffff;
const HEADER_SIZE = 32;
const RECORD_SIZE = 56;

// ── 字符串池构建 ────────────────────────────────────────────────
const pool = Buffer.alloc(64 * 1024 * 1024); // 64MB 上限
let poolLen = 0;
const poolMap = new Map<string, number>();

function intern(s: string | undefined): [number, number] {
  if (!s) return [0, ABSENT];
  const existing = poolMap.get(s);
  if (existing !== undefined) return [existing, Buffer.byteLength(s, 'utf8')];
  const bytes = Buffer.from(s, 'utf8');
  if (poolLen + bytes.length > pool.length) throw new Error('pool overflow');
  bytes.copy(pool, poolLen);
  const off = poolLen;
  poolMap.set(s, off);
  poolLen += bytes.length;
  return [off, bytes.length];
}

/** 释义 d → 多行文本：首行说明（可空），其后每行一个义项 */
function encodeMeanings(d?: [string, string[]]): string | undefined {
  if (!d || !d[1] || !d[1].length) return undefined;
  const lines: string[] = [];
  lines.push(d[0] ?? '');
  for (const m of d[1]) lines.push(m);
  return lines.join('\n');
}

// ── 记录装配（按 z 码点升序排序，保证二分查找正确） ─────────────
interface Rec {
  z: string; y?: string; p?: string; a?: string; c?: string; m?: string;
  e?: string; n?: string; d?: string; s: boolean; q: boolean;
}

const recs: Rec[] = base.map((b, i) => {
  const x = extra[i] ?? {};
  const z = b.z ?? '';
  if (!z) throw new Error(`第 ${i} 条缺 z 字段`);
  return {
    z,
    y: b.y, p: b.p, a: b.a,
    c: x.c, m: x.m,
    e: x.e, n: x.n,
    d: encodeMeanings(x.d),
    s: b.s === 1, q: b.q === 1,
  };
});

// 按 z 的首个码点升序（同码点保持原顺序——stable sort）
const sorted = recs
  .map((r, idx) => ({ r, idx, cp: r.z.codePointAt(0)! }))
  .sort((a, b) => a.cp - b.cp || a.idx - b.idx)
  .map(x => x.r);

// ── 释义倒排索引(d/e/n 并集)固化到文件尾部 ─────────────────────
// search_meaning 对 d/e/n 做子串反查,全表扫描为 O(N) 且每条都要解码字符串。
// 这里把「字符 → 含该字符的记录 ID(升序)」倒排表固化进 dict.bin:
// 查询时取 posting 最短的查询字符做锚点,只对候选集做完整子串验证。
// posting 超过 INDEX_MAX_POSTING 的超频字(之/水/名等)不收录,单独记入排除表——
// 引擎据此区分「超频字」(回退全扫)与「语料中不存在」(直接返回空)。

/** 收录的 posting 长度上限 */
const INDEX_MAX_POSTING = 4096;

interface MeaningIndex {
  /** 收录字符,按码点升序 */
  chars: Array<{ cp: number; len: number; off: number }>;
  /** 超频排除字符(posting 过长),按码点升序 */
  excluded: Array<{ cp: number; count: number }>;
  /** LEB128 varint 增量 posting 流 */
  posting: number[];
}

function pushVarint(out: number[], n: number): void {
  for (;;) {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
    if (!n) return;
  }
}

function buildMeaningIndex(recs: Rec[]): MeaningIndex {
  const postings = new Map<number, Set<number>>();
  recs.forEach((r, i) => {
    const text = (r.d ?? '') + (r.e ?? '') + (r.n ?? '');
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      let ids = postings.get(cp);
      if (!ids) { ids = new Set(); postings.set(cp, ids); }
      ids.add(i);
    }
  });
  const entries = [...postings.entries()].sort((a, b) => a[0] - b[0]);
  const chars: MeaningIndex['chars'] = [];
  const excluded: MeaningIndex['excluded'] = [];
  const posting: number[] = [];
  for (const [cp, ids] of entries) {
    if (ids.size > INDEX_MAX_POSTING) {
      excluded.push({ cp, count: ids.size });
      continue;
    }
    const off = posting.length;
    let prev = -1;
    for (const id of [...ids].sort((a, b) => a - b)) {
      pushVarint(posting, id - prev - 1);
      prev = id;
    }
    chars.push({ cp, len: ids.size, off });
  }
  return { chars, excluded, posting };
}

/** 索引区布局:"XTIX\0" + charCount(u32) + exclCount(u32) + 字符表(10B/条) + 排除表(8B/条) + posting 流 */
function serializeIndex(idx: MeaningIndex): Buffer {
  const buf = Buffer.alloc(13 + idx.chars.length * 10 + idx.excluded.length * 8 + idx.posting.length);
  buf.write('XTIX\0', 0, 'ascii');
  buf.writeUInt32LE(idx.chars.length, 5);
  buf.writeUInt32LE(idx.excluded.length, 9);
  let p = 13;
  for (const c of idx.chars) {
    buf.writeUInt32LE(c.cp, p);
    buf.writeUInt16LE(c.len, p + 4);
    buf.writeUInt32LE(c.off, p + 6);   // 相对 posting 流起始
    p += 10;
  }
  for (const e of idx.excluded) {
    buf.writeUInt32LE(e.cp, p);
    buf.writeUInt32LE(e.count, p + 4);
    p += 8;
  }
  for (let i = 0; i < idx.posting.length; i++) buf[p + i] = idx.posting[i];
  return buf;
}

// ── 序列化 ──────────────────────────────────────────────────────
const recordTableSize = sorted.length * RECORD_SIZE;
const tableOffset = HEADER_SIZE;
const poolOffset = HEADER_SIZE + recordTableSize;

const out = Buffer.alloc(HEADER_SIZE + recordTableSize + pool.length);

// Header
out.write('XTEXT\0', 0, 'ascii');
out.writeUInt8(1, 6);
out.writeBigUInt64LE(BigInt(sorted.length), 8);
out.writeBigUInt64LE(BigInt(tableOffset), 16);
out.writeBigUInt64LE(BigInt(poolOffset), 24);

for (let i = 0; i < sorted.length; i++) {
  const r = sorted[i];
  const addr = tableOffset + i * RECORD_SIZE;
  const w = (off: number, len: number, field: 'u32' | 'u16', at: number) => {
    if (field === 'u32') out.writeUInt32LE(off, addr + at);
    else out.writeUInt16LE(len, addr + at);
  };
  const [zOff, zLen] = intern(r.z);   w(zOff, zLen, 'u32', 0); w(zOff, zLen, 'u16', 4);
  const [yOff, yLen] = intern(r.y);   w(yOff, yLen, 'u32', 6); w(yOff, yLen, 'u16', 10);
  const [pOff, pLen] = intern(r.p);   w(pOff, pLen, 'u32', 12); w(pOff, pLen, 'u16', 16);
  const [aOff, aLen] = intern(r.a);   w(aOff, aLen, 'u32', 18); w(aOff, aLen, 'u16', 22);
  const [cOff, cLen] = intern(r.c);   w(cOff, cLen, 'u32', 24); w(cOff, cLen, 'u16', 28);
  const [mOff, mLen] = intern(r.m);   w(mOff, mLen, 'u32', 30); w(mOff, mLen, 'u16', 34);
  const [eOff, eLen] = intern(r.e);   w(eOff, eLen, 'u32', 36); w(eOff, eLen, 'u16', 40);
  const [nOff, nLen] = intern(r.n);   w(nOff, nLen, 'u32', 42); w(nOff, nLen, 'u16', 46);
  const [dOff, dLen] = intern(r.d);   w(dOff, dLen, 'u32', 48); w(dOff, dLen, 'u16', 52);
  let flags = 0;
  if (r.s) flags |= 1;
  if (r.q) flags |= 2;
  out.writeUInt8(flags, addr + 54);
}

pool.copy(out, poolOffset, 0, poolLen);

// ── 追加释义倒排索引与 trailer ──────────────────────────────────
const index = buildMeaningIndex(sorted);
const indexBuf = serializeIndex(index);
const indexOffset = poolOffset + poolLen;
const trailer = Buffer.alloc(8);
trailer.writeBigUInt64LE(BigInt(indexOffset), 0);
const final = Buffer.concat([out.subarray(0, poolOffset + poolLen), indexBuf, trailer]);
writeFileSync('src/assets/dict.bin', final);

console.log(`✓ dict.bin: ${sorted.length} 记录, ${(final.length / 1024 / 1024).toFixed(2)} MB (pool ${(poolLen / 1024 / 1024).toFixed(2)} MB, 索引 ${(indexBuf.length / 1024).toFixed(0)} KB: ${index.chars.length} 字符 + ${index.excluded.length} 超频排除)`);
