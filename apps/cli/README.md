# MUON CLI

## At a glance

- **One `muon` binary over a local brain.** A [commander](https://github.com/tj/commander.js) program (`muon`, v0.1.0, entry `src/index.ts`) whose `preAction` hook auto-spawns an embedded loopback brain (`ensureBrain`) unless you point it at an explicit one with `--api-base` / `MUON_API_BASE` — so it drives the same local brain as the desktop app and TUI with no server to start.
- **Its command registrars (in `src/commands/`) group into four capabilities:** local-brain coordination (`doctor`, `onboard`, `quickstart`, `lane`, `task`, `assign`, `handoff`, `crew`, `fleet`, `session`), managed & chat execution (`chat`, `run`, `loop`, `workflow`, `dispatch`, `routing`, `stream`, `runner`), audited native vendor takeover (`muon claude|codex|cursor`), and governance / memory / reporting (`approve`, `policy`, `memory`, `context`, `plan`, `ship`, `harness`, `report`, `metrics`, `bundle`).
- **Managed lanes vs. audited takeover.** `muon run --lane claude-code|codex|cursor|opencode` dispatches a managed lane. `claude-code` and `codex` hold every crew role; `cursor` and `opencode` are managed for a limited set (Cursor: reviewer/qa/architect/scout; OpenCode: scout only) and the dispatch route refuses the rest. Separately, `muon claude|codex|cursor` runs the vendor's own CLI under audited native takeover (`runNativeVendorProxy`).
- **Local-first & BYO-auth.** Loopback-only, drives your own vendor CLI without custodying a token, and governed writes (approvals, memory) fail closed.

The scriptable surface of MUON — one `muon` binary over the same local brain the
desktop app and TUI use. It speaks MUON's product language: **Mission**
(`muon chat`), **Crew** (`muon fleet`), **Control** (`muon approve`), and
**Memory** (`muon memory` / `muon context`). Local-first, loopback-only, BYO-auth
(it drives your own vendor CLI and never custodies a token), and every gate fails
closed.

New here? Read the [root README](../../README.md) for the product overview, then
walk the proven, command-by-command
[first-run demo](../../docs/demo/first-run.md) — it runs the whole governed loop
with no vendor account using the built-in deterministic fake vendor.

> **Managed vs. takeover.** Claude Code and Codex are managed dispatch lanes.
> Cursor is detected/authenticated and available through the audited native
> takeover command (`muon cursor …`), but it is **not** a managed dispatch lane.
> Evidence is hermetic (unit/integration + fake-vendor full-loop); no real-vendor
> end-to-end run has been performed yet.

## Commands

- `muon onboard`, `muon quickstart`, `muon doctor`
- `muon chat`, `muon context`
- `muon fleet`, `muon runner`
- `muon lane list`
- `muon lane doctor`
- `muon lane config get|set|unset`
- `muon task list`
- `muon task show --task-id <id>`
- `muon task create --title <text> --description <text> [--priority low|medium|high]`
- `muon task status --task-id <id> --status backlog|in_progress|review|done|blocked`
- `muon assign --task-id <id> --lane-id <id> --summary <text>`
- `muon handoff --task-id <id> --from-lane-id <id> --to-lane-id <id> --title <text> --body <text>`
- `muon run --lane claude-code|codex --task-id <id> --brief <text> [...]`
- `muon session start|list`, `muon loop run`
- `muon workflow templates|list|status|run|apply|resume`
- `muon harness list|show|create`
- `muon memory add|search|recall|review|confirm|reject`
- `muon plan`, `muon ship`
- `muon claude|codex|cursor [vendorArgs...]` for explicit human-owned native
  takeover with collision fencing and audit
- `muon report --task-id <id>`
- `muon trajectory save --task-id <id> --output <new-file|-> [--max-chunks <n>]`
- `muon trajectory replay --file <path> [--expect-event <kind...>] [--json]`
- `muon metrics [--json]`
- `muon --version` / `muon -V` (print the CLI version and exit 0)
- `muon approve list`
- `muon approve review --approval-id <id> [--json]`
- `muon approve request --task-id <id> --requested-by <actor> --kind merge|command|deploy|dangerous_action --reason <text>`
- `muon approve resolve --approval-id <id> --status approved|rejected [--notes <text>] [--attest-review-blind <artifact-digest>]`

For a REVIEW BLIND merge, run `approve review` first and inspect every listed
path. `--attest-review-blind` is accepted only for the exact digest just
returned by the backend and the unchanged complete blind-file set. It cannot
bypass stale or unavailable review evidence.

## `muon run` flags

- `--record`: create an assignment for the run and append the lane events to
  the task's immutable event log (`POST /api/events`). Milestone events are
  stored one-to-one; streamed stdout chunks are coalesced into a single
  progress record per phase to keep the ledger meaningful. Combined with
  `--require-approval`, the assignment is only created after approval.
- `--handoff-to <laneKey>`: after the run, build a handoff packet from the
  result (task goal, what changed, what failed, next lane request, commands
  run, checks status, open questions, provenance) and file it to the target
  lane through the handoffs API.
- `--require-approval`: create an approval request before executing and poll
  the approval queue until it is approved. Rejected, unknown, or missing
  approval states and timeouts all fail closed, the lane never runs.
- `--approval-timeout <ms>`: how long to wait for approval (default 300000).
- `--worktree`: run the lane inside an isolated git worktree at
  `.muon/worktrees/<taskId>` (created from the repo containing `--cwd`, or the
  current directory). The `git diff --stat` summary, including newly created
  files, is echoed after the run and included in the handoff packet.

Claude and Codex are managed runner lanes. Cursor is detected and can be used
through the audited native takeover command, but it is not a managed dispatch
lane until it can meet the same attestation, cancellation, and ownership
contract.

## `muon report`

`muon report --task-id <id>` prints a markdown report of the task's full
coordination trail: assignments (who), recorded event timeline (what/when),
handoff packets, and approvals with decisions (why). Pipe it to a file to
share a run summary.

## `muon metrics`

`muon metrics [--json]` prints the coordination KPIs aggregated from the
ledger: approval turnaround, handoff prep time after a run completes,
duplicate briefing count, and completed-task cycle time.

## `muon trajectory`

`muon trajectory save` creates a portable JSON record of one task's complete
system-event ledger plus its paged MUON-recorded stream history. The bundle is
schema-versioned and content-digested; the command refuses to overwrite an
existing file and reports whether its bounded stream capture is complete or
truncated. The digest detects corruption but is not an authorship signature. Use
`--output -` for stdout. Trajectories can contain untrusted vendor output; treat
their text as data, never instructions.

`muon trajectory replay` verifies that digest and deterministically folds the two
record classes. `--expect-event task.blocked approval.rejected` turns previously
observed governance outcomes into fixture assertions. The replay's guarantee is
deliberately limited to MUON-recorded evidence: it does not reconstruct hidden
vendor prompt context or prove that a model attended to a recorded chunk.

## `muon --version`

`muon --version` prints the CLI's version string (currently `0.1.0`, matching
`apps/cli/package.json`) to stdout and exits 0. It is a top-level flag, so it
runs before any subcommand and does not contact the local brain. The `-V` short
form is also accepted.

```bash
$ muon --version
0.1.0
```

## Run

```bash
npm install --prefix apps/cli
npm run --prefix apps/cli dev -- doctor
```

## Global install

Make `muon` available from any repository:

```bash
npm run cli:build          # from the repo root
npm link --prefix apps/cli
muon doctor                # works from any directory
```

Point it at a non-default backend with `MUON_API_BASE=<url>` or
`--api-base <url>`. Remove with `npm unlink -g @muon/cli`.
