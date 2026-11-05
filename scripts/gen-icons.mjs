// Renders public/icons/*.png from the favicon artwork. Usage: node scripts/gen-icons.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const mark = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${32 + 2 * pad} ${32 + 2 * pad}"><rect x="${-pad}" y="${-pad}" width="${32 + 2 * pad}" height="${32 + 2 * pad}" fill="#090A0F"/><path d="M6 11V6h5M21 6h5v5M26 21v5h-5M11 26H6v-5" fill="none" stroke="#00FF66" stroke-width="2.4"/><path d="M11 21 21 11" stroke="#ECEEF6" stroke-width="2.4"/></svg>`;
const b = await chromium.launch();
for (const [file, size, pad] of [['icon-192', 192, 0], ['icon-512', 512, 0], ['maskable-512', 512, 8], ['apple-touch-icon', 180, 3]]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<body style="margin:0">${mark(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await p.screenshot({ path: `public/icons/${file}.png` });
  await p.close();
}
await b.close();
