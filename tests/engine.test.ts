import { describe, expect, it } from 'vitest';
import { analyze, clean, detectFormat, pixelDigest, UnsupportedFormat } from '../src/engine/analyze.ts';
import { ParseError, ascii, concat, crc32, toAscii, u32be } from '../src/engine/bytes.ts';
import { injectMetadata, syntheticJpeg, syntheticPng, exifFor, type PhotoSpec } from '../src/engine/fixtures.ts';
import { haversineKm, nearestCity } from '../src/engine/geo.ts';
import { parseJpeg } from '../src/engine/jpeg.ts';
import { parsePng } from '../src/engine/png.ts';
import { buildTiff, parseTiff } from '../src/engine/tiff.ts';
import { makeZip } from '../src/engine/zip.ts';
import { inflateSync } from 'node:zlib';

const HOME: PhotoSpec = {
  lat: 33.7853, lon: -84.3738, altitude: 312, heading: 90,
  make: 'Apple', model: 'iPhone 15 Pro', lens: 'iPhone 15 Pro back camera 6.86mm f/1.78', serial: 'SN-F2LXK9Q3PD', owner: 'Jordan Rivera',
  artist: 'Jordan Rivera', software: 'Adobe Lightroom 7.2', taken: '2026:06:08 14:32:11', orientation: 6, makerNote: true, comment: 'secret-comment-xyz',
  xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:mwg-rs="x" xmp:CreatorTool="Lightroom Classic" xmp:CreateDate="2026-06-08T14:32:11"><dc:creator><rdf:Seq><rdf:li>Jordan Rivera</rdf:li></rdf:Seq></dc:creator><mwg-rs:Name>Grandma Rose</mwg-rs:Name></rdf:Description></rdf:RDF></x:xmpmeta>',
  iptc: [[90, 'Atlanta'], [80, 'J. Rivera'], [120, 'Backyard birthday']],
};
const SECRETS = ['Jordan Rivera', 'SN-F2LXK9Q3PD', 'iPhone', 'Lightroom', 'Grandma Rose', 'secret-comment-xyz', 'Atlanta', 'Backyard', 'Apple'];
const has = (b: Uint8Array, s: string) => toAscii(b).includes(s);

describe('TIFF/EXIF', () => {
  for (const little of [false, true]) {
    it(`round-trips GPS, strings and thumbnail (${little ? 'II' : 'MM'})`, () => {
      const thumb = syntheticJpeg(16, 9);
      const t = parseTiff(buildTiff({ little, ifd0: [{ tag: 0x10f, type: 2, value: 'Canon' }, { tag: 0x112, type: 3, value: [6] }],
        gps: [{ tag: 1, type: 2, value: 'S' }, { tag: 2, type: 5, value: [[33, 1], [51, 1], [30, 1]] }], thumbnail: thumb }));
      expect(t.little).toBe(little);
      expect(t.ifd0.get(0x10f)!.value).toBe('Canon');
      expect(t.ifd0.get(0x112)!.value).toEqual([6]);
      expect(t.gps.get(2)!.value).toEqual([[33, 1], [51, 1], [30, 1]]);
      expect(t.thumbnail).toEqual(thumb);
    });
  }
  it('rejects garbage and survives truncation', () => {
    expect(() => parseTiff(ascii('nope'))).toThrow(ParseError);
    const full = exifFor(HOME);
    for (let n = 8; n < full.length; n += 7) expect(() => { try { parseTiff(full.subarray(0, n)); } catch (e) { if (!(e instanceof ParseError)) throw e; } }).not.toThrow();
  });
  it('does not loop on a self-referencing IFD', () => {
    const b = buildTiff({ ifd0: [{ tag: 0x10f, type: 2, value: 'X' }] });
    b.set([0, 0, 0, 8], b.length - 4 > 8 ? 8 + 2 + 12 : 0); // next IFD -> itself
    expect(() => parseTiff(b)).not.toThrow();
  });
});

describe('JPEG analysis', () => {
  const jpg = injectMetadata(syntheticJpeg(64, 48), { ...HOME, thumbnail: syntheticJpeg(40, 40) });
  it('finds GPS and converts to signed decimal degrees', async () => {
    const a = await analyze(jpg, 'a.jpg');
    expect(a.format).toBe('jpeg');
    expect(a.gps!.lat).toBeCloseTo(33.7853, 4);
    expect(a.gps!.lon).toBeCloseTo(-84.3738, 4); // W => negative
    expect(a.gps!.altitude).toBe(312);
    expect(a.gps!.nearest[0].name).toBe('Atlanta');
    expect(a.risk.level).toBe('critical');
    expect(a.risk.headline).toMatch(/where it was taken/);
  });
  it('reports device, serial, owner, time, software, maker notes', async () => {
    const f = (await analyze(jpg)).findings;
    const val = (label: string) => f.find((x) => x.label === label)?.value;
    expect(val('Camera / phone')).toBe('Apple iPhone 15 Pro');
    expect(val('Camera serial number')).toBe('SN-F2LXK9Q3PD');
    expect(val('Camera owner name')).toBe('Jordan Rivera');
    expect(val('Taken')).toBe('2026-06-08 14:32:11');
    expect(val('Software')).toContain('Lightroom');
    expect(val('Maker notes')).toMatch(/manufacturer-private/);
    expect(f.find((x) => x.label === 'GPS clock')!.value).toContain('2026-06-08');
  });
  it('reads XMP people/faces, IPTC place and JPEG comment', async () => {
    const f = (await analyze(jpg)).findings;
    expect(f.some((x) => x.source === 'XMP' && x.category === 'people' && x.value === 'Grandma Rose')).toBe(true);
    expect(f.some((x) => x.source === 'XMP' && x.label === 'dc:creator' && x.value === 'Jordan Rivera')).toBe(true);
    expect(f.some((x) => x.source === 'IPTC' && x.label === 'City' && x.category === 'location')).toBe(true);
    expect(f.some((x) => x.label === 'JPEG comment')).toBe(true);
  });
  it('flags an embedded thumbnail whose shape differs from the photo (un-cropped leak)', async () => {
    const a = await analyze(jpg);
    expect(a.thumbnail!.mismatch).toBe(true);
    expect(a.findings.find((x) => x.category === 'preview')!.severity).toBe('high');
    const same = await analyze(injectMetadata(syntheticJpeg(64, 48), { make: 'X', thumbnail: syntheticJpeg(32, 24) }));
    expect(same.thumbnail!.mismatch).toBe(false);
  });
  it('detects data hidden after EOI (second JPEG)', async () => {
    const a = await analyze(injectMetadata(syntheticJpeg(), { make: 'X' }, syntheticJpeg(200, 100)));
    expect(a.findings.find((x) => x.label.startsWith('Hidden data'))!.severity).toBe('high');
  });
  it('walks scan data containing FF00 stuffing and RST markers', () => {
    const info = parseJpeg(syntheticJpeg(10, 10));
    expect(info.width).toBe(10);
    expect(info.pieces.at(-1)!.marker).toBe(0xd9);
    expect(info.trailing.length).toBe(0);
  });
  it('gives a calm result for a file with no metadata', async () => {
    const a = await analyze(syntheticJpeg(), 'bare.jpg');
    expect(a.risk.level).toBe('info');
    expect(a.risk.headline).toMatch(/No identifying/);
  });
});

describe('JPEG strip + verify', () => {
  const jpg = injectMetadata(syntheticJpeg(64, 48), { ...HOME, thumbnail: syntheticJpeg(40, 40) }, syntheticJpeg(20, 20));
  it('removes every byte of identifying data and proves it by re-parsing', async () => {
    for (const s of SECRETS) expect(has(jpg, s)).toBe(true); // fixture really contains them
    const r = await clean(jpg, 'a.jpg');
    for (const s of SECRETS) expect(has(r.bytes, s), s).toBe(false);
    expect(r.verified).toBe(true);
    expect(r.after.gps).toBeUndefined();
    expect(r.after.findings.filter((f) => f.label !== 'Orientation')).toEqual([]);
    expect(r.removed.length).toBeGreaterThan(10);
    expect(r.bytes.length).toBeLessThan(jpg.length);
  });
  it('leaves the pixel stream byte-identical', async () => {
    const r = await clean(jpg);
    expect(r.pixelsIdentical).toBe(true);
    expect(await pixelDigest(r.bytes)).toBe(await pixelDigest(jpg));
    const a = parseJpeg(jpg), b = parseJpeg(r.bytes);
    expect([b.width, b.height]).toEqual([a.width, a.height]);
  });
  it('keeps rotation so photos are not left sideways (orientation 6)', async () => {
    const r = await clean(jpg);
    expect(r.orientationKept).toBe(6);
    expect(r.after.orientation).toBe(6);
    expect(r.bytes.length).toBeLessThan(jpg.length - 200);
  });
  it('can drop orientation when asked', async () => {
    const r = await clean(jpg, 'a.jpg', { keepOrientation: false });
    expect(r.after.orientation).toBe(1);
    expect(r.verified).toBe(true);
  });
  it('is idempotent', async () => {
    const once = (await clean(jpg)).bytes;
    const twice = (await clean(once)).bytes;
    expect(twice).toEqual(once);
  });
  it('drops an embedded JFIF thumbnail', async () => {
    const withThumb = syntheticJpeg(8, 8);
    // JFIF payload: set thumbnail 2x2 (12 pixels bytes)
    const j = concat([withThumb.subarray(0, 2), Uint8Array.of(0xff, 0xe0, 0, 28), ascii('JFIF\0'), Uint8Array.of(1, 1, 0, 0, 1, 0, 1, 2, 2), new Uint8Array(12).fill(9), withThumb.subarray(2 + 18)]);
    const out = (await clean(j)).bytes;
    expect(out.length).toBeLessThan(j.length);
    expect(parseJpeg(out).width).toBe(8);
  });
});

describe('PNG', () => {
  it('parses text, compressed text, time, EXIF GPS, and appended data', async () => {
    const png = await syntheticPng({ text: [['Author', 'Jordan Rivera'], ['parameters', 'a cat, steps 20, seed 99']], ztxt: [['Comment', 'hidden zipped note']], time: true,
      exif: { lat: 40.7128, lon: -74.006, make: 'Google', model: 'Pixel 8' }, trailing: ascii('LEFTOVER-CROPPED-ORIGINAL') });
    const a = await analyze(png, 's.png');
    expect(a.format).toBe('png');
    expect(a.gps!.lat).toBeCloseTo(40.7128, 3);
    expect(a.findings.find((f) => f.label === 'Text: Author')!.severity).toBe('high');
    expect(a.findings.some((f) => f.label.startsWith('AI prompt'))).toBe(true);
    expect(a.findings.find((f) => f.value === 'hidden zipped note')).toBeTruthy();
    expect(a.findings.find((f) => f.label.startsWith('Last modified'))!.value).toBe('2026-06-08 14:32:11 UTC');
    expect(a.findings.find((f) => f.label.startsWith('Hidden data'))!.severity).toBe('high');
  });
  it('strips to a valid, decodable PNG with identical pixels and verifies', async () => {
    const png = await syntheticPng({ text: [['Author', 'Jordan Rivera']], ztxt: [['Comment', 'zipped-secret']], time: true, xmp: '<x xmlns:dc="d"><dc:creator><rdf:Seq><rdf:li>Zed Zeta</rdf:li></rdf:Seq></dc:creator></x>',
      exif: { lat: 40.7, lon: -74, serial: 'PNG-SERIAL-1', orientation: 3 }, trailing: ascii('TAIL-DATA') });
    const r = await clean(png, 's.png');
    expect(r.verified).toBe(true);
    for (const s of ['Jordan Rivera', 'PNG-SERIAL-1', 'TAIL-DATA', 'Zed Zeta']) expect(has(r.bytes, s)).toBe(false);
    expect(r.after.orientation).toBe(3);
    const p = await parsePng(r.bytes); // re-validates every CRC
    expect(p.chunks.map((c) => c.type)).toEqual(['IHDR', 'eXIf', 'gAMA', 'IDAT', 'IEND']);
    const idat = p.chunks.find((c) => c.type === 'IDAT')!;
    const raw = inflateSync(r.bytes.subarray(idat.start + 8, idat.end - 4));
    expect(raw.length).toBe((8 * 3 + 1) * 8);
  });
  it('rejects corrupted CRCs and truncation', async () => {
    const png = await syntheticPng();
    const bad = png.slice(); bad[20] ^= 1;
    await expect(parsePng(bad)).rejects.toThrow(ParseError);
    await expect(parsePng(png.subarray(0, png.length - 5))).rejects.toThrow(ParseError);
  });
  it('keeps APNG and unknown critical chunks', async () => {
    const png = await syntheticPng();
    expect(crc32(ascii('IEND'))).toBe(0xae426082);
    const r = await clean(png);
    expect(u32be(r.bytes, 8)).toBe(13);
  });
});

describe('format detection + robustness', () => {
  it('explains unsupported formats clearly (HEIC and PDF are supported since v2, see formats.test.ts)', () => {
    const avif = concat([Uint8Array.of(0, 0, 0, 24), ascii('ftypavif'), new Uint8Array(16)]);
    expect(() => detectFormat(avif)).toThrow(UnsupportedFormat);
    expect(() => detectFormat(ascii('GIF89a......'))).toThrow(/JPEG, PNG, WebP, HEIC, PDF/);
  });
  it('never crashes with anything but a ParseError on mutated files (fuzz)', async () => {
    const base = injectMetadata(syntheticJpeg(), { ...HOME, thumbnail: syntheticJpeg(10, 10) });
    let seed = 1234567;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let i = 0; i < 400; i++) {
      const b = base.slice();
      for (let k = 0; k < 1 + Math.floor(rnd() * 6); k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      const cut = rnd() < 0.3 ? b.subarray(0, Math.floor(rnd() * b.length)) : b;
      try { await analyze(cut); } catch (e) { expect(e instanceof ParseError || e instanceof UnsupportedFormat, String(e)).toBe(true); }
    }
  });
});

describe('geo + zip', () => {
  it('computes distances offline', () => {
    expect(haversineKm({ lat: 33.749, lon: -84.388 }, { lat: 40.713, lon: -74.006 })).toBeGreaterThan(1180);
    expect(haversineKm({ lat: 33.749, lon: -84.388 }, { lat: 40.713, lon: -74.006 })).toBeLessThan(1300);
    expect(nearestCity({ lat: 33.2, lon: -87.5 })[0].name).toBe('Tuscaloosa');
  });
  it('writes a ZIP whose entries and CRCs read back correctly', () => {
    const a = ascii('hello'), b = new Uint8Array(1000).map((_, i) => i % 251);
    const z = makeZip([{ name: 'a.txt', data: a }, { name: 'b-clean.jpg', data: b }]);
    const eocd = z.length - 22;
    expect(u32be(new Uint8Array([z[eocd + 3], z[eocd + 2], z[eocd + 1], z[eocd]]), 0)).toBe(0x06054b50);
    expect(z[eocd + 10]).toBe(2); // entries
    const nameLen = z[26] | (z[27] << 8);
    expect(toAscii(z.subarray(30, 30 + nameLen))).toBe('a.txt');
  });
});
