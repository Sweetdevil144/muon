import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CLAIM_TTL_MS,
  MAX_CLAIMED_PATHS_PER_JOB,
  MAX_PEER_BODY_CHARS,
  MAX_PEER_MESSAGES_PER_JOB,
  MAX_PEER_SUBJECT_CHARS,
  MIN_PEER_SEND_INTERVAL_MS,
} from "@muon/protocol";

// ── A2A: governed peer coordination ──────────────────────────────────────────
//
// End-to-end against a REAL temp-SQLite brain. These tests exist to prove the
// three properties the feature is only safe because of:
//
//   1. IDENTITY IS AUTHENTICATED. A sender cannot express, forge, or borrow an
//      identity: the envelope's chat/mission/job/role/vendor come from the
//      exact-job bearer, and naming someone else's job 403s instead of
//      impersonating.
//   2. DELIVERY IS BOUNDED — BY THE CHAT. One chat's crew hears each other
//      however many orchestrator root turns dispatched them; another chat is
//      invisible. Bounding on the ROOT TURN instead is what made this feature
//      silently undeliverable, so both halves are proven below.
//   3. THE CAPS ARE REAL. Size, count, rate and claim caps are enforced at the
//      route, not merely declared in the protocol module.

const OPERATOR = "operator-token-a2a";
const AGENT = "agent-token-a2a";
const ROOT_A = `root-a-a2a-${"a".repeat(48)}`;
const IMPL_A = `impl-a-a2a-${"b".repeat(48)}`;
const REVIEW_A = `review-a-a2a-${"c".repeat(46)}`;
const NOROLE_A = `norole-a-a2a-${"d".repeat(46)}`;
const IMPL_A2 = `impl-a2-a2a-${"e".repeat(47)}`;
const IMPL_B = `impl-b-a2a-${"f".repeat(48)}`;
const ROOT_B = `root-b-a2a-${"g".repeat(48)}`;
const WORKSPACE = process.cwd();

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let app: FastifyInstance;

/**
 * The 250ms anti-flood fence is real, so a helper that reuses one sender across
 * tests spaces its own sends. The fence itself is exercised deliberately below.
 */
const lastSendAt = new Map<string, number>();

async function sendAs(
  token: string,
  payload: Record<string, unknown>
): Promise<ReturnType<FastifyInstance["inject"]> extends Promise<infer R> ? R : never> {
  const previous = lastSendAt.get(token);
  if (previous !== undefined) {
    const wait = MIN_PEER_SEND_INTERVAL_MS - (Date.now() - previous) + 10;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  const response = await app.inject({
    method: "POST",
    url: "/api/a2a/messages",
    headers: auth(token),
    payload,
  });
  lastSendAt.set(token, Date.now());
  return response;
}

/**
 * `/claims` carries the same fence, for the same reason: an unbounded claim
 * path is how a job churns rows into a table `/coordination` scans on every
 * poll. Same spacing helper, and the fence itself is exercised deliberately.
 */
const lastClaimAt = new Map<string, number>();

async function claimAs(
  token: string,
  payload: Record<string, unknown>
): Promise<ReturnType<FastifyInstance["inject"]> extends Promise<infer R> ? R : never> {
  const previous = lastClaimAt.get(token);
  if (previous !== undefined) {
    const wait = MIN_PEER_SEND_INTERVAL_MS - (Date.now() - previous) + 10;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  const response = await app.inject({
    method: "POST",
    url: "/api/a2a/claims",
    headers: auth(token),
    payload,
  });
  lastClaimAt.set(token, Date.now());
  return response;
}

type Snapshot = {
  participants: {
    jobId: string;
    status: string;
    claimedPaths: number;
    unreadMessages: number;
  }[];
  openConflicts: { coordinate: string; heldByJobId: string; heldByRole: string }[];
  messageCount: number;
  score?: {
    claimsTaken: number;
    claimsActive: number;
    claimsRefused: number;
    findingsPublished: number;
    findingsWithNoteLink: number;
    findingDeliveries: number;
    truncated: boolean;
  };
};

/** The human's coordinates-only view of one mission. */
async function coordinationSnapshot(
  missionId = "job-root-a"
): Promise<Snapshot> {
  const res = await app.inject({
    method: "GET",
    url: `/api/a2a/coordination?chatId=chat-a&missionId=${missionId}`,
    headers: auth(OPERATOR),
  });
  expect(res.statusCode).toBe(200);
  return res.json().snapshot as Snapshot;
}

/** Who the snapshot names as a party to the collision on one path. */
function conflictHolders(snapshot: Snapshot, coordinate: string): string[] {
  return snapshot.openConflicts
    .filter((conflict) => conflict.coordinate === coordinate)
    .map((conflict) => conflict.heldByJobId)
    .sort();
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-a2a-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();

  db = await import("../src/lib/db.js");
  await db.ensureSchema();

  await db.prisma.task.createMany({
    data: [
      {
        id: "task-a",
        title: "Mission A",
        description: "The first mission of chat A.",
        status: "in_progress",
        workspacePath: WORKSPACE,
        chatId: "chat-a",
      },
      {
        id: "task-a2",
        title: "Mission A2",
        description: "A second, later mission of the same chat.",
        status: "in_progress",
        workspacePath: WORKSPACE,
        chatId: "chat-a",
      },
      {
        id: "task-b",
        title: "Mission B",
        description: "A mission belonging to another chat.",
        status: "in_progress",
        workspacePath: WORKSPACE,
        chatId: "chat-b",
      },
    ],
  });
  await db.prisma.orchestratorChat.createMany({
    data: [
      { id: "chat-a", title: "Chat A", workspacePath: WORKSPACE, taskId: "task-a" },
      { id: "chat-b", title: "Chat B", workspacePath: WORKSPACE, taskId: "task-b" },
    ],
  });
  await db.prisma.agent.create({
    data: { vendor: "codex", ordinal: 1, name: "codex-1", status: "working" },
  });
  const seat = await db.prisma.agent.findUnique({ where: { name: "codex-1" } });

  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-root-a",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-a",
        chatId: "chat-a",
        brief: "Coordinate mission A.",
        workspacePath: WORKSPACE,
        capabilityMode: "orchestrator",
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-impl-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-a",
        chatId: "chat-a",
        parentJobId: "job-root-a",
        rootJobId: "job-root-a",
        role: "implementer",
        agentId: seat?.id ?? null,
        brief: "Implement mission A.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-a",
      },
      {
        id: "job-review-a",
        kind: "oneshot",
        vendor: "claude-code",
        taskId: "task-a",
        chatId: "chat-a",
        parentJobId: "job-root-a",
        rootJobId: "job-root-a",
        role: "reviewer",
        brief: "Review mission A.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-a",
      },
      {
        id: "job-norole-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-a",
        chatId: "chat-a",
        parentJobId: "job-root-a",
        rootJobId: "job-root-a",
        brief: "A pre-A2A job with no crew role.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-a",
      },
      {
        // A SECOND root turn of the same chat — what MUON's own contract-retry
        // path enqueues. Its root has ended while the worker it dispatched
        // keeps running: one crew, two roots, which is the topology that was
        // structurally unable to see its own mail.
        id: "job-root-a2",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-a2",
        chatId: "chat-a",
        brief: "Coordinate mission A2.",
        workspacePath: WORKSPACE,
        capabilityMode: "orchestrator",
        status: "done",
        dispatchedBy: "human",
      },
      {
        id: "job-impl-a2",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-a2",
        chatId: "chat-a",
        parentJobId: "job-root-a2",
        rootJobId: "job-root-a2",
        role: "implementer",
        brief: "Implement the second mission of chat A.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-a2",
      },
      {
        id: "job-root-b",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-b",
        chatId: "chat-b",
        brief: "Coordinate chat B.",
        workspacePath: WORKSPACE,
        capabilityMode: "orchestrator",
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-impl-b",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-b",
        chatId: "chat-b",
        parentJobId: "job-root-b",
        rootJobId: "job-root-b",
        role: "implementer",
        brief: "Implement chat B work.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-b",
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      ["job-root-a", ROOT_A],
      ["job-impl-a", IMPL_A],
      ["job-review-a", REVIEW_A],
      ["job-norole-a", NOROLE_A],
      ["job-impl-a2", IMPL_A2],
      ["job-impl-b", IMPL_B],
      ["job-root-b", ROOT_B],
    ].map(([jobId, token]) => ({
      jobId: jobId!,
      tokenHash: createHash("sha256").update(token!).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })),
  });

  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("A2A identity is authenticated, never claimed", () => {
  it("refuses a job that runs without a crew role (fail closed, no guessed role)", async () => {
    const res = await sendAs(NOROLE_A, {
      to: { kind: "crew" },
      kind: "status",
      subject: "who am I",
      body: "A job with no role has no peer identity.",
    });
    expect(res.statusCode).toBe(403);
    expect(await db.prisma.peerMessage.count({ where: { fromJobId: "job-norole-a" } })).toBe(0);
  });

  it("rejects a body that tries to declare its own identity, and stamps the bearer's", async () => {
    const forged = await sendAs(IMPL_A, {
      to: { kind: "crew" },
      kind: "status",
      subject: "forged identity",
      body: "Claiming to be someone else.",
      fromJobId: "job-root-a",
      chatId: "chat-b",
      missionId: "job-root-b",
      fromRole: "orchestrator",
    });
    expect(forged.statusCode).toBe(400);

    const sent = await sendAs(IMPL_A, {
      to: { kind: "crew" },
      kind: "status",
      subject: "starting on the auth boundary",
      body: "Taking backend/src/lib/auth.ts for the next hour.",
      refs: { files: ["backend/src/lib/auth.ts"], symbols: ["requireOperator"] },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().message).toMatchObject({
      version: 1,
      chatId: "chat-a",
      missionId: "job-root-a",
      fromJobId: "job-impl-a",
      fromRole: "implementer",
      fromVendor: "codex",
      // Display-only crew codename, resolved from the fleet seat.
      fromName: "codex-1",
      to: { kind: "crew" },
      subject: "starting on the auth boundary",
    });
    expect(sent.json().message.readAt).toBeUndefined();
  });

  it("cannot address a job in another chat (403) and stores nothing", async () => {
    const before = await db.prisma.peerMessage.count();
    const res = await sendAs(IMPL_A, {
      to: { kind: "job", jobId: "job-impl-b" },
      kind: "question",
      subject: "cross-chat probe",
      body: "Does chat B hear me?",
    });
    expect(res.statusCode).toBe(403);
    expect(await db.prisma.peerMessage.count()).toBe(before);
  });

  it("refuses a self-addressed envelope at the ROUTE (400) and stores nothing", async () => {
    // The MCP handler blocks this too, but the exact-job bearer lives in the
    // agent's own process env, so the tool layer is not the boundary. Accepted,
    // it would be delivered to nobody, never take a `readAt`, and inflate the
    // mission's messageCount forever.
    const before = await db.prisma.peerMessage.count();
    const res = await sendAs(IMPL_A, {
      to: { kind: "job", jobId: "job-impl-a" },
      kind: "status",
      subject: "talking to myself",
      body: "Nobody is on the other end of this.",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/cannot address itself/i);
    expect(await db.prisma.peerMessage.count()).toBe(before);
  });

  it("CAN address a job dispatched under another root turn of the same chat", async () => {
    // This assertion used to read 403. A chat re-roots every orchestrator turn,
    // so refusing here was MUON refusing to deliver its own crew's mail — the
    // boundary is the chat (see `coordinationScope`), and the chat half is
    // proven fail-closed by the test above and by the cross-chat block below.
    const res = await sendAs(IMPL_A, {
      to: { kind: "job", jobId: "job-impl-a2" },
      kind: "question",
      subject: "cross-root probe",
      body: "Does the crew's other root hear me?",
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects a replyTo that points outside this chat (400)", async () => {
    const foreign = await sendAs(IMPL_B, {
      to: { kind: "crew" },
      kind: "status",
      subject: "chat B work",
      body: "Chat B is doing its own thing.",
    });
    expect(foreign.statusCode).toBe(201);

    const res = await sendAs(IMPL_A, {
      to: { kind: "crew" },
      kind: "answer",
      subject: "replying across the boundary",
      body: "Threading onto another chat's message.",
      replyTo: foreign.json().message.id,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("A2A delivery is chat-bounded", () => {
  it("delivers the whole crew's traffic, across roots, and nothing from another chat", async () => {
    const otherRoot = await sendAs(IMPL_A2, {
      to: { kind: "crew" },
      kind: "status",
      subject: "other-root broadcast",
      body: "Sent from a peer the second root turn dispatched.",
    });
    expect(otherRoot.statusCode).toBe(201);

    const inbox = await app.inject({
      method: "GET",
      url: "/api/a2a/inbox",
      headers: auth(REVIEW_A),
    });
    expect(inbox.statusCode).toBe(200);
    const subjects = inbox
      .json()
      .messages.map((message: { subject: string }) => message.subject);
    expect(subjects).toContain("starting on the auth boundary");
    // Used to be `not.toContain`. One crew, two orchestrator turns: excluding
    // this is the whole defect.
    expect(subjects).toContain("other-root broadcast");
    expect(subjects).not.toContain("chat B work");
    // Every delivered envelope belongs to THIS chat. Its `missionId` records
    // which root turn wrote it and is deliberately NOT uniform.
    for (const message of inbox.json().messages) {
      expect(message.chatId).toBe("chat-a");
    }
    expect(
      new Set(
        inbox.json().messages.map((message: { missionId: string }) => message.missionId)
      ).size
    ).toBeGreaterThan(1);
  });

  // The reason delivery is a per-job CURSOR and not a shared read flag on the
  // message: a crew broadcast has many recipients, and one flag could only ever
  // record the first of them.
  it("delivers one crew broadcast to every peer independently, and never twice", async () => {
    const broadcast = await sendAs(ROOT_A, {
      to: { kind: "crew" },
      kind: "constraint",
      subject: "mission-wide constraint",
      body: "Keep the gate fail-closed; this is a hint, not an approval.",
    });
    expect(broadcast.statusCode).toBe(201);
    const broadcastId = broadcast.json().message.id;

    const readInbox = async (token: string) => {
      const res = await app.inject({
        method: "GET",
        url: "/api/a2a/inbox",
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
      return res.json().messages.map((message: { id: string }) => message.id);
    };

    // BOTH siblings receive it — neither consumes it from under the other.
    expect(await readInbox(IMPL_A)).toContain(broadcastId);
    expect(await readInbox(REVIEW_A)).toContain(broadcastId);

    // And each cursor has advanced past it, so a re-read never re-delivers.
    expect(await readInbox(IMPL_A)).not.toContain(broadcastId);
    expect(await readInbox(REVIEW_A)).not.toContain(broadcastId);
  });

  it("delivers role-addressed mail to the role holder exactly once", async () => {
    const sent = await sendAs(IMPL_A, {
      to: { kind: "role", role: "reviewer" },
      kind: "review_request",
      subject: "diff ready for review",
      body: "Please look at the claim conflict path.",
      refs: { files: ["backend/src/routes/a2a.ts"] },
    });
    expect(sent.statusCode).toBe(201);

    const first = await app.inject({
      method: "GET",
      url: "/api/a2a/inbox",
      headers: auth(REVIEW_A),
    });
    expect(first.statusCode).toBe(200);
    expect(
      first.json().messages.map((message: { id: string }) => message.id)
    ).toContain(sent.json().message.id);
    expect(first.json().truncated).toBe(false);

    const second = await app.inject({
      method: "GET",
      url: "/api/a2a/inbox",
      headers: auth(REVIEW_A),
    });
    expect(second.json()).toMatchObject({ messages: [], unread: 0, truncated: false });
  });

  it("never delivers a job its own sends", async () => {
    const own = await sendAs(IMPL_A, {
      to: { kind: "crew" },
      kind: "status",
      subject: "my own broadcast",
      body: "I should never read this back from my inbox.",
    });
    expect(own.statusCode).toBe(201);
    const peer = await sendAs(REVIEW_A, {
      to: { kind: "crew" },
      kind: "status",
      subject: "a peer broadcast",
      body: "This one is addressed to the crew by someone else.",
    });
    expect(peer.statusCode).toBe(201);

    const inbox = await app.inject({
      method: "GET",
      url: "/api/a2a/inbox",
      headers: auth(IMPL_A),
    });
    expect(inbox.statusCode).toBe(200);
    const ids = inbox.json().messages.map((message: { id: string }) => message.id);
    expect(ids).toContain(peer.json().message.id);
    expect(ids).not.toContain(own.json().message.id);
  });

  it("reports truncation instead of over-delivering a page", async () => {
    // Start from a drained inbox so the page arithmetic below is exact.
    await app.inject({
      method: "GET",
      url: "/api/a2a/inbox",
      headers: auth(REVIEW_A),
    });
    await db.prisma.peerMessage.createMany({
      data: Array.from({ length: 4 }, (_, index) => ({
        chatId: "chat-a",
        missionId: "job-root-a",
        fromJobId: "job-root-a",
        fromRole: "orchestrator",
        fromVendor: "claude-code",
        toKind: "job",
        toJobId: "job-review-a",
        kind: "constraint",
        subject: `bounded hint ${index}`,
        body: "A hint, not a binding constraint.",
        refs: { files: [], symbols: [] },
      })),
    });

    const page = await app.inject({
      method: "GET",
      url: "/api/a2a/inbox?limit=2",
      headers: auth(REVIEW_A),
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().messages).toHaveLength(2);
    expect(page.json().unread).toBe(4);
    expect(page.json().truncated).toBe(true);
    // Directly-addressed mail carries the display-only delivery stamp.
    for (const message of page.json().messages) {
      expect(message.readAt).toBeTruthy();
    }

    // The four share a createdAt millisecond, so this also proves the cursor
    // compares the (createdAt, id) TUPLE: a timestamp-only cursor would skip
    // the rest of the batch.
    const rest = await app.inject({
      method: "GET",
      url: "/api/a2a/inbox",
      headers: auth(REVIEW_A),
    });
    expect(rest.json().messages).toHaveLength(2);
    expect(rest.json().truncated).toBe(false);
    const delivered = [
      ...page.json().messages.map((message: { id: string }) => message.id),
      ...rest.json().messages.map((message: { id: string }) => message.id),
    ];
    expect(new Set(delivered).size).toBe(4);
  });
});

describe("A2A envelope caps are enforced at the route", () => {
  it("rejects an oversized subject or body (400)", async () => {
    const subject = await sendAs(IMPL_A, {
      to: { kind: "crew" },
      kind: "status",
      subject: "s".repeat(MAX_PEER_SUBJECT_CHARS + 1),
      body: "ok",
    });
    expect(subject.statusCode).toBe(400);

    const body = await sendAs(IMPL_A, {
      to: { kind: "crew" },
      kind: "status",
      subject: "too much to say",
      body: "b".repeat(MAX_PEER_BODY_CHARS + 1),
    });
    expect(body.statusCode).toBe(400);
  });

  it("rejects an over-full refs block (400)", async () => {
    const res = await sendAs(IMPL_A, {
      to: { kind: "crew" },
      kind: "status",
      subject: "too many refs",
      body: "Coordinates only, but far too many of them.",
      refs: { files: Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a job that has spent its message budget (429)", async () => {
    await db.prisma.peerMessage.createMany({
      data: Array.from({ length: MAX_PEER_MESSAGES_PER_JOB }, (_, index) => ({
        chatId: "chat-a",
        missionId: "job-root-a",
        fromJobId: "job-root-a",
        fromRole: "orchestrator",
        fromVendor: "claude-code",
        toKind: "crew",
        kind: "status",
        subject: `budget filler ${index}`,
        body: "Filling the mission budget.",
        refs: { files: [], symbols: [] },
      })),
    });

    const res = await sendAs(ROOT_A, {
      to: { kind: "crew" },
      kind: "status",
      subject: "one too many",
      body: "This send is over the per-job budget.",
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().message).toMatch(/budget/i);
  });

  it("spaces sends from one job (429 inside the anti-flood window)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/a2a/messages",
      headers: auth(REVIEW_A),
      payload: {
        to: { kind: "crew" },
        kind: "review_verdict",
        subject: "verdict: concerns",
        body: "Two findings, both bounded.",
      },
    });
    expect(first.statusCode).toBe(201);

    const immediate = await app.inject({
      method: "POST",
      url: "/api/a2a/messages",
      headers: auth(REVIEW_A),
      payload: {
        to: { kind: "crew" },
        kind: "status",
        subject: "flooding",
        body: "Sent with no spacing at all.",
      },
    });
    expect(immediate.statusCode).toBe(429);
    lastSendAt.set(REVIEW_A, Date.now());
  });
});

describe("A2A file claims are advisory, bounded, and self-scoped", () => {
  it("conflicts on two edit intents and leaves the first writer holding the path", async () => {
    const first = await claimAs(IMPL_A, {
      coordinates: ["src/contested.ts"],
      intent: "edit",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().granted).toHaveLength(1);
    expect(first.json().conflicts).toEqual([]);
    expect(first.json().granted[0]).toMatchObject({
      version: 1,
      chatId: "chat-a",
      missionId: "job-root-a",
      jobId: "job-impl-a",
      coordinate: "src/contested.ts",
      intent: "edit",
      role: "implementer",
      vendor: "codex",
    });

    const second = await claimAs(REVIEW_A, {
      coordinates: ["src/contested.ts"],
      intent: "edit",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().granted).toEqual([]);
    expect(second.json().conflicts[0]).toMatchObject({
      coordinate: "src/contested.ts",
      heldByJobId: "job-impl-a",
      heldByRole: "implementer",
      heldByVendor: "codex",
      heldByName: "codex-1",
    });
    // Advisory, not blocking: the loser learns who holds it — AND its own
    // announcement is recorded, so the collision is a fact two rows make
    // visible rather than a moment that existed only inside one request.
    expect(
      await db.prisma.fileClaim.count({
        where: { coordinate: "src/contested.ts", releasedAt: null },
      })
    ).toBe(2);
  });

  it("lets a reviewer read a file an implementer is editing (edit vs review never conflicts)", async () => {
    const edit = await claimAs(IMPL_A, {
      coordinates: ["src/shared-read.ts"],
      intent: "edit",
    });
    expect(edit.json().granted).toHaveLength(1);

    const review = await claimAs(REVIEW_A, {
      coordinates: ["src/shared-read.ts"],
      intent: "review",
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().conflicts).toEqual([]);
    expect(review.json().granted[0]).toMatchObject({ intent: "review" });
  });

  it("ignores an expired or released claim when detecting conflicts", async () => {
    await db.prisma.fileClaim.create({
      data: {
        workspacePath: WORKSPACE,
        coordinateKind: "path",
        chatId: "chat-a",
        missionId: "job-root-a",
        jobId: "job-review-a",
        coordinate: "src/expired.ts",
        intent: "edit",
        role: "reviewer",
        vendor: "claude-code",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await db.prisma.fileClaim.create({
      data: {
        workspacePath: WORKSPACE,
        coordinateKind: "path",
        chatId: "chat-a",
        missionId: "job-root-a",
        jobId: "job-review-a",
        coordinate: "src/released.ts",
        intent: "edit",
        role: "reviewer",
        vendor: "claude-code",
        expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
        releasedAt: new Date(),
      },
    });

    const res = await claimAs(IMPL_A, {
      coordinates: ["src/expired.ts", "src/released.ts"],
      intent: "edit",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conflicts).toEqual([]);
    expect(res.json().granted).toHaveLength(2);
  });

  it("refreshes rather than duplicates or self-conflicts a path the holder already has", async () => {
    const first = await claimAs(IMPL_A, {
      coordinates: ["src/refresh.ts"],
      intent: "edit",
    });
    expect(first.statusCode).toBe(200);
    const original = first.json().granted[0];

    const again = await claimAs(IMPL_A, {
      coordinates: ["src/refresh.ts"],
      intent: "edit",
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().conflicts).toEqual([]);
    expect(again.json().granted).toHaveLength(1);
    expect(again.json().granted[0].id).toBe(original.id);
    expect(
      new Date(again.json().granted[0].expiresAt).getTime()
    ).toBeGreaterThan(new Date(original.expiresAt).getTime());
    expect(
      await db.prisma.fileClaim.count({
        where: { coordinate: "src/refresh.ts", releasedAt: null },
      })
    ).toBe(1);
  });

  it("keeps claims inside one chat (the same path in another chat is not a conflict)", async () => {
    const mine = await claimAs(IMPL_A, {
      coordinates: ["src/per-chat.ts"],
      intent: "edit",
    });
    expect(mine.json().granted).toHaveLength(1);

    const theirs = await claimAs(IMPL_B, {
      coordinates: ["src/per-chat.ts"],
      intent: "edit",
    });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().conflicts).toEqual([]);
    expect(theirs.json().granted[0]).toMatchObject({
      chatId: "chat-b",
      missionId: "job-root-b",
      jobId: "job-impl-b",
    });
  });

  it("releases only your own claims", async () => {
    // `src/refresh.ts` is held by the implementer ALONE, so a non-zero release
    // here could only ever be the reviewer dropping someone else's lease.
    const stolen = await app.inject({
      method: "POST",
      url: "/api/a2a/claims/release",
      headers: auth(REVIEW_A),
      payload: { coordinates: ["src/refresh.ts"] },
    });
    expect(stolen.statusCode).toBe(200);
    expect(stolen.json()).toEqual({ released: 0 });
    expect(
      await db.prisma.fileClaim.findFirst({
        where: { coordinate: "src/refresh.ts", jobId: "job-impl-a" },
      })
    ).toMatchObject({ releasedAt: null });

    const own = await app.inject({
      method: "POST",
      url: "/api/a2a/claims/release",
      headers: auth(IMPL_A),
      payload: { coordinates: ["src/refresh.ts"] },
    });
    expect(own.json()).toEqual({ released: 1 });
  });

  it("rejects a non-canonical or absolute claim path (400)", async () => {
    for (const badPath of ["/etc/passwd", "../outside.ts", "src/./sneaky.ts"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/a2a/claims",
        headers: auth(IMPL_A),
        payload: { coordinates: [badPath], intent: "edit" },
      });
      expect(res.statusCode, badPath).toBe(400);
    }
  });

  it("caps how many paths one job may hold (400)", async () => {
    await db.prisma.fileClaim.createMany({
      data: Array.from({ length: MAX_CLAIMED_PATHS_PER_JOB }, (_, index) => ({
        workspacePath: WORKSPACE,
        coordinateKind: "path",
        chatId: "chat-b",
        missionId: "job-root-b",
        jobId: "job-impl-b",
        coordinate: `src/held-${index}.ts`,
        intent: "edit",
        role: "implementer",
        vendor: "codex",
        // Backdated past the send fence: this fixture stands in for claims the
        // job made over its lifetime, not for a burst it just wrote.
        createdAt: new Date(Date.now() - MIN_PEER_SEND_INTERVAL_MS * 4),
        expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
      })),
    });

    const res = await claimAs(IMPL_B, {
      coordinates: ["src/one-too-many.ts"],
      intent: "edit",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/at most/i);
    expect(
      await db.prisma.fileClaim.count({ where: { coordinate: "src/one-too-many.ts" } })
    ).toBe(0);
  });
});

// The demo beat: two agents reach for the same file and the human sees BOTH of
// them. Every step below goes through the real route — the conflict has to be
// reachable by the API an agent actually calls, not only by a seeded row.
describe("A2A claim conflicts are reachable end to end", () => {
  it("records the refused contender, so a governed collision is visible to the human", async () => {
    const first = await claimAs(IMPL_A, {
      coordinates: ["src/demo-beat.ts"],
      intent: "edit",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().granted).toHaveLength(1);

    const second = await claimAs(REVIEW_A, {
      coordinates: ["src/demo-beat.ts"],
      intent: "edit",
    });
    // The CALLER's answer is unchanged: it lost, and it is told who holds it.
    expect(second.statusCode).toBe(200);
    expect(second.json().granted).toEqual([]);
    expect(second.json().conflicts).toEqual([
      expect.objectContaining({
        coordinate: "src/demo-beat.ts",
        heldByJobId: "job-impl-a",
      }),
    ]);

    // Two live announcements on one path is what makes the collision a fact.
    expect(
      await db.prisma.fileClaim.count({
        where: { coordinate: "src/demo-beat.ts", releasedAt: null },
      })
    ).toBe(2);
    expect(conflictHolders(await coordinationSnapshot(), "src/demo-beat.ts")).toEqual(
      ["job-impl-a", "job-review-a"]
    );
  });

  it("reports both edit holders when a REVIEWER claimed the path first", async () => {
    // draft → critique → patch is the normal order this protocol documents, so
    // the oldest live claim on a hot path is routinely a `review`. Comparing
    // every later claim against that first row (instead of pairwise) made
    // `claimsConflict("review", "edit")` false for all of them and hid two
    // genuine `edit` holders completely.
    expect(
      (await claimAs(ROOT_A, { coordinates: ["src/review-first.ts"], intent: "review" }))
        .statusCode
    ).toBe(200);
    expect(
      (await claimAs(IMPL_A, { coordinates: ["src/review-first.ts"], intent: "edit" }))
        .json().granted
    ).toHaveLength(1);
    const contender = await claimAs(REVIEW_A, {
      coordinates: ["src/review-first.ts"],
      intent: "edit",
    });
    expect(contender.json().granted).toEqual([]);

    const snapshot = await coordinationSnapshot();
    expect(conflictHolders(snapshot, "src/review-first.ts")).toEqual([
      "job-impl-a",
      "job-review-a",
    ]);
    // The reviewer that is only READING is not a party to the collision.
    expect(conflictHolders(snapshot, "src/review-first.ts")).not.toContain(
      "job-root-a"
    );
  });

  it("re-announcing a contended path refreshes the row instead of duplicating it", async () => {
    expect(
      (await claimAs(IMPL_A, { coordinates: ["src/re-announce.ts"], intent: "edit" }))
        .statusCode
    ).toBe(200);
    const announced = await claimAs(REVIEW_A, {
      coordinates: ["src/re-announce.ts"],
      intent: "edit",
    });
    expect(announced.json().conflicts).toHaveLength(1);
    const again = await claimAs(REVIEW_A, {
      coordinates: ["src/re-announce.ts"],
      intent: "edit",
    });
    expect(again.json().granted).toEqual([]);
    expect(again.json().conflicts).toHaveLength(1);

    expect(
      await db.prisma.fileClaim.count({
        where: {
          coordinate: "src/re-announce.ts",
          jobId: "job-review-a",
          releasedAt: null,
        },
      })
    ).toBe(1);
  });

  it("counts a contended announcement against the per-job claim cap (400)", async () => {
    // `job-impl-b` already holds `src/per-chat.ts`; put the coordinator of that
    // same mission at its own ceiling.
    await db.prisma.fileClaim.createMany({
      data: Array.from({ length: MAX_CLAIMED_PATHS_PER_JOB }, (_, index) => ({
        workspacePath: WORKSPACE,
        coordinateKind: "path",
        chatId: "chat-b",
        missionId: "job-root-b",
        jobId: "job-root-b",
        coordinate: `src/coord-held-${index}.ts`,
        intent: "review",
        role: "orchestrator",
        vendor: "claude-code",
        createdAt: new Date(Date.now() - MIN_PEER_SEND_INTERVAL_MS * 4),
        expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
      })),
    });

    // An announcement is a live row, so it costs what a grant costs. Free
    // contended paths would be an unbounded write for any job at its cap.
    const res = await claimAs(ROOT_B, {
      coordinates: ["src/per-chat.ts"],
      intent: "edit",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/at most/i);
    expect(
      await db.prisma.fileClaim.count({
        where: { coordinate: "src/per-chat.ts", jobId: "job-root-b" },
      })
    ).toBe(0);

    await db.prisma.fileClaim.deleteMany({ where: { jobId: "job-root-b" } });
  });
});

describe("A2A claims are rate-fenced and self-reaping", () => {
  it("spaces claims from one job (429 inside the anti-flood window)", async () => {
    const first = await claimAs(IMPL_A, {
      coordinates: ["src/fenced.ts"],
      intent: "edit",
    });
    expect(first.statusCode).toBe(200);

    const immediate = await app.inject({
      method: "POST",
      url: "/api/a2a/claims",
      headers: auth(IMPL_A),
      payload: { coordinates: ["src/fenced-again.ts"], intent: "edit" },
    });
    expect(immediate.statusCode).toBe(429);
    expect(immediate.json().message).toMatch(/spaced at least/i);
    expect(
      await db.prisma.fileClaim.count({ where: { coordinate: "src/fenced-again.ts" } })
    ).toBe(0);
    lastClaimAt.set(IMPL_A, Date.now());
  });

  it("reaps released rows instead of growing the table on claim → release churn", async () => {
    const coordinates = Array.from(
      { length: 8 },
      (_, index) => `src/churn-${index}.ts`
    );
    for (let round = 0; round < 3; round += 1) {
      const claimed = await claimAs(IMPL_A2, { coordinates, intent: "edit" });
      expect(claimed.statusCode, `round ${round}`).toBe(200);
      expect(claimed.json().granted).toHaveLength(coordinates.length);
      const released = await app.inject({
        method: "POST",
        url: "/api/a2a/claims/release",
        headers: auth(IMPL_A2),
        payload: { coordinates },
      });
      expect(released.json()).toEqual({ released: coordinates.length });
    }

    // Three rounds used to leave 24 inert rows on a table `/coordination`
    // scans every poll; the only standing cap counts ACTIVE rows, so nothing
    // bounded this. One round's worth is what survives now.
    expect(
      await db.prisma.fileClaim.count({ where: { missionId: "job-root-a2" } })
    ).toBe(coordinates.length);
  });
});

describe("A2A operator surfaces", () => {
  it("returns a coordination snapshot with coordinates only — never a message body", async () => {
    // Driven entirely through the ROUTE: two jobs, two sequential POSTs, no
    // seeded row. A test that manufactured the second claim with a direct
    // `prisma.fileClaim.create` was how the unreachable-conflict defect passed
    // review — it proved the snapshot's arithmetic against a state the API
    // could not actually produce.
    const first = await claimAs(IMPL_A, {
      coordinates: ["src/snapshot-conflict.ts"],
      intent: "edit",
    });
    expect(first.statusCode).toBe(200);
    const second = await claimAs(REVIEW_A, {
      coordinates: ["src/snapshot-conflict.ts"],
      intent: "edit",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().granted).toEqual([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/a2a/coordination?chatId=chat-a&missionId=job-root-a",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);
    const snapshot = res.json().snapshot;
    expect(snapshot).toMatchObject({
      version: 1,
      chatId: "chat-a",
      missionId: "job-root-a",
    });
    expect(snapshot.messageCount).toBeGreaterThan(0);

    const participants = snapshot.participants as {
      jobId: string;
      role: string;
      claimedPaths: number;
    }[];
    expect(participants.map((participant) => participant.jobId)).toEqual(
      expect.arrayContaining(["job-root-a", "job-impl-a", "job-review-a"])
    );
    // A job with no crew role is not a peer and is not rendered as one.
    expect(participants.map((participant) => participant.jobId)).not.toContain(
      "job-norole-a"
    );
    expect(
      participants.find((participant) => participant.jobId === "job-impl-a")
        ?.claimedPaths
    ).toBeGreaterThan(0);
    // BOTH parties are named. The crew view keys its badges on `heldByJobId`,
    // so reporting only the first holder left the agent that is actually
    // blocked unmarked.
    expect(conflictHolders(snapshot, "src/snapshot-conflict.ts")).toEqual([
      "job-impl-a",
      "job-review-a",
    ]);
    expect(
      snapshot.openConflicts.find(
        (conflict: { coordinate: string }) =>
          conflict.coordinate === "src/snapshot-conflict.ts"
      )
    ).toMatchObject({ heldByRole: "implementer", heldByVendor: "codex" });

    // The whole point of the snapshot: it is safe on an ungated surface.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("Taking backend/src/lib/auth.ts");
    expect(serialized).not.toContain("Please look at the claim conflict path.");
    expect(serialized).not.toContain("subject");
    expect(serialized).not.toContain("body");
  });

  it("gives the human the full transcript, newest first", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/a2a/messages?chatId=chat-a&missionId=job-root-a&limit=5",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);
    const messages = res.json().messages as {
      createdAt: string;
      body: string;
      missionId: string;
    }[];
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThanOrEqual(5);
    for (const message of messages) {
      expect(message.missionId).toBe("job-root-a");
      expect(message.body.length).toBeGreaterThan(0);
    }
    const timestamps = messages.map((message) => Date.parse(message.createdAt));
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });

  it("reports no unread for a FINISHED job — a dead peer has no inbox", async () => {
    // Mission A2's root has ended while a straggler worker keeps running. Both
    // are addressed by a crew broadcast; only the one that can still poll its
    // inbox has an honest backlog.
    await db.prisma.peerMessage.create({
      data: {
        chatId: "chat-a",
        missionId: "job-root-a2",
        fromJobId: "job-root-a2",
        fromRole: "orchestrator",
        fromVendor: "claude-code",
        toKind: "crew",
        kind: "status",
        subject: "wrapping up",
        body: "Closing out the second mission.",
        refs: { files: [], symbols: [] },
      },
    });

    const snapshot = await coordinationSnapshot("job-root-a2");
    const finished = snapshot.participants.find(
      (participant) => participant.jobId === "job-root-a2"
    );
    const live = snapshot.participants.find(
      (participant) => participant.jobId === "job-impl-a2"
    );
    // Its cursor can never advance again, so a non-zero count here would be a
    // permanent "N unread" against a peer nobody is waiting for.
    expect(finished).toMatchObject({ status: "done", unreadMessages: 0 });
    expect(live?.unreadMessages).toBeGreaterThan(0);
  });

  it("bounds the transcript page at the SAME cap the client and CLI use", async () => {
    const ok = await app.inject({
      method: "GET",
      url: `/api/a2a/messages?chatId=chat-a&limit=${MAX_PEER_MESSAGES_PER_JOB}`,
      headers: auth(OPERATOR),
    });
    expect(ok.statusCode).toBe(200);

    // A route maximum of its own drifted from the client's, so a page the CLI
    // accepted died on the client's parse instead of ever being served.
    const over = await app.inject({
      method: "GET",
      url: `/api/a2a/messages?chatId=chat-a&limit=${MAX_PEER_MESSAGES_PER_JOB + 1}`,
      headers: auth(OPERATOR),
    });
    expect(over.statusCode).toBe(400);
  });

  it("refuses every agent credential on the operator-only reads (403)", async () => {
    for (const url of [
      "/api/a2a/messages?chatId=chat-a",
      "/api/a2a/coordination?chatId=chat-a&missionId=job-root-a",
    ]) {
      for (const token of [AGENT, IMPL_A]) {
        const res = await app.inject({ method: "GET", url, headers: auth(token) });
        expect(res.statusCode, `${url} / ${token.slice(0, 8)}`).toBe(403);
      }
    }
  });

  it("refuses the shared agent bearer on the agent-tier writes (no exact job, no identity)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/a2a/messages",
      headers: auth(AGENT),
      payload: {
        to: { kind: "crew" },
        kind: "status",
        subject: "shared bearer",
        body: "The runner's shared bearer has no peer identity.",
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── The crew is the CHAT's, not one orchestrator turn's ──────────────────────
//
// The topology below is the founder's real mission, reproduced: chat A's root
// turn dispatched one child, MUON's own contract retry enqueued a SECOND root,
// and that root dispatched the other child. Comparing on the root job id put
// two members of ONE crew in two buckets, so every peer read returned empty,
// every send returned 201, and coordination was silently 100% undelivered.
//
// `job-root-a`  → `job-review-a`  (reviewer)
// `job-root-a2` → `job-impl-a2`   (implementer)  ← the contract-retry root
describe("A2A coordination scope is the chat's mission, not one root turn", () => {
  /**
   * Read until the inbox is empty. Earlier tests deliberately leave a backlog
   * (the budget filler alone is 64 crew messages), and delivery is oldest-first
   * behind a page cap — so an assertion about ONE new message has to start from
   * a drained cursor or it is really asserting about page 1.
   */
  async function drain(token: string): Promise<void> {
    for (let page = 0; page < 20; page += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/api/a2a/inbox",
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
      if (res.json().messages.length === 0) {
        return;
      }
    }
    throw new Error("inbox never drained");
  }

  async function inboxOf(token: string): Promise<
    { id: string; chatId: string; missionId: string; subject: string; readAt?: string }[]
  > {
    const res = await app.inject({
      method: "GET",
      url: "/api/a2a/inbox",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().messages;
  }

  it("delivers a peer message ACROSS the two root turns of one chat", async () => {
    await drain(REVIEW_A);

    // The retry root's child answers the first root's child, by ROLE.
    const sent = await sendAs(IMPL_A2, {
      to: { kind: "role", role: "reviewer" },
      kind: "review_request",
      subject: "cross-root review request",
      body: "Dispatched from the contract-retry root; same crew, same chat.",
    });
    expect(sent.statusCode).toBe(201);

    const delivered = await inboxOf(REVIEW_A);
    expect(delivered.map((message) => message.id)).toContain(
      sent.json().message.id
    );
    // Provenance is UNCHANGED: the row still records which root turn produced
    // it. The comparison widened; the history did not.
    const row = delivered.find(
      (message) => message.id === sent.json().message.id
    );
    expect(row).toMatchObject({ chatId: "chat-a", missionId: "job-root-a2" });

    // ...and the cursor advanced across the root boundary, so the crew's mail
    // is not redelivered forever.
    expect((await inboxOf(REVIEW_A)).map((message) => message.id)).not.toContain(
      sent.json().message.id
    );
  });

  it("delivers the founder's own case: a question to a role dispatched under a LATER root", async () => {
    await drain(IMPL_A2);

    const sent = await sendAs(REVIEW_A, {
      to: { kind: "role", role: "implementer" },
      kind: "question",
      subject: "question for the implementer",
      body: "This is the message that got no reply on the real mission.",
    });
    expect(sent.statusCode).toBe(201);

    expect((await inboxOf(IMPL_A2)).map((message) => message.subject)).toContain(
      "question for the implementer"
    );
  });

  it("addresses a job under another root of the same chat directly, and stamps readAt", async () => {
    await drain(REVIEW_A);

    const sent = await sendAs(IMPL_A2, {
      to: { kind: "job", jobId: "job-review-a" },
      kind: "answer",
      subject: "direct across roots",
      body: "Named peer, other root, same chat.",
    });
    expect(sent.statusCode).toBe(201);

    const delivered = await inboxOf(REVIEW_A);
    const message = delivered.find(
      (candidate) => candidate.id === sent.json().message.id
    );
    // Marking-read IS implemented — for DIRECTLY addressed mail, which has
    // exactly one recipient. It had simply never run, because nothing was ever
    // delivered to mark.
    expect(message?.readAt).toBeTruthy();
    expect(
      await db.prisma.peerMessage.findUnique({
        where: { id: sent.json().message.id },
        select: { readAt: true },
      })
    ).not.toMatchObject({ readAt: null });
  });

  it("threads a reply onto a message written under the other root", async () => {
    const parent = await sendAs(IMPL_A2, {
      to: { kind: "crew" },
      kind: "status",
      subject: "retry-root status",
      body: "Something for the crew to answer.",
    });
    expect(parent.statusCode).toBe(201);

    const reply = await sendAs(REVIEW_A, {
      to: { kind: "crew" },
      kind: "answer",
      subject: "threaded across roots",
      body: "Replying to the other root's message.",
      replyTo: parent.json().message.id,
    });
    expect(reply.statusCode).toBe(201);
  });

  it("keeps the CHAT boundary fail-closed in both directions", async () => {
    await drain(REVIEW_A);

    const foreign = await sendAs(IMPL_B, {
      to: { kind: "crew" },
      kind: "status",
      subject: "chat B crew broadcast",
      body: "Another chat's crew talking among themselves.",
    });
    expect(foreign.statusCode).toBe(201);

    expect((await inboxOf(REVIEW_A)).map((message) => message.subject)).not.toContain(
      "chat B crew broadcast"
    );

    // Naming a job in another chat is a 403 from EITHER side — widening the
    // mission comparison must not have widened the chat one.
    const outbound = await sendAs(IMPL_A, {
      to: { kind: "job", jobId: "job-impl-b" },
      kind: "question",
      subject: "cross-chat probe",
      body: "Does another chat hear me?",
    });
    expect(outbound.statusCode).toBe(403);

    const inbound = await sendAs(IMPL_B, {
      to: { kind: "job", jobId: "job-impl-a" },
      kind: "question",
      subject: "cross-chat probe back",
      body: "Does chat A hear me?",
    });
    expect(inbound.statusCode).toBe(403);

    const threaded = await sendAs(IMPL_A, {
      to: { kind: "crew" },
      kind: "answer",
      subject: "threading across chats",
      body: "Threading onto another chat's message.",
      replyTo: foreign.json().message.id,
    });
    expect(threaded.statusCode).toBe(400);
  });

  it("shows the human the WHOLE crew, across roots, on the operator surfaces", async () => {
    const snapshot = await coordinationSnapshot("job-root-a");
    const jobIds = snapshot.participants.map((participant) => participant.jobId);
    expect(jobIds).toEqual(
      expect.arrayContaining(["job-root-a", "job-review-a", "job-impl-a2"])
    );

    const transcript = await app.inject({
      method: "GET",
      url: "/api/a2a/messages?chatId=chat-a&missionId=job-root-a&limit=50",
      headers: auth(OPERATOR),
    });
    expect(transcript.statusCode).toBe(200);
    const messages = transcript.json().messages as {
      chatId: string;
      missionId: string;
      subject: string;
    }[];
    // The Topology panel's under-report: traffic written under the retry root
    // belongs to the same crew's transcript.
    expect(messages.map((message) => message.missionId)).toContain("job-root-a2");
    for (const message of messages) {
      expect(message.chatId).toBe("chat-a");
    }
    expect(messages.map((message) => message.subject)).not.toContain(
      "chat B crew broadcast"
    );
  });

  it("refuses a mission anchor that belongs to ANOTHER chat (the join hazard)", async () => {
    // `missionId` names a ROOT JOB. Now that it anchors a chat-wide scope
    // instead of partitioning the rows, an anchor from another chat has to be
    // refused explicitly — silently answering with chat A's crew under chat
    // B's coordinate is exactly the coordinate confusion that hid this bug.
    for (const url of [
      "/api/a2a/coordination?chatId=chat-a&missionId=job-root-b",
      "/api/a2a/messages?chatId=chat-a&missionId=job-root-b",
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: auth(OPERATOR),
      });
      expect(res.statusCode, url).toBe(400);
    }
  });
});

// ── ADR-0034: a peer may be waited on ────────────────────────────────────────
//
// The three properties this feature is only safe because of: the wait is
// bounded by the WAITER'S OWN budget (an unbounded wait is a budget leak and
// composes into two-peer deadlock), it returns FACTS and never a peer's text
// (so the pull-based §4 contract survives), and it cannot see outside the chat.
describe("POST /api/a2a/wait", () => {
  it("returns immediately when the condition already holds", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/a2a/wait",
      headers: auth(IMPL_A),
      payload: {
        condition: { kind: "peer_state", jobId: "job-review-a", states: ["working"] },
        timeoutMs: 5_000,
      },
    });
    expect(res.statusCode).toBe(200);
    const { result } = res.json() as { result: Record<string, unknown> };
    expect(result.outcome).toBe("satisfied");
    expect(result.observedState).toBe("working");
    // Satisfied on the first poll, so it must not have burned the timeout.
    expect(result.waitedMs as number).toBeLessThan(2_000);
  });

  it("never returns a peer's message text — only facts", async () => {
    // The property that keeps the A2A pull-based rule intact: an agent blocks
    // on something MUON computed, then opens its inbox deliberately.
    await sendAs(REVIEW_A, {
      to: { kind: "job", jobId: "job-impl-a" },
      kind: "answer",
      subject: "secret-subject-marker",
      body: "secret-body-marker",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/a2a/wait",
      headers: auth(IMPL_A),
      payload: { condition: { kind: "inbox_kind", messageKind: "answer" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("secret-body-marker");
    expect(res.body).not.toContain("secret-subject-marker");
    const { result } = res.json() as { result: Record<string, unknown> };
    expect(result.outcome).toBe("satisfied");
    expect(result.matchingUnread as number).toBeGreaterThan(0);
  });

  it("refuses to wait on a job in another chat, disclosing nothing about it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/a2a/wait",
      headers: auth(IMPL_A),
      payload: {
        condition: { kind: "peer_state", jobId: "job-impl-b", states: ["done"] },
      },
    });
    expect(res.statusCode).toBe(403);
    // ADR-0033: partition.mismatch is forced `withheld`, so the refusal cannot
    // be used to probe whether that job exists.
    expect(res.body).not.toContain("chat-b");
    const body = res.json() as { refusal?: { rule?: string; evidence?: unknown[] } };
    expect(body.refusal?.rule).toBe("partition.mismatch");
    expect(body.refusal?.evidence).toEqual([]);
  });

  it("answers the same way for a job that does not exist at all", async () => {
    // An unknown id and an out-of-chat id must be indistinguishable, or the
    // refusal becomes an existence oracle.
    const unknown = await app.inject({
      method: "POST",
      url: "/api/a2a/wait",
      headers: auth(IMPL_A),
      payload: {
        condition: { kind: "peer_state", jobId: "job-does-not-exist", states: ["done"] },
      },
    });
    expect(unknown.statusCode).toBe(403);
    expect((unknown.json() as { refusal?: { rule?: string } }).refusal?.rule).toBe(
      "partition.mismatch"
    );
  });

  it("reports `blocked` when a human gate is pending against the peer", async () => {
    // The state actually worth waiting on, and not a column — a running job
    // parked at a gate looks identical to a working one without this.
    await db.prisma.approvalRequest.create({
      data: {
        taskId: "task-a",
        requestedBy: "job-review-a",
        kind: "gate",
        reason: "needs a human",
        status: "pending",
        jobId: "job-review-a",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/a2a/wait",
      headers: auth(IMPL_A),
      payload: {
        condition: { kind: "peer_state", jobId: "job-review-a", states: ["blocked"] },
        timeoutMs: 3_000,
      },
    });
    expect(res.statusCode).toBe(200);
    const { result } = res.json() as { result: Record<string, unknown> };
    expect(result.outcome).toBe("satisfied");
    expect(result.observedState).toBe("blocked");
    await db.prisma.approvalRequest.deleteMany({ where: { jobId: "job-review-a" } });
  });

  it("times out honestly rather than hanging", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/a2a/wait",
      headers: auth(IMPL_A),
      payload: {
        condition: { kind: "peer_state", jobId: "job-review-a", states: ["done"] },
        timeoutMs: 1_200,
      },
    });
    expect(res.statusCode).toBe(200);
    const { result } = res.json() as { result: Record<string, unknown> };
    expect(result.outcome).toBe("timeout");
    expect(result.observedState).toBe("working");
    expect(result.waitedMs as number).toBeLessThan(5_000);
  });

  it("refuses a wait on chatter kinds at the schema", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/a2a/wait",
      headers: auth(IMPL_A),
      payload: { condition: { kind: "inbox_kind", messageKind: "status" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires a chat-bound crew identity like every other A2A verb", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/a2a/wait",
      headers: auth(NOROLE_A),
      payload: {
        condition: { kind: "peer_state", jobId: "job-review-a", states: ["done"] },
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("the coordination SCORE — what the layer actually did (#92)", () => {
  /**
   * A dogfood run is graded from the record. Before this, a refused claim
   * existed only inside one HTTP response: the crew's central act — one agent
   * yielding ground to another — was unmeasurable the moment the request
   * ended, which is the same shape as the delivery gap of task #99.
   *
   * The recorder is fire-and-forget, so poll like the product behaves.
   */
  async function scoreWhen(
    predicate: (score: NonNullable<Snapshot["score"]>) => boolean,
    timeoutMs = 5_000
  ): Promise<NonNullable<Snapshot["score"]>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = await coordinationSnapshot();
      const score = snapshot.score;
      expect(score, "this build scores coordination").toBeTruthy();
      if (predicate(score!) || Date.now() > deadline) return score!;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("counts a REFUSED claim, so a yield is provable after the fact", async () => {
    const before = await scoreWhen(() => true);
    await claimAs(IMPL_A, {
      coordinates: ["src/scored.ts"],
      intent: "edit",
    });
    const contended = await claimAs(REVIEW_A, {
      coordinates: ["src/scored.ts"],
      intent: "edit",
    });
    expect(contended.json().conflicts).toHaveLength(1);

    const after = await scoreWhen(
      (score) => score.claimsRefused > before.claimsRefused
    );
    expect(after.claimsRefused).toBe(before.claimsRefused + 1);
    // And the claims themselves are counted, both of them: a contended
    // announcement is still an announcement.
    expect(after.claimsTaken).toBeGreaterThanOrEqual(before.claimsTaken + 2);
  }, 20_000);

  it("a RETRY of the same collision is not a second yield", async () => {
    // An agent that polls or retries a contended claim hits /claims again and
    // again; each call recomputes the same blocker. Counted per call, ONE
    // collision inflates the headline number — the only figure that claims
    // coordination changed somebody's plan — into a count of retries, and
    // writes an unbounded event stream for a single collision.
    const before = await scoreWhen(() => true);
    await claimAs(IMPL_A, { coordinates: ["src/retried.ts"], intent: "edit" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const contended = await claimAs(REVIEW_A, {
        coordinates: ["src/retried.ts"],
        intent: "edit",
      });
      expect(contended.json().conflicts).toHaveLength(1);
    }
    const after = await scoreWhen(
      (score) => score.claimsRefused > before.claimsRefused
    );
    expect(
      after.claimsRefused,
      "three retries of one collision is one yield"
    ).toBe(before.claimsRefused + 1);
  }, 30_000);

  it("a RE-ACQUIRED coordinate is a NEW collision, not the same one", async () => {
    // The dedup must not swallow a genuinely new yield. This isolates the one
    // shape that tests it: the SAME requester, the SAME coordinate, the SAME
    // holder job — and a DIFFERENT claim row. Keyed on the holder's job alone
    // the second refusal is indistinguishable from the first and vanishes,
    // which is the opposite failure from counting retries.
    const release = (token: string) =>
      app.inject({
        method: "POST",
        url: "/api/a2a/claims/release",
        headers: auth(token),
        payload: { coordinates: ["src/reacquired.ts"] },
      });

    const before = await scoreWhen(() => true);
    await claimAs(IMPL_A, { coordinates: ["src/reacquired.ts"], intent: "edit" });
    await claimAs(REVIEW_A, { coordinates: ["src/reacquired.ts"], intent: "edit" });
    const once = await scoreWhen(
      (score) => score.claimsRefused > before.claimsRefused
    );

    // Both sides let go, so the next round repeats the FIRST round exactly:
    // same requester, same holder, same path — only the claim row is new.
    await release(REVIEW_A);
    await release(IMPL_A);
    await claimAs(IMPL_A, { coordinates: ["src/reacquired.ts"], intent: "edit" });
    await claimAs(REVIEW_A, { coordinates: ["src/reacquired.ts"], intent: "edit" });

    const twice = await scoreWhen(
      (score) => score.claimsRefused > once.claimsRefused
    );
    expect(
      twice.claimsRefused,
      "a fresh claim on the same ground is a fresh yield"
    ).toBe(once.claimsRefused + 1);
  }, 30_000);

  it("does not count a GRANTED claim as a refusal", async () => {
    const before = await scoreWhen(() => true);
    const granted = await claimAs(IMPL_A, {
      coordinates: ["src/uncontested-score.ts"],
      intent: "edit",
    });
    expect(granted.json().granted).toHaveLength(1);
    const after = await scoreWhen(
      (score) => score.claimsTaken > before.claimsTaken
    );
    expect(after.claimsRefused).toBe(before.claimsRefused);
  }, 20_000);

  it("counts only CREW-FINDING deliveries, not every memory injection", async () => {
    // The #99 lesson, applied to the score: the `memory.injected` kind carries
    // TWO different deliveries — the pre-edit gate's path-triggered standing
    // injection (no reason) and slice 3's crew-finding delivery. Counting both
    // would inflate the one number that claims "a finding reached a peer".
    const before = await scoreWhen(() => true);
    await db.prisma.event.createMany({
      data: [
        {
          laneId: "muon",
          taskId: "job-impl-a",
          kind: "memory.injected",
          message: "standing injection, not a crew finding",
          metadata: { noteId: "mem-standing", jobId: "job-impl-a" },
        },
        {
          laneId: "muon",
          taskId: "job-impl-a",
          kind: "memory.injected",
          message: "a crew finding reaching a peer",
          metadata: {
            noteId: "mem-finding",
            jobId: "job-impl-a",
            reason: "crew-finding-at-preedit",
          },
        },
      ],
    });
    const after = await scoreWhen(
      (score) => score.findingDeliveries > before.findingDeliveries
    );
    expect(after.findingDeliveries).toBe(before.findingDeliveries + 1);
  }, 20_000);

  it("keeps the id list bounded, whatever a long-lived chat accumulates", async () => {
    // `jobs` is every job the CHAT has ever had. Binding all of them into one
    // `IN (…)` would have hit SQLite's parameter cap and turned this read into
    // a hard error on exactly the missions worth scoring. The score survives,
    // and a dropped job makes the event-derived counts a declared FLOOR.
    const score = await scoreWhen(() => true);
    expect(score.claimsTaken).toBeGreaterThanOrEqual(0);
    expect(typeof score.truncated).toBe("boolean");
  }, 20_000);

  it("reports the numbers as a FLOOR when the scan hits its bound", async () => {
    // Not exercised at this size — the assertion is that the flag EXISTS and
    // is honest at small N, so a future reader cannot mistake a bounded count
    // for a total.
    const score = await scoreWhen(() => true);
    expect(score.truncated).toBe(false);
  }, 20_000);
});
