import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MuonGraph } from "../src/muon-graph.js";

/**
 * Substrate §3.3 — pathTriggeredStanding: kind-filtered, gate-tiered, anchored.
 * Distinct from standingMemory (global canon, no anchors).
 */

let graph: MuonGraph;
let dir: string;
const WS = "/repo/path-trigger";
const MOD = "src/auth/session.ts";
const OTHER = "src/other/unrelated.ts";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-path-standing-"));
  graph = new MuonGraph(join(dir, "test.lbug"), { disableFts: true });
  await graph.init();
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

async function confirm(id: string) {
  await graph.updateMemoryNote(id, { confirmed: true });
}

describe("pathTriggeredStanding", () => {
  it("returns confirmed constraint/convention on the anchor; excludes decisions and unconfirmed", async () => {
    const constraint = await graph.addMemoryNote({
      kind: "constraint",
      text: "Never store session tokens in localStorage",
      modules: [MOD],
      trust: "high",
      createdBy: "human",
      workspacePath: WS,
    });
    await confirm(constraint.id);

    const convention = await graph.addMemoryNote({
      kind: "convention",
      text: "Session cookies are HttpOnly",
      modules: [MOD],
      trust: "high",
      createdBy: "human",
      workspacePath: WS,
    });
    await confirm(convention.id);

    const decision = await graph.addMemoryNote({
      kind: "decision",
      text: "We chose cookie sessions over JWT",
      modules: [MOD],
      trust: "high",
      createdBy: "human",
      workspacePath: WS,
    });
    await confirm(decision.id);

    const unconfirmed = await graph.addMemoryNote({
      kind: "constraint",
      text: "Hostile unconfirmed constraint",
      modules: [MOD],
      trust: "low",
      createdBy: "agent:intruder",
      workspacePath: WS,
    });

    const otherMod = await graph.addMemoryNote({
      kind: "constraint",
      text: "Unrelated module constraint",
      modules: [OTHER],
      trust: "high",
      createdBy: "human",
      workspacePath: WS,
    });
    await confirm(otherMod.id);

    const hit = await graph.pathTriggeredStanding(
      { modules: [MOD], workspacePath: WS },
      { limit: 16 }
    );
    const ids = hit.map((n) => n.id);
    expect(ids).toContain(constraint.id);
    expect(ids).toContain(convention.id);
    expect(ids).not.toContain(decision.id);
    expect(ids).not.toContain(unconfirmed.id);
    expect(ids).not.toContain(otherMod.id);
  });

  it("empty anchor set returns [] (fail closed, not whole corpus)", async () => {
    const empty = await graph.pathTriggeredStanding(
      { modules: [], workspacePath: WS },
      { limit: 16 }
    );
    expect(empty).toEqual([]);
  });
});
