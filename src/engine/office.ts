// DOCX / XLSX / PPTX (Office Open XML). Reads docProps/core, app and custom, and rewrites the zip without them.
import { ParseError, crc32, utf8 } from './bytes.ts';
import { decodeEntities } from './xmp.ts';
import { MAX_INFLATE_TOTAL } from './limits.ts';
import { type ZipEntry, entryData, entryRaw, isZip, readZip, rewriteZip } from './zip.ts';

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';
export interface OfficeProp { source: 'core' | 'app' | 'custom'; key: string; value: string }
export interface OfficeInfo {
  kind: OfficeKind;
  props: OfficeProp[];
  hasThumbnail: boolean;
  /** Author names found inside the document body (tracked changes, comments). Not removable here. */
  bodyAuthors: string[];
  /** Absolute paths stored in the workbook, e.g. C:\Users\name\... (xlsx) */
  absPaths: string[];
  entries: ZipEntry[];
}

const CORE = 'docProps/core.xml', APP = 'docProps/app.xml', CUSTOM = 'docProps/custom.xml';
const isThumb = (n: string) => /^docProps\/thumbnail\.[a-z]+$/i.test(n);

export const detectOffice = (b: Uint8Array): OfficeKind | undefined => {
  if (!isZip(b)) return undefined;
  let entries: ZipEntry[];
  try { entries = readZip(b); } catch { return undefined; }
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('[Content_Types].xml')) return undefined;
  if (names.has('word/document.xml')) return 'docx';
  if (names.has('xl/workbook.xml')) return 'xlsx';
  if (names.has('ppt/presentation.xml')) return 'pptx';
  return undefined;
};

const tagValues = (xml: string, wanted: Record<string, string>): OfficeProp[] => {
  const out: OfficeProp[] = [];
  for (const [tag, label] of Object.entries(wanted)) {
    const m = new RegExp(`<${tag}(?:\\s[^>]{0,200})?>([^<]{0,2000})</${tag}>`).exec(xml);
    const v = m && decodeEntities(m[1]).trim();
    if (v) out.push({ source: 'core', key: label, value: v });
  }
  return out;
};

const CORE_TAGS: Record<string, string> = {
  'dc:creator': 'Author', 'cp:lastModifiedBy': 'Last modified by', 'dcterms:created': 'Created', 'dcterms:modified': 'Modified',
  'cp:lastPrinted': 'Last printed', 'cp:revision': 'Revision', 'dc:title': 'Title', 'dc:subject': 'Subject', 'cp:keywords': 'Keywords',
  'dc:description': 'Comments', 'cp:category': 'Category', 'cp:contentStatus': 'Status',
};
const APP_TAGS: Record<string, string> = {
  Application: 'Application', AppVersion: 'App version', Company: 'Company', Manager: 'Manager', Template: 'Template',
  TotalTime: 'Total editing time (min)', HyperlinkBase: 'Hyperlink base', DocSecurity: 'Document security',
};

const readText = async (b: Uint8Array, entries: ZipEntry[], name: string, left: { n: number }): Promise<string | undefined> => {
  const e = entries.find((x) => x.name === name);
  if (!e) return undefined;
  const d = await entryData(b, e);
  left.n -= d.length;
  if (left.n < 0) throw new ParseError('Office file would decompress past the safety limit');
  return utf8(d);
};

export const parseOffice = async (b: Uint8Array): Promise<OfficeInfo> => {
  const kind = detectOffice(b);
  if (!kind) throw new ParseError('not an Office Open XML file');
  const entries = readZip(b);
  const left = { n: MAX_INFLATE_TOTAL };
  const info: OfficeInfo = { kind, props: [], hasThumbnail: entries.some((e) => isThumb(e.name)), bodyAuthors: [], absPaths: [], entries };

  const core = await readText(b, entries, CORE, left);
  if (core) info.props.push(...tagValues(core, CORE_TAGS));
  const app = await readText(b, entries, APP, left);
  if (app) info.props.push(...tagValues(app, APP_TAGS).map((p) => ({ ...p, source: 'app' as const })));
  const custom = await readText(b, entries, CUSTOM, left);
  if (custom) {
    let n = 0;
    for (const m of custom.matchAll(/<property\b[^>]{0,300}\bname="([^"]{1,200})"[^>]*>\s*<vt:[a-z0-9]+>([^<]{0,500})<\/vt:[a-z0-9]+>/gi)) {
      if (++n > 100) break;
      const v = decodeEntities(m[2]).trim();
      if (v) info.props.push({ source: 'custom', key: decodeEntities(m[1]), value: v });
    }
  }

  // document-body authors and absolute paths (read-only: these are content, not properties)
  const authors = new Set<string>();
  const bodyParts = kind === 'docx' ? ['word/document.xml', 'word/comments.xml', 'word/footnotes.xml'] : kind === 'pptx' ? ['ppt/commentAuthors.xml'] : ['xl/workbook.xml'];
  for (const name of bodyParts) {
    let xml: string | undefined;
    try { xml = await readText(b, entries, name, left); } catch (e) { if (e instanceof ParseError && /safety/.test(e.message)) throw e; continue; }
    if (!xml) continue;
    for (const m of xml.matchAll(/\b(?:w:author|name)="([^"]{1,120})"/g)) {
      if (authors.size >= 50) break;
      if (name === 'ppt/commentAuthors.xml' ? true : m[0].startsWith('w:author')) authors.add(decodeEntities(m[1]));
    }
    if (kind === 'xlsx') for (const m of xml.matchAll(/absPath[^>]{0,40}url="([^"]{1,300})"/g)) if (info.absPaths.length < 5) info.absPaths.push(decodeEntities(m[1]));
  }
  info.bodyAuthors = [...authors];
  return info;
};

const EMPTY_CORE = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>';
const EMPTY_APP = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>';
const EMPTY_CUSTOM = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>';

export const stripOffice = async (b: Uint8Array): Promise<Uint8Array> => {
  const info = await parseOffice(b);
  const enc = new TextEncoder();
  const replace = new Map<string, Uint8Array>();
  const remove = new Set<string>();
  const has = (n: string) => info.entries.some((e) => e.name === n);
  if (has(CORE)) replace.set(CORE, enc.encode(EMPTY_CORE));
  if (has(APP)) replace.set(APP, enc.encode(EMPTY_APP));
  if (has(CUSTOM)) replace.set(CUSTOM, enc.encode(EMPTY_CUSTOM));
  for (const e of info.entries) if (isThumb(e.name)) remove.add(e.name);
  if (remove.size && has('_rels/.rels')) {
    const rels = await entryData(b, info.entries.find((e) => e.name === '_rels/.rels')!);
    const xml = utf8(rels).replace(/<Relationship\b[^>]*\/>/g, (m) => (/relationships\/metadata\/thumbnail/.test(m) || /docProps\/thumbnail\./i.test(m) ? '' : m));
    replace.set('_rels/.rels', enc.encode(xml));
  }
  return rewriteZip(b, info.entries, { replace, remove });
};

/** Digest of every part we do not rewrite (name + stored CRC + compressed bytes). Equal before and after = nothing else changed. */
export const officeContentDigest = (b: Uint8Array): number => {
  const skip = new Set([CORE, APP, CUSTOM, '_rels/.rels']);
  let h = 0;
  for (const e of readZip(b)) {
    if (skip.has(e.name) || isThumb(e.name)) continue;
    h = crc32(new TextEncoder().encode(`${e.name}\0${e.crc}\0${e.usize}\0`), h);
    h = crc32(entryRaw(b, e), h);
  }
  return h;
};
