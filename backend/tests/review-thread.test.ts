import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// ── H1: the review thread is BOUND — the digest survives a close-without-decide ──
//
// Real SQLite ledger, real routes. The properties under test are the ones the
// feature exists for: (1) the digest is SINCE-cursor, not a full dump; (2)
// opening the digest does NOT advance the cursor — only the explicit advance
// verb does, so closing without deciding resumes the same digest; (3) the
// digest cites ledger ids and structural flags (a degraded packet's own
// flag), never paraphrased prose; (4) operator tier only; (5) the advance
// stamps the moment the digest was READ, so the render→click window is never
// consumed unseen.

const OPERATOR = "operator-token-review-thread";
const AGENT = "agent-token-review-thread";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let app: FastifyInstance;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-review-thread-")));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  vi.resetModules();
  db = await import("../src/lib/db.js");
  await db.ensureSchema();
  const { buildApp } = await import("../src/app.js");
  app = buildApp();

  await db.prisma.orchestratorChat.create({
    data: {
      id: "chat-rt",
      title: "review thread",
      status: "active",
      workspacePath: dir,
    },
  });
  await db.prisma.task.create({
    data: {
      id: "task-rt",
      title: "review-thread fixture",
      description: "fixture",
      status: "in_progress",
      priority: "normal",
      chatId: "chat-rt",
    },
  });
  await db.prisma.lane.createMany({
    data: [
      { id: "lane-rt-a", key: "codex", name: "codex", provider: "codex", role: "implementer" },
      {
        id: "lane-rt-b",
        key: "claude-code",
        name: "claude",
        provider: "claude-code",
        role: "reviewer",
      },
    ],
  });
  await db.prisma.handoff.create({
    data: {
      id: "handoff-rt-1",
      taskId: "task-rt",
      fromLaneId: "lane-rt-a",
      toLaneId: "lane-rt-b",
      packetTitle: "first packet",
      packetBody: "body",
      packetJson: { degraded: { flag: true, reasons: ["no_check_evidence"] } },
      status: "filed",
    },
  });
  await db.prisma.approvalRequest.create({
    data: {
      id: "approval-rt-1",
      taskId: "task-rt",
      requestedBy: "runner",
      kind: "merge",
      reason: "ship it",
      status: "pending",
      reviewCertification: { artifactDigest: "digest-abc123" },
    },
  });
});

afterAll(async () => {
  await app.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

async function digest() {
  const response = await app.inject({
    method: "GET",
    url: "/api/review-thread/task/task-rt",
    headers: auth(OPERATOR),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    lastLookedAt: string | null;
    digestAt: string;
    handoffs: {
      id: string;
      degraded: boolean | null;
      standing: boolean;
      newSinceLook: boolean;
    }[];
    approvals: {
      id: string;
      reviewDigest: string | null;
      status: string;
      newSinceLook: boolean;
    }[];
    openQuestionIds: string[];
  };
}

describe("H1 — the bound review thread", () => {
  it("first look: everything on the ledger is in the digest, as ids and structural flags", async () => {
    const first = await digest();
    expect(first.lastLookedAt).toBeNull();
    expect(first.handoffs.map((row) => row.id)).toContain("handoff-rt-1");
    // The degraded fact is the packet's OWN flag, cited not paraphrased.
    expect(first.handoffs.find((row) => row.id === "handoff-rt-1")?.degraded).toBe(
      true
    );
    const approval = first.approvals.find((row) => row.id === "approval-rt-1");
    expect(approval?.reviewDigest).toBe("digest-abc123");
  });

  it("opening the digest again WITHOUT deciding resumes the SAME digest — the thread is bound", async () => {
    const again = await digest();
    expect(again.handoffs.map((row) => row.id)).toContain("handoff-rt-1");
    expect(again.approvals.map((row) => row.id)).toContain("approval-rt-1");
  });

  it("advance clears the delta but can NEVER clear a standing blocker", async () => {
    const advanced = await app.inject({
      method: "POST",
      url: "/api/review-thread/task/task-rt/advance",
      headers: auth(OPERATOR),
    });
    expect(advanced.statusCode).toBe(200);

    // Founder-approved H1 correction: marking a look is not a repair and not
    // a decision. The task's CURRENT packet is degraded and the gate is
    // still pending — both persist, flagged as standing rather than new.
    const after = await digest();
    expect(after.lastLookedAt).not.toBeNull();
    const standingPacket = after.handoffs.find(
      (row) => row.id === "handoff-rt-1"
    );
    expect(standingPacket?.degraded).toBe(true);
    expect(standingPacket?.newSinceLook).toBe(false);
    const standingGate = after.approvals.find(
      (row) => row.id === "approval-rt-1"
    );
    expect(standingGate?.status).toBe("pending");
    expect(standingGate?.newSinceLook).toBe(false);
  });

  it("a clean successor packet supersedes the degraded blocker and rides as the delta", async () => {
    await db.prisma.handoff.create({
      data: {
        id: "handoff-rt-2",
        taskId: "task-rt",
        fromLaneId: "lane-rt-a",
        toLaneId: "lane-rt-b",
        packetTitle: "second packet",
        packetBody: "body",
        packetJson: { degraded: { flag: false, reasons: [] } },
        status: "filed",
      },
    });
    const delta = await digest();
    // The task's current wrap is now clean, so the OLD degraded packet is no
    // longer a standing blocker — a repair, not a cursor stamp, cleared it.
    expect(delta.handoffs.map((row) => row.id)).toEqual(["handoff-rt-2"]);
    expect(delta.handoffs[0]!.degraded).toBe(false);
    expect(delta.handoffs[0]!.newSinceLook).toBe(true);
  });

  it("a DECISION on an old gate is new information — and clears its standing hold", async () => {
    await db.prisma.approvalRequest.update({
      where: { id: "approval-rt-1" },
      data: { status: "approved", decidedAt: new Date() },
    });
    const delta = await digest();
    const approval = delta.approvals.find((row) => row.id === "approval-rt-1");
    expect(approval?.status).toBe("approved");
    expect(approval?.newSinceLook).toBe(true);

    // After the NEXT advance the decided gate leaves the digest entirely:
    // deciding — not marking — is what retires a gate from the thread.
    const advanced = await app.inject({
      method: "POST",
      url: "/api/review-thread/task/task-rt/advance",
      headers: auth(OPERATOR),
    });
    expect(advanced.statusCode).toBe(200);
    const settled = await digest();
    expect(settled.approvals.map((row) => row.id)).not.toContain(
      "approval-rt-1"
    );
    // The clean current packet is not a blocker either; with the delta
    // consumed the thread is genuinely quiet.
    expect(settled.handoffs).toEqual([]);
  });

  it("agent tier is refused on both verbs — the cursor is an operator fact", async () => {
    const read = await app.inject({
      method: "GET",
      url: "/api/review-thread/task/task-rt",
      headers: auth(AGENT),
    });
    expect(read.statusCode).toBe(403);
    const advance = await app.inject({
      method: "POST",
      url: "/api/review-thread/task/task-rt/advance",
      headers: auth(AGENT),
    });
    expect(advance.statusCode).toBe(403);
  });

  it("a chat target folds every task in the chat into one thread", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/review-thread/chat/chat-rt",
      headers: auth(OPERATOR),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { handoffs: { id: string }[] };
    // The chat cursor is its own row (never advanced), so both packets ride.
    expect(body.handoffs.map((row) => row.id).sort()).toEqual([
      "handoff-rt-1",
      "handoff-rt-2",
    ]);
  });
});

// ── What the cursor may NEVER clear, and the one act that does ───────────────
//
// Adversarial-review correction (2026-08-17). The older rule admitted only
// `degraded === true` on a not-`done` task to the standing half, which made
// the route disagree with the strip twice over: an UNVERIFIABLE packet was
// counted as a blocker on screen while the cursor quietly retired it, and a
// finished task's unrepaired packet vanished because the task closed rather
// than because anyone evidenced it. Both are pinned here against the real
// route and a real ledger.

async function readTask(taskId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/review-thread/task/${taskId}`,
    headers: auth(OPERATOR),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    digestAt: string;
    handoffs: {
      id: string;
      degraded: boolean | null;
      standing: boolean;
      newSinceLook: boolean;
    }[];
  };
}

async function markReviewed(taskId: string, digestAt?: string) {
  return app.inject({
    method: "POST",
    url: `/api/review-thread/task/${taskId}/advance`,
    headers: auth(OPERATOR),
    ...(digestAt === undefined ? {} : { payload: { digestAt } }),
  });
}

async function fixtureTask(id: string, status: string) {
  await db.prisma.task.create({
    data: {
      id,
      title: `${id} fixture`,
      description: "fixture",
      status,
      priority: "normal",
      chatId: "chat-rt",
    },
  });
}

async function filePacket(
  id: string,
  taskId: string,
  packetJson: unknown,
  createdAt?: Date
) {
  await db.prisma.handoff.create({
    data: {
      id,
      taskId,
      fromLaneId: "lane-rt-a",
      toLaneId: "lane-rt-b",
      packetTitle: id,
      packetBody: "body",
      packetJson: packetJson as never,
      status: "filed",
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

describe("standing blockers and their one clearing act", () => {
  it("an UNVERIFIABLE (prose-only) wrap survives Mark reviewed — cannot-tell is not fine", async () => {
    await fixtureTask("task-rt-prose", "in_progress");
    await filePacket("handoff-rt-prose", "task-rt-prose", undefined);

    // In the delta first, labelled unverifiable rather than clean.
    const first = await readTask("task-rt-prose");
    expect(first.handoffs.map((row) => row.id)).toEqual(["handoff-rt-prose"]);
    expect(first.handoffs[0]!.degraded).toBeNull();
    expect(first.handoffs[0]!.standing).toBe(true);

    // A look is not the missing evidence: it STILL rides, now as standing.
    expect((await markReviewed("task-rt-prose", first.digestAt)).statusCode).toBe(
      200
    );
    const after = await readTask("task-rt-prose");
    expect(after.handoffs.map((row) => row.id)).toEqual(["handoff-rt-prose"]);
    expect(after.handoffs[0]!.standing).toBe(true);
    expect(after.handoffs[0]!.newSinceLook).toBe(false);
  });

  it("…and a later READABLE packet is the act that clears it", async () => {
    await filePacket("handoff-rt-prose-fixed", "task-rt-prose", {
      degraded: { flag: false, reasons: [] },
    });
    const repaired = await readTask("task-rt-prose");
    // The unverifiable row is superseded by the task's new current packet.
    expect(repaired.handoffs.map((row) => row.id)).toEqual([
      "handoff-rt-prose-fixed",
    ]);
    expect(repaired.handoffs[0]!.standing).toBe(false);
    expect(repaired.handoffs[0]!.newSinceLook).toBe(true);
    // …and with nothing standing, the cursor genuinely quiets the thread.
    expect(
      (await markReviewed("task-rt-prose", repaired.digestAt)).statusCode
    ).toBe(200);
    expect((await readTask("task-rt-prose")).handoffs).toEqual([]);
  });

  it("a DONE task's UNREPAIRED degraded wrap still stands — finishing is not evidencing", async () => {
    await fixtureTask("task-rt-done", "done");
    await filePacket("handoff-rt-done", "task-rt-done", {
      degraded: { flag: true, reasons: ["no_check_evidence"] },
    });
    const first = await readTask("task-rt-done");
    expect((await markReviewed("task-rt-done", first.digestAt)).statusCode).toBe(
      200
    );
    const after = await readTask("task-rt-done");
    expect(after.handoffs.map((row) => row.id)).toEqual(["handoff-rt-done"]);
    expect(after.handoffs[0]!.degraded).toBe(true);
    expect(after.handoffs[0]!.standing).toBe(true);
    expect(after.handoffs[0]!.newSinceLook).toBe(false);
  });

  it("a DONE task's CLEAN wrap is history: it rides the delta and retires with it", async () => {
    await fixtureTask("task-rt-done-clean", "done");
    await filePacket("handoff-rt-done-clean", "task-rt-done-clean", {
      degraded: { flag: false, reasons: [] },
    });
    const first = await readTask("task-rt-done-clean");
    expect(first.handoffs.map((row) => row.id)).toEqual([
      "handoff-rt-done-clean",
    ]);
    expect(first.handoffs[0]!.standing).toBe(false);
    expect(
      (await markReviewed("task-rt-done-clean", first.digestAt)).statusCode
    ).toBe(200);
    expect((await readTask("task-rt-done-clean")).handoffs).toEqual([]);
  });
});

// ── The render→click window belongs to the operator, not to the server ──────

describe("advance stamps the READ, not the click", () => {
  it("a packet filed after the digest was read still rides — the window is not consumed", async () => {
    await fixtureTask("task-rt-race", "in_progress");
    // The operator opens the strip. Nothing to see yet.
    const rendered = await readTask("task-rt-race");
    expect(rendered.handoffs).toEqual([]);

    // …and while they are reading it, a lane files a clean wrap. Dated one
    // millisecond after the digest was taken: exactly the window the old
    // `new Date()` stamp swallowed.
    await filePacket(
      "handoff-rt-race",
      "task-rt-race",
      { degraded: { flag: false, reasons: [] } },
      new Date(Date.parse(rendered.digestAt) + 1)
    );

    // They press Mark reviewed on the digest they were SHOWN.
    expect(
      (await markReviewed("task-rt-race", rendered.digestAt)).statusCode
    ).toBe(200);
    const reopened = await readTask("task-rt-race");
    expect(reopened.handoffs.map((row) => row.id)).toEqual(["handoff-rt-race"]);
    expect(reopened.handoffs[0]!.newSinceLook).toBe(true);

    // Acknowledging THAT digest is what finally consumes it.
    expect(
      (await markReviewed("task-rt-race", reopened.digestAt)).statusCode
    ).toBe(200);
    expect((await readTask("task-rt-race")).handoffs).toEqual([]);
  });

  it("a FORGED future digestAt is clamped to the server clock", async () => {
    const forged = new Date(Date.now() + 3_600_000).toISOString();
    const advanced = await markReviewed("task-rt-race", forged);
    expect(advanced.statusCode).toBe(200);
    const stamped = Date.parse(
      (advanced.json() as { lastLookedAt: string }).lastLookedAt
    );
    // Never forward of now: a skewed or forged stamp must not retire facts
    // that have not happened yet.
    expect(stamped).toBeLessThan(Date.parse(forged));
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it("a STALE digestAt never rewinds a cursor a later act already advanced", async () => {
    const stale = new Date(Date.now() - 86_400_000).toISOString();
    const before = await readTask("task-rt-race");
    const advanced = await markReviewed("task-rt-race", stale);
    expect(advanced.statusCode).toBe(200);
    // The delta consumed a moment ago stays consumed…
    expect((await readTask("task-rt-race")).handoffs).toEqual([]);
    expect(before.handoffs).toEqual([]);
  });

  it("an UNREADABLE digestAt is refused, never silently stamped now", async () => {
    const advanced = await markReviewed("task-rt-race", "yesterday, ish");
    expect(advanced.statusCode).toBe(400);
  });

  it("a surface that sends no digestAt still advances (stamping now)", async () => {
    await fixtureTask("task-rt-legacy", "in_progress");
    await filePacket("handoff-rt-legacy", "task-rt-legacy", {
      degraded: { flag: false, reasons: [] },
    });
    expect((await readTask("task-rt-legacy")).handoffs).toHaveLength(1);
    expect((await markReviewed("task-rt-legacy")).statusCode).toBe(200);
    expect((await readTask("task-rt-legacy")).handoffs).toEqual([]);
  });
});

// ── "Declared nothing" is not "declared unreadable" ──────────────────────────
//
// Both fell under one test (`degradedOf(...) !== false`), so a PROSE-ONLY wrap —
// a packet carrying no `degraded` object at all — stood FOREVER on a task that
// had already read CLEAN, and there was no act in the product that could clear
// it: the clearing act is a later clean packet, and the prose wrap was itself
// the newest one. D21's rule for an UNREADABLE declaration on a live task is
// unchanged here, and pinned alongside it: that one still stands. Real route,
// real SQLite ledger, no source-text assertions.
//
// Timestamps are explicit throughout: the newest-packet-per-task scan orders by
// createdAt, so two packets filed in the same millisecond would make "which wrap
// is current" a coin flip rather than a fact.

describe("prose-only wraps and the verdicts that settle them", () => {
  const ago = (ms: number) => new Date(Date.now() - ms);

  it("a prose-only wrap AFTER a clean verdict is history, not a permanent blocker", async () => {
    await fixtureTask("task-rt-wrap-clean", "in_progress");
    await filePacket(
      "handoff-rt-wrap-clean-1",
      "task-rt-wrap-clean",
      { degraded: { flag: false, reasons: [] } },
      ago(60_000)
    );
    await filePacket(
      "handoff-rt-wrap-clean-2",
      "task-rt-wrap-clean",
      { title: "wrap", summary: "prose only — no degraded object at all" },
      ago(30_000)
    );

    const first = await readTask("task-rt-wrap-clean");
    const wrap = first.handoffs.find(
      (row) => row.id === "handoff-rt-wrap-clean-2"
    );
    // Still UNVERIFIABLE on the wire: nothing here claims this wrap vouched for
    // itself, and the strip must keep saying so.
    expect(wrap?.degraded).toBeNull();
    // …but the task's newest READABLE verdict was clean, so the cursor may
    // retire it. Before the fix this was `standing: true` with no clearing act.
    expect(wrap?.standing).toBe(false);
    expect(
      (await markReviewed("task-rt-wrap-clean", first.digestAt)).statusCode
    ).toBe(200);
    expect((await readTask("task-rt-wrap-clean")).handoffs).toEqual([]);
  });

  it("a prose-only wrap with NO earlier verdict is still surfaced — no new blind spot", async () => {
    await fixtureTask("task-rt-wrap-only", "in_progress");
    await filePacket(
      "handoff-rt-wrap-only",
      "task-rt-wrap-only",
      { title: "wrap", summary: "prose only, and nothing before it" },
      ago(30_000)
    );
    const first = await readTask("task-rt-wrap-only");
    expect(first.handoffs[0]!.degraded).toBeNull();
    expect(first.handoffs[0]!.standing).toBe(true);
    // A look is not the missing evidence: it still rides after Mark reviewed.
    expect(
      (await markReviewed("task-rt-wrap-only", first.digestAt)).statusCode
    ).toBe(200);
    const after = await readTask("task-rt-wrap-only");
    expect(after.handoffs.map((row) => row.id)).toEqual([
      "handoff-rt-wrap-only",
    ]);
    expect(after.handoffs[0]!.standing).toBe(true);
    expect(after.handoffs[0]!.newSinceLook).toBe(false);
  });

  it("a prose-only wrap after a DEGRADED verdict still stands — prose is not a repair", async () => {
    await fixtureTask("task-rt-wrap-degraded", "in_progress");
    await filePacket(
      "handoff-rt-wrap-degraded-1",
      "task-rt-wrap-degraded",
      { degraded: { flag: true, reasons: ["no_check_evidence"] } },
      ago(60_000)
    );
    await filePacket(
      "handoff-rt-wrap-degraded-2",
      "task-rt-wrap-degraded",
      { title: "wrap", summary: "prose only" },
      ago(30_000)
    );
    const first = await readTask("task-rt-wrap-degraded");
    const wrap = first.handoffs.find(
      (row) => row.id === "handoff-rt-wrap-degraded-2"
    );
    expect(wrap?.standing).toBe(true);
    expect(
      (await markReviewed("task-rt-wrap-degraded", first.digestAt)).statusCode
    ).toBe(200);
    const after = await readTask("task-rt-wrap-degraded");
    expect(after.handoffs.map((row) => row.id)).toEqual([
      "handoff-rt-wrap-degraded-2",
    ]);
    expect(after.handoffs[0]!.standing).toBe(true);
  });

  it("an UNREADABLE declaration still stands even after a clean packet (D21 unchanged)", async () => {
    await fixtureTask("task-rt-unreadable", "in_progress");
    await filePacket(
      "handoff-rt-unreadable-1",
      "task-rt-unreadable",
      { degraded: { flag: false, reasons: [] } },
      ago(60_000)
    );
    // The packet CARRIES a degraded shape and MUON cannot read it. That is the
    // fact D21 made standing, and an earlier clean packet does not settle it:
    // this wrap tried to declare and its declaration is unreadable.
    await filePacket(
      "handoff-rt-unreadable-2",
      "task-rt-unreadable",
      { degraded: null },
      ago(30_000)
    );
    const first = await readTask("task-rt-unreadable");
    const wrap = first.handoffs.find(
      (row) => row.id === "handoff-rt-unreadable-2"
    );
    expect(wrap?.degraded).toBeNull();
    expect(wrap?.standing).toBe(true);
    expect(
      (await markReviewed("task-rt-unreadable", first.digestAt)).statusCode
    ).toBe(200);
    const after = await readTask("task-rt-unreadable");
    expect(after.handoffs.map((row) => row.id)).toEqual([
      "handoff-rt-unreadable-2",
    ]);
    expect(after.handoffs[0]!.standing).toBe(true);
    expect(after.handoffs[0]!.newSinceLook).toBe(false);
  });

  it("a DEGRADED current wrap stands, and its own repair is what clears it", async () => {
    await fixtureTask("task-rt-repair", "in_progress");
    await filePacket(
      "handoff-rt-repair-1",
      "task-rt-repair",
      { degraded: { flag: true, reasons: ["no_check_evidence"] } },
      ago(60_000)
    );
    const first = await readTask("task-rt-repair");
    expect(first.handoffs[0]!.standing).toBe(true);
    expect(
      (await markReviewed("task-rt-repair", first.digestAt)).statusCode
    ).toBe(200);
    expect((await readTask("task-rt-repair")).handoffs[0]!.standing).toBe(true);
    // The one act: a later packet on this task that READS clean. Filed NOW, so
    // it is also newer than the cursor and rides the delta as its own news.
    await filePacket("handoff-rt-repair-2", "task-rt-repair", {
      degraded: { flag: false, reasons: [] },
    });
    const repaired = await readTask("task-rt-repair");
    expect(repaired.handoffs.map((row) => row.id)).toEqual([
      "handoff-rt-repair-2",
    ]);
    expect(repaired.handoffs[0]!.standing).toBe(false);
  });
});
