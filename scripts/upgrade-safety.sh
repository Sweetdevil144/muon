#!/usr/bin/env bash
#
# N → N+1 upgrade-safety harness (P0-4, the automatable half).
#
# Migration failures are the ONE class of bug a user cannot recover from and
# cannot roll back: their ledger is their missions, approvals, and confirmed
# memory. This harness proves an upgrade preserves it, using the REAL upgrade
# code path rather than a simulation:
#
#   1. Build a data dir exactly as an OLDER build left it: apply the committed
#      migrations up to a pinned version (PINNED_MIGRATION) with sqlite3, record
#      them in `_muon_migrations` the way ensureSchema does, and seed real
#      ledger rows (scripts/upgrade-fixtures/fixture-*.sql).
#   2. Boot the CURRENT backend against that data dir. ensureSchema applies
#      every later migration on boot — the identical path a downloaded update
#      runs on a user's machine.
#   3. Assert every seeded record is still reachable THROUGH THE API (not just
#      present in the file), the migration bookkeeping covers every committed
#      migration, and SQLite integrity/foreign-key checks pass.
#
# The pin is deliberately BEHIND head so the harness exercises a real N→N+1
# delta on every run. When a new migration ships, this immediately tests it
# against the old-shape data. Re-pin (and regenerate the fixture) only when a
# migration legitimately invalidates the fixture's INSERTs — and say so in the
# commit message.
#
# CI cost: one backend boot (~seconds). Run it with the release gate.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PINNED_MIGRATION="0049_memory_access_log"
FIXTURE="$ROOT/scripts/upgrade-fixtures/fixture-0049.sql"
MIGRATIONS_DIR="$ROOT/backend/prisma/migrations"
BACKEND_ENTRY="$ROOT/backend/dist/index.js"

if [ ! -f "$BACKEND_ENTRY" ]; then
  echo "ERROR: $BACKEND_ENTRY not found, run scripts/ci-install.sh (or npm run build --prefix backend) first." >&2
  exit 1
fi
if [ ! -d "$MIGRATIONS_DIR/$PINNED_MIGRATION" ]; then
  echo "ERROR: pinned migration '$PINNED_MIGRATION' no longer exists; re-pin the harness and regenerate the fixture." >&2
  exit 1
fi
if [ ! -f "$FIXTURE" ]; then
  echo "ERROR: fixture $FIXTURE not found." >&2
  exit 1
fi

DATA_DIR="$(mktemp -d)"
RUN_CWD="$(mktemp -d)"
mkdir -p "$DATA_DIR/graph"
DB="$DATA_DIR/muon.db"
LOG="$DATA_DIR/boot.log"
PID=""

cleanup() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$DATA_DIR" "$RUN_CWD"
}
trap cleanup EXIT

# ── 1. The OLD install ────────────────────────────────────────────────────────
echo "Building the N-state ledger at $PINNED_MIGRATION ..."
APPLIED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
sqlite3 "$DB" 'CREATE TABLE IF NOT EXISTS "_muon_migrations" ("version" TEXT PRIMARY KEY NOT NULL, "appliedAt" TEXT NOT NULL)'
OLD_COUNT=0
for m in $(ls "$MIGRATIONS_DIR" | grep -v migration_lock | sort); do
  sqlite3 "$DB" < "$MIGRATIONS_DIR/$m/migration.sql"
  sqlite3 "$DB" "INSERT INTO \"_muon_migrations\" (\"version\",\"appliedAt\") VALUES ('$m','$APPLIED_AT')"
  OLD_COUNT=$((OLD_COUNT + 1))
  [ "$m" = "$PINNED_MIGRATION" ] && break
done
TOTAL_COUNT=$(ls "$MIGRATIONS_DIR" | grep -cv migration_lock)
if [ "$OLD_COUNT" -ge "$TOTAL_COUNT" ]; then
  echo "WARNING: the pin is at (or past) head — no N→N+1 delta is being exercised. Land a migration or accept the reduced claim." >&2
fi
echo "  applied $OLD_COUNT of $TOTAL_COUNT committed migrations (delta on boot: $((TOTAL_COUNT - OLD_COUNT)))"

sqlite3 "$DB" < "$FIXTURE"
echo "  fixture seeded"

# ── 2. The UPGRADE: boot the current backend on the old ledger ────────────────
unset DATABASE_URL || true
export MUON_DATA_DIR="$DATA_DIR"
export MUON_GRAPH_DISABLE_FTS=1
export NODE_ENV=production

( cd "$RUN_CWD" && exec node "$BACKEND_ENTRY" ) >"$LOG" 2>&1 &
PID=$!

LOCK="$DATA_DIR/brain.lock"
echo "Booting the CURRENT backend on the N-state ledger ..."
for _ in $(seq 1 120); do
  [ -f "$LOCK" ] && break
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "ERROR: backend exited during the upgrade boot. Boot log:" >&2
    cat "$LOG" >&2
    exit 1
  fi
  sleep 0.5
done
[ -f "$LOCK" ] || { echo "ERROR: timed out waiting for brain.lock. Boot log:" >&2; cat "$LOG" >&2; exit 1; }

read -r PORT TOKEN <<EOF
$(python3 - "$LOCK" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
print(lock["port"], lock.get("token") or "")
PY
)
EOF

HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/health")"
echo "  /health: $HEALTH"

# ── 3. Every seeded record must still be reachable through the API ───────────
fetch() {
  curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT$1"
}

FAILED=0
require() { # $1 = api path, $2 = id that must appear
  if fetch "$1" | grep -q "$2"; then
    echo "  PASS $2 reachable via $1"
  else
    echo "  FAIL $2 NOT reachable via $1" >&2
    FAILED=1
  fi
}

require "/api/chats" "chat-upgrade-1"
require "/api/tasks" "task-upgrade-1"
require "/api/approvals" "approval-upgrade-1"

# Memory read via SQL (the API read is partition-fenced; survival is the claim
# here, and the note's partition semantics have their own tests).
if [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM \"MemoryNote\" WHERE id='mem-upgrade-1' AND text LIKE '%must survive%'")" = "1" ]; then
  echo "  PASS mem-upgrade-1 survived with its text intact"
else
  echo "  FAIL mem-upgrade-1 lost or mutated" >&2
  FAILED=1
fi

# ── 4. Migration bookkeeping + physical integrity ────────────────────────────
RECORDED=$(sqlite3 "$DB" 'SELECT COUNT(*) FROM "_muon_migrations"')
if [ "$RECORDED" = "$TOTAL_COUNT" ]; then
  echo "  PASS all $TOTAL_COUNT migrations recorded after boot"
else
  echo "  FAIL _muon_migrations has $RECORDED of $TOTAL_COUNT after boot" >&2
  FAILED=1
fi

INTEGRITY=$(sqlite3 "$DB" "PRAGMA integrity_check")
if [ "$INTEGRITY" = "ok" ]; then
  echo "  PASS integrity_check ok"
else
  echo "  FAIL integrity_check: $INTEGRITY" >&2
  FAILED=1
fi

FK=$(sqlite3 "$DB" "PRAGMA foreign_key_check" | head -5)
if [ -z "$FK" ]; then
  echo "  PASS foreign_key_check clean"
else
  echo "  FAIL foreign_key_check: $FK" >&2
  FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
  echo "UPGRADE-SAFETY FAILED — a migration lost or orphaned user data. Boot log:" >&2
  tail -50 "$LOG" >&2
  exit 1
fi

echo "UPGRADE-SAFETY PASSED — the N-state ledger ($PINNED_MIGRATION) upgraded to head with every record reachable."
