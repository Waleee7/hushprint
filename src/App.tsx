import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { CATEGORY_TITLE, RANK, analyze, clean, type Analysis, type Category, type CleanResult, type Finding, type Severity } from './engine/analyze.ts';
import { formatCoord, formatDistance, nearestCity } from './engine/geo.ts';
import { Radar, WorldMap } from './GeoMap.tsx';
import { cleanName, mimeFor, saveBlob, zipFiles } from './download.ts';
import { makeSampleFiles } from './sample.ts';

interface Item {
  id: string; file: File; bytes?: Uint8Array; analysis?: Analysis; error?: string; result?: CleanResult;
  url: string; thumbUrl?: string;
}

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
  const input = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(async (files: File[]) => {
    const news: Item[] = files.slice(0, 40).map((file) => ({ id: `f${++uid}`, file, url: URL.createObjectURL(file) }));
    if (!news.length) return;
    setItems((p) => [...p, ...news]);
    setSelected((s) => s ?? news[0].id);
    for (const n of news) {
      let patch: Partial<Item>;
      try {
        const bytes = new Uint8Array(await n.file.arrayBuffer());
        const analysis = await analyze(bytes, n.file.name);
        patch = { bytes, analysis, thumbUrl: analysis.thumbnail ? URL.createObjectURL(new Blob([analysis.thumbnail.bytes as BlobPart], { type: 'image/jpeg' })) : undefined };
      } catch (e) { patch = { error: e instanceof Error ? e.message : 'Could not read this file.' }; }
      setItems((p) => p.map((x) => (x.id === n.id ? { ...x, ...patch } : x)));
    }
    setAnnounce(`${news.length} file${news.length > 1 ? 's' : ''} scanned.`);
  }, []);

  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); void addFiles([...e.dataTransfer.files]); };
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    window.addEventListener('dragover', stop); window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);

  const loadSample = async () => { void addFiles(await makeSampleFiles()); };
  const reset = () => { items.forEach((i) => { URL.revokeObjectURL(i.url); if (i.thumbUrl) URL.revokeObjectURL(i.thumbUrl); }); setItems([]); setSelected(undefined); };

  const ready = items.filter((i) => i.analysis);
  const allCleaned = ready.length > 0 && ready.every((i) => i.result);
  const cur = items.find((i) => i.id === selected) ?? items[0];
  const totalLeaks = ready.reduce((n, i) => n + i.analysis!.findings.filter((f) => f.label !== 'Orientation').length, 0);

  const download = (i: Item) => i.result && saveBlob(new Blob([i.result.bytes as BlobPart], { type: mimeFor(i.analysis!.format) }), cleanName(i.file.name));
  const downloadAll = (list: Item[]) => saveBlob(zipFiles(list.filter((i) => i.result).map((i) => ({ name: cleanName(i.file.name), bytes: i.result!.bytes }))), 'hushprint-clean.zip');

  const runClean = async () => {
    setBusy(true);
    const done: Item[] = [];
    for (const i of items) {
      if (!i.bytes || !i.analysis) { done.push(i); continue; }
      try { done.push({ ...i, result: i.result ?? await clean(i.bytes, i.file.name, { keepOrientation: keepRotation }) }); }
      catch (e) { done.push({ ...i, error: e instanceof Error ? e.message : 'Cleaning failed.' }); }
    }
    setItems(done);
    setBusy(false);
    const ok = done.filter((i) => i.result);
    setAnnounce(`Cleaned ${ok.length} file${ok.length === 1 ? '' : 's'}. Re-scan found no identifying data.`);
    navigator.vibrate?.([14, 50, 22]); // light "done" haptic where supported (Android); silently ignored elsewhere
    if (ok.length === 1) download(ok[0]); else if (ok.length > 1) downloadAll(ok);
  };

  return (
    <div className={`app${drag ? ' dragging' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }} onDrop={onDrop}>
      <a className="skip" href="#main">Skip to content</a>
      <Header onProof={() => setProof(true)} />
      <main id="main" className={items.length ? 'loaded' : 'empty'}>
        {!items.length ? (
          <Empty onPick={() => input.current?.click()} onSample={loadSample} />
        ) : (
          <div className="workspace">
            <aside className="rail" aria-label="Files">
              <div className="rail-head">
                <h2>Files <span className="count">{items.length}</span></h2>
                <button className="link" onClick={() => input.current?.click()}>+ Add</button>
              </div>
              <ul className="files">
                {items.map((i) => (
                  <li key={i.id}>
                    <button className={`file${i.id === cur?.id ? ' on' : ''}`} onClick={() => setSelected(i.id)} aria-current={i.id === cur?.id}>
                      <img src={i.url} alt="" className="fthumb" />
                      <span className="fmeta">
                        <span className="fname">{i.file.name}</span>
                        <span className="fsub">{kb(i.file.size)}{i.result ? ` → ${kb(i.result.bytes.length)}` : ''}</span>
                      </span>
                      {i.error ? <span className="sev sev-high">Can&rsquo;t read</span> : !i.analysis ? <span className="sev sev-info">Scanning</span>
                        : i.result ? <span className="sev sev-clean"><span aria-hidden="true">{'✓'}</span> Clean</span> : <Sev level={i.analysis.risk.level} />}
                    </button>
                  </li>
                ))}
              </ul>
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
              <strong>{allCleaned ? 'All clean' : `${totalLeaks} leak${totalLeaks === 1 ? '' : 's'} found`}</strong>
              <span>{ready.length} file{ready.length === 1 ? '' : 's'} {'·'} stays on this device</span>
            </div>
            <label className="check"><input type="checkbox" checked={keepRotation} disabled={allCleaned} onChange={(e) => setKeepRotation(e.target.checked)} /> Keep rotation</label>
            {allCleaned ? (
              <div className="ab-btns">
                {cur?.result && ready.length > 1 && <button className="btn ghost" onClick={() => download(cur)}>This file</button>}
                <button className="btn primary" onClick={() => (ready.length > 1 ? downloadAll(ready) : download(ready[0]))}>
                  {ready.length > 1 ? `Download all (${ready.length}) .zip` : 'Download clean copy'}
                </button>
              </div>
            ) : (
              <button className="btn primary" disabled={busy || !ready.length} onClick={() => void runClean()}>{busy ? 'Cleaning…' : `Clean & download${ready.length > 1 ? ` (${ready.length})` : ''}`}</button>
            )}
          </div>
        </div>
      )}

      <Footer />
      <input ref={input} type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" multiple hidden onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
      <div className="sr" role="status" aria-live="polite">{announce}</div>
      {drag && <div className="dropveil" aria-hidden="true"><span>Drop to scan. Nothing is uploaded.</span></div>}
      {proof && <Proof onClose={() => setProof(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

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
        <p className="eyebrow">Photo privacy check</p>
        <h1>Your photos talk.<br /><em>Make them hush.</em></h1>
        <p className="lede">Every photo you post can carry the GPS spot you stood on, your phone&rsquo;s serial number, the second you took it, and a hidden copy of whatever you cropped out. Drop a photo to see exactly what it gives away, then wipe it.</p>
        <button className="drop" onClick={onPick} aria-label="Choose photos to scan. You can also drag and drop files here.">
          <span className="corners" aria-hidden="true" />
          <span className="drop-title">Drop photos here</span>
          <span className="drop-sub">or tap to choose from your library {'·'} JPEG &amp; PNG {'·'} batch OK</span>
        </button>
        <div className="hero-actions">
          <button className="btn primary" onClick={onPick}>Choose photos</button>
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
  if (item.error) return <div className="verdict sev-bg-high"><p className="eyebrow">{item.file.name}</p><h2>We couldn&rsquo;t scan this file.</h2><p className="lede">{item.error}</p></div>;
  if (!a) return <div className="verdict"><p className="eyebrow">{item.file.name}</p><h2>Scanning&hellip;</h2></div>;
  const done = !!item.result;
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
          <p className="eyebrow">{a.name} {'·'} {a.format.toUpperCase()} {'·'} {a.width}&times;{a.height} {'·'} {kb(a.size)}</p>
          {done ? <span className="sev sev-clean big"><span aria-hidden="true">{'✓'}</span> Clean</span> : <Sev level={a.risk.level} big />}
        </div>
        <h2>{done ? 'Clean. Nothing identifying is left in this file.' : a.risk.headline}</h2>
        {!done && a.risk.bullets.length > 0 && <ul className="bullets">{a.risk.bullets.map((b) => <li key={b}>{b}</li>)}</ul>}
        {!done && counts.length > 0 && <p className="counts">{counts.map(([s, n]) => <span key={s} className={`c-${s}`}>{n} {s}</span>)}</p>}
        {done && item.result && <Verified r={item.result} />}
        {a.warnings.length > 0 && <p className="warn">{a.warnings.join(' ')}</p>}
      </div>

      {(a.gps || a.thumbnail) && (
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
          {a.thumbnail && (
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

      <div className="cards">
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
        <span className="why">{f.why} <span className="src">{f.source}</span></span>
      </dd>
    </div>
  );
}

function Verified({ r }: { r: CleanResult }) {
  return (
    <ul className="proof-list">
      <li><b>{r.removed.length}</b> fields removed, re-scanned: <b>{r.after.findings.filter((f) => f.label !== 'Orientation').length}</b> remain</li>
      <li>Pixels {r.pixelsIdentical ? <b>byte-identical</b> : <b className="bad">changed</b>} (no re-compression, no quality loss)</li>
      <li>Rotation {r.orientationKept > 1 ? <b>kept</b> : 'not needed'} {'·'} {kb(r.before.size)} {'→'} {kb(r.bytes.length)}</li>
    </ul>
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
      <p><b>Honest limits.</b> Hushprint removes metadata from the file, not what is visible in the picture (faces, street signs, reflections). JPEG and PNG only for now. HEIC, PDF and DOCX are on the roadmap.</p>
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
