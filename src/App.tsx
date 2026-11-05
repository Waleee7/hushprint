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

let uid = 0;

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
          <Empty onPick={() => input.current?.click()} onSample={loadSample} />
        ) : (
          <div className="workspace">
            <aside className="rail" aria-label="Files">
              <div className="rail-head">
                <h2>Files <span className="count">{items.length}</span>{items.length > 1 && <span className="swipe">swipe {'\u2192'}</span>}</h2>
                <span className="rail-add"><button className="link" onClick={() => input.current?.click()}>+ Files</button><button className="link" onClick={() => folderInput.current?.click()}>+ Folder</button></span>
              </div>
              <ul className="files">
                {items.map((i) => (
                  <li key={i.id}>
                    <button className={`file${i.id === cur?.id ? ' on' : ''}`} onClick={() => setSelected(i.id)} aria-current={i.id === cur?.id}>
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
              <div className="settings">
                <label className="check"><input type="checkbox" checked={keepRotation} disabled={allCleaned} onChange={(e) => setKeepRotation(e.target.checked)} /> <span>Keep rotation tag <span className="hint">(recommended)</span></span></label>
                <p className="hint small">Off bakes the rotation into the pixels, which re-encodes rotated images.</p>
              </div>
              <button className="link subtle" onClick={reset}>Remove all &amp; start over</button>
            </aside>
            <section className="report" aria-label="Report" key={cur?.id}>
              {cur && <Report item={cur} />}
            </section>
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

      <Footer />
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
        <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><path d="M5 11V5h6M21 5h6v6M27 21v6h-6M11 27H5v-6" fill="none" stroke="currentColor" strokeWidth="2.6" className="mark-c" /><path d="M11 21 21 11" stroke="currentColor" strokeWidth="2.6" /></svg>
        <span>HUSHPRINT</span>
      </a>
      <button className="pill" onClick={onProof} aria-haspopup="dialog">
        <span className="dot" aria-hidden="true" /> <span className="pill-long">Zero uploads.&nbsp;</span><u>Prove it</u>
      </button>
    </header>
  );
}

function Empty({ onPick, onSample }: { onPick: () => void; onSample: () => void }) {
  return (
    <div className="hero">
      <div className="hero-main">
        <p className="eyebrow">File privacy check {'·'} v2</p>
        <h1>Your photos talk.<br /><em>Make them hush.</em></h1>
        <p className="steps" aria-label="How it works"><b>Drop</b> {'·'} <b>See</b> {'·'} <b>Clean</b></p>
        <p className="lede">Every photo, PDF, Office file and video you share can carry the GPS spot you stood on, your phone&rsquo;s serial number, the author&rsquo;s name, the second it was made, and a hidden copy of whatever you cropped out. Drop it in to see exactly what it gives away, then wipe it.</p>
        <button className="drop" onClick={onPick} aria-label="Choose photos to scan. You can also drag and drop files here.">
          <span className="corners" aria-hidden="true" />
          <span className="drop-title">Drop files or a whole folder</span>
          <span className="drop-sub">or tap to choose from your library {'·'} photos, PDF, Office, video {'·'} folders OK</span>
        </button>
        <div className="hero-actions">
          <button className="btn primary" onClick={onPick}>Choose files</button>
          <button className="btn ghost" onClick={onSample}>Try a sample with GPS</button>
        </div>
        <p className="fine">Files are read in your browser and never sent anywhere. The page&rsquo;s security policy forbids network requests entirely.</p>
      </div>
      <aside className="specimen" aria-label="Example of what a photo can reveal">
        <p className="eyebrow">Specimen {'·'} illustration</p>
        <div className="spec-map"><WorldMap point={{ lat: 33.785, lon: -84.374 }} label="33.785° N, 84.374° W" /></div>
        <table className="spec-table">
          <tbody>
            <tr><th>Where</th><td><Sev level="critical" /></td><td>Street-level GPS</td></tr>
            <tr><th>Who</th><td><Sev level="high" /></td><td>Owner name, serial no.</td></tr>
            <tr><th>Leftover</th><td><Sev level="high" /></td><td>Hidden uncropped thumbnail</td></tr>
            <tr><th>When</th><td><Sev level="medium" /></td><td>Date and time to the second</td></tr>
            <tr><th>What</th><td><Sev level="medium" /></td><td>Phone make &amp; model</td></tr>
          </tbody>
        </table>
      </aside>
    </div>
  );
}

function Report({ item }: { item: Item }) {
  const a = item.analysis;
  const done = !!item.result;
  // play the scrub animation, then fold the per-category detail away so the clean state stays short
  const [folded, setFolded] = useState(done);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setFolded(true), 1900); return () => clearTimeout(t); }, [done]);
  if (item.error) return <div className="verdict sev-bg-high"><p className="eyebrow">{item.file.name}</p><h2>We couldn&rsquo;t scan this file.</h2><p className="lede">{item.error}</p></div>;
  if (!a) return <div className="verdict"><p className="eyebrow">{item.file.name}</p><h2>Scanning&hellip;</h2></div>;
  const leaks = a.findings.filter((f) => f.label !== 'Orientation');
  const counts = (['critical', 'high', 'medium', 'low'] as Severity[]).map((s) => [s, leaks.filter((f) => f.severity === s).length] as const).filter(([, n]) => n);
  const groups = (Object.keys(CATEGORY_TITLE) as Category[])
    .map((cat) => ({ cat, list: a.findings.filter((f) => f.category === cat && f.label !== 'Orientation') }))
    .filter((g) => g.list.length)
    .sort((x, y) => Math.max(...y.list.map((f) => RANK[f.severity])) - Math.max(...x.list.map((f) => RANK[f.severity])));
  let order = 0;

  return (
    <>
      <div className={`verdict ${done ? 'sev-bg-clean' : `sev-bg-${a.risk.level}`}`}>
        <div className="v-head">
          <p className="eyebrow">{a.name} {'·'} {FORMAT_LABEL[a.format]}{a.detail ? ` · ${a.detail}` : ''}{a.width ? ` · ${a.width}\u00d7${a.height}` : ''} {'·'} {kb(a.size)}</p>
          {done ? (item.result!.remaining.length ? <span className="sev sev-medium big"><span aria-hidden="true">!</span> Partly clean</span> : <span className="sev sev-clean big"><span aria-hidden="true">{'✓'}</span> Clean</span>) : <Sev level={a.risk.level} big />}
        </div>
        <div className="scorebox" role="group" aria-label="Privacy score">
          <span className={`scorenum band-${scoreBand(done ? item.result!.after.score : a.score)}`}>{done ? item.result!.after.score : a.score}<small>/100</small></span>
          <span className="scoretxt">Privacy score{done && <> {'·'} was <b>{a.score}</b></>}<br /><em>{BAND_LABEL[scoreBand(done ? item.result!.after.score : a.score)]}</em></span>
        </div>
        <h2>{done ? (item.result!.remaining.length ? `Cleaned. ${item.result!.remaining.length} thing${item.result!.remaining.length > 1 ? 's' : ''} Hushprint cannot remove.` : 'Clean. Nothing identifying is left in this file.') : a.risk.headline}</h2>
        {!done && a.risk.bullets.length > 0 && <ul className="bullets">{a.risk.bullets.map((b) => <li key={b}>{b}</li>)}</ul>}
        {!done && counts.length > 0 && <p className="counts">{counts.map(([s, n]) => <span key={s} className={`c-${s}`}>{n} {s}</span>)}</p>}
        {done && item.result && <Verified r={item.result} />}
        {a.warnings.length > 0 && <p className="warn">{a.warnings.join(' ')}</p>}
      </div>

      {item.cleanError && <div className="verdict sev-bg-high"><h2>Not cleaned.</h2><p className="lede">{item.cleanError}</p></div>}
      {!folded && (a.gps || (a.thumbnail && isPreviewable(a.format))) && (
        <div className="panels">
          {a.gps && (
            <div className={`panel map-panel${done ? ' removed' : ''}`}>
              <h3>Location {done && <span className="tag-clean">removed</span>}</h3>
              <div className="map-wrap">
                <WorldMap point={a.gps} label={nearestCity(a.gps)[0] ? `near ${nearestCity(a.gps)[0].name}` : undefined} />
                <div className="radar-wrap"><Radar point={a.gps} cities={nearestCity(a.gps, 3)} /></div>
              </div>
              <p className="coord">{formatCoord(a.gps)}</p>
              <p className="sub">{done ? 'Not present in the clean copy.' : ''}{!done && a.gps.nearest[0] ? `${formatDistance(a.gps.nearest[0].km)} from ${a.gps.nearest[0].name}. ` : ''}{!done && (a.gps.accuracyM ? `Accurate to about ${Math.round(a.gps.accuracyM)} m.` : 'Phone GPS is typically accurate to a few metres: enough to pick out one house.')}</p>
            </div>
          )}
          {a.thumbnail && isPreviewable(a.format) && (
            <div className={`panel thumb-panel${done ? ' removed' : ''}`}>
              <h3>Hidden preview {done && <span className="tag-clean">removed</span>}</h3>
              <div className="compare">
                <figure><img src={item.url} alt="The photo as it appears" /><figcaption>What you see</figcaption></figure>
                {item.thumbUrl && <figure className={a.thumbnail.mismatch ? 'leaky' : ''}><img src={item.thumbUrl} alt="The thumbnail hidden inside the file" /><figcaption>What&rsquo;s hiding inside{a.thumbnail.width ? ` (${a.thumbnail.width}×${a.thumbnail.height})` : ''}</figcaption></figure>}
              </div>
              <p className="sub">{done ? 'The hidden preview is gone from the clean copy.' : a.thumbnail.mismatch ? 'The embedded thumbnail is a different shape, so it was captured before the crop. It can show exactly what you cut out.' : 'A small copy of the photo travels inside the file. If you edit or redact the picture, this copy can still show the original.'}</p>
            </div>
          )}
        </div>
      )}

      <div className="cards" hidden={folded}>
        {groups.length === 0 && <p className="nothing">No metadata fields found. This image is already quiet.</p>}
        {groups.map(({ cat, list }) => {
          const top = list.reduce<Severity>((m, f) => (RANK[f.severity] > RANK[m] ? f.severity : m), 'info');
          return (
            <section key={cat} className={`card${done ? ' scrubbed' : ''}`} style={{ '--c': `var(--${top})` } as CSSProperties}>
              <header><h3>{CATEGORY_TITLE[cat]}</h3><Sev level={top} /></header>
              <dl>
                {list.map((f) => <Row key={f.id} f={f} i={order++} />)}
              </dl>
            </section>
          );
        })}
      </div>

      {done && item.result && <Diff r={item.result} />}
    </>
  );
}

function Row({ f, i }: { f: Finding; i: number }) {
  return (
    <div className="row" style={{ '--i': i } as CSSProperties}>
      <dt><span className={`dotsev d-${f.severity}`} aria-label={SEV_LABEL[f.severity]} title={SEV_LABEL[f.severity]} />{f.label}</dt>
      <dd>
        <span className="val"><span className="txt">{f.value}</span><span className="gone" aria-hidden="true">removed</span></span>
        <span className="why">{f.why} <span className="src">{f.source}</span>{f.removable === false && <span className="stuck"> not removable by Hushprint</span>}</span>
      </dd>
    </div>
  );
}

const CONTENT: Record<string, string> = { pdf: 'Every page, font and image', docx: 'Document body and media', xlsx: 'Sheets and media', pptx: 'Slides and media', mp4: 'Audio and video streams', webp: 'Pixels', png: 'Pixels', jpeg: 'Pixels', heic: 'Pixels' };
function Verified({ r }: { r: CleanResult }) {
  const f = r.before.format;
  return (
    <>
      <ul className="proof-list">
        <li><b>{r.removed.length}</b> fields removed, re-scanned: <b>{r.after.findings.filter((x) => x.label !== 'Orientation' && x.removable !== false).length}</b> removable ones remain</li>
        {r.reencoded
          ? <li className="warnline"><b>Re-encoded.</b> {f === 'heic' ? 'HEIC was decoded and saved again as JPEG, so the pixels are not byte-identical and colours are converted to sRGB.' : 'The rotation was baked into the pixels, so the image was decoded and saved again (not byte-identical).'}</li>
          : <li>{CONTENT[f]} {r.pixelsIdentical ? <b>byte-identical</b> : <b className="bad">changed</b>} (no re-compression, no quality loss)</li>}
        <li>{r.orientationKept > 1 ? 'Rotation tag kept' : 'No rotation tag left'} {'·'} {kb(r.before.size)} {'→'} {kb(r.bytes.length)}</li>
      </ul>
      {r.remaining.length > 0 && (
        <div className="caveats"><b>Still in the file (Hushprint cannot remove these):</b>
          <ul>{r.remaining.map((x) => <li key={x.id}>{x.label}: {x.value}</li>)}</ul>
        </div>
      )}
    </>
  );
}

function Diff({ r }: { r: CleanResult }) {
  return (
    <details className="diff" open>
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
      <p><b>Honest limits.</b> Hushprint removes metadata from the file, not what is visible in the picture, page or video (faces, street signs, reflections, text). HEIC export re-encodes to JPEG. Some PDF and video leaks are shown but cannot be removed losslessly.</p>
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
