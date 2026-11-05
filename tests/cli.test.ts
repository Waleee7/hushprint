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
