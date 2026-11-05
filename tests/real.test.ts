// Files written by real encoders (ffmpeg, macOS ImageIO, Chromium/Skia), not by our own fixture builders.
// Metadata inside them is fictional. They prove the parsers work on genuine containers.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze, clean } from '../src/engine/analyze.ts';
import { toAscii } from '../src/engine/bytes.ts';
import { privacyScore, scoreBand, batchScore } from '../src/engine/score.ts';

const load = (n: string) => new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', n)));

describe('real-encoder files', () => {
  it('HEIC written by macOS ImageIO: finds GPS, serial, device', async () => {
    const a = await analyze(load('real.heic'), 'real.heic');
    expect(a.format).toBe('heic');
    expect(a.gps!.lat).toBeCloseTo(33.7853, 3);
    expect(a.findings.find((f) => f.label === 'Camera serial number')!.value).toBe('REAL-SN-777');
    expect(a.findings.find((f) => f.label === 'Camera / phone')!.value).toBe('Apple iPhone 15 Pro');
  });
  it('WebP from libwebp + injected EXIF/XMP: strips and still decodes structurally', async () => {
    const src = load('real.webp');
    const r = await clean(src, 'real.webp');
    expect(r.verified && r.pixelsIdentical).toBe(true);
    expect(toAscii(r.bytes)).not.toContain('REAL-SN-777');
    expect(toAscii(r.bytes)).not.toContain('Real Person');
    expect(r.after.score).toBe(100);
  });
  it('MP4 from ffmpeg: reads ISO 6709 GPS from an mdta key and strips in place', async () => {
    const src = load('real.mp4');
    const a = await analyze(src, 'real.mp4');
    expect(a.gps!.lon).toBeCloseTo(-84.3738, 3);
    expect(a.gps!.altitude).toBe(312);
    const r = await clean(src, 'real.mp4');
    expect(r.bytes.length).toBe(src.length);
    expect(r.verified && r.pixelsIdentical).toBe(true);
    expect(toAscii(r.bytes)).not.toContain('Backyard party');
    expect(r.after.findings).toEqual([]);
  });
  it('PDF from Chromium/Skia: reads Title/Creator/Producer/dates, blanks them in place', async () => {
    const src = load('real.pdf');
    const a = await analyze(src, 'real.pdf');
    expect(a.findings.find((f) => f.label === 'Title')!.value).toBe('Salary review Q3');
    expect(a.findings.find((f) => f.label === 'Produced by')!.value).toMatch(/Skia/);
    const r = await clean(src, 'real.pdf');
    expect(r.bytes.length).toBe(src.length);
    expect(r.verified && r.pixelsIdentical).toBe(true);
    expect(toAscii(r.bytes)).not.toContain('Salary review');
    expect(toAscii(r.bytes)).not.toContain('Skia/PDF');
  });
});

describe('privacy score', () => {
  const f = (severity: 'critical' | 'high' | 'medium' | 'low' | 'info', category = 'device' as const) => ({ id: Math.random().toString(), category, severity, label: 'x', value: 'y', why: '', source: '' });
  it('is 100 when nothing is found and ignores the orientation tag', () => {
    expect(privacyScore([])).toBe(100);
    expect(privacyScore([{ ...f('info'), label: 'Orientation' }])).toBe(100);
  });
  it('drops with severity and is capped per severity', () => {
    expect(privacyScore([f('low')])).toBe(98);
    expect(privacyScore([f('medium'), f('medium')])).toBe(84);
    expect(privacyScore(Array.from({ length: 50 }, () => f('low')))).toBe(92);
    expect(privacyScore(Array.from({ length: 50 }, () => f('high')))).toBe(60);
  });
  it('GPS coordinates cap the score at 25', () => {
    expect(privacyScore([f('critical', 'location' as never)])).toBe(25);
  });
  it('bands and batch (batch = the worst file)', () => {
    expect([100, 80, 50, 10].map(scoreBand)).toEqual(['quiet', 'low', 'leaky', 'exposed']);
    expect(batchScore([100, 20, 90])).toBe(20);
    expect(batchScore([])).toBeUndefined();
  });
});
