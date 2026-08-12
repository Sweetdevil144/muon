/**
 * Operator-chosen crew / orchestrator configuration (non-secret).
 * Persisted in settings.json and projected to the renderer.
 */

import {
  validateModelForVendor,
  type VendorKey,
} from "@muon/adapters/vendor-capabilities";
import {
  VENDOR_REGISTRY,
  coordinatorVendorIds,
  defaultCoordinatorVendor,
  fleetVendorIds,
  type VendorId,
} from "@muon/client/vendors";
import {
  DESKTOP_PRESET_EFFORTS,
  type DesktopPresetEffort,
} from "./presets.js";

/**
 * Vendors that can seat the super-orchestrator.
 *
 * WAVE D: a projection of `authority.coordinatorSeat`, not a copy. The TYPE is
 * `VendorId` because a type never gated anything here — `normalizeCrewConfig`
 * checks the runtime projection below, and the backend role ceiling
 * (`assertVendorMayHoldRole`) is the actual authority.
 */
export const ORCHESTRATOR_VENDORS = coordinatorVendorIds();
export type OrchestratorVendor = VendorId;

/**
 * Worker lanes that expose model/effort knobs in the Crew tab.
 *
 * NOT the same set as `FLEET_VENDORS`: every fleet lane is sizeable, but a
 * dropdown needs a LIST, and only these can supply one MUON is willing to
 * pre-seat a default from. OpenCode is a sizeable lane WITHOUT a model dropdown
 * rather than a lane with a fabricated one — see the derivation below for why
 * that stayed true even after TODO 3.4 gave it a catalogue.
 */
export const CREW_LANE_VENDORS = ["claude-code", "codex", "cursor"] as const;
export type CrewLaneVendor = (typeof CREW_LANE_VENDORS)[number];

/**
 * WHY THIS ONE STAYS A LITERAL. `laneDefaults` is a TOTAL
 * `Record<CrewLaneVendor, …>` carrying a real model id per lane, so widening the
 * type would force a fabricated default for a lane that has no catalogue —
 * exactly the outcome the comment above refuses. The literal is held to the
 * registry by a conformance test (`crew-config.test.ts`) instead of by the type:
 * two independent statements that must agree, which is also the only shape that
 * catches a wrong value rather than a missing one.
 *
 * TODO 3.4 MOVED THIS PREDICATE, and the move is the interesting part. It read
 * `models !== null`, which was a fair proxy while the only two states were "has
 * a list" and "has nothing". opencode now has a catalogue that is deliberately
 * UNENUMERABLE (`known: []` + an id shape), and `!== null` would have swept it
 * into the crew tab — where the total `laneDefaults` record would then demand a
 * hardcoded opencode model id, and any id MUON invented would be one this
 * operator's providers may not offer. So the predicate now asks for what a
 * dropdown actually needs: a NON-EMPTY `known`.
 */
export const CREW_LANE_VENDORS_FROM_REGISTRY = (): readonly VendorId[] =>
  fleetVendorIds().filter(
    (id) => (VENDOR_REGISTRY[id].models?.known.length ?? 0) > 0
  );

const crewLaneSet = new Set<string>(CREW_LANE_VENDORS);

/** True when this lane has MUON-known model/effort defaults to edit. */
export function isCrewLaneVendor(vendor: string): vendor is CrewLaneVendor {
  return crewLaneSet.has(vendor);
}

export type LaneDefaultConfig = {
  model: string;
  effort: DesktopPresetEffort;
};

/** Effort levels the Mission superagent menu can pick (Codex-aligned). */
export const ORCHESTRATOR_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type OrchestratorEffort = (typeof ORCHESTRATOR_EFFORTS)[number];

/**
 * TODO 3.8 — per-vendor Mission prefs. Keyed by vendor id (not a config UUID).
 * `model: ""` is explicit "vendor picks"; absence of a key means never chosen
 * for that vendor (falls back to "").
 */
export type OrchestratorVendorPrefs = {
  model: string;
  effort: OrchestratorEffort;
};

export type CrewConfig = {
  orchestratorVendor: OrchestratorVendor;
  orchestratorModel: string;
  orchestratorEffort: OrchestratorEffort;
  /**
   * Last model/effort per coordinator vendor. Restored on vendor switch so
   * flipping Claude ↔ Codex does not lose each seat's choice.
   */
  orchestratorByVendor: Partial<
    Record<OrchestratorVendor, OrchestratorVendorPrefs>
  >;
  laneDefaults: Record<CrewLaneVendor, LaneDefaultConfig>;
};

export const DEFAULT_CREW_CONFIG: CrewConfig = {
  // WAVE E: the operator's coordinator preference, intersected with the seated
  // set. One default, one place, instead of the four spellings ADR-0022 §1.1
  // counted across `apps/**`.
  orchestratorVendor: defaultCoordinatorVendor(),
  orchestratorModel: "",
  orchestratorEffort: "medium",
  orchestratorByVendor: {},
  laneDefaults: {
    "claude-code": { model: "sonnet", effort: "medium" },
    codex: { model: "gpt-5.6-sol", effort: "medium" },
    cursor: { model: "auto", effort: "medium" },
  },
};

/**
 * Switching the Mission vendor restores that vendor's remembered prefs
 * (TODO 3.8). Empty remembered model means explicit vendor-picks, not "unset".
 */
export function selectOrchestratorVendor(
  current: CrewConfig,
  vendor: OrchestratorVendor
): CrewConfig {
  // Snapshot the outgoing vendor before the switch so the next flip back
  // restores what the operator had, not a blank.
  const outgoing: OrchestratorVendorPrefs = {
    model: current.orchestratorModel,
    effort: current.orchestratorEffort,
  };
  const remembered = current.orchestratorByVendor[vendor];
  return {
    ...current,
    orchestratorVendor: vendor,
    orchestratorModel: remembered?.model ?? "",
    orchestratorEffort: remembered?.effort ?? "medium",
    orchestratorByVendor: {
      ...current.orchestratorByVendor,
      [current.orchestratorVendor]: outgoing,
    },
  };
}

/** Persist the live Mission model/effort under the seated vendor id. */
export function rememberOrchestratorPrefs(
  current: CrewConfig,
  patch: Partial<OrchestratorVendorPrefs>
): CrewConfig {
  const nextModel =
    patch.model !== undefined ? patch.model : current.orchestratorModel;
  const nextEffort =
    patch.effort !== undefined ? patch.effort : current.orchestratorEffort;
  return {
    ...current,
    orchestratorModel: nextModel,
    orchestratorEffort: nextEffort,
    orchestratorByVendor: {
      ...current.orchestratorByVendor,
      [current.orchestratorVendor]: {
        model: nextModel,
        effort: nextEffort,
      },
    },
  };
}

const effortSet = new Set<string>(DESKTOP_PRESET_EFFORTS);
const orchestratorEffortSet = new Set<string>(ORCHESTRATOR_EFFORTS);
const orchestratorSet = new Set<string>(ORCHESTRATOR_VENDORS);

/**
 * Takes a plain `string` (not `CrewLaneVendor`) so a caller iterating the full
 * fleet can ask about any lane. A lane MUON has no model catalogue for answers
 * with `[]` — an honest empty list, never another vendor's models.
 */
export function knownModelsForVendor(vendor: string): string[] {
  // WAVE D: read from the registry. This used to be a hand-copied catalogue
  // under a "Keep in sync with packages/adapters" comment — the kind of comment
  // that is only ever written because nothing enforces it.
  const entry = (VENDOR_REGISTRY as Record<string, { models: { known: readonly string[] } | null }>)[
    vendor
  ];
  // A lane with no declared catalogue answers with an honest empty list, never
  // another vendor's models. `models: null` is a statement, not an omission.
  return entry?.models ? [...entry.models.known] : [];
}

function normalizeEffort(value: unknown): DesktopPresetEffort {
  return typeof value === "string" && effortSet.has(value)
    ? (value as DesktopPresetEffort)
    : "medium";
}

function normalizeOrchestratorEffort(value: unknown): OrchestratorEffort {
  return typeof value === "string" && orchestratorEffortSet.has(value)
    ? (value as OrchestratorEffort)
    : "medium";
}

function normalizeModel(vendor: string, value: unknown): string {
  // A lane with no configured default falls back to "" (the vendor default),
  // which is what an operator-chosen seat outside CREW_LANE_VENDORS should get.
  const fallback =
    DEFAULT_CREW_CONFIG.laneDefaults[vendor as CrewLaneVendor]?.model ?? "";
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 200) return fallback;
  // TODO 3.3 closed ADR-0022 §1.2(a): `VendorKey` IS `VendorId`, so the fourth
  // managed lane has a descriptor row and this cast no longer crosses a
  // divergence. An id for a seat the registry does not name still degrades
  // honestly (no declared policy → the argv-shape checks only), so an unknown
  // seat is validated, not waved through.
  const check = validateModelForVendor(vendor as VendorKey, trimmed);
  return check.ok ? trimmed : fallback;
}

export function normalizeCrewConfig(value: unknown): CrewConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const orchestratorVendor =
    typeof raw.orchestratorVendor === "string" &&
    orchestratorSet.has(raw.orchestratorVendor)
      ? (raw.orchestratorVendor as OrchestratorVendor)
      : DEFAULT_CREW_CONFIG.orchestratorVendor;

  const laneRaw =
    raw.laneDefaults &&
    typeof raw.laneDefaults === "object" &&
    !Array.isArray(raw.laneDefaults)
      ? (raw.laneDefaults as Record<string, unknown>)
      : {};

  const laneDefaults = { ...DEFAULT_CREW_CONFIG.laneDefaults };
  for (const vendor of CREW_LANE_VENDORS) {
    const entry = laneRaw[vendor];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    laneDefaults[vendor] = {
      model: normalizeModel(vendor, rec.model),
      effort: normalizeEffort(rec.effort),
    };
  }

  const orchestratorModel = normalizeModel(
    orchestratorVendor,
    raw.orchestratorModel ??
      laneDefaults[orchestratorVendor as CrewLaneVendor]?.model ??
      ""
  );

  const orchestratorEffort = normalizeOrchestratorEffort(
    raw.orchestratorEffort
  );

  // TODO 3.8: restore per-vendor map; prune models that fail the seated
  // vendor's shape check (ids that fell out of the catalogue / policy).
  const byVendorRaw =
    raw.orchestratorByVendor &&
    typeof raw.orchestratorByVendor === "object" &&
    !Array.isArray(raw.orchestratorByVendor)
      ? (raw.orchestratorByVendor as Record<string, unknown>)
      : {};
  const orchestratorByVendor: Partial<
    Record<OrchestratorVendor, OrchestratorVendorPrefs>
  > = {};
  for (const vendor of ORCHESTRATOR_VENDORS) {
    const entry = byVendorRaw[vendor];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    let model = normalizeModel(vendor, rec.model ?? "");
    // TODO 3.8: prune ids that fell out of the enumerable catalogue. allowCustom
    // vendors still accept unknown ids at dispatch time; remembered prefs should
    // not keep advertising a dead catalogue row after a bump.
    const known = knownModelsForVendor(vendor);
    if (model && known.length > 0 && !known.includes(model)) {
      model = "";
    }
    orchestratorByVendor[vendor] = {
      model,
      effort: normalizeOrchestratorEffort(rec.effort),
    };
  }
  // Seed the live vendor from the live fields when the map has no row yet
  // (upgrade path from settings written before 3.8).
  if (!orchestratorByVendor[orchestratorVendor]) {
    orchestratorByVendor[orchestratorVendor] = {
      model: orchestratorModel,
      effort: orchestratorEffort,
    };
  }

  return {
    orchestratorVendor,
    orchestratorModel,
    orchestratorEffort,
    orchestratorByVendor,
    laneDefaults,
  };
}
