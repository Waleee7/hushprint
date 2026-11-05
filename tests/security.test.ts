// Static guards for the security posture. They fail the build if someone weakens it.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CSP } from '../vite.config.ts';

const root = join(import.meta.dirname, '..');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe('no file content can reach an HTML or code sink', () => {
  const files = walk(join(root, 'src')).filter((f) => /\.(tsx?|js)$/.test(f));
  for (const [name, re] of [['innerHTML / outerHTML', /\b(inner|outer)HTML\b/], ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/], ['insertAdjacentHTML', /insertAdjacentHTML/], ['document.write', /document\.write/], ['eval', /\beval\s*\(/], ['new Function', /new Function\s*\(/], ['setTimeout with a string', /setTimeout\s*\(\s*['"`]/], ['DOMParser', /DOMParser/], ['createContextualFragment', /createContextualFragment/]] as const) {
    it(`src/ has no ${name}`, () => { for (const f of files) expect(re.test(readFileSync(f, 'utf8')), `${f} uses ${name}`).toBe(false); });
  }
});

describe('Content-Security-Policy', () => {
  const dirs = (csp: string) => Object.fromEntries(csp.split(';').map((s) => s.trim()).filter(Boolean).map((s) => [s.split(' ')[0], s.split(' ').slice(1).join(' ')]));
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
  const pageCsp = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy')!.value;
  it('forbids every network request from the page', () => {
    for (const csp of [CSP, pageCsp]) { const d = dirs(csp); expect(d['connect-src']).toBe("'none'"); expect(d['default-src']).toBe("'none'"); }
  });
  it('allows no inline script/style, eval, remote hosts or plugins', () => {
    for (const csp of [CSP, pageCsp]) {
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
      const d = dirs(csp); expect(d['script-src']).toBe("'self'"); expect(d['object-src']).toBe("'none'"); expect(d['base-uri']).toBe("'none'"); expect(d['form-action']).toBe("'none'");
    }
  });
  it('enforces Trusted Types with exactly one named policy', () => {
    for (const csp of [CSP, pageCsp]) { const d = dirs(csp); expect(d['require-trusted-types-for']).toBe("'script'"); expect(d['trusted-types']).toBe('hushprint-sw'); }
  });
  it('the meta CSP and the vercel.json header agree on every shared directive', () => {
    const a = dirs(CSP), b = dirs(pageCsp);
    for (const k of Object.keys(a)) expect(b[k], k).toBe(a[k]);
  });
  it('only the service worker script may fetch, and only from its own origin', () => {
    const sw = vercel.headers[1];
    expect(sw.source).toBe('/sw.js');
    expect(sw.headers.find((h) => h.key === 'Content-Security-Policy')!.value).toBe("default-src 'none'; connect-src 'self'");
  });
  it('the service worker ignores cross-origin requests', () => {
    expect(readFileSync(join(root, 'sw', 'sw.js'), 'utf8')).toMatch(/origin !== self\.location\.origin\) return/);
  });
});

describe('web UI fails closed on verification', () => {
  it('rejects an unverified clean result before it can be stamped or downloaded', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const gate = app.indexOf('if (!result.verified) throw');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(app.indexOf('done.push({ ...i, result, mode, outName'));
  });
});
