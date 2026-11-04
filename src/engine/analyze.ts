// Public engine API: detect a file's format, report everything it leaks, and produce a verified clean copy.
import { crc32 } from './bytes.ts';
import { Collector, type Sink, fromTiff, fromXmp, kb, num, summarize, trunc } from './findings.ts';
import { formatCoord, nearestCity } from './geo.ts';
import { isAvif, isHeic, parseHeic } from './heic.ts';
import { isJpeg, jpegSize, parseJpeg, stripJpeg } from './jpeg.ts';
import { MAX_FILE_BYTES } from './limits.ts';
import { isVideo, mp4ContentDigest, parseMp4, stripMp4 } from './mp4.ts';
import { detectOffice, officeContentDigest, parseOffice, stripOffice } from './office.ts';
import { isPdf, parsePdf, pdfContentDigest, prettyPdfDate, stripPdf } from './pdf.ts';
import { isPng, parsePng, stripPng } from './png.ts';
import { privacyScore } from './score.ts';
import { parseTiff, type ParsedTiff } from './tiff.ts';
import { type Analysis, type Category, type CleanResult, type Finding, type Format, type Severity, FORMAT_LABEL, NeedsReencode, RANK, UnsupportedFormat } from './types.ts';
import { isWebp, parseWebp, stripWebp, webpPixelDigestRanges } from './webp.ts';
import { parseXmp } from './xmp.ts';

export { CATEGORY_TITLE, FORMAT_LABEL, NeedsReencode, RANK, UnsupportedFormat } from './types.ts';
export type { Analysis, Category, CleanResult, Finding, Format, GpsFix, Risk, Severity, Thumb } from './types.ts';

/** Browser-side re-encoder (canvas). Injected so the engine stays DOM-free and testable. */
export type Rasterizer = (bytes: Uint8Array, from: Format) => Promise<{ bytes: Uint8Array }>;
export interface CleanOptions { keepOrientation?: boolean; rasterize?: Rasterizer }

const SUPPORTED = 'Hushprint reads JPEG, PNG, WebP, HEIC, PDF, DOCX, XLSX, PPTX and MP4/MOV.';

export const detectFormat = (b: Uint8Array): Format => {
  if (isJpeg(b)) return 'jpeg';
  if (isPng(b)) return 'png';
  if (isWebp(b)) return 'webp';
  if (isAvif(b)) throw new UnsupportedFormat(`AVIF is not supported yet. ${SUPPORTED}`);
  if (isHeic(b)) return 'heic';
  if (isVideo(b)) return 'mp4';
  if (isPdf(b)) return 'pdf';
  const office = detectOffice(b);
  if (office) return office;
  throw new UnsupportedFormat(`This file type is not supported. ${SUPPORTED}`);
};

const READS_PIXELS = new Set<Format>(['jpeg', 'png', 'webp']);

/* ------------------------------ per-format readers ------------------------------ */
interface Common { width: number; height: number; tiff?: ParsedTiff; trailing: number; trailingJpeg: boolean; detail?: string }
type Ctx = { c: Collector; out: Sink; warnings: string[] };

const readTiffInto = (ctx: Ctx, tiffBytes: Uint8Array | undefined): ParsedTiff | undefined => {
  if (!tiffBytes) return undefined;
  try { return parseTiff(tiffBytes); } catch (e) { ctx.warnings.push(`EXIF block could not be read fully (${(e as Error).message}).`); return undefined; }
};
const addXmp = (ctx: Ctx, list: string[]) => { const budget = { left: 1024 * 1024 }; list.forEach((x) => fromXmp(parseXmp(x, budget), ctx.c, ctx.out)); };

const readJpeg = (b: Uint8Array, ctx: Ctx): Common => {
  const { c } = ctx;
  const j = parseJpeg(b);
  const tiff = readTiffInto(ctx, j.exif);
  addXmp(ctx, j.xmp);
  for (const { key, value } of j.iptc) {
    const loc = /^(City|State|Country|Sublocation)$/.test(key), person = /^(Photographer|Credit|Caption writer)/.test(key);
    c.add({ category: loc ? 'location' : person ? 'people' : /date/i.test(key) ? 'time' : 'hidden', severity: loc || person ? 'high' : 'medium', label: key, value: trunc(value), source: 'IPTC', why: loc ? 'A named place typed into the photo.' : person ? 'A person or agency named in the photo metadata.' : 'Caption-style text carried inside the file.' });
  }
  j.comments.forEach((t) => c.add({ category: 'hidden', severity: 'medium', label: 'JPEG comment', value: trunc(t.trim()), source: 'COM', why: 'Free text stored by the software that saved this file.' }));
  return { width: j.width, height: j.height, tiff, trailing: j.trailing.length, trailingJpeg: j.trailing.startsWithJpeg };
};

const readPng = async (b: Uint8Array, ctx: Ctx): Promise<Common> => {
  const { c } = ctx;
  const p = await parsePng(b);
  const tiff = readTiffInto(ctx, p.exif);
  addXmp(ctx, p.xmp);
  for (const t of p.text) {
    const k = t.keyword;
    const ai = /^(parameters|prompt|workflow|dream|sd-metadata|invokeai)/i.test(k);
    const cat: Category = /^(author|artist)$/i.test(k) ? 'people' : /^software$/i.test(k) ? 'software' : /(time|date)/i.test(k) ? 'time' : 'hidden';
    const sev: Severity = cat === 'people' ? 'high' : cat === 'software' ? 'low' : ai || /^(comment|description|title|copyright)$/i.test(k) || cat === 'time' ? 'medium' : 'low';
    c.add({ category: cat, severity: sev, label: ai ? `AI prompt / settings (${k})` : `Text: ${k}`, value: trunc(t.text.replace(/\s+/g, ' ')), source: 'PNG text', why: ai ? 'Image generators save your full prompt and settings inside the file.' : 'A text note stored in a PNG chunk.' });
  }
  if (p.modified) c.add({ category: 'time', severity: 'low', label: 'Last modified (tIME)', value: p.modified, source: 'PNG tIME', why: 'When the file was last saved.' });
  return { width: p.width, height: p.height, tiff, trailing: p.trailing.length, trailingJpeg: false };
};

const readWebp = (b: Uint8Array, ctx: Ctx): Common => {
  const w = parseWebp(b);
  const tiff = readTiffInto(ctx, w.exif);
  addXmp(ctx, w.xmp);
  return { width: w.width, height: w.height, tiff, trailing: w.trailing.length, trailingJpeg: false, detail: w.animated ? 'animated' : undefined };
};

const readHeic = (b: Uint8Array, ctx: Ctx): Common => {
  const h = parseHeic(b);
  const tiff = readTiffInto(ctx, h.exif);
  addXmp(ctx, h.xmp);
  if (!h.exif && !h.xmp.length) ctx.warnings.push('No EXIF or XMP item was found in this HEIC file.');
  return { width: h.width, height: h.height, tiff, trailing: 0, trailingJpeg: false, detail: h.brand.trim() };
};

const PDF_INFO: Record<string, [Category, Severity, string, string]> = {
  Author: ['people', 'high', 'Author', 'The name of whoever created the file, often your real name or work username.'],
  Creator: ['software', 'low', 'Created with', 'The application that made the original document.'],
  Producer: ['software', 'low', 'Produced by', 'The tool that wrote the PDF, often with its exact version.'],
  Title: ['hidden', 'medium', 'Title', 'A title stored in the file properties, which may differ from what the page shows.'],
  Subject: ['hidden', 'medium', 'Subject', 'A subject line stored in the file properties.'],
  Keywords: ['hidden', 'medium', 'Keywords', 'Keywords stored in the file properties.'],
  CreationDate: ['time', 'medium', 'Created', 'When the document was first made.'],
  ModDate: ['time', 'medium', 'Last modified', 'When the document was last saved.'],
};

const readPdf = async (b: Uint8Array, ctx: Ctx): Promise<Common> => {
  const { c } = ctx;
  const p = await parsePdf(b);
  const stuck = p.infoInObjStm;
  const NOTE = ' Hushprint cannot remove this one: it sits in a compressed object stream and removing it would mean rewriting the PDF.';
  for (const f of p.info) {
    const known = PDF_INFO[f.key];
    const value = /Date$/.test(f.key) ? prettyPdfDate(f.value) : f.value;
    c.add({ category: known?.[0] ?? 'hidden', severity: known?.[1] ?? 'medium', label: known?.[2] ?? `Custom property: ${f.key}`, value: trunc(value), source: 'PDF Info',
      why: (known?.[3] ?? 'A custom field stored in the PDF document properties.') + (stuck ? NOTE : ''), removable: stuck ? false : undefined });
  }
  addXmp(ctx, p.xmp);
  if (p.encrypted) {
    c.add({ category: 'hidden', severity: 'medium', label: 'Encrypted PDF', value: 'document properties cannot be read', source: 'PDF', removable: false,
      why: 'The strings in this file are encrypted, so Hushprint can neither read nor safely change them. Remove the password in your PDF app first.' });
  }
  if (p.xmpUnreadable) c.add({ category: 'hidden', severity: 'medium', label: 'XMP metadata in an unsupported encoding', value: `${p.xmpUnreadable} stream${p.xmpUnreadable > 1 ? 's' : ''}`, source: 'PDF XMP', removable: false, why: 'Hushprint could not decode this metadata stream, so it can neither show nor blank it.' });
  if (p.savedRevisions > 0) c.add({ category: 'preview', severity: 'medium', label: 'Earlier saved versions', value: `up to ${p.savedRevisions} older revision${p.savedRevisions > 1 ? 's' : ''}`, source: 'PDF', removable: false,
    why: 'Saving a PDF as an incremental update keeps older pages and text inside the file. A redaction or deletion made in a later save can sometimes be undone. Print to a new PDF to flatten it.' });
  if (p.trailingBytes) c.add({ category: 'preview', severity: 'medium', label: 'Hidden data after the end', value: `${kb(p.trailingBytes)} after %%EOF`, source: 'after %%EOF', removable: false, why: 'Extra bytes after the PDF ends. Hushprint does not cut them because that changes the file length.' });
  let reported = 0;
  for (const img of p.jpegImages) {
    if (reported >= 3 || img.end - img.start > 64 * 1024 * 1024) continue;
    try {
      const j = parseJpeg(b.subarray(img.start, img.end));
      const t = j.exif && parseTiff(j.exif);
      if (!t) continue;
      const tmp = new Collector(), sink: Sink = {};
      fromTiff(t, tmp, sink);
      const hot = tmp.list.filter((f) => f.category === 'location' || /serial|owner/i.test(f.label));
      if (!hot.length) continue;
      reported++;
      for (const f of hot) c.add({ ...f, label: `Embedded photo: ${f.label}`, source: `PDF image ${img.num}`, removable: false, why: `${f.why} This lives inside a photo embedded in the PDF; Hushprint cannot change embedded images.` });
      if (sink.gps && !ctx.out.gps) ctx.out.gps = sink.gps;
    } catch { /* an embedded image that does not parse is not our concern */ }
  }
  return { width: 0, height: 0, trailing: 0, trailingJpeg: false, detail: `PDF ${p.version}${p.linearized ? ' · linearized' : ''}` };
};

const OFFICE_PROP: Record<string, [Category, Severity, string]> = {
  'Author': ['people', 'high', 'The person who created the document, usually your real name or work login.'],
  'Last modified by': ['people', 'high', 'The last person who saved it. Often a different name from the author.'],
  'Company': ['people', 'high', 'The organisation name your copy of Office is registered to.'],
  'Manager': ['people', 'high', 'A manager name stored in the document properties.'],
  'Created': ['time', 'medium', 'When the document was first made.'],
  'Modified': ['time', 'medium', 'When the document was last saved.'],
  'Last printed': ['time', 'medium', 'When someone last printed it.'],
  'Revision': ['time', 'low', 'How many times the document has been saved.'],
  'Total editing time (min)': ['time', 'low', 'Minutes spent editing it, which says how much effort went into it.'],
  'Application': ['software', 'low', 'The Office program that saved the file.'],
  'App version': ['software', 'low', 'The exact version of that program.'],
  'Template': ['software', 'medium', 'The template used, sometimes a file path that includes a user name.'],
  'Hyperlink base': ['hidden', 'medium', 'A base address that can point at an internal server or folder.'],
  'Title': ['hidden', 'medium', 'A title stored in the file properties.'],
  'Subject': ['hidden', 'medium', 'A subject stored in the file properties.'],
  'Keywords': ['hidden', 'medium', 'Keywords stored in the file properties.'],
  'Comments': ['hidden', 'medium', 'A description stored in the file properties.'],
  'Category': ['hidden', 'medium', 'A category stored in the file properties.'],
  'Status': ['hidden', 'medium', 'A status label such as "Draft" or "Final".'],
};

const readOffice = async (b: Uint8Array, ctx: Ctx): Promise<Common> => {
  const { c } = ctx;
  const o = await parseOffice(b);
  for (const p of o.props) {
    if (p.key === 'Document security') continue;
    const known = OFFICE_PROP[p.key];
    const sensitivity = p.source === 'custom' && /^MSIP_Label/i.test(p.key);
    c.add({ category: known?.[0] ?? 'hidden', severity: known?.[1] ?? 'medium', label: p.source === 'custom' ? `Custom property: ${p.key}` : p.key,
      value: trunc(/^(Created|Modified|Last printed)$/.test(p.key) ? p.value.replace('T', ' ').replace(/Z$/, ' UTC') : p.value),
      source: `docProps/${p.source}.xml`, why: known?.[2] ?? (sensitivity ? 'A Microsoft Purview sensitivity label. It can include your organisation\'s tenant ID.' : 'A custom property saved with the document, often by a company template or compliance tool.') });
  }
  if (o.hasThumbnail) c.add({ category: 'preview', severity: 'medium', label: 'Document thumbnail', value: 'preview image of the first page', source: 'docProps/thumbnail', why: 'A small picture of the first page travels inside the file and can show text you later changed.' });
  if (o.bodyAuthors.length) c.add({ category: 'people', severity: 'high', label: o.kind === 'pptx' ? 'Comment authors' : 'Tracked changes and comment authors', value: o.bodyAuthors.slice(0, 6).join(', ') + (o.bodyAuthors.length > 6 ? '…' : ''), source: 'document body', removable: false,
    why: 'These names are part of the document content, not its properties. Accept or delete the tracked changes and comments in Office, then run Hushprint again.' });
  for (const path of o.absPaths) c.add({ category: 'people', severity: 'high', label: 'Saved file path', value: trunc(path), source: 'xl/workbook.xml', removable: false, why: 'Excel stores the full folder path of the original file, which usually contains your user name. Hushprint cannot change workbook content.' });
  return { width: 0, height: 0, trailing: 0, trailingJpeg: false, detail: undefined };
};

const readVideo = (b: Uint8Array, ctx: Ctx): Common => {
  const { c, out } = ctx;
  const v = parseMp4(b);
  const src = v.quickTime ? 'QuickTime' : 'MP4';
  if (v.gps) {
    const nearest = nearestCity(v.gps, 3).map(({ name, km }) => ({ name, km }));
    out.gps = { ...v.gps, nearest };
    c.add({ category: 'location', severity: 'critical', label: 'GPS coordinates', value: formatCoord(v.gps), source: `${src} location tag`, why: 'Pinpoints where the video was recorded, usually within a few metres. If this was at home, you just shared your address.' });
    if (v.gps.altitude !== undefined) c.add({ category: 'location', severity: 'high', label: 'Altitude', value: `${Math.round(v.gps.altitude)} m`, source: `${src} location tag`, why: 'Can reveal which floor of a building you were on.' });
  }
  const tag = (k: string) => v.tags.find((t) => t.key === k);
  const device = [tag('make')?.value, tag('model')?.value].filter(Boolean).join(' ');
  if (device) c.add({ category: 'device', severity: 'medium', label: 'Camera / phone', value: device, source: `${src} tags`, why: 'Tells anyone which exact device model recorded this.' });
  const sw = tag('software'); if (sw) c.add({ category: 'software', severity: 'low', label: 'Software', value: sw.value, source: `${src} tags`, why: 'Shows what recorded or edited the video.' });
  const date = tag('date'); if (date) c.add({ category: 'time', severity: 'medium', label: 'Recorded', value: date.value, source: `${src} tags`, why: 'The date and time the video was recorded.' });
  if (v.created) c.add({ category: 'time', severity: 'medium', label: 'Created (movie header)', value: v.created, source: 'mvhd', why: 'A creation time stored in the file header, separate from any tag.' });
  for (const t of v.tags) {
    if (['make', 'model', 'software', 'date'].includes(t.key)) continue;
    const place = t.key === 'place', who = t.key === 'author' || t.key === 'copyright';
    c.add({ category: place ? 'location' : who ? 'people' : 'hidden', severity: place || t.key === 'author' ? 'high' : t.key === 'other' ? 'low' : 'medium',
      label: place ? 'Place name' : t.key === 'author' ? 'Author' : t.key === 'copyright' ? 'Copyright' : t.key === 'title' ? 'Title' : t.key === 'comment' ? 'Comment' : `Tag: ${t.key}`,
      value: trunc(t.value), source: `${src} ${t.source}`, why: place ? 'A named place attached by the phone.' : who ? 'A name stored in the video tags.' : 'Text carried inside the video file.' });
  }
  addXmp(ctx, v.xmp);
  if (v.timedTracks.length) c.add({ category: 'location', severity: 'medium', label: 'Timed metadata track', value: `${v.timedTracks.length} track${v.timedTracks.length > 1 ? 's' : ''} (${[...new Set(v.timedTracks)].join(', ')})`, source: 'trak', removable: false,
    why: 'A track of per-moment data, as used by action cameras and dashcams, can hold a GPS position for every second. Hushprint cannot remove a track without re-muxing the video.' });
  const dur = v.durationSec ? `${Math.floor(v.durationSec / 60)}:${String(Math.round(v.durationSec % 60)).padStart(2, '0')}` : '';
  return { width: v.width, height: v.height, trailing: 0, trailingJpeg: false, detail: [v.quickTime ? 'MOV' : 'MP4', dur].filter(Boolean).join(' · ') };
};

/* ------------------------------ analyze ------------------------------ */
export const analyze = async (bytes: Uint8Array, name = 'file'): Promise<Analysis> => {
  if (bytes.length > MAX_FILE_BYTES) throw new UnsupportedFormat(`This file is larger than the ${MAX_FILE_BYTES / 1048576} MB limit.`);
  const format = detectFormat(bytes);
  const ctx: Ctx = { c: new Collector(), out: {}, warnings: [] };
  const { c, out, warnings } = ctx;

  const r: Common = format === 'jpeg' ? readJpeg(bytes, ctx)
    : format === 'png' ? await readPng(bytes, ctx)
    : format === 'webp' ? readWebp(bytes, ctx)
    : format === 'heic' ? readHeic(bytes, ctx)
    : format === 'pdf' ? await readPdf(bytes, ctx)
    : format === 'mp4' ? readVideo(bytes, ctx)
    : await readOffice(bytes, ctx);

  let orientation = 1, thumb: Analysis['thumbnail'];
  const t = r.tiff;
  if (t) {
    fromTiff(t, c, out);
    t.warnings.forEach((w) => warnings.push(`EXIF: ${w}`));
    orientation = num(t.ifd0.get(0x112)) ?? 1;
    if (t.thumbnail) {
      const dim = jpegSize(t.thumbnail);
      const ratio = (w: number, h: number) => w / h;
      const mismatch = !!dim && !!r.width && Math.abs(ratio(dim.width, dim.height) - ratio(r.width, r.height)) / ratio(r.width, r.height) > 0.03;
      thumb = { bytes: t.thumbnail, width: dim?.width, height: dim?.height, mismatch };
      c.add({ category: 'preview', severity: mismatch ? 'high' : 'medium', label: mismatch ? 'Embedded thumbnail (different shape)' : 'Embedded thumbnail',
        value: `${dim ? `${dim.width}×${dim.height}, ` : ''}${kb(t.thumbnail.length)}`, source: 'EXIF IFD1',
        why: mismatch ? 'This hidden preview has a different shape than the photo, so it was probably made before you cropped. It can still show what you cut out.' : 'A small hidden copy of the photo. Editors that crop or paint over the image often forget to update it.' });
    }
  }
  if (r.trailing > 0) {
    c.add({ category: 'preview', severity: format === 'png' || r.trailingJpeg ? 'high' : 'medium', label: 'Hidden data after the image', value: `${kb(r.trailing)} appended`,
      source: format === 'png' ? 'after IEND' : format === 'webp' ? 'after RIFF' : 'after EOI',
      why: format === 'png' ? 'Extra bytes after the PNG ends. Some editors (the "aCropalypse" bug) leave the uncropped original here.' : r.trailingJpeg ? 'A complete second JPEG is attached after the first (HDR map, motion photo, or an uncropped original).' : `Extra bytes after the ${FORMAT_LABEL[format]} ends.` });
  }
  if (c.truncated) warnings.push('This file carries a very large amount of metadata; only the first entries are listed.');
  const sorted = c.list.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return {
    name, size: bytes.length, format, width: r.width, height: r.height, orientation, findings: sorted, gps: out.gps, thumbnail: thumb, warnings,
    risk: summarize(sorted, out.gps, thumb), score: privacyScore(sorted), detail: r.detail,
  };
};

/* ------------------------------ strip + verify ------------------------------ */

/** Digest of the content that must survive cleaning untouched: pixels, pages, sheets, media samples. */
export const contentDigest = async (bytes: Uint8Array): Promise<number> => {
  const f = detectFormat(bytes);
  let h = 0;
  switch (f) {
    case 'jpeg':
      for (const p of parseJpeg(bytes).pieces) if (p.kind === 'raw' || [0xc0, 0xc1, 0xc2, 0xc4, 0xda, 0xdb].includes(p.marker)) h = crc32(bytes.subarray(p.start, p.end), h);
      return h;
    case 'png':
      for (const ch of (await parsePng(bytes)).chunks) if (['IHDR', 'PLTE', 'IDAT', 'fdAT'].includes(ch.type)) h = crc32(bytes.subarray(ch.start, ch.end), h);
      return h;
    case 'webp':
      for (const [s, e] of webpPixelDigestRanges(bytes)) h = crc32(bytes.subarray(s, e), h);
      return h;
    case 'pdf': return pdfContentDigest(bytes);
    case 'mp4': return mp4ContentDigest(bytes);
    case 'docx': case 'xlsx': case 'pptx': return officeContentDigest(bytes);
    case 'heic': throw new NeedsReencode('HEIC content cannot be compared byte for byte.');
  }
};
/** Back-compat name used by the tests: CRC of the actual pixel stream. */
export const pixelDigest = contentDigest;

const KEPT_ON_PURPOSE = (f: Finding) => f.label === 'Orientation';

export const clean = async (bytes: Uint8Array, name = 'file', opts: CleanOptions = {}): Promise<CleanResult> => {
  const before = await analyze(bytes, name);
  const fmt = before.format;
  let out: Uint8Array;
  let reencoded = false;
  let orientation = opts.keepOrientation === false ? 1 : before.orientation;

  if (fmt === 'heic') {
    if (!opts.rasterize) throw new NeedsReencode('HEIC cannot be cleaned losslessly. It has to be decoded and saved again as JPEG, which needs a browser that can open HEIC.');
    out = (await opts.rasterize(bytes, fmt)).bytes; reencoded = true; orientation = 1;
  } else if (READS_PIXELS.has(fmt) && opts.keepOrientation === false && before.orientation > 1 && opts.rasterize) {
    // Dropping the tag would leave the photo sideways, so the rotation is baked into the pixels instead.
    out = (await opts.rasterize(bytes, fmt)).bytes; reencoded = true; orientation = 1;
  } else {
    switch (fmt) {
      case 'jpeg': out = stripJpeg(bytes, { orientation }); break;
      case 'png': out = await stripPng(bytes, { orientation }); break;
      case 'webp': out = stripWebp(bytes, { orientation }); break;
      case 'pdf': out = await stripPdf(bytes); break;
      case 'mp4': out = stripMp4(bytes); break;
      default: out = await stripOffice(bytes);
    }
  }
  const after = await analyze(out, name);
  const pixelsIdentical = !reencoded && (await contentDigest(bytes)) === (await contentDigest(out));
  const leftovers = after.findings.filter((f) => !KEPT_ON_PURPOSE(f));
  const remaining = leftovers.filter((f) => f.removable === false);
  const unexpected = leftovers.filter((f) => f.removable !== false);
  const removable = (f: Finding) => !KEPT_ON_PURPOSE(f) && f.removable !== false;
  return {
    bytes: out, before, after, pixelsIdentical, reencoded, outFormat: after.format, orientationKept: orientation,
    removed: before.findings.filter(removable), remaining,
    verified: unexpected.length === 0 && (reencoded || (pixelsIdentical && after.width === before.width && after.height === before.height)),
  };
};

