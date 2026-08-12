import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { MEMORY_TRAVERSAL_TEXT_POLICY } from "@muon/client";
import { registerMemoryCommands } from "../src/commands/memory.js";
import type { MuonApiClient } from "../src/lib/api-client.js";

function run(argv: string[], client: Partial<MuonApiClient>) {
  const program = new Command();
  program.exitOverride();
  registerMemoryCommands(program, () => client as MuonApiClient);
  return program.parseAsync(["node", "muon", ...argv]);
}

const noteStub = {
  id: "mem-1",
  text: "t",
  kind: "decision",
  trust: "medium",
  confirmed: false,
  stale: false,
  status: "active",
  createdBy: "human",
  taskId: null,
  modules: [],
  topics: [],
  symbols: [],
};

describe("muon memory reject (KG-6 governed rejection)", () => {
  it("sends confirmed:false + status:rejected + a human principal so the backend govern branch fires", async () => {
    const updateMemoryNote = vi.fn().mockResolvedValue(noteStub);
    await run(["memory", "reject", "--note-id", "mem-1"], {
      updateMemoryNote,
    } as unknown as Partial<MuonApiClient>);
    // confirmed:false forces requireOperator + a ledger `reject` Confirmation;
    // status:"rejected" retires the note (hidden from recall); principal defaults
    // to the human operator so the rejection is attributed, never anonymous.
    expect(updateMemoryNote).toHaveBeenCalledWith({
      noteId: "mem-1",
      confirmed: false,
      status: "rejected",
      principal: "human",
    });
  });

  it("attributes the rejection to an explicit --principal", async () => {
    const updateMemoryNote = vi.fn().mockResolvedValue(noteStub);
    await run(
      ["memory", "reject", "--note-id", "mem-1", "--principal", "human:carol"],
      { updateMemoryNote } as unknown as Partial<MuonApiClient>
    );
    expect(updateMemoryNote).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: false, principal: "human:carol" })
    );
  });
});

describe("muon memory pause/resume (non-verdict lifecycle)", () => {
  it("changes only status and never forges a confirmation decision", async () => {
    const updateMemoryNote = vi.fn().mockResolvedValue(noteStub);
    await run(["memory", "pause", "--note-id", "mem-1"], {
      updateMemoryNote,
    } as unknown as Partial<MuonApiClient>);
    expect(updateMemoryNote).toHaveBeenLastCalledWith({
      noteId: "mem-1",
      status: "paused",
    });

    await run(["memory", "resume", "--note-id", "mem-1"], {
      updateMemoryNote,
    } as unknown as Partial<MuonApiClient>);
    expect(updateMemoryNote).toHaveBeenLastCalledWith({
      noteId: "mem-1",
      status: "active",
    });
  });

  it("passes the paused library filter through", async () => {
    const listMemoryLibrary = vi.fn().mockResolvedValue({
      notes: [],
      edges: [],
      confirmations: [],
      imports: [],
      total: 0,
      truncated: false,
    });
    await run(["memory", "library", "--status", "paused"], {
      listMemoryLibrary,
    } as unknown as Partial<MuonApiClient>);
    expect(listMemoryLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" })
    );
  });
});

describe("muon memory pin/unpin (operator retention protection)", () => {
  it("sends an explicit human pin verdict in both directions", async () => {
    const updateMemoryNote = vi.fn().mockResolvedValue(noteStub);
    await run(["memory", "pin", "--note-id", "mem-1"], {
      updateMemoryNote,
    } as unknown as Partial<MuonApiClient>);
    expect(updateMemoryNote).toHaveBeenLastCalledWith({
      noteId: "mem-1",
      pinned: true,
      principal: "human",
    });

    await run(["memory", "unpin", "--note-id", "mem-1"], {
      updateMemoryNote,
    } as unknown as Partial<MuonApiClient>);
    expect(updateMemoryNote).toHaveBeenLastCalledWith({
      noteId: "mem-1",
      pinned: false,
      principal: "human",
    });
  });
});

describe("muon memory library (operator browse)", () => {
  it("passes filters through to the governed library snapshot", async () => {
    const listMemoryLibrary = vi
      .fn()
      .mockResolvedValue({ notes: [], edges: [], confirmations: [], imports: [], total: 0, truncated: false });
    await run(
      [
        "memory",
        "library",
        "--status",
        "active",
        "--confirmed",
        "confirmed",
        "--kind",
        "decision",
        "--trust",
        "high",
        "--limit",
        "50",
      ],
      { listMemoryLibrary } as unknown as Partial<MuonApiClient>
    );
    expect(listMemoryLibrary).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        confirmed: "confirmed",
        kind: "decision",
        trust: "high",
        limit: 50,
      })
    );
  });

  it("rejects an out-of-range --limit before calling the backend", async () => {
    const listMemoryLibrary = vi.fn();
    await run(["memory", "library", "--limit", "500"], {
      listMemoryLibrary,
    } as unknown as Partial<MuonApiClient>);
    expect(listMemoryLibrary).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe("muon memory R3 TTL + R5 filter (cross-surface parity)", () => {
  it("threads --show-expired and a validated --filter into search and recall", async () => {
    const searchMemory = vi.fn().mockResolvedValue([]);
    await run(
      [
        "memory",
        "search",
        "retry",
        "--show-expired",
        "--filter",
        '{"field":"kind","op":"eq","value":"decision"}',
      ],
      { searchMemory } as unknown as Partial<MuonApiClient>
    );
    expect(searchMemory).toHaveBeenCalledWith("retry", {
      // ADR-0026: the workspace default rides EVERY read, so it is part of the exact
      // shape rather than allowed to hide behind an `objectContaining`. A test that
      // stopped asserting it would stop noticing if the default were dropped.
      workspace: process.cwd(),
      showExpired: true,
      filter: { field: "kind", op: "eq", value: "decision" },
    });

    const recallMemory = vi.fn().mockResolvedValue([]);
    await run(
      [
        "memory",
        "recall",
        "--module",
        "src/a.ts",
        "--filter",
        '{"not":{"field":"trust","op":"eq","value":"low"}}',
      ],
      { recallMemory } as unknown as Partial<MuonApiClient>
    );
    expect(recallMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: process.cwd(),
        module: "src/a.ts",
        filter: { not: { field: "trust", op: "eq", value: "low" } },
      })
    );
  });

  it("refuses an out-of-grammar --filter before calling the backend", async () => {
    for (const filter of [
      '{"field":"textHash","op":"eq","value":"x"}',
      '{"field":"kind","op":"regex","value":".*"}',
      "not-json",
    ]) {
      const searchMemory = vi.fn();
      await run(["memory", "search", "x", "--filter", filter], {
        searchMemory,
      } as unknown as Partial<MuonApiClient>);
      // The SAME @muon/protocol validator the backend uses, so the CLI cannot
      // send a filter the server would reject (or accept one it would not).
      expect(searchMemory).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    }
  });

  it("passes the library's expiry + filter knobs through", async () => {
    const listMemoryLibrary = vi.fn().mockResolvedValue({
      notes: [],
      edges: [],
      confirmations: [],
      imports: [],
      total: 0,
      truncated: false,
    });
    await run(
      [
        "memory",
        "library",
        "--show-expired",
        "--filter",
        '{"field":"confirmed","op":"eq","value":false}',
      ],
      { listMemoryLibrary } as unknown as Partial<MuonApiClient>
    );
    expect(listMemoryLibrary).toHaveBeenCalledWith(
      expect.objectContaining({
        showExpired: true,
        filter: { field: "confirmed", op: "eq", value: false },
      })
    );
  });

  it("reads and writes the bounded TTL policy", async () => {
    const getMemoryTtlPolicy = vi
      .fn()
      .mockResolvedValue({ days: 30, trustCeiling: "medium" });
    const setMemoryTtlPolicy = vi
      .fn()
      .mockResolvedValue({ days: 14, trustCeiling: "low" });
    await run(["memory", "ttl"], {
      getMemoryTtlPolicy,
      setMemoryTtlPolicy,
    } as unknown as Partial<MuonApiClient>);
    expect(setMemoryTtlPolicy).not.toHaveBeenCalled();

    await run(
      ["memory", "ttl", "--days", "14", "--trust-ceiling", "low"],
      { getMemoryTtlPolicy, setMemoryTtlPolicy } as unknown as Partial<MuonApiClient>
    );
    expect(setMemoryTtlPolicy).toHaveBeenCalledWith({
      days: 14,
      trustCeiling: "low",
    });

    // "high" is not a legal ceiling — a high-trust note never auto-expires.
    setMemoryTtlPolicy.mockClear();
    await run(["memory", "ttl", "--trust-ceiling", "high"], {
      getMemoryTtlPolicy,
      setMemoryTtlPolicy,
    } as unknown as Partial<MuonApiClient>);
    expect(setMemoryTtlPolicy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("enforces preview-before-apply for the kind lifecycle table", async () => {
    const current = {
      version: 1 as const,
      trustCeiling: "medium" as const,
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
    };
    const recommended = {
      ...current,
      daysByKind: {
        decision: 90,
        constraint: 90,
        convention: 90,
        attempt: 30,
        question: 7,
      },
    };
    const getMemoryLifecyclePolicy = vi.fn().mockResolvedValue({
      source: "legacy_global",
      legacyFallbackDays: 30,
      policy: current,
      recommended,
    });
    const migrateMemoryLifecyclePolicy = vi.fn().mockResolvedValue({
      policy: { ...recommended, daysByKind: { ...recommended.daysByKind, question: 5 } },
      previousSource: "legacy_global",
      dryRun: true,
      applied: false,
      previewDigest: "a".repeat(64),
      scanned: 4,
      changed: 3,
      wouldHideNow: 1,
      wouldRestoreNow: 0,
      wouldBecomePermanent: 1,
    });
    const client = {
      getMemoryLifecyclePolicy,
      migrateMemoryLifecyclePolicy,
    } as unknown as Partial<MuonApiClient>;

    await run(
      ["memory", "lifecycle-policy", "--dry-run", "--question-days", "5"],
      client
    );
    expect(migrateMemoryLifecyclePolicy).toHaveBeenCalledWith(
      { ...recommended, daysByKind: { ...recommended.daysByKind, question: 5 } },
      { dryRun: true }
    );

    migrateMemoryLifecyclePolicy.mockClear();
    await run(
      [
        "memory",
        "lifecycle-policy",
        "--apply",
        "a".repeat(64),
        "--question-days",
        "5",
      ],
      client
    );
    expect(migrateMemoryLifecyclePolicy).toHaveBeenCalledWith(
      { ...recommended, daysByKind: { ...recommended.daysByKind, question: 5 } },
      { dryRun: false, previewDigest: "a".repeat(64) }
    );

    migrateMemoryLifecyclePolicy.mockClear();
    await run(
      ["memory", "lifecycle-policy", "--question-days", "5"],
      client
    );
    expect(migrateMemoryLifecyclePolicy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("runs the bounded expiry sweep", async () => {
    const sweepExpiredMemory = vi.fn().mockResolvedValue({
      ttlDays: 30,
      scanned: 4,
      expired: 3,
      noteIds: ["mem-1", "mem-2", "mem-3"],
      skipped: false,
      dryRun: false,
      batchId: "batch-1",
      reason: null,
    });
    await run(
      [
        "memory",
        "sweep-expired",
        "--dry-run",
        "--max-forget",
        "2",
        "--batch-id",
        "batch-1",
        "--reason",
        "ttl cleanup",
      ],
      {
        sweepExpiredMemory,
      } as unknown as Partial<MuonApiClient>
    );
    expect(sweepExpiredMemory).toHaveBeenCalledWith({
      dryRun: true,
      maxForget: 2,
      batchId: "batch-1",
      reason: "ttl cleanup",
    });
  });
});

describe("muon memory analytics and global promotion", () => {
  it("threads the bounded analytics query through the client", async () => {
    const memoryAnalytics = vi.fn().mockResolvedValue({
      noteScores: [],
      hotModules: [],
      communities: [],
      source: { notes: 0, modules: 0, edges: 0, truncated: false },
    });
    await run(
      ["memory", "analytics", "--chat-id", "chat-a", "--limit", "75"],
      { memoryAnalytics } as unknown as Partial<MuonApiClient>
    );
    expect(memoryAnalytics).toHaveBeenCalledWith({
      // ADR-0026: analytics is a read too — hot-module paths are workspace-relative.
      workspace: process.cwd(),
      chatId: "chat-a",
      limit: 75,
    });
  });

  it("threads workspace-fenced access cohorts and keeps the causal caveat", async () => {
    const memoryAccessAnalytics = vi.fn().mockResolvedValue({
      rowsScanned: 2,
      distinctNotes: 2,
      retainedPerNote: 128,
      truncated: false,
      firstAccessAt: "2026-07-01T10:00:00.000Z",
      lastAccessAt: "2026-07-01T10:01:00.000Z",
      byType: [
        {
          accessType: "preedit_gate",
          accessedUnconfirmedNotes: 2,
          laterHumanConfirmedNotes: 1,
          confirmationRate: 0.5,
        },
      ],
      interpretation: "association_not_causation",
    });
    await run(["memory", "access-analytics", "--limit", "75"], {
      memoryAccessAnalytics,
    } as unknown as Partial<MuonApiClient>);
    expect(memoryAccessAnalytics).toHaveBeenCalledWith({
      workspace: process.cwd(),
      limit: 75,
    });
  });

  it("uses the operator-only promotion client method", async () => {
    const promoteMemoryToGlobal = vi.fn().mockResolvedValue({
      noteId: "mem-1",
      scope: "global",
      promoted: true,
      alreadyGlobal: false,
    });
    await run(["memory", "promote-global", "--note-id", "mem-1"], {
      promoteMemoryToGlobal,
    } as unknown as Partial<MuonApiClient>);
    expect(promoteMemoryToGlobal).toHaveBeenCalledWith("mem-1");
  });
});

describe("muon memory add --symbol (ADR-0012 on-symbol anchoring)", () => {
  it("threads symbol anchors through to the write so the pre-edit gate can lift on-symbol notes", async () => {
    const addMemoryNote = vi.fn().mockResolvedValue(noteStub);
    await run(
      [
        "memory",
        "add",
        "--kind",
        "decision",
        "--text",
        "Authorization stays at the boundary",
        "--module",
        "src/auth/guard.ts",
        "--symbol",
        "src/auth/guard.ts#authorize",
      ],
      { addMemoryNote } as unknown as Partial<MuonApiClient>
    );
    expect(addMemoryNote).toHaveBeenCalledWith(
      expect.objectContaining({
        modules: ["src/auth/guard.ts"],
        symbols: ["src/auth/guard.ts#authorize"],
      })
    );
  });

  it("defaults symbols to [] when --symbol is omitted (backward compatible)", async () => {
    const addMemoryNote = vi.fn().mockResolvedValue(noteStub);
    await run(
      ["memory", "add", "--kind", "decision", "--text", "no symbol anchor here"],
      { addMemoryNote } as unknown as Partial<MuonApiClient>
    );
    expect(addMemoryNote).toHaveBeenCalledWith(
      expect.objectContaining({ symbols: [] })
    );
  });
});

describe("muon memory traversal", () => {
  it("threads bounded neighbors options through the client", async () => {
    const memoryNeighbors = vi.fn().mockResolvedValue({
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
    await run(
      [
        "memory",
        "neighbors",
        "--node-id",
        "mem-1",
        "--hops",
        "2",
        "--relation",
        "SUPERSEDES",
        "--limit",
        "25",
        "--chat-id",
        "chat-a",
      ],
      { memoryNeighbors } as unknown as Partial<MuonApiClient>
    );
    expect(memoryNeighbors).toHaveBeenCalledWith("mem-1", {
      // ADR-0026: a provenance walk is a read, so it carries the coordinate too.
      workspace: process.cwd(),
      hops: 2,
      relations: ["SUPERSEDES"],
      limit: 25,
      chatId: "chat-a",
    });
  });

  it("threads explanation scope through the client", async () => {
    const memoryExplain = vi.fn().mockResolvedValue({
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
    await run(
      [
        "memory",
        "explain",
        "--note-id",
        "mem-1",
        "--limit",
        "80",
        "--chat-id",
        "chat-a",
      ],
      { memoryExplain } as unknown as Partial<MuonApiClient>
    );
    expect(memoryExplain).toHaveBeenCalledWith("mem-1", {
      workspace: process.cwd(),
      limit: 80,
      chatId: "chat-a",
    });
  });

  it("rejects an out-of-range traversal before calling the client", async () => {
    const memoryNeighbors = vi.fn();
    await run(
      ["memory", "neighbors", "--node-id", "mem-1", "--hops", "4"],
      { memoryNeighbors } as unknown as Partial<MuonApiClient>
    );
    expect(memoryNeighbors).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("runs governed delete and clone commands through coordinate-only client methods", async () => {
    const deleteMemoryNote = vi.fn().mockResolvedValue({
      noteId: "mem-1",
      deleted: true,
      alreadyDeleted: false,
    });
    const cloneMemoryNote = vi.fn().mockResolvedValue({
      noteId: "mem-clone",
      clonedFromNoteId: "mem-1",
      confirmed: false,
    });
    const client = {
      deleteMemoryNote,
      cloneMemoryNote,
    } as unknown as Partial<MuonApiClient>;

    await run(["memory", "delete", "--note-id", "mem-1"], client);
    await run(["memory", "clone", "--note-id", "mem-1"], client);

    expect(deleteMemoryNote).toHaveBeenCalledWith("mem-1");
    expect(cloneMemoryNote).toHaveBeenCalledWith("mem-1");
  });

  it("persists a bounded retention override before compaction", async () => {
    const setMemoryCompactionRetentionDays = vi.fn().mockResolvedValue(45);
    const compactMemory = vi.fn().mockResolvedValue({
      retentionDays: 45,
      cutoff: "2026-06-06T00:00:00.000Z",
      scanned: 3,
      tombstoned: 2,
      noteIds: ["mem-a", "mem-b"],
    });
    await run(
      ["memory", "compact", "--retention-days", "45"],
      {
        setMemoryCompactionRetentionDays,
        compactMemory,
      } as unknown as Partial<MuonApiClient>
    );
    expect(setMemoryCompactionRetentionDays).toHaveBeenCalledWith(45);
    expect(compactMemory).toHaveBeenCalledTimes(1);
  });
});
