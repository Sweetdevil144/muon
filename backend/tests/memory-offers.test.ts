import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-0060 — the offer ledger. What these pin:
//   D1: offers are recorded SERVER-SIDE at serve time, keyed by the
//       capability-derived (jobId, partition) — never a caller claim — and a
//       failed offer write never fails the read (availability wins; a drop
//       understates provenance, the safe direction).
//   D2: operator serves record NOTHING (offers attribute context to governed
//       sessions); traversal serves count only TEXT-BEARING note nodes
//       (a redacted node disclosed existence, not content).
//   D3: `memory_add` carries no predecessor parameter anywhere — the offer
//       row for the created note is the only provenance written.
//   D4: the explain dossier's `history` derives from offer rows: the
//       offer-set before `recordedAt` (self excluded), pre-ledger notes read
//       "predates-offer-ledger" (never "read nothing"), and every list is
//       bounded WITH its total.
//   D5: history attaches only when the root note passes the caller's own
//       read fence — a fenced note keeps the response exactly as it was.

const AGENT = "agent-token-offers-1";
const OPERATOR = "operator-token-offers-1";
const JOB_TOKEN = `job-offers-${"o".repeat(50)}`;
const CHAT = "chat-offers-1";
const JOB = "job-offers-1";

const dbMock = vi.hoisted(() => ({
  delegationGrant: { findFirst: vi.fn() },
  dispatchJob: { findUnique: vi.fn() },
  memoryOffer: {
    upsert: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  memoryNote: { findMany: vi.fn(), findUnique: vi.fn() },
  operatorSetting: { findUnique: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
}));

const ledgerMock = vi.hoisted(() => ({
  mintContradictionEdge: vi.fn(),
  getMemoryNote: vi.fn(),
  memoryNoteGroundingScope: vi.fn(),
  resolveMemoryNoteByIdOrPrefix: vi.fn(),
  updateMemoryNote: vi.fn(),
  ingestMemoryNote: vi.fn(),
  promoteMemoryNoteToGlobal: vi.fn(),
  recordMemoryUsed: vi.fn(),
  applyMemoryExpiry: vi.fn(),
  migrateMemoryLifecyclePolicy: vi.fn(),
  MemoryLifecyclePreviewMismatchError: class extends Error {},
  MemoryPreviewStaleError: class extends Error {},
  sweepExpiredMemory: vi.fn(),
  backfillMemoryNoteWorkspace: vi.fn(),
  cloneMemoryNote: vi.fn(),
  compactMemory: vi.fn(),
  deleteMemoryNote: vi.fn(),
  listMemoryLibrary: vi.fn(),
  listOwnershipCanon: vi.fn(),
  listStandingDecisionLog: vi.fn(),
  OWNERSHIP_TOPIC_TAGS: ["ownership", "owner", "why", "rationale"],
  revertExpiredMemoryBatch: vi.fn(),
}));

const graphMock = vi.hoisted(() => ({
  // ADR-0061: the disclosed façades ride the SAME underlying fns, so every
  // existing mockResolvedValue seeding keeps working; tests that want
  // candidates override these directly.
  searchMemoryDisclosed: vi.fn(async (...args: unknown[]) => ({
    notes: await (graphMock.searchMemory as (...a: unknown[]) => Promise<unknown[]>)(...args),
    withheldCandidates: [],
  })),
  recallMemoryDisclosed: vi.fn(async (...args: unknown[]) => ({
    notes: await (graphMock.recallMemory as (...a: unknown[]) => Promise<unknown[]>)(...args),
    withheldCandidates: [],
  })),
  searchMemory: vi.fn(),
  memoryExplain: vi.fn(),
  recallMemory: vi.fn(),
  standingMemory: vi.fn(),
}));

vi.mock("../src/lib/memory-ledger.js", () => ledgerMock);
vi.mock("../src/lib/preedit.js", () => ({ preEditContext: vi.fn() }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => graphMock,
  mirrorToGraph: () => undefined,
  getEmbedder: () => undefined,
}));
vi.mock("../src/lib/codegraph.js", () => ({
  selectCodeGraphProvider: async () => null,
}));
vi.mock("../src/lib/db.js", () => ({ prisma: dbMock }));

async function buildTieredApp() {
  process.env.MUON_AGENT_TOKEN = AGENT;
  process.env.MUON_API_TOKEN = OPERATOR;
  vi.resetModules();
  const { buildApp } = await import("../src/app.js");
  return buildApp();
}

const agentAuth = { authorization: `Bearer ${JOB_TOKEN}` };
const operatorAuth = { authorization: `Bearer ${OPERATOR}` };

// A confirmed, global, human-vouched note: passes the agent read gate on
// every path this suite serves it through.
const SERVED_NOTE = {
  id: "mem-11111111-aaaa-bbbb-cccc-333333333333",
  kind: "constraint" as const,
  text: "Never write the partition from the body.",
  trust: "medium" as const,
  confirmed: true,
  confirmedBy: "human" as const,
  status: "active" as const,
  scope: "global" as const,
  stale: false,
  chatId: CHAT,
  live: true,
  expired: false,
  createdAt: "2026-08-21T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  dbMock.delegationGrant.findFirst.mockResolvedValue({
    jobId: JOB,
    tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
    issuedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  dbMock.dispatchJob.findUnique.mockResolvedValue({
    id: JOB,
    taskId: "task-offers-1",
    vendor: "codex",
    chatId: CHAT,
    parentJobId: null,
    rootJobId: null,
    capabilityMode: null,
    workspacePath: null,
    status: "running",
    interruptRequested: false,
  });
  dbMock.memoryOffer.upsert.mockResolvedValue({ id: "offer-1" });
  dbMock.memoryOffer.findFirst.mockResolvedValue(null);
  dbMock.memoryOffer.findMany.mockResolvedValue([]);
  dbMock.memoryOffer.count.mockResolvedValue(0);
  dbMock.$transaction.mockImplementation(async (ops: unknown[]) =>
    Promise.all(ops as Promise<unknown>[])
  );
  // Serves both raw reads: the migration-epoch probe (no finished_at here →
  // the constant fallback) and the offered-to COUNT(DISTINCT) pair.
  dbMock.$queryRaw.mockResolvedValue([{ jobs: 0, partitions: 0 }]);
  dbMock.memoryNote.findMany.mockResolvedValue([
    { id: SERVED_NOTE.id, chatId: CHAT },
  ]);
  dbMock.operatorSetting.findUnique.mockResolvedValue(null);
  // Expiry passthrough that PRESERVES the annotation fields the redaction and
  // crew gates read — the notes this suite serves already carry them.
  ledgerMock.applyMemoryExpiry.mockImplementation(
    async (notes: ReadonlyArray<Record<string, unknown>>) =>
      notes.map((note) => ({ live: true, expired: false, ...note }))
  );
  graphMock.searchMemory.mockResolvedValue([SERVED_NOTE]);
  ledgerMock.ingestMemoryNote.mockResolvedValue({
    note: { id: "mem-created-1" },
    action: "inserted",
  });
  ledgerMock.memoryNoteGroundingScope.mockResolvedValue({
    status: "ok",
    note: {
      ...SERVED_NOTE,
      createdBy: "agent:codex",
      provenance: {
        sourceType: "api",
        rawRef: `job:${JOB}`,
        createdAt: SERVED_NOTE.createdAt,
      },
    },
  });
});

describe("serve-time offer recording (D1/D2)", () => {
  it("GET /search under a job capability records the served note with derived coordinates", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/search?q=partition&chatId=${CHAT}`,
      headers: agentAuth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notes.map((n: { id: string }) => n.id)).toEqual([
      SERVED_NOTE.id,
    ]);
    expect(dbMock.memoryOffer.upsert).toHaveBeenCalledTimes(1);
    const call = dbMock.memoryOffer.upsert.mock.calls[0]![0] as {
      where: { jobId_noteId: { jobId: string; noteId: string } };
      create: Record<string, unknown>;
    };
    // Coordinates are DERIVED from the capability — the same values the
    // fence used — never from anything the request body/query claimed.
    expect(call.where.jobId_noteId).toEqual({
      jobId: JOB,
      noteId: SERVED_NOTE.id,
    });
    expect(call.create).toMatchObject({
      partition: CHAT,
      jobId: JOB,
      noteId: SERVED_NOTE.id,
      surface: "search",
    });
    expect(typeof call.create.principal).toBe("string");
    expect((call.create.principal as string).length).toBeGreaterThan(0);
  });

  it("an operator search records NOTHING", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/memory/search?q=partition",
      headers: operatorAuth,
    });
    expect(res.statusCode).toBe(200);
    expect(dbMock.memoryOffer.upsert).not.toHaveBeenCalled();
  });

  it("a failed offer write never fails the read, and is logged", async () => {
    dbMock.memoryOffer.upsert.mockRejectedValue(new Error("disk full"));
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/search?q=partition&chatId=${CHAT}`,
      headers: agentAuth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notes).toHaveLength(1);
  });

  it("POST / records the created note under surface 'add' — and the create body has no predecessor field to assert (D3)", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/",
      headers: agentAuth,
      payload: {
        kind: "decision",
        text: "We choose the offer ledger.",
        chatId: CHAT,
        createdBy: "codex",
        // A caller trying to assert provenance ids finds no field for it;
        // the schema has no such key and it MUST NOT reach ingest.
        derivedFrom: ["mem-forged-1"],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(dbMock.memoryOffer.upsert).toHaveBeenCalledTimes(1);
    expect(
      (dbMock.memoryOffer.upsert.mock.calls[0]![0] as {
        create: Record<string, unknown>;
      }).create
    ).toMatchObject({ surface: "add", noteId: "mem-created-1" });
    const ingestInput = ledgerMock.ingestMemoryNote.mock
      .calls[0]![0] as Record<string, unknown>;
    expect("derivedFrom" in ingestInput).toBe(false);
  });
});

describe("ADR-0063: the ingest gate on impact claims", () => {
  const CLAIM = {
    v: 1,
    target: "chargeCard",
    direction: "upstream",
    atCommit: "abc123def456",
    summary: { directCallers: 2, processes: 1, risk: "LOW" },
  };

  it("a valid claim reaches ingest verbatim", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/",
      headers: agentAuth,
      payload: {
        kind: "decision",
        text: "chargeCard has exactly two callers.",
        chatId: CHAT,
        createdBy: "codex",
        impactClaim: CLAIM,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(
      (ledgerMock.ingestMemoryNote.mock.calls[0]![0] as Record<string, unknown>)
        .impactClaim
    ).toEqual(CLAIM);
  });

  it("a malformed claim is a 400 — REJECTED, never stored (D1)", async () => {
    const app = await buildTieredApp();
    for (const bad of [
      { ...CLAIM, direction: "downstream" }, // v1 pins upstream
      { ...CLAIM, summary: { ...CLAIM.summary, risk: "SEVERE" } },
      { ...CLAIM, extra: "field" },
      "prose claim",
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/memory/",
        headers: agentAuth,
        payload: {
          kind: "decision",
          text: "chargeCard has exactly two callers.",
          chatId: CHAT,
          createdBy: "codex",
          impactClaim: bad,
        },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(ledgerMock.ingestMemoryNote).not.toHaveBeenCalled();
  });
});

describe("the recall route's branches carry their own surfaces (D2)", () => {
  it("flat recall records 'recall'; the standing arm records 'standing-pack'", async () => {
    graphMock.recallMemory.mockResolvedValue([SERVED_NOTE]);
    graphMock.standingMemory.mockResolvedValue([SERVED_NOTE]);
    ledgerMock.listStandingDecisionLog.mockResolvedValue([]);
    const app = await buildTieredApp();
    const flat = await app.inject({
      method: "GET",
      url: `/api/memory/recall?chatId=${CHAT}`,
      headers: agentAuth,
    });
    expect(flat.statusCode).toBe(200);
    expect(
      (dbMock.memoryOffer.upsert.mock.calls.at(-1)![0] as {
        create: { surface: string };
      }).create.surface
    ).toBe("recall");
    dbMock.memoryOffer.upsert.mockClear();
    const standing = await app.inject({
      method: "GET",
      url: `/api/memory/recall?standing=true&chatId=${CHAT}`,
      headers: agentAuth,
    });
    expect(standing.statusCode).toBe(200);
    expect(standing.json().notes.length).toBeGreaterThan(0);
    expect(
      (dbMock.memoryOffer.upsert.mock.calls.at(-1)![0] as {
        create: { surface: string };
      }).create.surface
    ).toBe("standing-pack");
  });
});

describe("explain: text-gated traversal offers + the history dossier (D2/D4/D5)", () => {
  const TEXT_NODE = {
    id: `note:${SERVED_NOTE.id}`,
    entityId: SERVED_NOTE.id,
    type: "note",
    kind: "constraint",
    text: SERVED_NOTE.text,
  };
  const REDACTED_PEER = {
    id: "note:mem-22222222-aaaa-bbbb-cccc-444444444444",
    entityId: "mem-22222222-aaaa-bbbb-cccc-444444444444",
    type: "note",
    kind: "decision",
    // no text: existence disclosed, content withheld
  };

  beforeEach(() => {
    graphMock.memoryExplain.mockResolvedValue({
      noteId: SERVED_NOTE.id,
      path: { nodes: [TEXT_NODE, REDACTED_PEER], edges: [], goal: "anchor" },
      contradictions: [],
      provenance: {
        root: `note:${SERVED_NOTE.id}`,
        hops: 2,
        relations: [],
        truncated: false,
        textPolicy: "confirmed-or-crew-visible-only",
      },
    });
  });

  it("records offers only for TEXT-BEARING note nodes", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/explain/${SERVED_NOTE.id}?chatId=${CHAT}`,
      headers: agentAuth,
    });
    expect(res.statusCode).toBe(200);
    const offered = dbMock.memoryOffer.upsert.mock.calls.map(
      (call) =>
        (call[0] as { create: { noteId: string; surface: string } }).create
    );
    expect(offered.map((row) => row.noteId)).toEqual([SERVED_NOTE.id]);
    expect(offered[0]!.surface).toBe("explain");
  });

  it("attaches the history dossier for a fence-visible note, offer-derived and bounded", async () => {
    const earlier = {
      noteId: "mem-33333333-aaaa-bbbb-cccc-555555555555",
      jobId: JOB,
      partition: CHAT,
      surface: "recall",
      firstAt: new Date("2026-08-21T09:00:00.000Z"),
    };
    dbMock.memoryOffer.count.mockResolvedValue(1);
    dbMock.memoryOffer.findMany.mockResolvedValue([earlier]);
    dbMock.$queryRaw.mockResolvedValue([{ jobs: 1, partitions: 1 }]);
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/explain/${SERVED_NOTE.id}?chatId=${CHAT}`,
      headers: agentAuth,
    });
    expect(res.statusCode).toBe(200);
    const history = res.json().history;
    expect(history.written).toMatchObject({
      by: "agent:codex",
      partition: CHAT,
      job: JOB, // from provenance rawRef, the authoritative source
    });
    expect(history.derivedFrom.status).toBe("ok");
    expect(history.derivedFrom.total).toBe(1);
    expect(history.derivedFrom.truncated).toBe(false);
    expect(history.derivedFrom.offers[0]).toMatchObject({
      noteId: earlier.noteId,
      jobId: JOB,
      surface: "recall",
    });
    // The self-exclusion, the before-write bound, AND the workspace fence
    // are IN the queries (review finding: chat↔workspace 1:1 is a
    // coincidence of two keys; the join restates the fence).
    const derivedWhere = (
      dbMock.memoryOffer.findMany.mock.calls.find(
        (call) =>
          (call[0] as { where: { partition?: string } }).where.partition ===
          CHAT
      )![0] as {
        where: {
          noteId: { not: string };
          firstAt: { lte: Date };
          workspacePath: string | null;
        };
      }
    ).where;
    expect(derivedWhere.noteId).toEqual({ not: SERVED_NOTE.id });
    expect(derivedWhere.firstAt.lte).toEqual(new Date(SERVED_NOTE.createdAt));
    expect(derivedWhere.workspacePath).toBeNull();
    const offeredWhere = (
      dbMock.memoryOffer.findMany.mock.calls.find(
        (call) =>
          (call[0] as { where: { noteId?: unknown } }).where.noteId ===
          SERVED_NOTE.id
      )![0] as { where: { workspacePath: string | null } }
    ).where;
    expect(offeredWhere.workspacePath).toBeNull();
  });

  it("a note that predates the offer ledger reads 'predates-offer-ledger', never an empty set", async () => {
    ledgerMock.memoryNoteGroundingScope.mockResolvedValue({
      status: "ok",
      note: {
        ...SERVED_NOTE,
        createdAt: "2026-07-01T00:00:00.000Z",
        createdBy: "human",
        provenance: null,
      },
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/explain/${SERVED_NOTE.id}?chatId=${CHAT}`,
      headers: agentAuth,
    });
    expect(res.json().history.derivedFrom).toEqual({
      status: "predates-offer-ledger",
    });
  });

  it("omits history entirely when the fence forbids the root note (D5)", async () => {
    ledgerMock.memoryNoteGroundingScope.mockResolvedValue({
      status: "forbidden",
      reason: "outside this job capability",
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/explain/${SERVED_NOTE.id}?chatId=${CHAT}`,
      headers: agentAuth,
    });
    expect(res.statusCode).toBe(200);
    expect("history" in res.json()).toBe(false);
  });
});

describe("the offer lib's own contracts", () => {
  it("noteIdsFromTraversalNodes keeps only text-bearing note nodes", async () => {
    const { noteIdsFromTraversalNodes } = await import(
      "../src/lib/memory-offers.js"
    );
    expect(
      noteIdsFromTraversalNodes([
        { type: "note", entityId: "a", text: "served" },
        { type: "note", entityId: "b" }, // redacted
        { type: "symbol", entityId: "c", text: "not a note" },
        null,
      ])
    ).toEqual(["a"]);
  });

  it("the boundary skips callers without a derived job+partition, dedupes ids, and returns the content IDENTICAL", async () => {
    // ADR-0088: `recordMemoryOffers` is module-private now — the boundary
    // is the only recording path, so the lib's own contract is exercised
    // through it. The branded return is the SAME runtime value: the brand
    // is type-only proof-of-record, never a wrapper.
    const { serveNoteContent } = await import("../src/lib/memory-offers.js");
    const content = [{ id: "x" }];
    const servedOperator = await serveNoteContent(
      { principal: "human" },
      "search",
      content,
      ["x"]
    );
    expect(servedOperator).toBe(content);
    expect(dbMock.memoryOffer.upsert).not.toHaveBeenCalled();
    const servedAgent = await serveNoteContent(
      { principal: "agent:codex", jobId: JOB, chatId: CHAT },
      "search",
      content,
      ["x", "x", "y"]
    );
    expect(servedAgent).toBe(content);
    expect(dbMock.memoryOffer.upsert).toHaveBeenCalledTimes(2);
  });
});
