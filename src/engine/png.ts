// PNG chunk parser and lossless stripper (drops text/EXIF/time chunks and anything after IEND).
import { ParseError, concat, crc32, inflate, p32be, startsWith, toAscii, u32be, utf8 } from './bytes.ts';
import { MAX_CHUNKS, MAX_META_SEGMENTS } from './limits.ts';
import { minimalOrientationTiff } from './tiff.ts';

export interface PngText { keyword: string; text: string; compressed: boolean }
export interface PngChunk { type: string; start: number; end: number }
export interface PngInfo {
  width: number; height: number; chunks: PngChunk[];
  text: PngText[]; exif?: Uint8Array; modified?: string; xmp: string[];
  trailing: { offset: number; length: number };
}

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const isPng = (b: Uint8Array) => startsWith(b, 0, SIG);

/** Chunks that affect how the picture looks. Everything else ancillary is dropped. */
const KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD', 'hIST', 'cICP', 'mDCV', 'acTL', 'fcTL', 'fdAT']);

const nul = (b: Uint8Array, from: number) => { let i = from; while (i < b.length && b[i] !== 0) i++; return i; };

export const parsePng = async (b: Uint8Array): Promise<PngInfo> => {
  if (!isPng(b)) throw new ParseError('not a PNG');
  const info: PngInfo = { width: 0, height: 0, chunks: [], text: [], xmp: [], trailing: { offset: b.length, length: 0 } };
  let pos = 8, sawEnd = false;
  while (pos + 12 <= b.length) {
    const len = u32be(b, pos);
    const type = toAscii(b.subarray(pos + 4, pos + 8));
    const end = pos + 12 + len;
    if (end > b.length) throw new ParseError(`chunk ${type} overruns file`);
    if (info.chunks.length >= MAX_CHUNKS) throw new ParseError('too many PNG chunks');
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (crc32(b.subarray(pos + 4, pos + 8 + len)) !== u32be(b, pos + 8 + len)) throw new ParseError(`bad CRC in ${type}`);
    info.chunks.push({ type, start: pos, end });
    if (type === 'IHDR') { info.width = u32be(data, 0); info.height = u32be(data, 4); }
    else if ((type === 'tEXt' || type === 'zTXt' || type === 'iTXt') && info.text.length + info.xmp.length >= MAX_META_SEGMENTS) { /* flood ignored; strip still drops them */ }
    else if (type === 'tEXt') { const z = nul(data, 0); info.text.push({ keyword: toAscii(data.subarray(0, z)), text: toAscii(data.subarray(z + 1)), compressed: false }); }
    else if (type === 'zTXt') {
      const z = nul(data, 0);
      let text = '';
      try { text = utf8(await inflate(data.subarray(z + 2))); } catch { text = '(compressed text)'; }
      info.text.push({ keyword: toAscii(data.subarray(0, z)), text, compressed: true });
    } else if (type === 'iTXt') {
      const z = nul(data, 0), comp = data[z + 1], l1 = nul(data, z + 3), l2 = nul(data, l1 + 1);
      const body = data.subarray(l2 + 1);
      let text = '';
      try { text = utf8(comp ? await inflate(body) : body); } catch { text = '(compressed text)'; }
      const keyword = toAscii(data.subarray(0, z));
      if (keyword === 'XML:com.adobe.xmp') info.xmp.push(text); else info.text.push({ keyword, text, compressed: !!comp });
    } else if (type === 'eXIf') info.exif = data;
    else if (type === 'tIME' && len === 7) {
      const p = (n: number) => String(n).padStart(2, '0');
      info.modified = `${(data[0] << 8) | data[1]}-${p(data[2])}-${p(data[3])} ${p(data[4])}:${p(data[5])}:${p(data[6])} UTC`;
    }
    pos = end;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawEnd) throw new ParseError('PNG has no IEND chunk (truncated)');
  info.trailing = { offset: pos, length: b.length - pos };
  return info;
};

const chunk = (type: string, data: Uint8Array) => {
  const t = new TextEncoder().encode(type);
  const body = concat([t, data]);
  return concat([p32be(data.length), body, p32be(crc32(body))]);
};

export const stripPng = async (b: Uint8Array, opts: { orientation?: number } = {}): Promise<Uint8Array> => {
  const info = await parsePng(b);
  const out: Uint8Array[] = [b.subarray(0, 8)];
  const orient = opts.orientation && opts.orientation > 1 && opts.orientation <= 8 ? opts.orientation : 0;
  for (const c of info.chunks) {
    // unknown critical chunks (uppercase first letter) are kept so the image still decodes
    if (!KEEP.has(c.type) && c.type[0] === c.type[0].toLowerCase()) continue;
    out.push(b.subarray(c.start, c.end));
    if (c.type === 'IHDR' && orient) out.push(chunk('eXIf', minimalOrientationTiff(orient)));
  }
  return concat(out);
};
