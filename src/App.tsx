import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { CATEGORY_TITLE, FORMAT_LABEL, NeedsReencode, RANK, analyze, clean, type Analysis, type Category, type CleanResult, type Finding, type Severity } from './engine/analyze.ts';
import { MAX_BATCH_BYTES, MAX_BATCH_FILES, MAX_FILE_BYTES } from './engine/limits.ts';
import { cleanName, randomName, safeZipPath } from './engine/names.ts';
import { BAND_LABEL, batchScore, scoreBand } from './engine/score.ts';
import { MIME, isPreviewable } from './engine/types.ts';
import { EXTENSIONS, entriesFromDrop, fromInput, walk, type Picked } from './batch.ts';
import { rasterize } from './raster.ts';
import { formatCoord, formatDistance, nearestCity } from './engine/geo.ts';
import { Radar, WorldMap } from './GeoMap.tsx';
import { saveBlob, zipFiles } from './download.ts';
import { makeSampleFiles } from './sample.ts';

type Mode = 'normal' | 'share';
interface Item {
  id: string; file: File; path: string; analysis?: Analysis; error?: string; result?: CleanResult; mode?: Mode; outName?: string;
  cleanError?: string; url: string; thumbUrl?: string;
}
interface Progress { label: string; done: number; total: number }
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const SEV_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
const SEV_GLYPH: Record<Severity, string> = { critical: '▲', high: '◆', medium: '●', low: '○', info: '·' };
const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const Sev = ({ level, big }: { level: Severity; big?: boolean }) => (
  <span className={`sev sev-${level}${big ? ' big' : ''}`}><span aria-hidden="true">{SEV_GLYPH[level]}</span> {SEV_LABEL[level]}</span>
);

/** A hand-drawn grease-pencil loop. Sits over its positioned parent and overshoots it a little. */
export const Scribble = ({ className = '' }: { className?: string }) => (
  <svg className={`scribble ${className}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <path d="M46 7 C 78 2, 98 24, 95 52 C 92 80, 62 98, 34 93 C 8 88, 1 60, 6 38 C 11 16, 38 4, 68 10" />
  </svg>
);
const pad2 = (n: number) => String(n).padStart(2, '0');

let uid = 0;
/** True on phone-width screens. Decides how many categories show before "See all". */
const useNarrow = () => {
  const [n, setN] = useState(() => window.matchMedia('(max-width: 600px)').matches);
  useEffect(() => { const m = window.matchMedia('(max-width: 600px)'); const f = () => setN(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return n;
};

export function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [keepRotation, setKeepRotation] = useState(true);
  const [drag, setDrag] = useState(false);
  const [proof, setProof] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [saved, setSaved] = useState<{ name: string; again: () => void }>();
  const [progress, setProgress] = useState<Progress>();
  const [notice, setNotice] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(async (picked: Picked[], skipped = 0, capped = false) => {
    const notes: string[] = [];
    let bytes = 0;
    const accepted: Picked[] = [];
    for (const p of picked) {
      if (accepted.length >= MAX_BATCH_FILES) { capped = true; break; }
      if (p.file.size > MAX_FILE_BYTES) { notes.push(`${p.file.name} is over ${MAX_FILE_BYTES / 1048576} MB`); continue; }
      if (bytes + p.file.size > MAX_BATCH_BYTES) { capped = true; break; }
      bytes += p.file.size; accepted.push(p);
    }
    if (skipped) notes.push(`${skipped} unsupported file${skipped > 1 ? 's' : ''} skipped`);
    if (capped) notes.push(`stopped at ${MAX_BATCH_FILES} files / ${MAX_BATCH_BYTES / 1073741824} GB`);
    setNotice(notes.length ? notes.join('. ') + '.' : undefined);
    const news: Item[] = accepted.map(({ file, path }) => ({ id: `f${++uid}`, file, path, url: URL.createObjectURL(file) }));
    if (!news.length) return;
    setItems((p) => [...p, ...news]);
    setSelected((s) => s ?? news[0].id);
    for (const [i, n] of news.entries()) {
      setProgress({ label: 'Scanning', done: i, total: news.length });
      await tick();
      let patch: Partial<Item>;
      try {
        const analysis = await analyze(new Uint8Array(await n.file.arrayBuffer()), n.file.name);
        patch = { analysis, thumbUrl: analysis.thumbnail ? URL.createObjectURL(new Blob([analysis.thumbnail.bytes as BlobPart], { type: 'image/jpeg' })) : undefined };
      } catch (e) { patch = { error: e instanceof Error ? e.message : 'Could not read this file.' }; }
      setItems((p) => p.map((x) => (x.id === n.id ? { ...x, ...patch } : x)));
    }
    setProgress(undefined);
    setAnnounce(`${news.length} file${news.length > 1 ? 's' : ''} scanned.`);
  }, []);

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDrag(false);
    const roots = entriesFromDrop(e.dataTransfer); // must happen synchronously
    if (!roots.length) return;
    setProgress({ label: 'Reading folder', done: 0, total: 0 });
    void walk(roots).then(({ picked, skipped, capped }) => addFiles(picked, skipped, capped)).catch(() => { setProgress(undefined); setNotice('Could not read that folder.'); });
  };
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    window.addEventListener('dragover', stop); window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);

  const loadSample = async () => { void addFiles(fromInput(await makeSampleFiles())); };
  const reset = () => { setSaved(undefined); setNotice(undefined); items.forEach((i) => { URL.revokeObjectURL(i.url); if (i.thumbUrl) URL.revokeObjectURL(i.thumbUrl); }); setItems([]); setSelected(undefined); };

  const ready = items.filter((i) => i.analysis);
  const allCleaned = ready.length > 0 && ready.every((i) => i.result);
  const cur = items.find((i) => i.id === selected) ?? items[0];
  const totalLeaks = ready.reduce((n, i) => n + i.analysis!.findings.filter((f) => f.label !== 'Orientation').length, 0);

  const scores = ready.map((i) => (i.result ? i.result.after.score : i.analysis!.score));
  const beforeBatch = batchScore(ready.map((i) => i.analysis!.score));
  const afterBatch = allCleaned ? batchScore(scores) : undefined;
  const anyShare = items.some((i) => i.mode === 'share');
  const failed = items.filter((i) => i.cleanError);

  const download = (i: Item) => {
    if (!i.result) return;
    const name = i.outName!;
    const go = () => saveBlob(new Blob([i.result!.bytes as BlobPart], { type: MIME[i.result!.outFormat] }), name);
    go(); setSaved({ name, again: go });
  };
  const downloadAll = (list: Item[]) => {
    const go = () => saveBlob(zipFiles(list.filter((i) => i.result).map((i) => ({ name: i.outName!, bytes: i.result!.bytes }))), 'hushprint-clean.zip');
    go(); setSaved({ name: 'hushprint-clean.zip', again: go });
  };

  const runClean = async (mode: Mode) => {
    setBusy(true);
    const share = mode === 'share';
    const used = new Set<string>();
    const done: Item[] = [];
    const todo = items.filter((i) => i.analysis).length;
    let n = 0;
    for (const i of items) {
      if (!i.analysis) { done.push(i); continue; }
      setProgress({ label: share ? 'Share-safe cleaning' : 'Cleaning', done: n++, total: todo });
      await tick();
      try {
        const bytes = new Uint8Array(await i.file.arrayBuffer());
        // share-safe drops the rotation tag too; when a photo is rotated that means baking it into the pixels (re-encode)
        const result = i.result && i.mode === mode ? i.result : await clean(bytes, i.file.name, { keepOrientation: share ? false : keepRotation, rasterize: share || !keepRotation || i.analysis.format === 'heic' ? rasterize : undefined });
        let outName = share ? randomName(result.outFormat) : cleanName(i.file.name, result.outFormat);
        if (!share) { const dir = i.path.includes('/') ? i.path.replace(/\/[^/]*$/, '/') : ''; outName = safeZipPath(dir + outName); }
        while (used.has(outName)) outName = outName.replace(/(-\d+)?(\.[^./]+)$/, (_, __, e) => `-${used.size + 1}${e}`);
        used.add(outName);
        done.push({ ...i, result, mode, outName, cleanError: undefined });
      } catch (e) {
        done.push({ ...i, result: undefined, cleanError: e instanceof NeedsReencode || e instanceof Error ? e.message : 'Cleaning failed.' });
      }
    }
    setItems(done);
    setProgress(undefined);
    setBusy(false);
    const ok = done.filter((i) => i.result);
    setAnnounce(`Cleaned ${ok.length} file${ok.length === 1 ? '' : 's'}. Re-scan done.`);
    navigator.vibrate?.([14, 50, 22]);
    if (ok.length === 1) download(ok[0]); else if (ok.length > 1) downloadAll(ok);
  };

  return (
    <div className={`app${drag ? ' dragging' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }} onDrop={onDrop}>
      <a className="skip" href="#main">Skip to content</a>
      <Header onProof={() => setProof(true)} />
      {progress && (
        <div className="progress" role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={progress.total || undefined} aria-valuenow={progress.total ? progress.done : undefined}>
          <span className="bar"><span className="fill" style={{ width: progress.total ? `${Math.round((progress.done / progress.total) * 100)}%` : '12%' }} /></span>
          <span className="plabel">{progress.label}{progress.total ? ` ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : '…'}</span>
        </div>
      )}
      {notice && <p className="notice" role="status">{notice} <button className="link inline" onClick={() => setNotice(undefined)}>Dismiss</button></p>}
      <main id="main" className={items.length ? 'loaded' : 'empty'}>
        {!items.length ? (
          <Empty onPick={() => input.current?.click()} onFolder={() => folderInput.current?.click()} onSample={loadSample} />
        ) : (
          <div className="workspace">
            <aside className="rail" aria-label="Files">
              <div className="rail-head">
                <h2>Roll <span className="count">{items.length} frame{items.length === 1 ? '' : 's'}</span></h2>
                <span className="rail-add"><button className="link" onClick={() => input.current?.click()}>+ Files</button><button className="link" onClick={() => folderInput.current?.click()}>+ Folder</button></span>
              </div>
              <div className="roll">
              <ul className="files">
                {items.map((i, n) => (
                  <li key={i.id}>
                    <button className={`file${i.id === cur?.id ? ' on' : ''}`} onClick={() => setSelected(i.id)} aria-current={i.id === cur?.id}>
                      <span className="fno" aria-hidden="true"><span>{'\u25B6'} {pad2(n + 1)}</span><span>{pad2(n + 1)}A</span></span>
                      {i.analysis && isPreviewable(i.analysis.format) ? <img src={i.url} alt="" className="fthumb" loading="lazy" decoding="async" /> : <span className="fthumb tile" aria-hidden="true">{i.analysis ? FORMAT_LABEL[i.analysis.format].slice(0, 4) : '···'}</span>}
                      <span className="fmeta">
                        <span className="fname">{i.file.name}</span>
                        <span className="fsub">{kb(i.file.size)}{i.result ? ` → ${kb(i.result.bytes.length)}` : ''}{i.analysis ? ` · ${i.result ? i.result.after.score : i.analysis.score}/100` : ''}</span>
                      </span>
                      {i.error || i.cleanError ? <span className="sev sev-high">{i.cleanError ? 'Not cleaned' : 'Can\u2019t read'}</span> : !i.analysis ? <span className="sev sev-info">Scanning</span>
                        : i.result ? <span className={`sev ${i.result.remaining.length ? 'sev-medium' : 'sev-clean'}`}><span aria-hidden="true">{i.result.remaining.length ? '!' : '✓'}</span> {i.result.remaining.length ? 'Partial' : 'Clean'}</span> : <Sev level={i.analysis.risk.level} />}
                    </button>
                  </li>
                ))}
              </ul>
              </div>
            </aside>
            <section className="report" aria-label="Report" key={cur?.id}>
              {cur && <Report item={cur} />}
            </section>
          </div>
        )}
        {items.length > 0 && (
          <div className="settings-row">
            {!allCleaned && (
              <div className="settings">
                <label className="check"><input type="checkbox" checked={keepRotation} onChange={(e) => setKeepRotation(e.target.checked)} /> <span>Keep photo orientation info <span className="hint">(recommended)</span></span></label>
                <p className="hint small">Photos are stored sideways with a &ldquo;rotate&rdquo; note. Off bakes the rotation into the pixels, which re-encodes rotated images.</p>
              </div>
            )}
            <button className="link subtle" onClick={reset}>Remove all &amp; start over</button>
          </div>
        )}
      </main>

      {items.length > 0 && (
        <div className="actionbar">
          <div className="ab-inner">
            <div className="ab-info">
              <strong>{allCleaned ? (failed.length ? 'Cleaned, with caveats' : 'All clean') : `${totalLeaks} leak${totalLeaks === 1 ? '' : 's'} found`}</strong>
              {beforeBatch !== undefined && <ScoreLine before={beforeBatch} after={afterBatch} batch={ready.length > 1} />}
              {allCleaned && saved
                ? <span className="saved"><span aria-hidden="true">{'\u2713'}</span> Saved<span className="sname"> {saved.name}</span> <button className="link inline" onClick={saved.again}>Download again</button></span>
                : <span>{ready.length} file{ready.length === 1 ? '' : 's'} stay{ready.length === 1 ? 's' : ''} on this device</span>}
            </div>
            <div className="ab-btns">
              {allCleaned && cur?.result && ready.length > 1 && <button className="btn ghost" onClick={() => download(cur)}>This file</button>}
              {allCleaned && <button className="btn primary" onClick={() => (ready.length > 1 ? downloadAll(ready) : download(ready[0]))}>{ready.length > 1 ? `Download all (${ready.length}) .zip` : 'Download clean copy'}</button>}
              {!allCleaned && <button className="btn primary" disabled={busy || !ready.length} onClick={() => void runClean('normal')}>{busy ? 'Cleaning…' : `Clean & download${ready.length > 1 ? ` (${ready.length})` : ''}`}</button>}
              {(!allCleaned || !anyShare) && <button className="btn ghost share" disabled={busy || !ready.length} onClick={() => void runClean('share')} title="Strips everything including the rotation tag, and gives every file a random name">Share-safe</button>}
            </div>
          </div>
        </div>
      )}

      {items.length > 0 && <Footer />}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,video/mp4,video/quicktime,.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,.docx,.xlsx,.pptx,.mp4,.mov,.m4v" multiple hidden onChange={(e) => { void addFiles(fromInput([...(e.target.files ?? [])])); e.target.value = ''; }} />
      <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={(e) => { const all = [...(e.target.files ?? [])]; const ok = all.filter((f) => EXTENSIONS.test(f.name)); void addFiles(fromInput(ok), all.length - ok.length); e.target.value = ''; }} />
      <div className="sr" role="status" aria-live="polite">{announce}</div>
      {drag && <div className="dropveil" aria-hidden="true"><span>Drop to scan. Nothing is uploaded.</span></div>}
      {proof && <Proof onClose={() => setProof(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

const ScoreLine = ({ before, after, batch }: { before: number; after?: number; batch: boolean }) => (
  <span className="scoreline" aria-label={`${batch ? 'Batch privacy score' : 'Privacy score'} ${before}${after !== undefined ? ` to ${after}` : ''} out of 100`}>
    {batch ? 'Batch score' : 'Privacy score'} <b className={`band-${scoreBand(before)}`}>{before}</b>
    {after !== undefined && <> <span aria-hidden="true">{'\u2192'}</span> <b className={`band-${scoreBand(after)}`}>{after}</b></>}<span className="of">/100</span>
  </span>
);

function Header({ onProof }: { onProof: () => void }) {
  return (
    <header className="top">
      <a className="brand" href="/" aria-label="Hushprint home">
        <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><path d="M5 11V5h6M21 5h6v6M27 21v6h-6M11 27H5v-6" fill="none" stroke="currentColor" strokeWidth="2.6" /><path d="M11 21 21 11" stroke="currentColor" strokeWidth="3" className="mark-c" /></svg>
        <span>HUSHPRINT</span>
      </a>
      <button className="proofbtn" onClick={onProof} aria-haspopup="dialog">
        <span className="pill-long">Zero uploads.&nbsp;</span><u>Prove it</u>
      </button>
    </header>
  );
}

function Empty({ onPick, onFolder, onSample }: { onPick: () => void; onFolder: () => void; onSample: () => void }) {
  return (
    <div className="hero">
      <div className="hero-main">
        <p className="eyebrow">File privacy check</p>
        <h1>See what your files <span className="mk">give away.<svg viewBox="0 0 300 14" preserveAspectRatio="none" aria-hidden="true"><path d="M2 9 C 60 3, 120 12, 180 6 S 270 4, 298 8" /></svg></span></h1>
        <p className="steps" aria-label="How it works"><b>Drop</b> {'→'} <b>See</b> {'→'} <b>Clean</b></p>
        <p className="lede">Photos, PDFs, Office files and videos carry hidden data: the GPS spot where you stood, your phone&rsquo;s serial number, the author&rsquo;s name, the exact second, and a copy of what you cropped out. Drop a file to see what it gives away. Then strip it.</p>
        <button className="drop" onClick={onPick} aria-label="Choose files to scan. You can also drag and drop files or a folder here.">
          <span className="drop-window">
            <span className="drop-title">Drop files or a whole folder</span>
            <span className="drop-sub">or tap here to choose. Photos, PDF, Office, video.</span>
          </span>
        </button>
        <div className="hero-actions">
          <button className="btn primary" onClick={onSample}>Try a sample with GPS</button>
          <button className="btn ghost" onClick={onFolder}>Choose a folder</button>
        </div>
        <p className="fine">Files are read in your browser and never sent anywhere. The page&rsquo;s security policy forbids network requests entirely.</p>
        <p className="fine limits"><b>Limits.</b> Hushprint removes metadata, not what is visible in the picture, page or video. HEIC export re-encodes to JPEG, and some PDF and video leaks are shown but cannot be removed losslessly.</p>
      </div>
      <aside className="specimen sheet" aria-label="Example of what a photo can reveal">
        <p className="sheet-head"><span>Contact sheet</span><span>Specimen. Not your file.</span></p>
        <div className="print">
          <div className="spec-map"><WorldMap point={{ lat: 33.785, lon: -84.374 }} label="33.785° N, 84.374° W" /></div>
          <p className="note spec-note">Street-level. One house.</p>
        </div>
        <table className="spec-table">
          <tbody>
            <tr><th scope="row">Where</th><td><Sev level="critical" /></td><td>Street-level GPS</td></tr>
            <tr><th scope="row">Who</th><td><Sev level="high" /></td><td>Owner name, serial no.</td></tr>
            <tr><th scope="row">Leftover</th><td><Sev level="high" /></td><td>Hidden uncropped thumbnail</td></tr>
            <tr><th scope="row">When</th><td><Sev level="medium" /></td><td>Date and time to the second</td></tr>
            <tr><th scope="row">What</th><td><Sev level="medium" /></td><td>Phone make &amp; model</td></tr>
          </tbody>
        </table>
      </aside>
    </div>
  );
}

function Report({ item }: { item: Item }) {
  const a = item.analysis;
  const done = !!item.result;
  // play the redaction, stamp the result, then fold the per-category detail away so the clean state stays short
  const [folded, setFolded] = useState(done);
  const [all, setAll] = useState(false);
  const narrow = useNarrow();
  useEffect(() => { if (!done) return; const t = setTimeout(() => setFolded(true), 2600); return () => clearTimeout(t); }, [done]);
  if (item.error) return <div className="verdict sheet sev-bg-high"><p className="eyebrow">{item.file.name}</p><h2>We couldn&rsquo;t scan this file.</h2><p className="lede">{item.error}</p></div>;
  if (!a) return <div className="verdict sheet"><p className="eyebrow">{item.file.name}</p><h2>Scanning&hellip;</h2></div>;
  const leaks = a.findings.filter((f) => f.label !== 'Orientation');
  const counts = (['critical', 'high', 'medium', 'low'] as Severity[]).map((s) => [s, leaks.filter((f) => f.severity === s).length] as const).filter(([, n]) => n);
  const groups = (Object.keys(CATEGORY_TITLE) as Category[])
    .map((cat) => ({ cat, list: a.findings.filter((f) => f.category === cat && f.label !== 'Orientation') }))
    .filter((g) => g.list.length)
    .sort((x, y) => Math.max(...y.list.map((f) => RANK[f.severity])) - Math.max(...x.list.map((f) => RANK[f.severity])));
  let order = 0;
  const showMap = !folded && !done && !!a.gps;
  const score = done ? item.result!.after.score : a.score;
  const partial = done && item.result!.remaining.length > 0;

  const cardsEl = (
      <div className="cards" hidden={folded}>
        {groups.length === 0 && <p className="nothing">No metadata fields found. This image is already quiet.</p>}
        {(all ? groups : groups.slice(0, narrow ? 1 : 2)).map(({ cat, list }) => {
          const top = list.reduce<Severity>((m, f) => (RANK[f.severity] > RANK[m] ? f.severity : m), 'info');
          return (
            <section key={cat} className={`card${done ? ' scrubbed' : ''}`}>
              <header><h3>{CATEGORY_TITLE[cat]}</h3><Sev level={top} /></header>
              <dl>
                {list.map((f) => <Row key={f.id} f={f} i={order++} />)}
              </dl>
            </section>
          );
        })}
      </div>
  );

  return (
    <>
      <div className={`lead${showMap || (done && !folded) ? ' with-map' : ''}`}>
        <div className={`verdict sheet ${done ? 'sev-bg-clean' : `sev-bg-${a.risk.level}`}`}>
          <div className="v-head">
            <p className="eyebrow">{a.name} {'·'} {FORMAT_LABEL[a.format]}{a.detail ? ` · ${a.detail}` : ''}{a.width ? ` · ${a.width}×${a.height}` : ''} {'·'} {kb(a.size)}</p>
            {done ? (partial ? <span className="sev sev-medium big"><span aria-hidden="true">!</span> Partly clean</span> : <span className="sev sev-clean big"><span aria-hidden="true">{'✓'}</span> Clean</span>) : <Sev level={a.risk.level} big />}
          </div>
          <div className="scorebox" role="group" aria-label="Privacy score">
            <span className={`scorenum band-${scoreBand(score)}`}><span className="digits">{score}{!done && a.gps && <Scribble />}</span><small>/100</small></span>
            <span className="scoretxt">Privacy score{done && <> {'·'} was <b>{a.score}</b></>}<br /><em>{BAND_LABEL[scoreBand(score)]}</em></span>
            {!done && a.gps && <span className="note score-note">GPS. 25 at best.</span>}
            {done && item.result && <Stamp r={item.result} partial={partial} />}
          </div>
          <h2>{done ? (partial ? `Cleaned. ${item.result!.remaining.length} thing${item.result!.remaining.length > 1 ? 's' : ''} Hushprint cannot remove.` : 'Nothing identifying is left in this file.') : a.risk.headline}</h2>
          {!done && a.risk.bullets.length > 0 && <ul className="bullets">{a.risk.bullets.map((b) => <li key={b}>{b}</li>)}</ul>}
          {!done && counts.length > 0 && <p className="counts">{counts.map(([s, n]) => <span key={s} className={`c-${s}`}>{n} {s}</span>)}</p>}
          {done && item.result && <Verified r={item.result} partial={partial} />}
          {a.warnings.length > 0 && <p className="warn">{a.warnings.join(' ')}</p>}
        </div>
        {done && !folded && cardsEl}
        {showMap && a.gps && (
          <div className={`panel sheet map-panel${done ? ' removed' : ''}`}>
            <p className="sheet-head"><span>Location</span>{done ? <span className="tag-clean">Removed</span> : <span>Finding 1</span>}</p>
            <div className="map-wrap print">
              <WorldMap point={a.gps} label={nearestCity(a.gps)[0] ? `near ${nearestCity(a.gps)[0].name}` : undefined} />
              <div className="radar-wrap"><Radar point={a.gps} cities={nearestCity(a.gps, 3)} /></div>
              {!done && <p className="note map-note">{a.gps.accuracyM ? `Within ${Math.round(a.gps.accuracyM)} m.` : 'Picks out one house.'}</p>}
            </div>
            <p className="coord"><span className="val">{formatCoord(a.gps)}</span></p>
            <p className="sub">{done ? 'Not present in the clean copy.' : ''}{!done && a.gps.nearest[0] ? `${formatDistance(a.gps.nearest[0].km)} from ${a.gps.nearest[0].name}. ` : ''}{!done && (a.gps.accuracyM ? `Accurate to about ${Math.round(a.gps.accuracyM)} m.` : 'Phone GPS is typically accurate to a few metres: enough to pick out one house.')}</p>
          </div>
        )}
      </div>

      {item.cleanError && <div className="verdict sheet sev-bg-high"><h2>Not cleaned.</h2><p className="lede">{item.cleanError}</p></div>}
      {!folded && a.thumbnail && isPreviewable(a.format) && (
        <div className={`panel sheet thumb-panel${done ? ' removed' : ''}`}>
          <p className="sheet-head"><span>Hidden preview</span>{done ? <span className="tag-clean">Removed</span> : <span>Finding 2</span>}</p>
          <div className="compare">
            <figure><div className="print"><img src={item.url} alt="The photo as it appears" /></div><figcaption><b>What you cropped to</b>The photo as you see it.</figcaption></figure>
            {item.thumbUrl && (
              <figure className={a.thumbnail.mismatch ? 'leaky' : ''}>
                <div className="print"><img src={item.thumbUrl} alt="The thumbnail hidden inside the file" />{a.thumbnail.mismatch && !done && <><Scribble /><span className="note thumb-note">Cropped out. Still here.</span></>}</div>
                <figcaption><b>What&rsquo;s still inside</b>{a.thumbnail.width ? `${a.thumbnail.width}×${a.thumbnail.height} copy stored in the file.` : 'A copy stored in the file.'}</figcaption>
              </figure>
            )}
          </div>
          <p className="sub">{done ? 'The hidden preview is gone from the clean copy.' : a.thumbnail.mismatch ? 'The embedded thumbnail is a different shape, so it was captured before the crop. It can show exactly what you cut out.' : 'A small copy of the photo travels inside the file. If you edit or redact the picture, this copy can still show the original.'}</p>
        </div>
      )}

      {!(done && !folded) && cardsEl}

      {!all && !folded && groups.length > (narrow ? 1 : 2) && (
        <button className="btn ghost seeall" onClick={() => setAll(true)}>See all {leaks.length} leaks</button>
      )}

      {done && item.result && <Diff r={item.result} />}
    </>
  );
}

function Row({ f, i }: { f: Finding; i: number }) {
  const mark = f.severity === 'critical' || f.severity === 'high';
  return (
    <div className="row" style={{ '--i': i } as CSSProperties}>
      <dt>{f.label}</dt>
      <dd>
        <span className="val"><span className="txt">{f.value}</span><span className="gone" aria-hidden="true">removed</span>{mark && <Scribble />}</span>
        <span className="why"><span className={`rank r-${f.severity}`}>{SEV_LABEL[f.severity]}.</span> {f.why} <span className="src">{f.source}</span>{f.removable === false && <span className="stuck"> Not removable by Hushprint</span>}</span>
      </dd>
    </div>
  );
}

const CONTENT: Record<string, string> = { pdf: 'Every page, font and image', docx: 'Document body and media', xlsx: 'Sheets and media', pptx: 'Slides and media', mp4: 'Audio and video streams', webp: 'Pixels', png: 'Pixels', jpeg: 'Pixels', heic: 'Pixels' };
function Stamp({ r, partial }: { r: CleanResult; partial: boolean }) {
  const left = r.after.findings.filter((x) => x.label !== 'Orientation' && x.removable !== false).length;
  return (
    <div className={`stamp${partial ? ' partial' : ''}`} role="img" aria-label={partial ? 'Stamped: partly clean' : 'Stamped: clean'}>
      <span>{partial ? 'Partly clean' : 'Clean'}</span>
      <small>Re-scan: {left} left<br />Checksum: {r.reencoded ? 'not identical' : r.pixelsIdentical ? 'identical' : 'changed'}</small>
    </div>
  );
}
function Verified({ r, partial }: { r: CleanResult; partial: boolean }) {
  const f = r.before.format;
  const left = r.after.findings.filter((x) => x.label !== 'Orientation' && x.removable !== false).length;
  const pixels = f === 'jpeg' || f === 'png' || f === 'webp' || f === 'heic';
  return (
    <div className="proof-wrap">
      <dl className="slip">
        <div><dt>Re-scan</dt><dd>Found <b>{left}</b> remaining. {r.removed.length} field{r.removed.length === 1 ? '' : 's'} removed.</dd></div>
        <div><dt>{pixels ? 'Pixel' : 'Content'} checksum</dt>
          <dd>{r.reencoded
            ? <><b className="warnline">Not identical.</b> {f === 'heic' ? 'HEIC was decoded and saved again as JPEG, and colours are converted to sRGB.' : 'The rotation was baked into the pixels, so the image was decoded and saved again.'}</>
            : <>{CONTENT[f]}: {r.pixelsIdentical ? <b>identical</b> : <b className="bad">changed</b>}. No re-compression, no quality loss.</>}</dd></div>
        <div><dt>Size</dt><dd>{r.orientationKept > 1 ? 'Rotation tag kept' : 'No rotation tag left'} {'·'} {kb(r.before.size)} {'→'} {kb(r.bytes.length)}</dd></div>
      </dl>
      {r.remaining.length > 0 && (
        <div className="caveats"><b>Still in the file (Hushprint cannot remove these):</b>
          <ul>{r.remaining.map((x) => <li key={x.id}>{x.label}: {x.value}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function Diff({ r }: { r: CleanResult }) {
  return (
    <details className="diff sheet" open>
      <summary>Before / after <span className="count">{r.removed.length + (r.orientationKept > 1 ? 1 : 0)} fields</span></summary>
      <div className="table-wrap">
        <table>
          <thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After (re-scanned)</th></tr></thead>
          <tbody>
            {r.removed.map((f) => <tr key={f.id}><th scope="row">{f.label}</th><td className="before">{f.value}</td><td className="after"><span aria-hidden="true">{'✓'}</span> removed</td></tr>)}
            {r.orientationKept > 1 && <tr><th scope="row">Orientation</th><td className="before">{r.orientationKept} (rotated)</td><td className="after keep">kept on purpose</td></tr>}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <p><b>Limits.</b> Hushprint removes metadata from the file, not what is visible in the picture, page or video (faces, street signs, reflections, text). HEIC export re-encodes to JPEG. Some PDF and video leaks are shown but cannot be removed losslessly.</p>
    </footer>
  );
}

function Proof({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [result, setResult] = useState<string>();
  const csp = useMemo(() => document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content, []);
  useEffect(() => { ref.current?.showModal(); }, []);
  const test = async () => {
    setResult('Trying to send a request…');
    let violated = '';
    const onV = (e: SecurityPolicyViolationEvent) => { violated = e.violatedDirective; };
    document.addEventListener('securitypolicyviolation', onV);
    let outcome = 'unknown';
    try { await fetch('https://hushprint.invalid/beacon', { method: 'POST', body: 'test' }); outcome = 'sent'; } catch { outcome = 'blocked'; }
    await new Promise((r) => setTimeout(r, 100));
    document.removeEventListener('securitypolicyviolation', onV);
    setResult(outcome === 'blocked' && violated ? `Blocked by your browser before leaving the page (violated: ${violated}).` : outcome === 'blocked' ? 'The request failed.' : 'Request was NOT blocked. Something is wrong.');
  };
  return (
    <dialog ref={ref} className="proof" onClose={onClose} onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }} aria-labelledby="proof-h">
      <div className="proof-body">
        <h2 id="proof-h">Don&rsquo;t trust us. Check.</h2>
        <ol>
          <li>Your files are read with the browser&rsquo;s File API, parsed and rewritten in this tab&rsquo;s memory.</li>
          <li>The page ships a Content-Security-Policy with <code>connect-src &#39;none&#39;</code>. The browser itself refuses every fetch, XHR, WebSocket and beacon.</li>
          <li>Maps are an offline dot grid compiled into the code. No tile server, no analytics, no fonts from a CDN.</li>
          <li>Open DevTools, Network tab, then clean a photo. You will see zero requests.</li>
        </ol>
        <pre className="csp" tabIndex={0}>{csp ?? 'No policy in the dev server. Production builds inject it.'}</pre>
        <div className="proof-actions">
          <button className="btn ghost" onClick={() => void test()} disabled={!csp}>Try to send data out</button>
          <button className="btn primary" onClick={() => ref.current?.close()}>Close</button>
        </div>
        {result && <p className="proof-result" role="status">{result}</p>}
      </div>
    </dialog>
  );
}
