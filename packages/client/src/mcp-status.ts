import path from "node:path";
// The `@muon/client/paths` subpath (same entry the backend uses) rather than the
// package root: `readLiveLockfile` is the liveness-checked read, and the root
// index only re-exports `readLockfile`. A lockfile left by a crashed brain must
// read as "no brain", because that is exactly the condition that produces a 401
// this command exists to explain.
import { readLiveLockfile, resolveDataDir } from "./paths.js";
import {
  ATTACHED_COORDINATOR_CAPABILITY_MODE,
  MUON_ATTACHED_COORDINATOR_TOOL_NAMES,
  MUON_CONTEXT_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES,
  MUON_CONTROL_TOOL_NAMES,
  MUON_OBSERVER_TOOL_NAMES,
  vendorLabel,
  type VendorId,
} from "@muon/protocol";
import {
  INSTALLABLE_VENDORS,
  MUON_MCP_ENTRY_NAME,
  claudeLocalScopePresence,
  readVendorEntry,
  resolveMuonMcpCommand,
  vendorConfigPath,
  vendorHoldsCoordinatorSeat,
  type InstallableVendorSpec,
  type McpConfigScope,
  type McpVendorIo,
} from "./mcp-vendor-config.js";
import { readAttachedCoordinatorCapabilityFile } from "./attached-coordinator-capability.js";

/**
 * `muon mcp status` — the §3.2 OUTPUT CONTRACT of
 * docs/design/cc-as-superagent-delivery.md, not a suggestion.
 *
 * THE ONE EVALUATOR for all three human surfaces (§5). `muon mcp status`, the
 * TUI's `/mcp` palette panel and the desktop's Settings → Connections row all
 * call `buildMcpStatusReport` and render `McpStatusReport`; none of them
 * re-derives a check, a level, a reason id or a vendor fact in its own idiom.
 * That is deliberate: this repo's most common regression is a change landing on
 * one surface and not its siblings, and a surface that restates a check is a
 * surface that will disagree with the CLI the next time a check changes. If a
 * surface needs something this function does not expose, WIDEN THIS FUNCTION.
 *
 * This command is load-bearing because the tier a hand-registered `muon-mcp`
 * gets is resolved from AMBIENT state, and ambient state is exactly what a user
 * cannot see. Every field below exists because a specific ambient condition
 * silently changes the answer. A status command that says "OK" without being
 * able to say "and here is what I checked" is the thing this stage exists to
 * avoid — so the report always carries the full check list with each check's
 * state, never only the failures.
 */

/**
 * Every reason `status` can name. POSITIVE list, and `mcpStatusCheckIds()` over a
 * built report must equal it — the drift lock for the output contract. A new
 * ambient failure mode has to be added here, which is the point: §3.2's
 * requirement is that the command name every reason it could be wrong.
 */
export const MCP_STATUS_CHECK_IDS = [
  /** No live lockfile ⇒ no agent token ⇒ 401 on every call (§3.2). */
  "brain-running",
  /** `MUON_API_BASE` exported in this shell turns OFF the lockfile branch (§1.4b). */
  "api-base-source",
  /** Which resolver branch supplies the bearer, so "why do I get 401" is one command. */
  "agent-token",
  /** `MUON_MCP_MODE` set without runner lineage ⇒ the server refuses to start. */
  "mcp-mode-env",
  /** Can `muon-mcp` be resolved at all right now (§1.4c, D-cmd). */
  "muon-mcp-command",
  /** Is MUON registered with at least one vendor. */
  "vendor-registration",
  /** ADR-0028 Tier C: whether any install/env is in attached-coordinator mode. */
  "tier-c-attachment",
] as const;
export type McpStatusCheckId = (typeof MCP_STATUS_CHECK_IDS)[number];

/** Every reason a single vendor row can be wrong. Positive list, same reasoning. */
export const MCP_VENDOR_REASON_IDS = [
  "not-registered",
  "command-path-moved",
  "command-not-absolute",
  "vendor-cli-missing",
  "scope-local-invisible-elsewhere",
  "config-unreadable",
  "vendor-approval-list",
  "vendor-writer-unverified",
  /** A human-installed entry may never request worker/control lineage. */
  "authority-bearing-mode",
  /** ADR-0028 Tier C attach mode (warn = non-hermetic; fail = missing capability file). */
  "attached-coordinator",
] as const;
export type McpVendorReasonId = (typeof MCP_VENDOR_REASON_IDS)[number];

export type CheckLevel = "ok" | "warn" | "fail";

export type McpStatusCheck = {
  id: McpStatusCheckId;
  level: CheckLevel;
  detail: string;
};

export type McpVendorReason = {
  id: McpVendorReasonId;
  level: CheckLevel;
  detail: string;
};

export type McpVendorStatus = {
  vendor: VendorId;
  label: string;
  /** Two SEPARATE booleans. Conflating them is the documentation failure mode
   *  ADR-0022 warns about, so both are always printed (§2.2). */
  installable: true;
  coordinatorSeat: boolean;
  cli: string;
  cliInstalled: boolean;
  cliPath: string | null;
  scope: McpConfigScope;
  scopes: readonly McpConfigScope[];
  configPath: string;
  writer: "vendor-cli" | "muon-json";
  verifiedAt: string;
  installed: boolean;
  /** The absolute command recorded in the vendor's config, verbatim. */
  command: string | null;
  /** D-cmd: re-verified on EVERY status run. A path that stopped resolving is
   *  otherwise a silent MCP failure inside the user's own CLI. */
  commandResolves: boolean | null;
  /** Mode/chat persisted in this vendor's own entry, never ambient shell state. */
  mode: string | null;
  chatId: string | null;
  reasons: McpVendorReason[];
  notes: readonly string[];
};

export type McpStatusReport = {
  /** Brain / lockfile (§3.2 row 1). */
  brainRunning: boolean;
  dataDir: string;
  port: number | null;
  pid: number | null;
  /** §3.2 row 2. */
  apiBase: string;
  baseSource: "explicit-env" | "lockfile" | "default";
  /** §3.2 row 3. NEVER a value, only the branch name. */
  tokenSource: "MUON_API_TOKEN" | "MUON_AGENT_TOKEN" | "lockfile.agentToken" | "none";
  /** §3.2 row 4. Stated positively, and it is never `operator`:
   *  `resolveMcpApiToken()` has no operator branch and a regression pins it. */
  tier: "agent" | "none";
  /** §3.2 row 5. */
  mode: string | null;
  toolCount: number;
  /** D-cmd: what an install would record right now, and where it came from. */
  resolvedCommand: string | null;
  resolvedCommandSource: string | null;
  vendors: McpVendorStatus[];
  /** §3.2 row 7. True only when ambient/vendor state is attached-coordinator. */
  wouldGetTierC: boolean;
  tierCReason: string;
  checks: McpStatusCheck[];
};

const BASE_TOOL_COUNT =
  MUON_CONTEXT_TOOL_NAMES.length + MUON_COORDINATION_TOOL_NAMES.length;
const ORCHESTRATOR_TOOL_COUNT =
  BASE_TOOL_COUNT + MUON_CONTROL_TOOL_NAMES.length;
const OBSERVER_TOOL_COUNT = new Set([
  ...MUON_CONTEXT_TOOL_NAMES,
  ...MUON_COORDINATION_TOOL_NAMES,
  ...MUON_OBSERVER_TOOL_NAMES,
]).size;
const ATTACHED_COORDINATOR_TOOL_COUNT =
  new Set(MUON_ATTACHED_COORDINATOR_TOOL_NAMES).size;

export type McpStatusInput = {
  io: McpVendorIo;
  /** The env `muon-mcp` would inherit. Injected so a test never reads the real one. */
  env: Readonly<Record<string, string | undefined>>;
  /** Which scope to report per vendor (defaults to each vendor's default). */
  scope?: McpConfigScope;
};

export function buildMcpStatusReport(input: McpStatusInput): McpStatusReport {
  const { io, env } = input;

  const dataDir = env.MUON_DATA_DIR?.trim() || resolveDataDir();
  const lock = readLiveLockfile(dataDir);

  // Mirror `explicitBase()` (packages/client/src/config.ts:15-21) exactly. This
  // is the ONE ambient condition a user is most likely to have set for an
  // unrelated reason and least likely to connect to a 401.
  const explicitBase =
    env.MUON_API_BASE?.trim() || env.NEXT_PUBLIC_MUON_API_BASE?.trim() || undefined;
  const baseSource: McpStatusReport["baseSource"] = explicitBase
    ? "explicit-env"
    : lock
      ? "lockfile"
      : "default";
  const apiBase = explicitBase
    ? explicitBase.replace(/\/$/, "")
    : lock
      ? `http://127.0.0.1:${lock.port}`
      : "http://localhost:4000";

  // Mirror `resolveMcpApiToken()` = MUON_API_TOKEN || resolveAgentToken(), and
  // resolveAgentToken's own base pairing: an explicit base means the lockfile is
  // NEVER read. There is deliberately no operator branch to mirror.
  const tokenSource: McpStatusReport["tokenSource"] = env.MUON_API_TOKEN?.trim()
    ? "MUON_API_TOKEN"
    : explicitBase
      ? env.MUON_AGENT_TOKEN?.trim()
        ? "MUON_AGENT_TOKEN"
        : "none"
      : lock?.agentToken
        ? "lockfile.agentToken"
        : env.MUON_AGENT_TOKEN?.trim()
          ? "MUON_AGENT_TOKEN"
          : "none";
  const tier: McpStatusReport["tier"] = tokenSource === "none" ? "none" : "agent";

  const mode = env.MUON_MCP_MODE?.trim() || null;
  const toolCount =
    mode === ATTACHED_COORDINATOR_CAPABILITY_MODE
      ? ATTACHED_COORDINATOR_TOOL_COUNT
      : mode === "orchestrator"
        ? ORCHESTRATOR_TOOL_COUNT
        : mode === "observer"
          ? OBSERVER_TOOL_COUNT
          : BASE_TOOL_COUNT;

  const resolution = resolveMuonMcpCommand(io);
  const vendors = INSTALLABLE_VENDORS.map((spec) =>
    buildVendorStatus(io, spec, input.scope ?? spec.defaultScope)
  );
  const attachedVendors = vendors.filter(
    (row) =>
      row.installed &&
      row.mode === ATTACHED_COORDINATOR_CAPABILITY_MODE &&
      row.reasons.some(
        (reason) =>
          reason.id === "attached-coordinator" && reason.level === "warn"
      )
  );
  const ambientCapabilityPath =
    mode === ATTACHED_COORDINATOR_CAPABILITY_MODE
      ? env.MUON_ATTACHED_CAPABILITY_FILE?.trim()
      : undefined;
  const ambientCapability = ambientCapabilityPath
    ? readAttachedCoordinatorCapabilityFile(ambientCapabilityPath)
    : null;
  const ambientTierC = ambientCapability?.ok === true;
  const tierCRequested =
    mode === ATTACHED_COORDINATOR_CAPABILITY_MODE ||
    vendors.some(
      (row) =>
        row.installed && row.mode === ATTACHED_COORDINATOR_CAPABILITY_MODE
    );
  const wouldGetTierC =
    ambientTierC || attachedVendors.length > 0;
  const tierCReason = wouldGetTierC
    ? ambientTierC
      ? `this shell would start muon-mcp in ${ATTACHED_COORDINATOR_CAPABILITY_MODE} (ADR-0028) — non-hermetic; MUON governs delegated children only`
      : `${attachedVendors.map((row) => row.label).join(", ")} registered in ${ATTACHED_COORDINATOR_CAPABILITY_MODE} — restart the vendor to pick up the entry; non-hermetic`
    : tierCRequested
      ? ambientCapability && !ambientCapability.ok
        ? `attached-coordinator was requested, but its capability file is unusable (${ambientCapability.reason}): ${ambientCapability.detail}`
        : "attached-coordinator was requested, but every configured capability file is missing, expired, malformed, or insecure"
    : `not attached — run \`muon mcp attach <${INSTALLABLE_VENDORS.filter((s) => vendorHoldsCoordinatorSeat(s.id))
        .map((s) => s.aliases[0])
        .join("|")}>\` (ADR-0028). Base install cannot dispatch/steer/interrupt/ship`;

  const checks: McpStatusCheck[] = [
    lock
      ? {
          id: "brain-running",
          level: "ok",
          detail: `brain pid ${lock.pid} on 127.0.0.1:${lock.port} (${dataDir})`,
        }
      : {
          id: "brain-running",
          level: "fail",
          detail: `no live brain lockfile in ${dataDir}. Without one there is no agent token, so every MUON tool call answers 401. Run any \`muon\` command (or open the app) to start the embedded brain.`,
        },
    explicitBase
      ? {
          id: "api-base-source",
          level: "warn",
          detail: `MUON_API_BASE/NEXT_PUBLIC_MUON_API_BASE is exported (${explicitBase}). An explicit base makes explicitBase() true, which turns OFF the lockfile branch muon-mcp's token resolution depends on — so the session degrades to whatever MUON_AGENT_TOKEN holds, or to unauthenticated. Unset it in the shell you launch the vendor CLI from.`,
        }
      : {
          id: "api-base-source",
          level: "ok",
          detail:
            baseSource === "lockfile"
              ? `no explicit base in the environment, so muon-mcp auto-discovers ${apiBase} from the live lockfile — which is also what keeps the agent-token branch reachable`
              : `no explicit base in the environment, so the lockfile branch is enabled; with no live lockfile it currently falls back to ${apiBase}, and will pick up the real port as soon as a brain is running`,
        },
    tokenSource === "none"
      ? {
          id: "agent-token",
          level: "fail",
          detail:
            "no agent credential would resolve (MUON_API_TOKEN / MUON_AGENT_TOKEN unset, no agentToken in a live lockfile). muon-mcp starts and prints this on stderr, then every call 401s. MUON never presents the operator token from an MCP server.",
        }
      : {
          id: "agent-token",
          level: "ok",
          detail: `bearer resolves from ${tokenSource} → tier ${tier} (never operator)`,
        },
    mode === "observer"
      ? {
          id: "mcp-mode-env",
          level: "ok",
          detail: `MUON_MCP_MODE=observer → agent tier, ${OBSERVER_TOOL_COUNT} tools, bounded read-only crew visibility, and no runner lineage required`,
        }
      : mode === ATTACHED_COORDINATOR_CAPABILITY_MODE
        ? {
            id: "mcp-mode-env",
            level: ambientTierC ? "ok" : "fail",
            detail: ambientTierC
              ? `MUON_MCP_MODE=${ATTACHED_COORDINATOR_CAPABILITY_MODE} → Tier C (${ATTACHED_COORDINATOR_TOOL_COUNT} tools) via owner-only capability file (ADR-0028); non-hermetic`
              : `MUON_MCP_MODE=${ATTACHED_COORDINATOR_CAPABILITY_MODE} is set but its capability file is not usable — muon-mcp will refuse to start. ${tierCReason}. Re-run \`muon mcp attach\`.`,
          }
        : mode
          ? {
              id: "mcp-mode-env",
              level: "warn",
              detail: `MUON_MCP_MODE=${mode} is exported. A hand-started session has no runner-minted lineage, so muon-mcp will REFUSE TO START ("${mode} MCP mode requires MUON_JOB_ID lineage."). Unset it.`,
            }
          : {
              id: "mcp-mode-env",
              level: "ok",
              detail: `unset → agent tier, ${BASE_TOOL_COUNT} tools, no authority-bearing mode requested`,
            },
    resolution.ok
      ? {
          id: "muon-mcp-command",
          level: "ok",
          detail: `muon-mcp resolves to ${resolution.command} (${resolution.source})`,
        }
      : {
          id: "muon-mcp-command",
          level: "fail",
          detail: `muon-mcp is not resolvable — searched ${resolution.searched.join(", ")}. A .dmg-only install has no muon-mcp on PATH; install the MUON CLI package so both bins exist, then re-run \`muon mcp install\`.`,
        },
    ...[vendorRegistrationCheck(vendors)],
    {
      id: "tier-c-attachment",
      level: wouldGetTierC ? "warn" : tierCRequested ? "fail" : "ok",
      detail: wouldGetTierC
        ? `${tierCReason}. Forbidden remainder: set_fleet, raise_budget, apply_workflow. Never approve/merge/confirm memory.`
        : tierCReason,
    },
  ];

  return {
    brainRunning: lock !== null,
    dataDir,
    port: lock?.port ?? null,
    pid: lock?.pid ?? null,
    apiBase,
    baseSource,
    tokenSource,
    tier,
    mode,
    toolCount,
    resolvedCommand: resolution.ok ? resolution.command : null,
    resolvedCommandSource: resolution.ok ? resolution.source : null,
    vendors,
    wouldGetTierC,
    tierCReason,
    checks,
  };
}

function vendorRegistrationCheck(
  vendors: readonly McpVendorStatus[]
): McpStatusCheck {
  const installed = vendors.filter((row) => row.installed);
  if (installed.length === 0) {
    return {
      id: "vendor-registration",
      level: "fail",
      detail: `'${MUON_MCP_ENTRY_NAME}' is registered with no vendor. Run \`muon mcp install <${INSTALLABLE_VENDORS.map((s) => s.aliases[0]).join("|")}>\`.`,
    };
  }
  const broken = installed.filter(
    (row) =>
      row.commandResolves === false ||
      row.reasons.some((reason) => reason.level === "fail")
  );
  if (broken.length > 0) {
    return {
      id: "vendor-registration",
      level: "fail",
      detail: `${broken
        .map((row) => {
          const failures = row.reasons
            .filter((reason) => reason.level === "fail")
            .map((reason) => reason.id);
          return `${row.label}${failures.length > 0 ? ` (${failures.join(", ")})` : ""}`;
        })
        .join(", ")} have a failing MCP registration. Re-run \`muon mcp install <vendor>\` after correcting the named reason.`,
    };
  }
  return {
    id: "vendor-registration",
    level: "ok",
    detail: `registered with ${installed.map((row) => row.label).join(", ")}`,
  };
}

function buildVendorStatus(
  io: McpVendorIo,
  spec: InstallableVendorSpec,
  scope: McpConfigScope
): McpVendorStatus {
  const effectiveScope = spec.scopes.includes(scope) ? scope : spec.defaultScope;
  const configPath = vendorConfigPath(spec, effectiveScope, io.roots);
  const cliPath = io.which(spec.cli);
  const reading = readVendorEntry(spec, effectiveScope, io.roots);
  const reasons: McpVendorReason[] = [];

  if (!cliPath) {
    reasons.push({
      id: "vendor-cli-missing",
      level: "warn",
      detail: `'${spec.cli}' is not on PATH. MUON never installs or logs in to a vendor CLI — that is a human action. Install it, then \`muon doctor\` to check its login.`,
    });
  }

  let installed = false;
  let command: string | null = null;
  let commandResolves: boolean | null = null;
  let mode: string | null = null;
  let chatId: string | null = null;

  if (reading.kind === "unreadable") {
    reasons.push({
      id: "config-unreadable",
      level: "fail",
      detail: `${reading.reason}. MUON refuses to rewrite a config it cannot parse, so install/uninstall will refuse too.`,
    });
  } else if (reading.kind === "absent") {
    reasons.push({
      id: "not-registered",
      level: "warn",
      detail: `no '${MUON_MCP_ENTRY_NAME}' entry in ${configPath}. Run \`muon mcp install ${spec.aliases[0]}\`.`,
    });
  } else {
    installed = true;
    command = reading.command ?? null;
    mode = reading.environment.MUON_MCP_MODE ?? null;
    chatId = reading.environment.MUON_CHAT_ID ?? null;
    if (mode === ATTACHED_COORDINATOR_CAPABILITY_MODE) {
      const capabilityFile =
        reading.environment.MUON_ATTACHED_CAPABILITY_FILE ?? null;
      const capabilityRead = capabilityFile
        ? readAttachedCoordinatorCapabilityFile(capabilityFile)
        : null;
      const capabilityMatchesVendor =
        capabilityRead?.ok === true && capabilityRead.capability.vendor === spec.id;
      reasons.push({
        id: "attached-coordinator",
        level: capabilityMatchesVendor ? "warn" : "fail",
        detail: capabilityMatchesVendor
          ? `ADR-0028 Tier C attached (${ATTACHED_COORDINATOR_CAPABILITY_MODE}) — NON-HERMETIC. Capability file path is recorded; token never lives in this config. Restart ${spec.cli} to load the entry. Detach with \`muon mcp detach ${spec.aliases[0]}\`.`
          : capabilityRead?.ok
            ? `MUON_MCP_MODE=${ATTACHED_COORDINATOR_CAPABILITY_MODE} points to a capability for ${vendorLabel(capabilityRead.capability.vendor)}, not ${vendorLabel(spec.id)}. Re-run \`muon mcp attach ${spec.aliases[0]}\`.`
            : capabilityRead
            ? `MUON_MCP_MODE=${ATTACHED_COORDINATOR_CAPABILITY_MODE} points to an unusable capability file (${capabilityRead.reason}): ${capabilityRead.detail}. Re-run \`muon mcp attach ${spec.aliases[0]}\`.`
            : `MUON_MCP_MODE=${ATTACHED_COORDINATOR_CAPABILITY_MODE} without MUON_ATTACHED_CAPABILITY_FILE — re-run \`muon mcp attach ${spec.aliases[0]}\`.`,
      });
    } else if (mode !== null && mode !== "observer") {
      reasons.push({
        id: "authority-bearing-mode",
        level: "fail",
        detail: `the vendor entry requests MUON_MCP_MODE=${mode}. A human-launched install may request only base, observer, or attached-coordinator (via \`muon mcp attach\`); re-run \`muon mcp install ${spec.aliases[0]}\` to remove unexpected authority-bearing lineage.`,
      });
    }
    if (command === null) {
      reasons.push({
        id: "config-unreadable",
        level: "fail",
        detail: `the '${MUON_MCP_ENTRY_NAME}' entry in ${configPath} has no command MUON can read.`,
      });
    } else if (!path.isAbsolute(command)) {
      // A bare `muon-mcp` (what a hand-written entry or a pre-S1 doc produces)
      // is broken for a .dmg-only user, whose PATH has no muon-mcp at all.
      commandResolves = io.which(command) !== null;
      reasons.push({
        id: "command-not-absolute",
        level: commandResolves ? "warn" : "fail",
        detail: `the entry names a bare '${command}' rather than an absolute path. It resolves in THIS shell${commandResolves ? "" : " — no, it does not"}, but a vendor CLI launched from Finder inherits a bare PATH and would fail with no diagnostic. Re-run \`muon mcp install ${spec.aliases[0]}\` to record an absolute path.`,
      });
    } else {
      commandResolves = io.isExecutableFile(command);
      if (!commandResolves) {
        reasons.push({
          id: "command-path-moved",
          level: "fail",
          detail: `${command} is no longer an executable file — the app moved or updated. This fails INSIDE ${vendorLabel(spec.id)} where MUON has no diagnostic. Re-run \`muon mcp install ${spec.aliases[0]}\`.`,
        });
      }
    }
  }

  if (spec.id === "claude-code" && effectiveScope === "user") {
    // The measured trap: the vendor's own default scope is `local`, which lands
    // the entry under `projects.<cwd>` and is invisible from every other repo.
    const local = claudeLocalScopePresence(io.roots);
    if (local.present) {
      reasons.push({
        id: "scope-local-invisible-elsewhere",
        level: installed ? "warn" : "fail",
        detail: `a '${MUON_MCP_ENTRY_NAME}' entry also exists at LOCAL scope (projects.<cwd> in ~/.claude.json${local.command ? `, command ${local.command}` : ""}). Local scope is per-directory, so it is invisible from any other repo. \`muon mcp install claude\` always writes user scope; MUON does not touch the local one.`,
      });
    }
  }

  if (spec.id === "cursor" && installed) {
    reasons.push({
      id: "vendor-approval-list",
      level: "warn",
      detail: `cursor keeps its own enable/approve state outside mcp.json: if \`cursor-agent mcp list\` reports '${MUON_MCP_ENTRY_NAME}: disabled', run \`cursor-agent mcp enable ${MUON_MCP_ENTRY_NAME}\`. \`muon mcp install cursor\` runs that for you. Note cursor-agent exits 0 even when logged OUT, so its exit code proves nothing about auth.`,
    });
  }

  if (spec.id === "opencode") {
    reasons.push({
      id: "vendor-writer-unverified",
      level: "warn",
      detail:
        "opencode's own `mcp add` is interactive and MUON does not drive it. MUON writes the JSON directly; the entry shape is live-verified against opencode 1.18.7 but the vendor's writer (and therefore its migrations) is not exercised.",
    });
  }

  return {
    vendor: spec.id,
    label: vendorLabel(spec.id),
    installable: true,
    coordinatorSeat: vendorHoldsCoordinatorSeat(spec.id),
    cli: spec.cli,
    cliInstalled: cliPath !== null,
    cliPath,
    scope: effectiveScope,
    scopes: spec.scopes,
    configPath,
    writer: spec.writerKind,
    verifiedAt: spec.verifiedAt,
    installed,
    command,
    commandResolves,
    mode,
    chatId,
    reasons,
    notes: spec.notes,
  };
}

/** The check ids a built report actually carried — the drift-lock read side. */
export function mcpStatusCheckIds(
  report: McpStatusReport
): readonly McpStatusCheckId[] {
  return report.checks.map((check) => check.id);
}
