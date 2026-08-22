import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ── ADR-0085 — the desk digests since you last looked ────────────────────────
//
// Real DB, real route. What these pin:
//   • the digest derives from the PREVIOUS absence boundary and enumerates
//     only what landed after it — the pre-boundary rows never appear;
//   • every section carries its TOTAL count and a truncation flag (D3);
//   • a packet line carries THE shared classifier's word — a schema fragment
//     reads packet_parse_failed, as loudly as the desk says it;
//   • fork MISSIONS list; 0084-inherited crew tasks (same stamp, not a chat
//     root) do not;
//   • a never-rolled boundary says so instead of inventing one;
//   • operator tier only.

const OPERATOR = "operator-token-digest";
const auth = { authorization: `Bearer ${OPERATOR}` };

let dir: string;
let db: typeof import("../src/lib/db.js");
let graphLib: typeof import("../src/lib/graph.js");
let attendance: typeof import("../src/lib/surface-attendance.js");
let app: FastifyInstance;
let boundary = 0;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-digest-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  graphLib = await import("../src/lib/graph.js");
  attendance = await import("../src/lib/surface-attendance.js");
  await db.ensureSchema();
  attendance.resetAttendanceForTests();

  const NOW = Date.now();
  boundary = NOW - 60 * 60_000; // the ended session's last look, an hour ago
  const before = new Date(boundary - 30 * 60_000); // landed while attending
  const after = new Date(boundary + 5 * 60_000); // landed during the absence

  await db.prisma.task.createMany({
    data: [
      {
        id: "task-digest",
        title: "Digest fixture task",
        description: "Rows for the digest derivation.",
        status: "in_progress",
        createdAt: before,
      },
      // A fork MISSION root minted during the absence...
      {
        id: "task-fork-mission",
        title: "Fork exploration",
        description: "A fork taken while the human was away.",
        status: "in_progress",
        chatId: "chat-fork-digest",
        forkSourceTaskId: "task-digest",
        createdAt: after,
      },
      // ...and an 0084-INHERITED crew task: same stamp, NOT a chat root —
      // it must not read as a second fork taken.
      {
        id: "task-fork-worker",
        title: "Fork worker slice",
        description: "Inherited crew task inside the fork mission.",
        status: "in_progress",
        chatId: "chat-fork-digest",
        forkSourceTaskId: "task-digest",
        createdAt: after,
      },
    ],
  });
  await db.prisma.orchestratorChat.create({
    data: {
      id: "chat-fork-digest",
      title: "Fork chat",
      workspacePath: process.cwd(),
      taskId: "task-fork-mission",
    },
  });
  await db.prisma.approvalRequest.createMany({
    data: [
      {
        id: "gate-before",
        taskId: "task-digest",
        requestedBy: "agent:job:job-x",
        kind: "merge",
        reason: "merge the fixture",
        status: "pending",
        createdAt: before,
      },
      {
        id: "gate-after",
        taskId: "task-digest",
        requestedBy: "agent:job:job-x",
        kind: "merge",
        reason: "merge the fixture",
        status: "pending",
        createdAt: after,
      },
      {
        id: "gate-decided",
        taskId: "task-digest",
        requestedBy: "agent:job:job-x",
        kind: "merge",
        reason: "merge the fixture",
        status: "approved",
        createdAt: before,
        decidedAt: after,
      },
    ],
  });
  await db.prisma.lane.create({
    data: {
      id: "lane-digest",
      key: "codex",
      name: "Codex",
      provider: "openai",
      role: "implementer",
    },
  });
  await db.prisma.handoff.createMany({
    data: [
      {
        id: "packet-clean",
        taskId: "task-digest",
        fromLaneId: "lane-digest",
        toLaneId: "lane-digest",
        packetTitle: "clean packet",
        packetBody: "clean",
        packetJson: {
          taskGoal: "digest fixture packet",
          whatChanged: "the fixture landed",
          whatFailed: "nothing failed",
          nextLaneRequest: "review the fixture",
          commandsRun: [],
          checksStatus: [],
          openQuestions: [],
          provenance: { lane: "codex", createdAt: new Date().toISOString() },
          degraded: { flag: false, reasons: [] },
        },
        createdAt: after,
      },
      {
        id: "packet-fragment",
        taskId: "task-digest",
        fromLaneId: "lane-digest",
        toLaneId: "lane-digest",
        packetTitle: "schema fragment",
        packetBody: "fragment",
        packetJson: { version: 1, nonsense: true },
        createdAt: after,
      },
    ],
  });
  await db.prisma.event.createMany({
    data: [
      {
        laneId: "lane-digest",
        taskId: "task-digest",
        kind: "question.blocked",
        message: "q asked",
        metadata: {},
        timestamp: after,
      },
      {
        laneId: "lane-digest",
        taskId: "task-digest",
        kind: "question.blocked",
        message: "asked while attending",
        metadata: {},
        timestamp: before,
      },
    ],
  });
  await db.prisma.peerMessage.create({
    data: {
      id: "finding-after",
      chatId: "chat-fork-digest",
      missionId: "task-digest",
      fromJobId: "job-x",
      fromRole: "implementer",
      fromVendor: "codex",
      toKind: "crew",
      kind: "finding",
      subject: "The cache invalidation claim does not hold.",
      body: "measured",
      refs: { files: [], symbols: [], noteIds: [] },
      createdAt: after,
    },
  });
  await db.prisma.memoryNote.createMany({
    data: [
      {
        id: "note-target",
        kind: "decision",
        text: "target",
        textHash: "digest-a",
        createdBy: "agent:job:job-x",
        topics: [],
        symbols: [],
        modules: [],
        validFrom: before,
      },
      {
        id: "note-dispute",
        kind: "question",
        text: "dispute",
        textHash: "digest-b",
        createdBy: "agent:job:job-y",
        topics: [],
        symbols: [],
        modules: [],
        validFrom: before,
      },
    ],
  });
  await db.prisma.memoryEdge.create({
    data: {
      fromId: "note-dispute",
      toId: "note-target",
      kind: "contradicts",
      at: after,
    },
  });

  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  attendance.resetAttendanceForTests();
  await app.close();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/digest", () => {
  it("a never-rolled boundary says so instead of inventing one; agent tier is refused", async () => {
    const noBoundary = await app.inject({
      method: "GET",
      url: "/api/digest",
      headers: auth,
    });
    expect(noBoundary.statusCode).toBe(200);
    expect(noBoundary.json().since).toBeNull();
    expect(noBoundary.json().sections).toBeNull();
    expect(noBoundary.json().note).toContain("No previous session");

    const agent = await app.inject({
      method: "GET",
      url: "/api/digest",
      headers: { authorization: "Bearer not-the-operator" },
    });
    expect(agent.statusCode).toBe(401);
  });

  it("derives from the previous absence boundary: post-boundary rows only, honest counts, the classifier's own words", async () => {
    // The session that ended at `boundary`, then the return now — the roll
    // the anchor pins; the digest anchors on its result.
    attendance.noteHumanPresent("tui", boundary);
    attendance.noteHumanPresent("tui", Date.now());
    expect(attendance.previousSessionEnd()).toBe(boundary);

    const res = await app.inject({
      method: "GET",
      url: "/api/digest",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const digest = res.json();
    expect(digest.since).toBe(boundary);

    // Gates: opened counts only the post-boundary open; the decision that
    // LANDED during the absence appears in decided even though the gate
    // itself predates the boundary.
    expect(digest.sections.gatesOpened.count).toBe(1);
    expect(digest.sections.gatesOpened.items[0].id).toBe("gate-after");
    expect(digest.sections.gatesOpened.truncated).toBe(false);
    expect(digest.sections.gatesDecided.count).toBe(1);
    expect(digest.sections.gatesDecided.items[0].id).toBe("gate-decided");

    // Packets carry the shared classifier's word — the fragment reads
    // packet_parse_failed, never clean; the clean one is typed.
    const classifications = Object.fromEntries(
      digest.sections.packets.items.map(
        (item: { id: string; classification: string }) => [
          item.id,
          item.classification,
        ]
      )
    );
    expect(classifications["packet-clean"]).toBe("typed");
    expect(classifications["packet-fragment"]).toBe("packet_parse_failed");
    expect(digest.sections.packets.count).toBe(2);

    // Questions: the pre-boundary event is not part of the absence.
    expect(digest.sections.questions.count).toBe(1);

    // Forks: the MISSION lists; the 0084-inherited worker task does not.
    expect(digest.sections.forks.count).toBe(1);
    expect(digest.sections.forks.items[0].taskId).toBe("task-fork-mission");

    expect(digest.sections.findings.count).toBe(1);
    expect(digest.sections.findings.items[0].subject).toContain(
      "cache invalidation"
    );
    expect(digest.sections.contradictions.count).toBe(1);
    expect(digest.sections.contradictions.items[0].fromId).toBe(
      "note-dispute"
    );
  });
});
