import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MuonGraph } from "../src/muon-graph.js";

// ── TODO 4.1: the STANDING-MEMORY arm's fixed posture ────────────────────────
//
// standingMemory() is its own selection — kind × human-confirmed × active ×
// workspace — NOT a retrieval mode. These tests pin the posture's every edge:
// human-confirmed only (a vouch is not a confirmation), constraint/convention
// only, stale/retired excluded, chat-INDEPENDENT (canon crosses chats), and the
// ADR-0026 workspace fence applied in the candidate query in both directions.

let graph: MuonGraph;
let dir: string;

const WS_A = "/repo/alpha";
const WS_B = "/repo/beta";

let confirmedConstraintA: string; // confirmed constraint, ws A, chat-1 → IN
let confirmedConventionA: string; // confirmed convention, ws A, chat-2 → IN (crosses chats)
let confirmedDecisionA: string; // confirmed DECISION, ws A → OUT (wrong kind)
let unconfirmedConstraintA: string; // unconfirmed constraint, ws A → OUT
let confirmedConstraintB: string; // confirmed constraint, ws B → OUT for ws A
let staleConstraintA: string; // confirmed but STALE, ws A → OUT
let nullWsConstraint: string; // confirmed GLOBAL constraint, NO workspace → OUT for ws A
let projectConstraintA: string; // confirmed but PROJECT scope, ws A → OUT (not promoted)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-standing-"));
  graph = new MuonGraph(join(dir, "test.lbug"));
  await graph.init();

  const confirm = async (id: string) => {
    await graph.updateMemoryNote(id, { confirmed: true });
  };

  // Canon = human-confirmed AND promoted to `scope:"global"` — the ONE existing
  // cross-chat rule the standing arm reuses (it does not invent a second one).
  const a1 = await graph.addMemoryNote({
    kind: "constraint",
    text: "Never custody vendor tokens",
    trust: "high",
    createdBy: "human",
    chatId: "chat-1",
    scope: "global",
    workspacePath: WS_A,
  });
  confirmedConstraintA = a1.id;
  await confirm(a1.id);

  const a2 = await graph.addMemoryNote({
    kind: "convention",
    text: "Error messages state the fix, not just the failure",
    trust: "high",
    createdBy: "human",
    chatId: "chat-2",
    scope: "global",
    workspacePath: WS_A,
  });
  confirmedConventionA = a2.id;
  await confirm(a2.id);

  // A human-confirmed PROJECT-scope constraint in WS_A: it is NOT canon —
  // project scope stays chat-bound on every read, and the standing arm must
  // exclude it exactly as it reuses the existing cross-chat rule.
  const aProj = await graph.addMemoryNote({
    kind: "constraint",
    text: "A confirmed but project-scoped (not promoted) constraint",
    trust: "high",
    createdBy: "human",
    chatId: "chat-1",
    scope: "project",
    workspacePath: WS_A,
  });
  projectConstraintA = aProj.id;
  await confirm(aProj.id);

  const a3 = await graph.addMemoryNote({
    kind: "decision",
    text: "We chose RRF over additive scoring",
    trust: "high",
    createdBy: "human",
    workspacePath: WS_A,
  });
  confirmedDecisionA = a3.id;
  await confirm(a3.id);

  const a4 = await graph.addMemoryNote({
    kind: "constraint",
    text: "An agent-proposed constraint nobody reviewed",
    trust: "medium",
    createdBy: "agent:codex",
    chatId: "chat-1",
    workspacePath: WS_A,
  });
  unconfirmedConstraintA = a4.id;

  const b1 = await graph.addMemoryNote({
    kind: "constraint",
    text: "Repo beta's own constraint",
    trust: "high",
    createdBy: "human",
    scope: "global",
    workspacePath: WS_B,
  });
  confirmedConstraintB = b1.id;
  await confirm(b1.id);

  const a5 = await graph.addMemoryNote({
    kind: "constraint",
    text: "A confirmed constraint that later went stale",
    trust: "high",
    createdBy: "human",
    scope: "global",
    workspacePath: WS_A,
    modules: ["src/stale-target.ts"],
  });
  staleConstraintA = a5.id;
  await confirm(a5.id);
  // Staleness arrives the production way: the anchored module was touched
  // after the note's validFrom (touchModules is the ONLY stale producer).
  await graph.touchModules(
    ["src/stale-target.ts"],
    new Date(Date.now() + 1_000).toISOString()
  );

  const n1 = await graph.addMemoryNote({
    kind: "constraint",
    text: "A confirmed constraint with no workspace (pre-0041 residue)",
    trust: "high",
    createdBy: "human",
    scope: "global",
  });
  nullWsConstraint = n1.id;
  await confirm(n1.id);
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("standingMemory — the fixed posture", () => {
  it("returns exactly the human-confirmed, current constraint/convention canon of ONE workspace", async () => {
    const standing = await graph.standingMemory({ workspacePath: WS_A });
    const ids = standing.map((note) => note.id);
    expect(ids).toContain(confirmedConstraintA);
    expect(ids).toContain(confirmedConventionA);
    // Wrong kind: a decision is ABOUT something; it is not standing canon.
    expect(ids).not.toContain(confirmedDecisionA);
    // Unconfirmed: a vouch is not a confirmation and there is no crew knob.
    expect(ids).not.toContain(unconfirmedConstraintA);
    // Stale: suspect canon must not ride into every brief silently.
    expect(ids).not.toContain(staleConstraintA);
    // The fence, both directions (ADR-0026): B's canon never reaches A…
    expect(ids).not.toContain(confirmedConstraintB);
    // …and the NULL-workspace residue is excluded by construction.
    expect(ids).not.toContain(nullWsConstraint);
    // PROJECT scope is not canon: a confirmed-but-unpromoted note stays
    // chat-bound and never rides the standing arm (the cross-chat rule reused).
    expect(ids).not.toContain(projectConstraintA);
  });

  it("is chat-INDEPENDENT: canon confirmed in one chat reaches a brief in another", async () => {
    // Both A-notes carry different chatIds and BOTH are returned above with no
    // chat coordinate supplied — pinned separately so a future chat parameter
    // cannot creep in unnoticed.
    const standing = await graph.standingMemory({ workspacePath: WS_A });
    const chats = new Set(standing.map((note) => note.chatId));
    expect(chats.size).toBeGreaterThan(1);
  });

  it("the other workspace sees ITS canon and nothing of A's (both directions)", async () => {
    const standing = await graph.standingMemory({ workspacePath: WS_B });
    const ids = standing.map((note) => note.id);
    expect(ids).toEqual([confirmedConstraintB]);
  });

  it("no workspace coordinate → the unfenced view (monotonic rollout, the ADR's own posture)", async () => {
    const standing = await graph.standingMemory({});
    const ids = standing.map((note) => note.id);
    // Still confirmed-only and kind-fenced…
    expect(ids).not.toContain(unconfirmedConstraintA);
    expect(ids).not.toContain(confirmedDecisionA);
    // …but spans workspaces, exactly like every other absent-coordinate read.
    expect(ids).toContain(confirmedConstraintA);
    expect(ids).toContain(confirmedConstraintB);
    expect(ids).toContain(nullWsConstraint);
    // Still scope-fenced: a project note never rides, coordinate or not.
    expect(ids).not.toContain(projectConstraintA);
  });

  it("MUTATION GUARD: retiring a note removes it from the standing arm", async () => {
    const doomed = await graph.addMemoryNote({
      kind: "constraint",
      text: "A short-lived constraint",
      trust: "high",
      createdBy: "human",
      scope: "global",
      workspacePath: WS_A,
    });
    await graph.updateMemoryNote(doomed.id, { confirmed: true });
    const before = await graph.standingMemory({ workspacePath: WS_A });
    expect(before.map((note) => note.id)).toContain(doomed.id);
    await graph.updateMemoryNote(doomed.id, { status: "rejected" });
    const after = await graph.standingMemory({ workspacePath: WS_A });
    expect(after.map((note) => note.id)).not.toContain(doomed.id);
  });
});
