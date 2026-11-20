// Builds the pictures of the app from assets/icon.svg: the store icon, the logos for light and dark themes
// (also in double size) and the icon the web interface shows. Needs Playwright with Chromium.
//
//   node tools/render-brand.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'renovate');
const { chromium } = createRequire(import.meta.url)('playwright');

const icon = readFileSync(path.join(root, 'assets/icon.svg'), 'utf8').replace(/<\?xml[^>]*>\s*/, '');
const innerIcon = icon.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace('id="sky"', 'id="sky-logo"').replace('url(#sky)', 'url(#sky-logo)');

const logo = (dark) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="128" viewBox="0 0 512 128">
  <g transform="translate(8 8) scale(0.4375)">${innerIcon}</g>
  <text x="140" y="70" font-family="Inter, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="52" font-weight="700" letter-spacing="-1" fill="${dark ? '#e6edf6' : '#15202e'}">Renovate</text>
  <text x="142" y="100" font-family="Inter, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="21" font-weight="500" fill="${dark ? '#9aabbf' : '#55657a'}">for Home Assistant</text>
</svg>
`;

writeFileSync(path.join(root, 'assets/logo.svg'), logo(false));
writeFileSync(path.join(root, 'assets/dark_logo.svg'), logo(true));
mkdirSync(path.join(app, 'rootfs/opt/renovate-app/ui/assets'), { recursive: true });
copyFileSync(path.join(root, 'assets/icon.svg'), path.join(app, 'rootfs/opt/renovate-app/ui/assets/icon.svg'));

const browser = await chromium.launch();
async function render(svgFile, width, height, scale, target) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  const page = await context.newPage();
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style>${readFileSync(svgFile, 'utf8')}`);
  await page.screenshot({ path: target, omitBackground: true, clip: { x: 0, y: 0, width, height } });
  await context.close();
}

await render(path.join(root, 'assets/icon.svg'), 256, 256, 1, path.join(app, 'icon.png'));
for (const [name, file] of [['logo', 'assets/logo.svg'], ['dark_logo', 'assets/dark_logo.svg']]) {
  await render(path.join(root, file), 512, 128, 1, path.join(app, `${name}.png`));
  await render(path.join(root, file), 512, 128, 2, path.join(app, `${name}@2x.png`));
}
await browser.close();
console.log('Pictures written to', app);
