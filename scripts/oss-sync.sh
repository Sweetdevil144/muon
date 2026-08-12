#!/bin/bash
# Push the current tree to the PUBLIC repo.
#
# The two repos have unrelated histories by design (ADR-less but deliberate:
# fresh lineage is what keeps docs/ and the research corpus out of the public
# object database), so nothing about `git push` keeps them in step — the export
# has to be re-run and committed. That is exactly the step a human forgets, and
# did: the public repo sat three commits behind through two releases, still
# advertising 0.2.1 while the private tree shipped 0.3.1.
#
# Usage: ./scripts/oss-sync.sh "commit message"
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MSG="${1:?usage: oss-sync.sh \"commit message\"}"
WORK="${MUON_OSS_WORKTREE:-/tmp/muon-oss-sync}"
REMOTE="${MUON_OSS_REMOTE:-https://github.com/Sweetdevil144/muon.git}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
"$ROOT/scripts/oss-export.sh" "$STAGE" >/dev/null

if [ ! -d "$WORK/.git" ]; then
  rm -rf "$WORK"
  git clone -q "$REMOTE" "$WORK"
fi
git -C "$WORK" fetch -q origin main
git -C "$WORK" checkout -q main
git -C "$WORK" reset -q --hard origin/main

# --delete so a file removed from the export is removed publicly too; without
# it the public repo accumulates files the private tree has already dropped.
rsync -a --delete --exclude='.git' "$STAGE/" "$WORK/"
git -C "$WORK" add -A

if git -C "$WORK" diff --cached --quiet; then
  echo "public repo already matches the export — nothing to push"
  exit 0
fi
git -C "$WORK" -c user.name="Abhinav Pandey" \
  -c user.email="abhinavpandey1230@gmail.com" commit -q -m "$MSG"
# The AI-authorship notes ref recreates itself and must never be published.
git -C "$WORK" update-ref -d refs/notes/ai 2>/dev/null || true
git -C "$WORK" push -q origin main
git -C "$WORK" log --oneline -1
