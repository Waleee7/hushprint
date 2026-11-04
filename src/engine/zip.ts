// ZIP: a small writer (STORE) for "download all", and a bounded reader/rewriter for Office files.
import { ParseError, concat, crc32, inflate, p16le, p32le, toAscii, u16le, u32le, utf8 } from './bytes.ts';
import { MAX_INFLATE_BYTES, MAX_ZIP_ENTRIES } from './limits.ts';

const DOS_TIME = (d: Date) => (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
const DOS_DATE = (d: Date) => ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

export const makeZip = (files: { name: string; data: Uint8Array }[], when = new Date()): Uint8Array => concat(makeZipParts(files, when));

/** Same as makeZip but returns the pieces, so a Blob can be built without one more full-size copy. */
export const makeZipParts = (files: { name: string; data: Uint8Array }[], when = new Date()): Uint8Array[] => {
  if (files.length > 65535) throw new ParseError('too many files for one ZIP');
  const time = DOS_TIME(when), date = DOS_DATE(when);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data);
    if (f.data.length > 0xfffffff0 || offset > 0xfffffff0) throw new ParseError('ZIP64 is not supported; split the batch');
    const local = concat([p32le(0x04034b50), p16le(20), p16le(0x0800), p16le(0), p16le(time), p16le(date), p32le(crc), p32le(f.data.length), p32le(f.data.length), p16le(name.length), p16le(0), name]);
    central.push(concat([p32le(0x02014b50), p16le(20), p16le(20), p16le(0x0800), p16le(0), p16le(time), p16le(date), p32le(crc), p32le(f.data.length), p32le(f.data.length), p16le(name.length), p16le(0), p16le(0), p16le(0), p16le(0), p32le(0), p32le(offset), name]));
    parts.push(local, f.data);
    offset += local.length + f.data.length;
  }
  const cd = concat(central);
  return [...parts, cd, concat([p32le(0x06054b50), p16le(0), p16le(0), p16le(files.length), p16le(files.length), p32le(cd.length), p32le(offset), p16le(0)])];
};

/* ------------------------------ reader ------------------------------ */

export interface ZipEntry {
  name: string; method: number; flags: number; crc: number;
  csize: number; usize: number; dataStart: number; version: number;
}

export const isZip = (b: Uint8Array) => b.length > 30 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;

export const readZip = (b: Uint8Array): ZipEntry[] => {
  // end-of-central-directory record sits in the last 64 KB + 22 bytes
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (u32le(b, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new ParseError('not a valid ZIP (no end record)');
  const count = u16le(b, e + 10), cdSize = u32le(b, e + 12), cdOff = u32le(b, e + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw new ParseError('ZIP64 archives are not supported');
  if (count > MAX_ZIP_ENTRIES) throw new ParseError('ZIP has too many entries');
  if (cdOff + cdSize > e) throw new ParseError('ZIP directory is out of range');
  const out: ZipEntry[] = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || u32le(b, p) !== 0x02014b50) throw new ParseError('ZIP directory is damaged');
    const flags = u16le(b, p + 8), method = u16le(b, p + 10), crc = u32le(b, p + 16), csize = u32le(b, p + 20), usize = u32le(b, p + 24);
    const nl = u16le(b, p + 28), xl = u16le(b, p + 30), cl = u16le(b, p + 32), lh = u32le(b, p + 42), version = u16le(b, p + 6);
    if (p + 46 + nl > b.length) throw new ParseError('ZIP directory is damaged');
    const raw = b.subarray(p + 46, p + 46 + nl);
    const name = flags & 0x800 ? utf8(raw) : toAscii(raw);
    if (flags & 1) throw new ParseError('Encrypted ZIP/Office files are not supported');
    if (lh + 30 > b.length || u32le(b, lh) !== 0x04034b50) throw new ParseError('ZIP entry header is damaged');
    const dataStart = lh + 30 + u16le(b, lh + 26) + u16le(b, lh + 28);
    if (dataStart + csize > cdOff) throw new ParseError('ZIP entry overruns the archive');
    out.push({ name, method, flags, crc, csize, usize, dataStart, version });
    p += 46 + nl + xl + cl;
  }
  return out;
};

export const entryRaw = (b: Uint8Array, e: ZipEntry) => b.subarray(e.dataStart, e.dataStart + e.csize);

/** Decompressed bytes of one entry, capped. */
export const entryData = async (b: Uint8Array, e: ZipEntry, max = MAX_INFLATE_BYTES): Promise<Uint8Array> => {
  if (e.method === 0) { if (e.csize > max) throw new ParseError('ZIP entry too large to read'); return entryRaw(b, e); }
  if (e.method !== 8) throw new ParseError(`unsupported ZIP compression method ${e.method}`);
  if (e.usize > max) throw new ParseError('ZIP entry too large to read');
  return inflate(entryRaw(b, e), { raw: true, max });
};

export interface Rewrite { replace?: Map<string, Uint8Array>; remove?: Set<string> }

/**
 * Rebuild an archive. Untouched entries keep their compressed bytes exactly; replaced entries are stored.
 * Every entry timestamp is reset to 1980-01-01 and extra fields, comments and data descriptors are dropped,
 * because those can carry file times and user IDs.
 */
export const rewriteZip = (b: Uint8Array, entries: ZipEntry[], r: Rewrite): Uint8Array => {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0, count = 0;
  for (const e of entries) {
    if (r.remove?.has(e.name)) continue;
    const swap = r.replace?.get(e.name);
    const data = swap ?? entryRaw(b, e);
    const method = swap ? 0 : e.method, crc = swap ? crc32(swap) : e.crc, usize = swap ? swap.length : e.usize;
    const name = enc.encode(e.name);
    const flags = 0x0800;
    const local = concat([p32le(0x04034b50), p16le(e.version || 20), p16le(flags), p16le(method), p16le(0), p16le(0x21), p32le(crc), p32le(data.length), p32le(usize), p16le(name.length), p16le(0), name]);
    central.push(concat([p32le(0x02014b50), p16le(e.version || 20), p16le(e.version || 20), p16le(flags), p16le(method), p16le(0), p16le(0x21), p32le(crc), p32le(data.length), p32le(usize), p16le(name.length), p16le(0), p16le(0), p16le(0), p16le(0), p32le(0), p32le(offset), name]));
    parts.push(local, data);
    offset += local.length + data.length;
    count++;
  }
  const cd = concat(central);
  return concat([...parts, cd, p32le(0x06054b50), p16le(0), p16le(0), p16le(count), p16le(count), p32le(cd.length), p32le(offset), p16le(0)]);
};
