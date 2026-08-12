import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MuonGraph } from "../src/muon-graph.js";

// ── ADR-0026 step 1+2: the GRAPH MIRROR carries the workspace partition ───────
//
// The relational ledger is the authority and this node property is a rebuildable
// projection, but a projection that silently drops the partition is how a wipe →
// reproject would hand every workspace's notes back to all of them. Two shapes are
// pinned here, both mirroring what `chatId` already does:
//
//   • A workspace-carrying write round-trips through the store.
//   • An UNASSIGNED note stores '' and reads back as `null` — never as a note
//     assigned to the empty-string workspace, which would be a real partition.
//
// No read predicate exists yet (step 3), and these tests deliberately assert that
// too: a recall with no workspace coordinate still returns both notes.

const MOD = "src/pay/charge.ts";
const WORKSPACE_A = "/Users/dev/SWE/repo-a";

let graph: MuonGraph;
let dir: string;
let scopedId: string;
let unassignedId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-ws-mirror-"));
  graph = new MuonGraph(join(dir, "test.lbug"));
  await graph.init();

  const scoped = await graph.addMemoryNote({
    kind: "decision",
    text: "Charges are idempotent by request key (repo A)",
    modules: [MOD],
    trust: "high",
    createdBy: "human",
    chatId: "chat-a",
    workspacePath: WORKSPACE_A,
  });
  scopedId = scoped.id;

  const unassigned = await graph.addMemoryNote({
    kind: "constraint",
    text: "A note written before the partition existed",
    modules: [MOD],
    trust: "high",
    createdBy: "human",
  });
  unassignedId = unassigned.id;
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ADR-0026 graph mirror: MemoryNote.workspacePath", () => {
  it("round-trips a workspace-carrying note through the store", async () => {
    expect((await graph.getMemoryNote(scopedId))?.workspacePath).toBe(
      WORKSPACE_A
    );
  });

  it("reads an UNASSIGNED note back as null, not as the '' workspace", async () => {
    expect((await graph.getMemoryNote(unassignedId))?.workspacePath).toBeNull();
  });

  it("restores the partition on re-projection (the wipe→reproject path)", async () => {
    const record = await graph.getMemoryNote(scopedId);
    expect(record).not.toBeNull();
    await graph.projectMemoryNote({ ...record!, workspacePath: WORKSPACE_A });
    expect((await graph.getMemoryNote(scopedId))?.workspacePath).toBe(
      WORKSPACE_A
    );

    // And a record whose partition is absent projects as unassigned rather than
    // silently inheriting whatever the live node happened to hold.
    await graph.projectMemoryNote({ ...record!, workspacePath: null });
    expect((await graph.getMemoryNote(scopedId))?.workspacePath).toBeNull();
    await graph.projectMemoryNote({ ...record!, workspacePath: WORKSPACE_A });
  });

  it("adds NO read predicate in step 2: an unscoped recall still returns both notes", async () => {
    const found = await graph.recallMemory({ module: MOD });
    expect(found.map((note) => note.id).sort()).toEqual(
      [scopedId, unassignedId].sort()
    );
  });
});
