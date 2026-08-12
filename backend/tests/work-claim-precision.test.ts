import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SLICE 1, MEASURED — stance test T2 ("agents discover collision").
 *
 * The design's guardrail is specific and this file exists to produce the
 * numbers rather than assert the feature: **exact-claim recall = 100%**, and
 * **cross-workspace false collisions = 0**.
 *
 * The third measure is mine, and it is the one that would make this change a
 * regression if it were wrong: **no collision that the old path-only shape
 * caught may be lost**. Precision that drops a real conflict is not precision.
 */

const OPERATOR = "operator-token-work-claim";
const AGENT = "agent-token-work-claim";

let app: FastifyInstance;
let db: typeof import("../src/lib/db.js");
let dir: string;

const WS_A = "/repo/alpha";
const WS_B = "/repo/beta";

/**
 * A CREW IS A ROOT PLUS CHILDREN, which the ledger enforces: a partial unique
 * index allows only ONE active root job per chat. Two peers in one chat are
 * therefore a root and its child, not two roots — the first version of this
 * fixture created two roots and the database refused it, which is the shape
 * the collision tests actually need.
 *
 * `job-b1` is the cross-workspace control: a different chat AND a different
 * workspace, so nothing it claims may ever reach the crew in workspace A.
 */
const JOBS = [
  { id: "job-a1", chatId: "chat-a", workspacePath: WS_A, role: "implementer", parentJobId: null },
  { id: "job-a2", chatId: "chat-a", workspacePath: WS_A, role: "reviewer", parentJobId: "job-a1" },
  { id: "job-b1", chatId: "chat-b", workspacePath: WS_B, role: "implementer", parentJobId: null },
];

const token = (jobId: string) => `job-${jobId}-${"c".repeat(44)}`;
const auth = (jobId: string) => ({ authorization: `Bearer ${token(jobId)}` });

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-work-claim-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();

  db = await import("../src/lib/db.js");
  await db.ensureSchema();

  const { createHash } = await import("node:crypto");
  for (const job of JOBS) {
    await db.prisma.task.create({
      data: {
        id: `task-${job.id}`,
        title: job.id,
        description: job.id,
        status: "in_progress",
      },
    });
    await db.prisma.orchestratorChat.create({
      data: { id: job.chatId, taskId: `task-${job.id}`, title: job.chatId },
    }).catch(() => undefined);
    await db.prisma.dispatchJob.create({
      data: {
        id: job.id,
        taskId: `task-${job.id}`,
        chatId: job.chatId,
        vendor: "codex",
        brief: "work",
        status: "running",
        startedAt: new Date(),
        workspacePath: job.workspacePath,
        role: job.role,
        capabilityMode: "worker",
        ...(job.parentJobId
          ? { parentJobId: job.parentJobId, rootJobId: job.parentJobId }
          : {}),
      },
    });
    await db.prisma.delegationGrant.create({
      data: {
        jobId: job.id,
        tokenHash: createHash("sha256").update(token(job.id)).digest("hex"),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.prisma.fileClaim.deleteMany({});
  // The peer send fence spaces messages by MIN_PEER_SEND_INTERVAL_MS and the
  // per-job budget is durable, so a suite that publishes repeatedly must start
  // each case from an empty outbox — otherwise it measures the rate limiter.
  await db.prisma.peerMessage.deleteMany({});
});

async function claim(
  jobId: string,
  coordinates: string[],
  intent: "edit" | "review" | "investigate" = "edit"
) {
  return app.inject({
    method: "POST",
    url: "/api/a2a/claims",
    headers: auth(jobId),
    payload: { coordinates, intent },
  });
}

/** Did the second claimant learn it was contended? */
async function collides(first: string[], second: string[]): Promise<boolean> {
  await db.prisma.fileClaim.deleteMany({});
  const a = await claim("job-a1", first);
  expect(a.statusCode, JSON.stringify(first)).toBe(200);
  const b = await claim("job-a2", second);
  expect(b.statusCode, JSON.stringify(second)).toBe(200);
  return b.json().conflicts.length > 0;
}

describe("T2 — exact-claim recall on SYMBOLS", () => {
  it("a second claimant on the SAME symbol is told, every time (recall = 100%)", async () => {
    const symbols = [
      "src/pay/charge.ts#charge",
      "src/pay/charge.ts#refund",
      "apps/tui/src/shell/desk.ts#handleMouse",
      "packages/graph/src/muon-graph.ts#MuonGraph",
    ];
    const detected: boolean[] = [];
    for (const symbol of symbols) {
      detected.push(await collides([symbol], [symbol]));
    }
    expect(detected, "exact-claim recall").toEqual(symbols.map(() => true));
  });

  it("names WHICH symbol, and who holds it", async () => {
    await db.prisma.fileClaim.deleteMany({});
    await claim("job-a1", ["src/pay/charge.ts#charge"]);
    const second = await claim("job-a2", ["src/pay/charge.ts#charge"]);
    expect(second.json().conflicts[0]).toMatchObject({
      coordinateKind: "symbol",
      coordinate: "src/pay/charge.ts#charge",
      heldByJobId: "job-a1",
    });
  });
});

describe("T2 — the PRECISION a path cannot express", () => {
  it("two agents on two DIFFERENT symbols of one file do not collide", async () => {
    expect(
      await collides(["src/pay/charge.ts#charge"], ["src/pay/charge.ts#refund"])
    ).toBe(false);
  });

  it("and both are granted, so both know they may proceed", async () => {
    await db.prisma.fileClaim.deleteMany({});
    const a = await claim("job-a1", ["src/pay/charge.ts#charge"]);
    const b = await claim("job-a2", ["src/pay/charge.ts#refund"]);
    expect(a.json().granted).toHaveLength(1);
    expect(b.json().granted).toHaveLength(1);
    expect(b.json().conflicts).toEqual([]);
  });
});

describe("NO COLLISION IS LOST — the regression that would make this worse", () => {
  it("path vs path still collides, exactly as before", async () => {
    expect(await collides(["src/pay/charge.ts"], ["src/pay/charge.ts"])).toBe(true);
  });

  it("a symbol collides with someone editing its whole FILE", async () => {
    expect(await collides(["src/pay/charge.ts"], ["src/pay/charge.ts#charge"])).toBe(
      true
    );
  });

  it("…and in the other order", async () => {
    expect(await collides(["src/pay/charge.ts#charge"], ["src/pay/charge.ts"])).toBe(
      true
    );
  });

  it("the conflict says which of YOUR coordinates lost", async () => {
    // Without this the contender is told "you lost" against a coordinate it
    // never asked for, and cannot tell which of its requests was refused.
    await db.prisma.fileClaim.deleteMany({});
    await claim("job-a1", ["src/pay/charge.ts"]);
    const second = await claim("job-a2", ["src/pay/charge.ts#charge"]);
    expect(second.json().conflicts[0]).toMatchObject({
      coordinate: "src/pay/charge.ts",
      requestedCoordinate: "src/pay/charge.ts#charge",
    });
  });

  it("a symbol in a DIFFERENT file does not collide", async () => {
    expect(await collides(["src/pay/charge.ts"], ["src/pay/refund.ts#refund"])).toBe(
      false
    );
  });
});

describe("cross-workspace FALSE collisions = 0", () => {
  it("the same coordinate in another workspace never collides", async () => {
    // The measure the design names. Two repositories routinely share relative
    // paths (`src/index.ts`), and before the workspace column a claim in one
    // announced a collision to the other.
    const shared = [
      "src/index.ts",
      "src/pay/charge.ts#charge",
      "package.json",
      "README.md",
    ];
    const falseCollisions: string[] = [];
    for (const coordinate of shared) {
      await db.prisma.fileClaim.deleteMany({});
      expect((await claim("job-a1", [coordinate])).statusCode).toBe(200);
      const other = await claim("job-b1", [coordinate]);
      expect(other.statusCode).toBe(200);
      if (other.json().conflicts.length > 0) falseCollisions.push(coordinate);
    }
    expect(falseCollisions, "cross-workspace false collisions").toEqual([]);
  });

  it("SAME CHAT, DIFFERENT WORKTREE — the case the chat fence cannot catch", async () => {
    /**
     * THE MEASUREMENT THAT CORRECTED MY OWN THESIS.
     *
     * The first version of this suite "proved" the workspace fence using a
     * peer in another CHAT — and removing the fence entirely left every test
     * green, because `crewScope(chatId)` already separated them. The test was
     * measuring the chat fence and calling it the workspace fence.
     *
     * The reachable case is a crew whose child runs in a WORKTREE
     * (`.muon/worktrees/…`): same chat, different workspace, and the same
     * relative path in both. Only the workspace column separates those.
     *
     * The consequence is deliberate and worth stating: two agents editing the
     * same relative path in two worktrees are no longer reported as colliding.
     * They are not standing on the same ground, and the merge gate — which the
     * protocol names as the real enforcement — is where those two changes
     * actually meet.
     */
    const worktree = `${WS_A}/.muon/worktrees/w1`;
    await db.prisma.dispatchJob.update({
      where: { id: "job-a2" },
      data: { workspacePath: worktree },
    });
    try {
      await db.prisma.fileClaim.deleteMany({});
      expect((await claim("job-a1", ["src/index.ts"])).statusCode).toBe(200);
      const inWorktree = await claim("job-a2", ["src/index.ts"]);
      expect(inWorktree.statusCode).toBe(200);
      expect(
        inWorktree.json().conflicts,
        "a different worktree is different ground"
      ).toEqual([]);
      expect(inWorktree.json().granted).toHaveLength(1);
    } finally {
      await db.prisma.dispatchJob.update({
        where: { id: "job-a2" },
        data: { workspacePath: WS_A },
      });
    }
  });

  it("and the claim is STORED with its workspace, so the fence is durable", async () => {
    await db.prisma.fileClaim.deleteMany({});
    await claim("job-a1", ["src/index.ts"]);
    await claim("job-b1", ["src/index.ts"]);
    const rows = await db.prisma.fileClaim.findMany({
      orderBy: { workspacePath: "asc" },
      select: { workspacePath: true, coordinate: true, coordinateKind: true },
    });
    expect(rows).toEqual([
      { workspacePath: WS_A, coordinate: "src/index.ts", coordinateKind: "path" },
      { workspacePath: WS_B, coordinate: "src/index.ts", coordinateKind: "path" },
    ]);
  });
});

describe("the kind is DERIVED, never taken from the caller", () => {
  it("a `#` makes it a symbol; its absence makes it a path", async () => {
    await db.prisma.fileClaim.deleteMany({});
    await claim("job-a1", ["src/a.ts", "src/a.ts#fn"]);
    const rows = await db.prisma.fileClaim.findMany({
      orderBy: { coordinate: "asc" },
      select: { coordinate: true, coordinateKind: true },
    });
    expect(rows).toEqual([
      { coordinate: "src/a.ts", coordinateKind: "path" },
      { coordinate: "src/a.ts#fn", coordinateKind: "symbol" },
    ]);
  });

  it("refuses a coordinate that escapes the workspace, symbol form included", async () => {
    for (const bad of ["/etc/passwd", "../secrets.env", "../secrets.env#KEY"]) {
      const res = await claim("job-a1", [bad]);
      expect(res.statusCode, bad).toBe(400);
    }
  });
});

describe("`investigate` announces presence without telling anyone to yield", () => {
  it("never conflicts, in either direction", async () => {
    await db.prisma.fileClaim.deleteMany({});
    await claim("job-a1", ["src/pay/charge.ts"], "edit");
    const looking = await claim("job-a2", ["src/pay/charge.ts"], "investigate");
    expect(looking.json().conflicts).toEqual([]);

    await db.prisma.fileClaim.deleteMany({});
    await claim("job-a1", ["src/pay/charge.ts"], "investigate");
    const editing = await claim("job-a2", ["src/pay/charge.ts"], "edit");
    expect(editing.json().conflicts).toEqual([]);
  });
});

describe("release is EXACT, so a coarse release cannot drop fine work", () => {
  it("releasing the file does not drop the symbol claim", async () => {
    await db.prisma.fileClaim.deleteMany({});
    await claim("job-a1", ["src/a.ts", "src/a.ts#fn"]);
    const released = await app.inject({
      method: "POST",
      url: "/api/a2a/claims/release",
      headers: auth("job-a1"),
      payload: { coordinates: ["src/a.ts"] },
    });
    expect(released.json()).toEqual({ released: 1 });
    const live = await db.prisma.fileClaim.findMany({
      where: { releasedAt: null },
      select: { coordinate: true },
    });
    expect(live).toEqual([{ coordinate: "src/a.ts#fn" }]);
  });
});

describe("the two surfaces AGREE about what collides", () => {
  /**
   * `/claims` tells the contender; `/coordination` tells the human. Found by an
   * adversarial pass on this slice: `/coordination` read claims with only the
   * CHAT fence, so a crew whose child runs in a worktree would show the human a
   * conflict the contender was never told about. A governed fact that two
   * surfaces disagree about is worse than one neither reports.
   */
  async function coordination() {
    const res = await app.inject({
      method: "GET",
      url: "/api/a2a/coordination?chatId=chat-a&missionId=job-a1",
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json().snapshot.openConflicts as { coordinate: string }[];
  }

  it("a worktree peer collides on NEITHER surface", async () => {
    const worktree = `${WS_A}/.muon/worktrees/w1`;
    await db.prisma.dispatchJob.update({
      where: { id: "job-a2" },
      data: { workspacePath: worktree },
    });
    try {
      await db.prisma.fileClaim.deleteMany({});
      await claim("job-a1", ["src/index.ts"]);
      const contender = await claim("job-a2", ["src/index.ts"]);
      expect(contender.json().conflicts, "/claims").toEqual([]);
      expect(await coordination(), "/coordination").toEqual([]);
    } finally {
      await db.prisma.dispatchJob.update({
        where: { id: "job-a2" },
        data: { workspacePath: WS_A },
      });
    }
  });

  it("a same-workspace peer collides on BOTH surfaces", async () => {
    await db.prisma.fileClaim.deleteMany({});
    await claim("job-a1", ["src/index.ts"]);
    const contender = await claim("job-a2", ["src/index.ts"]);
    expect(contender.json().conflicts).toHaveLength(1);
    expect((await coordination()).map((c) => c.coordinate)).toContain("src/index.ts");
  });

  it("two DIFFERENT symbols of one file collide on neither", async () => {
    await db.prisma.fileClaim.deleteMany({});
    await claim("job-a1", ["src/index.ts#one"]);
    const contender = await claim("job-a2", ["src/index.ts#two"]);
    expect(contender.json().conflicts).toEqual([]);
    expect(await coordination()).toEqual([]);
  });
});

describe("a collision read that could not finish REFUSES", () => {
  it("does not grant on evidence it knows is incomplete", async () => {
    // The bound exists so the query is bounded. Hitting it means some live
    // claim on this ground went unexamined, and "no conflict" would be a
    // statement the route cannot support — so it refuses instead.
    const { MAX_CLAIMED_PATHS_PER_JOB } = await import("@muon/protocol");
    const limit = MAX_CLAIMED_PATHS_PER_JOB * 8;
    await db.prisma.fileClaim.deleteMany({});
    await db.prisma.fileClaim.createMany({
      data: Array.from({ length: limit + 1 }, (_, index) => ({
        workspacePath: WS_A,
        chatId: "chat-a",
        missionId: "job-a1",
        jobId: "job-a1",
        coordinateKind: "symbol",
        coordinate: `src/index.ts#sym${index}`,
        intent: "edit",
        role: "implementer",
        vendor: "codex",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      })),
    });

    const res = await claim("job-a2", ["src/index.ts"]);
    expect(res.statusCode, "refused rather than granted blind").toBe(409);
    expect(String(res.json().message)).toMatch(/collisions completely/i);
    // And nothing was written for the contender.
    expect(
      await db.prisma.fileClaim.count({ where: { jobId: "job-a2" } })
    ).toBe(0);
  });
});

describe("T1 — a reviewer's finding reaches the implementer without a human", () => {
  /**
   * THE SCENARIO THAT IS IMPOSSIBLE TODAY.
   *
   * A reviewer records a defect with `memory_add`; nothing links it to anyone.
   * If it also sends a `peer_message`, that is a separate decision carrying no
   * note id, so the implementer receives prose it cannot look up and the human
   * ends up relaying. `publish_finding` makes the note and its announcement one
   * act, and the announcement carries the note's id.
   *
   * What this slice does NOT claim: that the implementer is PUSHED the finding.
   * Delivery is still a pull (`peer_inbox`), and making it arrive at a work
   * boundary is slice 3. What is measured here is that the finding is
   * ADDRESSABLE — published once, linked, and readable by the peer.
   */
  async function publish(jobId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/a2a/findings",
      headers: auth(jobId),
      payload: body,
    });
  }

  it("publishes the note and the announcement in one call", async () => {
    const res = await publish("job-a2", {
      text: "charge() double-bills when the retry lands after the webhook.",
      kind: "decision",
      coordinates: ["src/pay/charge.ts#charge"],
      subject: "double-bill on retry",
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    const { noteId, messageId } = res.json();
    expect(noteId).toBeTruthy();
    expect(messageId).toBeTruthy();

    // The message CARRIES the note id — the link that makes it addressable.
    const row = await db.prisma.peerMessage.findUnique({ where: { id: messageId } });
    expect(row?.memoryNoteId).toBe(noteId);
    expect(row?.kind).toBe("finding");
  });

  it("the peer READS the finding, with the id, from its own inbox", async () => {
    await publish("job-a2", {
      text: "The retry path needs an idempotency key.",
      kind: "constraint",
      coordinates: ["src/pay/charge.ts#charge"],
      subject: "idempotency key required",
    });
    const inbox = await app.inject({
      method: "GET",
      url: "/api/a2a/inbox",
      headers: auth("job-a1"),
    });
    expect(inbox.statusCode, inbox.body).toBe(200);
    const messages = inbox.json().messages as { memoryNoteId?: string }[];
    const finding = messages.find((m) => m.memoryNoteId);
    expect(finding, "the implementer can see a linked finding").toBeDefined();
    // …and the id resolves to a real note.
    const note = await db.prisma.memoryNote.findUnique({
      where: { id: finding!.memoryNoteId! },
    });
    expect(note?.text).toContain("idempotency key");
  });

  it("the note lands UNCONFIRMED — no agent vouches for its own finding", async () => {
    // Confirmation is not a column on the note; it is a `Confirmation` row by a
    // HUMAN principal, projected at read time. Asserting `note.confirmed` (as
    // this first did) reads `undefined` and passes for the wrong reason, so
    // the absence is asserted where confirmation actually lives.
    const res = await publish("job-a2", {
      text: "This is a proposal, not a fact.",
      kind: "decision",
      subject: "proposal",
    });
    const noteId = res.json().noteId;
    expect(noteId).toBeTruthy();
    const humanVouches = await db.prisma.confirmation.count({
      where: { noteId, principal: { startsWith: "human" }, decision: "confirm" },
    });
    expect(humanVouches, "no human has vouched for an agent's own finding").toBe(0);
  });

  it("records an attempt's OUTCOME in the ledger's own field", async () => {
    const res = await publish("job-a2", {
      text: "Tried the cache-first read; it broke invalidation.",
      kind: "attempt",
      outcome: "abandoned",
      subject: "cache-first read",
    });
    const note = await db.prisma.memoryNote.findUnique({
      where: { id: res.json().noteId },
    });
    expect(note?.outcome).toBe("abandoned");
  });

  it("is scoped to the publisher's workspace and chat, never wider", async () => {
    const res = await publish("job-a2", {
      text: "Scoped to alpha only.",
      kind: "convention",
      subject: "scoping",
    });
    const note = await db.prisma.memoryNote.findUnique({
      where: { id: res.json().noteId },
    });
    expect(note?.workspacePath).toBe(WS_A);
    expect(note?.chatId).toBe("chat-a");
  });

  it("writes into the REPO ROOT's partition, not a worktree's", async () => {
    /**
     * The defect a review caught and my own test was blind to.
     *
     * Memory is partitioned by REPO ROOT, and every other write derives it with
     * `repoRootOf()`. Taking `DispatchJob.workspacePath` raw meant a job
     * dispatched into `.muon/worktrees/<x>` published its finding into a
     * partition its OWN `memory_recall` never reads — so the peer it was
     * published to could not look it up. The whole feature, defeated by one
     * missing call, and my earlier assertion passed only because the fixture
     * used a plain workspace.
     */
    const worktree = `${WS_A}/.muon/worktrees/finding-w1`;
    await db.prisma.dispatchJob.update({
      where: { id: "job-a2" },
      data: { workspacePath: worktree },
    });
    try {
      const res = await publish("job-a2", {
        text: "Published from inside a worktree.",
        kind: "decision",
        subject: "worktree partition",
      });
      expect(res.statusCode).toBe(201);
      const note = await db.prisma.memoryNote.findUnique({
        where: { id: res.json().noteId },
      });
      expect(
        note?.workspacePath,
        "a worktree resolves to the repo root its peers read"
      ).not.toContain(".muon/worktrees");
    } finally {
      await db.prisma.dispatchJob.update({
        where: { id: "job-a2" },
        data: { workspacePath: WS_A },
      });
    }
  });

  it("is a PROPOSAL — it cannot retire a peer's unconfirmed note", async () => {
    // Every other agent-tier write sets `proposalOnly`, so an equal-trust agent
    // cannot destructively supersede a peer's note before a human sees either.
    // This route omitted it, which made the route-allowlist comment's claim
    // ("exactly as POST /api/memory would leave it") false.
    const res = await publish("job-a2", {
      text: "A proposal, and only that.",
      kind: "decision",
      subject: "proposal only",
    });
    const note = await db.prisma.memoryNote.findUnique({
      where: { id: res.json().noteId },
    });
    // A proposal never lands as a retirement of something else.
    expect(note?.status).toBe("active");
    expect(note?.supersededBy).toBeNull();
  });

  it("attributes the finding to the JOB, not the vendor", async () => {
    /**
     * Crew corroboration promotes a note once TWO DISTINCT principals support
     * the same text. `agent:<vendor>` is a third spelling of the same writer,
     * so one job that published a finding and then `memory_add`ed the same text
     * would have contributed two principals and auto-vouched a claim only it
     * ever made.
     */
    const res = await publish("job-a2", {
      text: "Attribution probe.",
      kind: "decision",
      subject: "attribution",
    });
    const note = await db.prisma.memoryNote.findUnique({
      where: { id: res.json().noteId },
    });
    expect(note?.createdBy).toBe("agent:job:job-a2");
    expect(note?.createdBy, "never the vendor spelling").not.toBe("agent:codex");
  });

  it("cannot address a job on another chat", async () => {
    const res = await publish("job-a2", {
      text: "Cross-chat probe.",
      kind: "decision",
      subject: "probe",
      to: { kind: "job", jobId: "job-b1" },
    });
    expect(res.statusCode).toBe(403);
    // And nothing was written — not the note, not the message.
    expect(
      await db.prisma.peerMessage.count({ where: { subject: "probe" } })
    ).toBe(0);
    expect(
      await db.prisma.memoryNote.count({ where: { text: "Cross-chat probe." } })
    ).toBe(0);
  });

  it("cannot address itself", async () => {
    const res = await publish("job-a2", {
      text: "Talking to myself.",
      kind: "decision",
      subject: "self",
      to: { kind: "job", jobId: "job-a2" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("is REFUSED once the job has spent its message budget", async () => {
    /**
     * Otherwise publishing is an unbounded second way to say the same thing.
     *
     * The first version counted that one message was written — which happens
     * whether or not the budget is checked, so it passed with the guard
     * removed. Spending the budget first is the only version that can fail.
     */
    const { MAX_PEER_MESSAGES_PER_JOB } = await import("@muon/protocol");
    await db.prisma.peerMessage.createMany({
      data: Array.from({ length: MAX_PEER_MESSAGES_PER_JOB }, (_, index) => ({
        chatId: "chat-a",
        missionId: "job-a1",
        fromJobId: "job-a2",
        fromRole: "reviewer",
        fromVendor: "codex",
        toKind: "crew",
        kind: "status",
        subject: `spent-${index}`,
        body: "spending the budget",
        refs: { files: [], symbols: [], noteIds: [] },
        // Backdated past the send fence, so this measures the BUDGET and not
        // the rate limiter.
        createdAt: new Date(Date.now() - 60_000),
      })),
    });

    const res = await publish("job-a2", {
      text: "One past the budget.",
      kind: "decision",
      subject: "over-budget",
    });
    expect(res.statusCode).toBe(429);
    expect(String(res.json().message)).toContain("A2A budget");
    expect(
      await db.prisma.memoryNote.count({ where: { text: "One past the budget." } })
    ).toBe(0);
  });
});
