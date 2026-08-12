import {
  AGENT_ROLES,
  ROLE_SPECS,
  VENDOR_REGISTRY,
  fleetVendorIds,
  isVendorId,
  vendorLabel,
  type AgentRole,
  type VendorConnectKind,
} from "@muon/protocol";
import type { VendorReadiness } from "./types.js";
// The ONE browser-safe mirror of each lane's declared crew roles (drift-locked
// against the adapters' `supportedRoles` in packages/mcp tests). Importing it
// here rather than restating "cursor is special" is the whole point: the copy
// below is DERIVED from the role model, so a lane whose roles change cannot end
// up described by stale prose.
//
// This is a deliberate module cycle (capability-preflight imports this module
// for the step machine). It is safe because neither side touches the other at
// module-evaluation time — every use is inside a function — and it is preferable
// to a second hand-maintained vendor→roles table.
import { VENDOR_DISPATCH_ROLES } from "./capability-preflight.js";

// Re-exported so browser-bundled surfaces (the Electron renderer) can pull the
// readiness type AND the state machine from this one pure, node-free module,
// never the package index (which reaches node built-ins via paths/config).
export type { VendorReadiness } from "./types.js";

/**
 * The shared vendor-onboarding state machine (P2b).
 *
 * The readiness DETECTION backend (P2a) answers, per vendor, "is the CLI
 * installed?" and "does MUON have positive evidence that it can
 * authenticate?" (`GET /api/fleet/readiness`). This module turns that raw truth
 * into the guided onboarding step + copy that ALL three surfaces (desktop
 * wizard, CLI `onboard`, TUI panel) render, so they can never drift. It is a
 * PURE function of the readiness array, no I/O, no node built-ins, so the
 * Electron renderer can bundle it too.
 *
 * INVARIANT, MUON never custodies a vendor credential. Onboarding only reads
 * readiness metadata + fixed setup guidance. It never receives, stores, logs,
 * proxies, or displays a credential value.
 */

/** The vendors MUON can drive, in a stable order. Mirrors the fleet vendors. */
export const ONBOARDING_VENDORS = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
] as const;

/**
 * Display labels for each vendor lane key.
 *
 * WAVE D: projected from the registry rather than hand-written. Kept as an
 * exported map because callers index it, but it is no longer a second statement
 * of what a vendor is called — `vendorLabel(id)` is, and this is that.
 */
export const ONBOARDING_VENDOR_LABELS: Record<string, string> =
  Object.fromEntries(fleetVendorIds().map((id) => [id, vendorLabel(id)]));

/**
 * How a user CONNECTS a lane. Copy-only — it never grants or withholds
 * anything; the exact command always comes verbatim from the readiness probe's
 * `fixHint`.
 *
 * `local-runtime` exists for a lane with NO account, where telling the user to
 * "sign in or configure provider credentials" would send them looking for a
 * login screen that does not exist. Removing the Ollama lane left that table
 * with zero entries, so it is READ FROM THE REGISTRY now rather than kept as an
 * empty hand-written copy — one fewer place for a vendor to be described twice
 * (ADR-0022 §3.2). An unknown id falls back to "account", which is the honest
 * answer for a lane MUON cannot look up: it is what every vendor MUON drives
 * today needs.
 */
function connectKind(vendor: string): VendorConnectKind {
  return isVendorId(vendor)
    ? VENDOR_REGISTRY[vendor].readiness.connectKind
    : "account";
}

/**
 * The trust signal shown on every onboarding surface. It is a differentiator:
 * MUON drives the user's OWN vendor CLI and its OWN login. Detection is
 * read-only (the CLI's own status probe), MUON never reads, stores, proxies,
 * or captures a vendor token.
 */
export const NEVER_STORES_TOKEN_NOTICE =
  "MUON never stores, logs, or displays vendor credentials. Logins stay inside each vendor CLI; for configured providers, MUON passes only the selected credential variable to the selected vendor process.";

/**
 * Generic manual steps shown ONLY when the readiness probe itself is
 * unavailable (backend/route down). We degrade to honest, self-service
 * guidance rather than claiming a vendor is (or isn't) ready.
 */
export const MANUAL_CONNECT_STEPS = [
  "Install a coding-agent CLI: Claude Code (`npm i -g @anthropic-ai/claude-code`), Codex (`npm i -g @openai/codex`), or Cursor (`curl https://cursor.com/install -fsS | bash`).",
  "Sign in with that CLI's own command, or configure its supported API-key/provider credentials.",
  "Optional, read-only reconnaissance: install OpenCode (`curl -fsSL https://opencode.ai/install | bash`) and run `opencode auth login`. MUON drives it under a deny-first permission config, so it can read the repo but never edit it or run a shell.",
  "Re-check readiness, MUON detects usable credential evidence and unlocks your first task.",
];

/**
 * The role an un-planned dispatch resolves to (the backend's
 * `resolveDispatchRole` last-resort, mirrored by the capability preflight). It
 * is the honest answer to "can this lane take work a user hasn't planned yet",
 * which is exactly the question first-run onboarding asks.
 */
const UNPLANNED_DISPATCH_ROLE: AgentRole = "implementer";

/** What a lane is FOR, derived from the role model — never from a vendor name. */
export type VendorRoleScope = {
  vendor: string;
  label: string;
  /** Crew roles this lane may hold; all of them when the lane is unscoped. */
  roles: AgentRole[];
  /** False when this lane cannot hold the role an un-planned dispatch takes. */
  takesUnplannedWork: boolean;
  /** True when every role it may hold is read-only authority. */
  readOnly: boolean;
  /** True when this lane is managed for only PART of the role taxonomy. */
  scoped: boolean;
  /**
   * Label-free fragment naming what this lane is managed for, e.g.
   * `read-only crew roles only: reviewer, qa, architect, scout`. For composing
   * into a sentence that already named the lane.
   */
  managedFor: string;
  /**
   * One sentence a UI can render verbatim: what this lane is managed for. It
   * describes; it never grants. The dispatch route and the runner remain the
   * enforcement — this only stops the product lying about them.
   */
  summary: string;
};

/**
 * Project one lane's role scope. Used by the onboarding copy AND by the desktop
 * Crew sidebar, so both say the same true thing about the same lane.
 *
 * NOTE the fail-closed direction: a vendor MUON does not name holds NO role, so
 * this projection describes it as unmanaged. It used to be `?? AGENT_ROLES` —
 * an unknown key read as unscoped, i.e. as a lane for every crew role — which
 * was the widest of the four fail-opens ADR-0022 §1.2(b) inventories, and the
 * one an operator actually reads (this is the desktop Crew sidebar's copy).
 */
export function vendorRoleScope(vendor: string): VendorRoleScope {
  const roles = [...(VENDOR_DISPATCH_ROLES[vendor] ?? [])];
  const label = vendorLabel(vendor);
  const scoped = roles.length < AGENT_ROLES.length;
  const unmanaged = roles.length === 0;
  const readOnly =
    roles.length > 0 &&
    roles.every((role) => ROLE_SPECS[role].authority === "read-only");
  const takesUnplannedWork = roles.includes(UNPLANNED_DISPATCH_ROLE);
  const managedFor = unmanaged
    ? "no crew role"
    : !scoped
      ? "every crew role"
      : `${readOnly ? "read-only" : "a limited set of"} crew roles only: ${roles.join(
          ", "
        )}`;
  const summary = unmanaged
    ? `${label} is not a managed dispatch lane in MUON: it holds no crew role, so MUON never assigns it work.`
    : !scoped
      ? `${label} is a managed dispatch lane for every crew role.`
      : `${label} is a managed dispatch lane for ${managedFor}. MUON never assigns it ${
          readOnly ? "write-class" : "other"
        } work.`;
  return {
    vendor,
    label,
    roles,
    takesUnplannedWork,
    readOnly,
    scoped,
    managedFor,
    summary,
  };
}

/** Which guided step a vendor is on: install, finish setup, or ready. */
export type VendorStepKind = "install" | "login" | "ready";

/** One vendor's onboarding row: raw readiness + the guided step and copy. */
export type VendorOnboardingStep = {
  vendor: string;
  label: string;
  step: VendorStepKind;
  installed: boolean;
  authenticated: boolean;
  credentialMethod?: VendorReadiness["credentialMethod"];
  detail: string;
  /**
   * The exact command the user runs THEMSELVES to close the gap (install or the
   * vendor's native login), sourced verbatim from the readiness probe. Absent
   * once the vendor is ready. NEVER a token.
   */
  fixHint?: string;
  /** One-line human instruction for the current step. */
  guidance: string;
  /** What this lane is FOR, derived from the role model (see vendorRoleScope). */
  roleScope: VendorRoleScope;
};

/** Map one vendor's readiness to its guided onboarding step. */
export function vendorOnboardingStep(
  readiness: VendorReadiness
): VendorOnboardingStep {
  const roleScope = vendorRoleScope(readiness.vendor);
  const label = roleScope.label;
  const local = connectKind(readiness.vendor) === "local-runtime";
  let step: VendorStepKind;
  let guidance: string;
  if (!readiness.installed) {
    step = "install";
    guidance = local
      ? `Install ${label} — there is no account to create. MUON runs local models through the Codex CLI, so keep that installed too.`
      : `Install the ${label} CLI, then sign in or configure it, MUON drives your own copy.`;
  } else if (!readiness.authenticated) {
    step = "login";
    guidance = local
      ? `${label} is installed · setup needed. No sign-in exists for this lane — start the daemon and pull at least one model.`
      : `${label} is installed · setup needed. Sign in or configure its supported provider credentials.`;
  } else {
    step = "ready";
    let connected: string;
    switch (readiness.credentialMethod) {
      case "api-key":
        connected = `${label} is configured with its own API key`;
        break;
      case "custom-provider":
        connected = `${label} is configured through its active provider`;
        break;
      case "local-provider":
        connected = `${label} is configured through a local provider`;
        break;
      default:
        connected = local ? `${label} is running locally` : `${label} is connected`;
    }
    // A role-scoped lane is CONNECTED — saying "ready to dispatch" full stop
    // would overstate it, and the old "dispatch depth expands as the integration
    // lands" understated it into a lie (Cursor and OpenCode are managed lanes
    // today). Say exactly which roles it holds, derived from the role model.
    guidance = roleScope.scoped
      ? `${connected}, managed for ${roleScope.managedFor}.${
          roleScope.takesUnplannedWork
            ? ""
            : " It cannot take implementation work, so it does not unlock your first task on its own."
        }`
      : `${connected}, ready to dispatch.`;
  }
  return {
    vendor: readiness.vendor,
    label,
    step,
    installed: readiness.installed,
    authenticated: readiness.authenticated,
    credentialMethod: readiness.credentialMethod,
    detail: readiness.detail,
    fixHint: readiness.fixHint,
    guidance,
    roleScope,
  };
}

/**
 * The aggregate onboarding phase:
 *  - `loading`    , readiness not yet probed (input `undefined`)
 *  - `unavailable`, probe could not run (input `null`) → show manual steps
 *  - `connect`    , probed, but no vendor is ready yet → guide install/login
 *  - `ready`      , ≥1 vendor installed AND authenticated → unlock first task
 */
export type OnboardingPhase = "loading" | "connect" | "ready" | "unavailable";

/** The full onboarding view-model every surface renders from. */
export type OnboardingState = {
  phase: OnboardingPhase;
  vendors: VendorOnboardingStep[];
  /**
   * Vendor keys that are connected AND can take the work an un-planned first
   * dispatch resolves to. A lane that is connected but role-scoped below that
   * (Cursor, OpenCode) is NOT here — see `roleScopedVendors`, which exists so the
   * omission is visible instead of silent.
   */
  readyVendors: string[];
  /**
   * Connected lanes that are managed for only PART of the role taxonomy, so a
   * user can see WHY a green lane did not unlock the first task.
   */
  roleScopedVendors: VendorRoleScope[];
  anyReady: boolean;
  /** First dispatch unlocks once ≥1 vendor is ready. */
  canDispatch: boolean;
  /** True when readiness could not be read (probe down), manual steps shown. */
  degraded: boolean;
  headline: string;
  subhead: string;
  /** Manual fallback steps; populated only when `degraded`. */
  manualSteps: string[];
  trustNotice: string;
};

/**
 * Build the onboarding view-model from a readiness array.
 *  - `undefined` → still probing (loading)
 *  - `null`      → probe unavailable (degrade to manual steps, never claim ready)
 *  - array       → derive per-vendor steps + whether first dispatch is unlocked
 */
export function buildOnboardingState(
  readiness: VendorReadiness[] | null | undefined
): OnboardingState {
  const base = {
    trustNotice: NEVER_STORES_TOKEN_NOTICE,
    manualSteps: [] as string[],
  };

  if (readiness === undefined) {
    return {
      ...base,
      phase: "loading",
      vendors: [],
      readyVendors: [],
      roleScopedVendors: [],
      anyReady: false,
      canDispatch: false,
      degraded: false,
      headline: "Checking your coding agents…",
      subhead:
        "Looking for installed CLIs and usable sign-in or provider credentials.",
    };
  }

  if (readiness === null) {
    return {
      ...base,
      phase: "unavailable",
      vendors: [],
      readyVendors: [],
      roleScopedVendors: [],
      anyReady: false,
      canDispatch: false,
      degraded: true,
      headline: "Couldn't check agent readiness.",
      subhead: "Connect an agent with the manual steps below, then re-check.",
      manualSteps: MANUAL_CONNECT_STEPS,
    };
  }

  const vendors = readiness.map(vendorOnboardingStep);
  const connected = vendors.filter((entry) => entry.step === "ready");
  // WHICH connected lanes unlock a first dispatch. This used to be spelled
  // `entry.vendor !== "cursor"` — a hardcoded vendor list that encoded the right
  // ANSWER for the wrong REASON, and was therefore already wrong for OpenCode
  // (also connected, also unable to hold `implementer`, but counted as ready).
  // The semantics are unchanged: a lane counts when it can take the role an
  // un-planned dispatch resolves to. Now they are DERIVED, so a lane whose role
  // scope changes cannot silently fall on the wrong side of this line.
  const readyVendors = connected
    .filter((entry) => entry.roleScope.takesUnplannedWork)
    .map((entry) => entry.vendor);
  // Connected but role-scoped below that bar. Surfaced (not swallowed) so a
  // Cursor-only or OpenCode-only machine is told WHY it is still on "connect".
  const roleScopedVendors = connected
    .filter((entry) => !entry.roleScope.takesUnplannedWork)
    .map((entry) => entry.roleScope);
  const anyReady = readyVendors.length > 0;

  if (anyReady) {
    const names = readyVendors
      .map((vendor) => vendorLabel(vendor))
      .join(", ");
    const alsoScoped =
      roleScopedVendors.length > 0
        ? ` ${roleScopedVendors.map((scope) => scope.summary).join(" ")}`
        : "";
    return {
      ...base,
      phase: "ready",
      vendors,
      readyVendors,
      roleScopedVendors,
      anyReady: true,
      canDispatch: true,
      degraded: false,
      headline: "You're connected.",
      subhead: `Ready to dispatch: ${names}. Run your first task.${alsoScoped}`,
    };
  }

  // The specific dead-end this closes: a machine where a lane IS connected and
  // green, yet the wizard still says "connect an agent" and gives no reason.
  const scopedReason =
    roleScopedVendors.length > 0
      ? `${roleScopedVendors
          .map((scope) => scope.summary)
          .join(" ")} Connect a lane that can implement (Claude Code or Codex) to unlock your first task.`
      : "MUON drives your own installed CLIs. Install and configure or sign in to at least one below, then re-check.";

  return {
    ...base,
    phase: "connect",
    vendors,
    readyVendors,
    roleScopedVendors,
    anyReady: false,
    canDispatch: false,
    degraded: false,
    headline:
      roleScopedVendors.length > 0
        ? "Connect a lane that can make changes."
        : "Connect or configure a coding agent to get started.",
    subhead: scopedReason,
  };
}
