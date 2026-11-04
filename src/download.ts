import { makeZip } from './engine/zip.ts';

export const cleanName = (name: string) => name.replace(/(\.[^.]+)?$/, (e) => `-clean${e}`);
import { MIME, type Format } from './engine/types.ts';
export const mimeFor = (format: Format) => MIME[format];

export const saveBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

export const zipFiles = (files: { name: string; bytes: Uint8Array }[]): Blob => {
  const used = new Map<string, number>();
  const unique = files.map((f) => {
    const n = used.get(f.name) ?? 0; used.set(f.name, n + 1);
    return { name: n ? f.name.replace(/(\.[^.]+)?$/, (e) => `-${n + 1}${e}`) : f.name, data: f.bytes };
  });
  return new Blob([makeZip(unique) as BlobPart], { type: 'application/zip' });
};
