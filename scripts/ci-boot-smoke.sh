#!/usr/bin/env bash
#
# Backend boot smoke test, the single most valuable check in MUON's CI.
#
# Boots the REAL backend on the embedded local-first path (SQLite in a throwaway
# per-user data dir, no external Postgres, see docs/adr/0008-embedded-brain-sqlite.md)
# and curls /health expecting `{"status":"ok"}`.
#
# Unit tests mock Prisma and never open the native graph store, so they cannot
# catch:
#   * the corrupt/incompatible LadybugDB store SEGFAULT-on-open (uncatchable by JS),
#   * schema-materialization (ensureSchema / migrations) regressions,
#   * env / bootstrap / listen wiring regressions.
# A real boot does. If the process dies before answering /health, this fails.
#
# The embedded brain binds 127.0.0.1:0 (OS-assigned port) and publishes the port
# in <dataDir>/brain.lock, so we read the port from there rather than guessing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BACKEND_ENTRY="$ROOT/backend/dist/index.js"
if [ ! -f "$BACKEND_ENTRY" ]; then
  echo "ERROR: $BACKEND_ENTRY not found, run scripts/ci-install.sh first." >&2
  exit 1
fi

# F6: the graph boot-probe child is loaded by RUNTIME PATH (not a static import),
# so a bundler (esbuild/pkg, the desktop bundles the backend) can silently drop
# it, self-disabling corrupt-store auto-recovery. Assert the build emitted it.
PROBE_CHILD="$ROOT/backend/dist/lib/graph-probe-child.js"
if [ ! -f "$PROBE_CHILD" ]; then
  echo "ERROR: $PROBE_CHILD not found, the graph boot-probe would self-disable (corrupt-store auto-recovery lost). Ensure the build/bundle emits it." >&2
  exit 1
fi

# Embedded path: DATABASE_URL UNSET => the backend computes file:<dataDir>/muon.db.
unset DATABASE_URL || true

# Throwaway data dir (holds the SQLite db, graph store and lockfile) + an empty
# working dir so dotenv finds no backend/.env to inject a hosted Postgres URL.
DATA_DIR="$(mktemp -d)"
RUN_CWD="$(mktemp -d)"
mkdir -p "$DATA_DIR/graph"

export MUON_DATA_DIR="$DATA_DIR"
# Container/CI hosts can't load the Ladybug FTS native extension; retrieval still
# works (lexical + salience). Mirrors the production (Railway) graph config.
export MUON_GRAPH_DISABLE_FTS=1
export NODE_ENV=production

LOG="$DATA_DIR/boot.log"

( cd "$RUN_CWD" && exec node "$BACKEND_ENTRY" ) >"$LOG" 2>&1 &
PID=$!

cleanup() {
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  rm -rf "$DATA_DIR" "$RUN_CWD"
}
trap cleanup EXIT

LOCK="$DATA_DIR/brain.lock"
echo "Booting embedded brain (data dir: $DATA_DIR); waiting for $LOCK ..."
for _ in $(seq 1 120); do
  [ -f "$LOCK" ] && break
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "ERROR: backend exited before publishing its lockfile. Boot log:" >&2
    cat "$LOG" >&2
    exit 1
  fi
  sleep 0.5
done
if [ ! -f "$LOCK" ]; then
  echo "ERROR: timed out (60s) waiting for the brain lockfile. Boot log:" >&2
  cat "$LOG" >&2
  exit 1
fi

PORT="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).port))" "$LOCK")"
if [ -z "$PORT" ] || [ "$PORT" = "0" ]; then
  echo "ERROR: could not read a valid port from $LOCK" >&2
  cat "$LOG" >&2
  exit 1
fi
echo "Embedded brain listening on http://127.0.0.1:$PORT"

URL="http://127.0.0.1:$PORT/health"
echo "GET $URL"
BODY="$(curl -fsS --retry 5 --retry-connrefused --retry-delay 1 "$URL")"
echo "Response: $BODY"

case "$BODY" in
  *'"status":"ok"'*)
    echo "PASS: embedded backend booted and /health returned status ok"
    ;;
  *)
    echo "FAIL: /health did not return status ok" >&2
    cat "$LOG" >&2
    exit 1
    ;;
esac
