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
