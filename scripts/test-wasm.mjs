import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';

const wasm = fs.readFileSync('moonbit/xtext_core/_build/wasm-gc/release/build/xtext_core.wasm');
const dictBytes = fs.readFileSync('src/assets/dict.bin');
const dictB64 = dictBytes.toString('base64');

const stringImports = new Proxy({}, { get: (_, name) => (typeof name === 'string' ? name : '') });

const { instance } = await WebAssembly.instantiate(wasm, { _: stringImports }, { builtins: ['js-string'] });
const ex = instance.exports;

console.log('records:', ex.load_dict(dictB64));
console.log('index_status:', ex.index_status() === 1 ? 'loaded' : 'absent (全扫回退)');
console.log('search_z 道:', JSON.parse(ex.search_z('道')));
console.log('exact LU:', JSON.parse(ex.search_exact('LU')).length);
console.log("exact l'uq:", JSON.parse(ex.search_exact("l'uq")).length);
console.log('prefix kʷ:', JSON.parse(ex.search_prefix('kʷ')).length);
console.log('contains y ʔ:', JSON.parse(ex.search_contains(1, 'ʔ')).length);
console.log('meaning 丈夫:', JSON.parse(ex.search_meaning('丈夫')).length);
console.log('domain LU:', JSON.parse(ex.search_domain_prefix('LU')).length);
const t0 = Date.now();
console.log('meaning 之:', JSON.parse(ex.search_meaning('之')).length, Date.now() - t0 + 'ms');
console.log('get_json sample:', ex.get_json(9193).slice(0, 150));

// ── 释义倒排索引正确性:以 JSON 源暴力扫描为基准逐条比对 ─────────────
// 复现 encode-dict.ts 的排序与 d 编码,得到"排序后记录 ID → d/e/n"基准。
const base = JSON.parse(gunzipSync(fs.readFileSync('src/assets/base.json.gz')).toString());
const extra = JSON.parse(gunzipSync(fs.readFileSync('src/assets/extra.json.gz')).toString());

const encodeMeanings = d => (!d || !d[1] || !d[1].length) ? undefined : [d[0] ?? '', ...d[1]].join('\n');
const sorted = base
  .map((b, idx) => ({
    z: b.z ?? '',
    d: encodeMeanings(extra[idx]?.d),
    e: extra[idx]?.e,
    n: extra[idx]?.n,
    idx,
    cp: (b.z ?? '').codePointAt(0),
  }))
  .sort((a, b) => a.cp - b.cp || a.idx - b.idx);

function bruteMeaning(q) {
  const hits = [];
  sorted.forEach((r, i) => {
    if ((r.d && r.d.includes(q)) || (r.e && r.e.includes(q)) || (r.n && r.n.includes(q))) hits.push(i);
  });
  return hits;
}

let failures = 0;
function checkMeaning(q) {
  const got = JSON.parse(ex.search_meaning(q));
  const want = bruteMeaning(q);
  const ok = got.length === want.length && got.every((v, i) => v === want[i]);
  if (!ok) {
    failures++;
    console.log(`  ✗ "${q}": got ${got.length} [${got.slice(0, 5)}...] want ${want.length} [${want.slice(0, 5)}...]`);
  }
  return { got: got.length, want: want.length };
}

console.log('\n── 索引 vs 暴力扫描 一致性 ──');
const queries = ['丈夫', '道路', '水名', '祭祀', '樂器', '白色', '美', '美好', '姓氏', '大水', '古代樂器', '龜甲', '之', '天', '人名', '星名', "l'uq", 'LU', 'oracle'];
for (const q of queries) {
  const { got, want } = checkMeaning(q);
  console.log(`  "${q}" 命中 ${got}(基准 ${want})`);
}

// 非 BMP 码点:从 d/e/n 语料中取一个扩展区字符做单字查询
let extChar = '';
outer: for (const r of sorted) {
  const text = (r.d ?? '') + (r.e ?? '') + (r.n ?? '');
  for (const ch of text) {
    if (ch.codePointAt(0) > 0xFFFF) { extChar = ch; break outer; }
  }
}
if (extChar) {
  const { got, want } = checkMeaning(extChar);
  console.log(`  "${extChar}"(U+${extChar.codePointAt(0).toString(16).toUpperCase()}) 命中 ${got}(基准 ${want})`);
}

// 语料外字符:在 CJK 基本区找一个 d/e/n 中不存在的码点 → 应直接返回空
const corpusCps = new Set();
for (const r of sorted) for (const ch of (r.d ?? '') + (r.e ?? '') + (r.n ?? '')) corpusCps.add(ch.codePointAt(0));
let absentChar = '';
for (let cp = 0x4E00; cp < 0x9FFF; cp++) {
  if (!corpusCps.has(cp)) { absentChar = String.fromCodePoint(cp); break; }
}
if (absentChar) {
  const { got, want } = checkMeaning(absentChar);
  console.log(`  "${absentChar}"(语料外) 命中 ${got}(基准 ${want})`);
  checkMeaning(`道${absentChar}`); // 混合语料外字符 → 也应为空
}

// ── 耗时对比(索引路径 vs 全扫回退) ──
function timeMeaning(q, iters = 5) {
  ex.search_meaning(q); // 预热
  let best = Infinity;
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    ex.search_meaning(q);
    best = Math.min(best, performance.now() - t);
  }
  return best;
}
console.log('\n── 耗时(5 次取最优)──');
console.log(`  水名(索引,候选 ~1.5k): ${timeMeaning('水名').toFixed(2)}ms`);
console.log(`  祭祀(索引,候选 ~330):  ${timeMeaning('祭祀').toFixed(2)}ms`);
console.log(`  之(超频,全扫回退):     ${timeMeaning('之').toFixed(2)}ms`);

// ── 旧格式兼容:截掉索引区与 trailer 后应回退全扫且结果一致 ──
const indexOffset = Number(dictBytes.readBigUInt64LE(dictBytes.length - 8));
const indexMagicOk = dictBytes.toString('binary', indexOffset, indexOffset + 5) === 'XTIX\0';
console.log(`\ntrailer 解析: indexOffset=${indexOffset}, 魔数 ${indexMagicOk ? '✓ XTIX' : '✗ 不符'}`);
if (!indexMagicOk) failures++;
const legacy = dictBytes.subarray(0, indexOffset);
if (legacy.toString('binary', 0, 5) === 'XTEXT') {
  const { instance: legacyInst } = await WebAssembly.instantiate(wasm, { _: stringImports }, { builtins: ['js-string'] });
  const lex = legacyInst.exports;
  const n = lex.load_dict(legacy.toString('base64'));
  // 条数随上游增补变化,与新版引擎的 count 对齐即可,勿硬编码
  const legacyOk = lex.index_status() === 0 && n === ex.record_count() &&
    JSON.stringify(JSON.parse(lex.search_meaning('丈夫'))) === JSON.stringify(bruteMeaning('丈夫')) &&
    JSON.stringify(JSON.parse(lex.search_meaning('之'))) === JSON.stringify(bruteMeaning('之'));
  console.log(`\n旧格式(无索引)兼容: ${legacyOk ? '✓ 回退全扫,结果一致' : '✗ 失败'}`);
  if (!legacyOk) failures++;
}

console.log(failures === 0 ? '\n✓ 全部校验通过' : `\n✗ ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
