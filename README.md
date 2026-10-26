# XText Next（PBOC 查詢）

Philology-Based Old Chinese（PBOC，基於文獻的上古漢語）查詢工具 —— 與 [Qwert-ly/xtext](https://github.com/Qwert-ly/xtext) 前端行為一致的現代化重寫版。

- **原版部署**：https://qwert-ly.github.io/xtext/
- **技術棧**：Bun + Lit 3.x（Web Components）+ Material Design 3 + MoonBit WASM 檢索引擎 + PWA
- **部署**：GitHub Actions 自動構建並發佈至 Cloudflare Pages（項目名 `xtext-next`）

## 功能（與原版一致）

- **五種搜索模式**：默認（自動分詞）、精確、正則（ReDoS 防護 + `/pattern/flags` 語法）、釋義反查、批量標音（最多 5000 字）
- **URL 狀態同步**：`?q=&mode=&page=&size=&sort=`，支持 popstate 前進後退
- **分頁排序**：每頁 20/50/100/200，按拼音/擬音/諧聲域排序
- **搜索歷史**：localStorage 持久化（上限 20 條），支持單項刪除/清空
- **結果卡片**：字頭、擬音、拼音、推導中古（音韻地位/聲首點擊查詢）、諧聲域標籤、見詩經韻/戰國韻外鏈、字統網鏈接、釋義列表、注釋（URL 自動轉鏈接）、複製、導出圖片（html-to-image）
- **批量標音**：表格輸出 + TSV/標音文本複製
- **全局快捷鍵**：`/` 聚焦搜索框
- **PWA**：manifest + Service Worker（HTML Network-First、靜態 SWR、字體 SWR）
- **歡迎頁**：說明/材料/音系/資料表/收字標準/凡例/字體許可全文

## 架構

```
moonbit/xtext_core/          MoonBit 檢索引擎（編譯為 wasm-gc）
├── query.mbt                dict.bin 二進制格式解析（定長記錄 + UTF-8 字符串池，二分檢索）+ 五模式檢索 API
└── _build/…/xtext_core.wasm 編譯產物 → 複製到 src/assets/

scripts/
├── fetch-dict-source.ts     從上游 Qwert-ly/xtext 下載 base.json.gz + extra.json.gz
├── encode-dict.ts           編碼為緊湊二進制 dict.bin（含釋義倒排索引），傳輸壓縮交由 CDN
├── build-static.ts          複製 HTML/樣式/資產至 dist/，編譯 Service Worker
├── serve.ts                 本地預覽（模擬 /cdn-cgi/trace loc=CN）
└── test-wasm.mjs            WASM 引擎端到端驗證

src/
├── index.ts                 入口：MCU 動態主題 + 字體分流 + SW 註冊/註銷
├── theme/dynamic-theme.ts   Material Color Utilities 種子色動態主題
├── core/
│   ├── font-loader.ts       /cdn-cgi/trace 地域探測 → MiSans BootCDN（CN）/ cdnjs（海外）分流
│   ├── wasm-engine.ts       WASM 實例化（wasm-gc + js-string builtins）+ base64 工具
│   ├── moonbit-dict.ts      檢索適配層（與原 DictEngine 對外接口一致）
│   ├── dict-engine.ts       原版 JS 引擎（僅供單元測試對照，主流程不再使用）
│   └── dict-loader.ts       原版 gzip 流式加載（主流程不再使用）
├── components/
│   ├── pboc-app.ts          <pboc-app> 主應用（light DOM，@material/web M3 組件）
│   └── icons.ts             Material Symbols Rounded SVG 圖標集
├── styles/
│   ├── m3-theme.css         MD3 主題（含靜態回退 token）與全部組件樣式
│   └── typography.css       MiSans 字體鏈 + text-autospace
└── sw.ts                    Service Worker（shell/static/dict 三級緩存）

tests/dict-engine.test.ts    22 項引擎單元測試
```

## 字庫數據流水線

倉庫內**不提交**字典數據與編譯產物（見 `.gitignore`），構建時自動獲取：

1. `bun run fetch:dict` — 從上游 [Qwert-ly/xtext](https://github.com/Qwert-ly/xtext)（`docs/base.json.gz` + `docs/extra.json.gz`）下載源數據至 `src/assets/`
2. `bun run encode:dict` — 編碼為緊湊二進制 `dict.bin`（Header 32B + 56B 定長記錄 × 條數 + UTF-8 字符串池 + 釋義倒排索引 trailer，按 z 碼點升序；條數隨上游增補變化，勿硬編碼）
3. 運行時直接 fetch `dict.bin`（傳輸壓縮由 Cloudflare 按請求的 Accept-Encoding 自動協商），base64 傳入 WASM 一次性駐留，零 `JSON.parse` 開銷

## 開發

```bash
bun install

# 1. 構建 MoonBit WASM 引擎（需 MoonBit 工具鏈，https://moonbitlang.com）
cd moonbit/xtext_core
moon build --target wasm-gc --release
cp _build/wasm-gc/release/build/xtext_core.wasm ../../src/assets/
cd ../..

# 2. 獲取字庫源數據並編碼
bun run fetch:dict
bun run encode:dict

# 3. 測試與構建
bun test            # 22 項引擎單元測試
bun run build       # 構建至 dist/
bun run serve       # 本地預覽 http://localhost:4173（模擬 /cdn-cgi/trace loc=CN）
```

## CI/CD（GitHub Actions → Cloudflare Pages）

`.github/workflows/deploy.yml`：push 到 `main` 或 PR 時自動執行

1. 安裝 MoonBit 工具鏈，`moon build --target wasm-gc --release` 編譯檢索引擎
2. 安裝 Bun，`bun install --frozen-lockfile`
3. 從上游 Qwert-ly/xtext 下載字典源數據，編碼為 `dict.bin`
4. `bun test`（22 項單元測試）
5. `bun run build` 構建前端至 `dist/`
6. PR 僅構建驗證；push 到 `main` 時通過 `wrangler-action` 發佈至 Cloudflare Pages

**所需倉庫 Secrets**（Settings → Secrets and variables → Actions）：

| Secret | 說明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（需 Pages:Edit 權限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 賬戶 ID |

## 設計系統

- **Material Design 3**：`@material/web` 組件庫（filled text field / filled button / filter chip / circular progress 等），light DOM + 外部主題樣式表
- **動態配色**：[Material Color Utilities](https://github.com/material-foundation/material-color-utilities) 以種子色（朱砂-焦褐 `#8f4a3c`）生成淺色/深色全量 `--md-sys-color-*` token（`src/theme/dynamic-theme.ts`），對比度通過 WCAG AA 校驗（正文最高 16.35:1，最低 6.14:1）
- **圖標**：全部為 Material Symbols Rounded 風格 SVG（`src/components/icons.ts`），無任何 emoji
- **排版**：`text-autospace: normal` 中西文混排微間距；正文 16px；中西文之間不加空格，一律由 CSS 處理

## 字體與 MiSans 知識產權聲明

系統通過 `/cdn-cgi/trace` 探測訪客地域：中國大陸走 [BootCDN](https://cdn.bootcdn.net/ajax/libs/misans-webfont/4.3.1/misans-style.min.css)，其他地區走 [cdnjs](https://cdnjs.cloudflare.com/ajax/libs/misans-webfont/4.3.1/misans-style.min.css)，加載 MiSans 與 MiSans L3（fallback 字體鏈防 FOUT/FOIT）。

> 本軟件界面採用小米科技有限責任公司擁有知識產權的 MiSans 字體（含 MiSans L3），嚴格遵守[《MiSans 字體知識產權許可協議》](https://hyperos.mi.com/font-download/MiSans%E5%AD%97%E4%BD%93%E7%9F%A5%E8%AF%86%E4%BA%A7%E6%9D%83%E8%AE%B8%E5%8F%AF%E5%8D%8F%E8%AE%AE.pdf)。字體知識產權歸小米科技有限責任公司所有。

本項目通過官方合法鏡像源（BootCDN / cdnjs）以 WebFont 方式在線引用字體，未對字體文件進行任何反編譯、子集化拆分（Subsetting）、重命名或再分發，不將字體軟件作為商品單獨銷售或收費綁定。

## 數據來源與致謝

- 字庫數據與原版前端行為：[Qwert-ly/xtext](https://github.com/Qwert-ly/xtext)（[原版在線](https://qwert-ly.github.io/xtext/)）
- 上古漢語構擬體系：Baxter、Sagart (2014)，及羊系、小舌音聲母組與清響音等新進展

## License

MIT（MiSans 字體部分見上述知識產權聲明，遵循《MiSans 字體知識產權許可協議》）
