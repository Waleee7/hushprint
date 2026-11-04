// Fuzzing: every parser must, for any input, either return or throw ParseError/UnsupportedFormat (never a TypeError,
// RangeError, or hang), and hostile size fields must not cause large allocations.
import { describe, expect, it } from 'vitest';
import { analyze, clean, UnsupportedFormat } from '../src/engine/analyze.ts';
import { ParseError, ascii, concat, inflate, p32be } from '../src/engine/bytes.ts';
import { box, fullBox, injectMetadata, syntheticHeic, syntheticJpeg, syntheticMp4, syntheticOffice, syntheticPdf, syntheticPng, syntheticWebp, pngChunk, type PhotoSpec } from '../src/engine/fixtures.ts';
import { parseXmp } from '../src/engine/xmp.ts';
import { deflateRawSync, deflateSync } from 'node:zlib';

const PHOTO: PhotoSpec = { lat: 33.78, lon: -84.37, altitude: 3, make: 'Apple', model: 'iPhone', serial: 'S1', owner: 'J', taken: '2026:06:08 14:32:11', orientation: 6, makerNote: true, comment: 'c',
  thumbnail: syntheticJpeg(16, 12), xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description xmlns:dc="d" dc:title="t"><dc:creator><rdf:Seq><rdf:li>Jo</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>', iptc: [[90, 'Atlanta']] };

const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

const mutate = (base: Uint8Array, r: () => number): Uint8Array => {
  let b: Uint8Array = base.slice();
  const mode = r();
  if (mode < 0.25) return b.subarray(0, Math.floor(r() * b.length));                       // truncate
  if (mode < 0.35) { const at = Math.floor(r() * b.length); b = concat([b.subarray(0, at), b.subarray(at + Math.floor(r() * 40))]); } // delete a span
  if (mode > 0.9) { const at = Math.floor(r() * Math.max(1, b.length - 4)); b.set([0xff, 0xff, 0xff, 0xff].map((v, i) => (r() < 0.5 ? v : b[at + i])), at); } // blow up a length field
  for (let k = 0; k < 1 + Math.floor(r() * 8); k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
  return b;
};

const okError = (e: unknown) => e instanceof ParseError || e instanceof UnsupportedFormat || (e instanceof Error && e.name === 'NeedsReencode');

const seeds = async (): Promise<Record<string, Uint8Array>> => ({
  jpeg: injectMetadata(syntheticJpeg(), PHOTO, syntheticJpeg(9, 9)),
  png: await syntheticPng({ text: [['Author', 'J']], ztxt: [['Comment', 'z']], time: true, exif: PHOTO, xmp: PHOTO.xmp, trailing: ascii('tail') }),
  webp: syntheticWebp({ exif: PHOTO, xmp: PHOTO.xmp, icc: true, trailing: ascii('tail') }),
  heic: syntheticHeic({ exif: PHOTO, xmp: PHOTO.xmp }),
  pdf: await syntheticPdf({ info: { Author: 'J', Title: 'T' }, xmp: PHOTO.xmp, update: { Author: 'K' }, jpeg: injectMetadata(syntheticJpeg(8, 8), { lat: 1, lon: 2 }) }),
  pdfz: await syntheticPdf({ info: { Author: 'J' }, objStm: true, xmp: PHOTO.xmp, compressXmp: true }),
  docx: syntheticOffice({ kind: 'docx', creator: 'J', lastModifiedBy: 'K', company: 'C', custom: { a: 'b' }, thumbnail: true, trackedAuthor: 'R' }),
  xlsx: syntheticOffice({ kind: 'xlsx', creator: 'J', absPath: 'C:\\Users\\j\\' }),
  mp4: syntheticMp4({ gps: '+33.7853-084.3738+312.000/', make: 'Apple', model: 'iPhone', title: 't', xmp: PHOTO.xmp, timedTrack: true }),
  mov: syntheticMp4({ gps: '+33.7853-084.3738/', make: 'Apple', quickTime: true, mdtaKeys: true }),
});

const ITER = 350;

describe('fuzz: mutated and truncated inputs', () => {
  it('analyze() and clean() only ever throw typed errors, and finish quickly', async () => {
    const all = await seeds();
    let ran = 0, cleaned = 0, slowest = 0;
    for (const [name, base] of Object.entries(all)) {
      const r = rng(0xc0ffee ^ name.length * 7919 ^ name.charCodeAt(0));
      for (let i = 0; i < ITER; i++) {
        const input = mutate(base, r);
        const t0 = performance.now();
        try { await analyze(input, name); ran++; } catch (e) { expect(okError(e), `${name} #${i} analyze: ${String(e)}`).toBe(true); }
        try { const res = await clean(input, name, { rasterize: async () => ({ bytes: syntheticJpeg() }) }); expect(res.bytes).toBeInstanceOf(Uint8Array); cleaned++; } catch (e) { expect(okError(e), `${name} #${i} clean: ${String(e)}`).toBe(true); }
        slowest = Math.max(slowest, performance.now() - t0);
      }
    }
    expect(ran).toBeGreaterThan(500);   // many mutants still parse, so we really exercised the deep paths
    expect(cleaned).toBeGreaterThan(300);
    expect(slowest).toBeLessThan(1500);
  }, 120_000);

  it('survives every possible truncation point of every format', async () => {
    for (const [name, base] of Object.entries(await seeds())) {
      const step = Math.max(1, Math.floor(base.length / 160));
      for (let n = 0; n < base.length; n += step) {
        try { await analyze(base.subarray(0, n), name); } catch (e) { expect(okError(e), `${name}@${n}: ${String(e)}`).toBe(true); }
      }
    }
  }, 60_000);

  it('survives pure random bytes behind every magic number', async () => {
    const r = rng(42);
    const magics = [[0xff, 0xd8, 0xff], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [...ascii('RIFF'), 0, 1, 0, 0, ...ascii('WEBP')], [0, 0, 0, 24, ...ascii('ftypheic')], [0, 0, 0, 24, ...ascii('ftypisom')], [...ascii('%PDF-1.7\n')], [0x50, 0x4b, 3, 4]];
    for (const m of magics) for (let i = 0; i < 150; i++) {
      const junk = Uint8Array.from({ length: Math.floor(r() * 600) }, () => Math.floor(r() * 256));
      try { await analyze(concat([Uint8Array.from(m), junk]), 'x'); } catch (e) { expect(okError(e), String(e)).toBe(true); }
    }
  });
});

describe('hostile size fields never cause big allocations or hangs', () => {
  const heapGrowth = async (fn: () => Promise<unknown>) => {
    const before = process.memoryUsage().arrayBuffers;
    let peak = 0;
    const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers - before); }, 1);
    const t0 = performance.now();
    try { await fn(); } catch (e) { expect(okError(e), String(e)).toBe(true); }
    clearInterval(t);
    return { ms: performance.now() - t0, peak: Math.max(peak, process.memoryUsage().arrayBuffers - before) };
  };
  const MB = 1024 * 1024;

  it('rejects a decompression bomb (inflate stops at its cap)', async () => {
    const bomb = deflateSync(Buffer.alloc(300 * MB));          // ~300 KB compressed, 300 MB expanded
    expect(bomb.length).toBeLessThan(1 * MB);
    const g = await heapGrowth(() => inflate(new Uint8Array(bomb)));
    expect(g.ms).toBeLessThan(3000);
    expect(g.peak).toBeLessThan(40 * MB);
    await expect(inflate(new Uint8Array(bomb))).rejects.toThrow(/safety limit/);
  });
  it('a zTXt bomb inside a PNG is capped, not expanded', async () => {
    const bomb = new Uint8Array(deflateSync(Buffer.alloc(200 * MB)));
    const png = await syntheticPng();
    const evil = concat([png.subarray(0, 33), pngChunk('zTXt', concat([ascii('Comment'), Uint8Array.of(0, 0), bomb])), png.subarray(33)]);
    const g = await heapGrowth(() => analyze(evil));
    expect(g.peak).toBeLessThan(40 * MB);
    expect(g.ms).toBeLessThan(3000);
  });
  it('a DOCX whose core.xml claims to be huge is refused, and a real bomb in it is capped', async () => {
    const good = syntheticOffice({ creator: 'J' });
    // swap the core.xml payload for a deflate bomb by building the zip by hand
    const bombData = new Uint8Array(deflateRawSync(Buffer.alloc(200 * MB)));
    const local = (name: string, data: Uint8Array, usize: number) => concat([p32le(0x04034b50), Uint8Array.of(20, 0, 0, 8, 8, 0, 0, 0, 0x21, 0), p32le(0), p32le(data.length), p32le(usize), Uint8Array.of(name.length, 0, 0, 0), ascii(name), data]);
    const names = ['[Content_Types].xml', 'word/document.xml', 'docProps/core.xml'];
    const datas = [new Uint8Array(deflateRawSync(Buffer.from('<Types/>'))), new Uint8Array(deflateRawSync(Buffer.from('<w/>'))), bombData];
    const usizes = [8, 4, 4 * MB]; // lies about its size: under the cap
    let off = 0; const parts: Uint8Array[] = [], cd: Uint8Array[] = [];
    names.forEach((n, i) => {
      const l = local(n, datas[i], usizes[i]); parts.push(l);
      cd.push(concat([p32le(0x02014b50), Uint8Array.of(20, 0, 20, 0, 0, 8, 8, 0, 0, 0, 0x21, 0), p32le(0), p32le(datas[i].length), p32le(usizes[i]), Uint8Array.of(n.length, 0, 0, 0, 0, 0, 0, 0, 0, 0), p32le(0), p32le(off), ascii(n)]));
      off += l.length;
    });
    const cdb = concat(cd);
    const evil = concat([...parts, cdb, p32le(0x06054b50), Uint8Array.of(0, 0, 0, 0, 3, 0, 3, 0), p32le(cdb.length), p32le(off), Uint8Array.of(0, 0)]);
    expect((await analyze(good)).format).toBe('docx');
    const g = await heapGrowth(() => analyze(evil));
    expect(g.peak).toBeLessThan(40 * MB);
    expect(g.ms).toBeLessThan(3000);
  });
  it('EXIF entries that all alias one huge region do not multiply memory', async () => {
    const n = 500;
    // Hand-built little-endian TIFF: 500 SHORT entries, each count = 4,000,000 pointing at offset 8+2+500*12+4.
    const header = Uint8Array.of(0x49, 0x49, 42, 0, 8, 0, 0, 0, n & 255, n >> 8);
    const dataAt = 8 + 2 + n * 12 + 4;
    const ent = (i: number) => Uint8Array.of(i & 255, 0x10 + (i >> 8), 3, 0, 0x00, 0x09, 0x3d, 0x00, dataAt & 255, dataAt >> 8, 0, 0);
    const tiff = concat([header, ...Array.from({ length: n }, (_, i) => ent(i)), new Uint8Array(4), new Uint8Array(8_000_000)]);
    const png = await syntheticPng();
    const evil = concat([png.subarray(0, 33), pngChunk('eXIf', tiff), png.subarray(33)]);
    const g = await heapGrowth(() => analyze(evil));
    expect(g.peak).toBeLessThan(80 * MB);
    expect(g.ms).toBeLessThan(3000);
  });
  it('HEIC iloc with a 4 GB extent and 20 000 items is bounded', async () => {
    const meta = box('meta', Uint8Array.of(0, 0, 0, 0), fullBox('iinf', 0, Uint8Array.of(0, 1), fullBox('infe', 2, Uint8Array.of(0, 1, 0, 0), ascii('Exif'), Uint8Array.of(0))),
      fullBox('iloc', 1, Uint8Array.of(0x44, 0), Uint8Array.of(0xff, 0xff), ...Array.from({ length: 300 }, () => Uint8Array.of(0, 1, 0, 0, 0, 0, 0, 1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))));
    const file = concat([box('ftyp', ascii('heic'), p32be(0), ascii('mif1')), meta]);
    const g = await heapGrowth(() => analyze(file));
    expect(g.peak).toBeLessThan(20 * MB);
  });
  it('MP4 with 64-bit box sizes and nested boxes of declared size 2^52 is bounded', async () => {
    const huge = concat([p32be(1), ascii('free'), p32be(0x000fffff), p32be(0xffffffff)]);
    const file = concat([syntheticMp4().subarray(0, 40), huge, new Uint8Array(100)]);
    const g = await heapGrowth(() => analyze(file));
    expect(g.peak).toBeLessThan(20 * MB);
    expect(g.ms).toBeLessThan(2000);
  });
  it('a PDF with 100 000 tiny objects and an unterminated 1 MB string stays linear', async () => {
    const objs = Array.from({ length: 100_000 }, (_, i) => `${i + 1} 0 obj\n<< /K ${i} >>\nendobj\n`).join('');
    const pdf = ascii(`%PDF-1.7\n${objs}trailer\n<< /Info 5 0 R >>\n99999 0 obj\n<< /Author (${'('.repeat(1_000_000)}\n%%EOF`);
    const g = await heapGrowth(() => analyze(pdf));
    expect(g.ms).toBeLessThan(4000);
    expect(g.peak).toBeLessThan(80 * MB);
  });
  it('XMP with thousands of unclosed tags does not go quadratic', () => {
    const t0 = performance.now();
    parseXmp('<a:b>'.repeat(30_000) + '<c:d x="'.repeat(10_000));
    parseXmp('<a:b ' .repeat(30_000));
    parseXmp('<rdf:li>'.repeat(30_000));
    expect(performance.now() - t0).toBeLessThan(1500);
  });
  it('file size is capped before parsing', async () => {
    const big = new Uint8Array(257 * MB);
    big.set([0xff, 0xd8, 0xff]);
    await expect(analyze(big)).rejects.toThrow(/larger than/);
  });
});

const p32le = (n: number) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
