// Programmatic fixtures: build JPEG/PNG files with known metadata. Used by the tests AND the in-app sample.
import { ascii, concat, crc32, p16be, p32be } from './bytes.ts';
import { buildTiff, type Rational, type WriteEntry } from './tiff.ts';
import { makeZip } from './zip.ts';

export const rat = (v: number, den = 1_000_000): Rational => [Math.round(v * den), den];
export const toDms = (deg: number): Rational[] => {
  const a = Math.abs(deg), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60;
  return [[d, 1], [m, 1], rat(s, 10000)];
};

export interface PhotoSpec {
  lat?: number; lon?: number; altitude?: number; heading?: number;
  make?: string; model?: string; lens?: string; serial?: string; owner?: string; artist?: string; software?: string;
  taken?: string; orientation?: number; thumbnail?: Uint8Array; makerNote?: boolean; comment?: string;
  xmp?: string; iptc?: [dataset: number, value: string][];
}

export const exifFor = (s: PhotoSpec): Uint8Array => {
  const ifd0: WriteEntry[] = [], exif: WriteEntry[] = [], gps: WriteEntry[] = [];
  const A = (tag: number, v?: string): WriteEntry | undefined => (v ? { tag, type: 2, value: v } : undefined);
  const push = (l: WriteEntry[], e?: WriteEntry) => { if (e) l.push(e); };
  push(ifd0, A(0x10f, s.make)); push(ifd0, A(0x110, s.model)); push(ifd0, A(0x131, s.software)); push(ifd0, A(0x13b, s.artist));
  if (s.orientation) ifd0.push({ tag: 0x112, type: 3, value: [s.orientation] });
  push(exif, A(0x9003, s.taken)); push(exif, A(0xa431, s.serial)); push(exif, A(0xa430, s.owner)); push(exif, A(0xa434, s.lens));
  if (s.taken) exif.push({ tag: 0x9011, type: 2, value: '-05:00' });
  exif.push({ tag: 0x829a, type: 5, value: [[1, 250]] }, { tag: 0x829d, type: 5, value: [[178, 100]] }, { tag: 0x8827, type: 3, value: [64] });
  if (s.makerNote) exif.push({ tag: 0x927c, type: 7, value: Array.from({ length: 64 }, (_, i) => i) });
  if (s.comment) exif.push({ tag: 0x9286, type: 7, value: [...ascii('ASCII\0\0\0'), ...ascii(s.comment)] });
  if (s.lat !== undefined && s.lon !== undefined) {
    gps.push({ tag: 0, type: 1, value: [2, 3, 0, 0] },
      { tag: 1, type: 2, value: s.lat >= 0 ? 'N' : 'S' }, { tag: 2, type: 5, value: toDms(s.lat) },
      { tag: 3, type: 2, value: s.lon >= 0 ? 'E' : 'W' }, { tag: 4, type: 5, value: toDms(s.lon) });
    if (s.altitude !== undefined) gps.push({ tag: 5, type: 1, value: [s.altitude < 0 ? 1 : 0] }, { tag: 6, type: 5, value: [rat(Math.abs(s.altitude), 100)] });
    if (s.heading !== undefined) gps.push({ tag: 0x10, type: 2, value: 'T' }, { tag: 0x11, type: 5, value: [rat(s.heading, 100)] });
    gps.push({ tag: 7, type: 5, value: [[14, 1], [32, 1], [11, 1]] }, { tag: 0x1d, type: 2, value: '2026:06:08' });
  }
  return buildTiff({ ifd0, exif, gps, thumbnail: s.thumbnail });
};

const seg = (marker: number, payload: Uint8Array) => concat([Uint8Array.of(0xff, marker), p16be(payload.length + 2), payload]);
export const app1Exif = (s: PhotoSpec) => seg(0xe1, concat([ascii('Exif\0\0'), exifFor(s)]));
export const app1Xmp = (xml: string) => seg(0xe1, concat([ascii('http://ns.adobe.com/xap/1.0/\0'), new TextEncoder().encode(xml)]));
export const app13Iptc = (sets: [number, string][]) => {
  const ds = concat(sets.map(([n, v]) => { const b = new TextEncoder().encode(v); return concat([Uint8Array.of(0x1c, 2, n), p16be(b.length), b]); }));
  const pad = ds.length % 2 ? Uint8Array.of(0) : new Uint8Array(0);
  return seg(0xed, concat([ascii('Photoshop 3.0\0'), ascii('8BIM'), Uint8Array.of(0x04, 0x04, 0, 0), p32be(ds.length), ds, pad]));
};
export const comSeg = (t: string) => seg(0xfe, ascii(t));

export const metadataSegments = (s: PhotoSpec): Uint8Array[] => {
  const out = [app1Exif(s)];
  if (s.xmp) out.push(app1Xmp(s.xmp));
  if (s.iptc) out.push(app13Iptc(s.iptc));
  if (s.comment) out.push(comSeg(s.comment));
  return out;
};

/** Insert metadata segments right after SOI (and after JFIF if present). Works on any real JPEG. */
export const injectMetadata = (jpeg: Uint8Array, s: PhotoSpec, trailing?: Uint8Array): Uint8Array => {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  const body = concat([jpeg.subarray(0, at), ...metadataSegments(s), jpeg.subarray(at)]);
  return trailing ? concat([body, trailing]) : body;
};

/** Structurally valid JPEG (markers, tables, byte-stuffed scan with RST markers). Not meant to be decoded. */
export const syntheticJpeg = (w = 64, h = 48, withJfif = true): Uint8Array => {
  const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  if (withJfif) parts.push(seg(0xe0, concat([ascii('JFIF\0'), Uint8Array.of(1, 1, 0, 0, 1, 0, 1, 0, 0)])));
  parts.push(seg(0xdb, concat([Uint8Array.of(0), new Uint8Array(64).fill(8)])));
  parts.push(seg(0xc0, Uint8Array.of(8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0)));
  parts.push(seg(0xc4, Uint8Array.of(0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)));
  parts.push(seg(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)));
  parts.push(Uint8Array.of(0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0xff, 0x00, 0x9a, 0xbc));
  parts.push(Uint8Array.of(0xff, 0xd9));
  return concat(parts);
};

/* ----------------------------- PNG ----------------------------- */
export const pngChunk = (type: string, data: Uint8Array) => {
  const body = concat([ascii(type), data]);
  return concat([p32be(data.length), body, p32be(crc32(body))]);
};
export const deflateZlib = async (data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());

export interface PngSpec { w?: number; h?: number; text?: [string, string][]; ztxt?: [string, string][]; exif?: PhotoSpec; time?: boolean; trailing?: Uint8Array; xmp?: string }
export const syntheticPng = async (s: PngSpec = {}): Promise<Uint8Array> => {
  const w = s.w ?? 8, h = s.h ?? 8;
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1); raw[o] = 0; raw[o + 1 + x * 3] = 40 + x * 10; raw[o + 2 + x * 3] = 120; raw[o + 3 + x * 3] = 200 - y * 10; }
  const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), pngChunk('IHDR', concat([p32be(w), p32be(h), Uint8Array.of(8, 2, 0, 0, 0)])), pngChunk('gAMA', p32be(45455))];
  for (const [k, v] of s.text ?? []) parts.push(pngChunk('tEXt', concat([ascii(k), Uint8Array.of(0), ascii(v)])));
  for (const [k, v] of s.ztxt ?? []) parts.push(pngChunk('zTXt', concat([ascii(k), Uint8Array.of(0, 0), await deflateZlib(ascii(v))])));
  if (s.xmp) parts.push(pngChunk('iTXt', concat([ascii('XML:com.adobe.xmp'), Uint8Array.of(0, 0, 0, 0, 0), ascii(s.xmp)])));
  if (s.exif) parts.push(pngChunk('eXIf', exifFor(s.exif)));
  if (s.time) parts.push(pngChunk('tIME', Uint8Array.of(0x07, 0xea, 6, 8, 14, 32, 11)));
  parts.push(pngChunk('IDAT', await deflateZlib(raw)), pngChunk('IEND', new Uint8Array(0)));
  if (s.trailing) parts.push(s.trailing);
  return concat(parts);
};

/* ----------------------------- WebP ----------------------------- */
const le32 = (n: number) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
export const riffChunk = (type: string, data: Uint8Array) => concat([ascii(type), le32(data.length), data, data.length & 1 ? Uint8Array.of(0) : new Uint8Array(0)]);

export interface WebpSpec { w?: number; h?: number; exif?: PhotoSpec; xmp?: string; extended?: boolean; alpha?: boolean; trailing?: Uint8Array; icc?: boolean; unknown?: boolean }
/** Structurally valid WebP (lossless header + filler). Not meant to be decoded. */
export const syntheticWebp = (s: WebpSpec = {}): Uint8Array => {
  const w = s.w ?? 32, h = s.h ?? 24;
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14) | ((s.alpha ? 1 : 0) << 28);
  const vp8l = riffChunk('VP8L', concat([Uint8Array.of(0x2f), le32(bits), Uint8Array.from({ length: 40 }, (_, i) => (i * 37) & 255)]));
  const chunks: Uint8Array[] = [];
  const ext = s.extended || s.exif || s.xmp || s.icc;
  if (ext) {
    const flags = (s.icc ? 0x20 : 0) | (s.alpha ? 0x10 : 0) | (s.exif ? 0x08 : 0) | (s.xmp ? 0x04 : 0);
    chunks.push(riffChunk('VP8X', concat([Uint8Array.of(flags, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255)])));
    if (s.icc) chunks.push(riffChunk('ICCP', Uint8Array.from({ length: 33 }, (_, i) => i)));
  }
  chunks.push(vp8l);
  if (s.exif) chunks.push(riffChunk('EXIF', exifFor(s.exif)));
  if (s.xmp) chunks.push(riffChunk('XMP ', ascii(s.xmp)));
  if (s.unknown) chunks.push(riffChunk('SECR', ascii('unknown-chunk-secret')));
  const body = concat([ascii('WEBP'), ...chunks]);
  return concat([ascii('RIFF'), le32(body.length), body, ...(s.trailing ? [s.trailing] : [])]);
};

/** Add EXIF/XMP chunks to a real WebP (used by the in-app sample). */
export const injectWebp = (webp: Uint8Array, s: { exif?: PhotoSpec; xmp?: string }): Uint8Array => {
  const w = webp.subarray(12);
  const chunks: Uint8Array[] = [];
  let p = 0, width = 0, height = 0;
  const flags = (s.exif ? 0x08 : 0) | (s.xmp ? 0x04 : 0);
  let hadVp8x = false;
  while (p + 8 <= w.length) {
    const type = String.fromCharCode(...w.subarray(p, p + 4));
    const len = new DataView(w.buffer, w.byteOffset + p + 4, 4).getUint32(0, true);
    const end = p + 8 + len + (len & 1);
    if (type === 'VP8X') { hadVp8x = true; width = 1 + (w[p + 12] | (w[p + 13] << 8) | (w[p + 14] << 16)); height = 1 + (w[p + 15] | (w[p + 16] << 8) | (w[p + 17] << 16)); const c = w.slice(p, end); c[8] |= flags; chunks.push(c); }
    else {
      if (type === 'VP8L') { const b = new DataView(w.buffer, w.byteOffset + p + 9, 4).getUint32(0, true); width = 1 + (b & 0x3fff); height = 1 + ((b >>> 14) & 0x3fff); }
      else if (type === 'VP8 ') { width = new DataView(w.buffer, w.byteOffset + p + 14, 2).getUint16(0, true) & 0x3fff; height = new DataView(w.buffer, w.byteOffset + p + 16, 2).getUint16(0, true) & 0x3fff; }
      chunks.push(w.slice(p, end));
    }
    p = end;
  }
  const head = hadVp8x ? [] : [riffChunk('VP8X', Uint8Array.of(flags, 0, 0, 0, (width - 1) & 255, ((width - 1) >> 8) & 255, ((width - 1) >> 16) & 255, (height - 1) & 255, ((height - 1) >> 8) & 255, ((height - 1) >> 16) & 255))];
  const extra = [...(s.exif ? [riffChunk('EXIF', exifFor(s.exif))] : []), ...(s.xmp ? [riffChunk('XMP ', new TextEncoder().encode(s.xmp))] : [])];
  const body = concat([ascii('WEBP'), ...head, ...chunks, ...extra]);
  return concat([ascii('RIFF'), le32(body.length), body]);
};

/* ----------------------------- ISO-BMFF (HEIC, MP4) ----------------------------- */
export const box = (type: string, ...payload: Uint8Array[]) => {
  const body = concat(payload);
  return concat([p32be(8 + body.length), ascii(type), body]);
};
export const fullBox = (type: string, version: number, ...payload: Uint8Array[]) => box(type, Uint8Array.of(version, 0, 0, 0), ...payload);
const cs = (s: string) => concat([new TextEncoder().encode(s), Uint8Array.of(0)]);

export interface HeicSpec { exif?: PhotoSpec; xmp?: string; w?: number; h?: number; exifPrefix?: boolean }
/** Structurally valid HEIC container: ftyp + meta(iinf, iloc, iprp) + mdat. The "image" is filler. */
export const syntheticHeic = (s: HeicSpec = {}): Uint8Array => {
  const ftyp = box('ftyp', ascii('heic'), p32be(0), ascii('mif1'), ascii('heic'));
  const exifTiff = s.exif ? exifFor(s.exif) : undefined;
  const exifItem = exifTiff && concat([p32be(s.exifPrefix === false ? 0 : 6), ...(s.exifPrefix === false ? [] : [ascii('Exif\0\0')]), exifTiff]);
  const xmpItem = s.xmp ? new TextEncoder().encode(s.xmp) : undefined;
  const imageData = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) & 255);
  const items: { id: number; type: string; mime?: string; data: Uint8Array }[] = [{ id: 1, type: 'hvc1', data: imageData }];
  if (exifItem) items.push({ id: 2, type: 'Exif', data: exifItem });
  if (xmpItem) items.push({ id: 3, type: 'mime', mime: 'application/rdf+xml', data: xmpItem });
  const build = (offsets: number[]) => {
    const infe = items.map((it) => fullBox('infe', 2, Uint8Array.of(0, it.id), Uint8Array.of(0, 0), ascii(it.type), cs(''), ...(it.mime ? [cs(it.mime)] : [])));
    const iinf = fullBox('iinf', 0, Uint8Array.of(0, items.length), ...infe);
    const iloc = fullBox('iloc', 1, Uint8Array.of(0x44, 0x00), Uint8Array.of(0, items.length),
      ...items.map((it, i) => concat([Uint8Array.of(0, it.id), Uint8Array.of(0, 0), Uint8Array.of(0, 0), Uint8Array.of(0, 1), p32be(offsets[i]), p32be(it.data.length)])));
    const ispe = fullBox('ispe', 0, p32be(s.w ?? 640), p32be(s.h ?? 480));
    const iprp = box('iprp', box('ipco', ispe));
    return box('meta', Uint8Array.of(0, 0, 0, 0), fullBox('hdlr', 0, p32be(0), ascii('pict'), new Uint8Array(12), cs('')), fullBox('pitm', 0, Uint8Array.of(0, 1)), iinf, iloc, iprp);
  };
  const metaLen = build(items.map(() => 0)).length;
  let at = ftyp.length + metaLen + 8; // mdat payload start
  const offsets = items.map((it) => { const o = at; at += it.data.length; return o; });
  return concat([ftyp, build(offsets), box('mdat', ...items.map((i) => i.data))]);
};

export interface Mp4Spec { gps?: string; make?: string; model?: string; software?: string; created?: number; quickTime?: boolean; mdtaKeys?: boolean; timedTrack?: boolean; title?: string; xmp?: string }
/** Structurally valid MP4/MOV (moov with mvhd, one video trak, udta/meta tags, mdat). */
export const syntheticMp4 = (s: Mp4Spec = {}): Uint8Array => {
  const mac = (s.created ?? Date.UTC(2026, 5, 8, 18, 42, 7) / 1000) + 2082844800;
  const ftyp = box('ftyp', ascii(s.quickTime ? 'qt  ' : 'isom'), p32be(512), ascii(s.quickTime ? 'qt  ' : 'isom'), ascii('mp42'));
  const mvhd = fullBox('mvhd', 0, p32be(mac), p32be(mac), p32be(1000), p32be(5000), p32be(0x10000), Uint8Array.of(1, 0), new Uint8Array(10), new Uint8Array(36), new Uint8Array(24), p32be(2));
  const tkhd = fullBox('tkhd', 0, p32be(mac), p32be(mac), p32be(1), p32be(0), p32be(5000), new Uint8Array(8), new Uint8Array(8), new Uint8Array(36), p32be(1280 << 16), p32be(720 << 16));
  const mdhd = fullBox('mdhd', 0, p32be(mac), p32be(mac), p32be(1000), p32be(5000), Uint8Array.of(0x55, 0xc4, 0, 0));
  const hdlr = (t: string) => fullBox('hdlr', 0, p32be(0), ascii(t), new Uint8Array(12), cs(''));
  const traks = [box('trak', tkhd, box('mdia', mdhd, hdlr('vide')))];
  if (s.timedTrack) traks.push(box('trak', fullBox('tkhd', 0, p32be(mac), p32be(mac), p32be(2), p32be(0), p32be(5000), new Uint8Array(8), new Uint8Array(8), new Uint8Array(36), p32be(0), p32be(0)), box('mdia', fullBox('mdhd', 0, p32be(0), p32be(0), p32be(1000), p32be(5000), Uint8Array.of(0x55, 0xc4, 0, 0)), hdlr('meta'))));
  const udtaKids: Uint8Array[] = [];
  const tag = (name: string, v: string) => box(name, p16be(v.length), p16be(0x15c7), new TextEncoder().encode(v));
  if (s.gps && !s.mdtaKeys) udtaKids.push(tag('\xa9xyz', s.gps));
  if (!s.mdtaKeys) {
    if (s.make) udtaKids.push(tag('\xa9mak', s.make));
    if (s.model) udtaKids.push(tag('\xa9mod', s.model));
    if (s.software) udtaKids.push(tag('\xa9swr', s.software));
    if (s.title) udtaKids.push(tag('\xa9nam', s.title));
  }
  const moovKids: Uint8Array[] = [mvhd, ...traks];
  if (udtaKids.length) moovKids.push(box('udta', ...udtaKids));
  if (s.mdtaKeys) {
    const entries: [string, string][] = [];
    if (s.gps) entries.push(['com.apple.quicktime.location.ISO6709', s.gps]);
    if (s.make) entries.push(['com.apple.quicktime.make', s.make]);
    if (s.model) entries.push(['com.apple.quicktime.model', s.model]);
    if (s.software) entries.push(['com.apple.quicktime.software', s.software]);
    entries.push(['com.apple.quicktime.creationdate', '2026-06-08T14:42:07-0400']);
    const keys = fullBox('keys', 0, p32be(entries.length), ...entries.map(([k]) => box('mdta', new TextEncoder().encode(k))));
    const ilst = box('ilst', ...entries.map(([, v], i) => { const d = box('data', p32be(1), p32be(0), new TextEncoder().encode(v)); return concat([p32be(8 + d.length), p32be(i + 1), d]); }));
    moovKids.push(box('meta', hdlr('mdta'), keys, ilst));
  }
  const top: Uint8Array[] = [ftyp, box('moov', ...moovKids)];
  if (s.xmp) top.push(box('uuid', Uint8Array.from([0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac]), new TextEncoder().encode(s.xmp)));
  top.push(box('mdat', Uint8Array.from({ length: 300 }, (_, i) => (i * 13) & 255)));
  return concat(top);
};

/* ----------------------------- PDF ----------------------------- */
export interface PdfSpec {
  info?: Record<string, string>; xmp?: string;
  /** Compress the XMP stream (needs the async builder) */
  compressXmp?: boolean;
  /** Put the Info dict inside a compressed object stream (needs the async builder). */
  objStm?: boolean;
  /** Add an incremental update that re-saves the Info dict. */
  update?: Record<string, string>;
  linearized?: boolean;
  encrypt?: boolean;
  jpeg?: Uint8Array;
  trailing?: string;
}
const pdfStr = (s: string) => '(' + s.replace(/[\\()]/g, (c) => '\\' + c) + ')';
const pdfUtf16 = (s: string) => '<FEFF' + [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase() + '>';
const pdfDict = (d: Record<string, string>) => '<< ' + Object.entries(d).map(([k, v]) => `/${k} ${/[^\x20-\x7e]/.test(v) ? pdfUtf16(v) : pdfStr(v)}`).join(' ') + ' >>';

/** Build a small, classic-xref PDF (one blank page) carrying the given Info/XMP. Async so XMP/ObjStm can be deflated. */
export const syntheticPdf = async (s: PdfSpec = {}): Promise<Uint8Array> => {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let len = 0;
  const push = (x: Uint8Array | string) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const offsets = new Map<number, number>();
  const obj = (n: number, body: string | Uint8Array, stream?: Uint8Array, dict = '') => {
    offsets.set(n, len);
    if (stream) { push(`${n} 0 obj\n<< ${dict} /Length ${stream.length} >>\nstream\n`); push(stream); push('\nendstream\nendobj\n'); }
    else { push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); }
  };
  push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  if (s.linearized) { offsets.set(9, len); push('9 0 obj\n<< /Linearized 1 /L 1234 >>\nendobj\n'); }
  obj(1, '<< /Type /Catalog /Pages 2 0 R' + (s.xmp ? ' /Metadata 5 0 R' : '') + ' >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R' + (s.jpeg ? ' /Resources << /XObject << /Im0 7 0 R >> >>' : '') + ' >>');
  obj(4, '', enc.encode('0.8 g 20 20 160 160 re f'));
  if (s.xmp) {
    const x = enc.encode(`<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>${s.xmp}<?xpacket end="w"?>`);
    obj(5, '', s.compressXmp ? await deflateZlib(x) : x, `/Type /Metadata /Subtype /XML${s.compressXmp ? ' /Filter /FlateDecode' : ''}`);
  }
  let infoRef = '';
  if (s.info && !s.objStm) { obj(6, pdfDict(s.info)); infoRef = ' /Info 6 0 R'; }
  if (s.jpeg) obj(7, '', s.jpeg, '/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode');
  if (s.objStm && s.info) {
    const dict = enc.encode(pdfDict(s.info));
    const header = enc.encode(`6 0 `);
    const data = concat([header, dict]);
    obj(8, '', await deflateZlib(data), `/Type /ObjStm /N 1 /First ${header.length} /Filter /FlateDecode`);
    infoRef = ' /Info 6 0 R';
  }
  const encrypt = s.encrypt ? ' /Encrypt << /Filter /Standard /V 1 /R 2 >>' : '';
  const xref = len;
  const max = 9;
  push(`xref\n0 ${max + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= max; i++) push(offsets.has(i) ? `${String(offsets.get(i)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n');
  push(`trailer\n<< /Size ${max + 1} /Root 1 0 R${infoRef}${encrypt} >>\nstartxref\n${xref}\n%%EOF\n`);
  if (s.update) {
    obj(6, pdfDict(s.update));
    const x2 = len;
    push(`xref\n6 1\n${String(offsets.get(6)).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${max + 1} /Root 1 0 R /Info 6 0 R /Prev ${xref} >>\nstartxref\n${x2}\n%%EOF\n`);
  }
  if (s.trailing) push(s.trailing);
  return concat(parts);
};

/* ----------------------------- Office ----------------------------- */
export interface OfficeSpec {
  kind?: 'docx' | 'xlsx' | 'pptx';
  creator?: string; lastModifiedBy?: string; created?: string; modified?: string; revision?: string; title?: string;
  company?: string; manager?: string; template?: string; application?: string; totalTime?: string;
  custom?: Record<string, string>; thumbnail?: boolean; trackedAuthor?: string; absPath?: string;
}
export const syntheticOffice = (s: OfficeSpec = {}): Uint8Array => {
  const kind = s.kind ?? 'docx';
  const enc = new TextEncoder();
  const x = (t: string, v?: string, attrs = '') => (v ? `<${t}${attrs}>${v.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</${t}>` : '');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${x('dc:title', s.title)}${x('dc:creator', s.creator)}${x('cp:lastModifiedBy', s.lastModifiedBy)}${x('cp:revision', s.revision)}${x('dcterms:created', s.created, ' xsi:type="dcterms:W3CDTF"')}${x('dcterms:modified', s.modified, ' xsi:type="dcterms:W3CDTF"')}</cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">${x('Template', s.template)}${x('TotalTime', s.totalTime)}${x('Application', s.application)}${x('Company', s.company)}${x('Manager', s.manager)}</Properties>`;
  const customXml = s.custom ? `<?xml version="1.0" encoding="UTF-8"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${Object.entries(s.custom).map(([k, v], i) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${i + 2}" name="${k}"><vt:lpwstr>${v}</vt:lpwstr></property>`).join('')}</Properties>` : '';
  const main = kind === 'docx' ? 'word/document.xml' : kind === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
  const body = kind === 'docx'
    ? `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p>${s.trackedAuthor ? `<w:ins w:id="1" w:author="${s.trackedAuthor}" w:date="2026-06-08T00:00:00Z"><w:r><w:t>added</w:t></w:r></w:ins>` : ''}</w:body></w:document>`
    : kind === 'xlsx' ? `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac">${s.absPath ? `<mc:AlternateContent><mc:Choice Requires="x15ac"><x15ac:absPath url="${s.absPath}"/></mc:Choice></mc:AlternateContent>` : ''}<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`
    : `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>${s.thumbnail ? '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>' : ''}</Relationships>`;
  const files: { name: string; data: Uint8Array }[] = [
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="jpeg" ContentType="image/jpeg"/></Types>') },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: main, data: enc.encode(body) },
    { name: 'docProps/core.xml', data: enc.encode(core) },
    { name: 'docProps/app.xml', data: enc.encode(app) },
  ];
  if (customXml) files.push({ name: 'docProps/custom.xml', data: enc.encode(customXml) });
  if (s.thumbnail) files.push({ name: 'docProps/thumbnail.jpeg', data: syntheticJpeg(16, 12) });
  return makeZip(files, new Date(2026, 5, 8, 14, 32, 10));
};
