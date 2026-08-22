import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MuonGraph } from "../src/muon-graph.js";
import type { MemoryNoteRecord } from "../src/muon-graph.js";

/**
 * ADR-0061 — the graph half of "recall says what it withheld".
 *
 * What is pinned is the KEEP/DISCLOSE boundary, not the plumbing: the cap
 * tail comes back as candidates, the policy stubs come from same-fence
 * inverted-status queries (so a foreign-workspace paused note can never
 * stub), the gated read's fence holds inside the disclosure query, stale
 * demotion stubs on the search path, and the undisclosed façade is
 * byte-identical to the disclosed one's `notes` (behavior freeze).
 */

const WORKSPACE = "/repo/alpha";
const OTHER_WORKSPACE = "/repo/beta";
const TASK = "task-disclose";
const PAST = "2026-01-01T00:00:00.000Z";

function record(
  id: string,
  patch: Partial<MemoryNoteRecord> = {}
): MemoryNoteRecord & { workspacePath?: string; expiresAt?: string | null } {
  return {
    id,
    kind: "decision",
    text: `text ${id}`,
    taskId: TASK,
    laneId: null,
    modules: [],
    topics: [],
    symbols: [],
    trust: "medium",
    confirmed: false,
    stale: false,
    status: "active",
    scope: "project",
    createdBy: "agent:job:seed",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    validFrom: "2026-07-20T00:00:00.000Z",
    invalidatedAt: null,
    invalidatedBy: null,
    staleSince: null,
    supersededBy: null,
    accessCount: 0,
    lastAccessedAt: null,
    conflictsWith: null,
    workspacePath: WORKSPACE,
    expiresAt: null,
    ...patch,
  } as MemoryNoteRecord & { workspacePath?: string; expiresAt?: string | null };
}

let graph: MuonGraph;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-withheld-"));
  graph = new MuonGraph(join(dir, "withheld.lbug"), { disableFts: true });
  await graph.init();

  // Four live notes on the task (createdAt descending seeds the cap order).
  for (let index = 0; index < 4; index += 1) {
    await graph.projectMemoryNote(
      record(`live-${index}`, {
        createdAt: `2026-07-2${index}T00:00:00.000Z`,
        validFrom: `2026-07-2${index}T00:00:00.000Z`,
      })
    );
  }
  // Policy-hidden in the SAME fence: one paused, one expired (agent-created,
  // unconfirmed, medium — none of the expiry immunities apply).
  await graph.projectMemoryNote(record("paused-own", { status: "paused" }));
  await graph.projectMemoryNote(record("expired-own", { expiresAt: PAST }));
  // A CONFIRMED note with a past stamp is NOT expired (the clause's own
  // immunity) — it must never stub as expired.
  await graph.projectMemoryNote(
    record("confirmed-past-stamp", { confirmed: true, expiresAt: PAST })
  );
  // Policy-hidden across the WORKSPACE fence: must never stub (the wall).
  await graph.projectMemoryNote(
    record("paused-foreign", {
      status: "paused",
      workspacePath: OTHER_WORKSPACE,
    })
  );
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("recall disclosure (exact)", () => {
  it("the cap tail comes back as candidates, and the served notes freeze against the undisclosed façade", async () => {
    const disclosed = await graph.retrieveMemoryDisclosed(
      { taskId: TASK, workspacePath: WORKSPACE },
      2
    );
    expect(disclosed.notes).toHaveLength(2);
    const capIds = disclosed.withheldCandidates
      .filter((candidate) => candidate.reason === "cap")
      .map((candidate) => candidate.note.id);
    // 4 live match; 2 served; 2 cap candidates (confirmed-past-stamp is
    // live too and joins the pool: 5 live total → 3 cap).
    expect(capIds).toHaveLength(3);
    const plain = await graph.retrieveMemory(
      { taskId: TASK, workspacePath: WORKSPACE },
      2
    );
    expect(plain.map((note) => note.id)).toEqual(
      disclosed.notes.map((note) => note.id)
    );
  });

  it("policy stubs are EXACT and fence-scoped: own-partition paused/expired stub, the foreign paused note never does", async () => {
    const disclosed = await graph.retrieveMemoryDisclosed(
      { taskId: TASK, workspacePath: WORKSPACE },
      10
    );
    const byReason = (reason: string) =>
      disclosed.withheldCandidates
        .filter((candidate) => candidate.reason === reason)
        .map((candidate) => candidate.note.id);
    expect(byReason("paused")).toEqual(["paused-own"]);
    expect(byReason("expired")).toEqual(["expired-own"]);
    // The confirmed note's past stamp is not expiry — never a stub.
    expect(byReason("expired")).not.toContain("confirmed-past-stamp");
    // The wall: the foreign-workspace paused note is nowhere in the answer.
    const allIds = disclosed.withheldCandidates.map(
      (candidate) => candidate.note.id
    );
    expect(allIds).not.toContain("paused-foreign");
  });

  it("a GATED read's fence holds INSIDE the disclosure: an unconfirmed paused note never stubs for a governed caller", async () => {
    const disclosed = await graph.retrieveMemoryDisclosed(
      { taskId: TASK, workspacePath: WORKSPACE, governedOnly: true },
      10
    );
    const pausedIds = disclosed.withheldCandidates
      .filter((candidate) => candidate.reason === "paused")
      .map((candidate) => candidate.note.id);
    // paused-own is UNCONFIRMED — the confirmed/trust OR (the fence half of
    // the gate) keeps it out of the disclosure query too.
    expect(pausedIds).toEqual([]);
  });

  it("a bitemporal recall discloses nothing — the as-of view has no withheld semantics", async () => {
    const disclosed = await graph.retrieveMemoryDisclosed(
      {
        taskId: TASK,
        workspacePath: WORKSPACE,
        asOf: "2026-07-25T00:00:00.000Z",
      },
      2
    );
    const policy = disclosed.withheldCandidates.filter(
      (candidate) =>
        candidate.reason === "paused" || candidate.reason === "expired"
    );
    expect(policy).toEqual([]);
    // And the SEARCH branch holds the same rule.
    const searched = await graph.retrieveMemoryDisclosed(
      {
        q: "text",
        workspacePath: WORKSPACE,
        asOf: "2026-07-25T00:00:00.000Z",
      },
      2
    );
    expect(
      searched.withheldCandidates.filter(
        (candidate) =>
          candidate.reason === "paused" || candidate.reason === "expired"
      )
    ).toEqual([]);
  });
});

describe("search disclosure", () => {
  it("stale demotion stubs as 'stale'; clean tail notes count as 'cap'", async () => {
    await graph.projectMemoryNote(
      record("stale-hit", {
        stale: true,
        staleSince: "2026-07-21T00:00:00.000Z",
        text: "retry budget guidance stale",
      })
    );
    await graph.projectMemoryNote(
      record("fresh-hit-1", { text: "retry budget guidance one" })
    );
    await graph.projectMemoryNote(
      record("fresh-hit-2", { text: "retry budget guidance two" })
    );
    const disclosed = await graph.retrieveMemoryDisclosed(
      { q: "retry budget guidance", workspacePath: WORKSPACE },
      1
    );
    expect(disclosed.notes).toHaveLength(1);
    const reasons = new Map(
      disclosed.withheldCandidates.map((candidate) => [
        candidate.note.id,
        candidate.reason,
      ])
    );
    // The stale note ranks below every clean note (tier demotion) and stubs
    // as 'stale', never silently as more cap.
    expect(reasons.get("stale-hit")).toBe("stale");
    expect(
      [...reasons.values()].filter((reason) => reason === "cap").length
    ).toBeGreaterThan(0);
  });

  it("policy stubs surface on SEARCH at lexical parity — and the workspace fence still holds", async () => {
    await graph.projectMemoryNote(
      record("paused-searchable", {
        status: "paused",
        text: "retry budget guidance paused note",
      })
    );
    await graph.projectMemoryNote(
      record("paused-foreign-search", {
        status: "paused",
        text: "retry budget guidance foreign",
        workspacePath: OTHER_WORKSPACE,
      })
    );
    await graph.projectMemoryNote(
      record("paused-offtopic", {
        status: "paused",
        text: "nothing about that subject at all",
      })
    );
    const disclosed = await graph.retrieveMemoryDisclosed(
      { q: "retry budget guidance", workspacePath: WORKSPACE },
      5
    );
    const pausedIds = disclosed.withheldCandidates
      .filter((candidate) => candidate.reason === "paused")
      .map((candidate) => candidate.note.id);
    expect(pausedIds).toContain("paused-searchable");
    // The wall: a foreign-workspace paused note never stubs, however well
    // it matches the text.
    expect(pausedIds).not.toContain("paused-foreign-search");
    // Lexical parity: a paused note that would NOT have matched this search
    // is not "withheld" from it.
    expect(pausedIds).not.toContain("paused-offtopic");
  });
});
