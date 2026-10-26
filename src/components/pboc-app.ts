import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// @material/web M3 组件
import '@material/web/textfield/filled-text-field.js';
import '@material/web/button/filled-button.js';
import '@material/web/button/outlined-button.js';
import '@material/web/button/text-button.js';
import '@material/web/iconbutton/icon-button.js';
import '@material/web/iconbutton/filled-icon-button.js';
import '@material/web/chips/filter-chip.js';
import '@material/web/progress/circular-progress.js';
import '@material/web/divider/divider.js';

import {
  initEngine, isEngineReady, recordCount,
  search as engineSearch, batchAnalyze, sortResults,
  BATCH_MAX_LENGTH,
  type BatchRow,
} from '../core/moonbit-dict';
import { startUpdateCheck, applyUpdate as reloadForUpdate } from '../core/update-check';
import { safeRegex } from '../core/dict-engine';
import type { DictItem, SearchMode, SortKey } from '../core/dict-engine';
import { icon, iconString } from './icons';

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [20, 50, 100, 200];
const PAGE_SIZE_STORAGE_KEY = 'pboc-page-size';
const HISTORY_STORAGE_KEY = 'pboc-search-history';
const HISTORY_MAX = 20;
const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'default', label: '默認順序' },
  { value: 'pinyin', label: '按拼音' },
  { value: 'phonetic', label: '按擬音' },
  { value: 'domain', label: '按諧聲域' },
];
const MODE_LABELS: Record<string, string> = {
  default: '默認', exact: '精確', regex: '正則', meaning: '釋義', batch: '批量',
};

interface HistoryItem { query: string; mode: string; }

declare global {
  interface Window { htmlToImage?: any; }
}

function escapeHtml(unsafe: unknown): string {
  if (typeof unsafe !== 'string') return unsafe as string;
  return unsafe
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/**
 * <pboc-app> —— PBOC 查詢主應用（M3 版本）
 * 使用 @material/web 组件 + MoonBit WASM 引擎。
 */
@customElement('pboc-app')
export class PbocApp extends LitElement {
  override createRenderRoot() { return this; }

  @state() private loading = true;
  @state() private loadError = false;
  @state() private loadProgress = '';
  @state() private extraStatus = '';
  @state() private extraStatusError = false;
  @state() private dataUpdatedAt = '資料最後更新：讀取中…';

  @state() private currentQuery = '';
  @state() private currentMode: SearchMode = 'default';
  @state() private currentSort: SortKey = 'default';
  @state() private currentPage = 1;
  @state() private pageSize = this.readStoredPageSize();
  @state() private currentResults: DictItem[] = [];
  @state() private batchRows: BatchRow[] | null = null;
  @state() private batchTruncated = false;
  @state() private regexError = '';
  @state() private hasSearched = false;
  @state() private history: HistoryItem[] = this.readSearchHistory();
  @state() private inputValue = '';
  @state() private updateReady = false;

  private pendingUrlPage = 1;
  private dictionaryLoading = false;
  private imageExportLoader: Promise<any> | null = null;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('popstate', this.loadFromUrl);
    document.addEventListener('keydown', this.globalKeyHandler);
    startUpdateCheck(() => { this.updateReady = true; });
    void this.initDictionary();
  }

  override disconnectedCallback() {
    window.removeEventListener('popstate', this.loadFromUrl);
    document.removeEventListener('keydown', this.globalKeyHandler);
    super.disconnectedCallback();
  }

  private globalKeyHandler = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isTyping = target && (
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' || target.isContentEditable
    );
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping) {
      e.preventDefault();
      this.querySelector('md-filled-text-field')?.focus();
    }
  };

  // ── 字典加载（MoonBit WASM 引擎） ──
  private async initDictionary() {
    if (this.dictionaryLoading) return;
    this.dictionaryLoading = true;
    this.loading = true;
    this.loadError = false;

    try {
      const count = await initEngine((loaded, total) => {
        this.loadProgress = total
          ? `加載字庫... ${Math.round((loaded / total) * 100)}%`
          : `加載字庫... ${(loaded / 1024 / 1024).toFixed(2)} MB`;
      });
      this.dataUpdatedAt = `資料最後更新：${new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      }).format(new Date())}`;
      this.loading = false;
      this.loadProgress = '';
      this.loadFromUrl();
    } catch (error) {
      console.error('字典加載錯誤:', error);
      this.loading = false;
      this.loadError = true;
      this.loadProgress = '';
      this.dictionaryLoading = false;
    }
  }

  // ── URL 状态同步 ──
  private loadFromUrl = () => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    const mode = params.get('mode');
    const sort = params.get('sort');
    this.pageSize = this.normalizePageSize(params.get('size') || String(this.pageSize));
    this.pendingUrlPage = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
    this.currentSort = (sort && SORT_OPTIONS.some(o => o.value === sort)) ? sort as SortKey : 'default';
    if (mode && ['default', 'exact', 'regex', 'meaning', 'batch'].includes(mode)) {
      this.currentMode = mode as SearchMode;
    }

    if (q) {
      this.inputValue = q;
      this.searchDict(false);
    } else {
      this.inputValue = '';
      this.currentQuery = '';
      this.currentResults = [];
      this.batchRows = null;
      this.hasSearched = false;
    }
  };

  private updateSearchUrl() {
    const url = new URL(window.location.href);
    if (this.currentQuery) {
      url.searchParams.set('q', this.currentQuery);
      url.searchParams.set('mode', this.currentMode);
      if (this.currentPage > 1) url.searchParams.set('page', String(this.currentPage));
      else url.searchParams.delete('page');
      if (this.pageSize !== DEFAULT_PAGE_SIZE) url.searchParams.set('size', String(this.pageSize));
      else url.searchParams.delete('size');
      if (this.currentSort !== 'default') url.searchParams.set('sort', this.currentSort);
      else url.searchParams.delete('sort');
    } else {
      ['q', 'mode', 'page', 'size', 'sort'].forEach(k => url.searchParams.delete(k));
    }
    if (window.location.search !== url.search) window.history.pushState({}, '', url);
  }

  // ── 搜索 ──
  /** 普通模式最大输入字数（按 Unicode 码点计） */
  private static readonly INPUT_MAX = 100;

  /**
   * 码点安全的输入处理：超出上限时按码点截断。
   * 不用原生 maxlength——HTML 規範按 UTF-16 码元计数，扩展区汉字（代理对）会被算成 2 个。
   */
  private handleInput(e: Event): void {
    const el = e.target as HTMLInputElement;
    const raw = el.value;
    const max = this.currentMode === 'batch' ? BATCH_MAX_LENGTH : PbocApp.INPUT_MAX;
    const cps = Array.from(raw);
    if (cps.length > max) {
      const value = cps.slice(0, max).join('');
      el.value = value;
      this.inputValue = value;
    } else {
      this.inputValue = raw;
    }
  }

  private searchDict(updateUrl = true) {    const query = this.inputValue.trim();
    this.currentQuery = query;
    this.currentResults = [];
    this.batchRows = null;
    this.regexError = '';
    this.currentPage = updateUrl ? 1 : this.pendingUrlPage;

    if (!query) {
      this.hasSearched = false;
      if (updateUrl) this.updateSearchUrl();
      return;
    }
    this.hasSearched = true;

    if (this.currentMode === 'batch') {
      const rows = batchAnalyze(query);
      this.batchRows = rows.length ? rows : [];
      this.batchTruncated = Array.from(query).length > BATCH_MAX_LENGTH;
      if (updateUrl) this.updateSearchUrl();
      return;
    }

    const { results, regexError } = engineSearch(query, this.currentMode);
    if (regexError) { this.regexError = regexError; return; }
    this.currentResults = results ?? [];
    if (this.currentResults.length > 0) this.addSearchHistory(query, this.currentMode);
    if (updateUrl) this.updateSearchUrl();
  }

  private searchExact(value: string) {
    this.inputValue = value;
    this.currentMode = 'exact';
    this.searchDict();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── 分页 / 排序 ──
  private get sortedResults() { return sortResults(this.currentResults, this.currentSort); }

  private goToPage(page: number) {
    const totalPages = Math.max(1, Math.ceil(this.currentResults.length / this.pageSize));
    const next = Math.min(Math.max(1, page), totalPages);
    if (next === this.currentPage) return;
    this.currentPage = next;
    this.updateSearchUrl();
    this.querySelector('.search-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private changePageSize(value: string) {
    this.pageSize = this.normalizePageSize(value);
    try { localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(this.pageSize)); } catch { /* noop */ }
    this.currentPage = 1;
    this.updateSearchUrl();
  }

  private changeSort(value: SortKey) {
    this.currentSort = value;
    this.currentPage = 1;
    this.updateSearchUrl();
  }

  private normalizePageSize(value: string): number {
    const parsed = parseInt(value, 10);
    return PAGE_SIZE_OPTIONS.includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
  }

  private readStoredPageSize(): number {
    try { return this.normalizePageSize(localStorage.getItem(PAGE_SIZE_STORAGE_KEY) || String(DEFAULT_PAGE_SIZE)); }
    catch { return DEFAULT_PAGE_SIZE; }
  }

  // ── 搜索历史 ──
  private readSearchHistory(): HistoryItem[] {
    try { return JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]'); } catch { return []; }
  }

  private addSearchHistory(query: string, mode: string) {
    if (!query || mode === 'batch') return;
    let h = this.readSearchHistory().filter(x => !(x.query === query && x.mode === mode));
    h.unshift({ query, mode });
    if (h.length > HISTORY_MAX) h.length = HISTORY_MAX;
    try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(h)); } catch { /* noop */ }
    this.history = h;
  }

  private removeHistoryItem(item: HistoryItem) {
    const h = this.readSearchHistory().filter(x => !(x.query === item.query && x.mode === item.mode));
    try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(h)); } catch { /* noop */ }
    this.history = h;
  }

  private clearHistory() {
    try { localStorage.setItem(HISTORY_STORAGE_KEY, '[]'); } catch { /* noop */ }
    this.history = [];
  }

  private openHistoryItem(item: HistoryItem) {
    this.inputValue = item.query;
    if (['default', 'exact', 'regex', 'meaning', 'batch'].includes(item.mode)) {
      this.currentMode = item.mode as SearchMode;
    }
    this.searchDict();
  }

  // ── 复制 / 导出 ──
  private async copyText(text: string, btn?: HTMLElement) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        btn.innerHTML = iconString('check', 18);
        setTimeout(() => { btn.innerHTML = iconString('content_copy', 18); }, 1500);
      }
    } catch (err) { console.error('複製失敗:', err); }
  }

  private loadImageExportLibrary(): Promise<any> {
    if (window.htmlToImage) return Promise.resolve(window.htmlToImage);
    if (this.imageExportLoader) return this.imageExportLoader;
    this.imageExportLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeoutId = window.setTimeout(() => {
        script.remove();
        reject(new Error('圖片導出組件加載超時'));
      }, 15000);
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html-to-image/1.11.11/html-to-image.min.js';
      script.async = true;
      script.onload = () => {
        window.clearTimeout(timeoutId);
        if (window.htmlToImage) resolve(window.htmlToImage);
        else reject(new Error('圖片導出組件未提供htmlToImage'));
      };
      script.onerror = () => {
        window.clearTimeout(timeoutId);
        script.remove();
        reject(new Error('圖片導出組件加載失敗'));
      };
      document.head.appendChild(script);
    }).catch(err => { this.imageExportLoader = null; throw err; });
    return this.imageExportLoader;
  }

  private safeFileName(value: string, fallback = 'result-card'): string {
    const cleaned = String(value || '')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
      .replace(/\s+/g, ' ').trim().slice(0, 60);
    return cleaned || fallback;
  }

  private async exportCard(card: HTMLElement) {
    const btn = card.querySelector<HTMLButtonElement>('.export-btn');
    if (!card || !btn || btn.disabled) return;
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = '準備中…';
    try {
      const htmlToImage = await this.loadImageExportLibrary();
      if (document.fonts?.ready) await document.fonts.ready;
      btn.textContent = '導出中…';
      const bgColor = window.getComputedStyle(card).backgroundColor;
      const dataUrl = await htmlToImage.toPng(card, {
        pixelRatio: Math.min(2, window.devicePixelRatio || 1),
        backgroundColor: bgColor,
        cacheBust: true,
        filter: (node: HTMLElement) => !node.classList?.contains('copy-btn') && !node.classList?.contains('export-btn'),
        style: { margin: '0', animation: 'none', transform: 'none', opacity: '1' },
      });
      const zi = this.safeFileName(card.dataset.char || '');
      const phonetic = this.safeFileName(card.dataset.phonetic || '', '');
      const link = document.createElement('a');
      link.download = phonetic ? `pboc-${zi}-${phonetic}.png` : `pboc-${zi}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      link.remove();
      btn.textContent = '已儲存';
    } catch (error) {
      console.error('圖片導出失敗:', error);
      btn.textContent = '導出失敗';
    } finally {
      btn.removeAttribute('aria-busy');
      window.setTimeout(() => { btn.innerHTML = originalHTML; btn.disabled = false; }, 1600);
    }
  }

  private batchCopy(format: 'tsv' | 'text', btn: HTMLElement) {
    if (!this.batchRows) return;
    if (format === 'tsv') {
      const lines = ['字\t拼音\t擬音\t諧聲域'];
      this.batchRows.forEach(row => {
        if (!row.items.length) lines.push(`${row.char}\t\t\t未收錄`);
        else row.items.forEach(item => lines.push(`${row.char}\t${item.p || ''}\t${item.y || ''}\t${item.a || ''}`));
      });
      this.copyText(lines.join('\n'), btn);
    } else {
      const parts: string[] = [];
      const seen = new Set<string>();
      this.batchRows.forEach(row => {
        if (seen.has(row.char)) return;
        seen.add(row.char);
        if (!row.items.length) parts.push(`${row.char}（?）`);
        else if (row.items.length === 1) parts.push(`${row.char}（${row.items[0].y || '?'}）`);
        else parts.push(`${row.char}（${row.items.map(it => it.y || '?').join(' / ')}）`);
      });
      this.copyText(parts.join('\n'), btn);
    }
  }

  // ── 文本渲染工具 ──
  private highlightMeaningSearchTerm(text: string): string {
    const escapedText = escapeHtml(text);
    if (this.currentMode !== 'meaning' || !this.currentQuery) return escapedText;
    const escapedQuery = escapeHtml(this.currentQuery);
    return escapedText.split(escapedQuery).join(`<mark class="meaning-search-hit">${escapedQuery}</mark>`);
  }

  private parseLinks(text: string, formatText: (s: string) => string = escapeHtml): string {
    if (!text) return text;
    const urlRegex = /((?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}(?:\/[a-zA-Z0-9._~:/?@!$&'()*+,;=%#-]*)?)/g;
    let htmlOut = '';
    let lastIndex = 0;
    for (const match of text.matchAll(urlRegex)) {
      const url = match[0];
      htmlOut += formatText(text.slice(lastIndex, match.index));
      const cleanUrl = url.replace(/[.,?!)\]]+$/, '');
      const trailingText = url.slice(cleanUrl.length);
      if (url.length < 7) {
        htmlOut += formatText(url);
        lastIndex = match.index! + url.length;
        continue;
      }
      const href = cleanUrl.startsWith('http') ? cleanUrl : 'https://' + cleanUrl;
      htmlOut += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" class="annotation-link">${escapeHtml(cleanUrl)}</a>`;
      htmlOut += formatText(trailingText);
      lastIndex = match.index! + url.length;
    }
    return htmlOut + formatText(text.slice(lastIndex));
  }

  private renderAnnotation(text: string): string {
    const lines = String(text).split(/\r?\n|\r/).filter(line => line.trim());
    if (!lines.length) return '';
    return `<ul class="annotation-list">${lines.map(line =>
      `<li>${this.parseLinks(line, s => this.highlightMeaningSearchTerm(s))}</li>`).join('')}</ul>`;
  }

  private pageWindow(page: number, totalPages: number): number[] {
    const pages = new Set([1, totalPages]);
    for (let p = page - 2; p <= page + 2; p++) {
      if (p >= 1 && p <= totalPages) pages.add(p);
    }
    return Array.from(pages).sort((a, b) => a - b);
  }

  // ── 模板 ──
  override render() {
    return html`
      <header class="page-header">
        <h1>
          <a href="https://zhuanlan.zhihu.com/p/12987993957" target="_blank" rel="noopener noreferrer">
            <span class="project-english-line">Philology-Based Old Chinese</span>
            <span class="project-chinese-line" lang="zh-Hant">基於文獻的上古漢語</span>
            <span class="project-acronym" aria-hidden="true">PBOC</span>
          </a>
        </h1>
      </header>

      <section class="search-container" role="search">
        <div class="search-box">
          <div class="field-wrap">
            <md-filled-text-field
              id="searchInput"
              .value="${this.inputValue}"
              placeholder="${this.loading ? '正在加載字庫…' : this.loadError ? '加載字典失敗，請檢查網絡' : this.currentMode === 'batch' && !this.inputValue ? `輸入古文文本（最多${BATCH_MAX_LENGTH}字），自動標注擬音…` : `已加載${recordCount()}條目—請輸入關鍵字`}"
              ?disabled="${this.loading}"
              autocomplete="off"
              spellcheck="false"
              @input="${(e: InputEvent) => this.handleInput(e)}"
              @keydown="${(e: KeyboardEvent) => e.key === 'Enter' && !e.isComposing && this.searchDict()}"
            >
              <span slot="leading-icon">${icon('search')}</span>
            </md-filled-text-field>
            <div class="char-counter" aria-live="polite">${Array.from(this.inputValue).length} / ${this.currentMode === 'batch' ? BATCH_MAX_LENGTH : PbocApp.INPUT_MAX}</div>
          </div>
          <md-filled-button
            ?disabled="${this.loading}"
            aria-label="${this.loading ? '加載中...' : this.loadError ? '重試' : '查詢'}"
            @click="${() => this.loadError ? (this.loadError = false, this.initDictionary()) : this.searchDict()}"
          >${this.loading ? '加載中...' : this.loadError ? '重試' : '查詢'}</md-filled-button>
        </div>

        <div class="search-options" role="group" aria-label="選擇搜索模式">
          ${(['default', 'exact', 'regex', 'meaning', 'batch'] as SearchMode[]).map(m => html`
            <md-filter-chip
              label="${MODE_LABELS[m]}"
              ?selected="${this.currentMode === m}"
              @click="${() => { this.currentMode = m; this.searchDict(); }}"
            ></md-filter-chip>
          `)}
        </div>
      </section>

      ${this.loadProgress ? html`
        <div class="loading-progress" role="status" aria-live="polite">
          <md-circular-progress indeterminate></md-circular-progress>
          <span>${this.loadProgress}</span>
        </div>
      ` : ''}

      ${this.extraStatus ? html`
        <div class="status-bar ${this.extraStatusError ? 'error' : ''}" role="status" aria-live="polite">
          ${this.extraStatus}
        </div>
      ` : ''}

      ${this.regexError ? html`
        <div class="regex-error" role="alert" aria-live="assertive">${this.regexError}</div>
      ` : ''}

      ${this.updateReady ? html`
        <div class="update-bar" role="status" aria-live="polite">
          <span>檢測到站點已發布新版本</span>
          <span>
            <md-text-button aria-label="刷新頁面以載入新版本"
                            @click="${() => this.applyUpdate()}">立即更新</md-text-button>
            <md-text-button aria-label="暫不更新,關閉提示"
                            @click="${() => this.dismissUpdate()}">暫不</md-text-button>
          </span>
        </div>
      ` : ''}

      ${!this.hasSearched && this.history.length ? this.renderHistory() : ''}

      <main class="results-main" aria-live="polite" aria-label="${this.hasSearched ? '查詢結果' : 'PBOC說明'}">
        ${this.renderMain()}
      </main>

      <footer class="site-footer">
        <p aria-live="polite">${this.dataUpdatedAt}</p>
        <p class="misans-attribution">字體支持：<a href="https://hyperos.mi.com/font-download/MiSans%E5%AD%97%E4%BD%93%E7%9F%A5%E8%AF%86%E4%BA%A7%E6%9D%83%E8%AE%B8%E5%8F%AF%E5%8D%8F%E8%AE%AE.pdf" target="_blank" rel="noopener">MiSans</a> (Copyright © Xiaomi Inc.)</p>
      </footer>

      <button class="back-to-top ${this.hasSearched ? 'visible' : ''}" type="button"
              aria-label="回到搜索框" title="回到搜索框"
              @click="${() => {
                this.querySelector('.search-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                (this.querySelector('md-filled-text-field') as HTMLElement | null)?.focus();
              }}">
        ${icon('arrow_upward', 16)}
        <span>搜索框</span>
      </button>
    `;
  }

  private applyUpdate(): void {
    void reloadForUpdate();
  }

  private dismissUpdate(): void {
    this.updateReady = false;
  }

  private renderHistory() {
    return html`
      <section class="search-history-section" aria-label="搜索歷史">
        <div class="search-history-header">
          <span class="search-history-title">${icon('history', 16)} 最近查詢</span>
          <md-text-button aria-label="清空歷史" @click="${this.clearHistory}">清空歷史</md-text-button>
        </div>
        <ul class="search-history-list">
          ${this.history.map(h => html`
            <li class="history-chip" role="button" tabindex="0"
                aria-label="再次查詢：${h.query}"
                @click="${(e: Event) => { if (!(e.target as HTMLElement).closest('.history-chip-delete')) this.openHistoryItem(h); }}"
                @keydown="${(e: KeyboardEvent) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !(e.target as HTMLElement).closest('.history-chip-delete')) {
                    e.preventDefault(); this.openHistoryItem(h);
                  }
                }}">
              <span class="history-chip-query" title="${h.query}">${h.query}</span>
              ${h.mode !== 'default' ? html`<span class="history-chip-mode">${MODE_LABELS[h.mode] || h.mode}</span>` : ''}
              <button class="history-chip-delete" type="button" title="刪除"
                      aria-label="刪除「${h.query}」"
                      @click="${() => this.removeHistoryItem(h)}">
                ${icon('close', 14)}
              </button>
            </li>
          `)}
        </ul>
      </section>
    `;
  }

  private renderMain() {
    if (!this.hasSearched || !this.currentQuery) return this.renderWelcome();
    if (this.currentMode === 'batch') return this.renderBatch();

    if (!this.currentResults.length) {
      return html`
        <div class="no-result" role="status">
          未找到「${this.currentQuery}」的相關條目<br>
          <span>可嘗試輸入單個漢字、拼音、諧聲域或使用正則</span>
        </div>`;
    }

    const sorted = this.sortedResults;
    const totalPages = Math.max(1, Math.ceil(sorted.length / this.pageSize));
    const page = Math.min(Math.max(1, this.currentPage), totalPages);
    const start = (page - 1) * this.pageSize;
    const display = sorted.slice(start, start + this.pageSize);

    return html`
      ${this.renderPaginationBar(sorted.length, page, totalPages, 'top')}
      ${display.map((item, idx) => this.renderResultCard(item, idx))}
      ${sorted.length > this.pageSize ? this.renderPaginationBar(sorted.length, page, totalPages, 'bottom') : ''}
    `;
  }

  private renderPaginationBar(total: number, page: number, totalPages: number, position: 'top' | 'bottom') {
    const includeOptions = position === 'top';
    const start = (page - 1) * this.pageSize + 1;
    const end = Math.min(total, page * this.pageSize);
    const windowPages = this.pageWindow(page, totalPages);
    const withEllipsis: (number | '…')[] = [];
    let last = 0;
    windowPages.forEach(p => {
      if (p - last > 1 && last !== 0) withEllipsis.push('…');
      withEllipsis.push(p);
      last = p;
    });

    return html`
      <nav class="pagination-bar ${position}" aria-label="${position === 'top' ? '查詢結果分頁' : '查詢結果底部分頁'}">
        <div class="pagination-summary">
          找到<b>${total}</b>條，顯示<b>${start}–${end}</b>條/第<b>${page}</b>頁，共<b>${totalPages}</b>頁
        </div>
        <div class="pagination-controls">
          ${includeOptions ? html`
            <label class="pagination-size">每頁
              <select aria-label="每頁顯示條數"
                      @change="${(e: Event) => this.changePageSize((e.target as HTMLSelectElement).value)}">
                ${PAGE_SIZE_OPTIONS.map(s => html`<option value="${s}" ?selected="${s === this.pageSize}">${s}條</option>`)}
              </select>
            </label>
            <label class="sort-select">排序
              <select aria-label="結果排序方式"
                      @change="${(e: Event) => this.changeSort((e.target as HTMLSelectElement).value as SortKey)}">
                ${SORT_OPTIONS.map(o => html`<option value="${o.value}" ?selected="${o.value === this.currentSort}">${o.label}</option>`)}
              </select>
            </label>
          ` : ''}
          ${totalPages > 1 ? html`
            <button class="pagination-btn" type="button" ?disabled="${page === 1}"
                    aria-label="前往第1頁" @click="${() => this.goToPage(1)}">首頁</button>
            <button class="pagination-btn" type="button" ?disabled="${page === 1}"
                    aria-label="前往第${page - 1}頁" @click="${() => this.goToPage(page - 1)}">上一頁</button>
            ${withEllipsis.map(p => p === '…'
              ? html`<span class="pagination-ellipsis">…</span>`
              : html`<button class="pagination-btn" type="button"
                      aria-label="${p === page ? `第${p}頁，目前頁` : `前往第${p}頁`}"
                      aria-current="${p === page ? 'page' : 'false'}"
                      @click="${() => p !== page && this.goToPage(p as number)}">${p}</button>`)}
            <button class="pagination-btn" type="button" ?disabled="${page === totalPages}"
                    aria-label="前往第${page + 1}頁" @click="${() => this.goToPage(page + 1)}">下一頁</button>
            <button class="pagination-btn" type="button" ?disabled="${page === totalPages}"
                    aria-label="前往第${totalPages}頁" @click="${() => this.goToPage(totalPages)}">末頁</button>
          ` : ''}
        </div>
      </nav>
    `;
  }

  private renderResultCard(item: DictItem, idx: number) {
    const ziUrl = item.z ? encodeURIComponent(item.z) : '';

    return html`
      <div class="result-card" style="animation-delay:${Math.min(idx, 10) * 0.06}s"
           data-char="${item.z || ''}" data-phonetic="${item.y || ''}">
        <div class="card-banner">
          <div class="card-banner-left">
            <div class="card-glyph">${item.z || '？'}</div>
            ${item.z ? html`
              <a class="zi-link" href="https://zi.tools/zi/${ziUrl}" target="_blank" rel="noopener" title="在字統網查閱字源">
                字統 ${icon('open_in_new', 12)}
              </a>
            ` : ''}
          </div>
          <div class="card-banner-right">
            <div class="phonetic-row">
              <span class="phonetic-label">擬音</span>
              <span class="phonetic-value">${item.y || '—'}</span>
              ${item.y ? html`
                <button class="copy-icon-btn copy-btn" type="button" title="複製擬音" aria-label="複製擬音"
                        @click="${(e: Event) => this.copyText(item.y!, (e.currentTarget || e.target) as HTMLElement)}">
                  ${icon('content_copy', 16)}
                </button>
              ` : ''}
            </div>
            <div class="phonetic-row">
              <span class="phonetic-label">拼音</span>
              <span class="pinyin-value">${item.p || '—'}</span>
              ${item.p ? html`
                <button class="copy-icon-btn copy-btn" type="button" title="複製拼音" aria-label="複製拼音"
                        @click="${(e: Event) => this.copyText(item.p!, (e.currentTarget || e.target) as HTMLElement)}">
                  ${icon('content_copy', 16)}
                </button>
              ` : ''}
            </div>
            ${item.c || item.m ? html`
              <div class="derived-phonology" aria-label="推導中古音韻">
                <span class="derived-heading">推導中古</span>
                ${item.c ? html`
                  <span class="derived-item">
                    <span class="derived-label">音韻地位</span>
                    <span class="derived-value">${item.c}</span>
                  </span>` : ''}
                ${item.m ? html`
                  <span class="derived-item">
                    <span class="derived-label">聲首</span>
                    <button class="derived-value initial-search" type="button"
                            title="點擊查找同聲首字" aria-label="聲首${item.m}，點擊查詢同聲首字"
                            @click="${() => this.searchExact(item.m!)}">${item.m}</button>
                  </span>` : ''}
              </div>` : ''}
            <div class="card-tags">
              ${item.a ? html`
                <button class="tag-btn xiesheng" type="button"
                        title="點擊查找同諧聲域字" aria-label="諧聲域${item.a}，點擊查詢同域字"
                        @click="${() => this.searchExact(item.a!)}">諧聲域: ${item.a}</button>
              ` : ''}
              ${item.s === 1 ? html`
                <a class="tag-btn rhyme" href="https://suzukish.sakura.ne.jp/search/xianqin/index.php?yunzi=${ziUrl}"
                   target="_blank" rel="noopener noreferrer" title="在先秦兩漢韻部資料庫查閱詩經韻">見詩經韻</a>
              ` : ''}
              ${item.q === 1 ? html`
                <a class="tag-btn rhyme" href="https://suzukish.sakura.ne.jp/search/xianqin/index.php?yunzi=${ziUrl}"
                   target="_blank" rel="noopener noreferrer" title="在先秦兩漢韻部資料庫查閱戰國韻">見戰國韻</a>
              ` : ''}
            </div>
          </div>
          <div class="card-actions">
            <button class="export-btn" type="button" title="導出爲圖片" aria-label="導出此條目爲圖片"
                    @click="${(e: Event) => this.exportCard((e.target as HTMLElement).closest('.result-card') as HTMLElement)}">
              ${icon('image', 14)} 導出
            </button>
          </div>
        </div>
        <div class="card-body">
          <div class="section">
            <div class="section-header">
              <span class="section-label">釋義</span>
              ${item.d?.[0] ? html`<span class="section-note">（${item.d[0]}）</span>` : ''}
            </div>
            ${item.d?.[1]?.length ? html`
              <ol class="meanings-list">
                ${item.d[1].map((m, i) => html`
                  <li><span class="sense-num">${i + 1}</span><span .innerHTML="${this.parseLinks(m, s => this.highlightMeaningSearchTerm(s))}"></span></li>
                `)}
              </ol>
            ` : html`<p class="empty-meaning">暫無釋義</p>`}
          </div>
          ${item.n ? html`
            <div class="section-divider"></div>
            <div class="section">
              <div class="section-header"><span class="section-label">注釋</span></div>
              <div .innerHTML="${this.renderAnnotation(item.n)}"></div>
            </div>` : ''}
        </div>
      </div>
    `;
  }

  private renderBatch() {
    if (!this.batchRows?.length) {
      return html`<div class="no-result" role="status">未找到可標音的漢字<br><span>請輸入包含漢字的文本</span></div>`;
    }
    const rows = this.batchRows;
    const totalChars = rows.length;
    const foundChars = rows.filter(r => r.items.length > 0).length;
    const totalRows = rows.reduce((sum, r) => sum + Math.max(1, r.items.length), 0);

    let idx = 0;
    const bodyRows = rows.map(row => {
      if (!row.items.length) {
        idx++;
        return html`<tr><td>${idx}</td><td class="batch-char">${row.char}</td>
          <td class="batch-not-found" colspan="3">未收錄</td></tr>`;
      }
      const firstIdx = ++idx;
      return row.items.map((item, i) => {
        if (i > 0) idx++;
        return html`<tr>
          ${i === 0 ? html`<td rowspan="${row.items.length > 1 ? row.items.length : nothing}">${firstIdx}</td>
            <td class="batch-char" rowspan="${row.items.length > 1 ? row.items.length : nothing}">${row.char}</td>` : nothing}
          <td class="batch-pinyin">${item.p || '—'}</td>
          <td class="batch-phonetic">${item.y || '—'}</td>
          <td class="batch-domain">${item.a || '—'}</td>
        </tr>`;
      });
    });

    return html`
      <div class="batch-container">
        <div class="batch-actions">
          <md-outlined-button @click="${(e: Event) => this.batchCopy('tsv', (e.currentTarget || e.target) as HTMLElement)}">
            ${icon('content_copy', 18)} 複製為TSV
          </md-outlined-button>
          <md-outlined-button @click="${(e: Event) => this.batchCopy('text', (e.currentTarget || e.target) as HTMLElement)}">
            ${icon('notes', 18)} 複製為標音文本
          </md-outlined-button>
        </div>
        <div class="batch-table-wrap">
          <table class="batch-table">
            <thead><tr><th>#</th><th>字</th><th>拼音</th><th>擬音</th><th>諧聲域</th></tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
        <p class="batch-summary">共${totalChars}字，${foundChars}字有擬音，${totalChars - foundChars}字未收錄，展開${totalRows}行${this.batchTruncated ? `，已截取前${BATCH_MAX_LENGTH}字` : ''}</p>
      </div>
    `;
  }

  private renderWelcome() {
    return html`
      <article class="welcome-page" aria-labelledby="welcomeTitle">
        <header class="welcome-intro">
          <h2 id="welcomeTitle">說明</h2>
          <p>本系統在Baxter、Sagart（2014）基礎上，吸收<a href="https://www.zhihu.com/question/611384252/answer/3127239134" target="_blank" rel="noopener noreferrer">羊系</a>、<a href="https://www.zhihu.com/question/334162615/answer/744255554" target="_blank" rel="noopener noreferrer">小舌音聲母組</a>與<a href="https://zhuanlan.zhihu.com/p/679828961" target="_blank" rel="noopener noreferrer">清響音</a>等新進展，並結合押韻與假借有若干具體改動。本網站提供漢字、拼音、擬音、諧聲域與釋義檢索。</p>
        </header>

        <section class="welcome-section" aria-labelledby="evidenceTitle">
          <h3 id="evidenceTitle">材料</h3>
          <p>四類材料按優先級排序：</p>
          <ol class="welcome-list">
            <li><strong>押韻與假借。</strong>作爲母語者給出的一手材料，具有無可替代的第一性地位。</li>
            <li><strong>中古音與傳世諧聲。</strong>是普遍的，但也是晚出的，只能作爲零假設，在①本身不足時格式化地填入。擺脫反映中古以來材料帶來的偏見才能更客觀地看待反映上古的材料。</li>
            <li><strong>現代方言與域外對音。</strong>不能作爲構擬新音類的論據，但可以作爲歸類參考。</li>
            <li><strong>漢藏對音。</strong>各藏緬語的歷史音變和既有構擬亟待評估，使用它們將是危險的。</li>
          </ol>
        </section>

        <section class="welcome-section" aria-labelledby="systemTitle">
          <h3 id="systemTitle">音系</h3>
          <details class="welcome-details" open>
            <summary>聲母概況</summary>
            <p>只有<code>s-</code>、<code>m-</code>兩種前綴，只在近音（<code>l-</code>、<code>j-</code>）前可以觀察到。端紐有演變爲中古書母的，寫作<code>st-</code>。<a href="https://zhuanlan.zhihu.com/p/706013675">閩語在其他紐也反映（不同的）前綴</a>（另在注釋中標出），但其不參與古典漢語的音系構擬，因此不予考慮。<code>C.r-</code>表示用非R系字符書寫，或與非中古來母詞有明顯同源關係的來母詞，其與通過比較法可以從方言確定的“特殊來母”關係待考。非三等標記爲便於顯示、從舊等原因，寫作<code>ˤ</code>，實際應爲舌根後縮（Retracted Tongue Root, RTR），即<code>◌̙</code>。</p>
          </details>
          <details class="welcome-details">
            <summary>韻母概況</summary>
            <ol class="welcome-list">
              <li>之部元音從舊，作<code>ə</code>。實際上應與<code>i</code>、<code>u</code>同爲高元音，即<code>[ɨ]</code>。三等無<code>r</code>的<code>-a(j)</code>韻母在銳音聲母後有進入麻韻者，其平聲部分的轄字在東漢各方言一致（詳見張振通《新視角下的漢代韻部研究》“東漢魚部三等字的分化問題”），應當反映了一個不同於其他<code>-a-</code>的原始音類，但目前尚難賦值，暫記作<code>ia</code>。</li>
              <li>歌、豪、乾部韻尾分別寫作<code>-j</code>、<code>-w</code>、<code>-r</code>。</li>
              <li>所有韻文及大多數假借、諧聲中，<code>-ps</code>、<code>-ts</code>已經合流、同<code>-t</code>混押，記作<code>-s</code>；<code>-ks</code>與<code>-s</code>已經合流、同<code>-k</code>混押，記作<code>-h</code>。<code>-əs</code>與<code>-əps</code>的押韵、演化皆有不同，諧聲也能分辨，因而留之。具體來說，關中先發生<code>*-əts>-its</code>，之後全體發生<code>*-ts,ps>-s</code>，其中<code>-əps</code>接非近銳音（<code>T, N, TS</code>）時演變爲<code>-us</code>，皆在《詩經》主體創作時間之前。</li>
            </ol>
          </details>
          <details class="welcome-details">
            <summary>聲調概況</summary>
            <p>本表認爲，在原則上，爲具體詞構擬聲調應與韻母遵循相同的原則，即以押韻係聯爲主，中古音僅作爲賦值依據。然而押韻相當稀疏、無法單獨支持構擬，因此在實踐中判定聲調（以及聲調異讀分工）的標準應與多音字一致：零假設爲後世讀音忠實反映上古音，遇到不一致的材料再進行討論。</p>
          </details>
        </section>

        <section class="welcome-section" aria-labelledby="tablesTitle">
          <h3 id="tablesTitle"><a href="https://zhuanlan.zhihu.com/p/12987993957">資料表</a></h3>
          <dl class="welcome-definitions">
            <div>
              <dt>音節表</dt>
              <dd>黑色:平聲，藍色:上聲，紅色:去聲，灰色:入聲。“入聲”所代表的韻尾，具體看左側。</dd>
            </div>
            <div>
              <dt>字典表</dt>
              <dd>以字頭（「字-音結合體」，以傳世寫法爲準）爲鍵的表。一行類似字典中的一項，故名。本網站據此表查詢。</dd>
            </div>
            <div>
              <dt>小韻表</dt>
              <dd>從音節表導出，以音節爲鍵的表。一行類似中古韻書的一個小韻，故名。純享版。</dd>
            </div>
          </dl>
          <p class="welcome-note">押韻、字頻數據由程序導出，不能區分多音字之多音。「字频」列實乃「出現該字的段落數」，不是一般的字頻。歸一化字頻:<code>100×(該字字頻／組最高字頻)<sup>0.5</sup></code>，可以調整公式另行計算。</p>
        </section>

        <section class="welcome-section" aria-labelledby="scopeTitle">
          <h3 id="scopeTitle">收字標準</h3>
          <p>傳世文獻原則上收至西漢初年，含輯佚；另收通假語素及逐步整理的出土文獻。考慮到語料性質，對出土文獻的年代要求適當放寬（如放寬到景帝爲止的西漢早期，以容納馬王堆帛書《五十二病方》、天回醫簡等醫學文獻）。</p>
          <details class="welcome-details">
            <summary>傳世文獻（僅作示意）</summary>
            <dl class="source-scope">
              <div><dt>西周</dt><dd>《詩經》《尚書》；《易》</dd></div>
              <div><dt>中原</dt><dd>《論語》《孟子》；《老子》；《春秋》及三傳、《國語》《戰國策》；《墨子》；三禮；《爾雅》</dd></div>
              <div><dt>齊</dt><dd>《管子》《晏子春秋》《孫子兵法》《司馬法》；《逸周書》（部分？）；《考工記》</dd></div>
              <div><dt>趙、周韓</dt><dd>《荀子》《公孫龍子》；《韓非子》；《穆天子傳》《竹書紀年》；《逸周書》</dd></div>
              <div><dt>晉其他</dt><dd>《呂氏春秋》；《申子》《子華子》等</dd></div>
              <div><dt>楚、吳越</dt><dd>《莊子》《鶡冠子》《楚辭》；《尉繚子》；《山海經》；《越人歌》</dd></div>
              <div><dt>關中</dt><dd>《商君書》；《素書》</dd></div>
              <div><dt>不明</dt><dd>《尸子》《范子計然》《孝經》；《歸藏》等</dd></div>
            </dl>
            <p>此外，還含李斯《諫逐客書》、樂毅《答燕惠王書》、《逸禮·王度記》等散篇。通假語素主要參考白於藍《簡帛古書通假字大系》（2017）。</p>
          </details>
        </section>

        <section class="welcome-section" aria-labelledby="conventionsTitle">
          <h3 id="conventionsTitle">字典表凡例</h3>
          <p>主要參考《漢語大詞典》《漢語大字典》，以數字列出各義項，義項下分點用①②③……。試圖兼顧簡明與全面，因此若有明顯的引申則酌情合併。</p>
          <p>語料依出土文獻、後世語料有所補充，暫時考慮收錄《史記》（西漢中期）及以前傳世文獻的語素引申義。直引語料用西文引號“”表示，計入字頻（歸一化）統計。注疏與後世語料用直角引號「」表示。</p>
          <p>依據現已明確的文本來源問題，對篇名有適當調整。例如，《考工記》是戰國齊地作品，漢人爲填補已佚的《周禮·冬官司空》將其補入，來源不同，故直接寫作《考工記·某》；《莊子》內篇與外、雜篇押韻習慣不同（前者有真耕通押），詞彙亦有別，故留作《莊子·內·某》以俟研究；《詩》《書》《楚辭》是彙編，只留作各部分與篇名，如《邶風·某》《周書·某》《九歌·某》。《左傳》後四公篇幅遠多於前八公，語法亦有別，然仍不清楚具體來源，故不作區分；《禮記》《大戴禮記》是戰國至漢初儒家文獻彙編，來源複雜，如海昏侯簡《禮記》類文獻形製、書體各異，有一部分（《中庸》《祭義》等）同《論語》相混雜，然也無法針對二《禮》給出更明確的來源，故不分，諸如此類。</p>
          <p>出土文獻默認以後世通行字寫出寬式釋文，必要時以“原作某”、或括注釋文、或在注釋欄給出原始字形。《管子》《鶡冠子》等傳世文獻多有錯訛、增窜、脫漏，以<code>&lt;&gt;</code>表示訛字當本作某，<code>()</code>表示當讀作某，<code>{}</code>表示當補，<code>【】</code>表示當刪。</p>
          <p><code>【X】</code>表示“訓作／意爲X”，<code>{X}</code>表示中古通行寫法爲X的詞彙或標音，或標音（直音爲X或反切切語），<code>“X”</code>表示X這個字。用例：《管子·地員》“位土”之“位”即“湴”字之壞，“湴”字從“竝(替)”聲，讀作{埿}，訓爲【汙泥】。</p>
          <details class="welcome-details">
            <summary>《說文》</summary>
            <p>《說文》的訓釋與字形說解含有大量漢儒重構成分，僅供參考。一般省略「從某，某聲」的字形說解部分，認爲能反映漢儒文字觀的，則酌情保留。</p>
          </details>
          <details class="welcome-details">
            <summary>《蒼頡篇》</summary>
            <p>《蒼頡篇》有蒙書、詁書兩種。</p>
            <ol class="welcome-list">
              <li>蒙書《蒼頡篇》是李斯《蒼頡篇》、趙高《爰歴篇》、胡毋敬《博學篇》合稱（55章），久佚，可從近來出土的簡牘復原大部，參看<a href="https://www.fdgwz.org.cn/Web/Show/11308">甘木《新編〈蒼頡篇〉釋文》</a><a href="https://www.fdgwz.org.cn/Web/Show/11307">《簡牘〈蒼頡篇〉校讀叢札》</a>及中引文。東漢以來與揚雄《訓纂篇》、賈魴《滂喜篇》各34章又合稱“三蒼”，如郭璞《三蒼解詁》等。</li>
              <li>詁書《蒼頡篇》散見於先宋注疏，現多稱作“古注本《蒼頡篇》”，是宣帝時爲緩解“《蒼頡》多古字，俗師失其讀”而依蒙書《蒼頡篇》逐字編著的杜林《蒼頡訓詁》。揚雄《訓纂篇》34篇以蒙書《蒼頡篇》格式收集蒙書《蒼頡篇》未收字，揚雄《蒼頡訓纂》則是對蒙書《蒼頡篇》+《訓纂篇》整體所作的詁書，魏晉以來被吸收進古注本《蒼頡篇》。約三國後又有後人增補反切（如《玉篇》以來“詯&lt;䛛&gt;”字訓已佚，字韻書徑以反切“胡市&lt;內&gt;”爲訓）。《說文》訓釋與古注本《蒼頡篇》相似者不少，說解字形有引杜林、揚雄說者。古注本《蒼頡篇》後與郭璞《三蒼注》等書在內容上有所混淆，王國維《重輯蒼頡篇》等即不作區分。以上參看苗壯《古注本〈蒼頡篇〉考》。</li>
              <li>字典表凡例：《蒼頡》《爰歴》《博學》皆取篇首二字爲題，可從蒙書《蒼頡篇》復原本（主要參考<a href="https://www.fdgwz.org.cn/Web/Show/11308">甘木《新編〈蒼頡篇〉釋文》</a>）輕易分出，表中將徑直寫明。例如“貤”字：《爰歷篇》：“爰歷次貤，繼續前圖。”詁書《蒼頡篇》盡量注明出處，以「」表示。至於《說文》引杜林、揚雄說，因其主要爲說解字形，故不另列明，只隨《說文》正文寫出。</li>
            </ol>
          </details>
        </section>

<!--        <section class="welcome-section" aria-labelledby="licenseTitle">-->
<!--          <h3 id="licenseTitle">字體支持</h3>-->
<!--          <p class="font-license"><a href="https://hyperos.mi.com/font-download/MiSans%E5%AD%97%E4%BD%93%E7%9F%A5%E8%AF%86%E4%BA%A7%E6%9D%83%E8%AE%B8%E5%8F%AF%E5%8D%8F%E8%AE%AE.pdf" target="_blank" rel="noopener">MiSans</a> (Copyright © Xiaomi Inc.)</p>-->
<!--        </section>-->
      </article>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pboc-app': PbocApp;
  }
}
