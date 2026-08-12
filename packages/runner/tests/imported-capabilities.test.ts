import { describe, expect, it, vi } from "vitest";
import { emptyLaneProfile, type LaneProfile, type McpServerConfig } from "@muon/protocol";
import {
  laneMayReceiveImports,
  mergeImportedServers,
  resolveImportedServers,
} from "../src/imported-capabilities.js";

/**
 * ADR-0038 D8 — the gate between "a human enabled this" and "this runs".
 *
 * The founder decided an enabled server may reach an agent-dispatched lane.
 * These are the two bounds that make that safe on the runner's side: WHICH
 * dispatched lane, and what a name collision means.
 */

function profile(over: Partial<LaneProfile> = {}): LaneProfile {
  return { ...emptyLaneProfile, ...over };
}

function imported(name: string): McpServerConfig {
  return { name, command: "npx", args: ["-y", `${name}-mcp`], env: {} };
}

describe("which lane may hold an imported server", () => {
  it("a plain worker may — that is what D8 was answered for", () => {
    expect(laneMayReceiveImports("worker")).toBe(true);
  });

  it("a DELEGATE may not: it inherits nothing it was not explicitly given", () => {
    expect(laneMayReceiveImports("delegate")).toBe(false);
  });

  it("an ORCHESTRATOR may not: it spawns children MUON cannot watch narrow", () => {
    // ADR-0019 §2.6, quoted in D6: where narrowing cannot be observed, MUON
    // assumes inheritance and keeps imported items out of parents that spawn
    // children.
    expect(laneMayReceiveImports("orchestrator")).toBe(false);
  });

  it("is a POSITIVE test, so a fourth mode arrives DENIED", () => {
    // ADR-0022 rule 2. Written as a subtraction, a capability mode added later
    // would land inside the grant with nobody deciding that — the failure this
    // repo has now paid for four times.
    expect(
      laneMayReceiveImports("supervisor" as unknown as "worker"),
      "an unknown mode must not inherit the grant"
    ).toBe(false);
  });
});

describe("merging into the profile that will run", () => {
  it("appends what the human enabled", () => {
    const merged = mergeImportedServers(profile(), [imported("linear")]);
    expect(merged.profile!.mcpServers.map((s) => s.name)).toEqual(["linear"]);
    expect(merged.rejected).toEqual([]);
  });

  it("keeps the operator's own servers alongside", () => {
    const merged = mergeImportedServers(
      profile({ mcpServers: [imported("internal")] }),
      [imported("linear")]
    );
    expect(merged.profile!.mcpServers.map((s) => s.name)).toEqual([
      "internal",
      "linear",
    ]);
  });

  it("REFUSES an imported server named `muon`", () => {
    // It would share a key with MUON's governed MCP in the vendor's server map
    // and, depending on that vendor's merge order, could replace it — a
    // third-party binary answering the tool calls MUON's whole governance model
    // assumes it answers itself.
    const merged = mergeImportedServers(profile(), [imported("muon")]);
    expect(merged.profile!.mcpServers).toEqual([]);
    expect(merged.rejected[0]!.reason).toContain("MUON's own governed MCP");
  });

  it("REFUSES to shadow a server the operator already authored", () => {
    const operatorOwned = { ...imported("linear"), command: "/usr/local/bin/safe" };
    const merged = mergeImportedServers(
      profile({ mcpServers: [operatorOwned] }),
      [imported("linear")]
    );
    expect(merged.profile!.mcpServers).toHaveLength(1);
    expect(
      merged.profile!.mcpServers[0]!.command,
      "the operator-authored one runs"
    ).toBe("/usr/local/bin/safe");
    expect(merged.rejected[0]!.reason).toContain("already defines a server");
  });

  it("REPORTS every refusal rather than dropping it quietly", () => {
    // A server a human enabled that then did not reach the lane is a fact they
    // have to be told, or the feature lies about what it did.
    const merged = mergeImportedServers(profile({ mcpServers: [imported("a")] }), [
      imported("muon"),
      imported("a"),
      imported("b"),
    ]);
    expect(merged.rejected.map((r) => r.name)).toEqual(["muon", "a"]);
    expect(merged.profile!.mcpServers.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("leaves a withheld profile withheld when there is nothing to add", () => {
    // A delegate gets no lane profile at all, and merging must not conjure one
    // out of nothing.
    const merged = mergeImportedServers(undefined, []);
    expect(merged.profile).toBeUndefined();
  });

  it("does NOT silently drop approved imports if a profile is somehow absent", () => {
    // Unreachable in production — eligibility is checked before the merge and
    // an eligible worker always has a profile — but if it ever were reached,
    // losing servers a human approved is the worst available outcome.
    const merged = mergeImportedServers(undefined, [imported("linear")]);
    expect(merged.profile!.mcpServers.map((s) => s.name)).toEqual(["linear"]);
  });

  it("a WORKER with no stored lane profile still gets its imports", () => {
    // The shape production actually produces: `applyHarnessToProfile` merges
    // over an absent stored profile and always returns one.
    const merged = mergeImportedServers(profile(), [imported("linear")]);
    expect(merged.profile!.mcpServers.map((s) => s.name)).toEqual(["linear"]);
  });

  it("does not touch the profile when there is nothing to add", () => {
    const original = profile({ mcpServers: [imported("internal")] });
    const merged = mergeImportedServers(original, []);
    expect(merged.profile).toBe(original);
  });

  it("never mutates the profile it was given", () => {
    const original = profile({ mcpServers: [imported("internal")] });
    mergeImportedServers(original, [imported("linear")]);
    expect(original.mcpServers.map((s) => s.name)).toEqual(["internal"]);
  });
});

describe("the lifecycle, end to end and without a dispatch", () => {
  const worker = "worker" as const;

  function recorder() {
    const seen: Array<{ message: string; metadata: Record<string, unknown> }> = [];
    return {
      seen,
      record: async (event: { message: string; metadata: Record<string, unknown> }) => {
        seen.push(event);
        return undefined;
      },
    };
  }

  it("attests, merges, and hands the lane what survived", async () => {
    const { record, seen } = recorder();
    const result = await resolveImportedServers({
      attest: async () => ({ servers: [imported("linear")], disabled: [] }),
      record,
      laneKey: "claude",
      capabilityMode: worker,
      profile: profile(),
    });
    expect(result!.mcpServers.map((s) => s.name)).toEqual(["linear"]);
    expect(seen, "a clean attestation is not noise").toEqual([]);
  });

  it("REPORTS every drift the attestation disabled", async () => {
    // A server a human enabled and that then vanished is a fact they have to
    // be told; a silent disappearance reads as a bug in MUON.
    const { record, seen } = recorder();
    await resolveImportedServers({
      attest: async () => ({
        servers: [],
        disabled: [
          {
            name: "linear",
            vendor: "claude",
            reason: "its shape changed",
            approvedDigest: "sha256:a",
            observedDigest: "sha256:b",
          },
        ],
      }),
      record,
      laneKey: "claude",
      capabilityMode: worker,
      profile: profile(),
    });
    expect(seen[0]!.message).toContain("disabled");
    expect(seen[0]!.metadata.importedCapability).toBe("disabled-drift");
  });

  it("a FAILED attestation yields nothing, and says so", async () => {
    // Fail-closed: fewer capabilities, never the stored set. And recorded,
    // because a silent fail-closed is indistinguishable from "you enabled
    // nothing".
    const { record, seen } = recorder();
    const result = await resolveImportedServers({
      attest: async () => {
        throw new Error("brain unreachable");
      },
      record,
      laneKey: "claude",
      capabilityMode: worker,
      profile: profile({ mcpServers: [imported("internal")] }),
    });
    expect(result!.mcpServers.map((s) => s.name)).toEqual(["internal"]);
    expect(seen[0]!.metadata.importedCapability).toBe("attestation-failed");
  });

  it("does not even ASK for a delegate or an orchestrator", async () => {
    for (const mode of ["delegate", "orchestrator"] as const) {
      const attest = vi.fn();
      const { record } = recorder();
      await resolveImportedServers({
        attest,
        record,
        laneKey: "claude",
        capabilityMode: mode,
        profile: profile(),
      });
      expect(attest, mode).not.toHaveBeenCalled();
    }
  });

  it("reports a merge refusal too", async () => {
    const { record, seen } = recorder();
    await resolveImportedServers({
      attest: async () => ({ servers: [imported("muon")], disabled: [] }),
      record,
      laneKey: "claude",
      capabilityMode: worker,
      profile: profile(),
    });
    expect(seen[0]!.metadata.importedCapability).toBe("rejected");
    expect(seen[0]!.message).toContain("MUON's own governed MCP");
  });
});
