// hushprint scan|clean <files...>  : the same engine as the web app, on the command line.
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { analyze, clean, NeedsReencode, RANK, type Analysis, type Severity } from './engine/analyze.ts';
import { cleanName, randomName } from './engine/names.ts';
import { MAX_FILE_BYTES } from './engine/limits.ts';
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
HEIC files can be scanned here, but cleaning them re-encodes pixels, which needs the web app.

Formats: JPEG, PNG, WebP, HEIC (scan), PDF, DOCX, XLSX, PPTX, MP4/MOV.
Exit codes: 0 ok, 1 findings at --fail-on level, 2 a file could not be processed or bad usage.`;

const EXT = /\.(jpe?g|png|webp|heic|heif|pdf|docx|xlsx|pptx|mp4|mov|m4v)$/i;
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const SEV_COLOR: Record<Severity, number> = { critical: 31, high: 33, medium: 93, low: 36, info: 90 };

interface Args { cmd?: string; files: string[]; json: boolean; out?: string; share: boolean; noRotation: boolean; failOn?: Severity }

export const parseArgs = (argv: string[]): Args => {
  const a: Args = { files: [], json: false, share: false, noRotation: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--json') a.json = true;
    else if (v === '--share-safe') a.share = true;
    else if (v === '--no-rotation') a.noRotation = true;
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

const expand = async (paths: string[]): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (p: string, depth: number): Promise<void> => {
    const s = await stat(p);
    if (s.isDirectory()) {
      if (depth > 12) return;
      for (const n of (await readdir(p)).sort()) { if (!n.startsWith('.')) await walk(join(p, n), depth + 1); }
    } else if (depth === 0 || EXT.test(p)) out.push(p);
  };
  for (const p of paths) await walk(p, 0);
  return out;
};

const load = async (file: string): Promise<Uint8Array> => {
  if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES / 1048576} MB`);
  return new Uint8Array(await readFile(file));
};

const line = (a: Analysis) => `${c(1, basename(a.name))}  ${a.format.toUpperCase()}  score ${c(scoreBand(a.score) === 'quiet' ? 32 : 31, `${a.score}/100`)} (${BAND_LABEL[scoreBand(a.score)]})`;

export const main = async (argv: string[]): Promise<number> => {
  let args: Args;
  try { args = parseArgs(argv); } catch (e) { console.error(`hushprint: ${(e as Error).message}\n`); console.error(HELP); return 2; }
  if (!args.cmd || args.cmd === 'help' || !['scan', 'clean'].includes(args.cmd)) { (args.cmd && args.cmd !== 'help' ? console.error : console.log)(HELP); return args.cmd && args.cmd !== 'help' ? 2 : 0; }
  if (!args.files.length) { console.error('hushprint: give at least one file or folder\n'); return 2; }

  let files: string[];
  try { files = await expand(args.files); } catch (e) { console.error(`hushprint: ${(e as Error).message}`); return 2; }
  let status = 0;
  const json: unknown[] = [];
  const scores: number[] = [];
  const used = new Set<string>();

  for (const file of files) {
    try {
      const bytes = await load(file);
      if (args.cmd === 'scan') {
        const a = await analyze(bytes, file);
        scores.push(a.score);
        const leaks = a.findings.filter((f) => f.label !== 'Orientation');
        if (args.failOn && leaks.some((f) => RANK[f.severity] >= RANK[args.failOn!])) status = Math.max(status, 1);
        if (args.json) { json.push({ file, format: a.format, score: a.score, gps: a.gps ? { lat: a.gps.lat, lon: a.gps.lon } : null, findings: leaks.map(({ severity, label, value, source, removable }) => ({ severity, label, value, source, removable: removable !== false })), warnings: a.warnings }); continue; }
        console.log(line(a));
        for (const f of leaks) console.log(`  ${c(SEV_COLOR[f.severity], f.severity.padEnd(8))} ${f.label}: ${f.value}  ${c(90, `[${f.source}${f.removable === false ? ', not removable' : ''}]`)}`);
        if (!leaks.length) console.log(c(32, '  nothing identifying found'));
        for (const w of a.warnings) console.log(c(33, `  note: ${w}`));
      } else {
        const r = await clean(bytes, file, { keepOrientation: !(args.share || args.noRotation) });
        scores.push(r.after.score);
        const dir = args.out ? resolve(args.out) : dirname(file);
        await mkdir(dir, { recursive: true });
        let name = args.share ? randomName(r.outFormat) : cleanName(file, r.outFormat);
        while (used.has(join(dir, name))) name = args.share ? randomName(r.outFormat) : name.replace(extname(name), `-${used.size}${extname(name)}`);
        const dest = join(dir, name);
        used.add(dest);
        await writeFile(dest, r.bytes, { flag: 'wx' }); // 'wx': refuse to overwrite anything
        const note = r.orientationKept > 1 ? `rotation tag kept${args.share ? ' (needs the web app to bake in)' : ''}` : '';
        if (args.json) { json.push({ file, output: dest, before: r.before.score, after: r.after.score, removed: r.removed.length, verified: r.verified, contentIdentical: r.pixelsIdentical, remaining: r.remaining.map((f) => f.label) }); continue; }
        console.log(`${c(1, basename(file))} -> ${dest}`);
        console.log(`  score ${r.before.score} -> ${c(r.remaining.length ? 33 : 32, String(r.after.score))}/100  removed ${r.removed.length}  ${r.verified ? c(32, 'verified') : c(31, 'NOT VERIFIED')}  content ${r.pixelsIdentical ? 'byte-identical' : 're-encoded'}${note ? `  ${note}` : ''}`);
        for (const f of r.remaining) console.log(c(33, `  still present (cannot remove): ${f.label}: ${f.value}`));
        if (!r.verified) status = Math.max(status, 2);
      }
    } catch (e) {
      const msg = e instanceof NeedsReencode ? e.message : (e as Error).message;
      console.error(`${c(31, 'error')} ${file}: ${msg}`);
      if (args.json) json.push({ file, error: msg });
      status = 2;
    }
  }
  const batch = batchScore(scores);
  if (args.json) console.log(JSON.stringify({ files: json, batchScore: batch ?? null }, null, 2));
  else if (scores.length > 1) console.log(`\nBatch score ${batch}/100 (the lowest file; one leak is enough)`);
  return status;
};

if (process.argv[1] && /hushprint(\.mjs)?$|cli\.ts$/.test(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
