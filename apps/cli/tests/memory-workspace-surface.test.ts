import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerMemoryCommands } from "../src/commands/memory.js";
import type { MuonApiClient } from "../src/lib/api-client.js";

// ── ADR-0026 §11 STEP 4 — the CLI surface ────────────────────────────────────
//
// §1 measured `search` (:395), `library` (:455) and `recall` (:604, :942) sending no
// partition coordinate at all, so one invocation read every repo on the machine.
// §5's cost paragraph says the fix must be a DEFAULT rather than an option, because
// the predicate falls back to today's behaviour when a surface says nothing — a
// forgotten coordinate is silent.
//
// So every test here asserts the DEFAULT fires, not merely that the flag works. A
// test that only exercised `--workspace` would pass on the exact code that shipped
// the leak.

function run(argv: string[], client: Partial<MuonApiClient>) {
  const program = new Command();
  program.exitOverride();
  registerMemoryCommands(program, () => client as MuonApiClient);
  return program.parseAsync(["node", "muon", ...argv]);
}

const note = {
  id: "mem-1",
  text: "t",
  kind: "decision",
  trust: "medium",
  confirmed: false,
  stale: false,
  status: "active",
  createdBy: "human",
  taskId: null,
  workspacePath: "/Users/dev/SWE/repo-a",
  modules: [],
  topics: [],
  symbols: [],
};

const emptySnapshot = {
  notes: [],
  edges: [],
  confirmations: [],
  imports: [],
  total: 0,
  truncated: false,
  totalExact: true,
};

describe("ADR-0026 step 4: every CLI read DEFAULTS to the invoking workspace", () => {
  it("search sends the cwd with no flag at all", async () => {
    const searchMemory = vi.fn().mockResolvedValue([]);
    await run(["memory", "search", "idempotency"], {
      searchMemory,
    } as unknown as Partial<MuonApiClient>);
    expect(searchMemory).toHaveBeenCalledWith(
      "idempotency",
      expect.objectContaining({ workspace: process.cwd() })
    );
    // And NOT the residue view: the default must be a real fence, not the §8 escape.
    expect(searchMemory.mock.calls[0]![1]).not.toHaveProperty("unscoped", true);
  });

  it("recall sends the cwd with no flag at all", async () => {
    const recallMemory = vi.fn().mockResolvedValue([]);
    await run(["memory", "recall", "--module", "src/pay/charge.ts"], {
      recallMemory,
    } as unknown as Partial<MuonApiClient>);
    expect(recallMemory).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: process.cwd() })
    );
  });

  it("library sends the cwd with no flag at all", async () => {
    const listMemoryLibrary = vi.fn().mockResolvedValue(emptySnapshot);
    await run(["memory", "library"], {
      listMemoryLibrary,
    } as unknown as Partial<MuonApiClient>);
    expect(listMemoryLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: process.cwd() })
    );
  });

  it("review sends the cwd too — the queue is per-repo", async () => {
    const recallMemory = vi.fn().mockResolvedValue([]);
    await run(["memory", "review"], {
      recallMemory,
    } as unknown as Partial<MuonApiClient>);
    expect(recallMemory).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: process.cwd() })
    );
  });

  it("analytics sends the cwd — hot-module paths are workspace-relative", async () => {
    const memoryAnalytics = vi.fn().mockResolvedValue({
      noteScores: [],
      hotModules: [],
      communities: [],
      source: { notes: 0, modules: 0, edges: 0, truncated: false },
    });
    await run(["memory", "analytics"], {
      memoryAnalytics,
    } as unknown as Partial<MuonApiClient>);
    expect(memoryAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: process.cwd() })
    );
  });

  it("neighbors and explain send it as well — a provenance walk is a read", async () => {
    const memoryNeighbors = vi.fn().mockResolvedValue({
      nodes: [],
      edges: [],
      provenance: { hops: 1, truncated: false },
    });
    await run(["memory", "neighbors", "--node-id", "note:mem-1"], {
      memoryNeighbors,
    } as unknown as Partial<MuonApiClient>);
    expect(memoryNeighbors).toHaveBeenCalledWith(
      "note:mem-1",
      expect.objectContaining({ workspace: process.cwd() })
    );

    const memoryExplain = vi.fn().mockResolvedValue({
      noteId: "mem-1",
      path: { nodes: [], edges: [], goal: "missing" },
      contradictions: [],
      provenance: { hops: 6, truncated: false },
    });
    await run(["memory", "explain", "--note-id", "mem-1"], {
      memoryExplain,
    } as unknown as Partial<MuonApiClient>);
    expect(memoryExplain).toHaveBeenCalledWith(
      "mem-1",
      expect.objectContaining({ workspace: process.cwd() })
    );
  });
});

describe("ADR-0026 step 4: --workspace and --unscoped", () => {
  it("--workspace replaces the default", async () => {
    const searchMemory = vi.fn().mockResolvedValue([]);
    await run(
      ["memory", "search", "--workspace", "/Users/dev/SWE/repo-b", "idempotency"],
      { searchMemory } as unknown as Partial<MuonApiClient>
    );
    expect(searchMemory).toHaveBeenCalledWith(
      "idempotency",
      expect.objectContaining({ workspace: "/Users/dev/SWE/repo-b" })
    );
  });

  it("--unscoped asks for the §8 residue and sends NO workspace", async () => {
    const searchMemory = vi.fn().mockResolvedValue([]);
    await run(["memory", "search", "--unscoped", "idempotency"], {
      searchMemory,
    } as unknown as Partial<MuonApiClient>);
    const options = searchMemory.mock.calls[0]![1];
    expect(options.unscoped).toBe(true);
    // Sending both is a 400 server-side, so the CLI must not send a workspace here.
    expect(options.workspace).toBeUndefined();
  });

  it("refuses --workspace with --unscoped rather than preferring one", async () => {
    const searchMemory = vi.fn().mockResolvedValue([]);
    await run(
      [
        "memory",
        "search",
        "--unscoped",
        "--workspace",
        "/Users/dev/SWE/repo-b",
        "idempotency",
      ],
      { searchMemory } as unknown as Partial<MuonApiClient>
    );
    // The command prints the refusal and sets a failing exit code; the read never
    // happens, so no partition is silently chosen for the operator.
    expect(searchMemory).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe("ADR-0026 §8: every printed row is LABELLED with its workspace", () => {
  it("prints the note's workspace, and `unscoped` when it has none", async () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      await run(["memory", "search", "idempotency"], {
        searchMemory: vi
          .fn()
          .mockResolvedValue([note, { ...note, id: "mem-2", workspacePath: null }]),
      } as unknown as Partial<MuonApiClient>);
    } finally {
      spy.mockRestore();
    }
    const output = written.join("");
    // The banner states the partition the READ used…
    expect(output).toContain(`workspace: ${process.cwd()}`);
    // …and every row states the partition it BELONGS to, which is the half that
    // covers a genuinely mixed page (an operator read with no coordinate).
    expect(output).toContain("workspace=/Users/dev/SWE/repo-a");
    expect(output).toContain("workspace=unscoped");
  });

  it("labels the library page too — the page §1 measured spanning two repos", async () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      await run(["memory", "library"], {
        listMemoryLibrary: vi.fn().mockResolvedValue({
          ...emptySnapshot,
          notes: [note, { ...note, id: "mem-2", workspacePath: null }],
          total: 2,
        }),
      } as unknown as Partial<MuonApiClient>);
    } finally {
      spy.mockRestore();
    }
    const output = written.join("");
    expect(output).toContain("workspace=/Users/dev/SWE/repo-a");
    expect(output).toContain("workspace=unscoped");
  });
});
