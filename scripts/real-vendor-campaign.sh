#!/usr/bin/env bash
#
# MUON REAL-VENDOR E2E CAMPAIGN — the founder-executed, push-button runner.
#
# Every prior MUON test number (Testing.md, docs/testing/desktop-tui-walkthrough.md,
# docs/demo/first-run.md) is HERMETIC: MUON_FAKE_VENDOR=1, a deterministic double,
# zero network, zero credentials. This script is the first thing in the repo that
# drives REAL Claude Code and REAL Codex — real API/subscription calls, real
# tokens, real cost — end to end through MUON's governed spine. It is written to
# be run ONLY by a human with their own vendor accounts already configured; it
# never asks for, stores, or prints a credential value.
#
# WHAT THIS SCRIPT DOES:
#   - Walks numbered steps, grouped into lettered sections (a)-(f), matching
#     docs/testing/real-vendor-campaign.md 1:1.
#   - For each step, prints the exact command(s) it is about to run (or, for a
#     manual/desktop-only step, the exact action to take) and the expected
#     outcome, BEFORE doing anything.
#   - Runs the command (unless --dry-run), shows the result, then asks
#     y/n/skip: did this match the expected outcome?
#   - Records every step's id/command/expected-outcome/result/note/timestamp to
#     a campaign-log JSON file (--log), so the campaign is resumable
#     (--resume skips steps already answered) and auditable after the fact.
#
# WHAT THIS SCRIPT NEVER DOES:
#   - Never runs as root.
#   - Never touches your normal/default MUON_DATA_DIR — it uses its own
#     (--data-dir, default ~/.muon-real-vendor-campaign), same discipline as
#     docs/testing/desktop-tui-walkthrough.md's isolated-profile guidance.
#   - Never runs with MUON_FAKE_VENDOR set (that would defeat the entire
#     point of this campaign; the script refuses to start if it is set).
#   - Never records a credential value, token, or raw command output blob to
#     the log — only command TEXT (which this script itself authors, so it
#     never embeds a secret), exit codes, your y/n/skip judgement, and any
#     free-text note YOU choose to type (your responsibility to keep it
#     credential-free, same as any other bug report).
#   - Never silently retries or auto-approves a real-vendor gate; every
#     approval in this script is an explicit `muon approve resolve` you
#     trigger, or an explicit desktop-UI click you confirm.
#
# USAGE:
#   scripts/real-vendor-campaign.sh [options]
#
#   --log <path>          Campaign-log JSON path (default: ./real-vendor-campaign-log.json)
#   --data-dir <path>      MUON_DATA_DIR for this campaign (default: ~/.muon-real-vendor-campaign)
#   --dry-run              Print every step (command + expected outcome) WITHOUT
#                           executing anything and WITHOUT prompting. Proves the
#                           flow renders; makes zero vendor calls, zero writes.
#   --resume                Skip any step already recorded with a result in --log.
#   --only <a,b,c,d,e,f>    Run only the named section letter(s) (comma-separated).
#   --approval-timeout <s>  Seconds to wait for a filed approval to appear (default 120).
#   --dispatch-timeout <s>  Seconds to wait for a real vendor dispatch to reach a
#                            terminal state (default 1800 = 30 minutes — real
#                            models are slower than the fake vendor).
#   -h, --help              Show this help.
#
# EXIT STATUS: 0 if every step that ran was confirmed 'y' or 'skip'; 1 if any
# step was confirmed 'n' and you chose to abort, or on a hard precondition
# failure (root, MUON_FAKE_VENDOR set, muon not on PATH, no TTY without --dry-run).

set -euo pipefail

# ── 0. Hard safety preconditions (cannot be skipped, apply before ANY section) ──

if [ "$(id -u)" = "0" ]; then
  echo "ERROR: refusing to run as root." >&2
  exit 1
fi

if [ -n "${MUON_FAKE_VENDOR:-}" ]; then
  echo "ERROR: MUON_FAKE_VENDOR is set in your environment. This is the REAL-VENDOR" >&2
  echo "campaign — it must not run under the fake vendor (that would prove nothing" >&2
  echo "new; every hermetic number already covers MUON_FAKE_VENDOR=1). Unset it:" >&2
  echo "  unset MUON_FAKE_VENDOR" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAKE_REPO="$ROOT/scripts/make-disposable-repo.sh"

LOG_FILE=""
DATA_DIR="$HOME/.muon-real-vendor-campaign"
DRY_RUN=0
RESUME=0
ONLY="a,b,c,d,e,f"
APPROVAL_TIMEOUT=120
DISPATCH_TIMEOUT=1800

usage() {
  sed -n '2,59p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --log) LOG_FILE="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --resume) RESUME=1; shift ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --approval-timeout) APPROVAL_TIMEOUT="${2:-}"; shift 2 ;;
    --dispatch-timeout) DISPATCH_TIMEOUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument '$1'." >&2; usage >&2; exit 1 ;;
  esac
done

if [ -z "$LOG_FILE" ]; then
  LOG_FILE="$ROOT/real-vendor-campaign-log.json"
fi
LOG_FILE="$(cd "$(dirname "$LOG_FILE")" && pwd)/$(basename "$LOG_FILE")"
export LOG_FILE

if [ "$DRY_RUN" -ne 1 ] && [ ! -t 0 ]; then
  echo "ERROR: no TTY on stdin and --dry-run not set. Run this in an interactive" >&2
  echo "terminal, or pass --dry-run to render the steps without executing them." >&2
  exit 1
fi

if ! command -v muon >/dev/null 2>&1 && [ ! -f "$ROOT/apps/cli/dist/index.js" ]; then
  echo "ERROR: 'muon' is not on PATH and $ROOT/apps/cli/dist/index.js does not exist." >&2
  echo "Build and link it first:" >&2
  echo "  cd $ROOT && npm install && npm run cli:build && npm link --prefix apps/cli" >&2
  exit 1
fi
if ! command -v muon >/dev/null 2>&1; then
  # Built but not linked/PATH'd — fall back to invoking it directly.
  muon() { node "$ROOT/apps/cli/dist/index.js" "$@"; }
fi

mkdir -p "$DATA_DIR"
export MUON_DATA_DIR="$DATA_DIR"
PIDS_FILE="$DATA_DIR/campaign-runner-pids"
: > "$PIDS_FILE" 2>/dev/null || true

echo "════════════════════════════════════════════════════════════════════" >&2
echo " MUON REAL-VENDOR E2E CAMPAIGN" >&2
echo "   log:       $LOG_FILE" >&2
echo "   data dir:  $DATA_DIR  (separate from your normal MUON_DATA_DIR)" >&2
echo "   sections:  $ONLY" >&2
echo "   mode:      $([ "$DRY_RUN" -eq 1 ] && echo 'DRY RUN (nothing executes)' || echo 'LIVE (real vendor calls)')" >&2
echo "════════════════════════════════════════════════════════════════════" >&2

# ── logging + prompting primitives ──────────────────────────────────────────

STEP_NUM=0

# Reads a prior result for step id `$1` from LOG_FILE, if any. Prints it and
# returns 0 if found, returns 1 (prints nothing) if not found or no log yet.
step_done_result() {
  node -e '
    const fs = require("fs");
    const logPath = process.env.LOG_FILE;
    const id = process.argv[1];
    let log;
    try { log = JSON.parse(fs.readFileSync(logPath, "utf8")); }
    catch { process.exit(1); }
    const step = (log.steps || []).find((s) => s.id === id);
    if (!step || !step.result) process.exit(1);
    process.stdout.write(step.result);
  ' "$1"
}

# Appends/updates one step record in LOG_FILE. Reads fields from env vars set
# by the caller (avoids argv-quoting hazards for arbitrary command text).
record_step() {
  node -e '
    const fs = require("fs");
    const logPath = process.env.LOG_FILE;
    let log;
    try { log = JSON.parse(fs.readFileSync(logPath, "utf8")); }
    catch {
      log = {
        version: 1,
        campaign: "real-vendor-e2e",
        startedAt: new Date().toISOString(),
        note: "Command TEXT and exit codes only — no credential values, no raw command output are ever recorded here.",
        steps: [],
      };
    }
    const entry = {
      id: process.env.STEP_ID,
      section: process.env.STEP_SECTION,
      title: process.env.STEP_TITLE,
      command: process.env.STEP_COMMAND || null,
      expectedOutcome: process.env.STEP_EXPECTED || null,
      executed: process.env.STEP_EXECUTED === "1",
      exitCode: process.env.STEP_EXITCODE === "" ? null : Number(process.env.STEP_EXITCODE),
      result: process.env.STEP_RESULT,
      note: process.env.STEP_NOTE || "",
      timestamp: new Date().toISOString(),
    };
    log.steps = (log.steps || []).filter((s) => s.id !== entry.id);
    log.steps.push(entry);
    log.updatedAt = entry.timestamp;
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2) + "\n");
  '
}

# Prompts on the controlling TTY (works even if stdin is otherwise redirected
# by a step that piped input into `muon chat`). Returns y / n / skip.
confirm() {
  local prompt="$1" answer
  while true; do
    read -r -p "$prompt [y/n/skip] " answer </dev/tty || { echo "skip"; return 0; }
    case "$answer" in
      y|Y|yes|Yes) echo "y"; return 0 ;;
      n|N|no|No) echo "n"; return 0 ;;
      s|S|skip|Skip) echo "skip"; return 0 ;;
      *) echo "Please answer y, n, or skip." >&2 ;;
    esac
  done
}

section_enabled() {
  case ",$ONLY," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

# run_step <id> <section-letter> <title> <expected-outcome> [<command>]
# A step with no <command> is a MANUAL action (desktop UI, human observation);
# its "expected outcome" text IS the instruction. Every step — automated or
# manual — ends with a logged y/n/skip.
run_step() {
  local id="$1" section="$2" title="$3" expected="$4" command="${5:-}"
  STEP_NUM=$((STEP_NUM + 1))
  echo "" >&2
  echo "── [$section] Step $STEP_NUM — $title ─────────────────────────────" >&2
  echo "id: $id" >&2
  if [ -n "$command" ]; then
    echo "command:" >&2
    echo "  $command" >&2
  else
    echo "(manual action — no command to run)" >&2
  fi
  echo "expected outcome:" >&2
  echo "  $expected" >&2

  if [ "$RESUME" -eq 1 ]; then
    local prior
    if prior=$(step_done_result "$id"); then
      echo "↺ already recorded as '$prior' in $LOG_FILE — skipping (drop --resume, or edit the log, to redo it)." >&2
      return 0
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[DRY RUN] not executed." >&2
    STEP_ID="$id" STEP_SECTION="$section" STEP_TITLE="$title" STEP_COMMAND="$command" \
      STEP_EXPECTED="$expected" STEP_EXECUTED="0" STEP_EXITCODE="" STEP_RESULT="dry-run" STEP_NOTE="" \
      record_step
    return 0
  fi

  local exit_code=""
  if [ -n "$command" ]; then
    set +e
    eval "$command"
    exit_code=$?
    set -e
    echo "(exit code: $exit_code)" >&2
  fi

  local result
  result=$(confirm "Did this match the expected outcome?")
  local note=""
  if [ "$result" = "n" ]; then
    read -r -p "Optional note about the mismatch (never paste a credential/token): " note </dev/tty || note=""
  fi
  STEP_ID="$id" STEP_SECTION="$section" STEP_TITLE="$title" STEP_COMMAND="$command" \
    STEP_EXPECTED="$expected" STEP_EXECUTED="$([ -n "$command" ] && echo 1 || echo 0)" \
    STEP_EXITCODE="$exit_code" STEP_RESULT="$result" STEP_NOTE="$note" \
    record_step

  if [ "$result" = "n" ]; then
    local go_on
    go_on=$(confirm "Result was 'n' — abort the campaign now (recommended unless you know why)?")
    if [ "$go_on" = "y" ]; then
      echo "Aborting at step '$id'. Log: $LOG_FILE" >&2
      exit 1
    fi
  fi
}

# info_step: like run_step but never runs a command and is meant for
# "read this, acknowledge it" pointers (used by section f).
info_step() {
  run_step "$1" "$2" "$3" "$4" ""
}

# ── background-runner + log-polling helpers ─────────────────────────────────

start_runner() {
  local label="$1" logfile="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[DRY RUN] would start: muon runner  (log: $logfile)" >&2
    return 0
  fi
  ( muon runner > "$logfile" 2>&1 & echo $! > "$logfile.pid" )
  sleep 1
  local pid
  pid="$(cat "$logfile.pid")"
  echo "$pid" >> "$PIDS_FILE"
  echo "started runner '$label' (pid $pid), log: $logfile" >&2
}

kill_runner() {
  local logfile="$1"
  if [ "$DRY_RUN" -eq 1 ] || [ ! -f "$logfile.pid" ]; then
    return 0
  fi
  local pid
  pid="$(cat "$logfile.pid")"
  echo "SIGKILL runner pid $pid (simulating a hard crash mid-dispatch)" >&2
  kill -9 "$pid" 2>/dev/null || true
}

wait_for_pattern() {
  # args: file pattern(extended-regex) timeout_seconds description
  local file="$1" pattern="$2" timeout="$3" desc="$4" waited=0
  if [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  while ! grep -qE "$pattern" "$file" 2>/dev/null; do
    if [ "$waited" -ge "$timeout" ]; then
      echo "⚠ timed out after ${timeout}s waiting for: $desc (see $file)" >&2
      return 1
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 0
}

extract_approval_id() { grep -oE -- '--approval-id [A-Za-z0-9._-]+' "$1" 2>/dev/null | head -1 | awk '{print $2}'; }
extract_job_id()      { grep -oE 'dispatch [A-Za-z0-9._-]+ queued' "$1" 2>/dev/null | head -1 | awk '{print $2}'; }
extract_chat_id()     { grep -oE '^chat [A-Za-z0-9._-]+,' "$1" 2>/dev/null | head -1 | awk '{print $2}' | tr -d ','; }
extract_note_id()     { grep -oE '^- [A-Za-z0-9._-]+ \|' "$1" 2>/dev/null | head -1 | awk '{print $2}'; }

cleanup() {
  if [ -s "$PIDS_FILE" ]; then
    echo "" >&2
    echo "Cleaning up background runner processes started by this campaign..." >&2
    while IFS= read -r pid; do
      [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done < "$PIDS_FILE"
  fi
}
trap cleanup EXIT

# ═════════════════════════════════════════════════════════════════════════
# SECTION (a) — PREFLIGHT
# ═════════════════════════════════════════════════════════════════════════

section_a() {
  section_enabled a || return 0
  echo "" >&2
  echo "################  SECTION (a) — PREFLIGHT  ################" >&2

  run_step "a1.doctor" "a" \
    "muon doctor reports a real, dispatch-ready fleet" \
    "status is 'ready' or 'degraded' (never 'blocked' on brain/runner); at least one of claude-code/codex shows dispatchReady=true with authMethod != 'none'/'unknown'. Read the printed vendor rows yourself before answering — this script cannot judge 'is this really MY account'." \
    "muon doctor --json | node -e '
      const data = JSON.parse(require(\"fs\").readFileSync(0, \"utf8\"));
      console.log(\"status:\", data.status, \"—\", data.headline);
      console.log(\"brain:\", data.brainHealth.state, \"| runner:\", data.runnerHealth.state, data.runnerHealth.detail);
      for (const v of data.vendors || []) {
        console.log(\` vendor \${v.vendor}: installed=\${v.installed} auth=\${v.auth} dispatchReady=\${v.dispatchReady} authMethod=\${v.authMethod} cliVersion=\${v.cliVersion ?? \"(unknown)\"}\`);
        console.log(\`   detail: \${v.detail}\`);
      }
      const real = (data.vendors || []).some((v) => v.dispatchReady && v.vendor !== \"fake\");
      if (!real) { console.error(\"No real (non-fake) vendor is dispatch-ready.\"); process.exit(1); }
    '"

  run_step "a2.toolchain" "a" \
    "git and node are present and sane" \
    "both print a version string; node major version >= 18 (node:test runner used by the golden-task scaffold requires it)." \
    "git --version && node --version"

  run_step "a3.consent" "a" \
    "explicit consent to make REAL vendor calls" \
    "you understand this campaign will call the REAL Claude Code and REAL Codex CLIs on your own connected accounts — real API/subscription usage, real tokens, real cost, unlike every other MUON test number. If you are not ready for that, answer 'n' and re-run later." \
    ""

  run_step "a4.workspace-plan" "a" \
    "two disposable repos reserved, one per vendor" \
    "you understand section (b) creates repo A for Claude and section (c) creates repo B for Codex via scripts/make-disposable-repo.sh, each added to MUON_WORKSPACE_ROOTS for this campaign's MUON_DATA_DIR only (never your real repos)." \
    ""
}

# ═════════════════════════════════════════════════════════════════════════
# SECTIONS (b) / (c) — GOLDEN TASK, one real dispatch → evidence → approval →
# interruption → restart → memory confirm, parameterized per vendor.
# ═════════════════════════════════════════════════════════════════════════

golden_task_section() {
  local section="$1" lane="$2" label="$3" repo_slug="$4"
  section_enabled "$section" || return 0
  echo "" >&2
  echo "################  SECTION ($section) — $label GOLDEN TASK  ################" >&2

  local REPO_DIR="$DATA_DIR/repo-$repo_slug"
  local RUNNER_LOG="$DATA_DIR/runner-$repo_slug.log"
  local DISPATCH_LOG="$DATA_DIR/dispatch-$repo_slug.log"
  local DISPATCH2_LOG="$DATA_DIR/dispatch-$repo_slug-interrupt.log"

  if [ "$DRY_RUN" -eq 1 ]; then
    REPO_DIR="<repo-$repo_slug, created in step $section.1>"
  fi

  run_step "$section.1.scaffold" "$section" \
    "scaffold the disposable $label repo" \
    "a tiny git repo with one failing test is created; the last line printed is REPO_PATH=<path>." \
    "\"$MAKE_REPO\" --dir \"$DATA_DIR/repo-$repo_slug\" --force"

  if [ "$DRY_RUN" -ne 1 ]; then
    REPO_DIR="$DATA_DIR/repo-$repo_slug"
  fi

  run_step "$section.2.workspace-root" "$section" \
    "allow the $label repo in MUON's workspace allowlist" \
    "MUON_WORKSPACE_ROOTS now includes $REPO_DIR for the rest of this campaign process." \
    "export MUON_WORKSPACE_ROOTS=\"\${MUON_WORKSPACE_ROOTS:+\$MUON_WORKSPACE_ROOTS:}$REPO_DIR\""

  run_step "$section.3.runner-up" "$section" \
    "start a persistent runner for this campaign's brain" \
    "muon doctor --json reports runnerHealth.live == true within a few seconds." \
    "start_runner '$label' '$RUNNER_LOG'; sleep 3; muon doctor --json | node -e 'const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")); console.log(\"runner live:\", d.runnerHealth.live, d.runnerHealth.detail); if (!d.runnerHealth.live) process.exit(1)'"

  local TASK_ID="<task-id, captured in step $section.4>"
  run_step "$section.4.task-create" "$section" \
    "create the golden-task ledger entry" \
    "a task row is created with status backlog and workspacePath == $REPO_DIR." \
    "TASK_JSON=\$(muon task create --title '$label golden task' --description 'Fix the failing test in test/greet.test.js; additive only' --priority low --workspace \"$REPO_DIR\" --json); echo \"\$TASK_JSON\"; echo \"\$TASK_JSON\" > \"$DATA_DIR/task-$repo_slug.json\""

  if [ "$DRY_RUN" -ne 1 ]; then
    TASK_ID="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(j.task.id)' "$DATA_DIR/task-$repo_slug.json" 2>/dev/null || echo '')"
    echo "  captured TASK_ID=$TASK_ID" >&2
  fi

  run_step "$section.5.dispatch-gated" "$section" \
    "dispatch the REAL $label run behind a fail-closed approval gate" \
    "the command BLOCKS and prints 'approval required before running (id: <approval-id>)'. This is a REAL $label CLI invocation — first real cost of the campaign." \
    "( muon run --lane $lane --task-id \"$TASK_ID\" --brief \"Fix the failing test in test/greet.test.js by completing src/greet.js's greet(name) function. Additive/minimal diff only.\" --record --harness review --require-approval --cwd \"$REPO_DIR\" > \"$DISPATCH_LOG\" 2>&1 & ) ; wait_for_pattern \"$DISPATCH_LOG\" 'approval required before running' \"$APPROVAL_TIMEOUT\" 'the approval-required line'; tail -n 5 \"$DISPATCH_LOG\""

  local APPROVAL_ID="<approval-id, captured in step $section.5>"
  if [ "$DRY_RUN" -ne 1 ]; then
    APPROVAL_ID="$(extract_approval_id "$DISPATCH_LOG")"
    echo "  captured APPROVAL_ID=$APPROVAL_ID" >&2
  fi

  run_step "$section.6.approve" "$section" \
    "approve the gate (Control) — releases the real $label run" \
    "'muon approve list' shows the pending approval; resolving it as approved unblocks the dispatch, which then starts streaming real progress into $DISPATCH_LOG." \
    "muon approve list; muon approve resolve --approval-id \"$APPROVAL_ID\" --status approved"

  run_step "$section.7.evidence" "$section" \
    "watch the real $label run to a terminal state and read the evidence" \
    "the dispatch reaches a terminal state (task.completed/task.blocked) within the dispatch timeout; 'muon report' shows a legible who/what/why trail reflecting REAL $label output — not the fake vendor's fixed artifact." \
    "wait_for_pattern \"$DISPATCH_LOG\" 'task\\.(completed|blocked|failed)' \"$DISPATCH_TIMEOUT\" 'a terminal dispatch event'; tail -n 20 \"$DISPATCH_LOG\"; muon report --task-id \"$TASK_ID\""

  local INTERRUPT_TASK_ID="<task-id, captured in step $section.8>"
  run_step "$section.8.second-task" "$section" \
    "create a SECOND golden task to interrupt mid-flight" \
    "a second task row is created in the same disposable repo." \
    "TASK2_JSON=\$(muon task create --title '$label interruption task' --description 'Add a short comment to README.md explaining the greet() fix; additive only' --priority low --workspace \"$REPO_DIR\" --json); echo \"\$TASK2_JSON\"; echo \"\$TASK2_JSON\" > \"$DATA_DIR/task2-$repo_slug.json\""

  if [ "$DRY_RUN" -ne 1 ]; then
    INTERRUPT_TASK_ID="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(j.task.id)' "$DATA_DIR/task2-$repo_slug.json" 2>/dev/null || echo '')"
  fi

  run_step "$section.9.dispatch-then-kill" "$section" \
    "dispatch the second real run, then SIGKILL the runner mid-flight" \
    "the dispatch is queued (job id printed), and shortly after the runner process is hard-killed. muon doctor --json then reports runnerHealth.live == false — a real crash-during-real-dispatch, not simulated." \
    "( muon run --lane $lane --task-id \"$INTERRUPT_TASK_ID\" --brief 'Add a one-sentence comment to README.md; additive only' --record --cwd \"$REPO_DIR\" > \"$DISPATCH2_LOG\" 2>&1 & ); wait_for_pattern \"$DISPATCH2_LOG\" 'dispatch .* queued' 30 'the dispatch-queued line'; sleep 2; kill_runner \"$RUNNER_LOG\"; sleep 2; muon doctor --json | node -e 'const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")); console.log(\"runner live:\", d.runnerHealth.live, d.runnerHealth.detail)'"

  local JOB_ID="<job-id, captured in step $section.9>"
  if [ "$DRY_RUN" -ne 1 ]; then
    JOB_ID="$(extract_job_id "$DISPATCH2_LOG")"
    echo "  captured JOB_ID=$JOB_ID" >&2
  fi

  run_step "$section.10.restart-recover" "$section" \
    "restart the runner and confirm recovery is visible and reclaimed" \
    "a fresh runner comes online; 'muon bundle resume' classifies the interrupted job (typically await-runner-reclaim), and the new runner's startup reclaim resumes/finishes it without a duplicate side effect." \
    "start_runner '$label-restart' \"$RUNNER_LOG.restart\"; sleep 3; muon bundle resume \"$JOB_ID\" --out \"$DATA_DIR/resume-$repo_slug.json\"; wait_for_pattern \"$RUNNER_LOG.restart\" 'task\\.(completed|blocked|failed)' \"$DISPATCH_TIMEOUT\" 'the reclaimed job reaching a terminal state'; muon report --task-id \"$INTERRUPT_TASK_ID\""

  run_step "$section.11.memory-confirm" "$section" \
    "review and confirm the captured memory from the real run" \
    "'muon memory review' lists at least one unconfirmed note captured from the REAL run harness; confirming it moves it into 'confirmed' and it will surface on the next pre-edit gate for touched files." \
    "muon memory review > \"$DATA_DIR/memory-review-$repo_slug.txt\"; cat \"$DATA_DIR/memory-review-$repo_slug.txt\"; NOTE_ID=\$(extract_note_id \"$DATA_DIR/memory-review-$repo_slug.txt\"); if [ -n \"\$NOTE_ID\" ]; then muon memory confirm --note-id \"\$NOTE_ID\"; else echo 'no unconfirmed note found — review the output above manually'; fi"

  echo "$REPO_DIR" > "$DATA_DIR/repo-$repo_slug.path"
  echo "$TASK_ID" > "$DATA_DIR/task-$repo_slug.id"
  echo "$JOB_ID" > "$DATA_DIR/job-$repo_slug.id"
}

# ═════════════════════════════════════════════════════════════════════════
# SECTION (c) extra — Codex BYOK / custom-provider variant
# ═════════════════════════════════════════════════════════════════════════

section_c_byok_variant() {
  section_enabled c || return 0
  echo "" >&2
  echo "################  SECTION (c) — CODEX BYOK / CUSTOM-PROVIDER VARIANT  ################" >&2

  local REPO_DIR
  REPO_DIR="$(cat "$DATA_DIR/repo-codex.path" 2>/dev/null || echo "<repo-codex, from section c>")"

  run_step "c.byok.1.switch-identity" "c" \
    "switch Codex to a BYOK / custom-provider identity" \
    "you have EITHER exported a direct key (e.g. OPENAI_API_KEY) OR set an active [model_providers.<id>] in ~/.codex/config.toml with model_provider pointing at it (per docs/research/vendor-provider-readiness.md). Do this in your own shell/config now — this script never touches vendor credential files." \
    ""

  run_step "c.byok.2.doctor-reflects-it" "c" \
    "muon doctor reflects the new credential method, honestly" \
    "the codex row's authMethod is now 'api-key' or 'custom-provider' (not 'vendor-login'), even if 'codex login status' itself is negative — this is the documented distinction from vendor-provider-readiness.md ('native status reported Not logged in while the configured Azure provider passed Codex's own diagnostic path')." \
    "muon doctor --json | node -e 'const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")); const c=(d.vendors||[]).find(v=>v.vendor===\"codex\"); console.log(JSON.stringify(c,null,2))'"

  local TASK_ID="<task-id, captured below>"
  run_step "c.byok.3.task-create" "c" \
    "create a small task for the BYOK dispatch" \
    "a task row is created against the same repo-codex workspace." \
    "TASK_JSON=\$(muon task create --title 'codex BYOK variant task' --description 'Add a one-line comment to src/greet.js noting the fix; additive only' --priority low --workspace \"$REPO_DIR\" --json); echo \"\$TASK_JSON\"; echo \"\$TASK_JSON\" > \"$DATA_DIR/task-codex-byok.json\""
  if [ "$DRY_RUN" -ne 1 ]; then
    TASK_ID="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(j.task.id)' "$DATA_DIR/task-codex-byok.json" 2>/dev/null || echo '')"
  fi

  local LOGF="$DATA_DIR/dispatch-codex-byok.log"
  run_step "c.byok.4.dispatch-and-approve" "c" \
    "dispatch under the BYOK/custom-provider identity, gated, and approve it" \
    "the run authenticates with ONLY the selected key/provider variable (never your native login token, never another vendor's key — see the sentinel-audit invariant in vendor-provider-readiness.md); it completes like any other real dispatch." \
    "( muon run --lane codex --task-id \"$TASK_ID\" --brief 'Add a one-line comment to src/greet.js noting the fix; additive only' --record --require-approval --cwd \"$REPO_DIR\" > \"$LOGF\" 2>&1 & ); wait_for_pattern \"$LOGF\" 'approval required before running' \"$APPROVAL_TIMEOUT\" 'the approval-required line'; APPROVAL_ID=\$(extract_approval_id \"$LOGF\"); muon approve resolve --approval-id \"\$APPROVAL_ID\" --status approved; wait_for_pattern \"$LOGF\" 'task\\.(completed|blocked|failed)' \"$DISPATCH_TIMEOUT\" 'a terminal dispatch event'; tail -n 15 \"$LOGF\""

  run_step "c.byok.5.no-cross-credential" "c" \
    "confirm no foreign/native credential leaked to this run" \
    "you have visually scanned $LOGF and the workspace diff, and see no credential value, no native-login token, and no other vendor's key anywhere — only the BYOK identity you selected in c.byok.1 was used." \
    ""
}

# ═════════════════════════════════════════════════════════════════════════
# SECTION (d) — NATIVE TAKEOVER FENCING
# ═════════════════════════════════════════════════════════════════════════

section_d() {
  section_enabled d || return 0
  echo "" >&2
  echo "################  SECTION (d) — NATIVE TAKEOVER FENCING  ################" >&2

  local REPO_A REPO_B
  REPO_A="$(cat "$DATA_DIR/repo-claude.path" 2>/dev/null || echo "<repo-claude, from section b>")"
  REPO_B="$(cat "$DATA_DIR/repo-codex.path" 2>/dev/null || echo "<repo-codex, from section c>")"

  run_step "d.1.native-claude" "d" \
    "open native Claude Code under MUON's audited proxy, then exit it" \
    "the vendor's OWN genuine terminal UI opens (colors, /model, /permissions, its real keyboard shortcuts) — MUON does not wrap or reinterpret it. On exit, 'muon task list --json' shows a 'Native Claude Code session' task with lifecycle + changed-file coordinates, and no raw terminal bytes were promoted to trusted memory." \
    "cd \"$REPO_A\" && muon claude; cd - >/dev/null; muon task list --json | node -e 'const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")); console.log(d.tasks.filter(t=>t.title.includes(\"Native\")).slice(-3))'"

  run_step "d.2.native-codex" "d" \
    "open native Codex under MUON's audited proxy, then exit it" \
    "same as d.1, for Codex's own genuine terminal UI." \
    "cd \"$REPO_B\" && muon codex; cd - >/dev/null"

  run_step "d.3.native-cursor" "d" \
    "attempt native Cursor under MUON's audited proxy" \
    "EITHER Cursor's genuine CLI opens (readiness/native-takeover only — MUON never claims managed dispatch for it), OR, if no Cursor agent binary is installed, MUON prints an honest 'not installed' error naming the expected binaries (cursor-agent, agent). Either outcome is correct; a silent/dishonest failure is not." \
    "cd \"$REPO_A\" && muon cursor; cd - >/dev/null || true"

  local LOGF="$DATA_DIR/dispatch-fencing.log"
  run_step "d.4.collision-fencing" "d" \
    "confirm MUON refuses native takeover while it owns the same workspace" \
    "with a MUON-managed dispatch active in $REPO_A, 'muon claude' in the SAME workspace refuses with an explicit 'A MUON-managed dispatch is active in this workspace' error — never a silent double-drive of the same repo." \
    "TASK_JSON=\$(muon task create --title 'fencing collision task' --description 'long-running placeholder for collision test' --priority low --workspace \"$REPO_A\" --json); TID=\$(echo \"\$TASK_JSON\" | node -e 'const j=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")); process.stdout.write(j.task.id)'); ( muon run --lane claude-code --task-id \"\$TID\" --brief 'Sleep-equivalent placeholder task to hold the workspace lease' --cwd \"$REPO_A\" > \"$LOGF\" 2>&1 & ); sleep 3; ( cd \"$REPO_A\" && muon claude ) ; echo '(a refusal above is SUCCESS for this step)'"
}

# ═════════════════════════════════════════════════════════════════════════
# SECTION (e) — NEW-FEATURE PASSES
# ═════════════════════════════════════════════════════════════════════════

section_e() {
  section_enabled e || return 0
  echo "" >&2
  echo "################  SECTION (e) — NEW-FEATURE PASSES  ################" >&2

  local REPO_A
  REPO_A="$(cat "$DATA_DIR/repo-claude.path" 2>/dev/null || echo "<repo-claude, from section b>")"

  # -- e1: model picker --------------------------------------------------
  run_step "e1.model-reject" "e" \
    "model picker rejects a bogus model id before touching the network" \
    "the command exits non-zero with '--model rejected: ...' — validated client-side, no real vendor call is made for the bad id." \
    "muon chat --workspace \"$REPO_A\" --model not-a-real-model --message 'hello' || true"

  run_step "e2.model-accept" "e" \
    "model picker accepts a real model id and the orchestrator runs on it" \
    "the turn completes normally (no rejection); this is a REAL orchestrator turn on the selected model." \
    "muon chat --workspace \"$REPO_A\" --model sonnet --message 'Reply with a one-sentence status of this workspace; no dispatch needed.'"

  # -- e2: budget raise (desktop UI act) ----------------------------------
  local CHATLOG="$DATA_DIR/chat-budget-raise.log"
  run_step "e3.budget-mission" "e" \
    "dispatch a multi-lane mission (creates a descendant budget pool)" \
    "the chat starts a mission that fans out to more than one worker; the printed line 'chat <id>, workspace ...' gives you the chat id to open in the desktop cockpit next." \
    "printf '%s\\n/quit\\n' 'Dispatch two independent Claude workers in parallel in this workspace: one adds a CONTRIBUTING.md stub, the other adds a one-line comment to package.json. Keep both additive.' | muon chat --workspace \"$REPO_A\" > \"$CHATLOG\" 2>&1; cat \"$CHATLOG\""

  local CHAT_ID="<chat-id, captured in step e3>"
  if [ "$DRY_RUN" -ne 1 ]; then
    CHAT_ID="$(extract_chat_id "$CHATLOG")"
    echo "  captured CHAT_ID=$CHAT_ID" >&2
    echo "$CHAT_ID" > "$DATA_DIR/chat-budget.id"
  fi

  run_step "e4.budget-raise-ui" "e" \
    "raise the mission's descendant budget in the desktop cockpit (operator act)" \
    "MANUAL: open the desktop app pointed at THIS campaign's data dir — 'MUON_DATA_DIR=$DATA_DIR npm run dev:desktop' from a NEW terminal (it should ATTACH to the already-running embedded brain, not start a second one; see docs/testing/desktop-tui-walkthrough.md's 'do not start a second backend' warning). Open chat $CHAT_ID, find the mission's budget control, and click [Raise] twice. Confirm the remaining-pool number visibly increases both times before you answer here." \
    ""

  # -- e5: bundle export + resume dry run ---------------------------------
  local BUNDLE_FILE="$DATA_DIR/bundle-budget-mission.json"
  run_step "e5.bundle-export" "e" \
    "export a portable run bundle for the mission chat" \
    "a v2 JSON bundle is written; the summary line shows job/mission/handoff/approval/milestone counts and a checkpoint phase mix." \
    "muon bundle export \"$CHAT_ID\" --chat --out \"$BUNDLE_FILE\""

  run_step "e6.bundle-resume-dry" "e" \
    "resume-plan the mission chat as a DRY RUN (zero ledger writes)" \
    "the plan renders per-job resume actions (e.g. already-resumed / none-still-queued / decide-gate) and ends with 'dry run — zero ledger writes were performed.' — no --execute is passed." \
    "muon bundle resume \"$CHAT_ID\" --chat --from \"$BUNDLE_FILE\""

  # -- e7/e8: policy profile + receipt round-trip -------------------------
  run_step "e7.policy-explain" "e" \
    "explain MUON's policy posture for this workspace" \
    "the built-in default profile posture prints per action-class (allow/gate/deny) with the honest 'dry-run only' footer, since no stored workspace profile exists yet." \
    "muon policy explain --workspace \"$REPO_A\""

  local RLOGF="$DATA_DIR/dispatch-receipt.log"
  local TASK_ID="<task-id>"
  run_step "e8.receipt-task" "e" \
    "create a small gated task to mint a receipt against" \
    "a task row is created in repo A." \
    "TASK_JSON=\$(muon task create --title 'receipt round-trip task' --description 'Add a one-line note to README.md; additive only' --priority low --workspace \"$REPO_A\" --json); echo \"\$TASK_JSON\" > \"$DATA_DIR/task-receipt.json\""
  if [ "$DRY_RUN" -ne 1 ]; then
    TASK_ID="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(j.task.id)' "$DATA_DIR/task-receipt.json" 2>/dev/null || echo '')"
  fi

  run_step "e9.receipt-dispatch-gate" "e" \
    "file the gate for the receipt round-trip (leave it PENDING for the next step)" \
    "the run blocks with 'approval required before running (id: ...)' — leave it pending; you will approve it FROM THE DESKTOP UI in the next step so you can opt into a receipt." \
    "( muon run --lane claude-code --task-id \"$TASK_ID\" --brief 'Add a one-line note to README.md; additive only' --record --require-approval --cwd \"$REPO_A\" > \"$RLOGF\" 2>&1 & ); wait_for_pattern \"$RLOGF\" 'approval required before running' \"$APPROVAL_TIMEOUT\" 'the approval-required line'; tail -n 5 \"$RLOGF\""

  run_step "e10.receipt-mint-ui" "e" \
    "approve the gate in the desktop UI WITH the receipt opt-in checked" \
    "MANUAL: in the same desktop window from step e4, open the pending approval, check the receipt opt-in box, pick a TTL, and Confirm. The dispatch in step e9 then proceeds (watch $RLOGF)." \
    ""

  run_step "e11.receipt-list" "e" \
    "confirm the minted receipt is live via the CLI" \
    "'muon policy receipts' lists at least one live, content-bound, expiring receipt for this workspace (id, tool, action class, payload digest, expiry, use count)." \
    "muon policy receipts --workspace \"$REPO_A\""

  # -- e12: chat archive ----------------------------------------------------
  run_step "e12.chat-archive" "e" \
    "archive the budget-mission chat" \
    "prints '✓ archived chat <id> (...); its history and audit trail are preserved' — non-destructive soft-delete." \
    "muon chat --workspace \"$REPO_A\" --archive --chat-id \"$CHAT_ID\""

  run_step "e13.chat-archive-ui" "e" \
    "confirm the chat left the active list in the desktop sidebar" \
    "MANUAL: in the desktop sidebar, chat $CHAT_ID no longer appears among active chats (and does appear if you switch to an archived/all filter, if the UI has one)." \
    ""

  # -- e14: crew-click stream -------------------------------------------
  run_step "e14.crew-click" "e" \
    "click a running AND a finished crew node to open the session workspace" \
    "MANUAL: in the desktop cockpit's mission tree (from section b's golden task or this section's mission), click a RUNNING agent preview and confirm it opens a closable central session tab; then click a FINISHED one and confirm the same. Inspect Overview, Timeline, Changes, Tools, Capabilities, Commands, and Audit inside it." \
    ""
}

# ═════════════════════════════════════════════════════════════════════════
# SECTION (f) — PACKAGED-APP PASS POINTERS (not executed here — separate gate)
# ═════════════════════════════════════════════════════════════════════════

section_f() {
  section_enabled f || return 0
  echo "" >&2
  echo "################  SECTION (f) — PACKAGED-APP PASS POINTERS  ################" >&2
  echo "These are POINTERS, not executed by this script — the packaged/virgin-Mac" >&2
  echo "pass is a separate release gate (ROADMAP.md 'Before public v0') with its own" >&2
  echo "unsigned-build, Gatekeeper, and notarization concerns this campaign does not" >&2
  echo "cover." >&2

  info_step "f1.package-dir" "f" \
    "build the unsigned packaged desktop app" \
    "run this SEPARATELY when ready for the packaged-app pass: 'npm run --prefix apps/desktop package:dir' — read docs/testing/desktop-tui-walkthrough.md's 'Automated release gate' section for the full command list first."

  info_step "f2.packaged-smokes" "f" \
    "run the packaged runner + desktop smokes" \
    "'npm run --prefix apps/desktop smoke:packaged-runner' and 'smoke:packaged-desktop' — these prove migration/dispatch/restart/crash recovery on the PACKAGED binary, hermetically (fake vendor); they do not replace this real-vendor campaign, and this campaign does not replace them."

  info_step "f3.virgin-mac" "f" \
    "schedule a real-vendor pass on a clean/virgin Mac" \
    "ROADMAP.md 'Before public v0' requires a virgin-Mac real-vendor beta before public distribution — this campaign proves the real-vendor path works AT ALL on a dev machine; it is not a substitute for the clean-machine install/Gatekeeper/onboarding pass."
}

# ═════════════════════════════════════════════════════════════════════════
# MAIN
# ═════════════════════════════════════════════════════════════════════════

section_a
golden_task_section b claude-code Claude claude
golden_task_section c codex Codex codex
section_c_byok_variant
section_d
section_e
section_f

echo "" >&2
echo "════════════════════════════════════════════════════════════════════" >&2
echo " Campaign steps complete. Log: $LOG_FILE" >&2
echo " Data dir (kept, not auto-deleted): $DATA_DIR" >&2
echo " Disposable repos live under: $DATA_DIR/repo-*" >&2
echo "" >&2
echo " Teardown when you are done reviewing evidence:" >&2
echo "   rm -rf \"$DATA_DIR\"" >&2
echo "════════════════════════════════════════════════════════════════════" >&2
