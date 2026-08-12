#!/usr/bin/env bash
#
# MUON P0.1, checkpoint + resume acceptance entrypoint (the kill-at-each-phase E2E).
#
# Boots the REAL embedded backend (node backend/dist/index.js, NOT app.inject),
# REALLY kills it (SIGKILL) at each lifecycle phase (queued, running, terminal,
# waiting-gate), reopens the SAME data dir, and proves the Future.md acceptance:
# same root/lineage digest, exact surviving ledger state, unchanged artifact
# hashes, and ZERO duplicate side effects (the fake vendor's additive sentinel
# is written exactly as many times as a human authorized).
#
# Hermetic + deterministic, same construction as e2e-smoke.sh / e2e-loop.sh:
# temp data dir, embedded SQLite, lexical brain (MUON_EMBED_DISABLE), an EMPTY
# PATH for the backend child so no real vendor CLI can ever spawn, and the
# deterministic fake vendor (MUON_FAKE_VENDOR=1). No network beyond loopback.
#
# Run locally: `node backend/tests/e2e/e2e-resume.mjs` or `bash scripts/e2e-resume.sh`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BACKEND_ENTRY="$ROOT/backend/dist/index.js"
if [ ! -f "$BACKEND_ENTRY" ]; then
  echo "ERROR: $BACKEND_ENTRY not found, run scripts/ci-install.sh first." >&2
  exit 1
fi

RUNNER_ENTRY="$ROOT/packages/runner/dist/index.js"
if [ ! -f "$RUNNER_ENTRY" ]; then
  echo "ERROR: $RUNNER_ENTRY not found, build @muon/runner (scripts/ci-install.sh)." >&2
  exit 1
fi

export E2E_BACKEND_ENTRY="$BACKEND_ENTRY"
export MUON_FAKE_VENDOR=1

echo "Running MUON P0.1 checkpoint+resume harness (real backend, SIGKILL at each phase)..."
exec node "$ROOT/backend/tests/e2e/e2e-resume.mjs"
