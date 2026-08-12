import { describe, expect, it } from "vitest";
import { VENDOR_REGISTRY, coordinatorVendorIds } from "@muon/client/vendors";
import {
  CREW_LANE_VENDORS,
  CREW_LANE_VENDORS_FROM_REGISTRY,
  DEFAULT_CREW_CONFIG,
  ORCHESTRATOR_VENDORS,
  isCrewLaneVendor,
  knownModelsForVendor,
  normalizeCrewConfig,
  rememberOrchestratorPrefs,
  selectOrchestratorVendor,
} from "../src/lib/crew-config.js";

/**
 * WAVE D conformance. `CREW_LANE_VENDORS` deliberately stays a literal tuple —
 * `laneDefaults` is a TOTAL record carrying a real model id per lane, and
 * widening the type would force a fabricated default for a lane that has no
 * catalogue. So the literal is held to the registry HERE instead of by the type:
 * two independent statements that must agree, which is the only shape that
 * catches a wrong value rather than merely a missing one (ADR-0022 §3.4).
 */
describe("crew-config — the registry projections", () => {
  it("CREW_LANE_VENDORS is exactly the fleet lanes that HAVE a model catalogue", () => {
    expect([...CREW_LANE_VENDORS]).toEqual([...CREW_LANE_VENDORS_FROM_REGISTRY()]);
  });

  it("every crew lane has a default model the registry actually knows", () => {
    for (const vendor of CREW_LANE_VENDORS) {
      const known = VENDOR_REGISTRY[vendor].models?.known ?? [];
      expect(known).toContain(DEFAULT_CREW_CONFIG.laneDefaults[vendor].model);
    }
  });

  it("a lane with no catalogue gets an empty list, never another vendor's models", () => {
    for (const id of Object.keys(VENDOR_REGISTRY)) {
      const entry = VENDOR_REGISTRY[id as keyof typeof VENDOR_REGISTRY];
      expect(knownModelsForVendor(id)).toEqual([...(entry.models?.known ?? [])]);
    }
    expect(knownModelsForVendor("kiro")).toEqual([]);
  });

  it("ORCHESTRATOR_VENDORS is a projection of the coordinator seat", () => {
    expect([...ORCHESTRATOR_VENDORS]).toEqual([...coordinatorVendorIds()]);
  });

  it("an ineligible vendor is never normalized into the orchestrator seat", () => {
    // The type is `VendorId` now; the RUNTIME projection is what refuses.
    const crew = normalizeCrewConfig({ orchestratorVendor: "cursor" });
    expect(crew.orchestratorVendor).not.toBe("cursor");
    expect(ORCHESTRATOR_VENDORS).toContain(crew.orchestratorVendor);
  });
});

describe("crew-config", () => {
  it("defaults to Claude Code orchestrator with sane lane models", () => {
    expect(DEFAULT_CREW_CONFIG.orchestratorVendor).toBe("claude-code");
    expect(DEFAULT_CREW_CONFIG.laneDefaults.codex.model).toBe("gpt-5.6-sol");
  });

  it("normalizes a codex orchestrator choice", () => {
    const crew = normalizeCrewConfig({
      orchestratorVendor: "codex",
      orchestratorModel: "gpt-5.6-terra",
      orchestratorEffort: "xhigh",
      laneDefaults: {
        codex: { model: "gpt-5.6-luna", effort: "low" },
      },
    });
    expect(crew.orchestratorVendor).toBe("codex");
    expect(crew.orchestratorModel).toBe("gpt-5.6-terra");
    expect(crew.orchestratorEffort).toBe("xhigh");
    expect(crew.laneDefaults.codex).toEqual({
      model: "gpt-5.6-luna",
      effort: "low",
    });
    // Unspecified lanes keep defaults.
    expect(crew.laneDefaults["claude-code"].model).toBe("sonnet");
  });

  it("rejects unknown orchestrator vendors and bad models", () => {
    const crew = normalizeCrewConfig({
      orchestratorVendor: "cursor",
      orchestratorModel: "not-a-real-model!!!!",
      orchestratorEffort: "extreme",
    });
    expect(crew.orchestratorVendor).toBe("claude-code");
    expect(crew.orchestratorEffort).toBe("medium");
  });

  it("exposes known model lists per vendor", () => {
    expect(knownModelsForVendor("claude-code")).toContain("fable");
    expect(knownModelsForVendor("claude-code")).toContain("sonnet");
    expect(knownModelsForVendor("codex")).toContain("gpt-5.6-sol");
    expect(knownModelsForVendor("cursor")).toContain("auto");
  });

  it("answers honestly for a lane with an UNENUMERABLE model catalogue", () => {
    // OpenCode is BYO-provider, so its live model set is whichever providers the
    // operator authed. TODO 3.4 gave the lane a catalogue, but a catalogue that
    // is a SHAPE (`known: []` + `idShape`), not a list — so a per-dispatch
    // override now validates while this list stays empty. An empty list keeps
    // the lane sizeable WITHOUT a fabricated dropdown — and, critically, without
    // falling through to another vendor's model names, which is what the old
    // `return ["auto", "sonnet", …]` default branch would have done.
    expect(knownModelsForVendor("opencode")).toEqual([]);
    expect(isCrewLaneVendor("opencode")).toBe(false);
    for (const vendor of ["claude-code", "codex", "cursor"]) {
      expect(isCrewLaneVendor(vendor)).toBe(true);
    }
  });

  it("uses the selected vendor's own configured model unless the operator overrides it", () => {
    const crew = selectOrchestratorVendor(DEFAULT_CREW_CONFIG, "codex");
    expect(crew.orchestratorVendor).toBe("codex");
    expect(crew.orchestratorModel).toBe("");
    expect(crew.laneDefaults.codex.model).toBe("gpt-5.6-sol");
  });

  it("TODO 3.8: remembers model/effort per vendor across switches", () => {
    const withCodex = rememberOrchestratorPrefs(
      selectOrchestratorVendor(DEFAULT_CREW_CONFIG, "codex"),
      { model: "gpt-5.6-terra", effort: "xhigh" }
    );
    expect(withCodex.orchestratorModel).toBe("gpt-5.6-terra");
    const backToClaude = selectOrchestratorVendor(withCodex, "claude-code");
    expect(backToClaude.orchestratorVendor).toBe("claude-code");
    // Outgoing Claude snapshot was empty/default; flip back to Codex restores.
    const againCodex = selectOrchestratorVendor(backToClaude, "codex");
    expect(againCodex.orchestratorModel).toBe("gpt-5.6-terra");
    expect(againCodex.orchestratorEffort).toBe("xhigh");
  });

  it("TODO 3.8: prunes invalid per-vendor models on read", () => {
    const crew = normalizeCrewConfig({
      orchestratorVendor: "codex",
      orchestratorModel: "gpt-5.6-sol",
      orchestratorByVendor: {
        codex: { model: "not-a-real-model!!!!", effort: "high" },
        "claude-code": { model: "sonnet", effort: "low" },
      },
    });
    // Bad codex id is pruned to explicit vendor-picks (""), not kept as a ghost.
    expect(crew.orchestratorByVendor.codex?.model).toBe("");
    expect(crew.orchestratorByVendor["claude-code"]).toEqual({
      model: "sonnet",
      effort: "low",
    });
  });
});
