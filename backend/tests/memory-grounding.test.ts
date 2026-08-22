import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-0058 — the grounding routes. What these pin:
//   D2: the check-kind list is POSITIVE (a fourth kind is a 400, never a
//       silent accept), and one row per kind.
//   D3: a mismatch files the contradiction proposal SERVER-side, as an
//       UNCONFIRMED note (proposalOnly, whoever the caller is), anchored where
//       the target is anchored, plus the contradicts edge.
//   D4: the overall verdict is DERIVED — all not-checkable is
//       "nothing-checkable", a truthful outcome, never a vacuous pass.
//   And the write half takes EXACT ids only; the facts read honours the
//   git-style prefix like every other read.

const AGENT = "agent-token-grounding-1";
const JOB_TOKEN = `job-grounding-${"g".repeat(50)}`;

const dbMock = vi.hoisted(() => ({
  delegationGrant: { findFirst: vi.fn() },
  dispatchJob: { findUnique: vi.fn() },
  memoryGrounding: { create: vi.fn(), findFirst: vi.fn() },
  memoryEdge: { create: vi.fn() },
  // ADR-0063: the facts read pulls the stored claim column.
  memoryNote: { findUnique: vi.fn() },
}));

const ledgerMock = vi.hoisted(() => ({
  getMemoryNote: vi.fn(),
  memoryNoteGroundingScope: vi.fn(),
  resolveMemoryNoteByIdOrPrefix: vi.fn(),
  updateMemoryNote: vi.fn(),
  ingestMemoryNote: vi.fn(),
  promoteMemoryNoteToGlobal: vi.fn(),
  recordMemoryUsed: vi.fn(),
  applyMemoryExpiry: vi.fn(async (notes: unknown[]) => notes),
  migrateMemoryLifecyclePolicy: vi.fn(),
  MemoryLifecyclePreviewMismatchError: class extends Error {},
  sweepExpiredMemory: vi.fn(),
  // ADR-0081 A3: the route's post-tx mirror leg through the one spelling.
  mintContradictionEdge: vi.fn(),
}));
const preeditMock = vi.hoisted(() => ({ preEditContext: vi.fn() }));

vi.mock("../src/lib/memory-ledger.js", () => ledgerMock);
vi.mock("../src/lib/preedit.js", () => preeditMock);
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
  getEmbedder: () => undefined,
}));
vi.mock("../src/lib/codegraph.js", () => ({
  selectCodeGraphProvider: async () => null,
}));
vi.mock("../src/lib/db.js", () => ({ prisma: dbMock }));

async function buildTieredApp() {
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const { buildApp } = await import("../src/app.js");
  return buildApp();
}

// Memory routes require dispatch lineage: the agent presents its JOB token,
// and the capability derives the partition. The grant + job are mocked.
const auth = { authorization: `Bearer ${JOB_TOKEN}` };

const NOTE = {
  id: "mem-11111111-aaaa-bbbb-cccc-222222222222",
  kind: "constraint",
  symbols: ["src/pay/charge.ts#charge"],
  modules: ["src/pay/charge.ts"],
  stale: false,
  staleSince: null,
  createdAt: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  dbMock.delegationGrant.findFirst.mockResolvedValue({
    jobId: "job-ground-1",
    tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
    issuedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  dbMock.dispatchJob.findUnique.mockResolvedValue({
    id: "job-ground-1",
    taskId: "task-1",
    vendor: "codex",
    chatId: "chat-ground-1",
    parentJobId: null,
    rootJobId: null,
    capabilityMode: null,
    workspacePath: null,
    status: "running",
    interruptRequested: false,
  });
  dbMock.memoryGrounding.create.mockImplementation(
    async (input: { data: Record<string, unknown> }) => ({
      id: "ground-1",
      at: new Date("2026-08-20T12:00:00.000Z"),
      ...input.data,
    })
  );
  dbMock.memoryGrounding.findFirst.mockResolvedValue(null);
  dbMock.memoryNote.findUnique.mockResolvedValue({ impactClaim: null });
  dbMock.memoryEdge.create.mockResolvedValue({ id: "edge-1" });
  ledgerMock.getMemoryNote.mockResolvedValue(NOTE);
  ledgerMock.memoryNoteGroundingScope.mockResolvedValue({
    status: "ok",
    note: NOTE,
  });
  ledgerMock.resolveMemoryNoteByIdOrPrefix.mockResolvedValue(NOTE);
  dbMock.$transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
  dbMock.memoryEdge.upsert = vi.fn().mockResolvedValue({ id: "edge-1" });
  ledgerMock.ingestMemoryNote.mockResolvedValue({
    note: { id: "mem-proposal-1" },
    action: "inserted",
  });
});

describe("GET /:noteId/ground-facts", () => {
  it("returns the checkable coordinates and the last stamp", async () => {
    dbMock.memoryGrounding.findFirst.mockResolvedValue({
      verdict: "holds",
      at: new Date("2026-08-19T00:00:00.000Z"),
      groundedBy: "agent:codex",
      proposalNoteId: null,
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/${NOTE.id}/ground-facts`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.note).toMatchObject({
      id: NOTE.id,
      symbols: NOTE.symbols,
      modules: NOTE.modules,
      stale: false,
    });
    expect(body.lastGrounding).toMatchObject({
      verdict: "holds",
      groundedBy: "agent:codex",
    });
    await app.close();
  });

  it("honours the git-style prefix — it is a READ", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/memory/mem-11111111/ground-facts",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(ledgerMock.resolveMemoryNoteByIdOrPrefix).toHaveBeenCalledWith(
      "mem-11111111"
    );
    await app.close();
  });
});

describe("POST /:noteId/ground", () => {
  it("holds: persists the stamp, files nothing", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${NOTE.id}/ground`,
      headers: auth,
      payload: {
        checks: [
          { kind: "anchor-existence", verdict: "holds", detail: "2 anchors resolve" },
          { kind: "staleness", verdict: "holds", detail: "nothing changed" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ verdict: "holds", proposalNoteId: null });
    expect(ledgerMock.ingestMemoryNote).not.toHaveBeenCalled();
    expect(dbMock.memoryGrounding.create).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("mismatch: files the UNCONFIRMED contradiction proposal server-side, with the edge", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${NOTE.id}/ground`,
      headers: auth,
      payload: {
        checks: [
          {
            kind: "anchor-existence",
            verdict: "mismatch",
            detail: "symbol 'src/pay/charge.ts#charge' no longer resolves",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      verdict: "mismatch",
      proposalNoteId: "mem-proposal-1",
    });
    // The proposal is a machine's claim about a note — it PROPOSES, whoever
    // ran the grounding, anchored where the target is anchored (ADR-0058 D3).
    const ingest = ledgerMock.ingestMemoryNote.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(ingest.kind).toBe("question");
    expect(ingest.proposalOnly).toBe(true);
    expect(ingest.symbols).toEqual(NOTE.symbols);
    expect(ingest.modules).toEqual(NOTE.modules);
    expect(String(ingest.text)).toContain("anchor-existence");
    // Edge + stamp are ONE transaction (a swallowed edge failure beside a
    // successful stamp left the contradiction undiscoverable), and the edge
    // is an upsert so a retried grounding replays instead of tripping the
    // unique constraint.
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
    expect(dbMock.memoryEdge.upsert).toHaveBeenCalledWith({
      where: {
        fromId_toId_kind: {
          fromId: "mem-proposal-1",
          toId: NOTE.id,
          kind: "contradicts",
        },
      },
      update: {},
      create: { fromId: "mem-proposal-1", toId: NOTE.id, kind: "contradicts" },
    });
    // The stamp records WHICH proposal it filed.
    expect(dbMock.memoryGrounding.create.mock.calls[0]![0].data).toMatchObject({
      verdict: "mismatch",
      proposalNoteId: "mem-proposal-1",
    });
    await app.close();
  });

  it("all not-checkable derives 'nothing-checkable' — never a vacuous pass", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${NOTE.id}/ground`,
      headers: auth,
      payload: {
        checks: [
          { kind: "impact-agreement", verdict: "not-checkable", detail: "no claim" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().verdict).toBe("nothing-checkable");
    expect(ledgerMock.ingestMemoryNote).not.toHaveBeenCalled();
    await app.close();
  });

  it("a fourth check kind is a 400 — the list is POSITIVE", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${NOTE.id}/ground`,
      headers: auth,
      payload: {
        checks: [{ kind: "vibes", verdict: "holds", detail: "trust me" }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(dbMock.memoryGrounding.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("two rows for one kind is a 400 — a stamp cannot contradict itself", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${NOTE.id}/ground`,
      headers: auth,
      payload: {
        checks: [
          { kind: "staleness", verdict: "holds", detail: "a" },
          { kind: "staleness", verdict: "mismatch", detail: "b" },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("the WRITE takes exact ids only — a prefix is a 404", async () => {
    ledgerMock.memoryNoteGroundingScope.mockResolvedValue({
      status: "missing",
      reason: "Only an active memory note can be grounded.",
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/mem-11111111/ground",
      headers: auth,
      payload: {
        checks: [{ kind: "staleness", verdict: "holds", detail: "x" }],
      },
    });
    expect(res.statusCode).toBe(404);
    expect(ledgerMock.resolveMemoryNoteByIdOrPrefix).not.toHaveBeenCalled();
    await app.close();
  });
});


describe("the partition fence (review finding: any known id was inspectable)", () => {
  it("an out-of-partition note is FORBIDDEN on the write…", async () => {
    ledgerMock.memoryNoteGroundingScope.mockResolvedValue({
      status: "forbidden",
      reason: "The source note belongs to another workspace.",
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/memory/${NOTE.id}/ground`,
      headers: auth,
      payload: {
        checks: [{ kind: "staleness", verdict: "holds", detail: "x" }],
      },
    });
    expect(res.statusCode).toBe(403);
    expect(dbMock.memoryGrounding.create).not.toHaveBeenCalled();
    expect(ledgerMock.ingestMemoryNote).not.toHaveBeenCalled();
    await app.close();
  });

  it("…and reads as MISSING on the facts read — existence is not probeable", async () => {
    ledgerMock.memoryNoteGroundingScope.mockResolvedValue({
      status: "forbidden",
      reason: "The source note belongs to another workspace.",
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/${NOTE.id}/ground-facts`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ADR-0063 — the stored impact claim is a CHECKABLE COORDINATE of the note:
// the facts read exposes it parsed (so the MCP verb can re-run impact against
// it), and a corrupt row reads as NO claim — the third check stays honestly
// not-checkable rather than the read throwing.
describe("ADR-0063: ground-facts exposes the impact claim", () => {
  const CLAIM = {
    v: 1,
    target: "charge",
    module: "src/pay/charge.ts",
    direction: "upstream",
    atCommit: "abc123def456",
    summary: { directCallers: 2, processes: 1, risk: "LOW" },
  };

  it("returns the parsed claim beside the anchors", async () => {
    dbMock.memoryNote.findUnique.mockResolvedValue({
      impactClaim: JSON.stringify(CLAIM),
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/${NOTE.id}/ground-facts`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().note.impactClaim).toEqual(CLAIM);
    await app.close();
  });

  it("a corrupt or absent stored claim reads as null, never a throw", async () => {
    for (const stored of [null, "not json", '{"v":9}']) {
      dbMock.memoryNote.findUnique.mockResolvedValue({ impactClaim: stored });
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/memory/${NOTE.id}/ground-facts`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().note.impactClaim).toBeNull();
      await app.close();
    }
  });
});
