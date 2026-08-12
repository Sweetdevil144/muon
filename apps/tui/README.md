# MUON TUI

## At a glance

- Ink + React terminal cockpit that renders MUON's fleet over the shared brain through `@muon/client` — Mission / Crew / Control / Memory panels (`CockpitPanels.tsx`), header/footer, and full-screen overlays, laid out as side-by-side lane columns on wide terminals.
- Prompt-first command bar (`parseCommandBarInput` in `src/lib/command-bar.ts`): plain text becomes a proposal for the super-orchestrator, slash-commands (`/run`, `/session`, `/ship`, `/memory`, `/task`, `/plan`, `/crew`, …) jump straight to cockpit actions, and `/<action> [vendor]` (e.g. `/plan codex`, `/ultrareview claude`) invokes a vendor's own feature, badged and gated.
- Live supervision overlays: `AgentStreamOverlay` streams one sub-agent's output ("watch it think") and `ApprovalReviewOverlay` shows complete approval evidence behind a desktop-parity gate (`a` approve · `A` approve, don't ask again · `r` reject), requiring a REVIEW BLIND attestation (`m`) before a merge approval is legal.
- Governed and local-first: the memory panel (`MemoryPanel.tsx`) marks settled vs unsettled notes, gates fail closed, and all four vendors run as managed dispatch lanes — Claude Code and Codex across every crew role, Cursor limited to reviewer/qa/architect/scout and OpenCode to scout, with the dispatch route refusing any role a lane cannot hold.

Terminal coordination cockpit over the shared brain — the same **Mission** /
**Crew** / **Control** / **Memory** model as the desktop app, tuned for fast
keyboard review. Ink + React; data via `@muon/client`. Local-first, BYO-auth,
gates fail closed.

New here? See the [root README](../../README.md) for the product overview and the
proven [first-run demo](../../docs/demo/first-run.md). Claude Code and Codex are
managed dispatch lanes; Cursor is readiness + audited native takeover only.
Evidence is hermetic (unit/integration + fake-vendor full-loop) — no real-vendor
end-to-end run has been performed yet.

## Run

```bash
# from repo root; share the same local profile as Desktop when testing together
export MUON_DATA_DIR="$HOME/.muon-qa"
npm run tui
```

See [`docs/runtime-commands.md`](../../docs/runtime-commands.md) for when to use
the compiled TUI versus the source-development command.

## Keys

<!-- Generated from src/lib/keymap.ts (ADR-0032 D6). Do not edit by hand:
     keymap-readme.test.ts fails when this drifts from the table. -->

### Desk

| Key | Action |
| --- | --- |
| `/ i` | focus the command bar — tell the crew what to do |
| `ctrl+k` | command palette |
| `?` | this keymap |
| `tab shift+tab` | cycle focus between rail zones |
| `j ↓` | move down in the focused zone |
| `k ↑` | move up in the focused zone |
| `o` | jump to the newest item that needs you |

### Tabs

| Key | Action |
| --- | --- |
| `1 … 9` | switch to tab N |
| `]` | next tab |
| `[` | previous tab |
| `x` | close the active tab |

### Crew

| Key | Action |
| --- | --- |
| `enter` | open the selected lane's live stream in a tab _(lanes)_ |
| `s` | stop the selected lane _(lanes)_ |
| `b` | mission budget breakdown _(lanes)_ |
| `!` | stop every dispatch |
| `enter` | open the selected task's detail in a tab _(tasks)_ |

### Decide

| Key | Action |
| --- | --- |
| `a` | approve (first press opens the evidence) _(approvals)_ |
| `A` | approve + don't ask again for 15 minutes _(approvals)_ |
| `r` | reject (first press opens the evidence) _(approvals)_ |
| `m` | merge gates only: attest REVIEW BLIND, then approve _(approval-review)_ |

### Memory

| Key | Action |
| --- | --- |
| `c` | confirm the selected note _(memory)_ |
| `x` | reject the selected note (governed) _(memory)_ |
| `p` | pause the selected note _(memory)_ |
| `e` | toggle expired notes (re-runs the governed search) _(memory)_ |
| `v` | view the selected proposal's text _(brain)_ |

### Panels

| Key | Action |
| --- | --- |
| `r` | refresh the open panel _(crew · mcp · brain)_ |
| `a` | apply the selected workflow run _(workflow)_ |
| `x` | apply if needed, then execute _(workflow)_ |

### App

| Key | Action |
| --- | --- |
| `esc` | back — never remounts the desk |
| `q` | quit |

## Palette commands

- Create task, assign task (with a suggested lane + reason), update status
- Run task/session/loop/workflow through the persistent runner and stream it
  into the selected crew member
- Open complete approval evidence, then approve or reject
- Search, add, review, confirm, and reject memory
- Inspect pre-edit evidence, diagnostics, activity, and Stop all
- Focus panels, refresh, quit

## Layout

- **≥150 columns**: five live crew seats side-by-side, each with task, activity,
  liveness, `Enter` stream focus, and `s` exact-lane Stop.
- **110–149 columns**: fleet + orchestrator + decision columns.
- **Narrower**: stacked fleet, orchestrator, and decision surfaces.

The TUI and Desktop share product semantics through `@muon/client`, but keep
native interaction models. The TUI optimizes for fast keyboard review; the
Desktop optimizes for visual lineage, diffs, memory, and audit.

The TUI shows at most 12 REVIEW BLIND paths. Larger sets cannot be attested
from a clipped terminal view; use Desktop or `muon approve review` to inspect
the complete list.
