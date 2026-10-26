import { describe, expect, test, beforeAll } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { DictEngine, safeRegex, CJK_RE, BATCH_MAX_LENGTH, type DictItem } from '../src/core/dict-engine';

const base: DictItem[] = JSON.parse(gunzipSync(readFileSync('src/assets/base.json.gz')).toString());
const extra: DictItem[] = JSON.parse(gunzipSync(readFileSync('src/assets/extra.json.gz')).toString());

const engine = new DictEngine();

beforeAll(() => {
  engine.dictData = base;
  extra.forEach((ext, i) => Object.assign(engine.dictData[i], ext));
  engine.buildIndexes({ includeExtra: true });
});

describe('数据契约', () => {
  test('base/extra 条目数一致（上游会增补条目，勿硬编码条数）', () => {
    expect(base.length).toBe(extra.length);
    expect(base.length).toBeGreaterThan(10000); // 防灾难性上游变更的兜底
  });
});

describe('默认模式（自动分词查询）', () => {
  test('单字精确命中 zIndex', () => {
    const { results } = engine.search('道', 'default');
    expect(results!.some(i => i.z === '道')).toBe(true);
    expect(results![0].z).toBe('道');
  });

  test('多字输入逐字展开', () => {
    const { results } = engine.search('道德', 'default');
    expect(results!.some(i => i.z === '道')).toBe(true);
    expect(results!.some(i => i.z === '德')).toBe(true);
  });

  test('拼音 token 命中', () => {
    const { results } = engine.search('pa', 'default');
    expect(results!.some(i => i.z === '夫')).toBe(true);
  });

  test('拟音 token 命中', () => {
    const { results } = engine.search("l'uq", 'default');
    expect(results!.some(i => i.z === '道')).toBe(true);
  });

  test('大写 token 模糊匹配谐声域', () => {
    const { results } = engine.search('LU', 'default');
    expect(results!.some(i => i.a === 'LU')).toBe(true);
  });

  test('非汉字 token 对拟音/拼音做子串匹配', () => {
    const { results } = engine.search('lˤu', 'default');
    expect(results!.length).toBeGreaterThan(0);
  });
});

describe('精确模式', () => {
  test('完整符合字头', () => {
    const { results } = engine.search('道', 'exact');
    expect(results!.every(i => i.z === '道' || i.p === '道' || i.y === '道' || i.a === '道' || i.m === '道')).toBe(true);
    expect(results!.some(i => i.z === '道')).toBe(true);
  });

  test('"引号" 触发精确模式', () => {
    const { results } = engine.search('"LU"', 'default');
    expect(results!.some(i => i.a === 'LU')).toBe(true);
  });
});

describe('正则模式', () => {
  test('/pattern/flags 语法', () => {
    const { results } = engine.search('/^k/', 'default');
    expect(results!.length).toBeGreaterThan(0);
  });

  test('regex 模式匹配拟音', () => {
    const { results } = engine.search('ʔ$', 'regex');
    expect(results!.length).toBeGreaterThan(0);
  });

  test('ReDoS 危险模式被拒绝', () => {
    expect(safeRegex('(\\w+\\+)+').ok).toBe(false);
    expect(safeRegex('(.*.*)*').ok).toBe(false);
  });

  test('超长正则被拒绝', () => {
    expect(safeRegex('a'.repeat(101)).ok).toBe(false);
  });

  test('语法错误返回提示', () => {
    const r = safeRegex('([');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.msg).toContain('正則語法錯誤');
  });
});

describe('释义反查模式', () => {
  test('从释义文字反查字头', () => {
    const { results } = engine.search('丈夫', 'meaning');
    expect(results!.some(i => i.z === '夫')).toBe(true);
  });
});

describe('批量标音', () => {
  test('逐字标注，保留顺序与重复', () => {
    const rows = engine.batchAnalyze('道德道');
    expect(rows.length).toBe(3);
    expect(rows[0].char).toBe('道');
    expect(rows[2].char).toBe('道');
    expect(rows[0].items.length).toBeGreaterThan(0);
  });

  test('未收录字返回空 items', () => {
    const rows = engine.batchAnalyze('龘');
    expect(rows.length === 0 || rows[0].items.length === 0).toBe(true);
  });

  test('非汉字字符被过滤', () => {
    const rows = engine.batchAnalyze('道abc德 123');
    expect(rows.length).toBe(2);
  });

  test('超长文本截取', () => {
    const rows = engine.batchAnalyze('道'.repeat(BATCH_MAX_LENGTH + 100));
    expect(rows.length).toBe(BATCH_MAX_LENGTH);
  });

  test('Ext-B 生僻字（代理对）按码点处理', () => {
    expect(CJK_RE.test('𠀀')).toBe(true);
    const rows = engine.batchAnalyze('𠀀');
    expect(rows.length).toBe(1);
  });
});

describe('排序', () => {
  test('按拼音排序', () => {
    const { results } = engine.search('道德仁', 'default');
    const sorted = engine.sortResults(results!, 'pinyin');
    expect(sorted.length).toBe(results!.length);
  });

  test('默认排序保持原顺序', () => {
    const { results } = engine.search('道', 'default');
    expect(engine.sortResults(results!, 'default')).toBe(results);
  });
});
