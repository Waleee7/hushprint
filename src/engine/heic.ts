// HEIC / HEIF reader. Pulls the EXIF and XMP items out of the ISO-BMFF `meta` box so the leaks can be shown.
// HEVC pixels are never decoded here. A clean export is a canvas re-encode done by the caller (see raster.ts).
import { ParseError, concat, startsWith, toAscii, u16be, u32be, utf8 } from './bytes.ts';
import { type Box, type BoxBudget, newBudget, payloadStart, readBoxes } from './isobmff.ts';
import { MAX_ITEM_BYTES } from './limits.ts';

export interface HeicInfo {
  brand: string; width: number; height: number;
  /** TIFF block of the Exif item (starts at the byte-order mark). */
  exif?: Uint8Array;
  xmp: string[];
  /** Items present, by 4cc, for the report. */
  itemTypes: Record<string, number>;
  rotationDeg: number;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

export const ftypBrands = (b: Uint8Array): string[] => {
  if (!startsWith(b, 4, 'ftyp') || b.length < 16) return [];
  const size = Math.min(u32be(b, 0) || b.length, b.length);
  const out = [toAscii(b.subarray(8, 12))];
  for (let p = 16; p + 4 <= size && out.length < 32; p += 4) out.push(toAscii(b.subarray(p, p + 4)));
  return out;
};
export const isAvif = (b: Uint8Array) => ftypBrands(b).some((x) => AVIF_BRANDS.has(x));
export const isHeic = (b: Uint8Array) => { const br = ftypBrands(b); return br.length > 0 && !br.some((x) => AVIF_BRANDS.has(x)) && br.some((x) => HEIC_BRANDS.has(x)); };

interface Item { id: number; type: string; contentType?: string }
interface Extent { offset: number; length: number }
interface Loc { id: number; method: number; base: number; extents: Extent[] }

const readUint = (b: Uint8Array, at: number, size: number): number => {
  if (size === 0) return 0;
  if (at + size > b.length) throw new ParseError('box field out of range');
  if (size === 4) return u32be(b, at);
  if (size === 8) { const hi = u32be(b, at), lo = u32be(b, at + 4); if (hi > 0x1fffff) throw new ParseError('offset too large'); return hi * 2 ** 32 + lo; }
  if (size === 2) return u16be(b, at);
  throw new ParseError('unsupported field size');
};

const cstr = (b: Uint8Array, at: number, end: number): [string, number] => {
  let i = at;
  while (i < end && b[i] !== 0) i++;
  return [utf8(b.subarray(at, i)), Math.min(i + 1, end)];
};

const parseInfe = (b: Uint8Array, bx: Box): Item | undefined => {
  const p = payloadStart(bx);
  const v = b[p];
  if (v < 2) return undefined; // v0/v1 predate HEIF item types
  let q = p + 4;
  let id: number;
  if (v === 2) { id = u16be(b, q); q += 2; } else { id = u32be(b, q); q += 4; }
  q += 2; // protection index
  if (q + 4 > bx.end) return undefined;
  const type = toAscii(b.subarray(q, q + 4)); q += 4;
  const [, afterName] = cstr(b, q, bx.end);
  const item: Item = { id, type };
  if (type === 'mime') item.contentType = cstr(b, afterName, bx.end)[0];
  return item;
};

const parseIinf = (b: Uint8Array, iinf: Box, budget: BoxBudget): Item[] => {
  const p = payloadStart(iinf);
  const v = b[p];
  const first = p + 4 + (v === 0 ? 2 : 4);
  return readBoxes(b, first, iinf.end, budget).filter((x) => x.type === 'infe').map((x) => parseInfe(b, x)).filter((x): x is Item => !!x);
};

const parseIloc = (b: Uint8Array, iloc: Box): Loc[] => {
  const p = payloadStart(iloc);
  const v = b[p];
  if (v > 2) throw new ParseError('unsupported iloc version');
  const offSize = b[p + 4] >> 4, lenSize = b[p + 4] & 15, baseSize = b[p + 5] >> 4, idxSize = v > 0 ? b[p + 5] & 15 : 0;
  for (const s of [offSize, lenSize, baseSize, idxSize]) if (![0, 2, 4, 8].includes(s)) throw new ParseError('bad iloc field size');
  let q = p + 6;
  const count = v < 2 ? u16be(b, q) : u32be(b, q);
  q += v < 2 ? 2 : 4;
  const out: Loc[] = [];
  let work = 0;
  for (let i = 0; i < count && i < 20000 && q + 8 <= iloc.end; i++) {
    const id = v < 2 ? u16be(b, q) : u32be(b, q); q += v < 2 ? 2 : 4;
    let method = 0;
    if (v > 0) { method = u16be(b, q) & 15; q += 2; }
    q += 2; // data reference index
    const base = readUint(b, q, baseSize); q += baseSize;
    const n = u16be(b, q); q += 2;
    const extents: Extent[] = [];
    for (let k = 0; k < n; k++) {
      if (++work > 100_000) throw new ParseError('iloc has too many extents');
      if (q + idxSize + offSize + lenSize > iloc.end) throw new ParseError('iloc overruns box');
      q += idxSize;
      const offset = readUint(b, q, offSize); q += offSize;
      const length = readUint(b, q, lenSize); q += lenSize;
      if (extents.length < 64) extents.push({ offset, length });
    }
    out.push({ id, method, base, extents });
  }
  return out;
};

/** Assemble one item's bytes from its extents. Total size is capped, so a hostile iloc cannot make us allocate. */
const itemBytes = (b: Uint8Array, loc: Loc, idat?: Box): Uint8Array | undefined => {
  let total = 0;
  const parts: Uint8Array[] = [];
  for (const e of loc.extents) {
    total += e.length;
    if (total > MAX_ITEM_BYTES) return undefined;
    const origin = loc.method === 1 ? (idat ? payloadStart(idat) : -1) : 0;
    if (origin < 0 || loc.method > 1) return undefined;
    const start = origin + loc.base + e.offset;
    if (start + e.length > b.length) return undefined;
    parts.push(b.subarray(start, start + e.length));
  }
  return parts.length === 1 ? parts[0] : concat(parts);
};

export const parseHeic = (b: Uint8Array): HeicInfo => {
  if (!isHeic(b)) throw new ParseError('not a HEIC file');
  const budget = newBudget();
  const top = readBoxes(b, 0, b.length, budget);
  const brand = ftypBrands(b)[0];
  const info: HeicInfo = { brand, width: 0, height: 0, xmp: [], itemTypes: {}, rotationDeg: 0 };
  const meta = top.find((x) => x.type === 'meta');
  if (!meta) throw new ParseError('HEIC has no meta box');
  const kids = readBoxes(b, payloadStart(meta) + 4, meta.end, budget);
  const iinf = kids.find((x) => x.type === 'iinf'), iloc = kids.find((x) => x.type === 'iloc'), idat = kids.find((x) => x.type === 'idat');
  const items = iinf ? parseIinf(b, iinf, budget) : [];
  for (const it of items) info.itemTypes[it.type] = (info.itemTypes[it.type] ?? 0) + 1;

  const iprp = kids.find((x) => x.type === 'iprp');
  if (iprp) {
    const ipco = readBoxes(b, payloadStart(iprp), iprp.end, budget).find((x) => x.type === 'ipco');
    if (ipco) for (const prop of readBoxes(b, payloadStart(ipco), ipco.end, budget)) {
      const p = payloadStart(prop);
      if (prop.type === 'ispe' && !info.width && prop.end - p >= 12) { info.width = u32be(b, p + 4); info.height = u32be(b, p + 8); }
      else if (prop.type === 'irot' && prop.end - p >= 1 && !info.rotationDeg) info.rotationDeg = (b[p] & 3) * 90;
    }
  }

  if (iloc) {
    const locs = new Map(parseIloc(b, iloc).map((l) => [l.id, l]));
    for (const it of items) {
      const isExif = it.type === 'Exif';
      const isXmp = it.type === 'mime' && /xmp|rdf\+xml/i.test(it.contentType ?? '');
      if (!isExif && !isXmp) continue;
      const loc = locs.get(it.id);
      const data = loc && itemBytes(b, loc, idat);
      if (!data) continue;
      if (isXmp) { if (info.xmp.length < 4) info.xmp.push(utf8(data)); continue; }
      if (info.exif || data.length < 12) continue;
      const skip = u32be(data, 0); // distance from this field to the TIFF header (usually 6: the "Exif\0\0" prefix)
      if (4 + skip + 8 <= data.length) info.exif = data.subarray(4 + skip);
    }
  }
  return info;
};
