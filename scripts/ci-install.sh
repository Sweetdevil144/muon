#!/usr/bin/env bash
#
# Ordered install + build for the MUON monorepo.
#
# This repo is a monorepo with NO npm workspaces, every package is `file:`-linked
# and has its own package-lock.json + node_modules. `file:` deps resolve as
# relative symlinks, so the ONLY thing that matters is build order: an upstream's
# dist/ must exist before a downstream is type-checked / built.
#
# Dependency order:
#   protocol -> adapters -> client -> core -> graph -> codegraph -> mcp ->
#   orchestrator -> runner -> backend -> apps/{cli,tui,desktop}
# (core imports @muon/client/paths for the shared data-dir resolver; client has
#  no dependency on core, so client must be built first on a clean checkout.)
# (runner imports @muon/orchestrator for reconcile/loop; orchestrator has no
#  runner dep, so orchestrator must build first.)
#
# This is the single install/build path shared by CI (.github/workflows/ci.yml)
# and local dev, so "works on my machine" == "works in CI".
#
# Env:
#   SKIP_INSTALL=1   Skip `npm ci` and prisma generate; only rebuild dist/. Use
#                    locally when node_modules is already populated (fast rebuild),
#                    and in CI when node_modules was restored from cache.
#
# Usage:
#   bash scripts/ci-install.sh              # full: npm ci + build, in order
#   SKIP_INSTALL=1 bash scripts/ci-install.sh   # rebuild dist only

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_INSTALL="${SKIP_INSTALL:-0}"

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

# install <dir> [extra npm ci flags...]
install() {
  local dir="$1"; shift || true
  if [ "$SKIP_INSTALL" = "1" ]; then
    log "skip install ($dir)"
    return 0
  fi
  log "npm ci ($dir)"
  ( cd "$dir" && npm ci --no-audit --no-fund "$@" )
}

# build <dir>
build() {
  local dir="$1"
  log "build ($dir)"
  ( cd "$dir" && npm run build )
}

# 0. Root (Next.js app). Needed for `npm run lint`, the root vitest suite, and
#    `next build`. Not part of the package graph (no @muon/* deps), so no build here.
install "."

# 1. Package graph, strictly in dependency order.
for dir in \
  packages/protocol \
  packages/adapters \
  packages/client \
  packages/core \
  packages/graph \
  packages/codegraph \
  packages/mcp \
  packages/orchestrator \
  packages/runner; do
  install "$dir"
  build "$dir"
done

# 2. Backend. The Prisma client must be GENERATED before tsc can type-check the
#    `@prisma/client` import. (Schema materialization for the embedded SQLite
#    brain happens at runtime via ensureSchema(), not here.)
install "backend"
# ALWAYS generate, even when node_modules came from cache: the cache key
# hashes lockfiles, not prisma/schema.prisma, so a schema-only change would
# otherwise type-check against a STALE generated client (broke PR #29's CI
# with "owner does not exist in LaneSessionWhereInput"). Generate is ~2s.
log "prisma generate (backend)"
( cd backend && npx --no-install prisma generate )
build "backend"

# 3. Apps.
install "apps/cli"
build "apps/cli"

install "apps/tui"
build "apps/tui"

# Desktop: install without lifecycle scripts first so dependencies land before
# we deliberately rebuild the two native/runtime boundaries the desktop tests
# exercise. This avoids running unrelated dependency scripts while still
# installing Electron's platform binary and compiling node-pty for the runner.
install "apps/desktop" --ignore-scripts
if [ "$SKIP_INSTALL" != "1" ]; then
  log "rebuild electron + node-pty (apps/desktop)"
  ( cd apps/desktop && npm rebuild electron node-pty --no-audit --no-fund )
fi
build "apps/desktop"

log "ci-install complete, all packages installed + built in dependency order"
