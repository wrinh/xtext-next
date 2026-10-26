/**
 * MoonBit 引擎检索适配层
 *
 * 把 WASM 引擎的索引查询包装成与原 DictEngine 相同的接口，
 * 供 pboc-app 使用。所有查询通过 WASM 引擎完成，结果懒取 JSON。
 */
import { loadWasm, bufferToBase64, type WasmExports } from './wasm-engine';
import type { DictItem, SearchMode, SortKey } from './dict-engine';
import { CJK_RE, CJK_TOKEN_RE, BATCH_MAX_LENGTH } from './dict-engine';

export { BATCH_MAX_LENGTH };

interface Engine {
  ex: WasmExports;
  count: number;
}

let engine: Engine | null = null;
let extraLoaded = false;

/** 引擎加载进度回调 */
export type ProgressFn = (loaded: number, total: number) => void;

export async function initEngine(onProgress?: ProgressFn): Promise<number> {
  const ex = await loadWasm();

  // 下载 dict.bin(传输压缩由 CDN 按 Accept-Encoding 自动协商)
  const resp = await fetch('assets/dict.bin');
  if (!resp.ok) throw new Error(`dict.bin 加载失败: ${resp.status}`);
  const total = Number(resp.headers.get('content-length') || 0);
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('响应无 body');

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }

  // 合并 chunks
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { combined.set(c, offset); offset += c.length; }

  const b64 = bufferToBase64(combined.buffer as ArrayBuffer);
  const count = ex.load_dict(b64);
  if (count <= 0) throw new Error('dict.bin 魔数错误');
  engine = { ex, count };
  extraLoaded = true;
  return count;
}

export function isEngineReady(): boolean { return engine !== null; }
export function isExtraLoaded(): boolean { return extraLoaded; }
export function recordCount(): number { return engine?.count ?? 0; }

// ── 索引查询（返回记录索引数组） ──────────────────────────────────────────

function hitsArray(json: string): number[] {
  try { return JSON.parse(json) as number[]; } catch { return []; }
}

export function searchZ(query: string): number[] {
  if (!engine) return [];
  return hitsArray(engine.ex.search_z(query));
}

export function searchExact(query: string): number[] {
  if (!engine) return [];
  return hitsArray(engine.ex.search_exact(query));
}

export function searchPrefix(query: string): number[] {
  if (!engine) return [];
  return hitsArray(engine.ex.search_prefix(query));
}

export function searchContains(field: number, query: string): number[] {
  if (!engine) return [];
  return hitsArray(engine.ex.search_contains(field, query));
}

export function searchDomainPrefix(query: string): number[] {
  if (!engine) return [];
  return hitsArray(engine.ex.search_domain_prefix(query));
}

export function searchMeaning(query: string): number[] {
  if (!engine) return [];
  return hitsArray(engine.ex.search_meaning(query));
}

// ── 记录读取 ───────────────────────────────────────────────────────────────

const jsonCache = new Map<number, DictItem>();

export function getRecord(idx: number): DictItem | null {
  if (!engine) return null;
  const cached = jsonCache.get(idx);
  if (cached) return cached;
  const json = engine.ex.get_json(idx);
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const item = normalizeRecord(raw);
    if (jsonCache.size > 5000) jsonCache.clear();
    jsonCache.set(idx, item);
    return item;
  } catch {
    return null;
  }
}

function normalizeRecord(raw: Record<string, unknown>): DictItem {
  const d = typeof raw.d === 'string' ? raw.d : '';
  let dTuple: [string, string[]] | undefined;
  if (d) {
    const lines = d.split('\n');
    const note = lines.length > 1 ? lines[0] : '';
    const meanings = lines.length > 1 ? lines.slice(1) : lines;
    dTuple = [note, meanings.filter(m => m.trim())];
  }
  return {
    z: str(raw.z), y: str(raw.y), p: str(raw.p), a: str(raw.a),
    c: str(raw.c), m: str(raw.m), e: str(raw.e), n: str(raw.n),
    d: dTuple,
    s: raw.s === 1 ? 1 : 0,
    q: raw.q === 1 ? 1 : 0,
  };
}

function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

// ── 高层搜索（与原 DictEngine.search 行为一致） ────────────────────────────

export interface SearchOutcome {
  results: DictItem[] | null;
  regexError?: string;
}

const INDEX_FIELD: Record<string, number> = { z: 0, y: 1, p: 2, a: 3 };

export function search(query: string, mode: SearchMode): SearchOutcome {
  if (!engine || !query) return { results: [] };

  switch (mode) {
    case 'default': {
      // 与原版一致：空白分词；CJK 串逐字拆分（含非 BMP 扩展区汉字）；其余按整 token 处理
      let tokens: string[] = [];
      for (const part of query.split(/\s+/)) {
        if (!part) continue;
        const matches = part.match(CJK_TOKEN_RE);
        if (matches) {
          for (const m of matches) {
            if (CJK_RE.test(m)) tokens.push(...Array.from(m));
            else tokens.push(m);
          }
        }
      }
      if (!tokens.length) tokens = [query];

      const results: DictItem[] = [];
      const seen = new Set<number>();
      const push = (idx: number): void => {
        if (!seen.has(idx)) {
          seen.add(idx);
          const rec = getRecord(idx);
          if (rec) results.push(rec);
        }
      };
      const pushAll = (idxs: number[]): void => { idxs.forEach(push); };

      for (const token of tokens) {
        const isUpper = /^[A-Z0-9]+$/.test(token);
        const isHan = CJK_RE.test(token);
        pushAll(searchZ(token));                        // z 精确（码点级，支持扩展区）
        pushAll(searchExact(token));                    // y/p/a/m 精确
        if (isUpper) pushAll(searchContains(3, token)); // 諧聲域包含
        if (!isHan) {                                   // y/p 子串扫描
          pushAll(searchContains(1, token));
          pushAll(searchContains(2, token));
        }
      }
      return { results };
    }

    case 'exact': {
      const hits = searchExact(query);
      return { results: hits.map(getRecord).filter((r): r is DictItem => r !== null) };
    }

    case 'regex': {
      const safe = safeRegex(query);
      if (!safe.ok) return { results: null, regexError: safe.msg };
      const re = safe.regex;
      const hits: number[] = [];
      for (let i = 0; i < engine.count; i++) {
        const item = getRecord(i);
        if (!item) continue;
        if ((item.y && re.test(item.y)) || (item.p && re.test(item.p))) hits.push(i);
      }
      re.lastIndex = 0;
      return { results: hits.map(getRecord).filter((r): r is DictItem => r !== null) };
    }

    case 'meaning': {
      const hits = searchMeaning(query);
      return { results: hits.map(getRecord).filter((r): r is DictItem => r !== null) };
    }

    case 'batch':
      return { results: [] };

    default:
      return { results: [] };
  }
}

// ReDoS 防护（与原 safeRegex 相同）
export function safeRegex(pattern: string, flags = ''): { ok: true; regex: RegExp } | { ok: false; msg: string } {
  try {
    const regex = new RegExp(pattern, flags);
    if (!flags.includes('g') && !flags.includes('y')) regex.lastIndex = 0;
    return { ok: true, regex };
  } catch (e) {
    return { ok: false, msg: `正則表達式無效：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── 批量分析 ───────────────────────────────────────────────────────────────

export interface BatchRow { char: string; items: DictItem[]; }

export function batchAnalyze(text: string): BatchRow[] {
  if (!engine) return [];
  const chars = Array.from(text).slice(0, BATCH_MAX_LENGTH);
  const rows: BatchRow[] = [];
  for (const ch of chars) {
    if (!CJK_RE.test(ch)) continue;
    const hits = searchZ(ch);
    const items = hits.map(getRecord).filter((r): r is DictItem => r !== null);
    rows.push({ char: ch, items });
  }
  return rows;
}

// ── 排序 ───────────────────────────────────────────────────────────────────

export function sortResults(items: DictItem[], key: SortKey): DictItem[] {
  if (key === 'default') return [...items];
  const collator = new Intl.Collator('zh-Hant', { numeric: true });
  const sorted = [...items];
  switch (key) {
    case 'pinyin':
      sorted.sort((a, b) => collator.compare(a.p || '', b.p || '') || collator.compare(a.z || '', b.z || ''));
      break;
    case 'phonetic':
      sorted.sort((a, b) => collator.compare(a.y || '', b.y || '') || collator.compare(a.z || '', b.z || ''));
      break;
    case 'domain':
      sorted.sort((a, b) => collator.compare(a.a || '', b.a || '') || collator.compare(a.z || '', b.z || ''));
      break;
  }
  return sorted;
}

export { CJK_RE, CJK_TOKEN_RE };
