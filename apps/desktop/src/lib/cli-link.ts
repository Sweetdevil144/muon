/**
 * Founder request, 2026-08-17: "download package + install should install
 * desktop app = mcp/cli/tui". Direction 2 of the curl<->desktop parity work
 * (public/install.sh is Direction 1). `apps/desktop/scripts/stage-cli.mjs`
 * ships `muon`/`muon-tui`/`muon-mcp` inside the app bundle
 * (<Resources>/cli/{muon,muon-tui,muon-mcp}.mjs); this module is the PURE
 * decision logic for the operator affordance that links them onto PATH —
 * Settings -> Command Line Tools (src/renderer, wired through
 * cli-link-bridge.ts and main.ts).
 *
 * Kept side-effect-free and IO-injected on purpose (mirrors
 * staged-swap.ts's plan/perform split and mcp-vendor-config.ts's shared
 * evaluator): the link/unlink DECISION — write, no-op, or refuse — has to be
 * provable against a fixture without a real `~/.local/bin` or a real .app
 * bundle, and it is the one part of this feature explicitly called out for
 * testing.
 *
 * WHY A SHIM SCRIPT, NOT A SYMLINK (per the ADR and the founder's own
 * framing): a symlink into `<Resources>/cli/muon.mjs` is fixed to whatever
 * `<Resources>` resolved to AT LINK TIME. The staged-swap updater
 * (staged-swap.ts) keeps `/Applications/MUON.app` at the SAME path across an
 * update (two renames, old-out then new-in), so a symlink baked from a
 * `/Applications` install would in fact keep resolving after an in-place
 * auto-update — but nothing here can assume the app is installed there. A
 * user can run it from Downloads, a second copy, or a location the
 * auto-updater refuses to touch (`swapRefusalReason`), and a plain symlink
 * baked against that path is silently dead the moment the app moves. The
 * shim below re-resolves the app bundle EVERY TIME IT RUNS: first the path
 * baked in at link time (the fast, common case), then the conventional
 * `/Applications/MUON.app`, then a live Spotlight lookup by bundle id — so a
 * moved or reinstalled app keeps a linked shim working without a re-link.
 *
 * WHY `~/.local/bin` (never `/usr/local/bin`, never sudo): the founder's
 * fence is explicit, and it is also where `resolveMuonMcpCommand`
 * (`@muon/client/mcp-vendor-config`) already searches as a well-known
 * install dir — `muon-mcp` written here is found by `muon mcp install`
 * with zero new resolution logic on that side.
 */
import path from "node:path";

export type CliBinName = "muon" | "muon-tui" | "muon-mcp";
export const CLI_BIN_NAMES: readonly CliBinName[] = ["muon", "muon-tui", "muon-mcp"];

/** The staged entry file each shim execs, relative to <Resources>/cli/. */
export function cliEntryFile(bin: CliBinName): string {
  return `${bin}.mjs`;
}

/**
 * Derive the running .app bundle root from Electron's `process.resourcesPath`
 * (`<bundle>/Contents/Resources`). Pure string math, no fs — testable without
 * a real bundle on disk. Returns null when the path does not end in `.app`
 * (an unpackaged/dev run), which callers treat as "nothing to link".
 */
export function resolveAppBundlePath(resourcesPath: string): string | null {
  const bundle = path.resolve(resourcesPath, "..", "..");
  return bundle.endsWith(".app") ? bundle : null;
}

/** Where `stage-cli.mjs` lands the three entries inside a bundle. */
export function cliResourcesDir(bundlePath: string): string {
  return path.join(bundlePath, "Contents", "Resources", "cli");
}

/**
 * ONE literal, checked byte-for-byte on both link and unlink. This is the
 * whole ownership test: a file at the target path is "ours" iff this exact
 * line is present, never a fuzzy content guess. Versioned so a future shim
 * format change can still recognize (and cleanly replace) an older one.
 */
export const CLI_SHIM_MARKER =
  "# muon-cli-shim v2 - installed by MUON.app; managed from Settings -> Command Line Tools (unlink there, or delete this file).";

export function isMuonOwnedShim(content: string): boolean {
  return content.split("\n").some((line) => line.trim() === CLI_SHIM_MARKER);
}

/**
 * The shim's own text. POSIX `sh` (not bash) — the only interpreter every
 * macOS ships unconditionally, and the body needs nothing bash-specific.
 *
 * Resolution order at RUN time (not link time):
 *   1. `$MUON_APP_BUNDLE` — an explicit override, mostly for tests.
 *   2. `bundlePath` baked in below — wherever THIS shim was written FROM.
 *   3. `/Applications/MUON.app` — the conventional install location, worth
 *      trying even if (2) was somewhere else (e.g. linked from a Downloads
 *      copy the user later replaced with a proper install).
 *   4. `mdfind` by bundle identifier (`dev.muonlabs.muon`, electron-builder.yml
 *      `appId`) — a live Spotlight lookup, the same mechanism Launch
 *      Services itself uses, so it finds the app wherever Finder would.
 * Exits 1 with a clear message (never a bare "command not found") when none
 * of the four resolve.
 */
export function shimScript(bin: CliBinName, bundlePath: string): string {
  const entry = cliEntryFile(bin);
  return [
    "#!/bin/sh",
    CLI_SHIM_MARKER,
    "set -e",
    `MUON_LINKED_BUNDLE=${shellQuote(bundlePath)}`,
    "resolve_app() {",
    '  if [ -n "$MUON_APP_BUNDLE" ] && [ -d "$MUON_APP_BUNDLE" ]; then printf %s "$MUON_APP_BUNDLE"; return 0; fi',
    '  if [ -d "$MUON_LINKED_BUNDLE" ]; then printf %s "$MUON_LINKED_BUNDLE"; return 0; fi',
    '  if [ -d "/Applications/MUON.app" ]; then printf %s "/Applications/MUON.app"; return 0; fi',
    "  if command -v mdfind >/dev/null 2>&1; then",
    "    found=\"$(mdfind \"kMDItemCFBundleIdentifier == 'dev.muonlabs.muon'\" 2>/dev/null | head -n 1)\"",
    '    if [ -n "$found" ] && [ -d "$found" ]; then printf %s "$found"; return 0; fi',
    "  fi",
    "  return 1",
    "}",
    'APP="$(resolve_app)" || {',
    `  echo "${bin}: could not find MUON.app (moved, renamed, or removed). Reinstall from https://getmuon.com/download, or re-link from MUON -> Settings -> Command Line Tools." >&2`,
    "  exit 1",
    "}",
    // THE CLAUDE SDK'S PLATFORM BINARY LIVES IN THE APP, ONCE.
    //
    // `@anthropic-ai/claude-agent-sdk` ships its ~300MB `claude` executable as
    // a per-platform package, and the app already carries it (asarUnpack). The
    // staged CLI deliberately does NOT get a second copy — that would add
    // ~300MB to every download for bytes already inside the same bundle.
    // The SDK finds it through `createRequire`, whose resolution consults
    // NODE_PATH, so pointing at the app's unpacked tree is what keeps a
    // DMG-linked `muon` able to start a Claude session (verified 2026-08-20).
    //
    // APPENDED, never assigned: a user with their own NODE_PATH keeps it, and
    // ours is a fallback rather than an override.
    'if [ -n "$NODE_PATH" ]; then',
    '  NODE_PATH="$NODE_PATH:$APP/Contents/Resources/app.asar.unpacked/node_modules"',
    "else",
    '  NODE_PATH="$APP/Contents/Resources/app.asar.unpacked/node_modules"',
    "fi",
    "export NODE_PATH",
    `exec "$APP/Contents/Resources/cli/${entry}" "$@"`,
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  // Single-quote, escaping any embedded single quote the POSIX way:
  // close-quote, escaped quote, reopen-quote. macOS install paths never
  // legitimately contain one, but a hostile/odd path must not break out of
  // the assignment.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ─────────────────────────────── link plan ───────────────────────────────

export type ExistingBin = {
  /** False when nothing exists at the target path at all. */
  exists: boolean;
  /** UTF-8 content, when it exists and was readable as text. Undefined for
   *  an unreadable (binary, permission-denied, or directory) target — which
   *  must never be treated as "ours" by default. */
  content?: string;
};

export type LinkPlanEntry =
  | { bin: CliBinName; targetPath: string; action: "write"; content: string; reason: "absent" | "stale" }
  | { bin: CliBinName; targetPath: string; action: "already-linked" }
  | { bin: CliBinName; targetPath: string; action: "refused"; reason: string };

export type LinkPlan = {
  binDir: string;
  bundlePath: string;
  entries: readonly LinkPlanEntry[];
};

/**
 * Decide, PER BINARY, whether to write, skip (already current), or refuse.
 * Never touches disk — `cli-link-bridge.ts` executes the plan this returns.
 *
 * `bundlePath` must be the running app's OWN bundle root (e.g.
 * `/Applications/MUON.app`), computed by the caller from
 * `process.resourcesPath` — this module has no Electron dependency and takes
 * it as plain data so it stays testable without one.
 */
export function planLink(input: {
  binDir: string;
  bundlePath: string;
  existing: Readonly<Record<CliBinName, ExistingBin>>;
}): LinkPlan {
  const entries = CLI_BIN_NAMES.map((bin): LinkPlanEntry => {
    const targetPath = path.join(input.binDir, bin);
    const existing = input.existing[bin];
    const desired = shimScript(bin, input.bundlePath);
    if (!existing.exists) {
      return { bin, targetPath, action: "write", content: desired, reason: "absent" };
    }
    if (existing.content !== undefined && isMuonOwnedShim(existing.content)) {
      if (existing.content === desired) {
        return { bin, targetPath, action: "already-linked" };
      }
      // Ours, but stale — the app moved, or the shim format changed. An
      // update, not a foreign-file refusal.
      return { bin, targetPath, action: "write", content: desired, reason: "stale" };
    }
    return {
      bin,
      targetPath,
      action: "refused",
      reason:
        `${targetPath} already exists and was not installed by MUON (no MUON shim marker). ` +
        "It may be a tarball/Homebrew install, or something unrelated with the same name. " +
        "Remove or rename it yourself, then link again — MUON will not overwrite a binary it does not own.",
    };
  });
  return { binDir: input.binDir, bundlePath: input.bundlePath, entries };
}

// ────────────────────────────── unlink plan ───────────────────────────────

export type UnlinkPlanEntry =
  | { bin: CliBinName; targetPath: string; action: "remove" }
  | { bin: CliBinName; targetPath: string; action: "absent" }
  | { bin: CliBinName; targetPath: string; action: "skip"; reason: string };

export type UnlinkPlan = {
  binDir: string;
  entries: readonly UnlinkPlanEntry[];
};

/** Undo, per binary: remove what MUON owns, leave everything else alone. */
export function planUnlink(input: {
  binDir: string;
  existing: Readonly<Record<CliBinName, ExistingBin>>;
}): UnlinkPlan {
  const entries = CLI_BIN_NAMES.map((bin): UnlinkPlanEntry => {
    const targetPath = path.join(input.binDir, bin);
    const existing = input.existing[bin];
    if (!existing.exists) {
      return { bin, targetPath, action: "absent" };
    }
    if (existing.content !== undefined && isMuonOwnedShim(existing.content)) {
      return { bin, targetPath, action: "remove" };
    }
    return {
      bin,
      targetPath,
      action: "skip",
      reason: `${targetPath} exists but was not installed by MUON — left in place.`,
    };
  });
  return { binDir: input.binDir, entries };
}

// ─────────────────────────────── status read ──────────────────────────────

export type CliLinkBinStatus =
  | { bin: CliBinName; targetPath: string; state: "linked-current" }
  | { bin: CliBinName; targetPath: string; state: "linked-stale" }
  | { bin: CliBinName; targetPath: string; state: "absent" }
  | { bin: CliBinName; targetPath: string; state: "foreign" };

/** Read-only projection of the same comparison `planLink` makes, for a
 *  status row that must not write anything just by being displayed. */
export function readLinkStatus(input: {
  binDir: string;
  bundlePath: string;
  existing: Readonly<Record<CliBinName, ExistingBin>>;
}): readonly CliLinkBinStatus[] {
  return planLink(input).entries.map((entry): CliLinkBinStatus => {
    if (entry.action === "already-linked") {
      return { bin: entry.bin, targetPath: entry.targetPath, state: "linked-current" };
    }
    if (entry.action === "refused") {
      return { bin: entry.bin, targetPath: entry.targetPath, state: "foreign" };
    }
    // action === "write"
    return {
      bin: entry.bin,
      targetPath: entry.targetPath,
      state: entry.reason === "absent" ? "absent" : "linked-stale",
    };
  });
}

/** `~/.local/bin` — the one target dir this feature ever writes to. */
export function defaultCliBinDir(home: string): string {
  return path.join(home, ".local", "bin");
}
