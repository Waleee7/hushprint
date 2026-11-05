# Threat model

## What Hushprint is for

A person is about to share a file (photo, PDF, Office document, video). Hushprint shows what hidden data the file
carries and produces a copy without it. The promise is narrow: **the metadata containers Hushprint knows about are
removed, the result is re-read to prove it, and your file never leaves your device.**

## Assets

1. The user's files and everything in them (the highest-value asset: files are often personal).
2. The user's trust that "nothing is uploaded".
3. The integrity of the cleaned output (it must still open, and must not silently still contain the leak).

## Adversaries and attack surface

| # | Adversary | What they control | What we do |
|---|---|---|---|
| A | **Malicious file** (someone sends the user a crafted image, PDF, zip, video) | Every byte of the input | Parsers are bounds-checked and capped; fuzzed; errors are typed `ParseError`; no file text reaches HTML or code sinks; decompression is bounded |
| B | **Compromised or malicious page code** (supply chain, hosting takeover) | The JavaScript we ship | `connect-src 'none'` stops the page itself exfiltrating via fetch/XHR/WebSocket/beacon; only 2 runtime dependencies; CSP forbids inline script and remote origins. This is a mitigation, not a proof: a malicious *update* of the app could remove the policy, so the source is small and the CSP is guarded by a test. Users who need more can run it from a local copy |
| C | **Network observer** | Traffic | There is no traffic after the app shell loads. After the first visit the app works offline from the service-worker cache |
| D | **Someone who receives the cleaned file** | The output | Metadata is removed and re-scanned. Limits below describe what remains |
| E | **Other web pages / extensions** | Same browser | Standard browser isolation; no cookies, no storage of file data, no `localStorage`. Browser extensions can read any page and are out of scope |

## Trust boundaries and design choices

- **Files stay in the page.** They are read with the File API into memory, parsed, rewritten and offered as a download.
  Nothing is written to IndexedDB, localStorage or the cache.
- **The service worker never sees files.** It caches the app shell and answers same-origin GETs. Its script is served with
  its own CSP (`connect-src 'self'`) because a worker needs `fetch` to fill its cache; the page's CSP stays at `'none'`.
  Cross-origin requests are ignored by the worker.
- **Trusted Types** blocks string-to-HTML/script sinks. The only policy (`hushprint-sw`) returns `/sw.js` and throws
  for anything else.
- **Bounded work.** `src/engine/limits.ts` lists every cap: file size (256 MB), decompressed metadata (4 MB per stream, 24 MB per file),
  boxes, chunks, objects, entries, EXIF elements, XMP characters, findings.
- **Lossless where possible.** JPEG, PNG, WebP, PDF, Office and MP4/MOV are rewritten without decoding pixels or samples;
  a CRC over the untouched content before and after proves it. HEIC and "bake the rotation in" re-encode through the
  browser's canvas and say so.
- **Verification is real.** After stripping, the output is parsed again by the same engine. If something removable is
  still there the result is marked not verified. Things the engine knows it cannot remove are listed as caveats.
- **Output names.** Share-safe mode replaces file names with 48 random bits so the name cannot leak.

## Out of scope / not protected

- **Visible content.** Faces, house numbers, screens, reflections, text on a page. Hushprint edits metadata, not what is shown.
- **Content-level leaks inside documents**: tracked-change and comment authors, hidden sheets or slides, embedded files and
  fonts, form-field and annotation authors in PDFs, earlier saved revisions in a PDF, per-frame GPS tracks in action-camera
  video. These are detected where practical and flagged "not removable", never silently ignored or claimed as removed.
- **Encrypted PDFs and ZIP64 Office files** are refused rather than guessed at.
- **Statistical or forensic identification** (camera sensor noise, writing style) is not metadata.
- **A compromised device or browser.** If malware controls the machine, no web page helps.
- **Tools that do not honour our output.** We remove the metadata we recognise; we cannot guarantee that every possible
  vendor-private container is recognised. Rule of thumb: unknown segments are dropped by default in JPEG/PNG/WebP (allow-list of
  what is needed to draw the image), but PDF, Office and MP4 use block-lists of known metadata locations.
- **Office files** were checked with our own parser, Python's zipfile and macOS `textutil`, not with Microsoft Office.

## Review checklist when changing the code

1. Does any new parser loop or allocation depend on a number read from the file? Add a cap in `limits.ts` and a hostile case in `tests/fuzz.test.ts`.
2. Does any new UI render file-derived text? Render it as a React text node; `tests/security.test.ts` bans HTML sinks.
3. Does anything new need the network? It must not. If it does, the answer is no.
4. Does the new output get re-parsed by `clean()` and fail verification on a leftover?
