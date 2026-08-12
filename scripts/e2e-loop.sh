#!/usr/bin/env bash
#
# MUON P7, FULL-LOOP end-to-end harness entrypoint.
#
# Boots the REAL embedded backend (node backend/dist/index.js) AND drives the
# REAL persistent runner in-process, dispatching a task to a deterministic FAKE
# vendor over LIVE loopback HTTP. Where scripts/e2e-smoke.sh proves the MOAT loop
# (memory + governance + auth), this proves the ORCHESTRATION SPINE: dispatch →
# claim agent (0–3 semaphore) → claim job → execute → stream → capture → release,
# plus the invariants (two-token boundary, P3-B workspace sandbox, vendor
# isolation, steer/interrupt wiring).
#
# Hermetic + deterministic: temp data dir (its own SQLite + .lbug + lockfile),
# DATABASE_URL unset (embedded path), MUON_EMBED_DISABLE=1 (lexical brain), no
# network, an EMPTY PATH so no real vendor CLI can spawn, and MUON_FAKE_VENDOR=1
# so ONLY the dev/test fake vendor leaf is substituted. The dev's real brain dir
# is never touched. Exits non-zero on any failed assertion.
#
# Run locally: `bash scripts/e2e-loop.sh` (after scripts/ci-install.sh).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BACKEND_ENTRY="$ROOT/backend/dist/index.js"
if [ ! -f "$BACKEND_ENTRY" ]; then
  echo "ERROR: $BACKEND_ENTRY not found, run scripts/ci-install.sh first." >&2
  exit 1
fi

# The full-loop harness drives the built runner in-process; make sure it exists.
RUNNER_ENTRY="$ROOT/packages/runner/dist/index.js"
if [ ! -f "$RUNNER_ENTRY" ]; then
  echo "ERROR: $RUNNER_ENTRY not found, build @muon/runner (scripts/ci-install.sh)." >&2
  exit 1
fi

export E2E_BACKEND_ENTRY="$BACKEND_ENTRY"
# Belt-and-suspenders: the in-process runner reads this when a job executes.
export MUON_FAKE_VENDOR=1

echo "Running MUON P7 FULL-LOOP harness (real backend + real runner + fake vendor)..."
exec node "$ROOT/backend/tests/e2e/e2e-loop.mjs"
