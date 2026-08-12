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
import { fleetVendorIds } from "@muon/client/vendors";

/** The lanes selectable for vendor-scoped standing consent (never the fake). */
export const FULL_AUTO_SELECTABLE_VENDORS: readonly string[] = fleetVendorIds();

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
export function isGlobalStandingConsent(vendors: readonly string[]): boolean {
  return (
    FULL_AUTO_SELECTABLE_VENDORS.length > 0 &&
    FULL_AUTO_SELECTABLE_VENDORS.every((id) => vendors.includes(id))
  );
}

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
   * lockfile named. Superseded by `applyBrainCoords` (the embedded brain
   * moving IS the newer instruction), which clears it.
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
   * Full-Auto operator standing consent ("Auto Approve all"). OFF by default:
   * when true, the desktop (operator tier) auto-resolves every incoming pending
   * approval as approved via the SAME resolveApproval path a human click uses,
   * sets vendor lanes to full access through the existing #52 dispatch-gate path,
   * and threads a "FULL-AUTO MODE ACTIVE" safety block into agent prompts. A
   * decision-layer standing consent, never a backend bypass; the fail-closed
   * gates/receipts/schema are unchanged. Reversible: OFF restores today exactly.
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
  // Operator standing consent ("Auto Approve all"), OFF by default; reversible.
  // Env override mirrors autoUpdate/autoContinue for a personal/packaged build.
  fullAuto: process.env.MUON_FULL_AUTO === "1" ? true : false,
  fullAutoVendors:
    process.env.MUON_FULL_AUTO === "1" ? [...FULL_AUTO_SELECTABLE_VENDORS] : [],
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

export function saveSettings(dir: string, settings: DesktopSettings): void {
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
 * Project the durable, persistable view of the settings. The embedded flow's
 * operator + agent tokens are auto-minted each boot from the 0600 brain
 * lockfile (`applyBrainCoords`), so writing them to settings.json is redundant
 * AND leaks a live secret to disk. Only user-supplied operator credentials
 * survive here: a manual/hosted API token and the GitHub credential obtained by
 * an explicit device flow. The agent token is NEVER persisted.
 * `JSON.stringify` drops the `undefined`s.
 */
export function persistableSettings(
  settings: DesktopSettings,
  userApiToken: string | undefined
): DesktopSettings {
  return { ...settings, apiToken: userApiToken, agentToken: undefined };
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
