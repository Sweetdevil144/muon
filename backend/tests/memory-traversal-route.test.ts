import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_TRAVERSAL_TEXT_POLICY } from "@muon/graph";

const OPERATOR = "operator-token-memory-traversal";
const AGENT = "agent-token-memory-traversal";
const JOB_TOKEN = `job-memory-traversal-${"b".repeat(43)}`;

const dbMock = vi.hoisted(() => ({
  delegationGrant: {
    findFirst: vi.fn(),
  },
  dispatchJob: {
    findUnique: vi.fn(),
  },
}));

const graphMock = vi.hoisted(() => ({
  memoryNeighbors: vi.fn(),
  memoryExplain: vi.fn(),
  memoryAnalytics: vi.fn(),
  // B3: recall reads the mirror too, and had the same unguarded exposure.
  recallMemory: vi.fn(),
  relatedToTask: vi.fn(),
  searchMemory: vi.fn(),
}));
const ledgerMock = vi.hoisted(() => ({
  applyMemoryExpiry: vi.fn(),
}));
const settingsMock = vi.hoisted(() => ({
  getAutoConfirmAgentMemory: vi.fn(),
  getMemoryLifecyclePolicy: vi.fn(),
  setAutoConfirmAgentMemory: vi.fn(),
}));

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => graphMock,
  getEmbedder: () => undefined,
  mirrorToGraph: () => undefined,
}));
vi.mock("../src/lib/operator-settings.js", () => settingsMock);
vi.mock("../src/lib/memory-ledger.js", () => ({
  // Used by the route's SECOND, ledger-backed gate pass (redactExpiredNodes).
  applyMemoryExpiry: ledgerMock.applyMemoryExpiry,
  getMemoryNote: vi.fn(),
  ingestMemoryNote: vi.fn(),
  listMemoryLibrary: vi.fn(),
  migrateMemoryLifecyclePolicy: vi.fn(),
  MemoryLifecyclePreviewMismatchError: class extends Error {},
  promoteMemoryNoteToGlobal: vi.fn(),
  recordMemoryUsed: vi.fn(),
  updateMemoryNote: vi.fn(),
}));
vi.mock("../src/lib/preedit.js", () => ({ preEditContext: vi.fn() }));
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

describe("memory traversal routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.getAutoConfirmAgentMemory.mockResolvedValue(true);
    graphMock.memoryNeighbors.mockResolvedValue({
      nodes: [],
      edges: [],
      provenance: {
        root: "note:mem-1",
        hops: 2,
        relations: ["SUPERSEDES"],
        truncated: false,
        textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
      },
    });
    graphMock.memoryExplain.mockResolvedValue({
      noteId: "mem-1",
      path: { nodes: [], edges: [], goal: "missing" },
      contradictions: [],
      provenance: {
        root: "note:mem-1",
        hops: 6,
        relations: [],
        truncated: false,
        textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
      },
    });
    dbMock.delegationGrant.findFirst.mockResolvedValue({
      jobId: "job-memory-traversal",
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    dbMock.dispatchJob.findUnique.mockResolvedValue({
      id: "job-memory-traversal",
      taskId: "task-memory-traversal",
      chatId: "chat-a",
      parentJobId: null,
      rootJobId: null,
      capabilityMode: "worker",
      workspacePath: null,
      status: "running",
      interruptRequested: false,
    });
  });

  it("fails closed when an agent traversal has no chat scope", async () => {
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/neighbors/mem-1",
      headers: auth(AGENT),
    });
    expect(response.statusCode).toBe(403);
    expect(graphMock.memoryNeighbors).not.toHaveBeenCalled();
    await app.close();
  });

  it("prevents an agent from probing a structural root outside its note partition", async () => {
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/neighbors/module:src%2Fsecret.ts?chatId=chat-a",
      headers: auth(JOB_TOKEN),
    });
    expect(response.statusCode).toBe(400);
    expect(graphMock.memoryNeighbors).not.toHaveBeenCalled();
    await app.close();
  });

  it("threads the agent chat, server-owned crew gate, bounds, and relation allowlist", async () => {
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "GET",
      url:
        "/api/memory/neighbors/mem-1?chatId=chat-a&hops=2&limit=12" +
        "&relations=SUPERSEDES%2CCONFIRMED_BY",
      headers: auth(JOB_TOKEN),
    });
    expect(response.statusCode).toBe(200);
    expect(graphMock.memoryNeighbors).toHaveBeenCalledWith("mem-1", {
      // ADR-0026, FAIL-CLOSED: this fixture's job capability carries no
      // `workspacePath`, and such an agent now reads the §8 residue (nothing)
      // rather than getting NO clause. With no clause the chat rule's
      // `scope:"global" AND confirmed` leg was the one predicate that matches
      // across every workspace on the machine, so a chat-less job could reach
      // another repository's memory — reproduced by a security review.
      unscopedWorkspace: true,
      hops: 2,
      limit: 12,
      relFilter: ["SUPERSEDES", "CONFIRMED_BY"],
      chatId: "chat-a",
      crewVisible: true,
    });
    await app.close();
  });

  it("keeps an operator global traversal confirmed-only by disabling the crew branch", async () => {
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/neighbors/mem-1?hops=1",
      headers: auth(OPERATOR),
    });
    expect(response.statusCode).toBe(200);
    expect(settingsMock.getAutoConfirmAgentMemory).not.toHaveBeenCalled();
    expect(graphMock.memoryNeighbors).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({ chatId: undefined, crewVisible: false })
    );
    await app.close();
  });

  it("applies the same agent scope to memory explanations", async () => {
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/explain/mem-1?chatId=chat-a",
      headers: auth(JOB_TOKEN),
    });
    expect(response.statusCode).toBe(200);
    expect(graphMock.memoryExplain).toHaveBeenCalledWith("mem-1", {
      // Same fail-closed posture as `memoryNeighbors` above.
      unscopedWorkspace: true,
      limit: 100,
      chatId: "chat-a",
      crewVisible: true,
    });
    await app.close();
  });
});

// ── B3: an embedded-graph outage costs provenance, never the whole response ──
//
// `/explain/:noteId` called `getGraph().memoryExplain(...)` with no `.catch`, so
// one segfault-and-recover window — exactly what the graph boot-probe recovery
// exists for — turned the Memory tab into an unmapped 500. `/library` had
// degraded correctly since it was written; these are the routes that did not.
describe("B3 memory-graph outage degrades rather than 500s", () => {
  const OUTAGE = new Error("ladybug store is not open (boot probe recovering)");

  beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.getAutoConfirmAgentMemory.mockResolvedValue(true);
    dbMock.delegationGrant.findFirst.mockResolvedValue({
      jobId: "job-memory-traversal",
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    dbMock.dispatchJob.findUnique.mockResolvedValue({
      id: "job-memory-traversal",
      taskId: "task-memory-traversal",
      chatId: "chat-a",
      parentJobId: null,
      rootJobId: null,
      capabilityMode: "worker",
      workspacePath: null,
      status: "running",
      interruptRequested: false,
    });
  });

  it("/explain degrades with a NAMED reason instead of an unmapped 500", async () => {
    graphMock.memoryExplain.mockRejectedValue(OUTAGE);
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/explain/mem-1?chatId=chat-a",
      headers: auth(JOB_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Empty, but never a silent empty success: `degraded` is what tells the
    // Memory tab "could not be asked" apart from "has no provenance".
    expect(body).toMatchObject({
      noteId: "mem-1",
      path: { nodes: [], edges: [], goal: "missing" },
      contradictions: [],
      degraded: {
        subsystem: "memory-graph",
        reason: expect.stringContaining("ladybug store is not open"),
      },
    });
    expect(body.provenance.textPolicy).toBe(MEMORY_TRAVERSAL_TEXT_POLICY);
    await app.close();
  });

  it("/neighbors degrades the same way", async () => {
    graphMock.memoryNeighbors.mockRejectedValue(OUTAGE);
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/neighbors/mem-1?chatId=chat-a&hops=2",
      headers: auth(JOB_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      nodes: [],
      edges: [],
      provenance: { root: "mem-1", hops: 2, truncated: false },
      degraded: { subsystem: "memory-graph" },
    });
    await app.close();
  });

  it("/recall degrades rather than 500s, on BOTH the flat and traversal paths", async () => {
    graphMock.recallMemory.mockRejectedValue(OUTAGE);
    graphMock.relatedToTask.mockRejectedValue(OUTAGE);
    const app = await buildTieredApp();

    const flat = await app.inject({
      method: "GET",
      url: "/api/memory/recall?chatId=chat-a",
      headers: auth(JOB_TOKEN),
    });
    expect(flat.statusCode).toBe(200);
    expect(flat.json()).toMatchObject({
      notes: [],
      degraded: { subsystem: "memory-graph" },
    });

    const traversal = await app.inject({
      method: "GET",
      url: "/api/memory/recall?chatId=chat-a&relatedToTask=task-memory-traversal",
      headers: auth(JOB_TOKEN),
    });
    expect(traversal.statusCode).toBe(200);
    expect(traversal.json()).toMatchObject({
      notes: [],
      degraded: { subsystem: "memory-graph" },
    });
    await app.close();
  });

  it("/search degrades too — the fourth call of the same shape", async () => {
    graphMock.searchMemory.mockRejectedValue(OUTAGE);
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/search?q=ranking&chatId=chat-a",
      headers: auth(JOB_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      notes: [],
      degraded: { subsystem: "memory-graph" },
    });
    await app.close();
  });

  it("says nothing about degradation when the graph answers normally", async () => {
    graphMock.memoryExplain.mockResolvedValue({
      noteId: "mem-1",
      path: { nodes: [], edges: [], goal: "missing" },
      contradictions: [],
      provenance: {
        root: "note:mem-1",
        hops: 6,
        relations: [],
        truncated: false,
        textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
      },
    });
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/explain/mem-1?chatId=chat-a",
      headers: auth(JOB_TOKEN),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().degraded).toBeUndefined();
    await app.close();
  });
});

describe("A WITHHELD NOTE LEAKS NO FIELD, not just no `text`", () => {
  /**
   * THE INVARIANT THAT HAS BEEN DEFEATED TWICE.
   *
   * The confirmed-only gate is a rule about a NOTE, but it is enforced by
   * deleting named FIELDS — `text` and `textTruncated`. Both previous breaches
   * were the same shape: a content-bearing field nobody added to that delete
   * list (a self-confirm path, and `proposalText`), so the prose travelled on
   * a sibling key while the gate reported success.
   *
   * Reading the code today, a note node carries prose in `text` alone — `name`
   * is set only for SYMBOL nodes and is a coordinate. But that is a
   * CONVENTION, and a convention is what failed twice. This asserts the shape
   * instead: a withheld node may carry only keys from a coordinate-and-
   * metadata allowlist, so ADDING a prose field to a note node fails the build
   * rather than shipping.
   */
  const COORDINATE_ONLY = new Set([
    "id",
    "entityId",
    "type",
    "kind",
    "trust",
    "confirmed",
    "status",
    "vendor",
    "module",
    "name",
  ]);

  const withheldNote = {
    id: "note:mem-secret",
    entityId: "mem-secret",
    type: "note",
    kind: "decision",
    trust: "medium",
    confirmed: false,
    status: "active",
    text: "THE-PROSE-THAT-MUST-NOT-TRAVEL",
    textTruncated: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.getAutoConfirmAgentMemory.mockResolvedValue(true);
    // The note is LIVE and UNEXPIRED — so the only reason it is withheld is
    // the gate itself, which is what this is measuring.
    ledgerMock.applyMemoryExpiry.mockResolvedValue([
      { id: "mem-secret", expired: false, live: true, confirmedBy: "agent" },
    ]);
    // …and it belongs to ANOTHER chat, so the crew leg cannot admit it either.
    dbMock.memoryNote = {
      findMany: vi.fn().mockResolvedValue([{ id: "mem-secret", chatId: "chat-other" }]),
    } as never;
    dbMock.delegationGrant.findFirst.mockResolvedValue({
      jobId: "job-memory-traversal",
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    dbMock.dispatchJob.findUnique.mockResolvedValue({
      id: "job-memory-traversal",
      taskId: "task-memory-traversal",
      chatId: "chat-a",
      parentJobId: null,
      rootJobId: null,
      capabilityMode: "worker",
      workspacePath: null,
      status: "running",
      interruptRequested: false,
    });
    graphMock.memoryNeighbors.mockResolvedValue({
      nodes: [withheldNote],
      edges: [],
      provenance: {
        root: "note:mem-secret",
        hops: 1,
        relations: [],
        truncated: false,
        textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
      },
    });
  });

  it("returns only coordinate and metadata keys for a note the agent may not read", async () => {
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/neighbors/mem-secret?chatId=chat-a",
      headers: auth(JOB_TOKEN),
    });
    expect(response.statusCode).toBe(200);
    const [node] = response.json().nodes as Record<string, unknown>[];
    expect(node, "the node itself is still returned — only its prose is not").toBeDefined();

    const leaked = Object.keys(node!).filter((key) => !COORDINATE_ONLY.has(key));
    expect(
      leaked,
      `a withheld note returned non-coordinate field(s): ${leaked.join(", ")}. ` +
        "If this is a NEW field, it must either be redacted with `text` or be " +
        "proven coordinate-only and added to the allowlist — deliberately, not " +
        "by making this test pass."
    ).toEqual([]);
    await app.close();
  });

  it("and the prose appears nowhere in the serialized response", async () => {
    // Belt and braces: the allowlist above catches a new KEY; this catches the
    // same prose arriving under a key that is already allowed.
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/neighbors/mem-secret?chatId=chat-a",
      headers: auth(JOB_TOKEN),
    });
    expect(response.body).not.toContain("THE-PROSE-THAT-MUST-NOT-TRAVEL");
    await app.close();
  });
});
