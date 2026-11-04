// Collect files from a drop (including whole folders), with hard limits.
import { MAX_BATCH_FILES } from './engine/limits.ts';

export const EXTENSIONS = /\.(jpe?g|png|webp|heic|heif|pdf|docx|xlsx|pptx|mp4|mov|m4v)$/i;
export interface Picked { file: File; path: string }

const readAll = (dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> => new Promise((resolve, reject) => {
  const reader = dir.createReader(), all: FileSystemEntry[] = [];
  const next = () => reader.readEntries((batch) => { if (!batch.length) resolve(all); else { all.push(...batch); next(); } }, reject); // Chrome returns <=100 per call
  next();
});
const toFile = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));

/** Must be called synchronously inside the drop handler: the DataTransfer is cleared afterwards. */
export const entriesFromDrop = (dt: DataTransfer): (FileSystemEntry | File)[] => {
  const out: (FileSystemEntry | File)[] = [];
  for (const it of [...dt.items]) {
    if (it.kind !== 'file') continue;
    const e = it.webkitGetAsEntry?.();
    const f = it.getAsFile();
    if (e) out.push(e); else if (f) out.push(f);
  }
  return out;
};

export const walk = async (roots: (FileSystemEntry | File)[], onCount?: (n: number) => void): Promise<{ picked: Picked[]; skipped: number; capped: boolean }> => {
  const picked: Picked[] = [];
  let skipped = 0, capped = false, visited = 0;
  const visit = async (e: FileSystemEntry | File, depth: number): Promise<void> => {
    if (picked.length >= MAX_BATCH_FILES || visited > 20_000) { capped = true; return; }
    visited++;
    if (e instanceof File) { picked.push({ file: e, path: e.name }); return; }
    if (e.isFile) {
      if (!EXTENSIONS.test(e.name)) { skipped++; return; }
      picked.push({ file: await toFile(e as FileSystemFileEntry), path: e.fullPath.replace(/^\//, '') });
      onCount?.(picked.length);
    } else if (e.isDirectory && depth < 12) {
      for (const k of await readAll(e as FileSystemDirectoryEntry)) await visit(k, depth + 1);
    }
  };
  for (const r of roots) await visit(r, 0);
  return { picked, skipped, capped };
};

export const fromInput = (files: File[]): Picked[] =>
  files.map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }));
