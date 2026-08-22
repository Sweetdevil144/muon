#!/bin/bash
# MUON installer — https://getmuon.com/install.sh
#
#   curl -fsSL https://getmuon.com/install.sh | bash
#
# Installs the `muon` CLI, the `muon-tui` terminal cockpit, and the
# `muon-mcp` MCP server from MUON's release host (download.getmuon.com) via
# npm — and, on macOS, ALSO installs the MUON.app desktop that hosts the
# local brain the CLI/TUI talk to. One command, both halves: a `muon` with
# no desktop app to attach to, and a desktop app with no way to register
# itself with your own coding agent, are both dead ends this closes.
#
# What this script does — and all it does:
#   1. Checks for Node.js >= 20 and npm.
#   2. Runs `npm install -g <tarball>` against the published muon-cli tarball.
#   3. On macOS, ONLY when --desktop is passed: downloads MUON-latest-arm64.dmg,
#      verifies its sha256 against the published SHA256SUMS, mounts it
#      read-only, and copies MUON.app into /Applications — UNLESS an app is
#      already installed there, in which case it is left alone (see
#      --replace-desktop below). Nothing is executed from the mounted image;
#      the volume is detached and every temp file removed, on success AND on
#      failure.
#   4. Prints where to go next. Nothing else is downloaded or executed.
#
# The desktop app is OPT-IN here, and that asymmetry is deliberate. Installing
# it is the reverse direction's job: the DMG always carries muon/muon-tui/muon-mcp
# inside the bundle, so a desktop user is never missing a surface. Going the
# other way — having `curl | bash` pull a 671MB unsigned disk image and mount it
# — is a large, surprising side effect for a command that reads as "install the
# CLI", it only means anything on macOS, and it ends with TWO copies of `muon`
# on one machine: this one, updated by `muon update`, and the app's own, updated
# by the in-app updater. Whichever wins PATH order decides which version answers,
# which is exactly the split the bundled-CLI rule exists to prevent.
#
# Flags (pass after `--`, e.g. `curl ... | bash -s -- --desktop`):
#   --desktop          ALSO install the macOS desktop app (off by default).
#   --no-desktop       Accepted and ignored; kept so an existing command line
#                       that already asked for CLI-only does not start failing
#                       on an unknown flag. It is the default now.
#   --desktop-only      Desktop app only; skip the CLI/TUI/MCP install.
#   --replace-desktop  If MUON.app already exists at the target, replace it
#                       (default: leave it alone and say so — this script
#                       never clobbers a possibly-running app without being
#                       asked). Update an existing install with MUON's own
#                       in-app updater (Settings -> Updates) instead, when
#                       that is what you want.
#
# Never blocks on a prompt: this script is meant to run piped from `curl`,
# where stdin is not a terminal, so every decision above has a stated
# non-interactive default.
set -euo pipefail

DOWNLOAD_HOST="${MUON_DOWNLOAD_HOST:-https://download.getmuon.com}"
TARBALL_URL="$DOWNLOAD_HOST/muon-cli-latest.tgz"
DMG_URL="$DOWNLOAD_HOST/MUON-latest-arm64.dmg"
SUMS_URL="$DOWNLOAD_HOST/SHA256SUMS"
# Override point for tests: exercise the real download+verify+mount+copy
# pipeline without touching a real /Applications (see docs/install.md).
APPS_DIR="${MUON_INSTALL_APPS_DIR:-/Applications}"

say()  { printf '\033[1m[muon]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[muon]\033[0m %s\n' "$*" >&2; exit 1; }
# Non-fatal: the desktop half must never turn a working CLI install into a
# failed script (exit 0 with the CLI installed is correct even if this half
# did not finish).
desktop_note() { printf '\033[1m[muon:desktop]\033[0m %s\n' "$*"; }
desktop_fail() {
  printf '\033[1;33m[muon:desktop]\033[0m %s\n' "$*" >&2
  printf '\033[1;33m[muon:desktop]\033[0m The CLI/TUI/MCP install above is unaffected. Download the app yourself from https://getmuon.com/download, or re-run this installer.\n' >&2
}

# https only — the same rule every MUON surface applies to this host
# (@muon/client/download-host): the tarball goes to `npm install -g`, whose
# lifecycle scripts execute, so a plaintext host is a network position away
# from code execution. Checked here, after `fail` exists, before any use.
case "$DOWNLOAD_HOST" in
  https://*) : ;;
  *) fail "MUON_DOWNLOAD_HOST=$DOWNLOAD_HOST is not https — MUON only fetches release artifacts over https." ;;
esac

# ── flags ────────────────────────────────────────────────────────────────
DO_CLI=1
DO_DESKTOP=0
REPLACE_DESKTOP=0
for arg in "$@"; do
  case "$arg" in
    --desktop) DO_DESKTOP=1 ;;
    # Already the default. Accepted rather than rejected so a command line
    # written against the old behaviour keeps working instead of failing on an
    # unknown flag.
    --no-desktop) DO_DESKTOP=0 ;;
    --desktop-only) DO_CLI=0; DO_DESKTOP=1 ;;
    --replace-desktop) REPLACE_DESKTOP=1 ;;
    *) fail "unknown flag: $arg (supported: --desktop, --no-desktop, --desktop-only, --replace-desktop)" ;;
  esac
done
if [ "$DO_CLI" = "0" ] && [ "$DO_DESKTOP" = "0" ]; then
  fail "--no-desktop and --desktop-only together install nothing. Drop one."
fi

# ── desktop-download cleanup, wired up FRONT so it is a safe no-op when the
#    desktop half never runs (the globals below stay empty/0 in that case) ──
DESKTOP_WORK_DIR=""
DESKTOP_MOUNT_POINT=""
DESKTOP_MOUNTED=0
desktop_cleanup() {
  if [ "$DESKTOP_MOUNTED" = "1" ] && [ -n "$DESKTOP_MOUNT_POINT" ]; then
    hdiutil detach "$DESKTOP_MOUNT_POINT" -quiet -force >/dev/null 2>&1 || true
  fi
  if [ -n "$DESKTOP_WORK_DIR" ]; then
    rm -rf "$DESKTOP_WORK_DIR"
  fi
}
trap desktop_cleanup EXIT

# ═══════════════════════════════ CLI / TUI / MCP ═══════════════════════════
if [ "$DO_CLI" = "1" ]; then
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
  # Since 0.4.8 the tarball carries the GitNexus code-graph engine as an
  # optional dependency (native parsers + an ONNX runtime, ~1GB installed).
  # Said out loud so a first install that takes minutes reads as a download,
  # not a hang — and npm may legitimately skip it on a machine that cannot
  # build its native pieces (MUON then says the code graph is unavailable).
  say "  (this includes the GitNexus code-graph engine, ~1GB — the first install can take a few minutes)"
  if ! npm install -g "$TARBALL_URL"; then
    fail "npm install failed. If this is a permissions error, configure a user-writable npm prefix (https://docs.npmjs.com/resolving-eacces-permissions-errors) and re-run — do not use sudo."
  fi

  command -v muon >/dev/null 2>&1 || say \
    "Installed, but 'muon' is not on your PATH yet — open a new shell, or add npm's global bin dir (npm prefix -g) to PATH."

  # THREE bins, not two: the tarball has shipped `muon-mcp` since 0.4.2, and
  # naming it here is load-bearing rather than completeness — `muon mcp install`
  # resolves the server as a SIBLING of the running `muon`, so a user who does
  # not know it arrived cannot tell an install problem from a missing feature.
  say "Done. Three commands are now available:"
  say "  muon       — the CLI (auto-starts the local brain; try: muon doctor)"
  say "  muon-tui   — the full-screen terminal cockpit"
  say "  muon-mcp   — the MCP server your own coding agent talks to"
  say ""
fi

# ═══════════════════════════════ Desktop app ═══════════════════════════════
#
# Verify-then-mount, never mount-then-verify: an unverified disk image is not
# something this script will attach at all, downloaded-and-discarded on any
# mismatch. `desktop_cleanup` (registered above, before either half ran) is
# what detaches the volume and clears the temp dir on every exit path,
# success or failure.
install_desktop_macos() {
  local target="$APPS_DIR/MUON.app"

  if [ -e "$target" ] && [ "$REPLACE_DESKTOP" != "1" ]; then
    desktop_note "MUON.app already exists at $target — leaving it alone (never clobbering a possibly-running app)."
    desktop_note "Use MUON's in-app updater (Settings -> Updates) to update it, or re-run with --replace-desktop to overwrite."
    return 0
  fi

  for tool in hdiutil ditto shasum; do
    command -v "$tool" >/dev/null 2>&1 || {
      desktop_fail "'$tool' is not available; cannot install the desktop app on this machine."
      return 1
    }
  done

  if ! DESKTOP_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/muon-desktop-install.XXXXXX")"; then
    desktop_fail "could not create a temp dir for the download."
    return 1
  fi
  DESKTOP_MOUNT_POINT="$DESKTOP_WORK_DIR/mnt"

  desktop_note "Downloading the MUON desktop app from $DMG_URL ..."
  if ! curl -fsSL -o "$DESKTOP_WORK_DIR/MUON.dmg" "$DMG_URL"; then
    desktop_fail "could not download $DMG_URL"
    return 1
  fi
  if ! curl -fsSL -o "$DESKTOP_WORK_DIR/SHA256SUMS" "$SUMS_URL"; then
    desktop_fail "could not download $SUMS_URL to verify the app — refusing to mount an unverified image."
    return 1
  fi

  # SHA256SUMS names the CURRENT release's versioned filename
  # (MUON-<version>-arm64.dmg); MUON-latest-arm64.dmg is a byte-identical
  # host-side copy of that same file, so its hash matches the SAME line —
  # matched by pattern, not by the "latest" alias, which the sums file never
  # names directly.
  local expected actual
  expected="$(grep -E '  MUON-[0-9A-Za-z.+-]+-arm64\.dmg$' "$DESKTOP_WORK_DIR/SHA256SUMS" 2>/dev/null | awk '{print $1}' | head -n 1 || true)"
  if [ -z "$expected" ]; then
    desktop_fail "SHA256SUMS has no entry for the MUON .dmg — refusing to mount an unverifiable download."
    return 1
  fi
  if ! actual="$(shasum -a 256 "$DESKTOP_WORK_DIR/MUON.dmg" | awk '{print $1}')"; then
    desktop_fail "could not compute the download's sha256."
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    desktop_fail "sha256 MISMATCH for the downloaded .dmg (expected $expected, got $actual) — refusing to mount it."
    return 1
  fi
  desktop_note "Checksum verified ($expected)."

  mkdir -p "$DESKTOP_MOUNT_POINT"
  if ! hdiutil attach "$DESKTOP_WORK_DIR/MUON.dmg" -nobrowse -readonly -mountpoint "$DESKTOP_MOUNT_POINT" -quiet; then
    desktop_fail "could not mount the .dmg"
    return 1
  fi
  DESKTOP_MOUNTED=1

  if [ ! -d "$DESKTOP_MOUNT_POINT/MUON.app" ]; then
    desktop_fail "the .dmg did not contain MUON.app"
    return 1
  fi

  mkdir -p "$APPS_DIR"
  if [ -e "$target" ]; then
    desktop_note "Replacing the existing install at $target (--replace-desktop) ..."
    rm -rf "$target"
  fi
  # ditto, not cp -R: the Apple-recommended way to copy an app bundle out of
  # a mounted image — it preserves resource forks, xattrs and the ad-hoc code
  # signature exactly, which a plain recursive copy is not guaranteed to.
  if ! ditto "$DESKTOP_MOUNT_POINT/MUON.app" "$target"; then
    desktop_fail "could not copy MUON.app to $target"
    return 1
  fi

  desktop_note "Installed MUON.app to $target"
  # UNSIGNED (v1, by decision — docs/install.md). Said here, not only in
  # docs: this is the moment the user needs the gesture, and a curl|bash
  # session has no browser tab open to a doc.
  desktop_note "It is UNSIGNED for now: on first launch, right-click (or Control-click) MUON.app -> Open -> Open — a plain double-click only offers \"Move to Trash\". macOS remembers the choice after that."
  return 0
}

if [ "$(uname -s)" = "Darwin" ]; then
  if [ "$DO_DESKTOP" = "1" ]; then
    # Guarded by `if !`, so a failing command ANYWHERE inside the function —
    # a bad download, a mount refusal, a copy failure — returns from the
    # function rather than aborting this script under `set -e`. The CLI half
    # above has already fully completed by the time this runs.
    if ! install_desktop_macos; then
      : # desktop_fail already explained; the CLI install above still stands.
    fi
  else
    say "CLI, TUI and MCP installed. The desktop app was not installed (pass --desktop to include it, or get it from https://getmuon.com/download) — the app ships its own copy of all three of these, so install it that way and you need nothing else."
  fi
else
  # PLATFORM-AWARE. The desktop app that carries the brain is macOS-only, so
  # telling a Linux user to install it — or trying to — is a dead end
  # dressed as an instruction.
  if [ "$DO_DESKTOP" = "0" ]; then
    : # nothing to say; the user already asked to skip it
  elif [ "$DO_CLI" = "0" ]; then
    fail "--desktop-only was requested, but the desktop app is macOS-only — there is nothing to install on this platform."
  else
    say "The local brain is not packaged for this platform yet — the desktop app"
    say "that carries it is macOS-only today. Build it from source to finish setup:"
    say "  git clone https://github.com/Sweetdevil144/muon && cd muon"
    say "  npm install && ./build.sh && muon doctor"
  fi
fi

if [ "$DO_CLI" = "1" ]; then
  say ""
  say "Register MUON with your own coding agent (MCP):  muon mcp install"
  say "Docs: https://docs.getmuon.com"
fi
