#!/usr/bin/env bash
#
# MUON P7, end-to-end integration harness entrypoint.
#
# Boots the REAL embedded backend (node backend/dist/index.js, NOT app.inject)
# on a FRESH throwaway data dir and drives the full moat + governance + auth loop
# over LIVE loopback HTTP. Where scripts/ci-boot-smoke.sh (P5a) proves the backend
# BOOTS, this proves the whole loop is WIRED: the two-token lockfile contract,
# onboarding readiness, the confirmed-only memory gate, the pre-edit hero, the
# operator/agent capability boundary, and durability across a real restart.
#
# Hermetic + deterministic: temp data dir (its own SQLite + .lbug + lockfile),
# DATABASE_URL unset (embedded path), MUON_EMBED_DISABLE=1 (lexical brain), no
# network, and the backend child runs with an EMPTY PATH so the vendor-readiness
# prober can never spawn a real vendor CLI. All lifecycle (spawn, restart, temp
# dir cleanup) is owned by the Node driver, which exits non-zero on any failed
# assertion. The developer's real brain data dir is never touched.
#
# Run locally: `npm run e2e` (from backend/) or `bash scripts/e2e-smoke.sh`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BACKEND_ENTRY="$ROOT/backend/dist/index.js"
if [ ! -f "$BACKEND_ENTRY" ]; then
  echo "ERROR: $BACKEND_ENTRY not found, run scripts/ci-install.sh first." >&2
  exit 1
fi

# Same F6 guard as the boot smoke: the graph boot-probe child is loaded by RUNTIME
# PATH, so a bundler can silently drop it and self-disable corrupt-store recovery.
# Assert the build emitted it before we lean on a real boot.
PROBE_CHILD="$ROOT/backend/dist/lib/graph-probe-child.js"
if [ ! -f "$PROBE_CHILD" ]; then
  echo "ERROR: $PROBE_CHILD not found, the graph boot-probe would self-disable. Ensure the build emits it." >&2
  exit 1
fi

export E2E_BACKEND_ENTRY="$BACKEND_ENTRY"

echo "Running MUON P7 end-to-end harness against the real embedded backend..."
exec node "$ROOT/backend/tests/e2e/e2e-smoke.mjs"
