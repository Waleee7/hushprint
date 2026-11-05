// hushprint scan|clean <files...>  : the same engine as the web app, on the command line.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { analyze, clean, NeedsReencode, RANK, type Analysis, type Severity } from './engine/analyze.ts';
import { cleanName, randomName } from './engine/names.ts';
import { MAX_BATCH_BYTES, MAX_BATCH_FILES, MAX_FILE_BYTES } from './engine/limits.ts';
import { BAND_LABEL, batchScore, scoreBand } from './engine/score.ts';

const HELP = `hushprint: see what your files leak, then strip it. Nothing leaves this machine.

Usage
  hushprint scan  <files|folders...> [--json] [--fail-on <critical|high|medium|low>]
  hushprint clean <files|folders...> [--out <dir>] [--share-safe] [--no-rotation] [--json]

scan        Report findings and a 0-100 privacy score per file and for the batch.
            Exit code 1 when --fail-on is set and a finding at that severity or worse exists.
clean       Write cleaned copies (never overwrites the original or an existing file).
            Default name: <name>-clean.<ext> next to the original, or inside --out.
--share-safe  Random output names (hp-<12 hex>.<ext>). Also drops the rotation tag: a rotated photo is
            kept as is and flagged, because rotating pixels needs the browser's image decoder.
--no-rotation Drop the orientation tag too (a rotated photo may then appear sideways).
--allow-unverified  Write a copy even when re-scanning it still finds removable metadata. The file is named
            <name>-UNVERIFIED.<ext> and the exit code stays 2, so it can never pass for a clean file.
Symlinks are skipped. Limits: 256 MB per file, 500 files and 1 GB per run.
HEIC files can be scanned here, but cleaning them re-encodes pixels, which needs the web app.

Formats: JPEG, PNG, WebP, HEIC (scan), PDF, DOCX, XLSX, PPTX, MP4/MOV.
Exit codes: 0 ok, 1 findings at --fail-on level, 2 a file could not be processed, failed verification, or bad usage.`;

const EXT = /\.(jpe?g|png|webp|heic|heif|pdf|docx|xlsx|pptx|mp4|mov|m4v)$/i;
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const SEV_COLOR: Record<Severity, number> = { critical: 31, high: 33, medium: 93, low: 36, info: 90 };

interface Args { cmd?: string; files: string[]; json: boolean; out?: string; share: boolean; noRotation: boolean; allowUnverified: boolean; failOn?: Severity }

export const parseArgs = (argv: string[]): Args => {
  const a: Args = { files: [], json: false, share: false, noRotation: false, allowUnverified: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--json') a.json = true;
    else if (v === '--share-safe') a.share = true;
    else if (v === '--no-rotation') a.noRotation = true;
    else if (v === '--allow-unverified') a.allowUnverified = true;
    else if (v === '--out' || v === '-o') a.out = argv[++i];
    else if (v === '--fail-on') {
      const s = argv[++i] as Severity;
      if (!['critical', 'high', 'medium', 'low'].includes(s)) throw new Error('--fail-on needs critical, high, medium or low');
      a.failOn = s;
    } else if (v === '-h' || v === '--help') a.cmd = 'help';
    else if (v.startsWith('-')) throw new Error(`unknown option ${v}`);
    else if (!a.cmd) a.cmd = v;
    else a.files.push(v);
  }
  return a;
};

/**
 * Everything that comes from a file (metadata, names, paths, error text) is untrusted. Before it reaches a terminal,
 * C0 and C1 controls (including ESC, which starts ANSI/OSC sequences), DEL, line/paragraph separators and Unicode
 * bidi controls are replaced by visible escapes. JSON output goes through safeJson() below.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
export const sanitize = (v: unknown): string =>
  String(v).replace(UNSAFE, (ch) => {
    const n = ch.charCodeAt(0);
    return n <= 0xff ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16).padStart(4, '0')}`;
  });
/** JSON.stringify escapes C0 but leaves C1 (U+009B is a CSI on some terminals), U+2028/9 and bidi controls raw. Escape those too; the result is still valid JSON. */
const JSON_UNSAFE = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g; // C0 is already escaped by JSON.stringify
export const safeJson = (v: unknown): string =>
  JSON.stringify(v, null, 2).replace(JSON_UNSAFE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

export interface Deps { analyze: typeof analyze; clean: typeof clean; maxFile: number; maxFiles: number; maxBytes: number }
const DEFAULTS: Deps = { analyze, clean, maxFile: MAX_FILE_BYTES, maxFiles: MAX_BATCH_FILES, maxBytes: MAX_BATCH_BYTES };

class Skip extends Error {}

/** Collect regular files only. Symlinks are never followed (lstat), special files are ignored. */
const expand = async (paths: string[], d: Deps): Promise<{ files: string[]; skipped: string[] }> => {
  const files: string[] = [], skipped: string[] = [];
  let total = 0;
  const walk = async (p: string, depth: number): Promise<void> => {
    const s = await lstat(p);
    if (s.isSymbolicLink()) { skipped.push(`${p} (symlink)`); return; }
    if (s.isDirectory()) {
      if (depth > 12) return;
      for (const n of (await readdir(p)).sort()) { if (!n.startsWith('.')) await walk(join(p, n), depth + 1); }
      return;
    }
    if (!s.isFile()) { skipped.push(`${p} (not a regular file)`); return; }
    if (depth > 0 && !EXT.test(p)) return;
    if (files.length >= d.maxFiles) throw new Error(`more than ${d.maxFiles} files; split the run`);
    total += s.size;
    if (total > d.maxBytes) throw new Error(`more than ${Math.round(d.maxBytes / 1048576)} MB in total; split the run`);
    files.push(p);
  };
  for (const p of paths) await walk(p, 0);
  return { files, skipped };
};

/** Open without following symlinks, require a regular file, and enforce the size cap on the open handle (no stat/read race). */
const load = async (file: string, d: Deps, budget: { left: number }): Promise<Uint8Array> => {
  const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((e: NodeJS.ErrnoException) => {
    throw new Skip(e.code === 'ELOOP' ? 'symlinks are not followed' : e.message);
  });
  try {
    const st = await h.stat();
    if (!st.isFile()) throw new Skip('not a regular file');
    if (st.size > d.maxFile) throw new Skip(`larger than ${Math.round(d.maxFile / 1048576)} MB`);
    if (st.size > budget.left) throw new Skip('run exceeds the total size limit');
    const buf = Buffer.allocUnsafe(st.size + 1); // one spare byte: if it gets filled, the file grew after fstat
    let n = 0;
    for (;;) { const { bytesRead } = await h.read(buf, n, buf.length - n, null); if (!bytesRead) break; n += bytesRead; if (n >= buf.length) break; }
    if (n > st.size) throw new Skip('file changed while being read');
    budget.left -= n;
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  } finally { await h.close(); }
};

const line = (a: Analysis) => `${c(1, sanitize(basename(a.name)))}  ${a.format.toUpperCase()}  score ${c(scoreBand(a.score) === 'quiet' ? 32 : 31, `${a.score}/100`)} (${BAND_LABEL[scoreBand(a.score)]})`;

export const main = async (argv: string[], deps: Partial<Deps> = {}): Promise<number> => {
  const D: Deps = { ...DEFAULTS, ...deps };
  let args: Args;
  try { args = parseArgs(argv); } catch (e) { console.error(`hushprint: ${sanitize((e as Error).message)}\n`); console.error(HELP); return 2; }
  if (!args.cmd || args.cmd === 'help' || !['scan', 'clean'].includes(args.cmd)) { (args.cmd && args.cmd !== 'help' ? console.error : console.log)(HELP); return args.cmd && args.cmd !== 'help' ? 2 : 0; }
  if (!args.files.length) { console.error('hushprint: give at least one file or folder\n'); return 2; }

  let files: string[];
  try {
    const x = await expand(args.files, D);
    files = x.files;
    for (const k of x.skipped) console.error(`hushprint: skipped ${sanitize(k)}`);
    if (x.skipped.length && !files.length) return 2;
  } catch (e) { console.error(`hushprint: ${sanitize((e as Error).message)}`); return 2; }
  let status = 0;
  const json: unknown[] = [];
  const scores: number[] = [];
  const used = new Set<string>();
  const budget = { left: D.maxBytes };

  for (const file of files) {
    try {
      const bytes = await load(file, D, budget);
      if (args.cmd === 'scan') {
        const a = await D.analyze(bytes, file);
        scores.push(a.score);
        const leaks = a.findings.filter((f) => f.label !== 'Orientation');
        if (args.failOn && leaks.some((f) => RANK[f.severity] >= RANK[args.failOn!])) status = Math.max(status, 1);
        if (args.json) { json.push({ file, format: a.format, score: a.score, gps: a.gps ? { lat: a.gps.lat, lon: a.gps.lon } : null, findings: leaks.map(({ severity, label, value, source, removable }) => ({ severity, label, value, source, removable: removable !== false })), warnings: a.warnings }); continue; }
        console.log(line(a));
        for (const f of leaks) console.log(`  ${c(SEV_COLOR[f.severity], f.severity.padEnd(8))} ${sanitize(f.label)}: ${sanitize(f.value)}  ${c(90, `[${sanitize(f.source)}${f.removable === false ? ', not removable' : ''}]`)}`);
        if (!leaks.length) console.log(c(32, '  nothing identifying found'));
        for (const w of a.warnings) console.log(c(33, `  note: ${sanitize(w)}`));
      } else {
        const r = await D.clean(bytes, file, { keepOrientation: !(args.share || args.noRotation) });
        scores.push(r.after.score);
        // Fail closed: a copy whose re-scan still finds removable metadata must never be written as if it were clean.
        if (!r.verified) {
          status = 2;
          if (!args.allowUnverified) {
            const msg = 'verification failed: the cleaned copy still contains removable metadata, so nothing was written (use --allow-unverified to write a clearly marked copy anyway)';
            if (args.json) json.push({ file, error: msg, verified: false }); else console.error(`${c(31, 'error')} ${sanitize(file)}: ${msg}`);
            continue;
          }
        }
        const dir = args.out ? resolve(args.out) : dirname(file);
        await mkdir(dir, { recursive: true });
        const mark = (n: string) => (r.verified ? n : n.replace(/(\.[^./]+)$/, '-UNVERIFIED$1'));
        let name = mark(args.share ? randomName(r.outFormat) : cleanName(file, r.outFormat));
        while (used.has(join(dir, name))) name = mark(args.share ? randomName(r.outFormat) : cleanName(file, r.outFormat).replace(extname(name), `-${used.size}${extname(name)}`));
        const dest = join(dir, name);
        used.add(dest);
        await writeFile(dest, r.bytes, { flag: 'wx' }); // 'wx': refuse to overwrite anything
        if (args.json) { json.push({ file, output: dest, before: r.before.score, after: r.after.score, removed: r.removed.length, verified: r.verified, contentIdentical: r.pixelsIdentical, remaining: r.remaining.map((f) => f.label) }); continue; }
        const note = r.orientationKept > 1 ? `rotation tag kept${args.share ? ' (needs the web app to bake in)' : ''}` : '';
        console.log(`${c(1, sanitize(basename(file)))} -> ${sanitize(dest)}`);
        console.log(`  score ${r.before.score} -> ${c(r.remaining.length ? 33 : 32, String(r.after.score))}/100  removed ${r.removed.length}  ${r.verified ? c(32, 'verified') : c(31, 'NOT VERIFIED')}  content ${r.pixelsIdentical ? 'byte-identical' : 're-encoded'}${note ? `  ${note}` : ''}`);
        for (const f of r.remaining) console.log(c(33, `  still present (cannot remove): ${sanitize(f.label)}: ${sanitize(f.value)}`));
      }
    } catch (e) {
      const msg = e instanceof NeedsReencode || e instanceof Error ? e.message : String(e);
      if (!args.json) console.error(`${c(31, 'error')} ${sanitize(file)}: ${sanitize(msg)}`);
      if (args.json) json.push({ file, error: msg });
      status = 2;
    }
  }
  const batch = batchScore(scores);
  if (args.json) console.log(safeJson({ files: json, batchScore: batch ?? null }));
  else if (scores.length > 1) console.log(`\nBatch score ${batch}/100 (the lowest file; one leak is enough)`);
  return status;
};

if (process.argv[1] && /hushprint(\.mjs)?$|cli\.ts$/.test(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
