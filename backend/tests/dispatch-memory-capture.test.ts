import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";

// ── B2: memory capture AFTER the terminal write, on the runner's own lease ───
//
// Mining a finished job costs a whole extra one-shot vendor run (up to 120s). It
// used to be awaited INSIDE executeJob, before the terminal write — so the fleet
// seat stayed claimed and Mission Chat kept spinning for two minutes after the
// assistant's last token. Moving it after the terminal write means the per-job
// capability is (correctly) already dead, so the runner comes in this door.
//
// What these lock down is that the door is NARROW: the lease is checked, the
// window is bounded, and every authority-bearing field is derived from the
// STORED job row rather than taken from the body.

const prismaMock = vi.hoisted(() => ({
  dispatchJob: {
    findUnique: vi.fn(),
  },
  runner: {
    findFirst: vi.fn(),
  },
  delegationGrant: {
    findFirst: vi.fn(),
  },
}));

const ledgerMock = vi.hoisted(() => ({
  ingestMemoryNote: vi.fn(),
  migrateMemoryLifecyclePolicy: vi.fn(),
  MemoryLifecyclePreviewMismatchError: class extends Error {},
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  getEmbedder: () => undefined,
  mirrorToGraph: () => undefined,
}));
vi.mock("../src/lib/memory-ledger.js", () => ledgerMock);

const LEASE_TOKEN = `lease-${"a".repeat(58)}`;
const OTHER_LEASE_TOKEN = `lease-${"b".repeat(58)}`;
const hashLease = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const LEASE_HASH = hashLease(LEASE_TOKEN);

const TERMINAL_JOB = {
  id: "job-mine",
  vendor: "claude-code",
  taskId: "task-1",
  chatId: "chat-1",
  status: "done",
  host: "desktop-mac",
  runnerLeaseHash: LEASE_HASH,
  endedAt: new Date(Date.now() - 30_000),
};

const NOTE = {
  kind: "decision" as const,
  text: "Rank fused memory with RRF instead of additive scoring",
  laneId: "lane-cc",
  modules: ["packages/graph"],
  topics: ["memory"],
  symbols: ["packages/graph#rank"],
  outcome: undefined,
};

// ADR-0026: real directories, because `repoRootOf` resolves symlinks and case
// against the filesystem — a synthetic string would silently assert the wrong key
// on a machine where /tmp is a symlink (it is, on macOS).
const WORKSPACE_ROOT = realpathSync(
  mkdtempSync(path.join(tmpdir(), "muon-mine-ws-"))
);
const MINED_REPO = path.join(WORKSPACE_ROOT, "repo");
const MINED_WORKTREE = path.join(MINED_REPO, ".muon", "worktrees", "task-1");
mkdirSync(MINED_WORKTREE, { recursive: true });

afterAll(() => {
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

function capture(payload: Record<string, unknown>) {
  return {
    method: "POST" as const,
    url: "/api/dispatch/job-mine/memory-capture",
    payload,
  };
}

describe("POST /api/dispatch/:jobId/memory-capture (B2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.runner.findFirst.mockImplementation(
      async (args: { where: { leaseHash?: string } }) =>
        args.where.leaseHash === LEASE_HASH
          ? { id: "runner-1", host: "desktop-mac", leaseHash: LEASE_HASH }
          : null
    );
    prismaMock.dispatchJob.findUnique.mockResolvedValue(TERMINAL_JOB);
    ledgerMock.ingestMemoryNote.mockResolvedValue({
      note: { id: "note-1" },
      action: "inserted",
    });
  });

  it("lets the exact lease-holder file a note for a job that has ALREADY gone terminal", async () => {
    const app = buildApp();
    const response = await app.inject(
      capture({ host: "desktop-mac", leaseToken: LEASE_TOKEN, note: NOTE })
    );

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      action: "inserted",
      relatedNoteId: null,
    });
    await app.close();
  });

  it("derives author, task and chat partition from the STORED job, and always proposes", async () => {
    const app = buildApp();
    await app.inject(
      capture({ host: "desktop-mac", leaseToken: LEASE_TOKEN, note: NOTE })
    );

    expect(ledgerMock.ingestMemoryNote).toHaveBeenCalledWith({
      kind: "decision",
      text: NOTE.text,
      laneId: "lane-cc",
      modules: ["packages/graph"],
      topics: ["memory"],
      symbols: ["packages/graph#rank"],
      outcome: undefined,
      // Identical to what the agent-tier POST /api/memory derives today, so a
      // note written through this door is indistinguishable from one written a
      // millisecond before the terminal.
      createdBy: "agent:job:job-mine",
      taskId: "task-1",
      chatId: "chat-1",
      proposalOnly: true,
    });
    await app.close();
  });

  it("stores a structured attempt outcome as coordinate data", async () => {
    const app = buildApp();
    await app.inject(
      capture({
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
        note: { ...NOTE, kind: "attempt", outcome: "worked" },
      })
    );

    expect(ledgerMock.ingestMemoryNote).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "attempt", outcome: "worked" })
    );
    await app.close();
  });

  it("ADR-0026: derives the WORKSPACE from the stored job, reduced to the parent repo", async () => {
    // Mined memory is the volume path into the brain. A job executing in a
    // governed worktree must still write to its PARENT repo's partition, or every
    // dispatch would mint its own memory island.
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      ...TERMINAL_JOB,
      workspacePath: MINED_WORKTREE,
    });
    const app = buildApp();
    await app.inject(
      capture({ host: "desktop-mac", leaseToken: LEASE_TOKEN, note: NOTE })
    );

    expect(ledgerMock.ingestMemoryNote).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: MINED_REPO })
    );
    await app.close();
  });

  it("ADR-0026: a job with no bound workspace mines into the residue, never a guess", async () => {
    const app = buildApp();
    await app.inject(
      capture({ host: "desktop-mac", leaseToken: LEASE_TOKEN, note: NOTE })
    );

    const input = ledgerMock.ingestMemoryNote.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect("workspacePath" in input).toBe(false);
    await app.close();
  });

  it("partitions a NON-chat job by task, never into an operator-wide view", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      ...TERMINAL_JOB,
      chatId: null,
    });
    const app = buildApp();
    await app.inject(
      capture({ host: "desktop-mac", leaseToken: LEASE_TOKEN, note: NOTE })
    );

    expect(ledgerMock.ingestMemoryNote).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "task:task-1" })
    );
    await app.close();
  });

  it("cannot be used to declare trust, scope, author or partition from the body", async () => {
    const app = buildApp();
    const response = await app.inject(
      capture({
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
        note: {
          ...NOTE,
          // Every one of these is an authority claim, and none of them is a
          // field this surface accepts.
          trust: "high",
          scope: "global",
          createdBy: "human:founder",
          taskId: "task-somebody-elses",
          chatId: "chat-somebody-elses",
          proposalOnly: false,
        },
      })
    );

    expect(response.statusCode).toBe(201);
    const ingested = ledgerMock.ingestMemoryNote.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(ingested).not.toHaveProperty("trust");
    expect(ingested).not.toHaveProperty("scope");
    expect(ingested.createdBy).toBe("agent:job:job-mine");
    expect(ingested.taskId).toBe("task-1");
    expect(ingested.chatId).toBe("chat-1");
    expect(ingested.proposalOnly).toBe(true);
    await app.close();
  });

  it("refuses a runner that does not hold the active launch lease", async () => {
    const app = buildApp();
    const response = await app.inject(
      capture({
        host: "desktop-mac",
        leaseToken: OTHER_LEASE_TOKEN,
        note: NOTE,
      })
    );

    expect(response.statusCode).toBe(409);
    expect(ledgerMock.ingestMemoryNote).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a live lease that does not own THIS job", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      ...TERMINAL_JOB,
      runnerLeaseHash: hashLease(OTHER_LEASE_TOKEN),
    });
    const app = buildApp();
    const response = await app.inject(
      capture({ host: "desktop-mac", leaseToken: LEASE_TOKEN, note: NOTE })
    );

    expect(response.statusCode).toBe(409);
    expect(ledgerMock.ingestMemoryNote).not.toHaveBeenCalled();
    await app.close();
  });

  it("closes the window: a long-dead job can no longer be written against", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      ...TERMINAL_JOB,
      endedAt: new Date(Date.now() - 60 * 60_000),
    });
    const app = buildApp();
    const response = await app.inject(
      capture({ host: "desktop-mac", leaseToken: LEASE_TOKEN, note: NOTE })
    );

    expect(response.statusCode).toBe(409);
    expect(ledgerMock.ingestMemoryNote).not.toHaveBeenCalled();
    await app.close();
  });
});
