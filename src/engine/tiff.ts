// Hand-written TIFF/EXIF reader and writer (JPEG APP1, PNG eXIf). No dependencies.
import { ParseError, ascii, concat, toAscii } from './bytes.ts';
import { MAX_TIFF_WORK } from './limits.ts';

export type Rational = [number, number];
export type TagValue = string | number | number[] | Rational[] | Uint8Array;
export interface RawEntry { tag: number; type: number; count: number; value: TagValue }
export interface ParsedTiff {
  little: boolean;
  ifd0: Map<number, RawEntry>;
  exif: Map<number, RawEntry>;
  gps: Map<number, RawEntry>;
  ifd1: Map<number, RawEntry>;
  thumbnail?: Uint8Array;
  warnings: string[];
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const MAX_ENTRIES = 512;

export const parseTiff = (buf: Uint8Array): ParsedTiff => {
  if (buf.length < 8) throw new ParseError('TIFF too short');
  const little = buf[0] === 0x49 && buf[1] === 0x49;
  if (!little && !(buf[0] === 0x4d && buf[1] === 0x4d)) throw new ParseError('bad TIFF byte order');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => { if (o < 0 || o + 2 > buf.length) throw new ParseError('read past end'); return dv.getUint16(o, little); };
  const u32 = (o: number) => { if (o < 0 || o + 4 > buf.length) throw new ParseError('read past end'); return dv.getUint32(o, little); };
  if (u16(2) !== 42) throw new ParseError('bad TIFF magic');
  const warnings: string[] = [];
  const seen = new Set<number>();
  let work = 0; // elements/bytes decoded so far; overlapping hostile entries cannot multiply memory past MAX_TIFF_WORK

  const readValue = (type: number, count: number, at: number): TagValue => {
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const off = size <= 4 ? at : u32(at);
    if (off + size > buf.length) throw new ParseError('value out of range');
    work += count;
    if (work > MAX_TIFF_WORK) throw new ParseError('EXIF block decodes to too much data');
    switch (type) {
      case 2: return toAscii(buf.subarray(off, off + count)).replace(/\0+$/, '');
      case 3: return Array.from({ length: count }, (_, i) => u16(off + i * 2));
      case 4: return Array.from({ length: count }, (_, i) => u32(off + i * 4));
      case 8: return Array.from({ length: count }, (_, i) => dv.getInt16(off + i * 2, little));
      case 9: return Array.from({ length: count }, (_, i) => dv.getInt32(off + i * 4, little));
      case 5: return Array.from({ length: count }, (_, i) => [u32(off + i * 8), u32(off + i * 8 + 4)] as Rational);
      case 10: return Array.from({ length: count }, (_, i) => [dv.getInt32(off + i * 8, little), dv.getInt32(off + i * 8 + 4, little)] as Rational);
      case 11: return Array.from({ length: count }, (_, i) => dv.getFloat32(off + i * 4, little));
      case 12: return Array.from({ length: count }, (_, i) => dv.getFloat64(off + i * 8, little));
      default: return buf.subarray(off, off + count);
    }
  };

  const readIfd = (offset: number): { entries: Map<number, RawEntry>; next: number } => {
    const entries = new Map<number, RawEntry>();
    if (seen.has(offset)) { warnings.push('IFD loop ignored'); return { entries, next: 0 }; }
    seen.add(offset);
    const n = Math.min(u16(offset), MAX_ENTRIES);
    for (let i = 0; i < n; i++) {
      const at = offset + 2 + i * 12;
      try {
        const tag = u16(at), type = u16(at + 2), count = u32(at + 4);
        if (count > buf.length) continue;
        entries.set(tag, { tag, type, count, value: readValue(type, count, at + 8) });
      } catch { warnings.push(`unreadable tag at entry ${i}`); }
    }
    let next = 0;
    try { next = u32(offset + 2 + n * 12); } catch { /* no next */ }
    return { entries, next };
  };

  const out: ParsedTiff = { little, ifd0: new Map(), exif: new Map(), gps: new Map(), ifd1: new Map(), warnings };
  const first = readIfd(u32(4));
  out.ifd0 = first.entries;
  const sub = (tag: number) => {
    const p = out.ifd0.get(tag)?.value;
    return Array.isArray(p) && typeof p[0] === 'number' ? (p[0] as number) : undefined;
  };
  try { const o = sub(0x8769); if (o) out.exif = readIfd(o).entries; } catch { warnings.push('Exif IFD unreadable'); }
  try { const o = sub(0x8825); if (o) out.gps = readIfd(o).entries; } catch { warnings.push('GPS IFD unreadable'); }
  if (first.next) {
    try {
      out.ifd1 = readIfd(first.next).entries;
      const off = (out.ifd1.get(0x201)?.value as number[] | undefined)?.[0];
      const len = (out.ifd1.get(0x202)?.value as number[] | undefined)?.[0];
      if (off !== undefined && len && off + len <= buf.length) out.thumbnail = buf.slice(off, off + len);
    } catch { warnings.push('thumbnail IFD unreadable'); }
  }
  return out;
};

/* ----------------------------- writer ----------------------------- */

export interface WriteEntry { tag: number; type: 1 | 2 | 3 | 4 | 5 | 7; value: number[] | string | Rational[] | Uint8Array }
export interface TiffSpec { ifd0?: WriteEntry[]; exif?: WriteEntry[]; gps?: WriteEntry[]; thumbnail?: Uint8Array; little?: boolean }

const entryBytes = (e: WriteEntry): Uint8Array => {
  const v = e.value;
  if (e.type === 2) return concat([ascii(v as string), Uint8Array.of(0)]);
  if (e.type === 1 || e.type === 7) return Uint8Array.from(v as number[] | Uint8Array);
  return new Uint8Array(0);
};

export const buildTiff = (spec: TiffSpec): Uint8Array => {
  const little = spec.little ?? false;
  const ifd0 = [...(spec.ifd0 ?? [])];
  const exif = spec.exif ?? [];
  const gps = spec.gps ?? [];
  // Pointer entries are filled in on the second layout pass.
  if (exif.length) ifd0.push({ tag: 0x8769, type: 4, value: [0] });
  if (gps.length) ifd0.push({ tag: 0x8825, type: 4, value: [0] });
  const thumb = spec.thumbnail;
  const ifd1: WriteEntry[] = thumb ? [{ tag: 0x201, type: 4, value: [0] }, { tag: 0x202, type: 4, value: [thumb.length] }] : [];
  const sort = (l: WriteEntry[]) => l.sort((a, b) => a.tag - b.tag);
  [ifd0, exif, gps, ifd1].forEach(sort);

  const sizeOf = (e: WriteEntry) => {
    if (e.type === 2) return (e.value as string).length + 1;
    if (e.type === 1 || e.type === 7) return (e.value as number[]).length;
    if (e.type === 3) return (e.value as number[]).length * 2;
    if (e.type === 4) return (e.value as number[]).length * 4;
    return (e.value as Rational[]).length * 8;
  };
  const count = (e: WriteEntry) => (e.type === 2 ? (e.value as string).length + 1 : (e.value as unknown[]).length);

  const layout = (ptrs: { exif: number; gps: number; thumb: number }) => {
    const ifds = [ifd0, exif, gps, ifd1].filter((l) => l.length);
    const offsets = new Map<WriteEntry[], number>();
    let cursor = 8;
    for (const l of ifds) { offsets.set(l, cursor); cursor += 2 + l.length * 12 + 4; }
    const data: { at: number; bytes: Uint8Array }[] = [];
    const fixed = new Map<WriteEntry, Uint8Array>();
    const alloc = (b: Uint8Array) => { if (cursor % 2) cursor++; const at = cursor; data.push({ at, bytes: b }); cursor += b.length; return at; };
    return { ifds, offsets, alloc, fixed, data, end: () => cursor, ptrs };
  };

  // pass 1 to learn the offsets, pass 2 to emit with real pointers
  const emit = (ptrs: { exif: number; gps: number; thumb: number }) => {
    const L = layout(ptrs);
    const dv16 = (n: number) => (little ? Uint8Array.of(n & 255, (n >> 8) & 255) : Uint8Array.of((n >> 8) & 255, n & 255));
    const dv32 = (n: number) => (little ? Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255) : Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255));
    const valueBytes = (e: WriteEntry): Uint8Array => {
      if (e.type === 3) return concat((e.value as number[]).map(dv16));
      if (e.type === 4) return concat((e.value as number[]).map(dv32));
      if (e.type === 5) return concat((e.value as Rational[]).flatMap(([n, d]) => [dv32(n), dv32(d)]));
      return entryBytes(e);
    };
    // allocate out-of-line values first so end offsets are known
    const inline = new Map<WriteEntry, Uint8Array>();
    const outline = new Map<WriteEntry, number>();
    for (const l of L.ifds) for (const e of l) {
      if (l === ifd0 && e.tag === 0x8769) e.value = [ptrs.exif];
      if (l === ifd0 && e.tag === 0x8825) e.value = [ptrs.gps];
      if (l === ifd1 && e.tag === 0x201) e.value = [ptrs.thumb];
      const vb = valueBytes(e);
      if (sizeOf(e) <= 4) inline.set(e, vb); else outline.set(e, L.alloc(vb));
    }
    const thumbAt = thumb ? L.alloc(thumb) : 0;
    const out = new Uint8Array(L.end() + (L.end() % 2));
    out.set(little ? [0x49, 0x49, 42, 0, 8, 0, 0, 0] : [0x4d, 0x4d, 0, 42, 0, 0, 0, 8]);
    const ifdList = L.ifds;
    ifdList.forEach((l, idx) => {
      let o = L.offsets.get(l)!;
      out.set(dv16(l.length), o); o += 2;
      for (const e of l) {
        out.set(dv16(e.type), o + 2);
        out.set(dv32(count(e)), o + 4);
        out.set(dv16(e.tag), o);
        const iv = inline.get(e);
        if (iv) { const padded = new Uint8Array(4); padded.set(iv); out.set(padded, o + 8); }
        else out.set(dv32(outline.get(e)!), o + 8);
        o += 12;
      }
      // only IFD0 -> IFD1 link
      const nextIsIfd1 = l === ifd0 && ifd1.length > 0;
      out.set(dv32(nextIsIfd1 ? L.offsets.get(ifd1)! : 0), o);
      void idx;
    });
    for (const d of L.data) out.set(d.bytes, d.at);
    return { out, offsets: L.offsets, thumbAt };
  };

  const first = emit({ exif: 0, gps: 0, thumb: 0 });
  const second = emit({ exif: first.offsets.get(exif) ?? 0, gps: first.offsets.get(gps) ?? 0, thumb: first.thumbAt });
  return second.out;
};

/** The only EXIF we keep: a single Orientation tag, so photos are never left sideways. */
export const minimalOrientationTiff = (orientation: number): Uint8Array =>
  buildTiff({ ifd0: [{ tag: 0x112, type: 3, value: [orientation] }] });
