# Security policy

Hushprint reads files you give it and parses them with hand-written code. That is exactly the kind of code that
needs scrutiny, so reports are welcome.

## Reporting a vulnerability

Please do not open a public issue for a security bug. Use GitHub's private vulnerability reporting
(Security tab, "Report a vulnerability") on this repository. Include the file or bytes that trigger it if you can.
Expect an acknowledgement within a few days. There is no bug bounty.

What counts as a vulnerability here:

- A crafted file that makes the page throw an uncaught error, hang, or allocate memory without bound.
- Any way for file content to run as script or HTML (XSS), or to leave the page (a network request).
- A "clean" result that still contains metadata the report claims was removed (a stripping bug).
- A way to weaken the Content-Security-Policy or Trusted Types policy.

## What is in place

| Control | Where |
|---|---|
| `connect-src 'none'`, `default-src 'none'`, no inline script or style, no `eval` | `vite.config.ts` (meta tag) and `vercel.json` (header); guarded by `tests/security.test.ts` |
| Trusted Types enforced (`require-trusted-types-for 'script'`, one policy `hushprint-sw` that can only return `/sw.js`) | same |
| No `innerHTML`, `dangerouslySetInnerHTML`, `document.write`, `eval`, `new Function` in `src/`. File content is only ever rendered as React text nodes | static test in `tests/security.test.ts`, plus a Playwright check that hostile metadata renders as text |
| Hard caps on every allocation and loop driven by file content | `src/engine/limits.ts` |
| Bounded decompression: output is read in chunks and cancelled at the cap, so a zip/deflate bomb costs at most a few MB | `inflate()` in `src/engine/bytes.ts` |
| Fuzzing: mutated and truncated inputs for every parser, plus hostile size fields | `tests/fuzz.test.ts` |
| Dependencies: Four runtime packages (React, ReactDOM and two font packages). `npm audit` is clean at the time of writing and runs in CI | `.github/workflows/ci.yml` |
| CLI: file-derived text is escaped before it reaches a terminal (controls, C1, bidi), symlinks are never followed, files are opened with `O_NOFOLLOW` and size-checked on the open handle, run totals are capped, and an unverified copy is never written as clean | `src/cli.ts`, `tests/cli.test.ts` |
| Outputs are re-parsed and verified before they are offered | `clean()` in `src/engine/analyze.ts` |

## Known limits

- The size caps are a defence against denial of service in one tab, not a sandbox. The parsers run on the main thread, so a
  very large or adversarial file can make the page sluggish for a moment (the fuzz suite asserts each file finishes in
  well under two seconds).
- Fuzzing here is seeded mutation and truncation inside the test suite, not coverage-guided fuzzing. A coverage-guided
  run (for example with a native fuzzer against the compiled engine) would be a good addition.
- Hushprint has not been audited by a third party.

See [THREAT_MODEL.md](THREAT_MODEL.md) for what the tool does and does not protect against.
