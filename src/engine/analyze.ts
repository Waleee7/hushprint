// Turns raw parser output into plain-English findings, a risk summary, and verified clean copies.
import { crc32, startsWith, utf8 } from './bytes.ts';
import { formatCoord, formatDistance, nearestCity } from './geo.ts';
import { isJpeg, jpegSize, parseJpeg, stripJpeg } from './jpeg.ts';
import { isPng, parsePng, stripPng } from './png.ts';
import { parseTiff, type ParsedTiff, type RawEntry, type Rational } from './tiff.ts';
import { parseXmp, type XmpField } from './xmp.ts';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Category = 'location' | 'device' | 'time' | 'people' | 'software' | 'preview' | 'hidden' | 'technical';
export type Format = 'jpeg' | 'png';

export interface Finding { id: string; category: Category; severity: Severity; label: string; value: string; why: string; source: string }
export interface GpsFix { lat: number; lon: number; altitude?: number; accuracyM?: number; nearest: { name: string; km: number }[] }
export interface Thumb { bytes: Uint8Array; width?: number; height?: number; mismatch: boolean }
export interface Risk { level: Severity; headline: string; bullets: string[] }
export interface Analysis {
  name: string; size: number; format: Format; width: number; height: number; orientation: number;
  findings: Finding[]; gps?: GpsFix; thumbnail?: Thumb; risk: Risk; warnings: string[];
}
export interface CleanResult {
  bytes: Uint8Array; before: Analysis; after: Analysis;
  removed: Finding[]; verified: boolean; pixelsIdentical: boolean; orientationKept: number;
}

export class UnsupportedFormat extends Error {}

export const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
export const CATEGORY_TITLE: Record<Category, string> = {
  location: 'Where you were', device: 'What you shot it with', time: 'When', people: 'Who you are',
  software: 'Software trail', preview: 'Hidden previews & leftovers', hidden: 'Notes, captions & IDs', technical: 'Camera settings',
};

export const detectFormat = (b: Uint8Array): Format => {
  if (isJpeg(b)) return 'jpeg';
  if (isPng(b)) return 'png';
  if (startsWith(b, 4, 'ftyp')) throw new UnsupportedFormat('HEIC/HEIF is not supported yet. On iPhone choose Settings > Camera > Formats > Most Compatible, or share the photo as JPEG.');
  throw new UnsupportedFormat('Only JPEG and PNG images are supported in this version.');
};

/* -------------------------- helpers -------------------------- */
const num = (e: RawEntry | undefined, i = 0): number | undefined => {
  const v = e?.value;
  if (!Array.isArray(v)) return typeof v === 'number' ? v : undefined;
  const x = v[i];
  if (Array.isArray(x)) { const [n, d] = x as Rational; return d ? n / d : undefined; }
  return typeof x === 'number' ? x : undefined;
};
const str = (e: RawEntry | undefined): string | undefined => {
  const v = e?.value;
  if (typeof v === 'string') return v.trim() || undefined;
  if (v instanceof Uint8Array) {
    const skip = startsWith(v, 0, 'ASCII\0\0\0') || startsWith(v, 0, 'UNICODE\0') ? 8 : 0; // UserComment charset prefix
    return utf8(v.subarray(skip)).replace(/\0+/g, '').trim() || undefined;
  }
  return undefined;
};
const ucs2 = (e: RawEntry | undefined) =>
  e?.value instanceof Uint8Array ? new TextDecoder('utf-16le').decode(e.value).replace(/\0+$/, '').trim() || undefined : undefined;
const exifDate = (s: string) => s.replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3');
const trunc = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

const dms = (e: RawEntry | undefined, ref: string | undefined): number | undefined => {
  const d = num(e, 0), m = num(e, 1), s = num(e, 2);
  if (d === undefined) return undefined;
  const v = d + (m ?? 0) / 60 + (s ?? 0) / 3600;
  return ref === 'S' || ref === 'W' ? -v : v;
};

const xmpGps = (v: string): number | undefined => {
  const m = /^(\d+),(\d+(?:\.\d+)?)([NSEW])$/.exec(v.trim());
  if (!m) return undefined;
  const x = Number(m[1]) + Number(m[2]) / 60;
  return m[3] === 'S' || m[3] === 'W' ? -x : x;
};

class Collector {
  list: Finding[] = [];
  seen = new Set<string>();
  add(f: Omit<Finding, 'id'>) {
    const id = `${f.category}|${f.source}|${f.label}|${f.value}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.list.push({ ...f, id });
  }
}
type Sink = { gps?: GpsFix };

/* -------------------------- EXIF -------------------------- */
const fromTiff = (t: ParsedTiff, c: Collector, out: Sink) => {
  const { ifd0, exif, gps } = t;

  if (gps.size) {
    const lat = dms(gps.get(2), str(gps.get(1))), lon = dms(gps.get(4), str(gps.get(3)));
    if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
      let altitude = num(gps.get(6));
      if (altitude !== undefined && num(gps.get(5)) === 1) altitude = -altitude;
      const nearest = nearestCity({ lat, lon }, 3).map(({ name, km }) => ({ name, km }));
      out.gps = { lat, lon, altitude, accuracyM: num(gps.get(0x1f)), nearest };
      c.add({ category: 'location', severity: 'critical', label: 'GPS coordinates', value: formatCoord({ lat, lon }), source: 'EXIF GPS',
        why: 'Pinpoints where you were standing, usually within a few metres. If this was at home, you just shared your address.' });
      if (altitude !== undefined) c.add({ category: 'location', severity: 'high', label: 'Altitude', value: `${Math.round(altitude)} m`, source: 'EXIF GPS', why: 'Can reveal which floor of a building you were on.' });
    } else {
      c.add({ category: 'location', severity: 'high', label: 'GPS block present', value: 'unreadable or empty coordinates', source: 'EXIF GPS', why: 'A GPS section exists, so location may still be recoverable by other tools.' });
    }
    const dir = num(gps.get(0x11));
    if (dir !== undefined) c.add({ category: 'location', severity: 'medium', label: 'Camera heading', value: `${Math.round(dir)}°`, source: 'EXIF GPS', why: 'Shows which direction you were facing.' });
    const gd = str(gps.get(0x1d));
    const gtv = gps.get(7)?.value;
    const gt = Array.isArray(gtv) ? (gtv as Rational[]).map(([n, d]) => String(Math.round(n / (d || 1))).padStart(2, '0')).join(':') : undefined;
    if (gd || gt) c.add({ category: 'time', severity: 'high', label: 'GPS clock', value: `${gd ? exifDate(gd) : ''} ${gt ?? ''} UTC`.trim(), source: 'EXIF GPS', why: 'A second, satellite-accurate timestamp of the moment you were there.' });
  }

  const make = str(ifd0.get(0x10f)), model = str(ifd0.get(0x110));
  if (make || model) c.add({ category: 'device', severity: 'medium', label: 'Camera / phone', value: [make, model].filter(Boolean).join(' '), source: 'EXIF', why: 'Tells anyone which exact device model you own.' });
  const lens = str(exif.get(0xa434));
  if (lens) c.add({ category: 'device', severity: 'low', label: 'Lens', value: lens, source: 'EXIF', why: 'Further narrows down your equipment.' });
  for (const [tag, label] of [[0xa431, 'Camera serial number'], [0xa435, 'Lens serial number'], [0xa430, 'Camera owner name'], [0xa420, 'Image unique ID']] as const) {
    const v = str(exif.get(tag));
    if (!v) continue;
    const isName = tag === 0xa430, isId = tag === 0xa420;
    c.add({ category: isName ? 'people' : isId ? 'hidden' : 'device', severity: isId ? 'low' : 'high', label, value: v, source: 'EXIF',
      why: isName ? 'The name you typed into your camera settings.' : isId ? 'A unique ID that can tie photos together.' : 'A unique number that links every photo to this exact device, and to its owner if it was ever registered.' });
  }
  const mn = exif.get(0x927c);
  if (mn) c.add({ category: 'device', severity: 'medium', label: 'Maker notes', value: `${kb(mn.count)} of manufacturer-private data`, source: 'EXIF', why: 'An opaque vendor block that commonly stores serial numbers, firmware, and lens details.' });

  for (const [tag, label, ifd] of [[0x9003, 'Taken', exif], [0x9004, 'Digitized', exif], [0x132, 'File modified', ifd0]] as const) {
    const v = str(ifd.get(tag));
    if (v) c.add({ category: 'time', severity: 'medium', label, value: exifDate(v), source: 'EXIF', why: 'The exact date and time, to the second. Combined with a place it builds a timeline of your life.' });
  }
  const off = str(exif.get(0x9011));
  if (off) c.add({ category: 'time', severity: 'low', label: 'Timezone offset', value: off, source: 'EXIF', why: 'Hints at the region of the world you were in.' });

  const artist = str(ifd0.get(0x13b));
  if (artist) c.add({ category: 'people', severity: 'high', label: 'Artist / photographer', value: artist, source: 'EXIF', why: 'A name, often your real one, attached to the file.' });
  const copyright = str(ifd0.get(0x8298));
  if (copyright) c.add({ category: 'people', severity: 'medium', label: 'Copyright', value: copyright, source: 'EXIF', why: 'Often contains your full name.' });
  for (const [tag, label] of [[0x9c9d, 'Windows author'], [0x9c9c, 'Windows comment'], [0x9c9b, 'Windows title'], [0x9c9e, 'Windows keywords']] as const) {
    const v = ucs2(ifd0.get(tag));
    if (v) c.add({ category: tag === 0x9c9d ? 'people' : 'hidden', severity: tag === 0x9c9d ? 'high' : 'medium', label, value: v, source: 'EXIF', why: 'Text added through Windows file properties.' });
  }
  const desc = str(ifd0.get(0x10e)) ?? str(exif.get(0x9286));
  if (desc) c.add({ category: 'hidden', severity: 'medium', label: 'Description / comment', value: trunc(desc), source: 'EXIF', why: 'Free text that travels with the photo and is easy to forget about.' });
  const sw = str(ifd0.get(0x131));
  if (sw) c.add({ category: 'software', severity: 'low', label: 'Software', value: sw, source: 'EXIF', why: 'Shows what you edited or created the file with.' });

  const tech: string[] = [];
  const et = num(exif.get(0x829a)), fn = num(exif.get(0x829d)), iso = num(exif.get(0x8827)), fl = num(exif.get(0x920a));
  if (et) tech.push(et < 1 ? `1/${Math.round(1 / et)}s` : `${et}s`);
  if (fn) tech.push(`f/${fn.toFixed(1)}`);
  if (iso) tech.push(`ISO ${iso}`);
  if (fl) tech.push(`${fl.toFixed(0)} mm`);
  if (tech.length) c.add({ category: 'technical', severity: 'info', label: 'Exposure', value: tech.join('  '), source: 'EXIF', why: 'Harmless alone, but part of a device fingerprint.' });
  const o = num(ifd0.get(0x112));
  if (o) c.add({ category: 'technical', severity: 'info', label: 'Orientation', value: `${o}${o > 1 ? ' (rotated)' : ''}`, source: 'EXIF', why: 'Kept on purpose, so your photo does not turn sideways.' });
};

/* -------------------------- XMP -------------------------- */
const fromXmp = (fields: XmpField[], c: Collector, out: Sink) => {
  let lat: number | undefined, lon: number | undefined;
  for (const { key, value } of fields) {
    const k = key.split(':')[1];
    const add = (category: Category, severity: Severity, why: string) => c.add({ category, severity, label: key, value: trunc(value), source: 'XMP', why });
    if (key === 'exif:GPSLatitude') lat = xmpGps(value);
    else if (key === 'exif:GPSLongitude') lon = xmpGps(value);
    else if (/^(photoshop:(City|State|Country|Location)|Iptc4xmpCore:(Location|CountryCode)|Iptc4xmpExt:(LocationShown|Sublocation))/.test(key)) add('location', 'high', 'A named place attached to the photo.');
    else if (/SerialNumber$/.test(k)) add('device', 'high', 'A unique number that links this photo to your exact device.');
    else if (/^(tiff:(Make|Model)|aux:Lens$|aux:LensInfo)/.test(key)) add('device', 'medium', 'Identifies your device model.');
    else if (key === 'xmp:CreatorTool' || /softwareAgent$/.test(key)) add('software', 'low', 'Shows what software touched this file.');
    else if (key === 'mwg-rs:Name' || /^Iptc4xmpExt:PersonInImage/.test(key)) add('people', 'high', 'The name of a person tagged in this photo (face region).');
    else if (/^(dc:creator|photoshop:Credit|Iptc4xmpCore:CreatorContactInfo|xmpRights:Owner|plus:|aux:OwnerName)/.test(key)) add('people', 'high', 'A name or contact attached to the file.');
    else if (/^(dc:rights|xmpRights:)/.test(key)) add('people', 'medium', 'Copyright text, often a full name.');
    else if (/^(xmp:(CreateDate|ModifyDate|MetadataDate)|photoshop:DateCreated|exif:DateTime)/.test(key)) add('time', 'medium', 'A timestamp inside the XMP block.');
    else if (/^(dc:(title|description|subject)|photoshop:Headline|lr:hierarchicalSubject)/.test(key)) add('hidden', 'medium', 'Title, caption or keywords carried inside the file.');
    else if (/^(xmpMM:(DocumentID|InstanceID|OriginalDocumentID)|photoshop:History)/.test(key)) add('hidden', 'low', 'An ID that can link edited copies of the same file.');
  }
  if (lat !== undefined && lon !== undefined && !out.gps) {
    out.gps = { lat, lon, nearest: nearestCity({ lat, lon }, 3).map(({ name, km }) => ({ name, km })) };
    c.add({ category: 'location', severity: 'critical', label: 'GPS coordinates (XMP)', value: formatCoord({ lat, lon }), source: 'XMP', why: 'Pinpoints where you were standing, usually within a few metres.' });
  }
};

/* -------------------------- risk summary -------------------------- */
const summarize = (f: Finding[], gps: GpsFix | undefined, thumb: Thumb | undefined): Risk => {
  const has = (cat: Category, min: Severity = 'low') => f.some((x) => x.category === cat && RANK[x.severity] >= RANK[min]);
  const level = f.reduce<Severity>((m, x) => (RANK[x.severity] > RANK[m] && x.label !== 'Orientation' ? x.severity : m), 'info');
  const bullets: string[] = [];
  if (gps) {
    const n = gps.nearest[0];
    bullets.push(`Exactly where it was taken: ${formatCoord(gps)}${n ? `, ${formatDistance(n.km)} from ${n.name}` : ''}. If that was your home, the photo gives away your address.`);
  } else if (has('location')) bullets.push('Contains named place information (city, region or country).');
  if (f.some((x) => /serial/i.test(x.label))) bullets.push('Carries a serial number that links every photo to your exact device.');
  const person = f.find((x) => x.category === 'people' && RANK[x.severity] >= 3);
  if (person) bullets.push(`Names a person: ${person.value}.`);
  if (thumb) bullets.push(thumb.mismatch ? 'Includes a hidden preview that does NOT match the photo, so it may still show what you cropped out.' : 'Includes a hidden thumbnail copy of the photo.');
  if (f.some((x) => x.label.startsWith('Hidden data'))) bullets.push('Has extra data tacked on after the image ends, which can hide an uncropped original.');
  if (has('time', 'medium')) bullets.push('Records the exact date and time, down to the second.');
  const dev = f.find((x) => x.label === 'Camera / phone');
  if (dev) bullets.push(`Reveals the device: ${dev.value}.`);
  if (has('hidden', 'medium')) bullets.push('Carries captions, keywords or comments you may not know about.');
  const headline = gps ? 'This photo reveals where it was taken.'
    : level === 'critical' || level === 'high' ? 'This file reveals who you are.'
    : level === 'medium' ? 'This file reveals your device and timing.'
    : level === 'low' ? 'Minor traces found.'
    : 'No identifying metadata found.';
  return { level, headline, bullets };
};

/* -------------------------- public API -------------------------- */
export const analyze = async (bytes: Uint8Array, name = 'file'): Promise<Analysis> => {
  const format = detectFormat(bytes);
  const c = new Collector();
  const out: Sink = {};
  const warnings: string[] = [];
  let width = 0, height = 0, tiff: ParsedTiff | undefined, orientation = 1;
  let trailing = 0, trailingJpeg = false;
  let thumb: Thumb | undefined;
  const readTiff = (b: Uint8Array) => { try { tiff = parseTiff(b); } catch (e) { warnings.push(`EXIF block could not be read fully (${(e as Error).message}).`); } };

  if (format === 'jpeg') {
    const j = parseJpeg(bytes);
    ({ width, height } = j);
    if (j.exif) readTiff(j.exif);
    j.xmp.forEach((x) => fromXmp(parseXmp(x), c, out));
    for (const { key, value } of j.iptc) {
      const loc = /^(City|State|Country|Sublocation)$/.test(key), person = /^(Photographer|Credit|Caption writer)/.test(key);
      c.add({ category: loc ? 'location' : person ? 'people' : /date/i.test(key) ? 'time' : 'hidden', severity: loc || person ? 'high' : 'medium', label: key, value: trunc(value), source: 'IPTC', why: loc ? 'A named place typed into the photo.' : person ? 'A person or agency named in the photo metadata.' : 'Caption-style text carried inside the file.' });
    }
    j.comments.forEach((t) => c.add({ category: 'hidden', severity: 'medium', label: 'JPEG comment', value: trunc(t.trim()), source: 'COM', why: 'Free text stored by the software that saved this file.' }));
    trailing = j.trailing.length; trailingJpeg = j.trailing.startsWithJpeg;
  } else {
    const p = await parsePng(bytes);
    ({ width, height } = p);
    if (p.exif) readTiff(p.exif);
    p.xmp.forEach((x) => fromXmp(parseXmp(x), c, out));
    for (const t of p.text) {
      const k = t.keyword;
      const ai = /^(parameters|prompt|workflow|dream|sd-metadata|invokeai)/i.test(k);
      const cat: Category = /^(author|artist)$/i.test(k) ? 'people' : /^software$/i.test(k) ? 'software' : /(time|date)/i.test(k) ? 'time' : 'hidden';
      const sev: Severity = cat === 'people' ? 'high' : cat === 'software' ? 'low' : ai || /^(comment|description|title|copyright)$/i.test(k) || cat === 'time' ? 'medium' : 'low';
      c.add({ category: cat, severity: sev, label: ai ? `AI prompt / settings (${k})` : `Text: ${k}`, value: trunc(t.text.replace(/\s+/g, ' ')), source: 'PNG text', why: ai ? 'Image generators save your full prompt and settings inside the file.' : 'A text note stored in a PNG chunk.' });
    }
    if (p.modified) c.add({ category: 'time', severity: 'low', label: 'Last modified (tIME)', value: p.modified, source: 'PNG tIME', why: 'When the file was last saved.' });
    trailing = p.trailing.length;
  }

  const t = tiff as ParsedTiff | undefined;
  if (t) {
    fromTiff(t, c, out);
    t.warnings.forEach((w) => warnings.push(`EXIF: ${w}`));
    orientation = num(t.ifd0.get(0x112)) ?? 1;
    if (t.thumbnail) {
      const dim = jpegSize(t.thumbnail);
      const r = (w: number, h: number) => w / h;
      const mismatch = !!dim && !!width && Math.abs(r(dim.width, dim.height) - r(width, height)) / r(width, height) > 0.03;
      thumb = { bytes: t.thumbnail, width: dim?.width, height: dim?.height, mismatch };
      c.add({ category: 'preview', severity: mismatch ? 'high' : 'medium', label: mismatch ? 'Embedded thumbnail (different shape)' : 'Embedded thumbnail',
        value: `${dim ? `${dim.width}×${dim.height}, ` : ''}${kb(t.thumbnail.length)}`, source: 'EXIF IFD1',
        why: mismatch ? 'This hidden preview has a different shape than the photo, so it was probably made before you cropped. It can still show what you cut out.' : 'A small hidden copy of the photo. Editors that crop or paint over the image often forget to update it.' });
    }
  }
  if (trailing > 0) {
    c.add({ category: 'preview', severity: format === 'png' || trailingJpeg ? 'high' : 'medium', label: 'Hidden data after the image', value: `${kb(trailing)} appended`, source: format === 'png' ? 'after IEND' : 'after EOI',
      why: format === 'png' ? 'Extra bytes after the PNG ends. Some editors (the "aCropalypse" bug) leave the uncropped original here.' : trailingJpeg ? 'A complete second JPEG is attached after the first (HDR map, motion photo, or an uncropped original).' : 'Extra bytes after the JPEG ends.' });
  }
  const sorted = c.list.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return { name, size: bytes.length, format, width, height, orientation, findings: sorted, gps: out.gps, thumbnail: thumb, warnings, risk: summarize(sorted, out.gps, thumb) };
};

/** CRC of the actual pixel stream, to prove stripping did not touch the image. */
export const pixelDigest = async (bytes: Uint8Array): Promise<number> => {
  let h = 0;
  if (isJpeg(bytes)) {
    for (const p of parseJpeg(bytes).pieces) if (p.kind === 'raw' || [0xc0, 0xc1, 0xc2, 0xc4, 0xda, 0xdb].includes(p.marker)) h = crc32(bytes.subarray(p.start, p.end), h);
    return h;
  }
  for (const ch of (await parsePng(bytes)).chunks) if (['IHDR', 'PLTE', 'IDAT', 'fdAT'].includes(ch.type)) h = crc32(bytes.subarray(ch.start, ch.end), h);
  return h;
};

const KEPT_ON_PURPOSE = (f: Finding) => f.label === 'Orientation';

export const clean = async (bytes: Uint8Array, name = 'file', opts: { keepOrientation?: boolean } = {}): Promise<CleanResult> => {
  const before = await analyze(bytes, name);
  const orientation = opts.keepOrientation === false ? 1 : before.orientation;
  const cleaned = before.format === 'jpeg' ? stripJpeg(bytes, { orientation }) : await stripPng(bytes, { orientation });
  const after = await analyze(cleaned, name);
  const pixelsIdentical = (await pixelDigest(bytes)) === (await pixelDigest(cleaned));
  const leftovers = after.findings.filter((f) => !KEPT_ON_PURPOSE(f));
  return {
    bytes: cleaned, before, after, pixelsIdentical, orientationKept: orientation,
    removed: before.findings.filter((f) => !KEPT_ON_PURPOSE(f)),
    verified: leftovers.length === 0 && pixelsIdentical && after.width === before.width && after.height === before.height,
  };
};
