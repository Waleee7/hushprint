// WebP (RIFF) parser and lossless stripper. The compressed image chunks are copied byte for byte.
import { ParseError, concat, p32le, startsWith, toAscii, u16le, u32le, utf8 } from './bytes.ts';
import { MAX_CHUNKS } from './limits.ts';
import { minimalOrientationTiff } from './tiff.ts';

export interface WebpChunk { type: string; start: number; end: number; dataStart: number; dataLen: number }
export interface WebpInfo {
  width: number; height: number; animated: boolean; hasAlpha: boolean;
  chunks: WebpChunk[];
  exif?: Uint8Array; xmp: string[];
  trailing: { offset: number; length: number };
}

export const isWebp = (b: Uint8Array) => startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP');

/** Chunks needed to display the image. Everything else (EXIF, XMP, unknown) is dropped. */
const KEEP = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
const IMAGE = new Set(['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

export const parseWebp = (b: Uint8Array): WebpInfo => {
  if (!isWebp(b)) throw new ParseError('not a WebP');
  const riffEnd = 8 + u32le(b, 4);
  if (riffEnd > b.length) throw new ParseError('WebP is truncated');
  if (riffEnd < 12) throw new ParseError('bad RIFF size');
  const info: WebpInfo = { width: 0, height: 0, animated: false, hasAlpha: false, chunks: [], xmp: [], trailing: { offset: riffEnd, length: b.length - riffEnd } };
  let pos = 12;
  while (pos + 8 <= riffEnd) {
    if (info.chunks.length >= MAX_CHUNKS) throw new ParseError('too many WebP chunks');
    const type = toAscii(b.subarray(pos, pos + 4));
    const len = u32le(b, pos + 4);
    const dataStart = pos + 8;
    const end = dataStart + len + (len & 1);
    if (dataStart + len > riffEnd) throw new ParseError(`chunk ${type.trim()} overruns file`);
    info.chunks.push({ type, start: pos, end: Math.min(end, riffEnd), dataStart, dataLen: len });
    const d = b.subarray(dataStart, dataStart + len);
    if (type === 'VP8X' && len >= 10) {
      info.animated = !!(d[0] & 0x02); info.hasAlpha = !!(d[0] & 0x10);
      info.width = 1 + (d[4] | (d[5] << 8) | (d[6] << 16)); info.height = 1 + (d[7] | (d[8] << 8) | (d[9] << 16));
    } else if (type === 'VP8L' && len >= 5 && d[0] === 0x2f) {
      const bits = u32le(d, 1);
      if (!info.width) { info.width = 1 + (bits & 0x3fff); info.height = 1 + ((bits >>> 14) & 0x3fff); }
      if ((bits >>> 28) & 1) info.hasAlpha = true;
    } else if (type === 'VP8 ' && len >= 10 && d[3] === 0x9d && d[4] === 0x01 && d[5] === 0x2a) {
      if (!info.width) { info.width = u16le(d, 6) & 0x3fff; info.height = u16le(d, 8) & 0x3fff; }
    } else if (type === 'ALPH') info.hasAlpha = true;
    else if (type === 'EXIF' && !info.exif) info.exif = startsWith(d, 0, 'Exif\0\0') ? d.subarray(6) : d;
    else if (type === 'XMP ' && info.xmp.length < 16) info.xmp.push(utf8(d));
    pos = end;
  }
  if (!info.chunks.some((c) => c.type === 'VP8 ' || c.type === 'VP8L' || c.type === 'ANMF')) throw new ParseError('WebP has no image data');
  return info;
};

const chunk = (type: string, data: Uint8Array) =>
  concat([new TextEncoder().encode(type), p32le(data.length), data, data.length & 1 ? Uint8Array.of(0) : new Uint8Array(0)]);

export const stripWebp = (b: Uint8Array, opts: { orientation?: number } = {}): Uint8Array => {
  const info = parseWebp(b);
  const orient = opts.orientation && opts.orientation > 1 && opts.orientation <= 8 ? opts.orientation : 0;
  const body: Uint8Array[] = [];
  let flags = 0;
  for (const c of info.chunks) {
    if (!KEEP.has(c.type) || c.type === 'VP8X') continue;
    body.push(b.subarray(c.start, c.end));
  }
  const vp8x = info.chunks.find((c) => c.type === 'VP8X');
  if (vp8x) flags = b[vp8x.dataStart] & 0x32; // keep ICC (0x20), alpha (0x10), animation (0x02); drop EXIF (0x08) and XMP (0x04)
  else {
    if (info.hasAlpha) flags |= 0x10;
    if (info.chunks.some((c) => c.type === 'ICCP')) flags |= 0x20;
  }
  const extended = !!vp8x || !!orient; // a bare VP8/VP8L file needs a VP8X header to carry an EXIF chunk
  if (orient) { flags |= 0x08; body.push(chunk('EXIF', minimalOrientationTiff(orient))); }
  const parts: Uint8Array[] = [];
  if (extended) {
    if (!info.width || !info.height) throw new ParseError('WebP dimensions unreadable');
    const w = info.width - 1, h = info.height - 1;
    parts.push(chunk('VP8X', Uint8Array.of(flags, 0, 0, 0, w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255)));
  }
  const payload = concat([new TextEncoder().encode('WEBP'), ...parts, ...body]);
  return concat([new TextEncoder().encode('RIFF'), p32le(payload.length), payload]);
};

export const webpPixelDigestRanges = (b: Uint8Array): [number, number][] =>
  parseWebp(b).chunks.filter((c) => IMAGE.has(c.type)).map((c) => [c.start, c.end]);
