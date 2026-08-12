import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { selectMemorySliceNotes } from "@muon/core";

// ADR-0027 CREW CORROBORATION, end-to-end at the backend level: real SQLite
// ledger + real LadybugDB graph + the real HTTP routes, no mocks on the store.
//
// The founder's complaint was never about a queue, it was about coordination:
// "if they don't have each other's memory, they won't co-ordinate visually with
// each other's context." So the thing that has to be PROVEN is a full round
// trip — agent A writes, agent B independently corroborates, and the shared
// brief contains the one canonical note with NO human anywhere in the path.
//
// The pieces this exercises are each individually correct and were, together,
// broken:
//   • ingest requires two distinct principals before the attributed vouch,
//   • the RECALL response carries `confirmedBy` (the vouch used to die at the
//     wire, so `selectMemorySliceNotes` never saw one),
//   • `selectMemorySliceNotes` admits a vouch, and
//   • the operator's review queue counts NONE of it.
// Any one of them regressing puts the crew back on human-confirmed-only memory
// with no error raised anywhere, which is exactly how this shipped broken.

const OPERATOR = "operator-token-crew-visibility";
const AGENT = "agent-token-crew-visibility";
const JOB_A_TOKEN = `job-crew-a-${"a".repeat(52)}`;
const JOB_B_TOKEN = `job-crew-b-${"b".repeat(52)}`;
const JOB_FOREIGN_TOKEN = `job-crew-foreign-${"f".repeat(46)}`;
const MISSION = "chat-crew-mission";
const MOD = "apps/cli/src/index.ts";
// Distinctive wording so the lexical recall matches deterministically (FTS off).
const A_TEXT =
  "The muon CLI version literal lives in apps/cli/src/index.ts, tango-victor";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;
let aNoteId: string;

/** The notes agent B's recall returns for this mission, as its brief would. */
async function recallForAgentB() {
  const response = await app.inject({
    method: "GET",
    url: `/api/memory/recall?module=${encodeURIComponent(MOD)}&chatId=${MISSION}`,
    headers: auth(JOB_B_TOKEN),
  });
  expect(response.statusCode).toBe(200);
  return response.json().notes as {
    id: string;
    text: string;
    confirmed: boolean;
    stale: boolean;
    confirmedBy: "human" | "orchestrator" | null;
  }[];
}

/** What the OPERATOR is being asked to review right now — the debt counter. */
async function pendingReviewCount(): Promise<number> {
  const response = await app.inject({
    method: "GET",
    url: `/api/memory/library?chatId=${MISSION}&confirmed=unvouched`,
    headers: auth(OPERATOR),
  });
  expect(response.statusCode).toBe(200);
  return response.json().total as number;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-crew-visibility-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();

  // ONE mission root with TWO children on two different tasks — the shape that
  // makes this a cross-agent test rather than a self-read. The root is real
  // because a chat may hold at most one active root (migration 0032), so two
  // bare roots on one chatId is not a state MUON can be in.
  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-crew-root",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-crew-root",
        chatId: MISSION,
        brief: "mission root: add a --version flag and document it",
        workspacePath: process.cwd(),
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-crew-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-crew-a",
        chatId: MISSION,
        parentJobId: "job-crew-root",
        rootJobId: "job-crew-root",
        delegationDepth: 1,
        brief: "child A: find the version literal",
        workspacePath: process.cwd(),
        status: "running",
        dispatchedBy: "orchestrator",
      },
      {
        id: "job-crew-b",
        kind: "oneshot",
        vendor: "claude-code",
        taskId: "task-crew-b",
        chatId: MISSION,
        parentJobId: "job-crew-root",
        rootJobId: "job-crew-root",
        delegationDepth: 1,
        brief: "child B: document the flag",
        workspacePath: process.cwd(),
        status: "running",
        dispatchedBy: "orchestrator",
      },
      {
        id: "job-crew-foreign",
        kind: "session",
        vendor: "codex",
        taskId: "task-crew-foreign",
        chatId: "chat-other-mission",
        workspacePath: process.cwd(),
        brief: "unrelated mission in the same repository",
        status: "running",
        dispatchedBy: "human",
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      {
        jobId: "job-crew-a",
        tokenHash: createHash("sha256").update(JOB_A_TOKEN).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        jobId: "job-crew-b",
        tokenHash: createHash("sha256").update(JOB_B_TOKEN).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        jobId: "job-crew-foreign",
        tokenHash: createHash("sha256")
          .update(JOB_FOREIGN_TOKEN)
          .digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ],
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await graphLib.awaitGraphMirrors();
  await app.close();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("ADR-0027 crew corroboration and visibility", () => {
  it("starts with an empty review queue", async () => {
    expect(await pendingReviewCount()).toBe(0);
  });

  it("agent A's first proposal stays unvouched and expiring", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(JOB_A_TOKEN),
      payload: {
        kind: "constraint",
        text: A_TEXT,
        modules: [MOD],
        // Authorship is derived from the authenticated capability, never the
        // body; the value here is deliberately ignored by the route.
        createdBy: "ignored-by-the-route",
        chatId: MISSION,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    aNoteId = response.json().note.id as string;

    const rows = await db.prisma.confirmation.findMany({
      where: { noteId: aNoteId },
    });
    expect(rows).toHaveLength(0);
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: aNoteId },
    });
    expect(row?.expiresAt).not.toBeNull();
    expect(await pendingReviewCount()).toBe(1);

    await graphLib.awaitGraphMirrors();
    const analytics = await app.inject({
      method: "GET",
      url: `/api/memory/analytics?chatId=${MISSION}`,
      headers: auth(JOB_A_TOKEN),
    });
    expect(analytics.statusCode, analytics.body).toBe(200);
    expect(
      analytics.json().noteScores.map((score: { noteId: string }) => score.noteId)
    ).not.toContain(aNoteId);
  });

  // Mission 420c8bf4 (2026-08-06): 0/3 cross-agent recalls, by topic AND by
  // noteId, while every note sat active in the ledger. A unique finding has ONE
  // author by definition, so the D12-C corroboration threshold (2 principals,
  // same textHash) can never admit it — and the recall route's post-filter
  // demanded exactly that vouch, undoing the #133 crew-visible admission the
  // graph gate had already made. The contract (memory-slice.ts): unvouched
  // notes stay OUT of briefs but remain reachable through explicit recall,
  // flagged as suspect. This pins the reachable half BEFORE any corroboration.
  it("a sibling recalls A's UNVOUCHED unique note (posture on) — briefs still exclude it", async () => {
    const notes = await recallForAgentB();
    const fromA = notes.find((note) => note.id === aNoteId);
    expect(fromA).toBeTruthy();
    // Flagged as suspect on the wire: nobody has vouched.
    expect(fromA!.confirmed).toBe(false);
    expect(fromA!.confirmedBy).toBeNull();
    // The BRIEF keeps the stricter bar: unvouched never steers a brief.
    expect(
      selectMemorySliceNotes(notes, 5).map((note) => note.id)
    ).not.toContain(aNoteId);

    // The D13 coordinate path resolves it too — a peer relaying a fresh note
    // id must not need a vouch that cannot exist yet.
    const byId = await app.inject({
      method: "GET",
      url: `/api/memory/recall?noteId=${aNoteId}&chatId=${MISSION}`,
      headers: auth(JOB_B_TOKEN),
    });
    expect(byId.statusCode, byId.body).toBe(200);
    expect(byId.json().notes.map((note: { id: string }) => note.id)).toEqual([
      aNoteId,
    ]);

    // Foreign mission: still nothing, vouch or no vouch.
    const foreign = await app.inject({
      method: "GET",
      url: `/api/memory/recall?noteId=${aNoteId}&chatId=chat-other-mission`,
      headers: auth(JOB_FOREIGN_TOKEN),
    });
    expect(foreign.json().notes).toEqual([]);

    // The pre-edit INFORM channel rides the same rule: B's preedit for the
    // module carries A's unvouched finding as a crew finding with an HONEST
    // confirmedBy: null (nobody vouched), never in the edit-gate `memories`.
    const preedit = await app.inject({
      method: "POST",
      url: "/api/memory/preedit",
      headers: auth(JOB_B_TOKEN),
      payload: { module: MOD, chatId: MISSION },
    });
    expect(preedit.statusCode, preedit.body).toBe(200);
    const preeditBody = preedit.json() as {
      memories: { id: string }[];
      crewFindings: { id: string; confirmedBy: string | null; tier: string }[];
    };
    expect(preeditBody.memories.map((note) => note.id)).not.toContain(aNoteId);
    const finding = preeditBody.crewFindings.find(
      (note) => note.id === aNoteId
    );
    expect(finding).toBeTruthy();
    expect(finding!.confirmedBy).toBeNull();
    expect(finding!.tier).toBe("crew_vouched");

    // A PAUSED note — the operator's "not now" — must dominate every
    // admission tier, including this inform channel: it was the one
    // agent-facing text path that never re-asked the gate.
    await db.prisma.memoryNote.update({
      where: { id: aNoteId },
      data: { status: "paused" },
    });
    try {
      const paused = await app.inject({
        method: "POST",
        url: "/api/memory/preedit",
        headers: auth(JOB_B_TOKEN),
        payload: { module: MOD, chatId: MISSION },
      });
      expect(paused.statusCode, paused.body).toBe(200);
      const pausedBody = paused.json() as {
        crewFindings: { id: string }[];
      };
      expect(pausedBody.crewFindings.map((note) => note.id)).not.toContain(
        aNoteId
      );
    } finally {
      await db.prisma.memoryNote.update({
        where: { id: aNoteId },
        data: { status: "active" },
      });
    }

    // The kill switch still kills: posture OFF hides the unvouched note from
    // live recall entirely.
    const settings = await import("../src/lib/operator-settings.js");
    await settings.setAutoConfirmAgentMemory(false);
    try {
      const off = await recallForAgentB();
      expect(off.map((note) => note.id)).not.toContain(aNoteId);
    } finally {
      await settings.setAutoConfirmAgentMemory(true);
    }
  });

  it("agent B's independent restatement vouches the canonical claim", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(JOB_B_TOKEN),
      payload: {
        kind: "constraint",
        text: A_TEXT,
        modules: [MOD],
        createdBy: "ignored-by-the-route",
        chatId: MISSION,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().note.id).toBe(aNoteId);
    expect(response.json().action).toBe("duplicate");

    const rows = await db.prisma.confirmation.findMany({
      where: { noteId: aNoteId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.principal).toBe(
      `agent:orchestrator:corroborated:${MISSION}`
    );
    const authLib = await import("../src/lib/auth.js");
    expect(authLib.isHumanPrincipal(rows[0]!.principal)).toBe(false);
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: aNoteId },
    });
    expect(row?.expiresAt).toBeNull();

    await graphLib.awaitGraphMirrors();
    const analytics = await app.inject({
      method: "GET",
      url: `/api/memory/analytics?chatId=${MISSION}`,
      headers: auth(JOB_B_TOKEN),
    });
    expect(analytics.statusCode, analytics.body).toBe(200);
    expect(
      analytics.json().noteScores.map((score: { noteId: string }) => score.noteId)
    ).toContain(aNoteId);
  });

  it("agent B's BRIEF SLICE contains agent A's note — with no human action at all", async () => {
    const notes = await recallForAgentB();
    const fromA = notes.find((note) => note.id === aNoteId);
    expect(fromA).toBeTruthy();
    // The wire carries WHO vouched. Without this field the slice below silently
    // drops the note and the crew stops sharing context.
    expect(fromA!.confirmed).toBe(false);
    expect(fromA!.confirmedBy).toBe("orchestrator");

    // The runner's own selector, on the runner's own input — the brief itself.
    const surfaced = selectMemorySliceNotes(notes, 5);
    expect(surfaced.map((note) => note.id)).toContain(aNoteId);
  });

  it("splits crew prose from the edit gate at the live pre-edit boundary", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/memory/preedit",
      headers: auth(JOB_B_TOKEN),
      payload: { module: MOD, chatId: MISSION },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      memories: { id: string }[];
      crewFindings: {
        id: string;
        confirmed: boolean;
        confirmedBy: string;
        tier: string;
        authority: string;
      }[];
    };
    expect(body.memories.map((note) => note.id)).not.toContain(aNoteId);
    expect(body.crewFindings).toContainEqual(
      expect.objectContaining({
        id: aNoteId,
        confirmed: false,
        confirmedBy: "orchestrator",
        tier: "crew_vouched",
        authority: "inform",
      })
    );
  });

  it("D13 resolves a peer note id in-mission and hides it from another mission", async () => {
    const local = await app.inject({
      method: "GET",
      url: `/api/memory/recall?noteId=${aNoteId}&chatId=${MISSION}`,
      headers: auth(JOB_B_TOKEN),
    });
    expect(local.statusCode, local.body).toBe(200);
    expect(local.json().notes.map((note: { id: string }) => note.id)).toEqual([
      aNoteId,
    ]);

    const foreign = await app.inject({
      method: "GET",
      url: `/api/memory/recall?noteId=${aNoteId}&chatId=chat-other-mission`,
      headers: auth(JOB_FOREIGN_TOKEN),
    });
    expect(foreign.statusCode, foreign.body).toBe(200);
    expect(foreign.json().notes).toEqual([]);
  });

  // Agents abbreviate ids in their own reports ("mem-dd6bfe9a"), and the
  // exact-only lookup answered "no such note" for a note that existed — a
  // live coordinator escalated that into a false "memory_add loses notes"
  // finding (2026-08-06). A UNIQUE ≥8-hex prefix now resolves, git-style;
  // ambiguity or no match still reads as [] (no existence oracle).
  it("resolves a unique SHORT-ID prefix through the same fences", async () => {
    const shortId = aNoteId.slice(0, "mem-".length + 8);
    const local = await app.inject({
      method: "GET",
      url: `/api/memory/recall?noteId=${shortId}&chatId=${MISSION}`,
      headers: auth(JOB_B_TOKEN),
    });
    expect(local.statusCode, local.body).toBe(200);
    expect(local.json().notes.map((note: { id: string }) => note.id)).toEqual([
      aNoteId,
    ]);

    // The fences still apply to a prefix-resolved note: a foreign mission
    // sees nothing, exactly as with the full id.
    const foreign = await app.inject({
      method: "GET",
      url: `/api/memory/recall?noteId=${shortId}&chatId=chat-other-mission`,
      headers: auth(JOB_FOREIGN_TOKEN),
    });
    expect(foreign.statusCode, foreign.body).toBe(200);
    expect(foreign.json().notes).toEqual([]);

    // A prefix that matches nothing reads as missing, never an error.
    const nothing = await app.inject({
      method: "GET",
      url: `/api/memory/recall?noteId=mem-00000000&chatId=${MISSION}`,
      headers: auth(JOB_B_TOKEN),
    });
    expect(nothing.statusCode, nothing.body).toBe(200);
    expect(nothing.json().notes).toEqual([]);
  });

  it("the operator is asked to review NOTHING throughout", async () => {
    expect(await pendingReviewCount()).toBe(0);
    // …and the note is unmistakably present in the library, just settled.
    const all = await app.inject({
      method: "GET",
      url: `/api/memory/library?chatId=${MISSION}`,
      headers: auth(OPERATOR),
    });
    const listed = all
      .json()
      .notes.find((note: { id: string }) => note.id === aNoteId);
    expect(listed.confirmedBy).toBe("orchestrator");
    expect(listed.confirmed).toBe(false);
  });

  it("an UNVOUCHED note (posture off) DOES reach the queue, so the counter still works", async () => {
    const settings = await import("../src/lib/operator-settings.js");
    await settings.setAutoConfirmAgentMemory(false);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/memory",
        headers: auth(JOB_A_TOKEN),
        payload: {
          kind: "question",
          text: "Should the CLI print a bare version or a prefixed one, sierra-november",
          modules: [MOD],
          createdBy: "ignored-by-the-route",
          chatId: MISSION,
        },
      });
      expect(response.statusCode).toBe(201);
      // Exactly one: the strict-posture note. A's vouched note is still settled.
      expect(await pendingReviewCount()).toBe(1);
    } finally {
      await settings.setAutoConfirmAgentMemory(true);
    }
  });

  // F14c — the `unvouched` bucket is reached over HTTP by no surface today
  // (desktop/CLI/TUI each fetch `confirmed: "all"` once and filter the rows they
  // already hold). That makes it an API contract rather than dead code only if
  // the contract is pinned, so this asserts the exact predicate end-to-end
  // through the route: unvouched === exactly the notes with confirmedBy === null.
  it("CONTRACT: ?confirmed=unvouched returns exactly the notes nobody vouched for", async () => {
    const everything = await app.inject({
      method: "GET",
      url: `/api/memory/library?chatId=${MISSION}&limit=200`,
      headers: auth(OPERATOR),
    });
    const all = everything.json().notes as {
      id: string;
      confirmedBy: string | null;
    }[];
    // The fixture has to contain BOTH tiers or this proves nothing.
    expect(all.some((note) => note.confirmedBy === "orchestrator")).toBe(true);
    expect(all.some((note) => note.confirmedBy === null)).toBe(true);

    const queue = await app.inject({
      method: "GET",
      url: `/api/memory/library?chatId=${MISSION}&confirmed=unvouched&limit=200`,
      headers: auth(OPERATOR),
    });
    const body = queue.json();
    const expected = all
      .filter((note) => note.confirmedBy === null)
      .map((note) => note.id)
      .sort();
    expect((body.notes as { id: string }[]).map((n) => n.id).sort()).toEqual(
      expected
    );
    // `total` is what any badge would render, so it must agree with the page.
    expect(body.total).toBe(expected.length);
  });

  // F14d — `confirmed` must mean "a HUMAN said so" on EVERY surface. `/used`
  // derived it as "the latest decision of any principal", so an orchestrator
  // vouch read as confirmed there alone and its `scope === "global" && confirmed`
  // clause let a vouched GLOBAL note be reinforced from outside its partition.
  it("reinforcement refuses a vouched GLOBAL note read from another partition", async () => {
    const globalId = "mem-vouched-global";
    await db.prisma.memoryNote.create({
      data: {
        id: globalId,
        kind: "convention",
        text: "A global note MUON vouched for but no human confirmed",
        textHash: "crew-vis-global",
        scope: "global",
        trust: "medium",
        status: "active",
        createdBy: "agent:job:job-crew-a",
        chatId: "chat-somewhere-else",
        modules: [MOD],
        topics: [],
        symbols: [],
      },
    });
    await db.prisma.confirmation.create({
      data: {
        noteId: globalId,
        principal: `agent:orchestrator:chat-somewhere-else`,
        decision: "confirm",
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/memory/used",
      headers: auth(JOB_B_TOKEN),
      payload: { noteIds: [globalId] },
    });
    expect(response.statusCode).toBe(202);
    // Cross-partition reinforcement is authority a HUMAN confirm confers.
    expect(response.json().buffered).toBe(0);
  });

  it("the human can still KILL a bad auto-approved memory after the fact", async () => {
    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/memory/${aNoteId}`,
      headers: auth(OPERATOR),
      payload: {
        confirmed: false,
        status: "rejected",
        principal: "human:founder",
      },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().note.status).toBe("rejected");

    await graphLib.awaitGraphMirrors();
    await ledger.projectLedgerToGraph();

    // Gone from the crew's shared context — the override path is real, not a
    // decoration on an auto-approval nobody can undo.
    const notes = await recallForAgentB();
    expect(
      selectMemorySliceNotes(notes, 5).map((note) => note.id)
    ).not.toContain(aNoteId);
  });
});
