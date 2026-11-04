// Lightweight XMP + IPTC-IIM readers. We only surface fields that identify a person, place, or device.
import { toAscii, utf8 } from './bytes.ts';

export interface XmpField { key: string; value: string }

const decodeEntities = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Extract `ns:Key="v"` attributes and `<ns:Key>text|<rdf:li>..</rdf:li></ns:Key>` elements. */
export const parseXmp = (xml: string): XmpField[] => {
  const out: XmpField[] = [];
  for (const m of xml.matchAll(/\b([A-Za-z][\w-]*:[A-Za-z][\w-]*)="([^"]*)"/g)) {
    if (/^(xmlns|rdf|x):/.test(m[1])) continue;
    if (m[2]) out.push({ key: m[1], value: decodeEntities(m[2]) });
  }
  for (const m of xml.matchAll(/<([A-Za-z][\w-]*:[A-Za-z][\w-]*)(?:\s[^>]*)?(?<!\/)>/g)) {
    if (/^(rdf|x):/.test(m[1])) continue;
    const from = m.index + m[0].length;
    const close = xml.indexOf(`</${m[1]}>`, from);
    if (close < 0) continue;
    const inner = xml.slice(from, close);
    const items = [...inner.matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g)].map((x) => x[1]);
    if (!items.length && /<[A-Za-z][\w-]*:/.test(inner)) continue; // container of other fields; they are visited on their own
    const text = (items.length ? items.join(', ') : inner).replace(/<[^>]+>/g, '').trim();
    if (text) out.push({ key: m[1], value: decodeEntities(text) });
  }
  return out;
};

export const decodeXmpPacket = (b: Uint8Array) => utf8(b);

export interface IptcField { key: string; value: string }
const IPTC_NAMES: Record<number, string> = {
  5: 'Title', 25: 'Keywords', 55: 'Date created', 80: 'Photographer (byline)', 90: 'City', 92: 'Sublocation', 95: 'State',
  101: 'Country', 110: 'Credit', 115: 'Source', 116: 'Copyright', 120: 'Caption', 122: 'Caption writer',
};

/** Photoshop 8BIM resources inside APP13; resource 0x0404 holds IPTC-IIM datasets. */
export const parseIptc = (app13: Uint8Array): IptcField[] => {
  const out: IptcField[] = [];
  let i = toAscii(app13.subarray(0, 14)) === 'Photoshop 3.0\0' ? 14 : 0;
  while (i + 12 <= app13.length && toAscii(app13.subarray(i, i + 4)) === '8BIM') {
    const id = (app13[i + 4] << 8) | app13[i + 5];
    const nameLen = app13[i + 6];
    let p = i + 7 + nameLen; if ((1 + nameLen) % 2) p++;
    const size = ((app13[p] << 24) | (app13[p + 1] << 16) | (app13[p + 2] << 8) | app13[p + 3]) >>> 0;
    p += 4;
    if (id === 0x0404) {
      let q = p; const end = Math.min(p + size, app13.length);
      while (q + 5 <= end && app13[q] === 0x1c) {
        const rec = app13[q + 1], ds = app13[q + 2], len = (app13[q + 3] << 8) | app13[q + 4];
        if (rec === 2 && IPTC_NAMES[ds] && q + 5 + len <= end) out.push({ key: IPTC_NAMES[ds], value: utf8(app13.subarray(q + 5, q + 5 + len)) });
        q += 5 + len;
      }
    }
    i = p + size + (size % 2);
  }
  return out;
};
