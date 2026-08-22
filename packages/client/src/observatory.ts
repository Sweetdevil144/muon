import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES,
  MUON_CONTEXT_TOOL_NAMES,
  MUON_CONTROL_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES,
  MUON_DELEGATE_TOOL_NAMES,
  MUON_OBSERVER_TOOL_NAMES,
} from "@muon/protocol";
import {
  createObservatoryUploader,
  OBSERVATORY_UPLOAD_PROVIDER,
} from "./observatory-upload.js";

/**
 * P0-5 — the Observatory, local half.
 *
 * What ships here: a bounded event vocabulary, a consent gate, and a local
 * 0600 spool.
 *
 * HISTORY, because this docstring was wrong for a while and the wrongness was
 * the point of the field below: it used to say "What deliberately does NOT
 * ship: any uploader … MUON has no telemetry endpoint at all". ADR-0031 then
 * landed `observatory-upload.ts`, a real consent-gated PostHog uploader — and
 * this module went on stamping `provider: "none"` on every spooled record.
 * That made the audit artifact contradict the actual destination, which is the
 * one thing an audit artifact may never do.
 *
 * `OBSERVATORY_PROVIDER` now names the CONFIGURED destination, read from the
 * uploader itself so there is one truth rather than two constants. It is not a
 * statement that any given record left the machine: egress still requires
 * `settings.telemetryEnabled`, and the `MUON_OBSERVATORY_SPOOL` audit override
 * records locally while uploading nothing.
 *
 * The spool exists for two reasons:
 *  1. It IS the launch-checklist audit artifact (§11.2: "capture the final
 *     payload locally and audit every field before production enablement") —
 *     the exact bytes a future uploader would send, inspectable today.
 *  2. Crash records are useful to the OPERATOR locally (support requests)
 *     even with no telemetry at all.
 *
 * PRIVACY BY SHAPE, not by review: no event carries a free-text field. Every
 * field is an enum from this file, a number, a boolean, or the app version.
 * There is nowhere to put a path, a prompt, a repo name, or a token — a new
 * field means editing the positive vocabulary below, which is the review
 * point. (§11.2's forbidden list is satisfied structurally.)
 */

export const OBSERVATORY_PROVIDER = OBSERVATORY_UPLOAD_PROVIDER;

/** Bumped ONLY when an event's shape changes; stamped on every record so a
 *  future uploader (and today's local summary) can trust what it parses.
 *  v2 (2026-08-23): the surface events — identity.gate_passed/gate_refused
 *  and mcp.tool_call — joined the vocabulary (ADR-0095). */
export const OBSERVATORY_SCHEMA_VERSION = 2 as const;

/** Coarse crash reasons — Electron's `render-process-gone` reasons collapsed
 *  to a closed set so the field can never smuggle prose. */
export const CRASH_REASONS = [
  "crashed",
  "oom",
  "killed",
  "launch-failed",
  "integrity-failure",
  "clean-exit",
  "abnormal-exit",
  "unknown",
] as const;
export type CrashReason = (typeof CRASH_REASONS)[number];

export function coarseCrashReason(raw: string | undefined): CrashReason {
  const value = (raw ?? "").trim().toLowerCase();
  return (CRASH_REASONS as readonly string[]).includes(value)
    ? (value as CrashReason)
    : "unknown";
}

/** The three distributed surfaces the identity gate runs on (ADR-0052 sites). */
export const GATE_SURFACES = ["desktop", "cli", "mcp"] as const;
export type GateSurface = (typeof GATE_SURFACES)[number];

/** Why a gate refused, collapsed to a closed set — an errno, proxy banner, or
 *  server message must never ride this field as prose. */
export const GATE_REFUSAL_REASONS = [
  "unregistered",
  "expired",
  "network",
  "unknown",
] as const;
export type GateRefusalReason = (typeof GATE_REFUSAL_REASONS)[number];

export function coarseGateRefusal(raw: string | undefined): GateRefusalReason {
  const value = (raw ?? "").trim().toLowerCase();
  return (GATE_REFUSAL_REASONS as readonly string[]).includes(value)
    ? (value as GateRefusalReason)
    : "unknown";
}

/** Coordinators that attach over MCP, collapsed to the governed vendor set. */
export const MCP_CLIENTS = [
  "claude-code",
  "cursor",
  "codex",
  "opencode",
  "other",
] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export function coarseMcpClient(raw: string | undefined): McpClient {
  const value = (raw ?? "").trim().toLowerCase();
  // Exact first, then vendor-token containment: real `clientInfo.name` strings
  // are "Claude Code", "cursor-agent 1.2", "codex-cli" — the token is in
  // there, the exact spelling is not. Containment still lands on the closed
  // set, never on the raw string.
  if (value !== "other" && (MCP_CLIENTS as readonly string[]).includes(value)) {
    return value as McpClient;
  }
  if (value.includes("claude")) return "claude-code";
  if (value.includes("opencode")) return "opencode";
  if (value.includes("cursor")) return "cursor";
  if (value.includes("codex")) return "codex";
  return "other";
}

/**
 * WHAT occasioned a gate verdict — the reviewer's finding on the first draft:
 * without this, "gate_refused by surface" compared three incomparable
 * denominators (one per launch on the desktop, one per command on the CLI,
 * one per tool call on MCP) under one event name. The trigger names the
 * denominator so the comparison is honest.
 */
export const GATE_TRIGGERS = [
  "launch", // desktop boot verdict
  "signin", // desktop mid-run gate-open transition
  "command", // one CLI run
  "session", // one MCP session's first admitted call
  "tool_call", // one refused MCP tools/call
] as const;
export type GateTrigger = (typeof GATE_TRIGGERS)[number];

/** The VALID surface × trigger pairs, as a discriminated union — so a CLI
 *  "launch" or a desktop "tool_call" is a type error, not a nonsense row.
 *  Each surface owns exactly the denominators it can honestly count under. */
export type GateCoordinate =
  | { surface: "desktop"; trigger: "launch" | "signin" }
  | { surface: "cli"; trigger: "command" }
  | { surface: "mcp"; trigger: "session" | "tool_call" };

/** How an MCP tool call ended, as a closed set — never the error message. */
export const MCP_TOOL_ERRORS = ["none", "timeout", "refused", "unknown"] as const;
export type McpToolError = (typeof MCP_TOOL_ERRORS)[number];

export function coarseMcpToolError(raw: string | undefined): McpToolError {
  const value = (raw ?? "").trim().toLowerCase();
  return (MCP_TOOL_ERRORS as readonly string[]).includes(value)
    ? (value as McpToolError)
    : "unknown";
}

/**
 * The governed tool inventory, as a POSITIVE union of every tier's named list
 * (tier-derivation rule: unions only, never subtraction). Used at RECORD time
 * to coerce, so a tool added to the inventory later simply starts being
 * admitted — already-spooled rows are never revalidated against this set.
 * Any name outside it (hostile, misspelled, or future) lands as "other",
 * never as free text.
 */
const MCP_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  ...MUON_CONTEXT_TOOL_NAMES,
  ...MUON_COORDINATION_TOOL_NAMES,
  ...MUON_CONTROL_TOOL_NAMES,
  ...MUON_OBSERVER_TOOL_NAMES,
  ...MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES,
  ...MUON_DELEGATE_TOOL_NAMES,
]);

/** The same union at the TYPE level, so the event field itself refuses free
 *  text — a caller cannot spool an arbitrary string even by skipping the
 *  coercer (cubic's finding on the first draft of this file). */
export type McpToolName =
  | (typeof MUON_CONTEXT_TOOL_NAMES)[number]
  | (typeof MUON_COORDINATION_TOOL_NAMES)[number]
  | (typeof MUON_CONTROL_TOOL_NAMES)[number]
  | (typeof MUON_OBSERVER_TOOL_NAMES)[number]
  | (typeof MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES)[number]
  | (typeof MUON_DELEGATE_TOOL_NAMES)[number];
export type McpObservedTool = McpToolName | "other";

export function coarseMcpTool(raw: string | undefined): McpObservedTool {
  const value = (raw ?? "").trim();
  return MCP_TOOL_ALLOWLIST.has(value) ? (value as McpToolName) : "other";
}

/** The WHOLE event vocabulary. Adding an event = adding a branch here. */
export type ObservatoryEvent =
  | { name: "app.launch"; coldStartMs?: number }
  | { name: "app.crash.renderer"; reason: CrashReason }
  | { name: "app.crash.main"; reason: "uncaught-exception" }
  | { name: "update.check"; updateAvailable: boolean }
  | { name: "update.applied" }
  // Consent lifecycle: granted lands as the FIRST row of a consenting spool.
  // (Revocation cannot land — a disabled spool records nothing — so absence
  // after a granted row IS the revocation record.)
  | { name: "consent.granted" }
  // Activation funnel: each fires at most ONCE per profile, ever.
  | { name: "funnel.first_vendor_ready" }
  | { name: "funnel.first_chat" }
  | { name: "funnel.first_dispatch" }
  | { name: "funnel.first_merge" }
  // v2 surface events (ADR-0095). The 0052 rule holds structurally: no field
  // here CAN carry an identity coordinate — not the token, not the login, not
  // the id, and not a digest of the id (GitHub's small sequential id space
  // makes any unsalted digest reversible, so a digest IS the id). A gate event
  // says only that A gate on SOME surface passed or refused, and why, coarsely.
  | ({ name: "identity.gate_passed" } & GateCoordinate)
  | ({ name: "identity.gate_refused"; reason: GateRefusalReason } & GateCoordinate)
  // Tool USAGE, never tool CONTENT: the coerced tool name, how long, how it
  // ended, which vendor's coordinator called — no arguments, no results.
  | { name: "mcp.tool_call"; tool: McpObservedTool; durationMs: number; error: McpToolError; client: McpClient };

const FUNNEL_EVENTS = new Set([
  "funnel.first_vendor_ready",
  "funnel.first_chat",
  "funnel.first_dispatch",
  "funnel.first_merge",
]);

/** What actually lands in the spool: the event + bounded build coordinates. */
export type ObservatoryRecord = ObservatoryEvent & {
  at: string;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  provider: typeof OBSERVATORY_PROVIDER;
  schema: typeof OBSERVATORY_SCHEMA_VERSION;
};

const SPOOL_MAX_BYTES = 512 * 1024;

export type ObservatoryOptions = {
  /** The profile's userData dir; the spool lives under `<dataDir>/observatory`. */
  dataDir: string;
  appVersion: string;
  /** Consent, read LIVE per event: `settings.telemetryEnabled` (default OFF)
   *  or the MUON_OBSERVATORY_SPOOL=1 audit override. OFF → record() is a
   *  complete no-op: no directory, no file, no bytes. */
  enabled: () => boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => Date;
  /** ADR-0031: called AFTER a row lands in the local spool (the uploader's
   *  tap). Consent was already checked by `enabled()`; the hook must never
   *  throw into record(). */
  onRecord?: (row: ObservatoryRecord) => void;
};

export type Observatory = {
  /** Append one event to the local spool (no-op without consent). Never
   *  throws: diagnostics loss must never break the app. */
  record(event: ObservatoryEvent): void;
  /** The spool path, for the Settings surface to name honestly. */
  spoolPath: string;
};

export function createObservatory(options: ObservatoryOptions): Observatory {
  const dir = join(options.dataDir, "observatory");
  const spoolPath = join(dir, "spool.jsonl");
  const milestonesPath = join(dir, "milestones.json");

  // Loaded from disk ONCE (lazily), then kept in the closure: the funnel
  // hooks sit on the 2s state poll, and re-reading the file per record meant
  // three synchronous reads every tick once consent was on.
  let milestones: Record<string, string> | null = null;
  const loadMilestones = (): Record<string, string> => {
    if (milestones) return milestones;
    try {
      const parsed = JSON.parse(readFileSync(milestonesPath, "utf8")) as unknown;
      milestones =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {};
    } catch {
      milestones = {};
    }
    return milestones;
  };

  const record = (event: ObservatoryEvent): void => {
    try {
      if (!options.enabled()) return;
      if (FUNNEL_EVENTS.has(event.name)) {
        const known = loadMilestones();
        if (known[event.name]) return; // once per profile, ever
        known[event.name] = (options.now?.() ?? new Date()).toISOString();
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(milestonesPath, JSON.stringify(known, null, 2), {
          mode: 0o600,
        });
      }
      const row: ObservatoryRecord = {
        ...event,
        at: (options.now?.() ?? new Date()).toISOString(),
        appVersion: options.appVersion,
        platform: options.platform ?? process.platform,
        arch: options.arch ?? process.arch,
        provider: OBSERVATORY_PROVIDER,
        schema: OBSERVATORY_SCHEMA_VERSION,
      };
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Size cap: one rotation generation is plenty for an audit artifact.
      try {
        if (statSync(spoolPath).size > SPOOL_MAX_BYTES) {
          renameSync(spoolPath, `${spoolPath}.1`);
        }
      } catch {
        /* no spool yet */
      }
      appendFileSync(spoolPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      options.onRecord?.(row);
    } catch {
      // Diagnostics loss is never app breakage.
    }
  };

  return { record, spoolPath };
}

// ---------------------------------------------------------------------------
// Local analytics (F3): aggregate the spool into counts + the funnel, for the
// Settings surface. COUNTS AND TIMESTAMPS ONLY — the summary never carries an
// event row through, so it cannot leak more than the shape-bounded spool
// itself. Reads both rotation generations; tolerates a torn/partial line.
// ---------------------------------------------------------------------------

export type ObservatorySummary = {
  schema: typeof OBSERVATORY_SCHEMA_VERSION;
  provider: typeof OBSERVATORY_PROVIDER;
  spoolBytes: number;
  launches: number;
  crashes: Partial<Record<CrashReason | "uncaught-exception", number>>;
  updateChecks: number;
  updatesApplied: number;
  consentGrantedAt?: string;
  /** v2 surface events (ADR-0095). The audit view must count everything the
   *  spool holds — a summary that under-reports is the audit lying. */
  gatePassed: number;
  gateRefused: number;
  mcpToolCalls: number;
  funnel: {
    first_vendor_ready?: string;
    first_chat?: string;
    first_dispatch?: string;
    first_merge?: string;
  };
};

export function summarizeObservatory(dataDir: string): ObservatorySummary {
  const dir = join(dataDir, "observatory");
  const summary: ObservatorySummary = {
    schema: OBSERVATORY_SCHEMA_VERSION,
    provider: OBSERVATORY_PROVIDER,
    spoolBytes: 0,
    launches: 0,
    crashes: {},
    updateChecks: 0,
    updatesApplied: 0,
    gatePassed: 0,
    gateRefused: 0,
    mcpToolCalls: 0,
    funnel: {},
  };
  for (const file of ["spool.jsonl.1", "spool.jsonl"]) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    summary.spoolBytes += Buffer.byteLength(text);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: Partial<ObservatoryRecord>;
      try {
        row = JSON.parse(line) as Partial<ObservatoryRecord>;
      } catch {
        continue; // torn tail line from a crash mid-append
      }
      switch (row.name) {
        case "app.launch":
          summary.launches += 1;
          break;
        case "app.crash.renderer":
        case "app.crash.main": {
          const reason = (row as { reason?: string }).reason ?? "unknown";
          const key = reason as keyof ObservatorySummary["crashes"];
          summary.crashes[key] = (summary.crashes[key] ?? 0) + 1;
          break;
        }
        case "update.check":
          summary.updateChecks += 1;
          break;
        case "update.applied":
          summary.updatesApplied += 1;
          break;
        case "consent.granted":
          summary.consentGrantedAt ??= row.at;
          break;
        case "identity.gate_passed":
          summary.gatePassed += 1;
          break;
        case "identity.gate_refused":
          summary.gateRefused += 1;
          break;
        case "mcp.tool_call":
          summary.mcpToolCalls += 1;
          break;
        default:
          break;
      }
    }
  }
  try {
    const milestones = JSON.parse(
      readFileSync(join(dir, "milestones.json"), "utf8")
    ) as Record<string, string>;
    summary.funnel = {
      first_vendor_ready: milestones["funnel.first_vendor_ready"],
      first_chat: milestones["funnel.first_chat"],
      first_dispatch: milestones["funnel.first_dispatch"],
      first_merge: milestones["funnel.first_merge"],
    };
  } catch {
    /* no milestones yet */
  }
  return summary;
}

/** The machine-wide consent read, resolved from the ONE profile (ADR-0050). */
export interface ObservatoryConsent {
  enabled: boolean;
  deviceId: string | null;
}

/**
 * Read telemetry consent from the shared profile's `settings.json` — the SAME
 * file the desktop settings page writes — so the CLI and muon-mcp honor the
 * one toggle instead of growing their own (ADR-0095 D2). Reads ONLY the two
 * telemetry fields; everything else in the file is none of this module's
 * business. Fails toward OFF on every malformation: absent file, torn JSON,
 * non-boolean consent, non-string device id — a surface that cannot prove
 * consent records nothing.
 */
export function readObservatoryConsent(dataDir: string): ObservatoryConsent {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dataDir, "settings.json"), "utf8")
    ) as { telemetryEnabled?: unknown; telemetryDeviceId?: unknown };
    if (parsed === null || typeof parsed !== "object") {
      return { enabled: false, deviceId: null };
    }
    const enabled = parsed.telemetryEnabled === true;
    // The device id becomes the wire distinct_id verbatim, which makes it the
    // one string-shaped hole in privacy-by-shape — so its SHAPE is enforced
    // here: UUID-class characters only, bounded length. A hand-edited value
    // that fails the guard is no id, and no id means no egress.
    const deviceId =
      typeof parsed.telemetryDeviceId === "string" &&
      /^[\w.+-]{1,64}$/.test(parsed.telemetryDeviceId)
        ? parsed.telemetryDeviceId
        : null;
    // Consent without an id still spools locally, but the uploader requires
    // BOTH (no id → no distinct_id → nothing leaves the machine).
    return { enabled, deviceId };
  } catch {
    return { enabled: false, deviceId: null };
  }
}

/**
 * The coarse refusal reason for a CLOSED 0052 gate state. Honest by design:
 * `locked` covers never-signed-in AND signed-out/expired — the state machine
 * cannot tell them apart (an expired credential reports plain `locked`), so
 * this mapper says "unregistered" for both rather than pretending to know.
 * "expired"/"network" stay in the enum for surfaces that DO know (none today).
 */
export function gateRefusalReasonForState(state: string): GateRefusalReason {
  switch (state) {
    case "locked":
    case "locked-unregistered":
      return "unregistered";
    default:
      return "unknown";
  }
}

/**
 * ADR-0095 D2 — the ONE construction the non-desktop surfaces (CLI, muon-mcp)
 * share: consent read live from the shared profile's `settings.json` (the
 * SAME toggle the desktop settings page writes), the same spool, the same
 * uploader. The desktop wires its own instances because it owns the live
 * settings object and the consent-revoke `discard()` epoch; everything else
 * goes through here so a fourth surface cannot invent a second consent story.
 *
 * `MUON_OBSERVATORY_SPOOL=1` spools locally without consent (the ADR-0031
 * audit override) — the UPLOADER still reads consent alone, so that override
 * can never cause egress.
 */
export function createSurfaceObservatory(options: {
  dataDir: string;
  appVersion: string;
  /** Injected in tests; defaults to global fetch. */
  fetcher?: typeof fetch;
  now?: () => Date;
}): {
  observatory: Observatory;
  /** Best-effort egress drain — callers on short-lived processes (the CLI)
   *  should bound it with a timeout race rather than block a command on it. */
  flush: () => Promise<void>;
  /** Cancels the uploader's flush timer. A one-shot caller (the CLI) calls
   *  this after its bounded flush so nothing lingers for the rest of the
   *  command process; a long-lived surface (muon-mcp) never does — the
   *  interval IS its egress cadence. */
  stop: () => void;
} {
  // ONE cached consent read shared by the spool gate and the uploader, keyed
  // on settings.json's mtime: `record()` runs synchronously inside hot paths
  // (the MCP tools/call handler), and the first draft re-read + re-parsed the
  // full settings.json up to four times per tool call (reviewer F5). An
  // mtime key — one stat per check — keeps the cache AND makes a desktop
  // revoke take effect at the very next record/flush, so the settings UI's
  // "stops uploads immediately" holds on every surface (cubic's follow-up
  // to a first-draft 2s TTL, under which it did not).
  const settingsPath = join(options.dataDir, "settings.json");
  let cachedConsent: ObservatoryConsent | undefined;
  // Composite (mtimeMs:size) key — two same-instant writes would also need
  // identical byte length to collide, and a revoke write (id key removed)
  // and a re-grant write (fresh UUID) differ in both.
  let cachedStamp: string | undefined;
  // The revocation EPOCH, observed through the device id: the desktop clears
  // it on revoke and mints a fresh UUID on re-grant, so a changed id means a
  // consent boundary was crossed while rows sat in the buffer. Those rows
  // belong to the OLD epoch and must never ship under the new one (reviewer
  // F2 — the same hole the desktop's `discard()` closes, which a long-lived
  // `muon-mcp` process was re-opening).
  let epochDeviceId: string | null | undefined;
  const consent = () => {
    let stamp: string | undefined;
    try {
      const stat = statSync(settingsPath);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      stamp = undefined; // absent file: OFF, and cheap to keep asking
    }
    if (!cachedConsent || stamp === undefined || stamp !== cachedStamp) {
      cachedConsent = readObservatoryConsent(options.dataDir);
      cachedStamp = stamp;
      if (
        epochDeviceId !== undefined &&
        cachedConsent.deviceId !== epochDeviceId
      ) {
        uploader.discard();
      }
      epochDeviceId = cachedConsent.deviceId;
    }
    return cachedConsent;
  };
  const uploader = createObservatoryUploader({
    enabled: () => consent().enabled,
    deviceId: () => consent().deviceId,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  const observatory = createObservatory({
    dataDir: options.dataDir,
    appVersion: options.appVersion,
    enabled: () =>
      consent().enabled || process.env.MUON_OBSERVATORY_SPOOL?.trim() === "1",
    onRecord: (row) => uploader.enqueue(row),
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    observatory,
    flush: () => uploader.flush(),
    stop: () => uploader.stop(),
  };
}
