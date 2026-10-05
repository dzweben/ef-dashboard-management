// Screenshot the built preview with Playwright (dev tool, not part of the site).
//   node scripts/build.mjs --preview && node scripts/screenshot.mjs [tab] [--phone] [--name x] [--file dist/preview.html]
// Prints console errors and page errors; writes shots/<name>.png.
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node22/lib/node_modules/playwright');
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, d) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : d;
};
const tab = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true) || 'overview';
const phone = flag('--phone');
const file = resolve(root, opt('--file', 'dist/preview.html'));
const name = opt('--name', `${tab}${phone ? '-phone' : ''}`);
const fullPage = !flag('--viewport-only');

if (!existsSync(file)) {
  console.error(`missing ${file}; run: node scripts/build.mjs --preview`);
  process.exit(1);
}

const launchOpts = { headless: true };
if (existsSync('/opt/pw-browsers/chromium')) {
  // let playwright find its own build via PLAYWRIGHT_BROWSERS_PATH; fall back to explicit path on mismatch
}
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxy) launchOpts.proxy = { server: proxy };

let browser;
try {
  browser = await playwright.chromium.launch(launchOpts);
} catch (err) {
  browser = await playwright.chromium.launch({ ...launchOpts, executablePath: '/opt/pw-browsers/chromium' });
}
const context = await browser.newContext({
  viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
  deviceScaleFactor: phone ? 2 : 1,
  isMobile: phone,
  hasTouch: phone,
  ignoreHTTPSErrors: true,
  timezoneId: 'America/New_York',
});
const page = await context.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`[console.${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`));

const url = pathToFileURL(file).href + (tab ? `#${tab}` : '');
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(opt('--wait', '1200')));
mkdirSync(join(root, 'shots'), { recursive: true });
const out = join(root, 'shots', `${name}.png`);
await page.screenshot({ path: out, fullPage });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
console.log(`shot: ${out}`);
console.log(`horizontal overflow: ${overflow}px`);
if (errors.length) console.log(errors.join('\n'));
else console.log('no console errors');
await browser.close();
