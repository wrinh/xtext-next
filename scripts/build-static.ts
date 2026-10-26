/**
 * 静态资源复制与 SW 编译（Bun 脚本）
 * bun build 输出 index.js 后，将 HTML / manifest / SW / 样式 / 字典数据复制至 dist
 */
import { mkdir, copyFile, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const dist = 'dist';
// 仅清理本脚本管理的产物（index.js 由 bun build 在此之前生成，不可删除）
await Promise.all([
  rm(join(dist, 'styles'), { recursive: true, force: true }),
  rm(join(dist, 'assets'), { recursive: true, force: true }),
  rm(join(dist, 'sw.js'), { force: true }),
]);
await mkdir(join(dist, 'styles'), { recursive: true });
await mkdir(join(dist, 'assets'), { recursive: true });

const staticFiles: Array<[string, string]> = [
  ['src/index.html', join(dist, 'index.html')],
  ['src/robots.txt', join(dist, 'robots.txt')],
  ['src/_headers', join(dist, '_headers')],
  ['src/manifest.webmanifest', join(dist, 'manifest.webmanifest')],
  ['src/styles/m3-theme.css', join(dist, 'styles/m3-theme.css')],
  ['src/styles/typography.css', join(dist, 'styles/typography.css')],
  ['src/assets/icon.svg', join(dist, 'assets/icon.svg')],
  ['src/assets/xtext_core.wasm', join(dist, 'assets/xtext_core.wasm')],
  ['src/assets/dict.bin', join(dist, 'assets/dict.bin')],
];
for (const [from, to] of staticFiles) await copyFile(from, to);

// 编译 Service Worker 为独立产物
await Bun.build({
  entrypoints: ['src/sw.ts'],
  outdir: dist,
  target: 'browser',
  minify: true,
  naming: { entry: '[name].[ext]' },
});

// ── 构建指纹：哈希关键产物 → 注入 index.html meta + 写出 version.json ──
// 更新检测（src/core/update-check.ts）依赖此指纹：页面运行中的 build-id
// 与站点最新 version.json 不一致时提示用户刷新。SW 对 version.json 直通。
const hash = createHash('sha256');
const fingerprintFiles = [
  join(dist, 'index.js'),
  join(dist, 'sw.js'),
  join(dist, 'index.html'),
  join(dist, 'manifest.webmanifest'),
  join(dist, 'styles', 'm3-theme.css'),
  join(dist, 'styles', 'typography.css'),
  join(dist, 'assets', 'xtext_core.wasm'),
  join(dist, 'assets', 'dict.bin'),
  join(dist, 'assets', 'icon.svg'),
];
for (const file of fingerprintFiles) {
  hash.update(await readFile(file));
}
const buildId = hash.digest('hex').slice(0, 16);

// 注入 build-id meta（源文件含 content="dev" 占位，构建时替换为真实指纹）
const htmlPath = join(dist, 'index.html');
const html = await readFile(htmlPath, 'utf8');
const metaTag = `<meta name="build-id" content="${buildId}" />`;
const updatedHtml = html.includes('name="build-id"')
  ? html.replace(/<meta name="build-id"[^>]*>/, metaTag)
  : html.replace('</head>', `  ${metaTag}\n</head>`);
await writeFile(htmlPath, updatedHtml);

await writeFile(join(dist, 'version.json'), `${JSON.stringify({ build: buildId })}\n`);

console.log(`✓ static assets copied to dist/`);
console.log(`✓ build-id ${buildId} → index.html meta + version.json`);
