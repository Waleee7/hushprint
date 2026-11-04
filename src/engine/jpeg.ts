// JPEG marker-level parser and lossless metadata stripper. Pixel data is never decoded or re-encoded.
import { ParseError, concat, p16be, startsWith, toAscii, u16be, utf8 } from './bytes.ts';
import { minimalOrientationTiff } from './tiff.ts';
import { parseIptc, type IptcField } from './xmp.ts';

interface Piece { kind: 'seg' | 'raw'; marker: number; start: number; end: number }

export interface JpegInfo {
  width: number; height: number;
  exif?: Uint8Array; xmp: string[]; iptc: IptcField[]; comments: string[];
  apps: string[];
  /** bytes after the final EOI (hidden second images, appended crops, ...) */
  trailing: { offset: number; length: number; startsWithJpeg: boolean };
  pieces: Piece[];
}

const EXIF_SIG = 'Exif\0\0';
const XMP_SIG = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT = 'http://ns.adobe.com/xmp/extension/\0';
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

export const isJpeg = (b: Uint8Array) => startsWith(b, 0, [0xff, 0xd8, 0xff]);

export const parseJpeg = (b: Uint8Array): JpegInfo => {
  if (!isJpeg(b)) throw new ParseError('not a JPEG');
  const info: JpegInfo = { width: 0, height: 0, xmp: [], iptc: [], comments: [], apps: [], trailing: { offset: b.length, length: 0, startsWithJpeg: false }, pieces: [] };
  let pos = 2;
  let sawEoi = false;
  while (pos < b.length) {
    if (b[pos] !== 0xff) throw new ParseError(`expected marker at ${pos}`);
    while (b[pos + 1] === 0xff) pos++; // fill bytes
    const m = b[pos + 1];
    if (m === 0xd9) { info.pieces.push({ kind: 'seg', marker: m, start: pos, end: pos + 2 }); pos += 2; sawEoi = true; break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { info.pieces.push({ kind: 'seg', marker: m, start: pos, end: pos + 2 }); pos += 2; continue; }
    if (pos + 4 > b.length) throw new ParseError('truncated segment');
    const len = u16be(b, pos + 2);
    const end = pos + 2 + len;
    if (len < 2 || end > b.length) throw new ParseError('segment overruns file');
    const payload = b.subarray(pos + 4, end);
    info.pieces.push({ kind: 'seg', marker: m, start: pos, end });
    if (isSof(m) && !info.width) { info.height = u16be(payload, 1); info.width = u16be(payload, 3); }
    if (m === 0xe1 && startsWith(payload, 0, EXIF_SIG)) info.exif ??= payload.subarray(6);
    else if (m === 0xe1 && (startsWith(payload, 0, XMP_SIG) || startsWith(payload, 0, XMP_EXT))) {
      info.xmp.push(utf8(payload.subarray(startsWith(payload, 0, XMP_SIG) ? XMP_SIG.length : XMP_EXT.length)));
    } else if (m === 0xed) info.iptc.push(...parseIptc(payload));
    else if (m === 0xfe) info.comments.push(utf8(payload));
    if (m >= 0xe0 && m <= 0xef) info.apps.push(`APP${m - 0xe0}:${toAscii(payload.subarray(0, 12)).split('\0')[0]}`);
    pos = end;
    if (m === 0xda) {
      let j = end;
      while (j < b.length && !(b[j] === 0xff && b[j + 1] !== 0 && b[j + 1] !== 0xff && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      info.pieces.push({ kind: 'raw', marker: 0, start: end, end: j });
      pos = j;
    }
  }
  if (!sawEoi) throw new ParseError('no end-of-image marker (truncated JPEG)');
  info.trailing = { offset: pos, length: b.length - pos, startsWithJpeg: b[pos] === 0xff && b[pos + 1] === 0xd8 };
  return info;
};

export const jpegSize = (b: Uint8Array): { width: number; height: number } | undefined => {
  try { const i = parseJpeg(b); return i.width ? { width: i.width, height: i.height } : undefined; } catch { return undefined; }
};

const isIcc = (m: number, p: Uint8Array) => m === 0xe2 && startsWith(p, 0, 'ICC_PROFILE\0');
const isAdobe = (m: number, p: Uint8Array) => m === 0xee && startsWith(p, 0, 'Adobe');
const isJfif = (m: number, p: Uint8Array) => m === 0xe0 && startsWith(p, 0, 'JFIF\0');

/** Re-assemble the JPEG keeping only what is needed to display it. Optionally preserves rotation. */
export const stripJpeg = (b: Uint8Array, opts: { orientation?: number } = {}): Uint8Array => {
  const info = parseJpeg(b);
  const out: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  const orient = opts.orientation && opts.orientation > 1 && opts.orientation <= 8 ? opts.orientation : 0;
  const orientSeg = () => {
    const payload = concat([new TextEncoder().encode(EXIF_SIG), minimalOrientationTiff(orient)]);
    return concat([Uint8Array.of(0xff, 0xe1), p16be(payload.length + 2), payload]);
  };
  let placed = !orient;
  for (const p of info.pieces) {
    if (p.kind === 'raw') { out.push(b.subarray(p.start, p.end)); continue; }
    const m = p.marker;
    if (m === 0xd8) continue;
    const isMeta = (m >= 0xe0 && m <= 0xef) || m === 0xfe;
    const payload = b.subarray(p.start + 4, p.end);
    if (!isMeta) {
      if (!placed) { out.push(orientSeg()); placed = true; }
      out.push(b.subarray(p.start, p.end));
    } else if (isJfif(m, payload)) {
      const keep = concat([payload.subarray(0, 12), Uint8Array.of(0, 0)]); // drop embedded JFIF thumbnail
      out.push(concat([Uint8Array.of(0xff, 0xe0), p16be(keep.length + 2), keep]));
      if (!placed) { out.push(orientSeg()); placed = true; }
    } else if (isIcc(m, payload) || isAdobe(m, payload)) out.push(b.subarray(p.start, p.end));
    // everything else (EXIF, XMP, IPTC, comments, vendor APPn) is dropped
  }
  return concat(out);
};
