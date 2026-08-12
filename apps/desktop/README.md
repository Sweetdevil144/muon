# MUON Desktop

## At a glance

- **Electron app with a hardened renderer boundary.** The main process
  (`src/main.ts` `createWindow`) opens a single context-isolated, OS-sandboxed
  `BrowserWindow`; the renderer (`src/renderer/app.tsx`) reaches the brain only
  through the typed IPC surface in `src/shared/ipc.ts` (`window.muon` preload —
  chat streams, `archiveChat`, `cancelChat`, `raiseDispatchBudget`,
  `updateMemoryNote`, and more).
- **Hosts and supervises its own embedded loopback brain.** `BrainSupervisor`
  (`src/lib/brain.ts`) adopts an already-running brain via its lockfile or
  spawns and restarts a child process, so a backend crash is contained to a
  restartable process instead of taking down the window.
- **Runs embedded vendor/shell terminals over real PTYs.** `registerTerminalIpc`
  (`src/lib/terminal-host.ts`) relays bytes between the renderer and `node-pty`
  children spawned from a fixed host allowlist; the renderer can name only a
  terminal kind, never argv/env/cwd or a session id.
- **Auto-indexes the open workspace with GitNexus.** `GitNexusIndexSupervisor`
  (`src/lib/gitnexus-index.ts`) watches repo HEAD and re-indexes on change, and
  `createWindow` nudges `ensureIndexed()` on window focus so commits made
  outside the app get picked up.

Native macOS app for the MUON brain — the crew HQ, and the fastest path to a
first governed run. It is organized around MUON's four product nouns:
**Mission** (the chat with the coordinator), **Crew** (your 0–3-per-vendor
fleet), **Control** (the approvals rail; every gate fails closed), and
**Memory** (the human-confirmable memory graph + pre-edit hero). It hosts its own
loopback brain and a lease-fenced runner, is BYO-auth (drives your own vendor CLI,
never custodies a token), and makes no outbound calls except the opt-in updater.

New here? Start with the [root README](../../README.md) and the proven
[first-run demo](../../docs/demo/first-run.md). Claude Code and Codex are managed
dispatch lanes; Cursor is readiness + audited native takeover only. Evidence is
hermetic (unit/integration + fake-vendor full-loop) — no real-vendor end-to-end
run has been performed yet.

One window:

- **Chat** (center), talk to the super-orchestrator. It plans, creates tasks,
  dispatches the sub-agent fleet, and reports back. Turns enqueue onto the same
  lease-fenced persistent runner used by CLI/TUI/workflows, with exact
  deny-first MCP capability policy and resumable vendor sessions. Pending
  approvals open the full bound action, scope, consequence, and evidence review
  before any decision. Merge review loads automatically: graph-certified
  artifacts can proceed, stale/unavailable evidence stays blocked, and REVIEW
  BLIND artifacts require reviewing every listed file and an exact
  digest-bound checkbox attestation. If the selected Claude/Codex provider is definitely not
  ready, Mission blocks before queue/history creation and shows the exact fix,
  a re-check action, and any ready fallback vendor beside the composer.
- **Sidebar** (left, collapsible), chats (+ New chat picks a workspace
  folder), the crew, active sessions, and progressive session details.
- **Control rail** (right, collapsible), the next review action, per-root
  lineage and limits, quiet dispatch evidence, Memory review, diagnostics, and
  human-readable activity.
- **Session workspaces** (closable center tabs), overview, timeline, changes,
  tools, capabilities, commands, audit, and a bounded Judge diff. The small
  stream card remains a preview; selecting it opens the full workspace.
- **Memory workspace**, review inbox, searchable library, calm 2D graph,
  accessible table, and provenance history.
- **Menu-bar companion**, the tray keeps brain status and the
  pending-approval count; new approvals raise native notifications you can
  deep-link into full review. Notifications never approve high-risk work.

The renderer talks to the brain only through typed IPC (`window.muon`,
context-isolated preload); the main process owns the `@muon/client` instance
and runs orchestrator turns via `@muon/orchestrator`.

## Run

```bash
# From the repository root. Rebuilds the monorepo in dependency order,
# verifies Electron, then opens the native app. The app supervises the
# embedded brain and persistent runner itself.
npm run dev:desktop

# First checkout or dependency refresh:
npm run dev:desktop:fresh

# Reuse existing build artifacts:
npm run dev:desktop:fast

# In a second terminal after the normal launcher rebuilt the TUI:
npm run tui
```

For an isolated QA profile shared by desktop and TUI:

```bash
export MUON_DATA_DIR="$HOME/.muon-qa"
npm run dev:desktop
# second terminal:
MUON_DATA_DIR="$HOME/.muon-qa" npm run tui
```

Use the walkthrough in
[`docs/testing/desktop-tui-walkthrough.md`](../../docs/testing/desktop-tui-walkthrough.md)
for the full feature and UX pass.
See [`docs/runtime-commands.md`](../../docs/runtime-commands.md) for the
canonical launch commands and the package-internal build/release commands.

If Electron reports *"failed to install correctly"*, approve its postinstall
script then rerun the helper (npm's `extract-zip` step can leave a partial
`dist/` on some setups):

```bash
npm approve-scripts electron
npm run ensure-electron
```

CI installs with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (build + tests only).

## Configure

Settings are editable in-app (sidebar → Settings) and persist to
`settings.json` in the Electron user-data dir:

```json
{
  "apiBase": "http://localhost:4000",
  "apiToken": "…",
  "tuiCommand": "npm run tui",
  "platformUrl": "http://localhost:3050/platform",
  "pollIntervalMs": 5000
}
```

## Test / typecheck

```bash
npm test           # vitest: renderer, main-process, cockpit, session, memory, approvals, settings
npm run typecheck  # main+preload (NodeNext) and renderer (bundler) configs
```

## Package

```bash
npm run package:dir             # unpacked release/mac-arm64/MUON.app
npm run package                 # unsigned DMG + zip/feed, never publishes
npm run verify:release-artifacts # feed sizes + SHA-512 match the DMG/ZIP
npm run smoke:packaged-runner   # focused Seatbelt runner path
npm run smoke:packaged-desktop  # full backend/auth/dispatch/recovery path
```

The Claude Agent SDK (and its `claude` binary) is asar-unpacked so packaged
builds can spawn it; the main process prepends common CLI install paths
(homebrew, `~/.local/bin`, mise shims) so Finder launches resolve vendor CLIs.
The bundle name is exactly **MUON** and its `.icns` is deterministically derived
from the repository's canonical `public/logo.png`.
