# Vendored: pi-tui (`@earendil-works/pi-tui`)

- **Source:** https://github.com/earendil-works/pi — `packages/tui`
- **Commit taken:** `368e013dec766724d892cfa5cc247d2f2bee8795` (v0.84.1)
- **Date vendored:** 2026-08-08
- **License:** MIT, © 2025 Mario Zechner — `LICENSE` in this directory,
  preserved verbatim per the license terms and ADR-0042 D1 / ADR-0046 D2.
- **Why vendored, not depended on:** a rendering substrate the whole TUI rests
  on is not a dependency to be surprised by (ADR-0042 open question 1,
  founder-decided 2026-08-08: vendor it).

## Local modifications

None. Sources are verbatim. The compiler flags they require
(`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`) are set in
`apps/tui/tsconfig.json` instead of rewriting their `.ts`-extension imports —
keeping the diff against upstream empty makes a future re-sync a plain copy.

If a local patch ever becomes necessary, record it here as a numbered entry
with the reason and the upstream issue link, so a re-sync knows what to
re-apply.

## What was deliberately NOT taken

- `test/` — upstream's tests exercise their repo layout; our integration is
  covered by MUON's own suites (including the evasion-corpus replay).
- `native/win32` — MUON's TUI ships for macOS/Linux today; the darwin
  modifier prebuilds ARE taken (the loader degrades gracefully where absent).
