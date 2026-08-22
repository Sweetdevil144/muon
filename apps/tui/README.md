# MUON TUI

## At a glance

- Terminal-hosting desk (`src/shell/`, ADR-0046): real vendor CLIs run inside
  its panes over node-pty + a headless xterm, with MUON's governance beside
  them — approvals, memory, tasks, workflows, crew, and pre-edit evidence are
  chorded surfaces (`ctrl+b …`), not a separate app.
- One keymap, drift-locked: `?` renders the exact table the dispatcher
  resolves against (`src/shell/keymap.ts`); a key the desk advertises but
  cannot run fails the suite.
- Evidence-first gates: the review pane opens the complete approval evidence
  on the first press and decides on the second (`a` / `A` approve+remember /
  `m` REVIEW BLIND attestation for merges / `r` reject). Gates fail closed.
- Governed and local-first over the shared brain via `@muon/client`: memory
  writes are UNCONFIRMED proposals until a human vouches; dispatch lanes keep
  their role fences; take-over is a consent form that flips ownership FIRST.

## Run

```bash
# from repo root; share the same local profile as Desktop when testing together
export MUON_DATA_DIR="$HOME/.muon-qa"
npm run tui
```

See [`docs/runtime-commands.md`](../../docs/runtime-commands.md) for when to use
the compiled TUI versus the source-development command.

## Keys

The authoritative list is IN the product: `?` renders the one keymap table
the dispatcher resolves against (`src/shell/keymap.ts`), and the drift-lock
test fails when an advertised key has no live handler. The shape:

| Chord | Action |
| --- | --- |
| `ctrl+b t` | new terminal (spawn picker: vendor CLIs, shell) |
| `ctrl+b a` | command picker — every registry action |
| `ctrl+b c` | crew drawer (`d` inside it opens roles + coordination) |
| `ctrl+b i` | inbox — approvals, evidence-first |
| `ctrl+b k` | tasks — the ledger and each task's packets |
| `ctrl+b r` | workflow runs — review, apply or dismiss a plan |
| `ctrl+b e` | evidence — pre-edit blast radius + governed memory |
| `ctrl+b m` | memory — the brain's notes |
| `ctrl+b g` | destinations |
| `ctrl+b \|` | split the active pane |
| `ctrl+b ⏎` | answer the waiting gate |
| `esc` | pop one layer, innermost first |

On the review gate: `a` approve, `A` approve+remember (where a receipt can
exist), `m` attest a review-blind merge, `r` reject — the first press
always opens the evidence, the second decides.

## Commands

**The desk lists only what it runs** (ROADMAP H13). A command cannot be
offered without a runner: the picker (`ctrl+b a`) derives from
`ACTION_REGISTRY` (`src/lib/actions.ts`) — run, tasks, assignment, status,
`ship`, `memory-add`, `specialist`, `fork`, `plan`, `budget`,
`return-session`, and `take-over` (via its own consent form). `ship` runs
the check in the task's own workspace and FILES a `kind:"merge"` approval
— the decision stays a separate, evidence-first press in the inbox — and
`memory-add` writes an UNCONFIRMED proposal a human still has to vouch
for.

The two earlier Ink desks were retired by disposition list and deleted
(ADR-0087 D4) after every gating command was ported here.

## Layout

Panes are terminal sessions: `ctrl+b t` spawns one (vendor CLI or shell),
`ctrl+b |` splits the active pane, and governance surfaces (inbox, tasks,
memory, workflows, crew, evidence) stack as layers over them — `esc` pops
one layer at a time, innermost first. A sidebar rail carries crew/attention
state when the terminal is wide enough.

The TUI and Desktop share product semantics through `@muon/client`, but keep
native interaction models. The TUI optimizes for fast keyboard review; the
Desktop optimizes for visual lineage, diffs, memory, and audit.

The TUI shows at most 12 REVIEW BLIND paths. Larger sets cannot be attested
from a clipped terminal view; use Desktop or `muon approve review` to inspect
the complete list.
