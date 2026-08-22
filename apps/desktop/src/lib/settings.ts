import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GitHubCredential } from "@muon/client";
import {
  DEFAULT_DESKTOP_PRESETS,
  normalizeDesktopPresets,
  type DesktopPreset,
} from "./presets.js";
import {
  DEFAULT_CREW_CONFIG,
  normalizeCrewConfig,
  type CrewConfig,
} from "./crew-config.js";
import { FLEET_VENDORS } from "./fleet.js";

/** The lanes selectable for vendor-scoped standing consent (never the fake).
 *  DERIVED from the one renderer-safe universe (cubic: two independent
 *  `fleetVendorIds()` derivations could let "all selectable lanes" disagree
 *  with the predicate that declares global consent). */
export const FULL_AUTO_SELECTABLE_VENDORS: readonly string[] = FLEET_VENDORS;

/**
 * The GLOBAL standing-consent coordinate: true only when EVERY selectable lane
 * is selected.
 *
 * Three consumers read `fullAuto` as an unscoped, machine-wide fact, and none
 * of them has a vendor dimension to narrow:
 *   - the standing-approver LEASE, which tells a coordinator on any lane "an
 *     approver is watching" and thereby suppresses its fast-deny;
 *   - `MUON_FULL_AUTO` in the runner env, which fuses "the gates are OFF" into
 *     EVERY worker's preamble;
 *   - the governed schedule executor's `canClaim`.
 *
 * Deriving those from "any lane selected" made each of them lie under a subset:
 * a coordinator on an unselected lane would skip its fast-deny, file an
 * approval nothing would ever grant, and block for the full 300s approval
 * timeout; a codex worker would be told its gates were off while they were
 * fail-closed. "Every lane" is the only reading under which all three
 * statements are true, and it is the fail-CLOSED direction: a subset simply
 * leaves the global posture off. Selecting all lanes reproduces the legacy
 * behaviour exactly.
 */
import { isGlobalStandingConsent } from "./fleet.js";
export { isGlobalStandingConsent };

/**
 * Normalize a persisted/IPC vendor selection: known managed lanes only, deduped,
 * registry order. `undefined` means "legacy settings.json with no vendor list" —
 * the caller migrates from the legacy boolean instead.
 */
export function normalizeFullAutoVendors(
  input: unknown,
  legacyFullAuto: boolean
): string[] {
  if (!Array.isArray(input)) {
    // Legacy file (or env bootstrap): ALL lanes when the old boolean was on,
    // none otherwise — the exact behavior the user had before the field existed.
    return legacyFullAuto ? [...FULL_AUTO_SELECTABLE_VENDORS] : [];
  }
  const requested = new Set(
    input.filter((value): value is string => typeof value === "string")
  );
  return FULL_AUTO_SELECTABLE_VENDORS.filter((id) => requested.has(id));
}

export type DesktopSettings = {
  apiBase: string;
  /**
   * The human TYPED this base, so automatic lockfile rebasing stands down.
   *
   * Persisted, because the opt-out was session-scoped: the in-memory flag was
   * re-initialised to false on every launch, so a restart made an
   * operator-entered base indistinguishable from one MUON chose itself, and
   * the first connection error silently redirected it at whatever the local
   * lockfile named.
   *
   * NOT superseded by a moving brain, which is what it used to say and what
   * `applyBrainCoords` used to do: it cleared this flag AND persisted the clear,
   * so an operator's typed base was overridden for the session and could not be
   * restored on the next launch either. A brain handover onto a pinned base now
   * stands down instead (`decideBrainCoordsApply`), and only the human who typed
   * the base clears it — in Settings.
   */
  apiBaseExplicit?: boolean;
  /** OPERATOR token (P3-A): the desktop's own client, human/govern authority. */
  apiToken?: string;
  /** AGENT-tier token (P3-A): injected into the orchestrator + hosted runner. */
  agentToken?: string;
  /**
   * Operator-authorized GitHub App user credential. Persisted only in the
   * private 0600 settings file, consumed by trusted Electron main/backend, and
   * never projected to renderer state or the runner environment.
   */
  githubCredential?: GitHubCredential;
  /** Command used by the deep link that opens the TUI in a terminal. */
  pollIntervalMs: number;
  /**
   * Automatic on-launch update CHECK against the GitHub releases feed. OFF by
   * default to preserve the no-egress-by-default invariant. This outbound call
   * happens only when the user opts in here or clicks "Check for updates"
   * manually. PR/check egress is separately unlocked by an explicit GitHub
   * device-flow connection. Never auto-downloads; the user confirms each step.
   * See lib/updater.ts and docs/install.md.
   */
  autoUpdate: boolean;
  /**
   * ADR-0029: the version that ran on the previous boot. A difference from
   * the current version on startup means an update was just applied — surface
   * the "Updated to <v>" confirmation and drop the staged-swap rollback
   * bundle. Never user-edited.
   */
  lastRunVersion?: string;
  /**
   * F3: when the local-diagnostics consent was first granted (display +
   * audit; the spool's own consent.granted row is the durable record).
   */
  telemetryConsentAt?: string;
  /** ADR-0031: the anonymous per-profile analytics id, minted when consent is
   *  granted and cleared on revoke (a re-grant starts a NEW identity epoch).
   *  Random UUID — never derived from the user or machine. */
  telemetryDeviceId?: string;
  /**
   * S4 durable orchestration: when a delegated worker finishes while the
   * orchestrator chat is idle, auto-synthesize ONE bounded reconciliation turn
   * (capped at AUTO_CONTINUE_CAP between human messages, every turn streamed
   * visibly, uncertain outcomes always gated). ON by default on desktop (FD-3):
   * the human consented by requesting the work in-chat. Toggle off to fall back
   * to the manual [Continue orchestration] affordance only. Never an unbounded
   * loop, and the human can always Stop-all.
   */
  autoContinue: boolean;
  /**
   * Full-Auto operator standing consent ("Auto-approve"). ON by default (every
   * managed lane): Auto mode is the product default. The desktop (operator
   * tier) auto-resolves incoming pending approvals via the SAME resolveApproval
   * path a human click uses, sets vendor lanes to full access through the #52
   * dispatch-gate path, and threads a "FULL-AUTO MODE ACTIVE" safety block into
   * agent prompts. A decision-layer standing consent, never a backend bypass;
   * egress and blocked merge reviews still ask. Reversible: OFF restores
   * fail-closed gates exactly. `MUON_FULL_AUTO=0` forces OFF for a personal
   * build.
   */
  fullAuto: boolean;
  /**
   * Vendor-scoped standing consent: the lanes whose approvals the auto-approver
   * covers. This is the STORED truth; `fullAuto` is derived from it on every
   * write as "every lane" (see isGlobalStandingConsent) because its three
   * consumers are unscoped. A vendor id
   * here is a POSITIVE selection out of the real managed lanes; an approval
   * whose server-derived lane vendor is not selected (or is unresolvable) stays
   * a fail-closed human gate. Selecting every managed lane reproduces the
   * legacy "Auto-approve all" byte-for-byte, including non-lane gates.
   */
  fullAutoVendors: string[];
  /**
   * ROADMAP P6 — opt-in localhost preview pane. OFF by default; never opens
   * arbitrary hosts (see port-preview-security.ts).
   */
  portPreviewEnabled: boolean;
  /**
   * P0-5 — local diagnostics recording (the Observatory's consent gate). OFF
   * by default. When ON, bounded operational events (launch, crash reason
   * codes, activation milestones — never prose, paths, prompts, or names) are
   * appended to a LOCAL 0600 spool under the profile. NOTHING leaves the
   * machine: MUON currently has no telemetry uploader at all (see
   * observatory.ts, OBSERVATORY_PROVIDER = "none"); enabling egress is a
   * founder decision with its own privacy contract.
   */
  telemetryEnabled: boolean;
  /**
   * Operator-authored dispatch presets. These are non-secret, strictly
   * allowlisted coordinates (vendor/model/effort/permission); arbitrary lane
   * profile fields and authority-bearing tool grants are not persistable here.
   */
  presets: DesktopPreset[];
  /**
   * Crew / orchestrator configuration: which vendor seats the super-orchestrator,
   * and per-lane default model + effort. Non-secret; normalized on load.
   */
  crew: CrewConfig;
};

export const DEFAULT_SETTINGS: DesktopSettings = {
  // Env-overridable so a personal/packaged build can point at a hosted brain
  // without a code change; falls back to a local backend for development.
  // (The hosted backend requires a token, the user still sets it in Settings.)
  apiBase: process.env.MUON_API_BASE?.trim() || "http://localhost:4000",
  apiToken: process.env.MUON_API_TOKEN?.trim() || undefined,
  agentToken: process.env.MUON_AGENT_TOKEN?.trim() || undefined,
  pollIntervalMs: 5000,
  // No egress by default: opt in (or use the manual "Check for updates" button).
  autoUpdate: false,
  // Local-only durable coordination (no egress): ON by default on desktop.
  autoContinue: true,
  // Operator standing consent ("Auto-approve"), ON by default for every lane;
  // reversible. `MUON_FULL_AUTO=0` forces off; any other value (including unset
  // and the legacy `=1`) keeps the Auto-mode default.
  fullAuto: process.env.MUON_FULL_AUTO === "0" ? false : true,
  fullAutoVendors:
    process.env.MUON_FULL_AUTO === "0" ? [] : [...FULL_AUTO_SELECTABLE_VENDORS],
  portPreviewEnabled: false,
  telemetryEnabled: false,
  presets: DEFAULT_DESKTOP_PRESETS.map((preset) => ({ ...preset })),
  crew: normalizeCrewConfig(DEFAULT_CREW_CONFIG),
};

export function loadSettings(dir: string): DesktopSettings {
  try {
    const raw = readFileSync(path.join(dir, "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<DesktopSettings>;
    // Vendor-scoped standing consent: a legacy file has only the boolean, and
    // `fullAuto === true` meant every lane — migrate it as exactly that. The
    // boolean itself is then re-derived so the pair can never disagree.
    const fullAutoVendors = normalizeFullAutoVendors(
      parsed.fullAutoVendors,
      parsed.fullAuto === true
    );
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      fullAutoVendors,
      // GLOBAL coordinate: all lanes, not any — see isGlobalStandingConsent.
      fullAuto: isGlobalStandingConsent(fullAutoVendors),
      presets: normalizeDesktopPresets(parsed.presets),
      crew: normalizeCrewConfig(parsed.crew),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * The durable projection of the settings. `apiBase` is OPTIONAL here because an
 * adopted one is runtime-only (see persistableSettings); `loadSettings` fills it
 * from DEFAULT_SETTINGS when it is absent.
 */
export type PersistableSettings = Omit<DesktopSettings, "apiBase"> & {
  apiBase?: string;
};

export function saveSettings(dir: string, settings: PersistableSettings): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.json");
  // settings.json may hold user-supplied operator/GitHub credentials, write it
  // private (0600), never world-readable. `mode` only applies when CREATING the
  // file (and is masked by umask), so `chmodSync` also TIGHTENS a pre-existing
  // file that a prior build left at the default 0644.
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Persist WITHOUT letting a failed write take a running app down.
 *
 * `saveSettings` above stays strict on purpose: the Settings surface asks a
 * human to save, and a save that did not happen has to be reported to them as a
 * failure. This is the other caller shape — the BACKGROUND persist that rides on
 * an event nobody clicked, `applyBrainCoords` recording the brain's fresh
 * coordinates. There the writer is synchronous (`writeFileSync` + `chmodSync`),
 * so an unwritable settings.json (ENOSPC, a root-owned file) threw straight
 * through a `void`ed async supervisor callback with nothing attached — and this
 * app installs no `unhandledRejection` handler, so main exited and took the
 * window and every runner-hosted vendor session with it. A settings file MUON
 * cannot write is worth a loud line, never the app.
 *
 * REPORTED, never silent: `onError` gets the reason, and the boolean lets a
 * caller that has somewhere better to put it do so. It lives beside the strict
 * writer rather than at the call site so the two cannot drift apart.
 */
export function trySaveSettings(
  dir: string,
  settings: PersistableSettings,
  onError: (reason: string) => void
): boolean {
  try {
    saveSettings(dir, settings);
    return true;
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * The loopback coordinates a brain hands over. Structural on purpose — settings
 * must not import the supervisor (lib/brain.ts) to state a rule about its own
 * fields; `BrainCoords` is assignable to this.
 */
export type BrainCoordinates = {
  base: string;
  token?: string;
  agentToken?: string;
};

/**
 * Should a brain-coordinate handover be applied to these settings at all?
 *
 * Two answers that used to be missing, and both of them cost live work, because
 * applying a handover restarts the runner — which SIGTERMs every vendor session
 * it hosts (observed: a live coordinator killed with exit 143):
 *
 *  - `pinned`: the operator TYPED a base (`apiBaseExplicit`, an editable field
 *    in the shipped Settings UI). Applying anyway both redirected them at the
 *    embedded brain and CLEARED the pin on disk, so the next launch could not
 *    restore it either — a durable silent un-pin of an explicit instruction.
 *  - `unchanged`: two producers now deliver coordinates (the supervisor's
 *    late-readiness watch and `rebaseFromLockfile`'s scheduled apply) and they
 *    can deliver the SAME ones. `rebaseFromLockfile` compares before it applies;
 *    the handover path did not, so a redundant re-apply was a free session kill.
 *
 * A token-only handover (same base, a fresh token) is still `apply` — that is
 * the late-readiness case the whole watch exists for. `undefined` on either
 * token means "keep what is there", which is exactly how the caller merges them,
 * so it counts as unchanged.
 */
export type BrainCoordsDecision =
  | { readonly action: "apply" }
  | { readonly action: "skip"; readonly reason: "pinned" | "unchanged" };

export function decideBrainCoordsApply(input: {
  current: Pick<DesktopSettings, "apiBase" | "apiToken" | "agentToken"> & {
    apiBaseExplicit?: boolean;
  };
  coords: BrainCoordinates;
}): BrainCoordsDecision {
  const { current, coords } = input;
  // PINNED FIRST: it is the honest reason MUON is standing down, and it holds
  // even when the coordinates happen to match.
  if (current.apiBaseExplicit === true) {
    return { action: "skip", reason: "pinned" };
  }
  const sameBase = coords.base === current.apiBase;
  const sameToken =
    coords.token === undefined || coords.token === current.apiToken;
  const sameAgentToken =
    coords.agentToken === undefined ||
    coords.agentToken === current.agentToken;
  if (sameBase && sameToken && sameAgentToken) {
    return { action: "skip", reason: "unchanged" };
  }
  return { action: "apply" };
}

/**
 * Project the durable, persistable view of the settings. The embedded flow's
 * operator + agent tokens are auto-minted each boot from the 0600 brain
 * lockfile (`applyBrainCoords`), so writing them to settings.json is redundant
 * AND leaks a live secret to disk. Only user-supplied operator credentials
 * survive here: a manual/hosted API token and the GitHub credential obtained by
 * an explicit device flow. The agent token is NEVER persisted.
 * `JSON.stringify` drops the `undefined`s.
 *
 * `apiBase` follows the same rule as the tokens, and for the same reason. The
 * embedded brain's port is chosen at runtime and republished in the lockfile
 * every boot, so writing the ADOPTED base to disk records a coordinate that is
 * already stale — and then `loadSettings` hands it back as if it were a
 * decision, which is the original stale-apiBase bug. Only an EXPLICIT base (the
 * human typed one, `apiBaseExplicit === true`) is durable; an adopted one is
 * re-derived from the lockfile on the next launch.
 */
export function persistableSettings(
  settings: DesktopSettings,
  userApiToken: string | undefined
): PersistableSettings {
  const { apiBase, ...rest } = settings;
  return {
    ...rest,
    ...(settings.apiBaseExplicit === true ? { apiBase } : {}),
    apiToken: userApiToken,
    agentToken: undefined,
  };
}

/**
 * Project the NON-SECRET settings view sent to the renderer. Raw operator/API
 * and GitHub credentials NEVER cross the IPC bridge; the renderer talks through
 * `window.muon.*`, so it needs no token. We expose a boolean API-token indicator
 * instead: true when the user configured a manual/hosted token, false when the
 * operator token is the embedded (auto) one.
 */
export function toRendererSettings(
  settings: DesktopSettings,
  userApiToken: string | undefined
): {
  apiBase: string;
  apiTokenSet: boolean;
  autoUpdate: boolean;
  autoContinue: boolean;
  fullAuto: boolean;
  fullAutoVendors: string[];
  portPreviewEnabled: boolean;
  telemetryEnabled: boolean;
  presets: DesktopPreset[];
  crew: CrewConfig;
} {
  return {
    apiBase: settings.apiBase,
    apiTokenSet: Boolean(userApiToken),
    autoUpdate: settings.autoUpdate,
    autoContinue: settings.autoContinue,
    fullAuto: settings.fullAuto,
    fullAutoVendors: [...settings.fullAutoVendors],
    portPreviewEnabled: settings.portPreviewEnabled,
    telemetryEnabled: settings.telemetryEnabled,
    presets: settings.presets.map((preset) => ({ ...preset })),
    crew: normalizeCrewConfig(settings.crew),
  };
}
