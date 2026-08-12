import { describe, expect, it } from "vitest";
import { createDefaultAdapters } from "@muon/adapters";
import { assignRoles, type LaneCandidate } from "@muon/core";
import {
  VENDOR_REGISTRY,
  isVendorId,
  vendorCost,
  type LaneHealthStatus,
} from "@muon/protocol";

/**
 * THE `cost` BEFORE/AFTER FIXTURE (ADR-0022 §1.2(h), §8; ADR-0020 §3).
 *
 * ADR-0020 §3 claimed "a cost term that steers cheap reconnaissance to the local
 * lane". That was never true. `probeLaneCandidates` never set `LaneCandidate.cost`,
 * so every lane took `role-assignment`'s `?? 0.5` and the term was a CONSTANT —
 * it shifted every score by the same amount and could not reorder anything.
 *
 * Wave F supplies it from the registry, which is the FIRST change to `assignRoles`
 * output since ADR-0020. ADR-0022 §8 says that "needs its own before/after
 * fixture", and this is it.
 *
 * WHY EXHAUSTIVE RATHER THAN ONE CREW. A single happy-path crew would prove
 * almost nothing: the cost adjustment is small (≤0.1 for `scout`, ≤0.05 for the
 * write roles) and the reuse penalty moves in 0.15 steps, so a flip needs a
 * near-tie that only appears in particular lane subsets and health mixes. So the
 * sweep is total over both: every non-empty subset of the registered lanes ×
 * every healthy/degraded assignment over them.
 *
 * THE RESULT, AND THE REASON THIS CHANGE WAS SAFE TO LAND: over every
 * production-reachable case, NO assignment moves. Only the reported `fit` numbers
 * do. The one place any assignment moves at all is behind `MUON_FAKE_VENDOR=1`,
 * and it moves in the right direction — see the second block.
 */

type Probe = {
  vendor: string;
  displayName: string;
  capabilities: LaneCandidate["capabilities"];
  supportedRoles: LaneCandidate["supportedRoles"];
  roleAffinity: LaneCandidate["roleAffinity"];
};

/** The same shape `probeLaneCandidates` builds, from the same adapters. */
async function probeAdapters(): Promise<Probe[]> {
  return Promise.all(
    createDefaultAdapters().map(async (adapter) => ({
      vendor: adapter.id,
      displayName: adapter.displayName,
      capabilities: await adapter.capabilities(),
      supportedRoles: adapter.supportedRoles,
      roleAffinity: adapter.roleAffinity,
    }))
  );
}

const HEALTHS: readonly LaneHealthStatus[] = ["healthy", "degraded"];

function lanesFor(
  chosen: readonly Probe[],
  healths: readonly LaneHealthStatus[],
  withCost: boolean
): LaneCandidate[] {
  return chosen.map((lane, index) => ({
    vendor: lane.vendor,
    displayName: lane.displayName,
    capabilities: lane.capabilities,
    health: healths[index]!,
    supportedRoles: lane.supportedRoles,
    ...(lane.roleAffinity ? { roleAffinity: lane.roleAffinity } : {}),
    // BEFORE = the field omitted entirely, which is literally what production
    // did until Wave F. AFTER = the registry's value.
    ...(withCost ? { cost: vendorCost(lane.vendor) } : {}),
  }));
}

/** Role→vendor only. `fit` is deliberately excluded: it is EXPECTED to move. */
function assignmentKey(lanes: LaneCandidate[]): string {
  const plan = assignRoles({ chatId: "chat-cost-fixture", lanes });
  return `${plan.bindings
    .map((binding) => `${binding.role}=${binding.vendor}`)
    .join(",")}|unfilled:${plan.unfilled.join(",")}`;
}

/** Every non-empty subset × every health assignment over it. */
function sweep(probes: readonly Probe[]): {
  cases: number;
  diffs: { lanes: string; before: string; after: string }[];
} {
  const diffs: { lanes: string; before: string; after: string }[] = [];
  let cases = 0;
  for (let mask = 1; mask < 1 << probes.length; mask += 1) {
    const chosen = probes.filter((_, index) => (mask >> index) & 1);
    for (let h = 0; h < HEALTHS.length ** chosen.length; h += 1) {
      let remaining = h;
      const healths = chosen.map(() => {
        const health = HEALTHS[remaining % HEALTHS.length]!;
        remaining = Math.floor(remaining / HEALTHS.length);
        return health;
      });
      const before = assignmentKey(lanesFor(chosen, healths, false));
      const after = assignmentKey(lanesFor(chosen, healths, true));
      cases += 1;
      if (before !== after) {
        diffs.push({
          lanes: chosen
            .map((lane, index) => `${lane.vendor}:${healths[index]}`)
            .join(" "),
          before,
          after,
        });
      }
    }
  }
  return { cases, diffs };
}

describe("cost is supplied from the registry — the before/after fixture", () => {
  it("moves NO production assignment, over every lane subset × health mix", async () => {
    const probes = await probeAdapters();
    // Guards the guard: if the fake seam ever leaked into a default probe, the
    // sweep below would silently be measuring something else.
    expect(probes.map((probe) => probe.vendor)).not.toContain("fake");

    const { cases, diffs } = sweep(probes);

    // 4 lanes → (2^4 - 1) subsets, each with 2^|subset| health mixes = 80.
    expect(cases).toBe(80);
    expect(diffs).toEqual([]);
  });

  it("supplies exactly the registry's number for every registered lane", async () => {
    for (const probe of await probeAdapters()) {
      expect(isVendorId(probe.vendor)).toBe(true);
      if (!isVendorId(probe.vendor)) continue;
      expect(vendorCost(probe.vendor)).toBe(VENDOR_REGISTRY[probe.vendor].cost);
    }
  });

  it("keeps an unregistered lane on the engine's own neutral default", () => {
    // 0.5 is what `role-assignment`'s `?? 0.5` already gave every lane, so an id
    // the registry does not name ranks EXACTLY as it did before Wave F. It is
    // deliberately not 0 — for `scout`, 0 is the strongest possible bonus, and an
    // unknown id must not out-rank a registered lane by being unknown.
    expect(vendorCost("kiro")).toBe(0.5);
    expect(vendorCost("")).toBe(0.5);
  });

  it("only ranks: no cost value can reach a role the ceiling refuses", async () => {
    // The whole safety claim for this field in one assertion. OpenCode is the
    // cheapest registered lane (0.3), so if cost could ever admit, it would admit
    // here first — and its ceiling is `["scout"]`.
    const probes = await probeAdapters();
    const cheapest = [...probes].sort(
      (a, b) => vendorCost(a.vendor) - vendorCost(b.vendor)
    )[0]!;
    const lanes = lanesFor(
      probes,
      probes.map(() => "healthy" as const),
      true
    );
    const plan = assignRoles({ chatId: "chat-cost-fixture", lanes });
    for (const binding of plan.bindings) {
      if (binding.vendor !== cheapest.vendor) continue;
      expect(cheapest.supportedRoles).toContain(binding.role);
    }
  });
});

describe("cost is supplied from the registry — the dev/test seam's own diff", () => {
  it("moves `docs` off a DEGRADED fake and onto a HEALTHY real lane", async () => {
    // Recorded rather than hidden. With MUON_FAKE_VENDOR=1 the sweep does find
    // assignment diffs, and every one of them has the same shape: a `degraded`
    // fake lane loses `docs` to a `healthy` claude-code that already holds four
    // roles, because `docs` is a WRITE role and the write-role adjustment is
    // `cost * 0.05` — 0.045 for claude-code (0.9) against 0.025 for the fake
    // (0.5, unchanged by construction). Before, the fake won that comparison by
    // 0.01 purely because the term was constant.
    //
    // This is the cost term doing exactly what ADR-0020 said it would: keeping a
    // weak lane off a role where a weak model is actively harmful. The knock-on
    // `scout` move in one case follows from the freed reuse budget, not from cost.
    const probes = await probeAdapters();
    const withFake: Probe[] = [
      ...probes,
      {
        vendor: "fake",
        displayName: "Fake Vendor (dev/test)",
        capabilities: probes[0]!.capabilities,
        supportedRoles: [...VENDOR_REGISTRY.fake.authority.supportedRoles],
        roleAffinity: VENDOR_REGISTRY.fake.roleAffinity,
      },
    ];

    const { diffs } = sweep(withFake);

    // Every diff involves the fake seam, and none is production-reachable.
    expect(diffs.length).toBeGreaterThan(0);
    for (const diff of diffs) {
      expect(diff.lanes).toContain("fake:degraded");
    }
    // Every diff takes `docs` off the fake; none puts a role ONTO it.
    for (const diff of diffs) {
      expect(diff.before).toContain("docs=fake");
      expect(diff.after).not.toContain("docs=fake");
    }
  });
});
