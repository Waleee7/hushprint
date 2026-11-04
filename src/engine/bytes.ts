import { MAX_INFLATE_BYTES } from './limits.ts';

export class ParseError extends Error {}

export const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

export const toAscii = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192) as unknown as number[]);
  return s;
};

export const startsWith = (b: Uint8Array, at: number, sig: number[] | string): boolean => {
  const s = typeof sig === 'string' ? [...ascii(sig)] : sig;
  if (at + s.length > b.length) return false;
  return s.every((v, i) => b[at + i] === v);
};

export const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
export const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export const p32be = (n: number) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
export const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
export const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
export const p16le = (n: number) => Uint8Array.of(n & 255, (n >>> 8) & 255);
export const p32le = (n: number) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
export const p16be = (n: number) => Uint8Array.of((n >>> 8) & 255, n & 255);

let table: Uint32Array | undefined;
export const crc32 = (data: Uint8Array, seed = 0): number => {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
};

/**
 * Bounded decompression. The output is read chunk by chunk and the stream is cancelled the moment it
 * would exceed `max`, so a decompression bomb costs at most `max` bytes of memory.
 */
export const inflate = async (data: Uint8Array, opts: { raw?: boolean; max?: number } = {}): Promise<Uint8Array> => {
  const max = opts.max ?? MAX_INFLATE_BYTES;
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(opts.raw ? 'deflate-raw' : 'deflate')).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) { await reader.cancel().catch(() => undefined); throw new ParseError(`compressed data expands past the ${Math.round(max / 1024)} KB safety limit`); }
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof ParseError) throw e;
    throw new ParseError('corrupt compressed data');
  }
  return concat(parts);
};

export const utf8 = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(b);
