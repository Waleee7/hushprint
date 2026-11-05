import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectMetadata, syntheticJpeg, syntheticPdf, syntheticHeic } from '../src/engine/fixtures.ts';
import { randomName, cleanName, safeZipPath } from '../src/engine/names.ts';
import { parseArgs } from '../src/cli.ts';

const bin = join(import.meta.dirname, '..', 'bin', 'hushprint.mjs');
const run = (...a: string[]) => spawnSync('node', [bin, ...a], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hp-cli-'));
  writeFileSync(join(dir, 'IMG_1.jpg'), injectMetadata(syntheticJpeg(), { make: 'Apple', model: 'iPhone', lat: 33.78, lon: -84.37, serial: 'CLI-SN-1' }));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'a.pdf'), await syntheticPdf({ info: { Author: 'Cli Person' } }));
  writeFileSync(join(dir, 'docs', 'readme.txt'), 'ignored in folders');
  return dir;
};

describe('cli', () => {
  it('scan prints findings and a score, and --fail-on sets the exit code', async () => {
    const dir = await setup();
    const r = run('scan', join(dir, 'IMG_1.jpg'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CLI-SN-1');
    expect(r.stdout).toMatch(/score \d+\/100/);
    expect(run('scan', join(dir, 'IMG_1.jpg'), '--fail-on', 'critical').status).toBe(1);
    const j = JSON.parse(run('scan', dir, '--json').stdout);
    expect(j.files).toHaveLength(2); // .txt skipped when walking a folder
    expect(j.batchScore).toBeLessThanOrEqual(j.files[0].score);
  });
  it('clean writes a verified copy beside the original and never overwrites', async () => {
    const dir = await setup();
    const r = run('clean', join(dir, 'IMG_1.jpg'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('verified');
    const out = join(dir, 'IMG_1-clean.jpg');
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out).includes('CLI-SN-1')).toBe(false);
    expect(readFileSync(join(dir, 'IMG_1.jpg')).includes('CLI-SN-1')).toBe(true); // original untouched
    const again = run('clean', join(dir, 'IMG_1.jpg'));
    expect(again.status).toBe(2); // 'wx': refuses to clobber the existing output
  });
  it('--share-safe --out gives random names', async () => {
    const dir = await setup();
    const out = join(dir, 'out');
    const r = run('clean', dir, '--share-safe', '--out', out);
    expect(r.status).toBe(0);
    const names = readdirSync(out);
    expect(names).toHaveLength(2);
    for (const n of names) expect(n).toMatch(/^hp-[0-9a-f]{12}\.(jpg|pdf)$/);
  });
  it('reports HEIC as scan-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-cli-'));
    writeFileSync(join(dir, 'x.heic'), syntheticHeic({ exif: { make: 'Apple', lat: 1, lon: 2 } }));
    expect(run('scan', join(dir, 'x.heic')).stdout).toContain('Apple');
    const c = run('clean', join(dir, 'x.heic'));
    expect(c.status).toBe(2);
    expect(c.stderr).toMatch(/HEIC cannot be cleaned losslessly/);
  });
  it('gives usage errors a non-zero exit', () => {
    expect(run('frobnicate', 'x').status).toBe(2);
    expect(run('scan').status).toBe(2);
    expect(() => parseArgs(['scan', '--fail-on', 'bad'])).toThrow();
    expect(execFileSync('node', [bin, '--help'], { encoding: 'utf8' })).toContain('Usage');
  });
});

describe('names', () => {
  it('random names are 48 bits, well formed, and the extension follows the real format', () => {
    expect(randomName('jpeg')).toMatch(/^hp-[0-9a-f]{12}\.jpg$/);
    expect(randomName('jpeg')).not.toBe(randomName('jpeg'));
    expect(cleanName('/a/b/IMG 1.HEIC', 'jpeg')).toBe('IMG 1-clean.jpg');
  });
  it('zip paths cannot escape', () => {
    expect(safeZipPath('../../etc/passwd')).toBe('etc/passwd');
    expect(safeZipPath('C:\\Users\\x\\a.jpg')).toBe('_/Users/x/a.jpg');
    expect(safeZipPath('/abs/a.jpg')).toBe('abs/a.jpg');
  });
});

// ---- security regressions (coordinator review of src/cli.ts) ----
import { vi } from 'vitest';
import { lstatSync, symlinkSync } from 'node:fs';
import { analyze as realAnalyze, clean as realClean } from '../src/engine/analyze.ts';
import { main, sanitize } from '../src/cli.ts';

const capture = async (argv: string[], deps = {}) => {
  const out: string[] = [], err: string[] = [];
  const l = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  const e = vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  try { const status = await main(argv, deps); return { status, out: out.join('\n'), err: err.join('\n') }; } finally { l.mockRestore(); e.mockRestore(); }
};
// eslint-disable-next-line no-control-regex
const DANGEROUS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

describe('cli: terminal escape injection', () => {
  const EVIL = '\u001b]0;pwned\u0007\u001b[2J\u009b31m\u202eevil\u2066x\u0085\r';
  it('sanitize() turns controls, C1 and bidi overrides into visible escapes', () => {
    const s = sanitize(`a${EVIL}b`);
    expect(DANGEROUS.test(s)).toBe(false);
    expect(s).toContain('\\x1b]0;pwned\\x07');
    expect(s).toContain('\\x9b');
    expect(s).toContain('\\u202e');
    expect(s).toContain('\\x0d');
    expect(sanitize('plain ünïcode 日本')).toBe('plain ünïcode 日本');
  });
  it('human-readable scan output never contains a control code from labels, values, sources or file names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-esc-'));
    const file = join(dir, `ph\u001b[31moto\u202e.jpg`);
    writeFileSync(file, injectMetadata(syntheticJpeg(), { make: EVIL, model: EVIL, owner: EVIL, comment: EVIL, lat: 1, lon: 2 }));
    const r = await capture(['scan', file]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('pwned'); // content is shown...
    expect(DANGEROUS.test(r.out)).toBe(false); // ...but defanged
    expect(r.out).toContain('\\x1b');
  });
  it('clean output and error messages are defanged too (dest path, file name in errors, engine error text)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-esc-'));
    const bad = join(dir, `not\u001b[2Jimage\u202e.jpg`);
    writeFileSync(bad, 'this is not an image');
    const r = await capture(['clean', bad]);
    expect(r.status).toBe(2);
    expect(DANGEROUS.test(r.err + r.out)).toBe(false);
    const good = join(dir, `ok\u001b]0;x\u0007.jpg`);
    writeFileSync(good, injectMetadata(syntheticJpeg(), { make: 'Apple', lat: 1, lon: 2 }));
    const c = await capture(['clean', good]);
    expect(c.status).toBe(0);
    expect(DANGEROUS.test(c.out + c.err)).toBe(false);
    const w = await capture(['scan', good], { analyze: async (b: Uint8Array, n?: string) => ({ ...(await realAnalyze(b, n)), warnings: [EVIL] }) });
    expect(DANGEROUS.test(w.out)).toBe(false);
  });
  it('--json keeps the raw text but as an escaped JSON string', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-esc-'));
    const file = join(dir, 'a.jpg');
    writeFileSync(file, injectMetadata(syntheticJpeg(), { make: EVIL, lat: 1, lon: 2 }));
    const r = await capture(['scan', file, '--json']);
    expect(DANGEROUS.test(r.out)).toBe(false);
    expect(JSON.parse(r.out).files[0].findings.some((f: { value: string }) => f.value.includes('\u001b'))).toBe(true);
  });
});

describe('cli: fail closed on unverified output', () => {
  const unverified = async (b: Uint8Array, n?: string, o?: Parameters<typeof realClean>[2]) => ({ ...(await realClean(b, n, o)), verified: false });
  const mk = () => { const dir = mkdtempSync(join(tmpdir(), 'hp-ver-')); const f = join(dir, 'a.jpg'); writeFileSync(f, injectMetadata(syntheticJpeg(), { make: 'Apple', lat: 1, lon: 2 })); return { dir, f }; };
  for (const json of [false, true]) {
    it(`exits 2 and writes nothing when verification fails (${json ? '--json' : 'text'})`, async () => {
      const { dir, f } = mk();
      const r = await capture(['clean', f, ...(json ? ['--json'] : [])], { clean: unverified });
      expect(r.status).toBe(2);
      expect(readdirSync(dir)).toEqual(['a.jpg']);
      if (json) { const j = JSON.parse(r.out); expect(j.files[0].verified).toBe(false); expect(j.files[0].error).toMatch(/verification failed/); }
      else expect(r.err).toMatch(/verification failed/);
    });
  }
  it('--allow-unverified writes only a clearly marked copy and still exits 2', async () => {
    const { dir, f } = mk();
    const r = await capture(['clean', f, '--allow-unverified', '--json'], { clean: unverified });
    expect(r.status).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['a-clean-UNVERIFIED.jpg', 'a.jpg']);
    expect(JSON.parse(r.out).files[0].output).toMatch(/UNVERIFIED/);
  });
  it('a verified run is unaffected', async () => {
    const { dir, f } = mk();
    expect((await capture(['clean', f, '--json'])).status).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['a-clean.jpg', 'a.jpg']);
  });
});

describe('cli: filesystem safety', () => {
  const tree = () => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-fs-'));
    writeFileSync(join(dir, 'real.jpg'), injectMetadata(syntheticJpeg(), { make: 'Apple', lat: 1, lon: 2 }));
    return dir;
  };
  it('does not follow symlinks found while walking a folder', async () => {
    const dir = tree();
    const outside = mkdtempSync(join(tmpdir(), 'hp-outside-'));
    writeFileSync(join(outside, 'secret.jpg'), injectMetadata(syntheticJpeg(), { make: 'Secret', lat: 3, lon: 4 }));
    symlinkSync(join(outside, 'secret.jpg'), join(dir, 'link.jpg'));
    symlinkSync(outside, join(dir, 'linkdir'));
    const r = await capture(['scan', dir, '--json']);
    const j = JSON.parse(r.out);
    expect(j.files).toHaveLength(1);
    expect(JSON.stringify(j)).not.toContain('Secret');
    expect(r.err).toMatch(/skipped .*link\.jpg.* \(symlink\)/);
  });
  it('refuses an explicitly named symlink and never reads through it', async () => {
    const dir = tree();
    symlinkSync(join(dir, 'real.jpg'), join(dir, 'link.jpg'));
    expect(lstatSync(join(dir, 'link.jpg')).isSymbolicLink()).toBe(true);
    const r = await capture(['clean', join(dir, 'link.jpg')]);
    expect(r.status).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['link.jpg', 'real.jpg']);
  });
  it('refuses non-regular files named explicitly (directory handled by walking; fifo/device skipped)', async () => {
    const r = await capture(['scan', '/dev/null']);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/not a regular file/);
  });
  it('enforces the per-file size limit on the open handle, before parsing', async () => {
    const dir = tree();
    const seen = vi.fn(realAnalyze);
    const r = await capture(['scan', join(dir, 'real.jpg')], { maxFile: 100, analyze: seen });
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/larger than/);
    expect(seen).not.toHaveBeenCalled();
  });
  it('caps the number of files and the total bytes per run', async () => {
    const dir = tree();
    writeFileSync(join(dir, 'two.jpg'), readFileSync(join(dir, 'real.jpg')));
    const many = await capture(['scan', dir], { maxFiles: 1 });
    expect(many.status).toBe(2);
    expect(many.err).toMatch(/more than 1 files/);
    const big = await capture(['scan', dir], { maxBytes: 10 });
    expect(big.status).toBe(2);
    expect(big.err).toMatch(/in total/);
  });
});
