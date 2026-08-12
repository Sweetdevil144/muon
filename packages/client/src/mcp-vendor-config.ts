import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  GOVERNED_MCP_SERVER_NAME,
  VENDOR_IDS,
  vendorEntry,
  vendorLabel,
  type VendorId,
} from "@muon/protocol";

/**
 * S1 of docs/design/cc-as-superagent-delivery.md §2.2 — the per-vendor writer
 * for `muon mcp install | status | uninstall`.
 *
 * WHY THIS LIVES IN `@muon/client` AND NOT IN `apps/cli` (§5 parity):
 * it was born in `apps/cli/src/lib/` when the CLI was the only surface. §5's S1
 * row also owes a TUI palette entry and a desktop Connections row, and a TUI or
 * desktop import of an APP package is a dependency this repo does not have and
 * must not gain. So the whole evaluator moved down here — the same
 * one-evaluator rule `workspaceCondition` and `memoryGateTier` already follow.
 * The CLI, the TUI and the desktop main process now read exactly ONE
 * implementation; no surface restates a check, a reason id, or a vendor fact.
 *
 * Rejected homes, recorded because each looked reasonable:
 *  - `@muon/core`: it does not depend on `@muon/client`, and this module needs
 *    `readLiveLockfile`/`resolveDataDir` from `@muon/client/paths` (the status
 *    half does). Putting it in core would mean either a new core→client edge or
 *    a second lockfile reader.
 *  - a brand-new package: `@muon/client` is already exactly this shape — pure,
 *    surface-agnostic read-models behind subpath exports, consumed by all three
 *    surfaces — and a fifth package for two files is cost without a boundary.
 *
 * WHAT THIS MODULE DELIBERATELY WRITES NOTHING OF (§2.2, and each omission looks
 * like a bug until you know why):
 *
 *  - NO token. The brain re-mints its agent token and its loopback port on every
 *    boot (§1.4a), so a token baked into a vendor config file is stale by the
 *    next restart. Auto-discovery through the lockfile is the feature.
 *  - NO `MUON_API_BASE`. This is the one that reads as an omission and is not:
 *    `resolveAgentToken()` (packages/client/src/config.ts:71-83) short-circuits
 *    when `explicitBase()` is truthy and NEVER reads the lockfile. Writing a base
 *    therefore switches off the exact branch this whole feature depends on, and
 *    the session silently degrades to unauthenticated (401 on every call) unless
 *    a token is written too — which the line above forbids. See §1.4b and the
 *    pinned branch at packages/mcp/tests/mcp-token.test.ts:89-93.
 *  - NO authority-bearing `MUON_MCP_MODE` by default. Base install writes no
 *    mode. `observer` is a positively named read-only Tier B inventory. ADR-0028
 *    Tier C's `attached-coordinator` DOES carry authority, but this writer still
 *    persists no credential for it: the mode names only a capability FILE path
 *    (`MUON_ATTACHED_CAPABILITY_FILE`), minted per-attach by an operator-tier
 *    surface, never typed in and never containing MUON_API_BASE or a token in
 *    this config. See `@muon/client/attached-coordinator-capability`.
 *
 * So the base entry is exactly a verified absolute command and empty args/env;
 * an explicit attached-observer/chat install adds only durable coordinates,
 * never a credential or govern authority.
 */

/**
 * The entry name MUON owns. One source of truth with the injected-session path
 * (`withMuonMcpServer`), so `uninstall` removes exactly what `install` wrote.
 *
 * Read from `@muon/protocol`'s `GOVERNED_MCP_SERVER_NAME` rather than
 * `@muon/core`'s `MUON_MCP_SERVER_NAME` (which is what this module imported
 * while it lived in `apps/cli`): `@muon/client` depends only on `@muon/protocol`,
 * and taking a core dependency here would drag `@muon/adapters` and the vendor
 * SDK into a package the desktop renderer type-imports. The two constants are
 * already pinned equal by `packages/core/tests/governed-mcp-server-name.test.ts`,
 * and `apps/cli/tests/mcp-vendor-registry.test.ts` re-asserts it from the CLI
 * side — so this is the same value, not a second opinion about it.
 */
export const MUON_MCP_ENTRY_NAME = GOVERNED_MCP_SERVER_NAME;

/** Scopes `muon mcp install` exposes. `local` is deliberately absent — see below. */
export const MCP_CONFIG_SCOPES = ["user", "project"] as const;
export type McpConfigScope = (typeof MCP_CONFIG_SCOPES)[number];

// ───────────────────────────── the seam ─────────────────────────────────────

export type VendorRunResult = {
  /** Process exit code, or -1 when the binary could not be spawned at all. */
  code: number;
  stdout: string;
  stderr: string;
  /** True when spawn itself failed (ENOENT), as distinct from a non-zero exit. */
  spawnFailed: boolean;
};

export type VendorRunner = (
  command: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>>
) => VendorRunResult;

/**
 * Where each vendor's config is rooted, plus the ONE knob that keeps MUON's own
 * tests off the operator's real vendor configs.
 */
export type VendorConfigRoots = {
  /** `~`. Production: os.homedir(). */
  home: string;
  /** XDG config root. Production: $XDG_CONFIG_HOME or `<home>/.config`. */
  configHome: string;
  /** Project root for `--scope project`. Production: process.cwd(). */
  cwd: string;
  /**
   * When true, MUON also exports each vendor's OWN config-dir override
   * (CLAUDE_CONFIG_DIR / CODEX_HOME / HOME / XDG_CONFIG_HOME) into every vendor
   * process it launches, so the vendor writes under `home` rather than under the
   * real one.
   *
   * FALSE in production and it must stay false. Redirecting a vendor's config dir
   * on a real machine silently orphans the config the human already has —
   * measured 2026-07-30: `CLAUDE_CONFIG_DIR=$HOME` moves `.claude.json` and the
   * `backups/` dir out from under `~/.claude`. It is TRUE only for MUON's own
   * tests, which is how the suite proves it never writes into `~/.claude`,
   * `~/.codex`, `~/.cursor` or `~/.config/opencode`.
   */
  redirectVendorConfigDirs: boolean;
};

export type McpVendorIo = {
  roots: VendorConfigRoots;
  run: VendorRunner;
  /** Absolute path of `command` on PATH, or null. */
  which: (command: string) => string | null;
  /** Does this absolute path exist and is it executable by us? */
  isExecutableFile: (absPath: string) => boolean;
};

/** The real IO. `redirectVendorConfigDirs` is hard-coded false here on purpose. */
export function defaultVendorIo(
  overrides: Partial<VendorConfigRoots> = {}
): McpVendorIo {
  const home = overrides.home ?? os.homedir();
  return {
    roots: {
      home,
      configHome:
        overrides.configHome ??
        process.env.XDG_CONFIG_HOME?.trim() ??
        path.join(home, ".config"),
      cwd: overrides.cwd ?? process.cwd(),
      redirectVendorConfigDirs: false,
    },
    run: (command, args, extraEnv) => {
      const result = spawnSync(command, [...args], {
        encoding: "utf8",
        env: { ...process.env, ...extraEnv },
        // A vendor CLI that hangs must not hang `muon mcp install`. 60s is far
        // above the ~1s these writers measured and far below "forever".
        timeout: 60_000,
      });
      return {
        code: result.status ?? -1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? (result.error ? result.error.message : ""),
        spawnFailed: result.error !== undefined && result.status === null,
      };
    },
    which: (command) => {
      const result = spawnSync("/usr/bin/env", ["which", command], {
        encoding: "utf8",
      });
      const first = (result.stdout ?? "").split("\n")[0]?.trim();
      return result.status === 0 && first ? first : null;
    },
    isExecutableFile: (absPath) => {
      try {
        if (!fs.statSync(absPath).isFile()) {
          return false;
        }
        fs.accessSync(absPath, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ─────────────────────── the installable vendor table ───────────────────────

/**
 * The vendors `muon mcp install` can target, as a POSITIVE list.
 *
 * NEVER `VENDOR_IDS.filter(...)`: ADR-0022 rule 2, and this repo has broken
 * itself three times deriving a set by subtraction. `installableRemainder()`
 * below plus its conformance test assert the remainder is exactly `fake`, so a
 * fifth real vendor fails the suite rather than silently becoming uninstallable.
 *
 * `coordinatorSeat` is NOT part of this decision. Cursor and opencode hold no
 * seat and are still worth installing — `code_impact` and `memory_preedit` are
 * useful to a reviewer session too. "Can be installed" and "can coordinate" are
 * two separate booleans and every surface must print both (§2.2).
 */
export type VendorWriterKind =
  /** The vendor's own `mcp add` / `mcp remove`. Preferred: the vendor owns its
   *  file format and its migrations, and MUON never parses someone else's TOML. */
  | "vendor-cli"
  /** MUON writes the vendor's JSON itself, because the vendor ships no
   *  non-interactive writer. Read-modify-write, never a key MUON did not add. */
  | "muon-json";

export type InstallableVendorSpec = {
  readonly id: VendorId;
  /** What the user may type. */
  readonly aliases: readonly string[];
  /** The binary name on PATH. */
  readonly cli: string;
  readonly writerKind: VendorWriterKind;
  /** Scopes MUON exposes for this vendor, in presentation order. */
  readonly scopes: readonly McpConfigScope[];
  readonly defaultScope: McpConfigScope;
  /** The version this row was live-verified against, and by what probe. */
  readonly verifiedAt: string;
  /** Honest caveats printed by `install` and `status`. */
  readonly notes: readonly string[];
};

export const INSTALLABLE_VENDORS: readonly InstallableVendorSpec[] = [
  {
    id: "claude-code",
    aliases: ["claude", "claude-code", "claudecode"],
    cli: "claude",
    writerKind: "vendor-cli",
    // `--scope user` is passed EXPLICITLY and always. The vendor's own default is
    // `local`, which lands the entry under `projects.<cwd>.mcpServers` in
    // ~/.claude.json — so a user who installs from one repo finds the tools
    // missing in the next one (measured 2026-07-30 at 2.1.220). `local` is
    // therefore not an exposed scope at all rather than a discouraged one.
    scopes: ["user", "project"],
    defaultScope: "user",
    verifiedAt: "2.1.220, live 2026-07-30 (`mcp add`/`mcp remove` in a temp CLAUDE_CONFIG_DIR)",
    notes: [],
  },
  {
    id: "codex",
    aliases: ["codex"],
    cli: "codex",
    writerKind: "vendor-cli",
    // Global only: `codex mcp add` exposes no scope flag at 0.145.0.
    scopes: ["user"],
    defaultScope: "user",
    verifiedAt: "codex-cli 0.145.0, live 2026-07-30 (`mcp add`/`mcp get` in a temp CODEX_HOME)",
    notes: [],
  },
  {
    id: "cursor",
    aliases: ["cursor", "cursor-agent"],
    cli: "cursor-agent",
    writerKind: "muon-json",
    scopes: ["user", "project"],
    defaultScope: "user",
    verifiedAt:
      "cursor-agent 2026.07.23, live 2026-07-30 (JSON write + `mcp list`/`enable`/`disable` in a temp HOME)",
    notes: [
      "cursor-agent ships no `mcp add`, so MUON writes ~/.cursor/mcp.json itself and touches no key it did not add.",
      "`cursor-agent mcp enable muon` runs after the write. Measured 2026-07-30: a freshly written server already reports `ready`/`already enabled and approved`, so the approval list did not gate it — but `mcp disable` DOES stick, and `enable` is what clears it.",
    ],
  },
  {
    id: "opencode",
    aliases: ["opencode"],
    cli: "opencode",
    writerKind: "muon-json",
    // Only the user-level config is claimed. A project-level opencode.json was
    // NOT exercised, so it is not offered rather than guessed at.
    scopes: ["user"],
    defaultScope: "user",
    verifiedAt:
      "opencode 1.18.7, live 2026-07-30 (JSON write confirmed by `mcp list` reporting `muon connected` in a temp XDG_CONFIG_HOME)",
    notes: [
      "opencode's own `mcp add` is interactive and MUON does not drive it; MUON writes the JSON directly.",
      "The entry SHAPE is live-verified (opencode reported `muon connected` after the write), but the vendor's own writer was never exercised, so its migrations are not MUON's to inherit.",
    ],
  },
] as const;

/** Vendors MUON deliberately does NOT install. Asserted, never derived. */
export function installableRemainder(): readonly VendorId[] {
  const installable = new Set(INSTALLABLE_VENDORS.map((spec) => spec.id));
  return VENDOR_IDS.filter((id) => !installable.has(id));
}

/** Resolve a user-typed vendor token. Own alias table on purpose: this command's
 *  set includes `opencode` (which `normalizeVendorAlias` omits) and excludes the
 *  dev-test `fake`. */
export function resolveInstallableVendor(
  token: string
): InstallableVendorSpec | undefined {
  const cleaned = token.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return INSTALLABLE_VENDORS.find((spec) => spec.aliases.includes(cleaned));
}

export function installableVendorTokens(): string {
  return INSTALLABLE_VENDORS.map((spec) => spec.aliases[0]).join(" | ");
}

/** Does this vendor hold the coordinator seat? Read straight off the registry —
 *  `muon mcp install` neither widens nor consults it as a gate. */
export function vendorHoldsCoordinatorSeat(id: VendorId): boolean {
  return vendorEntry(id).authority.coordinatorSeat;
}

// ─────────────────────── config paths + child env ───────────────────────────

/** The env MUON forces onto a vendor process. Empty in production. */
export function vendorChildEnv(
  spec: InstallableVendorSpec,
  roots: VendorConfigRoots
): Record<string, string> {
  if (!roots.redirectVendorConfigDirs) {
    return {};
  }
  switch (spec.id) {
    case "claude-code":
      return { CLAUDE_CONFIG_DIR: roots.home };
    case "codex":
      return { CODEX_HOME: path.join(roots.home, ".codex") };
    case "cursor":
      return { HOME: roots.home };
    case "opencode":
      return { XDG_CONFIG_HOME: roots.configHome };
    default:
      return {};
  }
}

export function vendorConfigPath(
  spec: InstallableVendorSpec,
  scope: McpConfigScope,
  roots: VendorConfigRoots
): string {
  switch (spec.id) {
    case "claude-code":
      // user scope → top-level `mcpServers` in ~/.claude.json.
      // project scope → the repo's own .mcp.json.
      return scope === "user"
        ? path.join(roots.home, ".claude.json")
        : path.join(roots.cwd, ".mcp.json");
    case "codex":
      return path.join(roots.home, ".codex", "config.toml");
    case "cursor":
      return scope === "user"
        ? path.join(roots.home, ".cursor", "mcp.json")
        : path.join(roots.cwd, ".cursor", "mcp.json");
    case "opencode":
      return path.join(roots.configHome, "opencode", "opencode.json");
    default:
      throw new Error(`no MCP config path for vendor '${spec.id}'`);
  }
}

/**
 * The claude LOCAL-scope location, read for diagnosis only. MUON never writes
 * here; `status` reports a hit as `scope-local-invisible-elsewhere` because that
 * is the silent failure §2.2 warns about.
 */
export function claudeLocalScopePresence(
  roots: VendorConfigRoots
): { present: boolean; command?: string } {
  const doc = readJsonDocument(path.join(roots.home, ".claude.json"));
  if (!doc.ok || doc.value === null) {
    return { present: false };
  }
  const projects = asRecord(asRecord(doc.value)?.projects);
  const project = asRecord(projects?.[roots.cwd]);
  const entry = asRecord(asRecord(project?.mcpServers)?.[MUON_MCP_ENTRY_NAME]);
  if (!entry) {
    return { present: false };
  }
  return {
    present: true,
    command: typeof entry.command === "string" ? entry.command : undefined,
  };
}

// ───────────────────────── reading the current entry ────────────────────────

export type VendorEntryReading =
  | { kind: "absent" }
  | {
      kind: "present";
      command: string | undefined;
      environment: Readonly<Record<string, string>>;
      raw: string;
    }
  /** The config file exists but MUON could not understand it. Never clobbered. */
  | { kind: "unreadable"; reason: string };

export function readVendorEntry(
  spec: InstallableVendorSpec,
  scope: McpConfigScope,
  roots: VendorConfigRoots
): VendorEntryReading {
  const file = vendorConfigPath(spec, scope, roots);
  if (spec.id === "codex") {
    return readCodexEntry(file);
  }
  const doc = readJsonDocument(file);
  if (!doc.ok) {
    return { kind: "unreadable", reason: doc.reason };
  }
  if (doc.value === null) {
    return { kind: "absent" };
  }
  const root = asRecord(doc.value);
  if (!root) {
    return { kind: "unreadable", reason: `${file} is not a JSON object` };
  }
  const container = asRecord(root[jsonContainerKey(spec)]);
  const entry = asRecord(container?.[MUON_MCP_ENTRY_NAME]);
  if (!entry) {
    return { kind: "absent" };
  }
  return {
    kind: "present",
    command: readEntryCommand(spec, entry),
    environment: readEntryEnvironment(spec, entry),
    raw: JSON.stringify(entry, null, 2),
  };
}

function jsonContainerKey(spec: InstallableVendorSpec): string {
  // opencode nests under `mcp`; claude and cursor under `mcpServers`.
  return spec.id === "opencode" ? "mcp" : "mcpServers";
}

function readEntryCommand(
  spec: InstallableVendorSpec,
  entry: Record<string, unknown>
): string | undefined {
  if (spec.id === "opencode") {
    // opencode's local shape is `command: [<argv0>, ...args]`.
    const argv = Array.isArray(entry.command) ? entry.command : [];
    return typeof argv[0] === "string" ? argv[0] : undefined;
  }
  return typeof entry.command === "string" ? entry.command : undefined;
}

function readEntryEnvironment(
  spec: InstallableVendorSpec,
  entry: Record<string, unknown>
): Readonly<Record<string, string>> {
  const raw = asRecord(spec.id === "opencode" ? entry.environment : entry.env);
  if (!raw) return {};
  const environment: Record<string, string> = {};
  for (const key of [
    "MUON_MCP_MODE",
    "MUON_CHAT_ID",
    "MUON_ATTACHED_CAPABILITY_FILE",
  ] as const) {
    if (typeof raw[key] === "string") environment[key] = raw[key];
  }
  return environment;
}

/**
 * A BOUNDED, READ-ONLY scan of codex's TOML for `[mcp_servers.muon]`.
 *
 * MUON never WRITES this file — `codex mcp add` does, because codex owns its own
 * format and migrations (§2.2 D-writer). Reading it here rather than shelling out
 * to `codex mcp get` is deliberate: `status` must still answer "is muon
 * registered" when the `codex` binary is not on PATH, and it must not spawn a
 * vendor process just to render a diagnostic.
 */
function readCodexEntry(file: string): VendorEntryReading {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable", reason: `${file}: ${(error as Error).message}` };
  }
  const lines = text.split("\n");
  const header = `[mcp_servers.${MUON_MCP_ENTRY_NAME}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    return { kind: "absent" };
  }
  const section: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    // Any new table header ends the section — including
    // `[mcp_servers.muon.env]`, which is correct: `command` is never in there.
    if (lines[i]!.trimStart().startsWith("[")) {
      break;
    }
    section.push(lines[i]!);
  }
  const commandLine = section.find((line) => /^\s*command\s*=/.test(line));
  const quoted = commandLine?.match(/"((?:[^"\\]|\\.)*)"/);
  const envHeader = `[mcp_servers.${MUON_MCP_ENTRY_NAME}.env]`;
  const envStart = lines.findIndex((line) => line.trim() === envHeader);
  const envLines: string[] = [];
  if (envStart !== -1) {
    for (let i = envStart + 1; i < lines.length; i += 1) {
      if (lines[i]!.trimStart().startsWith("[")) break;
      envLines.push(lines[i]!);
    }
  }
  const environment: Record<string, string> = {};
  for (const line of envLines) {
    const match = line.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/
    );
    if (
      match &&
      (match[1] === "MUON_MCP_MODE" ||
        match[1] === "MUON_CHAT_ID" ||
        match[1] === "MUON_ATTACHED_CAPABILITY_FILE")
    ) {
      environment[match[1]] = match[2]!.replace(/\\(.)/g, "$1");
    }
  }
  return {
    kind: "present",
    command: quoted?.[1]?.replace(/\\(.)/g, "$1"),
    environment,
    raw: [
      header,
      ...section,
      ...(envStart === -1 ? [] : [envHeader, ...envLines]),
    ]
      .join("\n")
      .replace(/\n+$/, ""),
  };
}

// ───────────────────────────── resolving `command` ──────────────────────────

export type CommandResolution =
  | { ok: true; command: string; source: string }
  | { ok: false; searched: readonly string[] };

/**
 * Sub-decision D-cmd (§2.2): resolve the command path at install time, VERIFY it,
 * and record it. `status` re-verifies on every run.
 *
 * Rejected alternatives, recorded here because each looks reasonable:
 *  - bare `muon-mcp` (what `withMuonMcpServer` emits): broken for a `.dmg`-only
 *    user, who has no `muon-mcp` on PATH at all (§1.4c). MUON has no interpose
 *    inside the user's own vendor CLI, so that failure is silent there.
 *  - an absolute path and nothing else: breaks when the app moves or updates,
 *    and a stale absolute path is the same silent failure.
 *  - installing a shim / mutating PATH: MUON gains a launcher it then owns
 *    forever. Explicitly not doing this.
 * So: write the absolute path that resolves NOW, and give the user a command that
 * tells them when it stopped being true.
 */
export function resolveMuonMcpCommand(io: McpVendorIo): CommandResolution {
  const searched: string[] = [];
  const candidates: { path: string; source: string }[] = [];

  // 1. A sibling of the `muon` binary that is running right now. Strongest
  //    signal and needs no PATH at all: npm/brew/mise all link both bins into
  //    the same dir, and a packaged build that ships both puts them together.
  const selfBin = process.argv[1];
  if (selfBin) {
    candidates.push({
      path: path.join(path.dirname(path.resolve(selfBin)), "muon-mcp"),
      source: "sibling of the running muon binary",
    });
  }

  // 2. PATH.
  const onPath = io.which("muon-mcp");
  if (onPath) {
    candidates.push({ path: onPath, source: "PATH" });
  }

  // 3. The same well-known install dirs the desktop prepends for exactly this
  //    binary (apps/desktop/src/lib/path-fix.ts:12-24). Duplicated rather than
  //    imported because a desktop module is not reachable from the CLI; if that
  //    list grows, this one should follow.
  for (const dir of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(io.roots.home, ".local", "bin"),
    path.join(io.roots.home, ".local", "share", "mise", "shims"),
    path.join(io.roots.home, "bin"),
  ]) {
    candidates.push({ path: path.join(dir, "muon-mcp"), source: dir });
  }

  for (const candidate of candidates) {
    searched.push(candidate.path);
    if (io.isExecutableFile(candidate.path)) {
      return { ok: true, command: candidate.path, source: candidate.source };
    }
  }
  return { ok: false, searched };
}

/**
 * The ONE refusal text for "there is no executable `muon-mcp` to register".
 *
 * Extracted from `apps/cli/src/commands/mcp.ts` verbatim when the desktop's
 * Connections row gained an Install action: two surfaces explaining the same
 * `.dmg`-only failure (§1.4c) in two different sets of words is exactly the
 * cross-surface drift §5 is written to prevent, and this one has to name every
 * path it searched or the user cannot act on it.
 */
export function muonMcpUnresolvedRefusal(searched: readonly string[]): string {
  return `Could not find an executable 'muon-mcp' to register. Searched:\n  ${searched.join("\n  ")}\nInstall the MUON CLI package (which ships both the 'muon' and 'muon-mcp' bins) and re-run. MUON deliberately does not write a bare 'muon-mcp' command: a vendor CLI launched from Finder inherits a bare PATH and would fail with no diagnostic.`;
}

// ─────────────────────────────── install ────────────────────────────────────

export type InstallOutcome =
  /** The entry already names this command + requested MUON mode/chat. Nothing
   *  was touched — which makes `install` byte-identically idempotent. */
  | { kind: "already-current"; configPath: string; entry: string }
  | {
      kind: "written";
      configPath: string;
      entry: string;
      /** Exactly what MUON ran / wrote, verbatim, for the user to audit. */
      via: string;
      /** Whether a differing prior entry was replaced. */
      replaced: boolean;
      /** Best-effort follow-ups (e.g. cursor's approval clear) and their result. */
      followUps: readonly string[];
    }
  | { kind: "dry-run"; configPath: string; entry: string; via: string }
  | { kind: "refused"; reason: string; hint?: string };

export type InstallRequest = {
  spec: InstallableVendorSpec;
  scope: McpConfigScope;
  command: string;
  dryRun: boolean;
  /**
   * The attach modes this writer may persist. Undefined is Tier A/base.
   * `attached-coordinator` (ADR-0028 Tier C) is a DISTINCT, narrower contract
   * from `observer`: it is minted per-attach by an operator-tier surface (see
   * `@muon/client/attached-coordinator-capability`), never typed in by hand,
   * so this writer only ever RECORDS the capability file path — never a token,
   * never `MUON_API_BASE`, never a chatId (the file itself carries chatId).
   */
  mode?: "observer" | "attached-coordinator";
  /** Durable coordinate only; never a credential or authority grant. Ignored
   *  for `mode: "attached-coordinator"` — the capability file carries it. */
  chatId?: string;
  /**
   * Absolute path to the ADR-0028 capability file. Required, and used ONLY,
   * when `mode === "attached-coordinator"`.
   */
  capabilityFile?: string;
};

function installEnvironment(
  request: InstallRequest
): Readonly<Record<string, string>> {
  if (request.mode === "attached-coordinator") {
    const file = request.capabilityFile?.trim();
    if (!file) {
      throw new Error(
        "attached-coordinator install requires an absolute capabilityFile path"
      );
    }
    if (!path.isAbsolute(file)) {
      throw new Error("capabilityFile must be an absolute path");
    }
    // Exactly these two keys — never a token, never MUON_API_BASE, never a
    // chatId. The capability file (not the vendor config) is the ONLY place
    // ADR-0028's per-job coordinates and credential live.
    return {
      MUON_MCP_MODE: "attached-coordinator",
      MUON_ATTACHED_CAPABILITY_FILE: file,
    };
  }
  const chatId = request.chatId?.trim();
  if (chatId && chatId.length > 128) {
    throw new Error("chatId exceeds 128 characters");
  }
  return {
    ...(request.mode === "observer" ? { MUON_MCP_MODE: "observer" } : {}),
    ...(chatId ? { MUON_CHAT_ID: chatId } : {}),
  };
}

function sameInstallEnvironment(
  current: Readonly<Record<string, string>>,
  target: Readonly<Record<string, string>>
): boolean {
  return (
    current.MUON_MCP_MODE === target.MUON_MCP_MODE &&
    current.MUON_CHAT_ID === target.MUON_CHAT_ID &&
    current.MUON_ATTACHED_CAPABILITY_FILE ===
      target.MUON_ATTACHED_CAPABILITY_FILE
  );
}

export function installMcpServer(
  io: McpVendorIo,
  request: InstallRequest
): InstallOutcome {
  const { spec, scope, command, dryRun } = request;
  const environment = installEnvironment(request);
  if (!spec.scopes.includes(scope)) {
    return {
      kind: "refused",
      reason: `${vendorLabel(spec.id)} has no '${scope}' MCP scope; MUON exposes ${spec.scopes.join(" and ")}.`,
      hint:
        spec.id === "codex"
          ? "codex registers MCP servers globally (no scope flag at codex-cli 0.145.0)."
          : undefined,
    };
  }
  const configPath = vendorConfigPath(spec, scope, io.roots);
  const current = readVendorEntry(spec, scope, io.roots);
  if (current.kind === "unreadable") {
    // Never clobber a config MUON could not parse. A vendor config is the user's
    // file, and a rewrite that drops keys MUON failed to read is unrecoverable.
    return {
      kind: "refused",
      reason: `Could not read ${configPath}: ${current.reason}`,
      hint: "Fix or move that file, then re-run. MUON will not overwrite a config it cannot parse.",
    };
  }
  const target = renderTargetEntry(spec, command, environment);
  if (
    current.kind === "present" &&
    current.command === command &&
    sameInstallEnvironment(current.environment, environment)
  ) {
    return { kind: "already-current", configPath, entry: current.raw };
  }
  const via = describeWrite(spec, scope, command, configPath, environment);
  if (dryRun) {
    return { kind: "dry-run", configPath, entry: target, via };
  }

  const replaced = current.kind === "present";
  const applied =
    spec.writerKind === "vendor-cli"
      ? applyVendorCliWrite(
          io,
          spec,
          scope,
          command,
          environment,
          replaced,
          // The PRIOR entry, so a failed update can put it back rather than
          // leaving the vendor with no MUON server at all.
          current.kind === "present"
            ? { command: current.command, environment: current.environment }
            : undefined
        )
      : applyMuonJsonWrite(io, spec, scope, command, environment, configPath);
  if (applied.kind === "refused") {
    return applied;
  }

  const readBack = readVendorEntry(spec, scope, io.roots);
  if (readBack.kind !== "present") {
    return {
      kind: "refused",
      reason: `${spec.cli} reported success but ${configPath} still has no '${MUON_MCP_ENTRY_NAME}' entry.`,
      hint: applied.detail,
    };
  }
  if (
    readBack.command !== command ||
    !sameInstallEnvironment(readBack.environment, environment)
  ) {
    return {
      kind: "refused",
      reason: `${spec.cli} reported success but ${configPath} did not retain the requested command/mode/chat entry.`,
      hint: applied.detail,
    };
  }
  return {
    kind: "written",
    configPath,
    entry: readBack.raw,
    via,
    replaced,
    followUps: applied.followUps,
  };
}

type ApplyResult =
  | { kind: "applied"; followUps: readonly string[]; detail?: string }
  | { kind: "refused"; reason: string; hint?: string };

function applyVendorCliWrite(
  io: McpVendorIo,
  spec: InstallableVendorSpec,
  scope: McpConfigScope,
  command: string,
  environment: Readonly<Record<string, string>>,
  replaced: boolean,
  priorEntry?: {
    command: string | undefined;
    environment: Readonly<Record<string, string>>;
  }
): ApplyResult {
  const cliPath = io.which(spec.cli);
  if (!cliPath) {
    return {
      kind: "refused",
      reason: `'${spec.cli}' is not on PATH, and MUON writes ${vendorLabel(spec.id)}'s MCP config through the vendor's own writer.`,
      hint: `Install ${vendorLabel(spec.id)} first, then re-run. MUON never edits ${spec.id === "codex" ? "someone else's TOML" : "that file"} directly.`,
    };
  }
  const extraEnv = vendorChildEnv(spec, io.roots);

  const followUps: string[] = [];

  // `claude mcp add` EXITS 1 and refuses when the name already exists (measured
  // live 2026-07-30 at 2.1.220), so an update — the D-cmd case where the
  // recorded path moved — needs a remove first. `-s <scope>` keeps that removal
  // from reaching into another scope the user set up deliberately.
  //
  // `claude mcp remove` ALSO exits 1 when the entry is absent (measured, and it
  // caught a wrong reading of this very shell probe: `claude … | head` reports
  // the pipe's status, not claude's). So its exit code is NOT authority here —
  // "was not there" and "could not remove" share rc 1. The `add` below is the
  // only gate: if the entry really is stuck, `add` fails with a legible
  // "already exists" naming the exact argv. A non-zero `remove` is carried
  // forward as a note instead of a refusal.
  //
  // `codex mcp add` overwrites in place at rc 0, so it needs none of this.
  if (spec.id === "claude-code" && replaced) {
    const removeArgs = ["mcp", "remove", MUON_MCP_ENTRY_NAME, "-s", scope];
    const removed = io.run(spec.cli, removeArgs, extraEnv);
    if (removed.code !== 0) {
      followUps.push(
        `\`${spec.cli} ${removeArgs.join(" ")}\` exited ${removed.code}: ${firstLine(removed.stderr || removed.stdout)} (not fatal — the add below is the gate)`
      );
    }
  }

  const args = vendorAddArgs(spec, scope, command, environment);
  const result = io.run(spec.cli, args, extraEnv);
  if (result.code !== 0) {
    // RESTORE what the remove above destroyed. Without this, a failed UPDATE
    // (the recorded `muon-mcp` path moved after a reinstall, say) left the
    // vendor with NO muon server at all — strictly worse than before the
    // command ran, and `muon mcp install` claims to be idempotent. Best-effort
    // by construction: if the restore also fails, the refusal says so rather
    // than implying the old entry is still there.
    let restoreNote = "";
    if (replaced && priorEntry?.command) {
      const restoreArgs = vendorAddArgs(
        spec,
        scope,
        priorEntry.command,
        priorEntry.environment
      );
      const restored = io.run(spec.cli, restoreArgs, extraEnv);
      restoreNote =
        restored.code === 0
          ? " The previous entry was restored."
          : ` The previous entry could NOT be restored (\`${spec.cli} ${restoreArgs.join(" ")}\` exited ${restored.code}); re-run \`muon mcp install\` once the cause is fixed.`;
    }
    return {
      kind: "refused",
      reason: `\`${spec.cli} ${args.join(" ")}\` failed (exit ${result.code}): ${firstLine(result.stderr || result.stdout)}.${restoreNote}`,
    };
  }
  return { kind: "applied", followUps, detail: firstLine(result.stdout) };
}

function vendorAddArgs(
  spec: InstallableVendorSpec,
  scope: McpConfigScope,
  command: string,
  environment: Readonly<Record<string, string>> = {}
): string[] {
  const pairs = Object.entries(environment).map(([key, value]) => `${key}=${value}`);
  switch (spec.id) {
    case "claude-code":
      // `-s <scope>` is ALWAYS passed: the vendor's default is `local`.
      return [
        "mcp",
        "add",
        MUON_MCP_ENTRY_NAME,
        "-s",
        scope,
        ...pairs.flatMap((pair) => ["-e", pair]),
        "--",
        command,
      ];
    case "codex":
      return [
        "mcp",
        "add",
        MUON_MCP_ENTRY_NAME,
        ...pairs.flatMap((pair) => ["--env", pair]),
        "--",
        command,
      ];
    default:
      throw new Error(`vendor '${spec.id}' has no CLI writer`);
  }
}

function applyMuonJsonWrite(
  io: McpVendorIo,
  spec: InstallableVendorSpec,
  scope: McpConfigScope,
  command: string,
  environment: Readonly<Record<string, string>>,
  configPath: string
): ApplyResult {
  const doc = readJsonDocument(configPath);
  if (!doc.ok) {
    return { kind: "refused", reason: doc.reason };
  }
  const root: Record<string, unknown> =
    doc.value === null ? {} : { ...(asRecord(doc.value) ?? {}) };
  const key = jsonContainerKey(spec);
  // Read-modify-write: every sibling key and every other server survives. MUON
  // only ever sets `<container>.muon`.
  const container = { ...(asRecord(root[key]) ?? {}) };
  container[MUON_MCP_ENTRY_NAME] = muonJsonEntry(spec, command, environment);
  root[key] = container;
  if (spec.id === "opencode" && doc.value === null) {
    // A brand-new opencode config: give it the schema pointer its own writer
    // emits, so the file the user later opens looks like opencode's own.
    root.$schema = "https://opencode.ai/config.json";
  }

  try {
    writeJsonPreservingMode(configPath, root);
  } catch (error) {
    return {
      kind: "refused",
      reason: `Could not write ${configPath}: ${(error as Error).message}`,
    };
  }

  const followUps: string[] = [];
  // MUON writes no credential of its own, so ITS entry is not sensitive — but
  // these files routinely hold other servers' bearer tokens, and MUON has just
  // become a reason to look at this one. Report a wider-than-0600 mode instead of
  // narrowing it: silently changing the visibility of a file the user chose to
  // share is not MUON's call (ADR-0017 §1 makes 0600 the boundary MUON's OWN
  // files use).
  const mode = fileMode(configPath);
  if (mode !== null && (mode & 0o077) !== 0) {
    followUps.push(
      `${configPath} is mode ${mode.toString(8).padStart(4, "0")} (readable beyond your user). MUON preserved it rather than narrowing it, and wrote no credential of its own — but other servers in that file may hold tokens. \`chmod 600 ${configPath}\` if that is not deliberate.`
    );
  }
  if (spec.id === "cursor") {
    // cursor gates a DISABLED server even when mcp.json names it (measured:
    // `mcp disable muon` → `mcp list` reports `muon: disabled`). `enable` is the
    // only thing that clears that, and it is a no-op when already approved.
    // Best-effort: a missing/unauthenticated cursor-agent must not fail a write
    // that already landed. NOTE cursor-agent exits 0 even when logged OUT, so
    // its exit code is not evidence of anything beyond "the call ran".
    const cliPath = io.which(spec.cli);
    if (!cliPath) {
      followUps.push(
        `skipped \`${spec.cli} mcp enable ${MUON_MCP_ENTRY_NAME}\` — ${spec.cli} is not on PATH. Run it yourself if cursor reports the server as disabled.`
      );
    } else {
      const enabled = io.run(
        spec.cli,
        ["mcp", "enable", MUON_MCP_ENTRY_NAME],
        vendorChildEnv(spec, io.roots)
      );
      followUps.push(
        enabled.code === 0
          ? `ran \`${spec.cli} mcp enable ${MUON_MCP_ENTRY_NAME}\` → ${firstLine(enabled.stdout) || "ok"}`
          : `\`${spec.cli} mcp enable ${MUON_MCP_ENTRY_NAME}\` exited ${enabled.code}: ${firstLine(enabled.stderr || enabled.stdout)} (the config entry was still written)`
      );
    }
  }
  void scope;
  return { kind: "applied", followUps };
}

/** The exact entry MUON writes. Never a token or MUON_API_BASE. */
function muonJsonEntry(
  spec: InstallableVendorSpec,
  command: string,
  environment: Readonly<Record<string, string>> = {}
): Record<string, unknown> {
  if (spec.id === "opencode") {
    return {
      type: "local",
      command: [command],
      enabled: true,
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
    };
  }
  return {
    command,
    args: [],
    ...(Object.keys(environment).length > 0 ? { env: environment } : {}),
  };
}

function renderTargetEntry(
  spec: InstallableVendorSpec,
  command: string,
  environment: Readonly<Record<string, string>> = {}
): string {
  if (spec.writerKind === "muon-json") {
    return JSON.stringify(muonJsonEntry(spec, command, environment), null, 2);
  }
  if (spec.id === "codex") {
    const env = Object.entries(environment).map(
      ([key, value]) => `${key} = ${JSON.stringify(value)}`
    );
    return [
      `[mcp_servers.${MUON_MCP_ENTRY_NAME}]`,
      `command = ${JSON.stringify(command)}`,
      ...(env.length > 0
        ? [`[mcp_servers.${MUON_MCP_ENTRY_NAME}.env]`, ...env]
        : []),
    ].join("\n");
  }
  return JSON.stringify({ command, args: [], env: environment }, null, 2);
}

function describeWrite(
  spec: InstallableVendorSpec,
  scope: McpConfigScope,
  command: string,
  configPath: string,
  environment: Readonly<Record<string, string>> = {}
): string {
  if (spec.writerKind === "vendor-cli") {
    return `${spec.cli} ${vendorAddArgs(spec, scope, command, environment).join(" ")}`;
  }
  // Say WHY MUON is writing rather than delegating, per vendor — the two reasons
  // are different and a reader who is deciding whether to trust this needs the
  // real one. cursor genuinely has no `mcp add`; opencode has one and it is
  // interactive, which is a different (weaker) claim.
  const why =
    spec.id === "cursor"
      ? `${spec.cli} ships no \`mcp add\``
      : `${spec.cli}'s own \`mcp add\` is interactive, so MUON does not drive it`;
  return `muon (direct JSON write to ${configPath}; ${why})`;
}

// ────────────────────────────── uninstall ───────────────────────────────────

export type UninstallOutcome =
  | { kind: "removed"; configPath: string; via: string }
  | { kind: "absent"; configPath: string }
  | { kind: "refused"; reason: string; hint?: string };

/** Removes exactly the entry MUON wrote and nothing else. */
export function uninstallMcpServer(
  io: McpVendorIo,
  spec: InstallableVendorSpec,
  scope: McpConfigScope
): UninstallOutcome {
  if (!spec.scopes.includes(scope)) {
    return {
      kind: "refused",
      reason: `${vendorLabel(spec.id)} has no '${scope}' MCP scope; MUON exposes ${spec.scopes.join(" and ")}.`,
    };
  }
  const configPath = vendorConfigPath(spec, scope, io.roots);
  const current = readVendorEntry(spec, scope, io.roots);
  if (current.kind === "unreadable") {
    return {
      kind: "refused",
      reason: `Could not read ${configPath}: ${current.reason}`,
      hint: "MUON will not rewrite a config it cannot parse.",
    };
  }
  if (current.kind === "absent") {
    return { kind: "absent", configPath };
  }

  if (spec.writerKind === "vendor-cli") {
    const cliPath = io.which(spec.cli);
    if (!cliPath) {
      return {
        kind: "refused",
        reason: `'${spec.cli}' is not on PATH, and MUON removes ${vendorLabel(spec.id)}'s entry through the vendor's own writer.`,
      };
    }
    const args =
      spec.id === "claude-code"
        ? // Scoped on purpose: an unscoped `claude mcp remove` deletes from
          // "whichever scope it exists in", which could reach a project entry
          // the user added deliberately.
          ["mcp", "remove", MUON_MCP_ENTRY_NAME, "-s", scope]
        : ["mcp", "remove", MUON_MCP_ENTRY_NAME];
    const result = io.run(spec.cli, args, vendorChildEnv(spec, io.roots));
    // The exit code is not sufficient evidence either way (claude's `mcp remove`
    // exits 1 for "was not there" as well as for a real failure), so the READ-BACK
    // is what decides. "Removed exactly the entry MUON wrote" has to be verified,
    // not asserted.
    const readBack = readVendorEntry(spec, scope, io.roots);
    if (readBack.kind === "present") {
      return {
        kind: "refused",
        reason: `\`${spec.cli} ${args.join(" ")}\` exited ${result.code} and '${MUON_MCP_ENTRY_NAME}' is still in ${configPath}: ${firstLine(result.stderr || result.stdout)}`,
      };
    }
    return { kind: "removed", configPath, via: `${spec.cli} ${args.join(" ")}` };
  }

  const doc = readJsonDocument(configPath);
  if (!doc.ok || doc.value === null) {
    return { kind: "absent", configPath };
  }
  const root = { ...(asRecord(doc.value) ?? {}) };
  const key = jsonContainerKey(spec);
  const container = { ...(asRecord(root[key]) ?? {}) };
  // `delete` ONE key. Every other server, and every sibling top-level key, is
  // carried through untouched — `uninstall` is not a reset.
  delete container[MUON_MCP_ENTRY_NAME];
  root[key] = container;
  try {
    writeJsonPreservingMode(configPath, root);
  } catch (error) {
    return {
      kind: "refused",
      reason: `Could not write ${configPath}: ${(error as Error).message}`,
    };
  }
  return {
    kind: "removed",
    configPath,
    via: `muon (removed only ${key}.${MUON_MCP_ENTRY_NAME} from ${configPath})`,
  };
}

// ───────────────────────────── json plumbing ────────────────────────────────

type JsonRead =
  | { ok: true; value: unknown | null }
  | { ok: false; reason: string };

function readJsonDocument(file: string): JsonRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { ok: true, value: null }
      : { ok: false, reason: `${file}: ${(error as Error).message}` };
  }
  if (text.trim() === "") {
    return { ok: true, value: null };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, reason: `${file} is not valid JSON (${(error as Error).message})` };
  }
}

/**
 * Atomic write that never WIDENS the file's mode. A new file is created 0600
 * (ADR-0017 §1: 0600 is the uid boundary these files rely on, and cursor's own
 * mcp.json was observed at 0600); an existing file keeps whatever mode it has,
 * because narrowing a config the user chose to share is not MUON's call either.
 */
function writeJsonPreservingMode(file: string, value: unknown): void {
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const text = `${JSON.stringify(value, null, 2)}\n`;
  // Random name + `wx` (exclusive create), mirroring
  // attached-coordinator-capability.ts: `${file}.${pid}.muon.tmp` was
  // predictable, and the default "w" flag follows a pre-planted symlink at
  // that name — truncating an unrelated same-user file before the rename.
  const tmp = `${file}.${process.pid}.${randomBytes(12).toString("hex")}.muon.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: "wx", mode });
    fs.renameSync(tmp, file);
  } finally {
    // Rename removes the temp path on success; a failed write/rename must not
    // leave a stray artifact behind.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup; the original failure remains the useful error.
    }
  }
}

/** The file's permission bits, or null when it does not exist yet. */
function fileMode(file: string): number | null {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}
