// Programmatic fixtures: build JPEG/PNG files with known metadata. Used by the tests AND the in-app sample.
import { ascii, concat, crc32, p16be, p32be } from './bytes.ts';
import { buildTiff, type Rational, type WriteEntry } from './tiff.ts';

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
