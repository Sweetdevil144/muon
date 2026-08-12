#!/bin/bash
# MUON OSS export — ALLOWLIST, fresh lineage.
#
# An allowlist, not a denylist, for the reason this repo already learned the
# hard way about bounded surfaces: a denylist ("exclude docs/") silently ships
# whatever nobody thought to name — and at the root of this repo that is
# FOUNDER_TODO.md, FOUNDER-ACTIONS.md, ROADMAP.md, PRE-RELEASE.md and TODO.md.
# Here, anything not named below does not ship.
#
# Fresh lineage, not a filtered history: the private repo's 1858 commits carry
# docs/ and the research corpus in every one of them, so `git log -p` on a
# rewritten export would still recover what the rewrite was meant to remove.
# One initial commit cannot leak what it never contained.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:?usage: oss-export.sh <dest-dir>}"

ALLOW_DIRS=(apps packages backend scripts src public packaging tests .github)
# Public documentation that ships WITH the code, not the internal docs tree.
# `docs/mcp-server-card.md` is the outward-facing enumeration of the MCP tool
# tiers — agent-ecosystem consumers need it, and a protocol test asserts the
# card matches the shipped inventory, so omitting it broke CI on the public
# repo (measured: 1 of 9 gates red).
ALLOW_DOCS=(docs/mcp-server-card.md)

ALLOW_FILES=(
  package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.mjs
  components.json next.config.ts postcss.config.mjs vercel.json
  Dockerfile backend.Dockerfile docker-compose.yml
  .dockerignore .vercelignore .gitignore .env.example
  build.sh LICENSE llms.txt llms-full.txt
)

rm -rf "$DEST"; mkdir -p "$DEST"
cd "$SRC"
for d in "${ALLOW_DIRS[@]}"; do
  git ls-files -z -- "$d" | while IFS= read -r -d '' f; do
    case "$f" in
      packaging/oss/*) continue ;;
      # The release workflow builds and signs the macOS desktop app and uploads
      # to the founder's download host. It needs secrets and infrastructure the
      # public repo does not have, so on a public fork it is a workflow that can
      # only ever be red. Releases are cut from the private tree; CI, which is
      # what a contributor actually needs, still ships.
      .github/workflows/release.yml) continue ;;
    esac
    mkdir -p "$DEST/$(dirname "$f")"
    git show "HEAD:$f" > "$DEST/$f" 2>/dev/null || true
  done
done
for f in "${ALLOW_DOCS[@]}" "${ALLOW_FILES[@]}"; do
  mkdir -p "$DEST/$(dirname "$f")"
  git show "HEAD:$f" > "$DEST/$f" 2>/dev/null || echo "  (skip, absent: $f)"
done
# The OSS README replaces the internal one, whose 13 links point at docs/ and
# root planning files that deliberately do not ship.
git show "HEAD:packaging/oss/README.md" > "$DEST/README.md"
git show "HEAD:packaging/oss/ADDITIONAL-GRANT.md" > "$DEST/ADDITIONAL-GRANT.md"
# The public product is named MUON; the private repo's root package keeps its
# own name (`muon-labs`, now the getmuon enterprise tree). Only the root package
# is renamed — every @muon/* workspace name is already correct and is what the
# file: dependencies resolve by.
python3 - "$DEST/package.json" <<'PYJSON'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["name"]="muon"
json.dump(d, open(p,"w"), indent=2); open(p,"a").write("\n")
PYJSON
chmod +x "$DEST/build.sh" 2>/dev/null || true
echo "exported $(find "$DEST" -type f | wc -l | tr -d ' ') files"
