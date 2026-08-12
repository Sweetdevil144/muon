import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OPERATOR = "operator-token-memory-lifecycle";
const AGENT = "agent-token-memory-lifecycle";
const JOB_TOKEN = `job-memory-lifecycle-${"a".repeat(43)}`;

const dbMock = vi.hoisted(() => ({
  delegationGrant: {
    findFirst: vi.fn(),
  },
  dispatchJob: {
    findUnique: vi.fn(),
  },
}));

const ledgerMock = vi.hoisted(() => ({
  cloneMemoryNote: vi.fn(),
  compactMemory: vi.fn(),
  deleteMemoryNote: vi.fn(),
  getMemoryNote: vi.fn(),
  ingestMemoryNote: vi.fn(),
  listMemoryLibrary: vi.fn(),
  migrateMemoryLifecyclePolicy: vi.fn(),
  MemoryLifecyclePreviewMismatchError: class extends Error {},
  promoteMemoryNoteToGlobal: vi.fn(),
  recordMemoryUsed: vi.fn(),
  updateMemoryNote: vi.fn(),
}));
const settingsMock = vi.hoisted(() => ({
  getAutoConfirmAgentMemory: vi.fn(),
  getMemoryLifecyclePolicy: vi.fn(),
  getMemoryCompactionRetentionDays: vi.fn(),
  setAutoConfirmAgentMemory: vi.fn(),
  setMemoryCompactionRetentionDays: vi.fn(),
}));

vi.mock("../src/lib/memory-ledger.js", () => ledgerMock);
vi.mock("../src/lib/operator-settings.js", () => settingsMock);
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({
    memoryNeighbors: vi.fn(),
    memoryExplain: vi.fn(),
    memoryAnalytics: vi.fn().mockResolvedValue({
      noteScores: [],
      hotModules: [],
      communities: [],
      source: { notes: 0, modules: 0, edges: 0, truncated: false },
    }),
  }),
  getEmbedder: () => undefined,
  mirrorToGraph: () => undefined,
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

describe("memory lifecycle routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.getAutoConfirmAgentMemory.mockResolvedValue(true);
    settingsMock.getMemoryLifecyclePolicy.mockResolvedValue({
      source: "legacy_global",
      legacyFallbackDays: 30,
      policy: {
        version: 1,
        trustCeiling: "medium",
        daysByKind: {
          decision: 30,
          constraint: 30,
          convention: 30,
          attempt: 30,
          question: 30,
        },
        permanentWhenConfirmedByKind: {
          decision: true,
          constraint: true,
          convention: true,
          attempt: true,
          question: true,
        },
      },
    });
    settingsMock.getMemoryCompactionRetentionDays.mockResolvedValue(30);
    settingsMock.setMemoryCompactionRetentionDays.mockImplementation(
      async (days: number) => days
    );
    ledgerMock.compactMemory.mockResolvedValue({
      retentionDays: 30,
      cutoff: "2026-06-21T00:00:00.000Z",
      scanned: 2,
      tombstoned: 1,
      noteIds: ["mem-old"],
    });
    dbMock.delegationGrant.findFirst.mockResolvedValue({
      jobId: "job-memory-lifecycle",
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    dbMock.dispatchJob.findUnique.mockResolvedValue({
      id: "job-memory-lifecycle",
      taskId: "task-memory-lifecycle",
      chatId: "chat-a",
      parentJobId: null,
      rootJobId: null,
      capabilityMode: "worker",
      workspacePath: null,
      status: "running",
      interruptRequested: false,
    });
  });

  it("fails closed without agent scope and preserves ledger ownership checks", async () => {
    const app = await buildTieredApp();
    const unscoped = await app.inject({
      method: "DELETE",
      url: "/api/memory/mem-1",
      headers: auth(AGENT),
    });
    expect(unscoped.statusCode).toBe(403);
    expect(ledgerMock.deleteMemoryNote).not.toHaveBeenCalled();

    ledgerMock.deleteMemoryNote.mockResolvedValueOnce({
      status: "forbidden",
      noteId: "mem-1",
      reason:
        "Agents may delete only their own unconfirmed note in the current chat.",
    });
    const denied = await app.inject({
      method: "DELETE",
      url: "/api/memory/mem-1?chatId=chat-a&createdBy=forged",
      headers: auth(JOB_TOKEN),
    });
    expect(denied.statusCode).toBe(403);
    expect(ledgerMock.deleteMemoryNote).toHaveBeenCalledWith("mem-1", {
      tier: "agent",
      principal: "agent:job:job-memory-lifecycle",
      chatId: "chat-a",
    });

    ledgerMock.deleteMemoryNote.mockResolvedValueOnce({
      status: "deleted",
      noteId: "mem-1",
    });
    const allowed = await app.inject({
      method: "DELETE",
      url: "/api/memory/mem-1?chatId=chat-a&createdBy=forged",
      headers: auth(JOB_TOKEN),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({
      noteId: "mem-1",
      deleted: true,
      alreadyDeleted: false,
    });
    await app.close();
  });

  it("clones through the server-owned crew gate and returns coordinates only", async () => {
    ledgerMock.cloneMemoryNote.mockResolvedValue({
      status: "cloned",
      sourceNoteId: "mem-source",
      note: {
        id: "mem-clone",
        text: "must never cross the lifecycle route",
      },
    });
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/memory/mem-source/clone",
      headers: auth(JOB_TOKEN),
      payload: { chatId: "chat-a", createdBy: "forged" },
    });
    expect(response.statusCode).toBe(200);
    expect(settingsMock.getAutoConfirmAgentMemory).toHaveBeenCalledTimes(1);
    expect(ledgerMock.cloneMemoryNote).toHaveBeenCalledWith("mem-source", {
      tier: "agent",
      principal: "agent:job:job-memory-lifecycle",
      chatId: "chat-a",
      crewVisible: true,
    });
    expect(response.json()).toEqual({
      noteId: "mem-clone",
      clonedFromNoteId: "mem-source",
      confirmed: false,
    });
    expect(response.body).not.toContain("must never");
    await app.close();
  });

  it("keeps compaction and retention configuration operator-only", async () => {
    const app = await buildTieredApp();
    const denied = await app.inject({
      method: "POST",
      url: "/api/memory/compact",
      headers: auth(AGENT),
    });
    expect(denied.statusCode).toBe(403);
    expect(ledgerMock.compactMemory).not.toHaveBeenCalled();

    const compacted = await app.inject({
      method: "POST",
      url: "/api/memory/compact",
      headers: auth(OPERATOR),
    });
    expect(compacted.statusCode).toBe(200);
    expect(ledgerMock.compactMemory).toHaveBeenCalledWith(
      30,
      expect.any(Date),
      {}
    );

    const configured = await app.inject({
      method: "PUT",
      url: "/api/memory/settings/memory-compaction-retention",
      headers: auth(OPERATOR),
      payload: { retentionDays: 45 },
    });
    expect(configured.statusCode).toBe(200);
    expect(settingsMock.setMemoryCompactionRetentionDays).toHaveBeenCalledWith(
      45
    );
    await app.close();
  });

  it("keeps the kind table operator-only and binds apply to its preview digest", async () => {
    const policy = {
      version: 1,
      trustCeiling: "medium",
      daysByKind: {
        decision: 90,
        constraint: 90,
        convention: 90,
        attempt: 30,
        question: 7,
      },
      permanentWhenConfirmedByKind: {
        decision: true,
        constraint: true,
        convention: true,
        attempt: true,
        question: true,
      },
    } as const;
    ledgerMock.migrateMemoryLifecyclePolicy.mockResolvedValue({
      policy,
      previousSource: "legacy_global",
      dryRun: true,
      applied: false,
      previewDigest: "a".repeat(64),
      scanned: 3,
      changed: 2,
      wouldHideNow: 1,
      wouldRestoreNow: 0,
      wouldBecomePermanent: 0,
    });
    const app = await buildTieredApp();

    const denied = await app.inject({
      method: "POST",
      url: "/api/memory/settings/memory-lifecycle/migrate",
      headers: auth(AGENT),
      payload: { policy, dryRun: true },
    });
    expect(denied.statusCode).toBe(403);
    expect(ledgerMock.migrateMemoryLifecyclePolicy).not.toHaveBeenCalled();

    const preview = await app.inject({
      method: "POST",
      url: "/api/memory/settings/memory-lifecycle/migrate",
      headers: auth(OPERATOR),
      payload: { policy, dryRun: true },
    });
    expect(preview.statusCode).toBe(200);
    expect(ledgerMock.migrateMemoryLifecyclePolicy).toHaveBeenCalledWith(
      policy,
      { dryRun: true }
    );

    ledgerMock.migrateMemoryLifecyclePolicy.mockClear();
    const missingDigest = await app.inject({
      method: "POST",
      url: "/api/memory/settings/memory-lifecycle/migrate",
      headers: auth(OPERATOR),
      payload: { policy, dryRun: false },
    });
    expect(missingDigest.statusCode).toBe(400);
    expect(ledgerMock.migrateMemoryLifecyclePolicy).not.toHaveBeenCalled();

    ledgerMock.migrateMemoryLifecyclePolicy.mockRejectedValueOnce(
      new ledgerMock.MemoryLifecyclePreviewMismatchError()
    );
    const stale = await app.inject({
      method: "POST",
      url: "/api/memory/settings/memory-lifecycle/migrate",
      headers: auth(OPERATOR),
      payload: {
        policy,
        dryRun: false,
        previewDigest: "a".repeat(64),
      },
    });
    expect(stale.statusCode).toBe(409);

    await app.close();
  });
});
