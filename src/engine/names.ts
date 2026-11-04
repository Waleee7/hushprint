// Output file naming. Share-safe mode replaces names entirely, because "IMG_4412 Mom's house.jpg" is itself a leak.
import { EXTENSION, type Format } from './types.ts';

const HEX = '0123456789abcdef';
export const randomName = (format: Format, rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string => {
  let id = '';
  for (const v of rand(6)) id += HEX[v >> 4] + HEX[v & 15];
  return `hp-${id}.${EXTENSION[format]}`;
};

/** photo.JPG -> photo-clean.jpg (extension follows the real output format, so a re-encoded HEIC becomes .jpg). */
export const cleanName = (name: string, format: Format): string => {
  const base = name.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') || 'file';
  return `${base}-clean.${EXTENSION[format]}`;
};

/** Safe relative path for inside a ZIP: no absolute paths, no "..", no drive letters. */
export const safeZipPath = (p: string): string =>
  p.split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..').map((s) => s.replace(/^[A-Za-z]:$/, '_')).join('/') || 'file';
