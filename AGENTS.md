# AGENTS.md

## Commands

```bash
bun run fetch:dict    # download base/extra.json.gz from upstream Qwert-ly/xtext → src/assets/
bun run encode:dict   # encode dict.bin (requires fetch:dict first; transfer compression is the CDN's job via Accept-Encoding)
bun test              # reads src/assets/base.json.gz — run AFTER fetch:dict/encode:dict
bun run build         # bun build (index.js) + build-static (dist/)
bun run serve         # build + preview at :4173 (simulates /cdn-cgi/trace loc=CN)
```

MoonBit engine (`src/assets/xtext_core.wasm` is gitignored — rebuild after clone or after any `.mbt` change):

```bash
$HOME/.moon/bin/moon -C moonbit/xtext_core build --target wasm-gc --release
cp moonbit/xtext_core/_build/wasm-gc/release/build/xtext_core.wasm src/assets/
```

For `.mbt` changes follow `moonbit/xtext_core/AGENTS.md`: run `moon fmt`, `moon info`, `moon test` inside `moonbit/xtext_core` before committing. Smoke-test the engine end-to-end with `node scripts/test-wasm.mjs` (needs built wasm + `src/assets/dict.bin`).

## Build order and artifacts

Pipeline order matters: `fetch:dict → encode:dict → test → build`. Dict sources and encoded artifacts are gitignored by design (CI downloads them from the upstream repo). A fresh clone cannot run `bun test` or `bun run build` until `fetch:dict && encode:dict` has run.

`scripts/build-static.ts` must only clean `dist/styles`, `dist/assets`, `dist/sw.js` — never wipe `dist/` itself: bun build writes `dist/index.js` before build-static runs, and wiping dist deletes it (this shipped once and took down the site with a MIME-type error).

## UTF-16 vs code points (recurring bug source)

JS strings, WASM js-string builtins, and MoonBit `String` are all UTF-16 — that's fixed; what varies is iterating by code unit vs code point. Three bugs shipped from getting this wrong:

- Frontend: always `Array.from(str)` for counting/splitting/limiting (input counter, batch analysis). Never native `maxlength` (HTML counts UTF-16 units, so an ext-block char = 2).
- Engine: `query.mbt` has `first_codepoint()` for decoding the first scalar value — `s[0].to_int()` returns a high surrogate for non-BMP chars and breaks the binary search (`search_z`/`search_exact`/`z_codepoint` all use it).
- The `0 / N` counter under the search box is our custom `.char-counter`, not M3's maxlength counter — don't re-add `maxlength`.

Non-BMP coverage is real: the dict contains 414 ext-block entries; test with e.g. `𨼊` (U+28F0A), `𢜮` (U+2272E).

## dict.bin format coupling

`scripts/encode-dict.ts` (encoder) and `moonbit/xtext_core/query.mbt` (parser) must agree exactly: 32-byte header + 11340 × 56-byte fixed records + UTF-8 string pool + optional meaning-inverted-index trailer appended after the pool (an `XTIX\0` section whose u64 LE offset sits in the last 8 bytes of the file; used by `search_meaning` for anchor-based candidate filtering, with the encoder's `INDEX_MAX_POSTING` cutoff — chars over the cutoff go into the excluded table). The z-table is sorted by full code point (`z.codePointAt(0)`, stable) — the engine's binary search (`find_by_z_codepoint`) depends on that order, and the inverted-index posting IDs are post-sort record indices; don't change the sort key or the search key independently. After editing either side, re-run `encode:dict` AND rebuild the wasm (`moon ... build`, copy to `src/assets/`); old engines ignore the trailer and new engines fall back to a full scan when the index is missing, so the pair can be deployed independently.

## Frontend conventions

- Lit with **light DOM** (`createRenderRoot() { return this }`): global stylesheets (`m3-theme.css`) style component internals directly; there are no shadow roots to pierce for our own elements (only for `@material/web` internals).
- M3 buttons: label text must be a **child text node**; the `label`/`.label` attribute does not render (aria-only in this @material/web version) — pair with `aria-label`. Batch buttons with SVG icons are fine as children.
- Search button alignment: `md-filled-text-field` outer box is 76px but the visible field is 56px; the button must stay 56px with `align-items: flex-start` — don't "fix" this back to centering.
- No emoji anywhere (code, comments, UI). Icons come from `src/components/icons.ts` (Material Symbols SVG).
- CJK↔Latin spacing: never put literal spaces in content strings; `text-autospace: normal` handles rendering.
- Links must be underlined (not color-only); text ≥16px for body copy; theme tokens are generated at runtime by Material Color Utilities from seed `#8f4a3c` (`src/theme/dynamic-theme.ts`, injected `<style id="mcu-dynamic-theme">`) — to change colors, change the seed, not the static tokens in `m3-theme.css` (those are first-paint fallback only).
- MiSans compliance (footer + README attribution text and license link) is a license requirement — don't remove it. The owner shortened the footer wording (「字體支持：MiSans (Copyright © Xiaomi Inc.)」 + license link) and commented out the welcome 字體許可 section in the org migration — treat that as intentional, don't re-add the old verbatim paragraphs. Fonts load via CDN split in `src/core/font-loader.ts` (BootCDN for `loc=CN`, cdnjs otherwise).

## Deploy and Service Worker

Push to `main` → GitHub Actions builds and deploys to Cloudflare Pages (project `xtext-next`, needs `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` secrets; the workflow creates the Pages project because non-interactive `wrangler pages deploy` won't). PRs build only.

The Service Worker (`src/sw.ts`) caches static assets SWR — after a deploy, the browser may serve stale `index.js`/wasm and make new code look broken. When testing a fresh deploy, unregister the SW and clear caches, or the behavior you observe may be from the previous version. Local dev auto-unregisters.

Update detection: `scripts/build-static.ts` fingerprints the artifacts (sha256 → 16-hex build id), injects `<meta name="build-id">` into `dist/index.html`, and writes `dist/version.json` (the SW must keep bypassing `version.json` — it is fetched `no-store` by `src/core/update-check.ts` and compared against the running page's meta). On mismatch the in-flow `.update-bar` (styles pre-exist in `m3-theme.css`) offers 立即更新 (clears `pboc-shell-*`/`pboc-static-*` caches, keeps `pboc-dict-*`, reloads) and 暫不. Checks run 5s after load, on tab visible (≥5min throttle), and every 30min; once shown or dismissed, no more checks this page load.
