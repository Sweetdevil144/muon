import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";

// ── ADR-0051 §3 — the institutional pack rides into every governed brief ────
//
// The runner fetches the standing canon WIDENED by ownership/why-tagged,
// human-confirmed decisions, partitions by tag, and renders the pack ABOVE
// the standing canon. The obligations under test are the ADR's own: zero
// unconfirmed ids in the pack, no pack section when the fetch never answered
// (an absence line about a question never asked would be a false claim), and
// byte-compatible degradation for clients that predate the method.
// A10 rides the same dispatch: a STALE local code-graph index adds the loud
// TOOL GAP block; fresh and missing do not.

const run$ = promisify(execFile);

const coreMocks = vi.hoisted(() => ({
  startManagedSession: vi.fn(),
  runLaneTask: vi.fn(),
  runLoop: vi.fn(),
}));

vi.mock("@muon/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/core")>();
  return {
    ...actual,
    startManagedSession: coreMocks.startManagedSession,
    runLaneTask: coreMocks.runLaneTask,
    runLoop: coreMocks.runLoop,
  };
});

import { executeJob } from "../src/execute.js";

const OWNERSHIP_NOTE = {
  id: "own-1",
  kind: "decision",
  text: "the ledger is owned by the memory crew; ask before schema changes",
  confirmed: true,
  stale: false,
  modules: [],
  topics: ["ownership"],
  symbols: [],
  trust: "high",
  status: "active",
  scope: "global",
};

const UNCONFIRMED_OWNERSHIP = {
  ...OWNERSHIP_NOTE,
  id: "own-unconfirmed",
  text: "unvouched ownership claim about the ledger",
  confirmed: false,
};

const CANON = {
  id: "standing-1",
  kind: "constraint",
  text: "Never custody vendor tokens",
  confirmed: true,
  stale: false,
  modules: [],
  topics: [],
  symbols: [],
  trust: "high",
  status: "active",
  scope: "global",
};

function sessionJob(workspace: string, overrides: Record<string, unknown> = {}) {
  const deadlineAt = new Date(Date.now() + 600_000).toISOString();
  const id = (overrides.id as string | undefined) ?? "job-institutional";
  return {
    id,
    kind: "session",
    vendor: "claude-code",
    taskId: "task-institutional",
    chatId: "chat-institutional",
    brief: "do the task",
    workspacePath: workspace,
    capabilityMode: "orchestrator",
    maxDelegationDepth: 3,
    maxChildren: 3,
    maxTotalDescendants: 8,
    maxDelegationIterations: 10,
    delegationDeadline: deadlineAt,
    delegationManifest: {
      version: 1,
      jobId: id,
      workspacePath: workspace,
      maxDepth: 3,
      maxChildrenPerParent: 3,
      maxTotalDescendants: 8,
      maxIterations: 10,
      deadlineAt,
      authority: "orchestrator",
      childAuthority: "work",
      narrowingRequired: true,
    },
    status: "running",
    interruptRequested: false,
    steerMessages: [],
    dispatchedBy: "orchestrator",
    ...overrides,
  };
}

function fakeClient(options: {
  institutional?: unknown[] | "absent" | "throws";
  scanComplete?: boolean;
  standing?: unknown[] | "absent";
  taskNotes?: unknown[];
}) {
  const client: Record<string, unknown> = {
    listLanes: vi.fn(async () => [{ id: "lane-1", key: "claude-code" }]),
    getTaskDetail: vi.fn(async () => undefined),
    getLaneProfile: vi.fn(async () => ({ profile: undefined })),
    recallRelatedToTask: vi.fn(async () => options.taskNotes ?? []),
    searchMemory: vi.fn(async () => []),
    markMemoryUsed: vi.fn(async () => undefined),
    updateAgent: vi.fn(async () => ({})),
    drainDispatchSteer: vi.fn(async () => []),
    getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
    recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
    updateChat: vi.fn(async () => ({})),
    recordEvent: vi.fn(async () => undefined),
    addMemoryNoteWithAction: vi.fn(async () => ({ action: "inserted" })),
    getMemoryMining: vi.fn(async () => false),
  };
  if (options.institutional === "throws") {
    client.recallInstitutionalMemory = vi.fn(async () => {
      throw new Error("brain unreachable");
    });
  } else if (options.institutional !== "absent") {
    client.recallInstitutionalMemory = vi.fn(async () => ({
      notes: options.institutional ?? [],
      ownershipScanComplete: options.scanComplete ?? true,
    }));
  }
  if (options.standing !== "absent") {
    client.recallStandingMemory = vi.fn(async () => options.standing ?? []);
  }
  return client as unknown as MuonApiClient;
}

async function runJob(client: MuonApiClient, workspace: string) {
  return executeJob(
    client,
    sessionJob(workspace) as never,
    { id: "agent-1", name: "claude-code-1" },
    {
      apiBase: "http://127.0.0.1:4000",
      delegationToken: "root-job-token",
      steerPollMs: 1,
      jobClient: client,
    }
  );
}

function sentBrief(): string {
  const call = coreMocks.startManagedSession.mock.calls.at(-1);
  return String((call?.[1] as { brief?: string })?.brief ?? "");
}

let workspace: string;

async function git(cwd: string, ...args: string[]) {
  await run$("git", args, { cwd });
}

/** A tiny real repo so the freshness probe resolves an actual HEAD. */
async function initRepo(root: string): Promise<string> {
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Muon Test");
  await writeFile(join(root, "README.md"), "fixture\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  const { stdout } = await run$("git", ["rev-parse", "HEAD"], { cwd: root });
  return stdout.trim();
}

async function writeIndexMeta(root: string, lastCommit: string) {
  await mkdir(join(root, ".gitnexus"), { recursive: true });
  await writeFile(
    join(root, ".gitnexus", "meta.json"),
    JSON.stringify({
      repoPath: root,
      lastCommit,
      indexedAt: "2026-08-14T05:30:27.292Z",
      stats: { files: 42, nodes: 1234, edges: 5, communities: 3, processes: 7 },
    })
  );
}

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "muon-inst-pack-")));
  coreMocks.startManagedSession.mockReset();
  coreMocks.startManagedSession.mockResolvedValue({
    sessionId: "session-1",
    handle: {
      vendorSessionId: "vendor-session-1",
      send: async () => undefined,
      interrupt: async () => undefined,
      wait: async () => ({ exitCode: 0, output: "done" }),
    },
  });
  coreMocks.runLaneTask.mockReset();
  coreMocks.runLaneTask.mockResolvedValue({ exitCode: 0, output: "{}" });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

describe("ADR-0051 — the institutional pack in the runner", () => {
  it("renders the ownership slice above the standing canon, partitioned by tag", async () => {
    const client = fakeClient({
      institutional: [OWNERSHIP_NOTE, CANON],
      taskNotes: [],
    });
    const result = await runJob(client, workspace);
    expect(result.status).toBe("done");
    const brief = sentBrief();
    expect(brief).toContain("OWNERSHIP / WHY (human-confirmed):");
    expect(brief).toContain("owned by the memory crew");
    expect(brief).toContain("Standing workspace memory");
    expect(brief).toContain("Never custody vendor tokens");
    // The pack frames the canon: institutional context reads first.
    expect(brief.indexOf("Institutional context")).toBeLessThan(
      brief.indexOf("Standing workspace memory")
    );
    // Partition, not duplication: the tagged note does not also ride the
    // standing section.
    const occurrences = brief.split("owned by the memory crew").length - 1;
    expect(occurrences).toBe(1);
  });

  it("an unconfirmed ownership-tagged note cannot enter the brief at all", async () => {
    const client = fakeClient({
      institutional: [UNCONFIRMED_OWNERSHIP, CANON],
      taskNotes: [],
    });
    await runJob(client, workspace);
    const brief = sentBrief();
    // ADR-0051's first test obligation, at the wire: the defense-in-depth
    // selector drops it even though the server should never have sent it.
    expect(brief).not.toContain("unvouched ownership claim");
    // With zero confirmed ownership notes the slice says so explicitly.
    expect(brief).toContain("no confirmed ownership or rationale notes");
  });

  it("a failed institutional fetch yields NO pack — absence of an answer is not an absence claim", async () => {
    const client = fakeClient({ institutional: "throws", taskNotes: [] });
    const result = await runJob(client, workspace);
    expect(result.status).toBe("done");
    const brief = sentBrief();
    expect(brief).not.toContain("Institutional context");
    expect(brief).not.toContain("no confirmed ownership");
  });

  it("a client that predates the method degrades to the standing arm, byte-compatible", async () => {
    const client = fakeClient({
      institutional: "absent",
      standing: [CANON],
      taskNotes: [],
    });
    const result = await runJob(client, workspace);
    expect(result.status).toBe("done");
    const brief = sentBrief();
    expect(brief).not.toContain("Institutional context");
    expect(brief).toContain("Standing workspace memory");
    expect(brief).toContain("Never custody vendor tokens");
  });
});

describe("F3 — ownership scan honesty in the brief", () => {
  it("a truncated ownership scan never asserts ledger-wide absence", async () => {
    const client = fakeClient({
      institutional: [CANON],
      scanComplete: false,
      taskNotes: [],
    });
    await runJob(client, workspace);
    const brief = sentBrief();
    expect(brief).not.toContain("no confirmed ownership or rationale notes exist");
    expect(brief).toContain("absence is NOT established");
  });
});

describe("A10 — index freshness in the brief", () => {
  it("a STALE index raises the loud TOOL GAP block and the pack names it", async () => {
    await initRepo(workspace);
    await writeIndexMeta(workspace, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    const client = fakeClient({ institutional: [OWNERSHIP_NOTE], taskNotes: [] });
    await runJob(client, workspace);
    const brief = sentBrief();
    expect(brief).toContain("code-graph index is STALE");
    expect(brief).toContain("TOOL GAP");
    expect(brief).toContain("CODE GRAPH: index is STALE");
  });

  it("a FRESH index adds no gap block and summarizes the graph shape", async () => {
    const head = await initRepo(workspace);
    await writeIndexMeta(workspace, head);
    const client = fakeClient({ institutional: [OWNERSHIP_NOTE], taskNotes: [] });
    await runJob(client, workspace);
    const brief = sentBrief();
    expect(brief).not.toContain("code-graph index is STALE");
    expect(brief).toContain("CODE GRAPH: fresh index");
    expect(brief).toContain("1234 symbols");
  });

  it("a MISSING index stays quiet — the graph tools name their own absence", async () => {
    const client = fakeClient({ institutional: [OWNERSHIP_NOTE], taskNotes: [] });
    await runJob(client, workspace);
    const brief = sentBrief();
    expect(brief).not.toContain("TOOL GAP — the code-graph evidence");
    expect(brief).toContain("no readable local index");
  });
});
