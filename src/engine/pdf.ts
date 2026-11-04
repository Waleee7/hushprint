// PDF metadata reader and in-place stripper.
//
// Approach: scan the file for `N G obj` markers (no xref trust, so damaged files still work), find the Info dictionary
// and the XMP metadata streams, and blank them *without changing the file length*. Because no byte moves, every xref
// offset stays valid and nothing else in the file changes. Things that cannot be removed this way (Info inside a
// compressed object stream, earlier saved revisions, encrypted files) are reported, not hidden.
import { ParseError, crc32, inflate, startsWith, toAscii, utf8 } from './bytes.ts';
import { MAX_INFLATE_BYTES, MAX_INFLATE_TOTAL, MAX_OBJSTM_BYTES, MAX_PDF_DICT, MAX_PDF_OBJECTS, MAX_PDF_OBJSTMS } from './limits.ts';

export interface PdfField { key: string; value: string }
interface Obj {
  num: number; gen: number; start: number; body: number; end: number;
  dictStart: number; dictEnd: number;        // `<<` .. one past `>>` (dictStart === -1 when the body is not a dictionary)
  streamStart: number; streamEnd: number;    // -1 when there is no stream
}
export interface PdfPatch { start: number; end: number; kind: 'info' | 'xmp' | 'string'; compressed?: boolean }
export interface PdfImageRef { num: number; start: number; end: number }
export interface PdfInfo {
  version: string; encrypted: boolean; objectCount: number; scanStopped: boolean; linearized: boolean;
  info: PdfField[];
  /** Info dictionary exists but only inside a compressed object stream: shown, cannot be blanked in place. */
  infoInObjStm: boolean;
  olderInfoCopies: number;
  xmp: string[];
  /** XMP streams we could not read (unsupported filter) */
  xmpUnreadable: number;
  savedRevisions: number;
  trailingBytes: number;
  jpegImages: PdfImageRef[];
  patches: PdfPatch[];
}

const WS = (c: number) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const DELIM = (c: number) => WS(c) || c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25 || Number.isNaN(c);
const DIGIT = (c: number) => c >= 48 && c <= 57;
const enc = new TextEncoder();

export const isPdf = (b: Uint8Array) => {
  const head = b.subarray(0, 1024);
  for (let i = 0; i + 5 <= head.length; i++) if (startsWith(head, i, '%PDF-')) return true;
  return false;
};

const indexOfSeq = (b: Uint8Array, seq: string, from: number, to = b.length): number => {
  const first = seq.charCodeAt(0);
  for (let i = b.indexOf(first, from); i >= 0 && i + seq.length <= to; i = b.indexOf(first, i + 1)) if (startsWith(b, i, seq)) return i;
  return -1;
};

const skipWs = (b: Uint8Array, i: number, end = b.length): number => {
  while (i < end) {
    if (WS(b[i])) i++;
    else if (b[i] === 0x25) { while (i < end && b[i] !== 10 && b[i] !== 13) i++; }
    else break;
  }
  return i;
};

/** Index one past the closing paren of the literal string that starts at `i`, or -1. */
const literalEnd = (b: Uint8Array, i: number, limit: number): number => {
  let depth = 0;
  for (; i < limit; i++) {
    const c = b[i];
    if (c === 0x5c) i++;
    else if (c === 0x28) depth++;
    else if (c === 0x29 && --depth === 0) return i + 1;
  }
  return -1;
};

/** Index one past the `>>` that closes the dictionary starting at `start`, or -1. */
export const dictEndAt = (b: Uint8Array, start: number): number => {
  const limit = Math.min(b.length, start + MAX_PDF_DICT);
  let depth = 0, i = start;
  while (i < limit) {
    const c = b[i];
    if (c === 0x3c && b[i + 1] === 0x3c) { depth++; i += 2; }
    else if (c === 0x3e && b[i + 1] === 0x3e) { depth--; i += 2; if (depth === 0) return i; }
    else if (c === 0x28) { const e = literalEnd(b, i, limit); if (e < 0) return -1; i = e; }
    else if (c === 0x3c) { const e = b.indexOf(0x3e, i + 1); if (e < 0 || e >= limit) return -1; i = e + 1; }
    else if (c === 0x25) { while (i < limit && b[i] !== 10 && b[i] !== 13) i++; }
    else i++;
  }
  return -1;
};

const decodeString = (raw: Uint8Array): string => {
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) return new TextDecoder('utf-16be').decode(raw.subarray(2));
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return new TextDecoder('utf-16le').decode(raw.subarray(2));
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return utf8(raw.subarray(3));
  return toAscii(raw);
};

/** Decode the literal string at b[i] == '('. Returns [bytes, indexAfter]. Length-capped. */
const readLiteral = (b: Uint8Array, i: number, limit: number): [Uint8Array, number] => {
  const e = literalEnd(b, i, limit);
  if (e < 0) return [new Uint8Array(0), limit];
  const out: number[] = [];
  for (let k = i + 1; k < e - 1 && out.length < 4096; k++) {
    const c = b[k];
    if (c !== 0x5c) { out.push(c); continue; }
    const n = b[++k];
    if (n === 0x6e) out.push(10); else if (n === 0x72) out.push(13); else if (n === 0x74) out.push(9);
    else if (n === 0x62) out.push(8); else if (n === 0x66) out.push(12);
    else if (n >= 48 && n <= 55) {
      let v = n - 48;
      for (let d = 0; d < 2 && b[k + 1] >= 48 && b[k + 1] <= 55; d++) v = v * 8 + (b[++k] - 48);
      out.push(v & 255);
    } else if (n === 13) { if (b[k + 1] === 10) k++; } else if (n === 10) { /* line continuation */ } else out.push(n);
  }
  return [Uint8Array.from(out), e];
};

const readHex = (b: Uint8Array, i: number, limit: number): [Uint8Array, number] => {
  const e = b.indexOf(0x3e, i + 1);
  const end = e < 0 || e >= limit ? limit : e;
  const digits: number[] = [];
  for (let k = i + 1; k < end && digits.length < 8192; k++) {
    const c = b[k];
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (v >= 0) digits.push(v);
  }
  if (digits.length % 2) digits.push(0);
  const out = new Uint8Array(digits.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = digits[2 * k] * 16 + digits[2 * k + 1];
  return [out, e < 0 ? limit : e + 1];
};

interface RawField { key: string; value?: string; ref?: number; valueStart: number; valueEnd: number }

/** Top-level `/Key value` pairs of one dictionary that hold strings or indirect references. */
const readDict = (b: Uint8Array, start: number, end: number): RawField[] => {
  const out: RawField[] = [];
  let i = start + 2;
  const limit = end - 2;
  while (i < limit && out.length < 200) {
    i = skipWs(b, i, limit);
    if (i >= limit) break;
    if (b[i] !== 0x2f) { i++; continue; }
    let k = i + 1;
    while (k < limit && !DELIM(b[k])) k++;
    const key = toAscii(b.subarray(i + 1, k)).replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    i = skipWs(b, k, limit);
    const c = b[i];
    if (c === 0x28) { const [raw, e] = readLiteral(b, i, limit); out.push({ key, value: decodeString(raw), valueStart: i, valueEnd: e }); i = e; }
    else if (c === 0x3c && b[i + 1] !== 0x3c) { const [raw, e] = readHex(b, i, limit); out.push({ key, value: decodeString(raw), valueStart: i, valueEnd: e }); i = e; }
    else if (c === 0x3c) { const e = dictEndAt(b, i); i = e < 0 ? limit : e; }
    else if (c === 0x5b) { const e = b.indexOf(0x5d, i); i = e < 0 ? limit : e + 1; }
    else if (DIGIT(c)) {
      let n = i; while (DIGIT(b[n])) n++;
      const a = skipWs(b, n, limit);
      let g = a; while (DIGIT(b[g])) g++;
      const r = skipWs(b, g, limit);
      if (g > a && b[r] === 0x52 && DELIM(b[r + 1])) { out.push({ key, ref: Number(toAscii(b.subarray(i, n))), valueStart: i, valueEnd: r + 1 }); i = r + 1; }
      else i = n;
    }
  }
  return out;
};

/** Scan for `N G obj ... endobj`. Streams are skipped using /Length when it is direct, else by searching `endstream`. */
const scanObjects = (b: Uint8Array): { objs: Obj[]; stopped: boolean } => {
  const objs: Obj[] = [];
  const n = b.length;
  let i = 0;
  while (i < n) {
    if (objs.length >= MAX_PDF_OBJECTS) return { objs, stopped: true };
    const o = b.indexOf(0x6f, i);
    if (o < 0) break;
    i = o + 1;
    if (b[o + 1] !== 0x62 || b[o + 2] !== 0x6a || (o + 3 < n && !DELIM(b[o + 3]))) continue;
    if (o >= 3 && b[o - 3] === 0x65 && b[o - 2] === 0x6e && b[o - 1] === 0x64) continue; // "endobj"
    let j = o - 1, w = 0;
    while (j >= 0 && WS(b[j])) { j--; w++; }
    if (!w) continue;
    const ge = j; while (j >= 0 && DIGIT(b[j])) j--;
    if (j === ge) continue;
    const gen = Number(toAscii(b.subarray(j + 1, ge + 1)));
    w = 0; while (j >= 0 && WS(b[j])) { j--; w++; }
    if (!w) continue;
    const ne = j; while (j >= 0 && DIGIT(b[j])) j--;
    if (j === ne || (j >= 0 && !DELIM(b[j]))) continue;
    const num = Number(toAscii(b.subarray(j + 1, ne + 1)));
    const start = j + 1;

    const obj: Obj = { num, gen, start, body: o + 3, end: n, dictStart: -1, dictEnd: -1, streamStart: -1, streamEnd: -1 };
    const k = skipWs(b, o + 3);
    let from = o + 3;
    if (b[k] === 0x3c && b[k + 1] === 0x3c) {
      const de = dictEndAt(b, k);
      if (de > 0) {
        obj.dictStart = k; obj.dictEnd = de; from = de;
        const s = skipWs(b, de);
        if (startsWith(b, s, 'stream')) {
          let ss = s + 6;
          if (b[ss] === 13 && b[ss + 1] === 10) ss += 2; else if (b[ss] === 10 || b[ss] === 13) ss += 1;
          const m = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(toAscii(b.subarray(k, Math.min(de, k + 2048))));
          let se = -1;
          if (m) {
            const len = Number(m[1]);
            if (ss + len <= n && startsWith(b, skipWs(b, ss + len), 'endstream')) se = ss + len;
          }
          if (se < 0) { const e = indexOfSeq(b, 'endstream', ss); se = e < 0 ? n : e; }
          obj.streamStart = ss; obj.streamEnd = se; from = se;
        }
      }
    }
    const e = indexOfSeq(b, 'endobj', from);
    obj.end = e < 0 ? n : e + 6;
    objs.push(obj);
    i = Math.max(i, obj.end);
  }
  return { objs, stopped: false };
};

const dictText = (b: Uint8Array, o: Obj, cap = 4096) => (o.dictStart < 0 ? '' : toAscii(b.subarray(o.dictStart, Math.min(o.dictEnd, o.dictStart + cap))));

const pdfDate = (s: string): string => {
  const m = /^D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?([Zz+-])?(\d\d)?'?(\d\d)?/.exec(s.trim());
  if (!m) return s;
  const date = `${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}`;
  const time = m[4] ? ` ${m[4]}:${m[5] ?? '00'}:${m[6] ?? '00'}` : '';
  const tz = m[7] && m[7] !== 'Z' && m[7] !== 'z' ? ` (UTC${m[7]}${m[8] ?? '00'}:${m[9] ?? '00'})` : m[7] ? ' UTC' : '';
  return `${date}${time}${tz}`;
};
export const prettyPdfDate = pdfDate;

const flateOnly = (dict: string) => {
  const f = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1];
  if (!f) return 'none' as const;
  return /^\[?\s*\/(FlateDecode|Fl)\s*\]?$/.test(f) ? 'flate' as const : 'other' as const;
};

const emptyXmp = enc.encode('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF></x:xmpmeta>');
const XMP_TAIL = enc.encode('<?xpacket end="w"?>');

/** Empty XMP packet padded with spaces to exactly `len` bytes (XMP allows whitespace padding). */
export const blankXmp = (len: number): Uint8Array => {
  const out = new Uint8Array(len).fill(0x20);
  if (len >= emptyXmp.length + XMP_TAIL.length) { out.set(emptyXmp, 0); out.set(XMP_TAIL, len - XMP_TAIL.length); }
  return out;
};

const adler32 = (d: Uint8Array) => {
  let a = 1, c = 0;
  for (let i = 0; i < d.length; i++) { a = (a + d[i]) % 65521; c = (c + a) % 65521; }
  return ((c << 16) | a) >>> 0;
};

/** A valid zlib stream of exactly `len` bytes made of stored blocks that decompress to `payload` padded with spaces. */
export const storedZlib = (len: number): Uint8Array | undefined => {
  // overhead = 2 (header) + 4 (adler) + 5 per stored block (max 65535 bytes each)
  let blocks = 1;
  for (;;) { const room = len - 6 - 5 * blocks; if (room < 0) return undefined; if (Math.ceil(room / 65535) <= blocks) break; blocks++; }
  const dataLen = len - 6 - 5 * blocks;
  const data = blankXmp(dataLen);
  const out = new Uint8Array(len);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2, d = 0;
  for (let k = 0; k < blocks; k++) {
    const n = k === blocks - 1 ? dataLen - d : Math.min(65535, dataLen - d);
    out[o++] = k === blocks - 1 ? 1 : 0;
    out[o++] = n & 255; out[o++] = n >> 8; out[o++] = ~n & 255; out[o++] = (~n >> 8) & 255;
    out.set(data.subarray(d, d + n), o); o += n; d += n;
  }
  const ad = adler32(data);
  out[o++] = ad >>> 24; out[o++] = (ad >>> 16) & 255; out[o++] = (ad >>> 8) & 255; out[o++] = ad & 255;
  return out;
};

export const parsePdf = async (b: Uint8Array): Promise<PdfInfo> => {
  if (!isPdf(b)) throw new ParseError('not a PDF');
  let verAt = 0; while (verAt < 1024 && !startsWith(b, verAt, '%PDF-')) verAt++;
  const info: PdfInfo = {
    version: toAscii(b.subarray(verAt + 5, verAt + 8)).trim(), encrypted: false, objectCount: 0, scanStopped: false, linearized: false,
    info: [], infoInObjStm: false, olderInfoCopies: 0, xmp: [], xmpUnreadable: 0, savedRevisions: 0, trailingBytes: 0, jpegImages: [], patches: [],
  };
  const { objs, stopped } = scanObjects(b);
  info.objectCount = objs.length; info.scanStopped = stopped;
  if (!objs.length) throw new ParseError('no PDF objects found');
  const byNum = new Map<number, Obj[]>();
  for (const o of objs) { const l = byNum.get(o.num); if (l) l.push(o); else byNum.set(o.num, [o]); }
  info.linearized = /\/Linearized\b/.test(dictText(b, objs[0], 512));

  // trailers and xref-stream dictionaries name the Info object
  const infoNums = new Set<number>();
  const note = (text: string) => {
    for (const m of text.matchAll(/\/Info\s+(\d+)\s+\d+\s+R/g)) if (infoNums.size < 64) infoNums.add(Number(m[1]));
    if (/\/Encrypt\b/.test(text)) info.encrypted = true;
  };
  for (let t = indexOfSeq(b, 'trailer', 0), c = 0; t >= 0 && c < 2000; t = indexOfSeq(b, 'trailer', t + 7), c++) note(toAscii(b.subarray(t, t + 2048)));
  for (const o of objs) if (o.streamStart >= 0 && /\/Type\s*\/XRef\b/.test(dictText(b, o, 1024))) note(dictText(b, o, 2048));

  // revisions
  let eofs = 0, lastEof = -1;
  for (let e = indexOfSeq(b, '%%EOF', 0); e >= 0 && eofs < 5000; e = indexOfSeq(b, '%%EOF', e + 5)) { eofs++; lastEof = e; }
  info.savedRevisions = Math.max(0, eofs - (info.linearized ? 1 : 0) - 1);
  if (lastEof >= 0) { let tail = 0; for (let i = lastEof + 5; i < b.length; i++) if (!WS(b[i])) tail++; info.trailingBytes = tail > 16 ? tail : 0; }

  // Info dictionaries (every copy in the file, including superseded revisions, is blanked)
  const resolveString = (ref: number): RawField | undefined => {
    const o = byNum.get(ref)?.at(-1);
    if (!o) return undefined;
    const k = skipWs(b, o.body);
    if (b[k] === 0x28) { const [raw, e] = readLiteral(b, k, o.end); info.patches.push({ start: k, end: e, kind: 'string' }); return { key: '', value: decodeString(raw), valueStart: k, valueEnd: e }; }
    return undefined;
  };
  const pending = new Set<number>();
  for (const num of infoNums) {
    const copies = byNum.get(num)?.filter((o) => o.dictStart >= 0 && o.streamStart < 0);
    if (!copies?.length) { pending.add(num); continue; }
    copies.forEach((o, idx) => {
      info.patches.push({ start: o.dictStart, end: o.dictEnd, kind: 'info' });
      const fields = readDict(b, o.dictStart, o.dictEnd);
      if (idx === copies.length - 1) {
        for (const f of fields) {
          const v = f.value ?? (f.ref !== undefined ? resolveString(f.ref)?.value : undefined);
          if (v !== undefined && v.trim() && f.key !== 'Trapped') info.info.push({ key: f.key, value: v.trim() });
        }
      } else if (fields.some((f) => f.value?.trim())) info.olderInfoCopies++;
    });
  }

  let inflated = 0;
  const budget = (n: number) => { inflated += n; if (inflated > MAX_INFLATE_TOTAL) throw new ParseError('PDF would decompress past the safety limit'); };

  // Info that only exists inside a compressed object stream
  if (pending.size && !info.encrypted) {
    let seen = 0;
    for (const o of objs) {
      if (o.streamStart < 0 || !/\/Type\s*\/ObjStm\b/.test(dictText(b, o, 1024))) continue;
      if (++seen > MAX_PDF_OBJSTMS) break;
      if (flateOnly(dictText(b, o, 1024)) !== 'flate') continue;
      let data: Uint8Array;
      try { data = await inflate(b.subarray(o.streamStart, o.streamEnd), { max: MAX_OBJSTM_BYTES }); } catch { continue; }
      budget(data.length);
      const d = dictText(b, o, 1024);
      const nObjs = Number(/\/N\s+(\d+)/.exec(d)?.[1] ?? 0), first = Number(/\/First\s+(\d+)/.exec(d)?.[1] ?? 0);
      const head = toAscii(data.subarray(0, Math.min(first, data.length))).trim().split(/\s+/).map(Number);
      for (let k = 0; k < nObjs && 2 * k + 1 < head.length; k++) {
        const num = head[2 * k], off = head[2 * k + 1];
        if (!pending.has(num) || !Number.isFinite(off)) continue;
        const at = first + off;
        const s = skipWs(data, at);
        if (data[s] !== 0x3c || data[s + 1] !== 0x3c) continue;
        const e = dictEndAt(data, s);
        if (e < 0) continue;
        info.infoInObjStm = true;
        for (const f of readDict(data, s, e)) if (f.value?.trim() && f.key !== 'Trapped') info.info.push({ key: f.key, value: f.value.trim() });
      }
    }
  }

  // XMP metadata streams
  for (const o of objs) {
    if (o.streamStart < 0) continue;
    const d = dictText(b, o, 1024);
    if (/\/Type\s*\/Metadata\b/.test(d) && /\/Subtype\s*\/XML\b/.test(d)) {
      const f = flateOnly(d);
      const raw = b.subarray(o.streamStart, o.streamEnd);
      if (f === 'none') { if (info.xmp.length < 8) info.xmp.push(utf8(raw.subarray(0, MAX_INFLATE_BYTES))); }
      else if (f === 'flate' && !info.encrypted) {
        try { const x = await inflate(raw); budget(x.length); if (info.xmp.length < 8) info.xmp.push(utf8(x)); } catch { info.xmpUnreadable++; }
      } else { info.xmpUnreadable++; continue; }
      info.patches.push({ start: o.streamStart, end: o.streamEnd, kind: 'xmp', compressed: f === 'flate' });
    } else if (/\/Filter\s*(\[\s*)?\/DCTDecode\b/.test(d) && /\/Subtype\s*\/Image\b/.test(d) && info.jpegImages.length < 24) {
      info.jpegImages.push({ num: o.num, start: o.streamStart, end: o.streamEnd });
    }
  }
  return info;
};

/** Blank every patch range in a copy of the file. Same length out as in. */
export const stripPdf = async (b: Uint8Array): Promise<Uint8Array> => {
  const info = await parsePdf(b);
  if (info.encrypted) throw new ParseError('This PDF is encrypted, so its metadata cannot be read or changed safely.');
  const out = b.slice();
  for (const p of info.patches) {
    const len = p.end - p.start;
    if (p.kind === 'info') { out.fill(0x20, p.start, p.end); out.set([0x3c, 0x3c], p.start); out.set([0x3e, 0x3e], p.end - 2); }
    else if (p.kind === 'string') { out.fill(0x20, p.start, p.end); out[p.start] = 0x28; out[p.end - 1] = 0x29; }
    else {
      out.set(p.compressed ? storedZlib(len) ?? blankXmp(len) : blankXmp(len), p.start);
    }
  }
  return out;
};

/** CRC over every byte outside the ranges we rewrite: proves the rest of the file did not move or change. */
export const pdfContentDigest = async (b: Uint8Array): Promise<number> => {
  const ranges = (await parsePdf(b)).patches.map((p) => [p.start, p.end] as const).sort((x, y) => x[0] - y[0]);
  let h = crc32(Uint8Array.of(b.length & 255, (b.length >>> 8) & 255, (b.length >>> 16) & 255, (b.length >>> 24) & 255));
  let at = 0;
  for (const [s, e] of ranges) { if (s > at) h = crc32(b.subarray(at, s), h); at = Math.max(at, e); }
  return crc32(b.subarray(at), h);
};
