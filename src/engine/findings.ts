// Shared building blocks: finding collector, EXIF/XMP interpretation, and the plain-English risk summary.
import { startsWith, utf8 } from './bytes.ts';
import { formatCoord, formatDistance, nearestCity } from './geo.ts';
import { MAX_FINDINGS } from './limits.ts';
import type { RawEntry, Rational, ParsedTiff } from './tiff.ts';
import type { XmpField } from './xmp.ts';
import type { Category, Finding, GpsFix, Risk, Severity, Thumb } from './types.ts';
import { RANK } from './types.ts';

/* -------------------------- helpers -------------------------- */
export const num = (e: RawEntry | undefined, i = 0): number | undefined => {
  const v = e?.value;
  if (!Array.isArray(v)) return typeof v === 'number' ? v : undefined;
  const x = v[i];
  if (Array.isArray(x)) { const [n, d] = x as Rational; return d ? n / d : undefined; }
  return typeof x === 'number' ? x : undefined;
};
export const str = (e: RawEntry | undefined): string | undefined => {
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
export const exifDate = (s: string) => s.replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3');
export const trunc = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);
export const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

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

export class Collector {
  list: Finding[] = [];
  seen = new Set<string>();
  truncated = false;
  add(f: Omit<Finding, 'id'>) {
    if (this.list.length >= MAX_FINDINGS) { this.truncated = true; return; }
    const id = `${f.category}|${f.source}|${f.label}|${f.value}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.list.push({ ...f, id });
  }
}
export type Sink = { gps?: GpsFix };

/* -------------------------- EXIF -------------------------- */
export const fromTiff = (t: ParsedTiff, c: Collector, out: Sink) => {
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
export const fromXmp = (fields: XmpField[], c: Collector, out: Sink) => {
  let lat: number | undefined, lon: number | undefined;
  for (const { key, value } of fields) {
    const k = key.split(':')[1];
    const add = (category: Category, severity: Severity, why: string) => c.add({ category, severity, label: key, value: trunc(value), source: 'XMP', why });
    if (key === 'exif:GPSLatitude') lat = xmpGps(value);
    else if (key === 'exif:GPSLongitude') lon = xmpGps(value);
    else if (/^(photoshop:(City|State|Country|Location)|Iptc4xmpCore:(Location|CountryCode)|Iptc4xmpExt:(LocationShown|Sublocation))/.test(key)) add('location', 'high', 'A named place attached to the photo.');
    else if (/SerialNumber$/.test(k)) add('device', 'high', 'A unique number that links this photo to your exact device.');
    else if (/^(tiff:(Make|Model)|aux:Lens$|aux:LensInfo)/.test(key)) add('device', 'medium', 'Identifies your device model.');
    else if (key === 'xmp:CreatorTool' || key === 'pdf:Producer' || /softwareAgent$/.test(key)) add('software', 'low', 'Shows what software touched this file.');
    else if (key === 'mwg-rs:Name' || /^Iptc4xmpExt:PersonInImage/.test(key)) add('people', 'high', 'The name of a person tagged in this photo (face region).');
    else if (/^(dc:creator|photoshop:Credit|Iptc4xmpCore:CreatorContactInfo|xmpRights:Owner|plus:|aux:OwnerName)/.test(key)) add('people', 'high', 'A name or contact attached to the file.');
    else if (/^(dc:rights|xmpRights:)/.test(key)) add('people', 'medium', 'Copyright text, often a full name.');
    else if (/^(xmp:(CreateDate|ModifyDate|MetadataDate)|photoshop:DateCreated|exif:DateTime)/.test(key)) add('time', 'medium', 'A timestamp inside the XMP block.');
    else if (/^(dc:(title|description|subject)|pdf:Keywords|photoshop:Headline|lr:hierarchicalSubject)/.test(key)) add('hidden', 'medium', 'Title, caption or keywords carried inside the file.');
    else if (/^(xmpMM:(DocumentID|InstanceID|OriginalDocumentID)|photoshop:History)/.test(key)) add('hidden', 'low', 'An ID that can link edited copies of the same file.');
  }
  if (lat !== undefined && lon !== undefined && !out.gps) {
    out.gps = { lat, lon, nearest: nearestCity({ lat, lon }, 3).map(({ name, km }) => ({ name, km })) };
    c.add({ category: 'location', severity: 'critical', label: 'GPS coordinates (XMP)', value: formatCoord({ lat, lon }), source: 'XMP', why: 'Pinpoints where you were standing, usually within a few metres.' });
  }
};

/* -------------------------- risk summary -------------------------- */
export const summarize = (f: Finding[], gps: GpsFix | undefined, thumb: Thumb | undefined): Risk => {
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
  const headline = gps ? 'This file reveals where it was taken.'
    : level === 'critical' || level === 'high' ? 'This file reveals who you are.'
    : level === 'medium' ? 'This file reveals your device and timing.'
    : level === 'low' ? 'Minor traces found.'
    : 'No identifying metadata found.';
  return { level, headline, bullets };
};

