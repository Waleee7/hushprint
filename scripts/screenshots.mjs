// End-to-end check + screenshots against the PRODUCTION build served with vercel.json headers.
//   npm run build && node scripts/serve-prod.mjs 4174 &
//   PLAYWRIGHT_PATH=/path/to/playwright OUT=/some/dir node scripts/screenshots.mjs
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { injectMetadata, syntheticJpeg, syntheticPdf } from '../src/engine/fixtures.ts';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const base = process.env.URL ?? 'http://localhost:4174';
const out = process.env.OUT ?? 'docs';
mkdirSync(out, { recursive: true });
const problems = [], notes = [];
const fail = (m) => problems.push('FAIL ' + m);

// fixtures for the injection + folder tests
const work = mkdtempSync(join(tmpdir(), 'hp-e2e-'));
const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
writeFileSync(join(work, 'evil.jpg'), injectMetadata(syntheticJpeg(), { make: evil, owner: evil, comment: evil, lat: 10, lon: 10 }));
mkdirSync(join(work, 'trip', 'day1'), { recursive: true });
writeFileSync(join(work, 'trip', 'a.jpg'), injectMetadata(syntheticJpeg(), { make: 'Apple', lat: 33.78, lon: -84.37 }));
writeFileSync(join(work, 'trip', 'day1', 'b.pdf'), await syntheticPdf({ info: { Author: 'Folder Person' } }));
writeFileSync(join(work, 'trip', 'notes.txt'), 'not supported');

const browser = await chromium.launch();
for (const [name, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: name === 'mobile' ? 2 : 1, acceptDownloads: true, hasTouch: name === 'mobile' });
  const page = await ctx.newPage();
  const external = [];
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });
  page.on('console', (m) => { if (m.type() === 'error') fail(`${name} console: ${m.text()}`); });
  page.on('pageerror', (e) => fail(`${name} pageerror: ${e.message}`));
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
  await page.goto(base); await page.waitForSelector('h1');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}-empty.png` });

  // sample pack
  await page.getByRole('button', { name: /Try a sample/ }).click();
  await page.waitForSelector('.card');
  await page.waitForFunction(() => document.querySelectorAll('.file').length >= 4 && !document.body.textContent.includes('Scanning'), null, { timeout: 15000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}-loaded.png` });
  await page.screenshot({ path: `${out}/${name}-loaded-full.png`, fullPage: true });
  await page.locator('.file', { hasText: 'offer-letter.pdf' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}-pdf.png` });
  await page.locator('.file', { hasText: 'q3-plan.docx' }).click(); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}-docx-full.png`, fullPage: true });

  let dl = page.waitForEvent('download');
  await page.getByRole('button', { name: /Clean & download/ }).click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${out}/${name}-scrubbing.png` });
  let d = await dl; notes.push(`${name} normal download: ${d.suggestedFilename()}`);
  const normalZip = join(work, `${name}-normal.zip`); await d.saveAs(normalZip);
  notes.push(`${name} normal zip: ${execFileSync('unzip', ['-Z1', normalZip]).toString().trim().split('\n').join(', ')}`);
  await page.waitForSelector('.sev-bg-clean, .sev-bg-medium'); await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/${name}-cleaned.png` });
  await page.screenshot({ path: `${out}/${name}-cleaned-full.png`, fullPage: true });

  // share-safe on the same batch
  dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Share-safe' }).click();
  d = await dl;
  const shareZip = join(work, `${name}-share.zip`); await d.saveAs(shareZip);
  const names = execFileSync('unzip', ['-Z1', shareZip]).toString().trim().split('\n');
  notes.push(`${name} share-safe zip: ${names.join(', ')}`);
  if (!names.every((n) => /^hp-[0-9a-f]{12}\.[a-z0-9]+$/.test(n))) fail(`${name} share-safe names not random: ${names}`);
  if (names.some((n) => /birthday|offer|q3-plan|ai-render|listing/.test(n))) fail(`${name} share-safe leaked an original name`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}-share.png` });

  // reset -> hostile metadata must render as text only
  await page.getByRole('button', { name: /Remove all/ }).click();
  await page.waitForSelector('h1');
  await page.setInputFiles('input[type=file]:not([webkitdirectory])', join(work, 'evil.jpg'));
  await page.waitForSelector('.card');
  await page.waitForTimeout(400);
  const xss = await page.evaluate(() => ({ flag: window.__xss, imgs: [...document.querySelectorAll('img')].filter((i) => i.getAttribute('src') === 'x').length, text: document.body.textContent.includes('<img src=x') }));
  if (xss.flag || xss.imgs) fail(`${name} metadata was interpreted as HTML: ${JSON.stringify(xss)}`);
  if (!xss.text) fail(`${name} hostile string was not displayed as text`);
  await page.screenshot({ path: `${out}/${name}-hostile.png` });

  // folder batch
  await page.getByRole('button', { name: /Remove all/ }).click();
  await page.waitForSelector('h1');
  await page.setInputFiles('input[webkitdirectory]', join(work, 'trip'));
  await page.waitForFunction(() => document.querySelectorAll('.file').length === 2, null, { timeout: 8000 }).catch(() => fail(`${name} folder batch: expected 2 files (txt skipped)`));
  dl = page.waitForEvent('download');
  await page.getByRole('button', { name: /Clean & download/ }).click();
  d = await dl; const fz = join(work, `${name}-folder.zip`); await d.saveAs(fz);
  notes.push(`${name} folder zip: ${execFileSync('unzip', ['-Z1', fz]).toString().trim().split('\n').join(', ')}`);

  // offline reload
  await ctx.setOffline(true);
  await page.reload(); 
  if (!(await page.waitForSelector('h1', { timeout: 5000 }).catch(() => null))) fail(`${name} offline reload failed`); else notes.push(`${name} offline reload OK`);
  await ctx.setOffline(false);

  const csp = await page.evaluate(() => window.__csp);
  if (external.length) fail(`${name} external requests: ${JSON.stringify(external)}`);
  if (csp.length) fail(`${name} csp violations: ${JSON.stringify(csp)}`);
  notes.push(`${name} external requests: ${external.length}, csp violations: ${csp.length}`);
  await ctx.close();
}
await browser.close();
console.log([...notes, ...problems].join('\n'));
if (problems.length) process.exit(1);
