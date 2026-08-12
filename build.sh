#!/usr/bin/env bash
#
# Build ALL of MUON, in dependency order, into the dist/ directories the
# installed binaries actually run.
#
# WHY THIS EXISTS. `muon` and `muon-mcp` on this machine are symlinks INTO this
# repo:
#
#   ~/.local/.../bin/muon      -> …/@muon/cli/dist/index.js  -> apps/cli
#   ~/.local/.../bin/muon-mcp  -> …/@muon/mcp/dist/index.js  -> packages/mcp
#
# So a stale `dist/` is not a build artifact — it IS the installed product. Edit
# a package, forget to build it, and every surface (CLI, MCP server the vendor
# spawns, desktop, TUI) keeps running yesterday's code while the source says
# otherwise. That has burned real sessions: a live MCP server serving 27 tools
# while the tree defined 30, and an e2e run against a `dist/` from three days
# earlier.
#
# Run this before running the app, before dev, and after pulling. It is
# idempotent and safe to run at any time.
#
# Usage:
#   ./build.sh              build everything, then verify
#   ./build.sh --fast       skip `npm install` (deps already present)
#   ./build.sh --no-verify  skip the post-build checks
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$PWD"

FAST=0
VERIFY=1
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --no-verify) VERIFY=0 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build.sh: unknown option '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; RESET=$'\033[0m'
step() { printf "%s==>%s %s\n" "$BOLD" "$RESET" "$1"; }
ok()   { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
warn() { printf "  %s!%s %s\n" "$YELLOW" "$RESET" "$1"; }
fail() { printf "  %s✗%s %s\n" "$RED" "$RESET" "$1"; }

started_at=$(date +%s)

# ── 1. Dependencies ──────────────────────────────────────────────────────────
if [ "$FAST" -eq 0 ]; then
  step "Installing dependencies"
  npm install --silent
  ok "npm install"
else
  step "Skipping npm install (--fast)"
fi

# ── 2. Prisma client ─────────────────────────────────────────────────────────
# The backend imports @prisma/client, which does not exist until generate has
# run against the schema. A fresh clone (or a schema change) leaves every
# backend build failing on an import that looks fine in the editor.
step "Generating the Prisma client"
npm run --prefix backend --silent prisma:generate >/dev/null
ok "prisma generate"

# ── 3. Packages, in dependency order ─────────────────────────────────────────
# ORDER IS THE WHOLE POINT. Each package compiles against its dependencies'
# EMITTED .d.ts, so building out of order fails confusingly (or, worse,
# succeeds against a stale one). Derived from the @muon/* dependency graph:
#
#   protocol, graph          (no MUON deps)
#   client, adapters         <- protocol
#   codegraph                <- graph
#   core                     <- protocol client adapters
#   orchestrator             <- protocol client core
#   runner                   <- protocol client core orchestrator
#   mcp                      <- protocol client core adapters graph
#   backend                  <- all of the above
#   cli, tui, desktop        <- the packages
BUILD_ORDER=(
  "packages/protocol"
  "packages/graph"
  "packages/client"
  "packages/adapters"
  "packages/codegraph"
  "packages/core"
  "packages/orchestrator"
  "packages/runner"
  "packages/mcp"
  "backend"
  "apps/cli"
  "apps/tui"
  "apps/desktop"
)

step "Building ${#BUILD_ORDER[@]} workspaces in dependency order"
for pkg in "${BUILD_ORDER[@]}"; do
  name=$(node -p "require('./$pkg/package.json').name" 2>/dev/null || echo "$pkg")
  printf "  %s…%s %-22s %s" "$DIM" "$RESET" "$name" "$DIM"
  if npm run --prefix "$pkg" --silent build >/tmp/muon-build-$$.log 2>&1; then
    printf "%s\r" "$RESET"
    ok "$(printf '%-22s built' "$name")"
  else
    printf "%s\n" "$RESET"
    fail "$name FAILED"
    echo
    tail -30 /tmp/muon-build-$$.log
    rm -f /tmp/muon-build-$$.log
    exit 1
  fi
done
rm -f /tmp/muon-build-$$.log

# ── 4. Restart a brain that predates this build ──────────────────────────────
# A RUNNING PROCESS IS STALE THE SAME WAY A dist/ IS. The brain executes the
# code it loaded at startup, so after a rebuild it keeps serving the old
# backend while every file on disk says otherwise. That is not theoretical: it
# is how a freshly built 10-minute lease came back as the old 2-minute one, and
# the only clue was that the number was wrong.
#
# The lockfile is written when the brain starts, so its mtime IS the brain's
# start time — older than the backend we just built means stale. The brain is
# stopped rather than restarted here: every MUON surface starts one on demand,
# and with the stable default port it comes back on the SAME address, so
# nothing that pinned it is disturbed.
# EVERY PROFILE, not just the canonical one. A machine can hold more than one
# brain lockfile: the CLI's data dir (`…/Application Support/MUON`) and the
# desktop's own Electron profile (`…/Application Support/@muon/desktop`) are
# different directories, and `discoverLiveBrain` adopts whichever is live. A
# check that looked only at the canonical path reported "no live brain to
# restart" while the desktop's brain — a minute older than the build — kept
# serving the previous backend. That is the exact failure this step exists to
# catch, so it hunts for all of them.
BACKEND_ENTRY="$ROOT/backend/dist/index.js"
LOCKFILES=()
while IFS= read -r found; do
  [ -n "$found" ] && LOCKFILES+=("$found")
done < <(
  {
    find "$HOME/Library/Application Support" -maxdepth 3 -name brain.lock 2>/dev/null
    find "${XDG_DATA_HOME:-$HOME/.local/share}" -maxdepth 3 -name brain.lock 2>/dev/null
  } | sort -u
)

if [ -f "$BACKEND_ENTRY" ]; then
  step "Checking running brains (${#LOCKFILES[@]} profile(s) found)"
  if [ "${#LOCKFILES[@]}" -eq 0 ]; then
    ok "none running — the next muon command starts one on this build"
  fi
  stopped_any=0
  stopped_pids=()
  # `"${LOCKFILES[@]}"` on an EMPTY array is an unbound-variable abort under
  # `set -u` in bash 3.2 — which is stock /bin/bash on macOS. A fresh clone or
  # a CI runner has no lockfile at all, so the script built every workspace and
  # then died with a message naming nothing about brains. The count guard above
  # is safe; the iteration is not.
  for lock in ${LOCKFILES[@]+"${LOCKFILES[@]}"}; do
    profile=$(basename "$(dirname "$lock")")
    if [ "$lock" -nt "$BACKEND_ENTRY" ]; then
      ok "$profile: newer than this build, left alone"
      continue
    fi
    # JSON.parse, NOT require(): node loads an unknown extension as
    # JAVASCRIPT, so `require('brain.lock')` parsed `{"pid":…}` as a block
    # statement and returned {} — the pid came back undefined and this step
    # reported the reassuring "no live process" while the brain was serving.
    lock_field() {
      node -e "try{const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(j[process.argv[2]]??''))}catch(e){}" \
        "$1" "$2" 2>/dev/null || true
    }
    brain_pid=$(lock_field "$lock" pid)
    brain_port=$(lock_field "$lock" port)
    # PIDS RECYCLE. A lockfile left by a crashed brain can name a pid the OS
    # has since handed to something else entirely, and `kill -0` only proves
    # SOMETHING is there. Confirm the process is actually running the backend
    # before signalling it — the same refusal to trust a stale file that made
    # this step read the lockfile as JSON rather than require() it.
    brain_cmd=$(ps -p "${brain_pid:-0}" -o command= 2>/dev/null || true)
    case "$brain_cmd" in
      *backend/dist/index.js*) is_brain=1 ;;
      *) is_brain=0 ;;
    esac
    if [ -n "$brain_pid" ] && [ "$is_brain" -eq 1 ]; then
      kill "$brain_pid" 2>/dev/null || true
      stopped_any=1
      stopped_pids+=("$brain_pid")
      ok "$profile: stopped the stale brain (pid $brain_pid, port $brain_port) — it predated this build"
    elif [ -n "$brain_pid" ] && kill -0 "$brain_pid" 2>/dev/null; then
      # Something is alive on that pid and it is NOT a brain: the lockfile
      # outlived its process and the number was reused. Left alone, loudly.
      ok "$profile: lockfile names pid $brain_pid, which is not a MUON brain — left alone"
    else
      ok "$profile: stale lockfile, no live process"
    fi
  done
  if [ "$stopped_any" -eq 1 ]; then
    # WAIT FOR THE EXIT, do not sleep a guess. A brain still holding its socket
    # makes the next one fall back to an ephemeral port — the fallback working
    # correctly, but for a reason we created. Measured: a fixed 1.2s wait
    # produced 47100, 53876, 47100 across three restarts. Polling for the
    # process to actually go makes the address stable.
    for _ in $(seq 1 60); do
      still=0
      for pid in ${stopped_pids[@]+"${stopped_pids[@]}"}; do
        kill -0 "$pid" 2>/dev/null && still=1
      done
      [ "$still" -eq 0 ] && break
      node -e "setTimeout(()=>{},250)" 2>/dev/null || true
    done
    echo "    ${DIM}a MUON surface starts a fresh brain on demand; with the stable"
    echo "    default port it returns to the same address${RESET}"
  fi
fi

# ── 5. Verify what the machine will actually run ─────────────────────────────
# A build that succeeded is not the same fact as "the installed binary is now
# this code". These checks answer the second question, which is the one that
# has actually gone wrong.
if [ "$VERIFY" -eq 1 ]; then
  step "Verifying the installed surface"

  for bin in muon muon-mcp; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      warn "$bin is not on PATH — this repo is built, but nothing links to it"
      continue
    fi
    # realpath, NOT one readlink hop: the bin is a symlink to
    # `…/node_modules/@muon/cli/dist/index.js`, and it is the *directory*
    # `@muon/cli` that links into this repo. Following only the last component
    # resolved to a path outside the repo and cried wolf on a correct install.
    target=$(node -e "console.log(require('fs').realpathSync(process.argv[1]))" \
      "$(command -v "$bin")" 2>/dev/null || echo "")
    case "$target" in
      "$ROOT"/*) ok "$(printf '%-9s → %s' "$bin" "${target#"$ROOT"/}")" ;;
      "") warn "$bin resolves nowhere readable" ;;
      *)  warn "$bin does NOT point into this repo (${target}) — you are running a different MUON" ;;
    esac
  done

  # The live MCP surface. `muon mcp probe` spawns the binary a vendor would
  # spawn and compares what it SERVES against what this tree DEFINES — the one
  # check that catches "built, but the vendor still holds an older server".
  if command -v muon >/dev/null 2>&1; then
    if muon mcp probe >/tmp/muon-probe-$$.log 2>&1; then
      ok "$(sed -n '1s/^OK  //p' /tmp/muon-probe-$$.log | head -1)"
      sed -n '2,5p' /tmp/muon-probe-$$.log | sed 's/^/    /'
    else
      warn "mcp probe reported a problem:"
      sed -n '1,6p' /tmp/muon-probe-$$.log | sed 's/^/    /'
      warn "a vendor already running holds its OWN server — restart it to pick this up"
    fi
    rm -f /tmp/muon-probe-$$.log
  fi
fi

elapsed=$(( $(date +%s) - started_at ))
echo
printf "%sMUON built in %ss.%s\n" "$BOLD" "$elapsed" "$RESET"
echo "${DIM}A vendor CLI that is already running still holds the server it spawned;"
echo "restart it (or re-attach) to pick this build up.${RESET}"
