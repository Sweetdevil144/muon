import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Security regression tests for two governance holes on the memory HTTP routes
// (found in the DB+code security review):
//   HIGH-1, an agent-tier caller must not be able to EVICT/tamper a
//     HUMAN-CONFIRMED note out of the hero gate via a status/trust/text PATCH
//     (only `confirmed` used to be operator-gated).
//   HIGH-2, `trustFloor` on the un-gated POST /preedit route let an agent admit
//     its own UNCONFIRMED note's verbatim text into the confirmed-only gate. It
//     is now honored only for the operator tier.
// These assert the ROUTE-level tier guards; the ledger/preedit internals are
// mocked so the test isolates the auth boundary.

const OPERATOR = "operator-token-mem-govern-1";
const AGENT = "agent-token-mem-govern-1";
const JOB_TOKEN = `job-memory-govern-${"c".repeat(45)}`;

const dbMock = vi.hoisted(() => ({
  delegationGrant: {
    findFirst: vi.fn(),
  },
  dispatchJob: {
    findUnique: vi.fn(),
  },
}));

const ledgerMock = vi.hoisted(() => ({
  getMemoryNote: vi.fn(),
  updateMemoryNote: vi.fn(),
  ingestMemoryNote: vi.fn(),
  promoteMemoryNoteToGlobal: vi.fn(),
  recordMemoryUsed: vi.fn(),
  // R3: the read/gate routes drop expired notes via the durable ledger.
  // Identity here — this file isolates the tier boundary, not expiry.
  applyMemoryExpiry: vi.fn(async (notes: unknown[]) => notes),
  migrateMemoryLifecyclePolicy: vi.fn(),
  MemoryLifecyclePreviewMismatchError: class extends Error {},
  sweepExpiredMemory: vi.fn(),
}));
const preeditMock = vi.hoisted(() => ({ preEditContext: vi.fn() }));

vi.mock("../src/lib/memory-ledger.js", () => ledgerMock);
vi.mock("../src/lib/preedit.js", () => preeditMock);
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
  // KG-10 (ADR-0014): the route resolves the embedder for the duplicate-work
  // reader; dense off here → undefined → duplicateWork degrades to [] (no embed).
  getEmbedder: () => undefined,
}));
vi.mock("../src/lib/codegraph.js", () => ({
  selectCodeGraphProvider: async () => null,
}));
vi.mock("../src/lib/db.js", () => ({ prisma: dbMock }));

async function buildTieredApp() {
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const { buildApp } = await import("../src/app.js");
  return buildApp();
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("memory route governance, PATCH cannot evict a confirmed note (HIGH-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ledgerMock.updateMemoryNote.mockResolvedValue({ id: "n1" });
  });

  it("agent PATCH {status:'rejected'} on a CONFIRMED note → 403; ledger untouched", async () => {
    ledgerMock.getMemoryNote.mockResolvedValue({
      id: "n1",
      confirmed: true,
      createdBy: "human:carol",
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/memory/n1",
      headers: auth(AGENT),
      payload: { status: "rejected" },
    });
    expect(res.statusCode).toBe(403);
    expect(ledgerMock.updateMemoryNote).not.toHaveBeenCalled();
    await app.close();
  });

  it("agent PATCH {trust:'low'} on a CONFIRMED note → 403 (cannot re-trust it out)", async () => {
    ledgerMock.getMemoryNote.mockResolvedValue({
      id: "n1",
      confirmed: true,
      createdBy: "human:carol",
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/memory/n1",
      headers: auth(AGENT),
      payload: { trust: "low" },
    });
    expect(res.statusCode).toBe(403);
    expect(ledgerMock.updateMemoryNote).not.toHaveBeenCalled();
    await app.close();
  });

  it("agent PATCH {text:...} on a CONFIRMED note → 403 (no unconfirmed-successor swap)", async () => {
    ledgerMock.getMemoryNote.mockResolvedValue({
      id: "n1",
      confirmed: true,
      createdBy: "human:carol",
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/memory/n1",
      headers: auth(AGENT),
      payload: { text: "attacker rewrite of a confirmed constraint" },
    });
    expect(res.statusCode).toBe(403);
    expect(ledgerMock.updateMemoryNote).not.toHaveBeenCalled();
    await app.close();
  });

  it("OPERATOR PATCH {status:'rejected'} on a confirmed note → 200 (the human governs)", async () => {
    ledgerMock.getMemoryNote.mockResolvedValue({
      id: "n1",
      confirmed: true,
      createdBy: "human:carol",
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/memory/n1",
      headers: auth(OPERATOR),
      payload: { status: "rejected" },
    });
    expect(res.statusCode).toBe(200);
    expect(ledgerMock.updateMemoryNote).toHaveBeenCalledOnce();
    await app.close();
  });

  it("agent PATCH {text:...} on an unconfirmed agent note → 403 because shared-agent ownership is not provable", async () => {
    ledgerMock.getMemoryNote.mockResolvedValue({
      id: "n1",
      confirmed: false,
      createdBy: "agent:codex",
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/memory/n1",
      headers: auth(AGENT),
      payload: { text: "a refined attempt note" },
    });
    expect(res.statusCode).toBe(403);
    expect(ledgerMock.getMemoryNote).not.toHaveBeenCalled();
    expect(ledgerMock.updateMemoryNote).not.toHaveBeenCalled();
    await app.close();
  });

  it("operator PATCH {text:...} on an unconfirmed agent note → 200 with a human principal", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/memory/n1",
      headers: auth(OPERATOR),
      payload: { text: "a human-governed refinement" },
    });
    expect(res.statusCode).toBe(200);
    expect(ledgerMock.updateMemoryNote).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({
        text: "a human-governed refinement",
        principal: "human",
      })
    );
    await app.close();
  });

  it("agent PATCH {confirmed:true} → 403 (self-confirm block unchanged)", async () => {
    ledgerMock.getMemoryNote.mockResolvedValue({
      id: "n1",
      confirmed: false,
      createdBy: "agent:codex",
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/memory/n1",
      headers: auth(AGENT),
      payload: { confirmed: true },
    });
    expect(res.statusCode).toBe(403);
    expect(ledgerMock.updateMemoryNote).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("memory route governance, trustFloor is operator-only (HIGH-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preeditMock.preEditContext.mockResolvedValue({
      memories: [],
      warnings: [],
      blastRadius: { modules: [], symbols: [], depth: 0, source: "none" },
      pendingProposals: [],
      // D14: coverage is part of the gate library's contract now — the route
      // re-tallies it after the ledger re-gate, so a stub must carry one.
      coverage: {
        anchors: {
          modules: { requested: 0, resolved: 0 },
          symbols: { requested: 0, resolved: 0 },
          unreadable: 0,
        },
        notes: { considered: 0, admitted: 0, surfaced: 0 },
        admittedBy: { humanConfirmed: 0, crewVouched: 0, trustFloor: 0 },
        crewChat: false,
        emptyReason: "no_anchors",
      },
    });
    dbMock.delegationGrant.findFirst.mockResolvedValue({
      jobId: "job-memory-govern",
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    dbMock.dispatchJob.findUnique.mockResolvedValue({
      id: "job-memory-govern",
      taskId: "task-memory-govern",
      chatId: "chat-govern",
      parentJobId: null,
      rootJobId: null,
      capabilityMode: "worker",
      workspacePath: null,
      status: "running",
      interruptRequested: false,
    });
  });

  it("agent POST /preedit {trustFloor:'low'} → preEditContext receives trustFloor:undefined (confirmed-only)", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/preedit",
      headers: auth(JOB_TOKEN),
      payload: { module: "x/y.ts", trustFloor: "low" },
    });
    expect(res.statusCode).toBe(200);
    expect(preeditMock.preEditContext).toHaveBeenCalledOnce();
    const opts = preeditMock.preEditContext.mock.calls[0][2] as {
      trustFloor?: string;
    };
    expect(opts.trustFloor).toBeUndefined();
    await app.close();
  });

  it("operator POST /preedit {trustFloor:'low'} → preEditContext receives trustFloor:'low' (human review knob preserved)", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/preedit",
      headers: auth(OPERATOR),
      payload: { module: "x/y.ts", trustFloor: "low" },
    });
    expect(res.statusCode).toBe(200);
    const opts = preeditMock.preEditContext.mock.calls[0][2] as {
      trustFloor?: string;
    };
    expect(opts.trustFloor).toBe("low");
    await app.close();
  });
});

describe("memory route governance, agent writes remain proposals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.delegationGrant.findFirst.mockResolvedValue({
      jobId: "job-memory-govern",
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    dbMock.dispatchJob.findUnique.mockResolvedValue({
      id: "job-memory-govern",
      taskId: "task-memory-govern",
      chatId: "chat-govern",
      parentJobId: null,
      rootJobId: null,
      capabilityMode: "worker",
      workspacePath: null,
      status: "running",
      interruptRequested: false,
    });
    ledgerMock.ingestMemoryNote.mockResolvedValue({
      note: { id: "mem-agent-proposal" },
      action: "inserted",
    });
  });

  it("forces an exact-job agent write through proposalOnly with server-derived scope", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(JOB_TOKEN),
      payload: {
        kind: "constraint",
        text: "Keep captured notes provisional.",
        createdBy: "human:forged",
        chatId: "chat-govern",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(ledgerMock.ingestMemoryNote).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalOnly: true,
        taskId: "task-memory-govern",
        chatId: "chat-govern",
        createdBy: "agent:job:job-memory-govern",
      })
    );
    await app.close();
  });

  // F2: `trust` was body-supplied and never tier-clamped, and "high" is not a
  // label — it is authority. A high-trust note NEVER auto-expires, and the
  // destructive-write gate admits a supersede when the writer's trust is at or
  // above the victim's. So `trust:"high"` bought an agent both permanence for
  // its own guesses and write authority over unconfirmed peers.
  it("clamps an agent's self-asserted trust:'high' to the agent ceiling", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(JOB_TOKEN),
      payload: {
        kind: "constraint",
        text: "This note declares itself permanent.",
        createdBy: "codex",
        trust: "high",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(ledgerMock.ingestMemoryNote).toHaveBeenCalledWith(
      expect.objectContaining({ trust: "medium" })
    );
    await app.close();
  });

  it("preserves an agent's HONEST lower declaration (clamped, never inflated)", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(JOB_TOKEN),
      payload: {
        kind: "attempt",
        text: "A hunch I am not confident about.",
        createdBy: "codex",
        trust: "low",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(ledgerMock.ingestMemoryNote).toHaveBeenCalledWith(
      expect.objectContaining({ trust: "low" })
    );
    await app.close();
  });

  it("leaves trust ABSENT when the body omits it, so the ledger derives it", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(JOB_TOKEN),
      payload: {
        kind: "decision",
        text: "No trust claimed at all.",
        createdBy: "codex",
      },
    });

    expect(res.statusCode).toBe(201);
    const input = ledgerMock.ingestMemoryNote.mock.calls[0]![0] as {
      trust?: string;
    };
    expect(input.trust).toBeUndefined();
    await app.close();
  });

  it("still lets the OPERATOR tier set trust:'high' (a human governance act)", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(OPERATOR),
      payload: {
        kind: "constraint",
        text: "A human-curated invariant.",
        createdBy: "human:carol",
        trust: "high",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(ledgerMock.ingestMemoryNote).toHaveBeenCalledWith(
      expect.objectContaining({ trust: "high" })
    );
    await app.close();
  });

  it("never forwards an unenumerated body field into the ledger input", async () => {
    // The ingest input is built field by field precisely so a future body key
    // cannot ride into the ledger the way `trust` did. `proposalOnly` is the
    // sharpest example: forwarding a body-supplied `false` would let an agent
    // write retire a peer note outright.
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(JOB_TOKEN),
      payload: {
        kind: "decision",
        text: "Attempting to smuggle authority fields.",
        createdBy: "codex",
        proposalOnly: false,
        expiresAt: null,
      },
    });

    expect(res.statusCode).toBe(201);
    const input = ledgerMock.ingestMemoryNote.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(input.proposalOnly).toBe(true);
    expect(input).not.toHaveProperty("expiresAt");
    await app.close();
  });
});
