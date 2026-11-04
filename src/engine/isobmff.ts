// ISO base media file format (MP4, MOV, HEIC) box walker. Every read is bounds-checked and every loop is capped.
import { startsWith, toAscii, u32be } from './bytes.ts';
import { MAX_BOXES, MAX_BOX_DEPTH } from './limits.ts';

export interface Box {
  type: string;
  start: number;   // first byte of the box header
  header: number;  // header length (8, 16 with a 64-bit size)
  end: number;     // one past the last byte
}
export interface BoxBudget { left: number }
export const newBudget = (): BoxBudget => ({ left: MAX_BOXES });

export const payloadStart = (bx: Box) => bx.start + bx.header;

/** Child boxes in [from, to). Stops quietly at the first malformed header: a damaged tail never throws. */
export const readBoxes = (b: Uint8Array, from: number, to: number, budget: BoxBudget = newBudget()): Box[] => {
  const out: Box[] = [];
  let pos = from;
  const limit = Math.min(to, b.length);
  while (pos + 8 <= limit && budget.left > 0) {
    let size = u32be(b, pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > limit) break;
      const hi = u32be(b, pos + 8), lo = u32be(b, pos + 12);
      if (hi > 0x1fffff) break; // beyond 2^53, certainly not a real size
      size = hi * 2 ** 32 + lo;
      header = 16;
    } else if (size === 0) size = limit - pos; // runs to the end of the container
    if (size < header || pos + size > limit) break;
    budget.left--;
    out.push({ type: toAscii(b.subarray(pos + 4, pos + 8)), start: pos, header, end: pos + size });
    pos += size;
  }
  return out;
};

/** Walk a path of container types, e.g. find(b, top, ['moov', 'udta']). Returns every match. */
export const findAll = (b: Uint8Array, parents: Box[], path: string[], budget: BoxBudget = newBudget(), depth = 0): Box[] => {
  if (!path.length || depth > MAX_BOX_DEPTH) return parents;
  const hits: Box[] = [];
  for (const p of parents) if (p.type === path[0]) hits.push(p);
  if (path.length === 1) return hits;
  const kids: Box[] = [];
  for (const h of hits) kids.push(...readBoxes(b, payloadStart(h), h.end, budget));
  return findAll(b, kids, path.slice(1), budget, depth + 1);
};

/** `meta` is a FullBox in MP4/HEIF (4 version+flags bytes) but a plain box in classic QuickTime. */
export const metaChildrenStart = (b: Uint8Array, meta: Box): number => {
  const p = payloadStart(meta);
  return startsWith(b, p + 4, 'hdlr') ? p : p + 4;
};
