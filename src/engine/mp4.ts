// MP4 / MOV (ISO-BMFF) metadata reader and in-place stripper.
// Stripping never moves a byte: metadata boxes are renamed `free` and zero-filled, so every chunk offset stays valid
// and the audio/video samples in `mdat` are untouched.
import { ParseError, crc32, startsWith, toAscii, u16be, u32be, utf8 } from './bytes.ts';
import { type Box, findAll, metaChildrenStart, newBudget, payloadStart, readBoxes } from './isobmff.ts';

export interface VideoTag { key: string; value: string; source: string }
export type Patch = { kind: 'wipe'; box: Box } | { kind: 'zero'; at: number; len: number };
export interface VideoInfo {
  brand: string; quickTime: boolean; width: number; height: number; durationSec: number;
  created?: string; tags: VideoTag[];
  gps?: { lat: number; lon: number; altitude?: number };
  /** Timed-metadata tracks (e.g. GoPro GPMF, dashcam GPS). Can carry a location per frame. Not touched by stripping. */
  timedTracks: string[];
  xmp: string[];
  patches: Patch[];
  mdat: Box[];
}

const XMP_UUID = [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac];
const VIDEO_BRANDS = /^(isom|iso\d|mp4\d|mp41|mp42|avc1|qt  |M4V |M4A |3gp\w|3g2\w|MSNV|dash|f4v |XAVC|CAEP|mmp4)$/;

export const isVideo = (b: Uint8Array) => {
  if (!startsWith(b, 4, 'ftyp') || b.length < 16) return false;
  const major = toAscii(b.subarray(8, 12));
  return VIDEO_BRANDS.test(major);
};

const MAC_TO_UNIX = 2082844800;
const isoFromMac = (secs: number): string | undefined => {
  if (!secs) return undefined;
  const ms = (secs - MAC_TO_UNIX) * 1000;
  const y = new Date(ms).getUTCFullYear();
  return Number.isFinite(ms) && y >= 1990 && y <= 2100 ? new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : undefined;
};
const u64 = (b: Uint8Array, o: number) => u32be(b, o) * 2 ** 32 + u32be(b, o + 4);

export const parseIso6709 = (s: string): { lat: number; lon: number; altitude?: number } | undefined => {
  const m = /^\s*([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)(?:([+-]\d+(?:\.\d+)?)CRS\w*|([+-]\d+(?:\.\d+)?))?\/?/.exec(s);
  if (!m) return undefined;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || (lat === 0 && lon === 0)) return undefined;
  const alt = m[3] ?? m[4];
  return { lat, lon, altitude: alt !== undefined ? Number(alt) : undefined };
};

const MDTA_LABELS: Record<string, string> = {
  'com.apple.quicktime.make': 'make', 'com.apple.quicktime.model': 'model', 'com.apple.quicktime.software': 'software',
  'com.apple.quicktime.creationdate': 'date', 'com.apple.quicktime.location.name': 'place', 'com.apple.quicktime.location.body': 'place',
  'com.apple.quicktime.location.ISO6709': 'gps', 'com.apple.quicktime.author': 'author', 'com.apple.quicktime.displayname': 'title',
};
const ITUNES_LABELS: Record<string, string> = {
  '©mak': 'make', '©mod': 'model', '©swr': 'software', '©too': 'software', '©day': 'date', '©xyz': 'gps',
  '©nam': 'title', '©cmt': 'comment', '©ART': 'author', '©aut': 'author', '©cpy': 'copyright', '©des': 'comment', '©alb': 'title',
};

export const parseMp4 = (b: Uint8Array): VideoInfo => {
  if (!isVideo(b)) throw new ParseError('not an MP4/MOV file');
  const budget = newBudget();
  const top = readBoxes(b, 0, b.length, budget);
  const brand = toAscii(b.subarray(8, 12));
  const info: VideoInfo = { brand, quickTime: brand === 'qt  ', width: 0, height: 0, durationSec: 0, tags: [], timedTracks: [], xmp: [], patches: [], mdat: top.filter((x) => x.type === 'mdat') };
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) throw new ParseError('no moov box (not a complete MP4/MOV)');
  const moovKids = readBoxes(b, payloadStart(moov), moov.end, budget);

  const addTag = (kind: string, key: string, value: string, source: string) => {
    value = value.replace(/\0+/g, '').trim();
    if (!value || info.tags.length >= 60) return;
    if (kind === 'gps' || /^\s*[+-]\d{1,2}(?:\.\d+)?[+-]\d{1,3}(?:\.\d+)?/.test(value)) {
      const g = parseIso6709(value);
      if (g) { info.gps ??= g; return; }
    }
    info.tags.push({ key: kind === 'other' ? key : kind, value, source });
  };

  // mvhd: creation time + duration
  const mvhd = moovKids.find((x) => x.type === 'mvhd');
  if (mvhd) {
    const p = payloadStart(mvhd), v = b[p];
    const created = v === 1 ? u64(b, p + 4) : u32be(b, p + 4);
    const scale = v === 1 ? u32be(b, p + 20) : u32be(b, p + 12);
    const dur = v === 1 ? u64(b, p + 24) : u32be(b, p + 16);
    info.created = isoFromMac(created);
    if (scale) info.durationSec = dur / scale;
    const len = v === 1 ? 16 : 8;
    if (created || (v === 1 ? u64(b, p + 12) : u32be(b, p + 8))) info.patches.push({ kind: 'zero', at: p + 4, len });
  }

  const readIlst = (meta: Box, source: string) => {
    const kids = readBoxes(b, metaChildrenStart(b, meta), meta.end, budget);
    const keys: string[] = [];
    const keysBox = kids.find((x) => x.type === 'keys');
    if (keysBox) {
      let q = payloadStart(keysBox) + 8;
      const n = u32be(b, q - 4);
      for (let i = 0; i < n && i < 500 && q + 8 <= keysBox.end; i++) {
        const sz = u32be(b, q);
        if (sz < 8 || q + sz > keysBox.end) break;
        keys.push(utf8(b.subarray(q + 8, q + sz)));
        q += sz;
      }
    }
    const ilst = kids.find((x) => x.type === 'ilst');
    if (!ilst) return;
    for (const item of readBoxes(b, payloadStart(ilst), ilst.end, budget)) {
      const data = readBoxes(b, payloadStart(item), item.end, budget).find((x) => x.type === 'data');
      if (!data) continue;
      const dp = payloadStart(data);
      if (data.end - dp < 8 || u32be(b, dp) !== 1) continue; // only UTF-8 text values
      const value = utf8(b.subarray(dp + 8, data.end));
      const idx = u32be(b, item.start + 4);
      const key = keys.length && idx >= 1 && idx <= keys.length ? keys[idx - 1] : item.type;
      const kind = MDTA_LABELS[key] ?? ITUNES_LABELS[key] ?? 'other';
      addTag(kind, key.replace(/^com\.apple\.quicktime\./, ''), value, source);
    }
  };

  const readUdta = (udta: Box, source: string) => {
    for (const k of readBoxes(b, payloadStart(udta), udta.end, budget)) {
      if (k.type === 'meta') { readIlst(k, source); continue; }
      if (k.type.charCodeAt(0) === 0xa9 || k.type === 'Xyz' || k.type === 'xyz ') {
        const p = payloadStart(k);
        if (k.end - p < 4) continue;
        const kind = ITUNES_LABELS[k.type] ?? 'other';
        addTag(kind, k.type.replace('©', ''), utf8(b.subarray(p + 4, k.end)), source);
      }
    }
  };

  // metadata containers anywhere a camera or editor puts them
  const wipe = (box: Box) => info.patches.push({ kind: 'wipe', box });
  for (const bx of top) {
    if (bx.type === 'meta') { readIlst(bx, 'meta'); wipe(bx); }
    else if (bx.type === 'uuid' && bx.end - bx.start >= 24 && XMP_UUID.every((v, i) => b[bx.start + bx.header + i] === v)) {
      info.xmp.push(utf8(b.subarray(bx.start + bx.header + 16, bx.end))); wipe(bx);
    } else if (bx.type === 'free' || bx.type === 'skip') { if (b.subarray(payloadStart(bx), bx.end).some((x) => x)) wipe(bx); }
  }
  for (const bx of moovKids) {
    if (bx.type === 'udta') { readUdta(bx, 'udta'); wipe(bx); }
    else if (bx.type === 'meta') { readIlst(bx, 'meta'); wipe(bx); }
    else if (bx.type === 'trak') {
      const kids = readBoxes(b, payloadStart(bx), bx.end, budget);
      for (const k of kids) {
        if (k.type === 'udta') { readUdta(k, 'track udta'); wipe(k); }
        else if (k.type === 'meta') { readIlst(k, 'track meta'); wipe(k); }
        else if (k.type === 'tkhd') {
          const p = payloadStart(k), v = b[p];
          const wOff = p + (v === 1 ? 88 : 76);
          const w = u16be(b, wOff), h = u16be(b, wOff + 4);
          if (w > info.width) { info.width = w; info.height = h; }
          const c = v === 1 ? u64(b, p + 4) : u32be(b, p + 4);
          if (c) info.patches.push({ kind: 'zero', at: p + 4, len: v === 1 ? 16 : 8 });
        }
      }
      for (const h of findAll(b, [bx], ['trak', 'mdia', 'hdlr'], budget)) {
        const t = toAscii(b.subarray(payloadStart(h) + 8, payloadStart(h) + 12));
        if (t === 'meta' || t === 'gps ') info.timedTracks.push(t.trim());
      }
      for (const m of findAll(b, [bx], ['trak', 'mdia', 'mdhd'], budget)) {
        const p = payloadStart(m), v = b[p];
        if ((v === 1 ? u64(b, p + 4) : u32be(b, p + 4)) || (v === 1 ? u64(b, p + 12) : u32be(b, p + 8))) info.patches.push({ kind: 'zero', at: p + 4, len: v === 1 ? 16 : 8 });
      }
    } else if (bx.type === 'free' || bx.type === 'skip') { if (b.subarray(payloadStart(bx), bx.end).some((x) => x)) wipe(bx); }
  }
  return info;
};

export const stripMp4 = (b: Uint8Array): Uint8Array => {
  const info = parseMp4(b);
  const out = b.slice();
  for (const p of info.patches) {
    if (p.kind === 'zero') { out.fill(0, p.at, p.at + p.len); continue; }
    const bx = p.box;
    out.set([0x66, 0x72, 0x65, 0x65], bx.start + 4); // 'free'
    out.fill(0, bx.start + bx.header, bx.end);
  }
  return out;
};

/** CRC over the media payload (`mdat`) so we can prove the audio/video samples were not touched. */
export const mp4ContentDigest = (b: Uint8Array): number => {
  let h = 0;
  for (const m of parseMp4(b).mdat) h = crc32(b.subarray(payloadStart(m), m.end), h);
  return h;
};
