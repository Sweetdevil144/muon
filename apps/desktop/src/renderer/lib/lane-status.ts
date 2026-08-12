import type { AgentRecord, VendorReadiness } from "@muon/client";
import { vendorRoleScope, type VendorRoleScope } from "@muon/client/onboarding";
import { coordinatorVendorIds, vendorLabel } from "@muon/client/vendors";
import type { ReadinessSnapshotMeta } from "../../shared/ipc.js";
import { formatCostOrdinalLabel } from "./cost-ordinal-label.js";

/**
 * The ONE projection of "what is this crew lane's situation right now".
 *
 * Crew, the Doctor strip and the titlebar Status control all render from this,
 * so they cannot disagree about a lane the way they used to: the Crew sidebar's
 * own chip collapsed an UNKNOWN probe ("the auth check could not run") into
 * "setup needed", while the Doctor's chip — reading the same field — correctly
 * showed "unknown". Those need different actions from the human, so they are
 * different states here and nowhere else.
 *
 * ## Why exit codes are never consulted
 *
 * `cursor-agent status` EXITS 0 WHETHER OR NOT ANYONE IS LOGGED IN, and
 * `opencode auth list` does the same. The probe layer already refuses to infer
 * auth from a status code (it requires an explicit "logged in" phrase, or a
 * credential COUNT), so this module reads only the interpreted verdict —
 * `authenticated` and `authState` — and never anything status-code shaped. A
 * lane can therefore never render "ready" on the strength of a zero exit.
 */

/**
 * A lane's situation, in the order of "how much does this block the human".
 * Each state maps to a DIFFERENT next action, which is the whole point of
 * keeping them apart.
 */
export type LaneState =
  /** No probe result yet — a probe is running. Not a verdict. */
  | "checking"
  /** The probe has never landed and none is running. Not a verdict either. */
  | "unchecked"
  /** The CLI is not on PATH. Action: install it. */
  | "missing"
  /** Installed, explicitly NOT logged in. Action: run the vendor's login. */
  | "signed-out"
  /** Installed, an explicitly selected provider has no usable credential. */
  | "provider-unconfigured"
  /** Installed, but the auth probe could not RUN. Action: re-check. Never "signed out". */
  | "unknown"
  /** Authenticated through the vendor's own login. */
  | "ready"
  /** Authenticated through an API key / custom provider (BYOK). */
  | "ready-byok";

/** Quiet-UI tone. Maps to the existing --status-* tokens, no new palette. */
export type LaneTone = "ready" | "warn" | "danger" | "idle";

export type LaneStatus = {
  vendor: string;
  label: string;
  state: LaneState;
  tone: LaneTone;
  /** Two or three words for the chip beside the lane name. */
  chip: string;
  /** The probe's own sentence, or an honest stand-in when there is no probe. */
  detail: string;
  /**
   * The exact next thing the human does. Null when there is nothing to do.
   * Comes from the probe's `fixHint` (the real command) wherever one exists —
   * this module never invents a command.
   */
  action: string | null;
  /** True while this lane cannot take work. Drives the "needs you" counts. */
  needsAttention: boolean;
  /** Settled enough to state a verdict at all (`checking`/`unchecked` are not). */
  known: boolean;
  /** What the lane is FOR, from the role model — never a hardcoded vendor test. */
  roleScope: VendorRoleScope;
  /** May this lane hold the coordinator seat? (claude-code and codex only.) */
  coordinatorEligible: boolean;
  /** Configured seats for this lane (0–3). */
  count: number;
  /** Seats currently executing work. */
  working: number;
  /** CLI version fingerprint when the probe captured one. Never a secret. */
  version: string | null;
  /** Relative cost ordinal for provider selection (TODO 3.11). */
  costLabel: string | null;
};

const CHIP: Record<LaneState, string> = {
  checking: "checking",
  unchecked: "not checked",
  missing: "not installed",
  "signed-out": "signed out",
  "provider-unconfigured": "provider not configured",
  unknown: "check failed",
  ready: "ready",
  "ready-byok": "ready · BYOK",
};

const TONE: Record<LaneState, LaneTone> = {
  checking: "idle",
  unchecked: "idle",
  // Not installed is a flat absence, not a failure — the human simply has not
  // added this lane. Amber, not red.
  missing: "warn",
  "signed-out": "warn",
  "provider-unconfigured": "warn",
  // A probe that could not run is the one genuinely alarming case: MUON does
  // not know, and silence here is what lets a dispatch die deep in the runner.
  unknown: "danger",
  ready: "ready",
  "ready-byok": "ready",
};

/**
 * Resolve the lane state from the probe verdict alone.
 *
 * `authState` is the machine-stable field; `authenticated` is the fallback for
 * payloads written before it existed. Neither is derived from an exit code.
 */
function laneStateOf(readiness: VendorReadiness | undefined): LaneState {
  if (!readiness) return "unchecked";
  if (readiness.authenticated) {
    return readiness.credentialMethod && readiness.credentialMethod !== "vendor-login"
      ? "ready-byok"
      : "ready";
  }
  if (!readiness.installed) return "missing";
  if (readiness.authState === "unknown") return "unknown";
  if (readiness.authState === "provider-unconfigured") {
    return "provider-unconfigured";
  }
  return "signed-out";
}

function detailFor(
  state: LaneState,
  readiness: VendorReadiness | undefined,
  label: string
): string {
  if (readiness) return readiness.detail;
  return state === "checking"
    ? `Checking whether ${label} is installed and signed in…`
    : `${label} has not been checked yet.`;
}

export function buildLaneStatus(input: {
  vendor: string;
  readiness?: VendorReadiness;
  /** Freshness of the readiness evidence, so an absent probe reads honestly. */
  meta?: ReadinessSnapshotMeta;
  count?: number;
  agents?: AgentRecord[];
  costOrdinal?: number;
  costNotice?: string;
}): LaneStatus {
  const roleScope = vendorRoleScope(input.vendor);
  const label = roleScope.label || vendorLabel(input.vendor);
  const probing =
    input.meta?.state === "probing" || input.meta?.state === "refreshing";
  // With no row for this vendor, the honest answer depends on whether a probe
  // is in flight — "checking" while one runs, "not checked" when none is.
  const state = input.readiness
    ? laneStateOf(input.readiness)
    : probing
      ? "checking"
      : "unchecked";
  const known = state !== "checking" && state !== "unchecked";
  const agents = input.agents ?? [];

  return {
    vendor: input.vendor,
    label,
    state,
    tone: TONE[state],
    chip:
      state === "ready" && roleScope.scoped
        ? "ready · role-scoped"
        : state === "ready-byok" && roleScope.scoped
          ? "ready · BYOK · role-scoped"
          : CHIP[state],
    detail: detailFor(state, input.readiness, label),
    // The probe's own hint carries the REAL command (`codex login`,
    // `cursor-agent login`, the install one-liner). Only fall back to prose
    // when the probe gave none, and never for a lane that is fine.
    action:
      state === "ready" || state === "ready-byok"
        ? null
        : (input.readiness?.fixHint ??
          (state === "unknown"
            ? `Re-check providers. If it stays unresolved, run ${label}'s own status command in a terminal.`
            : state === "checking" || state === "unchecked"
              ? null
              : `Finish ${label} setup in its own CLI, then re-check.`)),
    needsAttention: known && state !== "ready" && state !== "ready-byok",
    known,
    roleScope,
    coordinatorEligible: (coordinatorVendorIds() as readonly string[]).includes(
      input.vendor
    ),
    count: input.count ?? 0,
    working: agents.filter((agent) => agent.status === "working").length,
    version: input.readiness?.cliVersion ?? null,
    costLabel:
      input.costOrdinal !== undefined
        ? formatCostOrdinalLabel(input.costOrdinal, input.costNotice)
        : null,
  };
}

/**
 * Build every lane in one pass.
 *
 * `vendors` is the registry projection (`fleetVendorIds()`), NEVER the probe
 * response — so a lane the operator can size always has a row even before its
 * first probe lands, and a vendor the registry has RETIRED (Ollama, removed as
 * a lane) can never reappear here just because some cached payload still
 * mentions it.
 */
export function buildLaneStatuses(input: {
  vendors: readonly string[];
  readiness: VendorReadiness[] | null | undefined;
  meta?: ReadinessSnapshotMeta;
  counts?: Partial<Record<string, number>>;
  agents?: AgentRecord[];
}): LaneStatus[] {
  return input.vendors.map((vendor) =>
    buildLaneStatus({
      vendor,
      readiness: input.readiness?.find((entry) => entry.vendor === vendor),
      meta: input.meta,
      count: input.counts?.[vendor] ?? 0,
      agents: (input.agents ?? []).filter(
        (agent) => agent.vendor === vendor && agent.ordinal >= 1
      ),
    })
  );
}

/** Headline numbers for the Crew/Doctor summary strip. */
export function summarizeLanes(lanes: LaneStatus[]): {
  ready: number;
  needsAttention: number;
  checking: number;
  seats: number;
  working: number;
  /** At least one lane that can take UNPLANNED work is ready. */
  canDispatch: boolean;
} {
  return {
    ready: lanes.filter((lane) => !lane.needsAttention && lane.known).length,
    needsAttention: lanes.filter((lane) => lane.needsAttention).length,
    checking: lanes.filter((lane) => !lane.known).length,
    seats: lanes.reduce((total, lane) => total + lane.count, 0),
    working: lanes.reduce((total, lane) => total + lane.working, 0),
    // Role-aware, exactly like the backend's `anyVendorReady`: a ready lane
    // whose whole ceiling is read-only (OpenCode holds `scout` only) cannot on
    // its own make the app dispatch-capable.
    canDispatch: lanes.some(
      (lane) =>
        lane.known &&
        !lane.needsAttention &&
        lane.roleScope.takesUnplannedWork
    ),
  };
}

/** "just now" / "12s ago" / "4m ago" — the freshness label beside the lanes. */
export function freshnessLabel(meta: ReadinessSnapshotMeta | undefined): string {
  if (!meta) return "";
  if (meta.state === "probing") return "Checking providers…";
  if (meta.state === "unknown") return "Providers not checked yet";
  const age = meta.ageMs ?? 0;
  const ago =
    age < 5_000
      ? "just now"
      : age < 60_000
        ? `${Math.floor(age / 1000)}s ago`
        : age < 3_600_000
          ? `${Math.floor(age / 60_000)}m ago`
          : `${Math.floor(age / 3_600_000)}h ago`;
  if (meta.state === "refreshing") return `Re-checking · last checked ${ago}`;
  if (meta.state === "stale") return `Last checked ${ago} · refresh stalled`;
  return `Checked ${ago}`;
}
