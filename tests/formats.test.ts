import { describe, expect, it } from 'vitest';
import { analyze, clean, contentDigest, detectFormat, NeedsReencode, UnsupportedFormat } from '../src/engine/analyze.ts';
import { ParseError, ascii, concat, toAscii } from '../src/engine/bytes.ts';
import { injectMetadata, syntheticHeic, syntheticJpeg, syntheticMp4, syntheticOffice, syntheticPdf, syntheticWebp, type PhotoSpec } from '../src/engine/fixtures.ts';
import { parseHeic } from '../src/engine/heic.ts';
import { parseMp4 } from '../src/engine/mp4.ts';
import { parsePdf, storedZlib } from '../src/engine/pdf.ts';
import { parseWebp } from '../src/engine/webp.ts';
import { readZip, entryData } from '../src/engine/zip.ts';
import { inflateSync } from 'node:zlib';

const has = (b: Uint8Array, s: string) => toAscii(b).includes(s);
const PHOTO: PhotoSpec = {
  lat: 33.7853, lon: -84.3738, altitude: 312, make: 'Apple', model: 'iPhone 15 Pro', serial: 'SN-F2LXK9Q3PD', owner: 'Jordan Rivera',
  software: '17.5.1', taken: '2026:06:08 14:32:11', orientation: 6,
};
const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Lightroom Classic"><dc:creator><rdf:Seq><rdf:li>Jordan Rivera</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>';

describe('format detection', () => {
  it('recognises every supported container by content, not extension', async () => {
    expect(detectFormat(syntheticWebp())).toBe('webp');
    expect(detectFormat(syntheticHeic({ exif: PHOTO }))).toBe('heic');
    expect(detectFormat(syntheticMp4())).toBe('mp4');
    expect(detectFormat(await syntheticPdf())).toBe('pdf');
    expect(detectFormat(syntheticOffice({ kind: 'docx' }))).toBe('docx');
    expect(detectFormat(syntheticOffice({ kind: 'xlsx' }))).toBe('xlsx');
    expect(detectFormat(syntheticOffice({ kind: 'pptx' }))).toBe('pptx');
  });
  it('still rejects what it cannot read, with a useful message', () => {
    expect(() => detectFormat(ascii('GIF89a-not-supported'))).toThrow(UnsupportedFormat);
    expect(() => detectFormat(ascii('GIF89a-not-supported'))).toThrow(/JPEG, PNG, WebP, HEIC, PDF/);
    const avif = concat([Uint8Array.of(0, 0, 0, 24), ascii('ftypavif'), new Uint8Array(16)]);
    expect(() => detectFormat(avif)).toThrow(/AVIF/);
  });
});

describe('WebP', () => {
  const full = syntheticWebp({ exif: PHOTO, xmp: XMP, icc: true, unknown: true, trailing: ascii('TRAILING-ORIGINAL-BYTES') });
  it('reads EXIF GPS, device, XMP and appended data', async () => {
    const a = await analyze(full, 'a.webp');
    expect(a.format).toBe('webp');
    expect([a.width, a.height]).toEqual([32, 24]);
    expect(a.gps!.lat).toBeCloseTo(33.7853, 3);
    expect(a.findings.find((f) => f.label === 'Camera serial number')!.value).toBe('SN-F2LXK9Q3PD');
    expect(a.findings.some((f) => f.source === 'XMP' && f.value === 'Jordan Rivera')).toBe(true);
    expect(a.findings.find((f) => f.label.startsWith('Hidden data'))!.source).toBe('after RIFF');
  });
  it('strips EXIF/XMP/unknown chunks and trailing bytes, keeps ICC and the image chunk byte-identical, verifies', async () => {
    const r = await clean(full, 'a.webp');
    expect(r.verified).toBe(true);
    expect(r.pixelsIdentical).toBe(true);
    for (const s of ['Jordan Rivera', 'SN-F2LXK9Q3PD', 'Apple', 'Lightroom', 'unknown-chunk-secret', 'TRAILING']) expect(has(r.bytes, s), s).toBe(false);
    const types = parseWebp(r.bytes).chunks.map((c) => c.type);
    expect(types).toEqual(['VP8X', 'ICCP', 'VP8L', 'EXIF']); // EXIF = orientation only
    expect(r.after.orientation).toBe(6);
  });
  it('writes a correct RIFF size and clears the VP8X EXIF/XMP flags when orientation is dropped', async () => {
    const r = await clean(full, 'a.webp', { keepOrientation: false });
    const dv = new DataView(r.bytes.buffer, r.bytes.byteOffset);
    expect(dv.getUint32(4, true)).toBe(r.bytes.length - 8);
    const info = parseWebp(r.bytes);
    expect(info.chunks.map((c) => c.type)).toEqual(['VP8X', 'ICCP', 'VP8L']);
    expect(r.bytes[info.chunks[0].dataStart] & 0x0c).toBe(0);
    expect(r.bytes[info.chunks[0].dataStart] & 0x20).toBe(0x20);
  });
  it('upgrades a bare VP8L file to VP8X only when it must carry orientation', async () => {
    const bare = syntheticWebp({ extended: false });
    expect(parseWebp(bare).chunks.map((c) => c.type)).toEqual(['VP8L']);
    expect((await clean(bare)).bytes).toEqual(bare);
    const rotated = syntheticWebp({ exif: { orientation: 8, make: 'X' } });
    expect(parseWebp((await clean(rotated)).bytes).chunks.map((c) => c.type)).toEqual(['VP8X', 'VP8L', 'EXIF']);
  });
  it('rejects truncated and oversized-chunk files', () => {
    expect(() => parseWebp(full.subarray(0, 40))).toThrow(ParseError);
    const bad = full.slice(); bad.set([0xff, 0xff, 0xff, 0x7f], 16); // first chunk length
    expect(() => parseWebp(bad)).toThrow(ParseError);
  });
});

describe('HEIC', () => {
  const heic = syntheticHeic({ exif: PHOTO, xmp: XMP, w: 4032, h: 3024 });
  it('extracts EXIF and XMP items from the ISO-BMFF boxes and shows the leaks', async () => {
    const info = parseHeic(heic);
    expect([info.width, info.height]).toEqual([4032, 3024]);
    expect(info.itemTypes).toMatchObject({ hvc1: 1, Exif: 1, mime: 1 });
    const a = await analyze(heic, 'IMG_1.HEIC');
    expect(a.format).toBe('heic');
    expect(a.gps!.lon).toBeCloseTo(-84.3738, 3);
    expect(a.findings.find((f) => f.label === 'Camera / phone')!.value).toBe('Apple iPhone 15 Pro');
    expect(a.findings.some((f) => f.source === 'XMP' && f.value === 'Jordan Rivera')).toBe(true);
    expect(a.score).toBeLessThanOrEqual(25);
  });
  it('works with an Exif item that has no "Exif\\0\\0" prefix', async () => {
    const a = await analyze(syntheticHeic({ exif: PHOTO, exifPrefix: false }));
    expect(a.gps).toBeTruthy();
  });
  it('refuses a lossless clean and says it needs a re-encode', async () => {
    await expect(clean(heic, 'x.heic')).rejects.toThrow(NeedsReencode);
  });
  it('re-encodes through an injected rasterizer and verifies the output has nothing left', async () => {
    const out = syntheticJpeg(40, 30);
    const r = await clean(heic, 'x.heic', { rasterize: async () => ({ bytes: out }) });
    expect(r.reencoded).toBe(true);
    expect(r.outFormat).toBe('jpeg');
    expect(r.pixelsIdentical).toBe(false);
    expect(r.verified).toBe(true);
    expect(r.after.score).toBe(100);
  });
  it('flags a rasterizer that leaves metadata behind (verification is real, not assumed)', async () => {
    const leaky = injectMetadata(syntheticJpeg(), { make: 'Apple', lat: 1, lon: 2 });
    const r = await clean(heic, 'x.heic', { rasterize: async () => ({ bytes: leaky }) });
    expect(r.verified).toBe(false);
  });
});

describe('PDF', () => {
  const INFO = { Author: 'Jordan Rivera', Creator: 'Microsoft Word', Producer: 'Acrobat Distiller 24', Title: 'Salary review', CreationDate: "D:20260608143211-04'00'", Keywords: 'confidential' };
  it('reads the Info dictionary and XMP', async () => {
    const pdf = await syntheticPdf({ info: INFO, xmp: XMP });
    const a = await analyze(pdf, 'a.pdf');
    expect(a.format).toBe('pdf');
    expect(a.findings.find((f) => f.label === 'Author')!.value).toBe('Jordan Rivera');
    expect(a.findings.find((f) => f.label === 'Created')!.value).toBe('2026-06-08 14:32:11 (UTC-04:00)');
    expect(a.findings.some((f) => f.source === 'XMP' && f.value === 'Jordan Rivera')).toBe(true);
    expect(a.score).toBeLessThan(40);
  });
  it('decodes UTF-16 strings', async () => {
    const a = await analyze(await syntheticPdf({ info: { Author: 'Zoë Müller 田中' } }));
    expect(a.findings.find((f) => f.label === 'Author')!.value).toBe('Zoë Müller 田中');
  });
  it('blanks Info and XMP in place: same length, nothing else changes, re-scan is clean', async () => {
    const pdf = await syntheticPdf({ info: INFO, xmp: XMP });
    const r = await clean(pdf, 'a.pdf');
    expect(r.bytes.length).toBe(pdf.length);
    expect(r.verified).toBe(true);
    expect(r.pixelsIdentical).toBe(true);
    for (const s of ['Jordan Rivera', 'Microsoft Word', 'Salary review', 'Lightroom', 'confidential']) expect(has(r.bytes, s), s).toBe(false);
    expect(r.after.findings).toEqual([]);
    expect(r.after.score).toBe(100);
    expect(has(r.bytes, '/Type /Catalog')).toBe(true);
    expect(has(r.bytes, 'startxref')).toBe(true);
  });
  it('keeps the xref table valid (every object is still where the table says)', async () => {
    const pdf = await syntheticPdf({ info: INFO, xmp: XMP });
    const out = (await clean(pdf)).bytes;
    const txt = toAscii(out);
    const x = txt.indexOf('xref\n0 ');
    const rows = txt.slice(x).split('\n').slice(2, 11);
    let checked = 0;
    rows.forEach((row, i) => { if (row.endsWith('n ')) { checked++; expect(txt.slice(Number(row.slice(0, 10))).startsWith(`${i} 0 obj`)).toBe(true); } });
    expect(checked).toBeGreaterThanOrEqual(5);
  });
  it('blanks a Flate-compressed XMP stream with a valid zlib stream of the same size', async () => {
    const pdf = await syntheticPdf({ xmp: XMP, compressXmp: true });
    expect((await analyze(pdf)).findings.some((f) => f.value === 'Jordan Rivera')).toBe(true);
    const r = await clean(pdf);
    expect(r.verified).toBe(true);
    expect(r.bytes.length).toBe(pdf.length);
    const info = await parsePdf(r.bytes);
    expect(info.xmp).toHaveLength(1);
    expect(info.xmp[0]).not.toContain('Jordan');
  });
  it('storedZlib produces a stream zlib itself accepts, at every size', () => {
    for (const len of [400, 401, 1000, 65535, 65536, 70000, 140000]) {
      const z = storedZlib(len)!;
      expect(z.length).toBe(len);
      const text = inflateSync(z).toString('latin1');
      expect(text.startsWith('<?xpacket')).toBe(true);
      expect(text.trimEnd().endsWith('<?xpacket end="w"?>') || text.endsWith(' ')).toBe(true);
      expect(text).not.toContain('Jordan');
    }
  });
  it('wipes every revision of the Info dictionary and reports earlier saved versions as a caveat', async () => {
    const pdf = await syntheticPdf({ info: { Author: 'Old Author Name' }, update: { Author: 'New Author Name' } });
    const before = await analyze(pdf);
    expect(before.findings.find((f) => f.label === 'Author')!.value).toBe('New Author Name');
    expect(before.findings.find((f) => f.label === 'Earlier saved versions')!.removable).toBe(false);
    const r = await clean(pdf);
    expect(has(r.bytes, 'Old Author Name')).toBe(false);
    expect(has(r.bytes, 'New Author Name')).toBe(false);
    expect(r.remaining.map((f) => f.label)).toEqual(['Earlier saved versions']);
    expect(r.verified).toBe(true); // everything removable is gone; the caveat is reported
  });
  it('does not call a linearized file "saved twice"', async () => {
    const a = await analyze(await syntheticPdf({ info: { Author: 'x' }, linearized: true }));
    expect(a.findings.some((f) => f.label === 'Earlier saved versions')).toBe(false);
  });
  it('shows Info stored in a compressed object stream but says it cannot remove it', async () => {
    const pdf = await syntheticPdf({ info: { Author: 'Hidden In ObjStm' }, objStm: true });
    const a = await analyze(pdf);
    const f = a.findings.find((x) => x.label === 'Author')!;
    expect(f.value).toBe('Hidden In ObjStm');
    expect(f.removable).toBe(false);
    const r = await clean(pdf);
    expect(r.remaining.map((x) => x.label)).toContain('Author');
    expect(r.bytes.length).toBe(pdf.length);
  });
  it('refuses to touch an encrypted PDF', async () => {
    const pdf = await syntheticPdf({ info: { Author: 'x' }, encrypt: true });
    const a = await analyze(pdf);
    expect(a.findings.some((f) => f.label === 'Encrypted PDF')).toBe(true);
    await expect(clean(pdf)).rejects.toThrow(/encrypted/);
  });
  it('finds GPS inside an embedded JPEG photo and flags it as not removable', async () => {
    const photo = injectMetadata(syntheticJpeg(8, 8), { lat: 40.7128, lon: -74.006, serial: 'EMB-SERIAL' });
    const a = await analyze(await syntheticPdf({ jpeg: photo }));
    const gps = a.findings.find((f) => f.label === 'Embedded photo: GPS coordinates')!;
    expect(gps.removable).toBe(false);
    expect(a.gps!.lat).toBeCloseTo(40.7128, 3);
  });
  it('reports bytes after %%EOF', async () => {
    const a = await analyze(await syntheticPdf({ trailing: 'X'.repeat(500) }));
    expect(a.findings.find((f) => f.label === 'Hidden data after the end')).toBeTruthy();
  });
});

describe('Office (DOCX / XLSX / PPTX)', () => {
  const SPEC = { creator: 'Jordan Rivera', lastModifiedBy: 'Sam Patel', created: '2026-06-08T14:32:11Z', modified: '2026-06-09T09:00:00Z', revision: '14', title: 'Q3 layoffs',
    company: 'Acme Holdings', manager: 'Dana Cole', template: 'C:\\Users\\jordan\\Normal.dotm', application: 'Microsoft Office Word', totalTime: '212', custom: { 'MSIP_Label_abc_SiteId': 'tenant-guid-123' }, thumbnail: true } as const;
  for (const kind of ['docx', 'xlsx', 'pptx'] as const) {
    it(`${kind}: reads creator, lastModifiedBy, company, revision, template and strips them in the zip`, async () => {
      const file = syntheticOffice({ kind, ...SPEC });
      const a = await analyze(file, `a.${kind}`);
      expect(a.format).toBe(kind);
      const v = (l: string) => a.findings.find((f) => f.label === l)?.value;
      expect(v('Author')).toBe('Jordan Rivera');
      expect(v('Last modified by')).toBe('Sam Patel');
      expect(v('Company')).toBe('Acme Holdings');
      expect(v('Revision')).toBe('14');
      expect(v('Template')).toContain('Normal.dotm');
      expect(a.findings.some((f) => f.label === 'Document thumbnail')).toBe(true);
      expect(a.findings.some((f) => f.label.startsWith('Custom property'))).toBe(true);
      const r = await clean(file, `a.${kind}`);
      expect(r.verified).toBe(true);
      expect(r.after.findings).toEqual([]);
      expect(r.after.score).toBe(100);
      for (const s of ['Jordan Rivera', 'Sam Patel', 'Acme Holdings', 'Normal.dotm', 'Q3 layoffs', 'tenant-guid-123']) {
        const entries = readZip(r.bytes);
        for (const e of entries) expect(has(await entryData(r.bytes, e), s), `${e.name} ${s}`).toBe(false);
      }
      const names = readZip(r.bytes).map((e) => e.name);
      expect(names).not.toContain('docProps/thumbnail.jpeg');
      const rels = toAscii(await entryData(r.bytes, readZip(r.bytes).find((e) => e.name === '_rels/.rels')!));
      expect(rels).not.toContain('thumbnail');
      expect(rels).toContain('officeDocument');
    });
  }
  it('leaves the document body byte-identical and resets entry timestamps to 1980', async () => {
    const file = syntheticOffice({ ...SPEC });
    const r = await clean(file);
    expect(r.pixelsIdentical).toBe(true);
    expect(await contentDigest(r.bytes)).toBe(await contentDigest(file));
    const body = (b: Uint8Array) => entryData(b, readZip(b).find((e) => e.name === 'word/document.xml')!);
    expect(await body(r.bytes)).toEqual(await body(file));
    const dosDate = r.bytes[12] | (r.bytes[13] << 8);
    expect(dosDate).toBe(0x21);
  });
  it('reports tracked-change authors and Excel absolute paths as content it cannot strip', async () => {
    const d = await analyze(syntheticOffice({ kind: 'docx', creator: 'x', trackedAuthor: 'Reviewer Rita' }));
    const f = d.findings.find((x) => x.label.startsWith('Tracked changes'))!;
    expect(f.value).toContain('Reviewer Rita');
    expect(f.removable).toBe(false);
    const x = await analyze(syntheticOffice({ kind: 'xlsx', absPath: 'C:\\Users\\jordan\\Desktop\\payroll\\' }));
    expect(x.findings.find((y) => y.label === 'Saved file path')!.value).toContain('jordan');
    const r = await clean(syntheticOffice({ kind: 'docx', creator: 'x', trackedAuthor: 'Reviewer Rita' }));
    expect(r.remaining).toHaveLength(1);
    expect(r.verified).toBe(true);
  });
  it('is idempotent', async () => {
    const once = (await clean(syntheticOffice({ ...SPEC }))).bytes;
    expect((await clean(once)).bytes).toEqual(once);
  });
});

describe('Video (MP4 / MOV)', () => {
  const SPEC = { gps: '+33.7853-084.3738+312.000/', make: 'Apple', model: 'iPhone 15 Pro', software: '17.5.1', title: 'Backyard party' };
  it('reads GPS from udta ©xyz plus make, model and creation time', async () => {
    const a = await analyze(syntheticMp4(SPEC), 'clip.mp4');
    expect(a.format).toBe('mp4');
    expect(a.gps!.lat).toBeCloseTo(33.7853, 4);
    expect(a.gps!.lon).toBeCloseTo(-84.3738, 4);
    expect(a.gps!.altitude).toBe(312);
    expect(a.gps!.nearest[0].name).toBe('Atlanta');
    expect(a.findings.find((f) => f.label === 'Camera / phone')!.value).toBe('Apple iPhone 15 Pro');
    expect(a.findings.find((f) => f.label === 'Created (movie header)')!.value).toBe('2026-06-08 18:42:07 UTC');
    expect([a.width, a.height]).toEqual([1280, 720]);
    expect(a.detail).toBe('MP4 · 0:05');
  });
  it('reads the QuickTime mdta keys/ilst form that iPhones write', async () => {
    const a = await analyze(syntheticMp4({ ...SPEC, quickTime: true, mdtaKeys: true }), 'IMG.MOV');
    expect(a.gps!.lat).toBeCloseTo(33.7853, 4);
    expect(a.findings.find((f) => f.label === 'Camera / phone')!.value).toBe('Apple iPhone 15 Pro');
    expect(a.findings.find((f) => f.label === 'Recorded')!.value).toContain('2026-06-08');
    expect(a.detail).toMatch(/^MOV/);
  });
  it('flags timed-metadata tracks (action-cam / dashcam GPS) as not removable', async () => {
    const a = await analyze(syntheticMp4({ timedTrack: true }));
    const f = a.findings.find((x) => x.label === 'Timed metadata track')!;
    expect(f.removable).toBe(false);
    expect((await clean(syntheticMp4({ timedTrack: true }))).remaining).toHaveLength(1);
  });
  for (const qt of [false, true]) {
    it(`strips in place without moving a byte (${qt ? 'mdta' : 'udta'})`, async () => {
      const file = syntheticMp4({ ...SPEC, quickTime: qt, mdtaKeys: qt, xmp: XMP });
      const r = await clean(file, 'c.mp4');
      expect(r.bytes.length).toBe(file.length);
      expect(r.verified).toBe(true);
      expect(r.pixelsIdentical).toBe(true);
      expect(r.after.findings).toEqual([]);
      for (const s of ['Apple', 'iPhone', 'Backyard', '33.7853', 'Jordan Rivera']) expect(has(r.bytes, s), s).toBe(false);
      expect(parseMp4(r.bytes).patches).toEqual([]);
    });
  }
  it('is idempotent', async () => {
    const once = (await clean(syntheticMp4(SPEC))).bytes;
    expect((await clean(once)).bytes).toEqual(once);
  });
});
