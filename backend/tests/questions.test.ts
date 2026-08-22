import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_OPEN_QUESTIONS_PER_JOB,
  MIN_QUESTION_ASK_INTERVAL_MS,
} from "@muon/protocol";

// ── ADR-0043: blocking questions ─────────────────────────────────────────────
//
// Real temp-SQLite brain, real routes. The properties under proof:
//   1. IDENTITY IS AUTHENTICATED — the ask body is identity-free by schema;
//      job/task/vendor/role are derived from the exact-job bearer.
//   2. AUTHORITY IS SPLIT — agents ask and withdraw their OWN questions;
//      only the operator answers; an answered question is never re-answered.
//   3. NOTHING STOPS — filing a question changes no job state.
//   4. THE CAP IS REAL — the per-job open-question bound refuses at the route.

const OPERATOR = "operator-token-questions";
const AGENT = "agent-token-questions";
const IMPL = `impl-q-${"a".repeat(52)}`;
const OTHER = `other-q-${"b".repeat(51)}`;
const WORKSPACE = process.cwd();

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let app: FastifyInstance;

/** The 250ms anti-flood fence is real (pass-7 HIGH #2), so the helper spaces
 *  its own asks; the fence itself is exercised deliberately below. */
const lastAskAt = new Map<string, number>();

async function ask(token: string, payload: Record<string, unknown>) {
  const previous = lastAskAt.get(token);
  if (previous !== undefined) {
    const wait = MIN_QUESTION_ASK_INTERVAL_MS - (Date.now() - previous) + 10;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  const response = await app.inject({
    method: "POST",
    url: "/api/questions",
    headers: auth(token),
    payload,
  });
  lastAskAt.set(token, Date.now());
  return response;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-questions-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();

  db = await import("../src/lib/db.js");
  await db.ensureSchema();

  await db.prisma.task.create({
    data: {
      id: "task-q",
      title: "Mission Q",
      description: "Blocking-question mission.",
      status: "in_progress",
      workspacePath: WORKSPACE,
      chatId: "chat-q",
    },
  });
  await db.prisma.orchestratorChat.create({
    data: {
      id: "chat-q",
      title: "Chat Q",
      workspacePath: WORKSPACE,
      taskId: "task-q",
    },
  });
  // One active ROOT per chat is a real invariant (migration 0032's partial
  // unique index), so the two agent jobs are WORKERS under one root.
  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-root-q",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-q",
        chatId: "chat-q",
        capabilityMode: "orchestrator",
        brief: "Coordinate mission Q.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-impl-q",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-q",
        chatId: "chat-q",
        parentJobId: "job-root-q",
        rootJobId: "job-root-q",
        role: "implementer",
        brief: "Implement mission Q.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-q",
      },
      {
        id: "job-other-q",
        kind: "oneshot",
        vendor: "claude-code",
        taskId: "task-q",
        chatId: "chat-q",
        parentJobId: "job-root-q",
        rootJobId: "job-root-q",
        brief: "A sibling job of the same task.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-q",
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      ["job-impl-q", IMPL],
      ["job-other-q", OTHER],
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

describe("asking (agent tier, identity derived)", () => {
  it("files a question with server-derived identity and returns it", async () => {
    const res = await ask(IMPL, {
      subject: "Which auth provider?",
      body: "The brief names none; the repo has stubs for two.",
    });
    expect(res.statusCode).toBe(200);
    const question = res.json().question;
    expect(question).toMatchObject({
      taskId: "task-q",
      jobId: "job-impl-q",
      askedByVendor: "codex",
      askedByRole: "implementer",
      status: "open",
      subject: "Which auth provider?",
    });
  });

  it("rejects any identity or lever field in the body — strict, deny-first", async () => {
    for (const extra of [
      { jobId: "job-other-q" },
      { taskId: "task-elsewhere" },
      { deadline: "2026-01-01T00:00:00.000Z" },
    ]) {
      const res = await ask(IMPL, { subject: "s", body: "b", ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
  });

  it("filing a question stops no clock — the job row is untouched", async () => {
    const job = await db.prisma.dispatchJob.findUnique({
      where: { id: "job-impl-q" },
    });
    expect(job?.status).toBe("running");
    expect(job?.interruptRequested).toBe(false);
  });
});

describe("reading + answering (the split)", () => {
  it("an agent reads only its OWN questions", async () => {
    const own = await app.inject({
      method: "GET",
      url: "/api/questions",
      headers: auth(IMPL),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().questions).toHaveLength(1);

    const sibling = await app.inject({
      method: "GET",
      url: "/api/questions",
      headers: auth(OTHER),
    });
    expect(sibling.statusCode).toBe(200);
    expect(sibling.json().questions).toHaveLength(0);
  });

  it("the agent tier cannot answer — answering is operator authority", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/questions",
      headers: auth(IMPL),
    });
    const id = list.json().questions[0].id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/answer`,
      headers: auth(IMPL),
      payload: { taskId: "task-q", answer: "answering myself" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("the operator answers once; the agent pulls the answer; re-answer refuses", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/questions/task/task-q",
      headers: auth(OPERATOR),
    });
    expect(list.statusCode).toBe(200);
    const id = list.json().questions[0].id as string;

    const answered = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/answer`,
      headers: auth(OPERATOR),
      payload: { taskId: "task-q", answer: "Use the OAuth stub." },
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().question).toMatchObject({
      status: "answered",
      answer: "Use the OAuth stub.",
    });

    const pulled = await app.inject({
      method: "GET",
      url: "/api/questions",
      headers: auth(IMPL),
    });
    expect(pulled.json().questions[0]).toMatchObject({
      status: "answered",
      answer: "Use the OAuth stub.",
    });

    const again = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/answer`,
      headers: auth(OPERATOR),
      payload: { taskId: "task-q", answer: "No — the other one." },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("withdrawal + the cap", () => {
  it("only the asking job may withdraw, and only while open", async () => {
    const filed = await ask(IMPL, { subject: "w?", body: "to withdraw" });
    const id = filed.json().question.id as string;

    const foreign = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/withdraw`,
      headers: auth(OTHER),
    });
    expect(foreign.statusCode).toBe(404);

    const own = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/withdraw`,
      headers: auth(IMPL),
    });
    expect(own.statusCode).toBe(200);

    const twice = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/withdraw`,
      headers: auth(IMPL),
    });
    expect(twice.statusCode).toBe(409);
  });

  it("two immediate asks from one job hit the anti-flood fence", async () => {
    const first = await ask(OTHER, { subject: "fence 1", body: "b" });
    expect(first.statusCode).toBe(200);
    // Bypass the spacing helper: fire the second ask immediately.
    const second = await app.inject({
      method: "POST",
      url: "/api/questions",
      headers: auth(OTHER),
      payload: { subject: "fence 2", body: "b" },
    });
    expect(second.statusCode).toBe(429);
    await new Promise((resolve) =>
      setTimeout(resolve, MIN_QUESTION_ASK_INTERVAL_MS + 10)
    );
    const cleanup = await app.inject({
      method: "GET",
      url: "/api/questions",
      headers: auth(OTHER),
    });
    // Withdraw the fence question so the cap test below starts clean.
    const fenceQuestion = (
      cleanup.json().questions as { id: string; subject: string; status: string }[]
    ).find((q) => q.subject === "fence 1" && q.status === "open");
    if (fenceQuestion) {
      await app.inject({
        method: "POST",
        url: `/api/questions/${fenceQuestion.id}/withdraw`,
        headers: auth(OTHER),
      });
    }
  });

  it("an agent bearer is refused the operator task listing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/questions/task/task-q",
      headers: auth(IMPL),
    });
    expect(res.statusCode).toBe(403);
  });

  it("the per-job open cap refuses the ask past the bound", async () => {
    // job-other-q holds no questions yet; fill it to the cap.
    for (let index = 0; index < MAX_OPEN_QUESTIONS_PER_JOB; index += 1) {
      const res = await ask(OTHER, {
        subject: `q ${index}`,
        body: `body ${index}`,
      });
      expect(res.statusCode).toBe(200);
    }
    const overflow = await ask(OTHER, { subject: "one more", body: "past cap" });
    expect(overflow.statusCode).toBe(429);
  });
});

describe("the open inbox (surface-parity audit 2026-08-11)", () => {
  /**
   * Agents could ask (ADR-0043) and only the CLI — with a --task-id the human
   * had to already know — could see. `GET /api/questions/open` is the inbox
   * read the desk and TUI mount: every OPEN question on the machine, derived
   * by the SAME fold as the per-task read, newest-asked first.
   */
  it("lists open questions across tasks, operator tier only", async () => {
    const asked = await ask(IMPL, {
      subject: "inbox probe: which retry policy?",
      body: "Blocked on choosing between fixed and exponential backoff.",
    });
    expect(asked.statusCode).toBe(200);
    const questionId = asked.json().question.id;

    const denied = await app.inject({
      method: "GET",
      url: "/api/questions/open",
      headers: auth(IMPL),
    });
    expect(denied.statusCode).toBe(403);

    const inbox = await app.inject({
      method: "GET",
      url: "/api/questions/open",
      headers: auth(OPERATOR),
    });
    expect(inbox.statusCode).toBe(200);
    const body = inbox.json();
    const mine = body.questions.find(
      (question: { id: string }) => question.id === questionId
    );
    expect(mine, "the fresh question is in the inbox").toBeTruthy();
    expect(mine.status).toBe("open");
    expect(mine.taskId, "taskId rides along for the answer call").toBeTruthy();
    expect(body.truncated).toBe(false);
  });

  it("an ANSWERED question leaves the inbox", async () => {
    const asked = await ask(IMPL, {
      subject: "inbox probe: answered questions vanish?",
      body: "This one gets answered immediately.",
    });
    expect(asked.statusCode).toBe(200);
    const question = asked.json().question;

    const answered = await app.inject({
      method: "POST",
      url: `/api/questions/${question.id}/answer`,
      headers: auth(OPERATOR),
      payload: { taskId: question.taskId, answer: "Exponential, capped at 30s." },
    });
    expect(answered.statusCode).toBe(200);

    const inbox = await app.inject({
      method: "GET",
      url: "/api/questions/open",
      headers: auth(OPERATOR),
    });
    const ids = inbox
      .json()
      .questions.map((entry: { id: string }) => entry.id);
    expect(ids).not.toContain(question.id);
  });
});

// ── ADR-0069: a question consults the brain before the human ─────────────────
//
// The pre-answer is HUMAN-CONFIRMED canon only, fenced by the asker's own
// capability, filed as a spine event both sides read; unconfirmed notes never
// enter the answer path. A withdrawal that proceeds on the cited answer
// records the typed reason + citations — never impersonating a human close.
describe("ADR-0069: the brain answers first", () => {
  it("attaches a confirmed pre-answer; unconfirmed notes never ride it; the typed withdrawal records its citations", async () => {
    const ledger = await import("../src/lib/memory-ledger.js");
    const { repoRootOf } = await import("../src/lib/workspace-identity.js");
    const repoRoot = await repoRootOf(WORKSPACE);
    const confirmed = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "The retry budget is capped at three attempts per lane.",
      createdBy: "human:operator",
      chatId: "chat-q",
      workspacePath: repoRoot,
    });
    // Confirm through the REAL route (a raw Confirmation row would leave the
    // graph mirror's own confirmed flag stale, which the agent-tier
    // governedOnly candidate read honours — production confirms re-mirror).
    const confirmRes = await app.inject({
      method: "PATCH",
      url: `/api/memory/${confirmed.note.id}`,
      headers: auth(OPERATOR),
      payload: { confirmed: true, principal: "human:operator" },
    });
    expect(confirmRes.statusCode).toBe(200);
    // A matching but UNCONFIRMED note: must never enter the answer path.
    const unconfirmed = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Maybe the retry budget should be five attempts per lane instead.",
      createdBy: "agent:job:job-other-q",
      proposalOnly: true,
      chatId: "chat-q",
      workspacePath: repoRoot,
    });

    // ADR-0082 fixture: an EXPIRED unconfirmed match — the ledger's expiry
    // fence applies to the crew branch too, so it must never surface.
    const expired = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "An old expired take on the retry budget from last month.",
      createdBy: "agent:job:job-other-q",
      proposalOnly: true,
      chatId: "chat-q",
      workspacePath: repoRoot,
    });
    await db.prisma.memoryNote.update({
      where: { id: expired.note.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    // A matching PACKET on the asker's task — the crew's
    // other artifact — plus lanes for its relations.
    await db.prisma.lane.createMany({
      data: [
        {
          id: "lane-q-a",
          key: "codex",
          name: "Codex",
          provider: "openai",
          role: "worker",
        },
        {
          id: "lane-q-b",
          key: "claude-code",
          name: "Claude Code",
          provider: "anthropic",
          role: "peer",
        },
      ],
    });
    await db.prisma.handoff.create({
      data: {
        id: "handoff-q-1",
        taskId: "task-q",
        fromLaneId: "lane-q-a",
        toLaneId: "lane-q-b",
        packetTitle: "Implemented the retry budget change",
        packetBody: "Raised the retry budget handling; checks green.",
        status: "pending",
      },
    });

    const res = await ask(IMPL, {
      subject: "retry budget",
      body: "What is the retry budget per lane for this task?",
    });
    expect(res.statusCode).toBe(200);
    const question = res.json().question;
    expect(question.memoryPreAnswer).toBeDefined();
    const preIds = question.memoryPreAnswer.notes.map(
      (note: { noteId: string }) => note.noteId
    );
    expect(preIds).toContain(confirmed.note.id);
    expect(preIds).not.toContain(unconfirmed.note.id);

    // ADR-0082: the crew block carries the UNCONFIRMED matching note and
    // the matching packet, each labeled with its own standing — and never
    // pollutes the confirmed pre-answer above.
    expect(question.crewContext).toBeDefined();
    const crewById = new Map(
      (question.crewContext.items as {
        kind: string;
        id: string;
        standing: string;
        excerpt: string;
      }[]).map((item) => [item.id, item])
    );
    const crewNote = crewById.get(unconfirmed.note.id);
    expect(crewNote).toBeDefined();
    expect(crewNote!.kind).toBe("note");
    expect(crewNote!.standing).toContain("unconfirmed");
    expect(crewNote!.standing).toContain("agent:job:job-other-q");
    expect(crewById.has(expired.note.id)).toBe(false);
    const crewPacket = crewById.get("handoff-q-1");
    expect(crewPacket).toBeDefined();
    expect(crewPacket!.kind).toBe("packet");
    expect(crewPacket!.standing).toContain("packet from codex");
    // Both crew serves RECORDED through the boundaries: the note in the
    // offer ledger, the packet in the 0080 delivery ledger.
    expect(
      await db.prisma.memoryOffer.count({
        where: {
          jobId: "job-impl-q",
          noteId: unconfirmed.note.id,
          surface: "question-crew-context",
        },
      })
    ).toBe(1);
    expect(
      await db.prisma.handoffOffer.count({
        where: {
          jobId: "job-impl-q",
          handoffId: "handoff-q-1",
          surface: "question-crew-context",
        },
      })
    ).toBe(1);

    // D2, structurally: a typed withdrawal citing a CREW id is refused —
    // crew context can never close a question.
    const crewCite = await app.inject({
      method: "POST",
      url: `/api/questions/${question.id}/withdraw`,
      headers: auth(IMPL),
      payload: {
        reason: "answered_from_memory",
        citedNoteIds: [unconfirmed.note.id],
      },
    });
    expect(crewCite.statusCode).toBe(400);
    expect(crewCite.json().message).toContain("own pre-answer");
    expect(
      question.memoryPreAnswer.notes.find(
        (note: { noteId: string }) => note.noteId === confirmed.note.id
      ).excerpt
    ).toContain("capped at three");

    // The typed withdrawal: recorded + cited on the fold, visible to the
    // operator's per-task read.
    const withdrawal = await app.inject({
      method: "POST",
      url: `/api/questions/${question.id}/withdraw`,
      headers: auth(IMPL),
      payload: {
        reason: "answered_from_memory",
        citedNoteIds: [confirmed.note.id],
      },
    });
    expect(withdrawal.statusCode).toBe(200);
    const listed = await app.inject({
      method: "GET",
      url: "/api/questions/task/task-q",
      headers: auth(OPERATOR),
    });
    const folded = (
      listed.json().questions as {
        id: string;
        status: string;
        withdrawnReason?: string;
        withdrawnCitedNoteIds?: string[];
        memoryPreAnswer?: unknown;
      }[]
    ).find((row) => row.id === question.id);
    expect(folded).toMatchObject({
      status: "withdrawn",
      withdrawnReason: "answered_from_memory",
      withdrawnCitedNoteIds: [confirmed.note.id],
    });
    expect(folded!.memoryPreAnswer).toBeDefined();

    // ADR-0060 via 0088's research: the pre-answer is a SERVE and records
    // its offers under the ASKER's job — without these rows, the typed
    // withdrawal's citations audit as offered:false relays.
    const offered = await db.prisma.memoryOffer.findMany({
      where: { jobId: "job-impl-q", noteId: confirmed.note.id },
    });
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({ surface: "question-preanswer" });

    // ADR-0069 D2's OVERRIDE leg: the human answers the memory-closed
    // question — the ONE legal second terminal. The override supersedes
    // the memory answer AND files the contradiction as an unconfirmed
    // proposal against the cited note ("the brain learns it was stale the
    // moment it misleads").
    const override = await app.inject({
      method: "POST",
      url: `/api/questions/${question.id}/answer`,
      headers: auth(OPERATOR),
      payload: {
        taskId: "task-q",
        answer: "No: the retry budget moved to five attempts last sprint.",
      },
    });
    expect(override.statusCode).toBe(200);
    expect(override.json().question).toMatchObject({
      status: "answered",
      overrodeMemoryAnswer: true,
      answeredBy: "operator",
      // The overridden memory answer survives as the override's provenance.
      withdrawnReason: "answered_from_memory",
      withdrawnCitedNoteIds: [confirmed.note.id],
    });
    // The contradiction proposal: unconfirmed, low-trust, anchored where
    // the cited note is anchored, edged `contradicts` against it.
    const edge = await db.prisma.memoryEdge.findFirst({
      where: { toId: confirmed.note.id, kind: "contradicts" },
    });
    expect(edge).toBeTruthy();
    const proposal = await db.prisma.memoryNote.findUnique({
      where: { id: edge!.fromId },
    });
    expect(proposal).toMatchObject({ status: "active", trust: "low" });
    expect(proposal!.text).toContain("human override contradicted");
    expect(proposal!.text).toContain("five attempts last sprint");
    expect(
      await db.prisma.confirmation.count({ where: { noteId: proposal!.id } })
    ).toBe(0);

    // The override is itself terminal: a second answer refuses.
    const again = await app.inject({
      method: "POST",
      url: `/api/questions/${question.id}/answer`,
      headers: auth(OPERATOR),
      payload: { taskId: "task-q", answer: "another go" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("a PLAIN withdrawal has no override path — answering it still refuses", async () => {
    const filed = await ask(IMPL, {
      subject: "plainly withdrawn",
      body: "This one the asker simply takes back.",
    });
    const id = filed.json().question.id;
    const withdrawn = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/withdraw`,
      headers: auth(IMPL),
      payload: {},
    });
    expect(withdrawn.statusCode).toBe(200);
    const answered = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/answer`,
      headers: auth(OPERATOR),
      payload: { taskId: "task-q", answer: "too late" },
    });
    expect(answered.statusCode).toBe(409);
  });

  it("ADR-0082: packets are an INDEPENDENT crew source — an ask matching only a packet gets crew context with no pre-answer, and a degraded packet says so", async () => {
    await db.prisma.handoff.create({
      data: {
        id: "handoff-q-frob",
        taskId: "task-q",
        fromLaneId: "lane-q-a",
        toLaneId: "lane-q-b",
        packetTitle: "Frobnicate pipeline landed",
        packetBody: "The frobnicate stage is wired; checks pending review.",
        status: "pending",
        packetJson: { degraded: { flag: true, reasons: ["checks unrun"] } },
      },
    });
    const res = await ask(IMPL, {
      subject: "frobnicate pipeline",
      body: "Did anyone already wire the frobnicate stage here?",
    });
    expect(res.statusCode).toBe(200);
    const question = res.json().question;
    // No confirmed canon matches — the ANSWER path stays silent…
    expect(question.memoryPreAnswer).toBeUndefined();
    // …while the crew's packet still surfaces, honestly classified: the
    // fixture's packetJson is a schema FRAGMENT, and the ONE shared
    // classifier calls that packet_parse_failed — never clean (the exact
    // malformed-shape case the review raised against an ad-hoc parser).
    expect(question.crewContext).toBeDefined();
    const packetItem = (question.crewContext.items as {
      kind: string;
      id: string;
      standing: string;
    }[]).find((item) => item.id === "handoff-q-frob");
    expect(packetItem).toBeDefined();
    expect(packetItem!.kind).toBe("packet");
    expect(packetItem!.standing).toContain("packet_parse_failed");
  });

  it("an ask with no matching confirmed canon simply has no pre-answer — and still files", async () => {
    const res = await ask(IMPL, {
      subject: "quarterly billing threshold",
      body: "Nothing in this brain speaks to invoicing cadence at all.",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().question.status).toBe("open");
    expect(res.json().question.memoryPreAnswer).toBeUndefined();
  });
});
