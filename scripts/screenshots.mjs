// Usage: npm run build && npx vite preview --port 4173 & node scripts/screenshots.mjs
// Needs playwright; set PLAYWRIGHT_PATH if it is not resolvable from here.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const base = process.env.URL ?? 'http://localhost:4173';
const out = process.env.OUT ?? 'docs';
const browser = await chromium.launch();
const problems = [];
for (const [name, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: name === 'mobile' ? 2 : 1, acceptDownloads: true, hasTouch: name === 'mobile' });
  const page = await ctx.newPage();
  const external = [];
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${name} console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
  await page.goto(base); await page.waitForSelector('h1');
  await page.screenshot({ path: `${out}/${name}-empty.png` });
  await page.getByRole('button', { name: /Try a sample/ }).click();
  await page.waitForSelector('.card');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}-loaded.png` });
  await page.screenshot({ path: `${out}/${name}-loaded-full.png`, fullPage: true });
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: /Clean & download/ }).click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${out}/${name}-scrubbing.png` });
  const d = await dl; problems.push(`${name} download: ${d.suggestedFilename()}`);
  await page.waitForSelector('.sev-bg-clean'); await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/${name}-cleaned.png` });
  await page.screenshot({ path: `${out}/${name}-cleaned-full.png`, fullPage: true });
  const csp = await page.evaluate(() => window.__csp);
  problems.push(`${name} external requests: ${JSON.stringify(external)}  csp violations: ${JSON.stringify(csp)}`);
  await ctx.close();
}
await browser.close();
console.log(problems.join('\n'));
