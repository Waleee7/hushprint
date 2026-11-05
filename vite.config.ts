import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Strict CSP, injected only into the production build (dev server needs inline HMR scripts).
// connect-src 'none' means the page cannot make ANY fetch/XHR/WebSocket request, ever.
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'none'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types hushprint-sw",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const cspPlugin = (): Plugin => ({
  name: 'hushprint-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

// Precache list = every file Vite emitted (hashed names) plus the shell. The version is a hash of that list,
// so a new build always replaces the old cache.
const pwaPlugin = (): Plugin => ({
  name: 'hushprint-pwa',
  apply: 'build',
  generateBundle(_, bundle) {
    const files = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png',
      ...Object.keys(bundle).filter((f) => f !== 'sw.js').map((f) => `/${f}`)];
    const version = createHash('sha256').update(files.join('\n') + Object.values(bundle).map((c) => ('code' in c ? c.code.length : c.source.length)).join(',')).digest('hex').slice(0, 12);
    const src = readFileSync(new URL('./sw/sw.js', import.meta.url), 'utf8').replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(files));
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
  },
});

export default defineConfig({
  plugins: [react(), cspPlugin(), pwaPlugin()],
  build: { target: 'es2022', assetsInlineLimit: 0 },
  test: { include: ['tests/**/*.test.ts'] },
});
