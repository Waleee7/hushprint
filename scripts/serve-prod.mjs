// Serves dist/ with the exact response headers from vercel.json, so CSP/Trusted Types/service worker behave as in production.
// Usage: node scripts/serve-prod.mjs [port]
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
const port = Number(process.argv[2] ?? 4174);
const rules = JSON.parse(readFileSync('vercel.json', 'utf8')).headers.map((h) => ({ re: new RegExp(`^${h.source}$`), headers: h.headers }));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json' };
createServer((req, res) => {
  const url = new URL(req.url, 'http://x').pathname;
  let file = join('dist', normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  const headers = { 'content-type': types[extname(file)] ?? 'application/octet-stream' };
  for (const r of rules) if (r.re.test(url)) for (const h of r.headers) headers[h.key.toLowerCase()] = h.value;
  res.writeHead(200, headers); res.end(readFileSync(file));
}).listen(port, () => console.log(`http://localhost:${port}`));
