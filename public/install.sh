#!/bin/bash
# MUON CLI + TUI installer — https://getmuon.com/install.sh
#
#   curl -fsSL https://getmuon.com/install.sh | bash
#
# Installs the `muon` CLI and `muon-tui` terminal cockpit from MUON's release
# host (download.getmuon.com) via npm. The desktop app is a separate download:
# https://getmuon.com/download
#
# What this script does — and all it does:
#   1. Checks for Node.js >= 20 and npm.
#   2. Runs `npm install -g <tarball>` against the published muon-cli tarball.
#   3. Prints where to go next. Nothing else is downloaded or executed.
set -euo pipefail

DOWNLOAD_HOST="${MUON_DOWNLOAD_HOST:-https://download.getmuon.com}"
TARBALL_URL="$DOWNLOAD_HOST/muon-cli-latest.tgz"

say()  { printf '\033[1m[muon]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[muon]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail \
  "Node.js is required (>= 20). Install it from https://nodejs.org and re-run."
command -v npm >/dev/null 2>&1 || fail \
  "npm is required (it ships with Node.js). Install Node >= 20 and re-run."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || fail \
  "Node.js >= 20 is required (found $(node --version)). Upgrade and re-run."

# A `muon` BINARY MAY ALREADY EXIST, AND NOT ALL OF THEM ARE OURS.
#
# npm refuses to overwrite a global bin it does not own and dies with a raw
# `EEXIST`, which is where this installer used to stop. Two very different
# things land here:
#
#   - a previous MUON install, or a `npm link`ed dev checkout — ours, and safe
#     to remove before reinstalling;
#   - `muon` from homebrew-core, which is an unrelated Meson-compatible build
#     system. Clobbering someone's build tool because our names collide would
#     be indefensible, so we stop and say exactly what is in the way.
# `command -v`, not `which`: `which` is not POSIX and on some systems exits 0
# even when nothing was found. And PATH ALONE IS NOT ENOUGH — npm raises
# EEXIST from ITS OWN global bin, which is not necessarily on PATH, so a
# PATH-only check would clear the guard and still fail the install.
NPM_BIN="$(npm prefix -g 2>/dev/null)/bin"
EXISTING="$(command -v muon 2>/dev/null || true)"
[ -z "$EXISTING" ] && [ -e "$NPM_BIN/muon" ] && EXISTING="$NPM_BIN/muon"

if [ -n "$EXISTING" ]; then
  # `npm ls -g` names the owner when npm owns it; anything else is not ours.
  if npm ls -g --depth=0 2>/dev/null | grep -qE '(^|[^a-z-])(muon-cli|@muon/cli)@'; then
    say "Removing the previous MUON install first ($EXISTING) ..."
    npm uninstall -g muon-cli >/dev/null 2>&1 || true
    npm uninstall -g @muon/cli >/dev/null 2>&1 || true
    # Re-check: uninstalling OUR package does not remove a foreign binary that
    # happens to sit in the same place, and npm would fail on it a moment later
    # with nothing explaining why.
    STILL="$(command -v muon 2>/dev/null || true)"
    [ -z "$STILL" ] && [ -e "$NPM_BIN/muon" ] && STILL="$NPM_BIN/muon"
    if [ -n "$STILL" ]; then
      fail "'$STILL' is still there after removing MUON's own install, so it
  belongs to something else. Remove or rename it and re-run."
    fi
  else
    fail "'$EXISTING' already exists and was not installed by MUON.
  If that is muon from homebrew-core (a Meson-compatible build system), the two
  share a name by coincidence. Remove or rename one of them and re-run; this
  installer will not overwrite a binary it does not own."
  fi
fi

say "Installing the MUON CLI + TUI from $TARBALL_URL ..."
if ! npm install -g "$TARBALL_URL"; then
  fail "npm install failed. If this is a permissions error, configure a user-writable npm prefix (https://docs.npmjs.com/resolving-eacces-permissions-errors) and re-run — do not use sudo."
fi

command -v muon >/dev/null 2>&1 || say \
  "Installed, but 'muon' is not on your PATH yet — open a new shell, or add npm's global bin dir (npm prefix -g) to PATH."

say "Done. Two commands are now available:"
say "  muon       — the CLI (auto-starts the local brain; try: muon doctor)"
say "  muon-tui   — the full-screen terminal cockpit"
say ""
# PLATFORM-AWARE. The desktop app that carries the brain is macOS-only, so
# telling a Linux user to install it is a dead end dressed as an instruction.
if [ "$(uname -s)" = "Darwin" ]; then
  say "The MUON desktop app hosts the local brain the CLI/TUI talk to —"
  say "install it from https://getmuon.com/download if you haven't yet."
else
  say "The local brain is not packaged for this platform yet — the desktop app"
  say "that carries it is macOS-only today. Build it from source to finish setup:"
  say "  git clone https://github.com/Sweetdevil144/muon && cd muon"
  say "  npm install && ./build.sh && muon doctor"
fi
say ""
say "Register MUON with your own coding agent (MCP):  muon mcp install"
say "Docs: https://docs.getmuon.com"
