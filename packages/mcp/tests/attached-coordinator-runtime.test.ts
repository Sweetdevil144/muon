import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readAttachedCoordinatorCapabilityFile,
  writeAttachedCoordinatorCapabilityFile,
} from "@muon/client/attached-coordinator-capability";
import type { DispatchJobRecord } from "@muon/client";
import type { AttachedCoordinatorCapabilityFile } from "@muon/protocol";

// ── ADR-0028 Tier C: the attached-coordinator MCP runtime ───────────────────
//
// `runAttachedCoordinator()` must:
//   1. Refuse to start with no MUON_ATTACHED_CAPABILITY_FILE.
//   2. Refuse to start when that file is missing/invalid/expired on disk.
//   3. NEVER fall back to an ambient MUON_AGENT_TOKEN/MUON_API_TOKEN as
//      authority for this mode — proven two ways: (a) a poisoned ambient
//      token present alongside a missing/invalid file still refuses (it is
//      never used to paper over the absence), and (b) with a VALID file, the
//      client MUON actually builds is constructed from the file's own
//      apiToken/apiBase, never the ambient — captured by spying on
//      MuonApiClient's constructor.
//
// `buildMuonServer` is mocked so `server.connect(transport)` never touches
// real stdio (its real StdioServerTransport is otherwise side-effect-free
// until `.start()`, which only the real McpServer.connect would call).

const capabilityConstructions: Array<{ apiBase: string; apiToken: string }> = [];
const heartbeatCalls: string[] = [];
const workflowListCalls: Array<{ filter: unknown; control: unknown }> = [];
const budgetCalls: string[] = [];

vi.mock("@muon/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/client")>();
  class SpyMuonApiClient extends actual.MuonApiClient {
    constructor(apiBase: string, fetcher: unknown, apiToken?: string, ...rest: unknown[]) {
      // @ts-expect-error forwarding a variadic constructor to the real class
      super(apiBase, fetcher, apiToken, ...rest);
      capabilityConstructions.push({ apiBase, apiToken: apiToken ?? "" });
    }

    override async getDispatchJob(jobId: string) {
      return { id: jobId, chatId: "chat-attached", status: "running" } as DispatchJobRecord;
    }

    override async getDispatchBudget(jobId: string) {
      budgetCalls.push(jobId);
      return {
        poolMs: 1,
        reservedMs: 0,
        consumedMs: 0,
        remainingMs: 1,
        children: [],
      } as never;
    }

    override async listWorkflowRuns(filter?: unknown, control?: unknown) {
      workflowListCalls.push({ filter, control });
      return [];
    }

    override async listTasks() {
      return [];
    }

    override async heartbeatAttachedCoordinator(jobId: string) {
      heartbeatCalls.push(jobId);
      return {
        job: { id: jobId } as DispatchJobRecord,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      };
    }
  }
  return { ...actual, MuonApiClient: SpyMuonApiClient };
});

const connectCalls: unknown[] = [];
vi.mock("../src/server-factory.js", () => ({
  buildMuonServer: vi.fn((tools: unknown, opts: unknown) => ({
    tools,
    opts,
    connect: vi.fn(async (transport: unknown) => {
      connectCalls.push({ tools, opts, transport });
    }),
  })),
}));

const POISON_AGENT_TOKEN = "POISONED-ambient-agent-token-must-never-be-used";
const POISON_API_TOKEN = "POISONED-ambient-api-token-must-never-be-used";

let dir: string;
const savedEnv = { ...process.env };

function trackedSignalListeners(): { sigterm: NodeJS.SignalsListener[]; sigint: NodeJS.SignalsListener[] } {
  return {
    sigterm: [...process.listeners("SIGTERM")],
    sigint: [...process.listeners("SIGINT")],
  };
}
function untrackNewSignalListeners(before: ReturnType<typeof trackedSignalListeners>): void {
  for (const fn of process.listeners("SIGTERM")) {
    if (!before.sigterm.includes(fn)) process.removeListener("SIGTERM", fn as NodeJS.SignalsListener);
  }
  for (const fn of process.listeners("SIGINT")) {
    if (!before.sigint.includes(fn)) process.removeListener("SIGINT", fn as NodeJS.SignalsListener);
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-mcp-attached-runtime-"));
  capabilityConstructions.length = 0;
  heartbeatCalls.length = 0;
  connectCalls.length = 0;
  workflowListCalls.length = 0;
  budgetCalls.length = 0;
  delete process.env.MUON_ATTACHED_CAPABILITY_FILE;
  delete process.env.MUON_MCP_MODE;
  process.env.MUON_AGENT_TOKEN = POISON_AGENT_TOKEN;
  process.env.MUON_API_TOKEN = POISON_API_TOKEN;
  // Fake timers: a successful run() starts a real 30s heartbeat `setInterval`
  // (unref'd, but still live). Faking timers here means it never actually
  // fires mid-suite and there is nothing to leak once the test ends.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  process.env = { ...savedEnv };
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function validCapability(
  overrides: Partial<AttachedCoordinatorCapabilityFile> = {}
): AttachedCoordinatorCapabilityFile {
  return {
    version: 1,
    apiBase: "http://127.0.0.1:4317",
    apiToken: "the-real-capability-token-from-the-file-not-ambient",
    jobId: "job-attached-root",
    delegationToken: "the-real-capability-token-from-the-file-not-ambient",
    chatId: "chat-attached",
    chatTaskId: "task-attached-shadow",
    workspacePath: "/repo",
    vendor: "codex",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    ...overrides,
  };
}

describe("runAttachedCoordinator", () => {
  it("refuses to start with no MUON_ATTACHED_CAPABILITY_FILE set", async () => {
    const { runAttachedCoordinator } = await import("../src/index.js");
    // ADR-0049: a vendor config in this mode with no capability path is BROKEN
    // rather than lapsed, and it earns the same legible refusal — the failure
    // an operator meets must not be an error code either way.
    await runAttachedCoordinator();
    expect(capabilityConstructions).toHaveLength(0);
    expect(connectCalls).toHaveLength(1);
    const served = connectCalls[0] as { tools: unknown[]; opts: { instructions?: string } };
    expect(served.tools).toEqual([]);
    expect(served.opts.instructions).toContain("requires MUON_ATTACHED_CAPABILITY_FILE");
    expect(served.opts.instructions).toContain("muon mcp attach");
  });

  it("refuses to start when the capability file does not exist on disk", async () => {
    process.env.MUON_ATTACHED_CAPABILITY_FILE = path.join(dir, "codex.json");
    const { runAttachedCoordinator } = await import("../src/index.js");
    // ADR-0049: it no longer THROWS — throwing killed the process before the
    // transport existed and the vendor reported only `-32000`. It serves the
    // handshake holding nothing, and says why.
    await runAttachedCoordinator();
    expect(capabilityConstructions, "no client is built from a file it refused").toHaveLength(0);
    expect(connectCalls).toHaveLength(1);
    const served = connectCalls[0] as { tools: unknown[]; opts: { instructions?: string } };
    expect(served.tools, "a refused seat offers no tool at all").toEqual([]);
    expect(served.opts.instructions).toContain("(missing)");
    expect(served.opts.instructions).toContain("muon mcp attach");
  });

  it("refuses to start when the capability file is expired, without leaking apiToken/delegationToken", async () => {
    const target = writeAttachedCoordinatorCapabilityFile(
      validCapability({
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        apiToken: "SECRET-CAP-API-TOKEN-VALUE-PADDING-PADDING-PADDING",
        delegationToken: "SECRET-CAP-DELEGATION-TOKEN-PADDING-PADDING",
      }),
      dir
    );
    process.env.MUON_ATTACHED_CAPABILITY_FILE = target;
    const { runAttachedCoordinator } = await import("../src/index.js");

    // ADR-0049: serves the handshake, holds nothing, names the remedy — and
    // the SECRECY property is unchanged and now covers a wider surface, since
    // the reason is carried in instructions an agent will actually read.
    await runAttachedCoordinator();
    expect(capabilityConstructions, "an expired file builds no client").toHaveLength(0);
    expect(connectCalls).toHaveLength(1);
    const served = connectCalls[0] as { tools: unknown[]; opts: { instructions?: string } };
    expect(served.tools).toEqual([]);
    const instructions = served.opts.instructions ?? "";
    expect(instructions).toContain("(expired)");
    expect(instructions).toContain("muon mcp attach");
    expect(instructions, "the remedy is the HUMAN's, never the agent's").toMatch(
      /Do not attempt to mint or repair this seat yourself/
    );
    expect(instructions).not.toContain("SECRET-CAP-API-TOKEN");
    expect(instructions).not.toContain("SECRET-CAP-DELEGATION-TOKEN");
  });

  it("a poisoned ambient MUON_AGENT_TOKEN/MUON_API_TOKEN never substitutes for a missing capability file", async () => {
    // Ambient tokens are already set to POISON_* in beforeEach; no capability
    // file exists. If this mode ever fell back to the ambient credential, it
    // would proceed instead of refusing.
    const { runAttachedCoordinator } = await import("../src/index.js");
    // ADR-0049 changed the SHAPE of the refusal, never its substance: no
    // ambient token may stand in for a capability file, so no client is built.
    await runAttachedCoordinator();
    expect(capabilityConstructions).toHaveLength(0);
    expect(capabilityConstructions).toHaveLength(0);
  });

  it("with a VALID capability file, builds its client from the file's OWN apiToken/apiBase — never the ambient POISON_* tokens", async () => {
    const capability = validCapability({
      apiBase: "http://127.0.0.1:59999",
      apiToken: "the-real-capability-token-from-the-file-not-ambient",
    });
    const target = writeAttachedCoordinatorCapabilityFile(capability, dir);
    process.env.MUON_ATTACHED_CAPABILITY_FILE = target;

    const before = trackedSignalListeners();
    const { runAttachedCoordinator } = await import("../src/index.js");
    await runAttachedCoordinator();
    untrackNewSignalListeners(before);

    expect(connectCalls).toHaveLength(1);
    // Exactly one MuonApiClient was constructed for this run, from the FILE.
    expect(capabilityConstructions).toEqual([
      { apiBase: capability.apiBase, apiToken: capability.apiToken },
    ]);
    expect(capabilityConstructions[0]!.apiToken).not.toBe(POISON_AGENT_TOKEN);
    expect(capabilityConstructions[0]!.apiToken).not.toBe(POISON_API_TOKEN);
  });

  it("the runtime tool set for a valid attach is exactly MUON_ATTACHED_COORDINATOR_TOOL_NAMES, positively — never set_fleet/raise_budget/apply_workflow", async () => {
    const target = writeAttachedCoordinatorCapabilityFile(validCapability(), dir);
    process.env.MUON_ATTACHED_CAPABILITY_FILE = target;

    const before = trackedSignalListeners();
    const { runAttachedCoordinator } = await import("../src/index.js");
    await runAttachedCoordinator();
    untrackNewSignalListeners(before);

    expect(connectCalls).toHaveLength(1);
    const built = connectCalls[0] as {
      tools: Array<{ name: string }>;
      opts: { mode: string };
    };
    expect(built.opts.mode).toBe("attached-coordinator");
    const names = built.tools.map((tool) => tool.name);
    for (const excluded of ["set_fleet", "raise_budget", "apply_workflow"]) {
      expect(names).not.toContain(excluded);
    }
    for (const granted of [
      "create_task",
      "dispatch",
      "steer",
      "interrupt",
      "ship",
      "assign_roles",
      "propose_workflow",
    ]) {
      expect(names).toContain(granted);
    }
  });

  it("a lane-scoped refusal from the REAL boot path names the seat, not a hand-launch", async () => {
    // The seat marker is one line in index.ts (`seat: "attached-coordinator"`),
    // and every other test that proves its effect hand-constructs the scope —
    // so deleting that line kept the whole suite green while restoring the
    // misdiagnosis measured live on 2026-08-13 ("This session was
    // hand-launched", said to a seat holding a job). This walks the real
    // `runAttachedCoordinator()` wiring instead.
    const target = writeAttachedCoordinatorCapabilityFile(validCapability(), dir);
    process.env.MUON_ATTACHED_CAPABILITY_FILE = target;

    const before = trackedSignalListeners();
    const { runAttachedCoordinator } = await import("../src/index.js");
    await runAttachedCoordinator();
    untrackNewSignalListeners(before);

    const built = connectCalls[0] as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }> }> };
    const remove = built.tools.find((tool) => tool.name === "memory_delete")!;

    const refusal = await remove.handler({ noteId: "note-1" });
    const text = refusal.content[0]?.text ?? "";

    expect(refusal.isError).toBe(true);
    expect(text).toMatch(/attached coordinator seat/i);
    expect(text).not.toMatch(/hand-launched/i);
    expect(text).not.toMatch(/runner's environment/i);
  });

  it("workflow_status from the REAL boot path carries the seat's caller-job capability", async () => {
    // The other measured 2026-08-13 defect: the workflow routes authenticate
    // the CALLER'S JOB, the seat's bearer carries one, and without these
    // headers the read 403s — so the seat could `propose_workflow` and never
    // read back its own run. `observer-tools.test.ts` proves the forwarding
    // given a scope; this proves Tier C's factory actually populates that
    // scope from the capability file, through main().
    const target = writeAttachedCoordinatorCapabilityFile(validCapability(), dir);
    process.env.MUON_ATTACHED_CAPABILITY_FILE = target;

    const before = trackedSignalListeners();
    const { runAttachedCoordinator } = await import("../src/index.js");
    await runAttachedCoordinator();
    untrackNewSignalListeners(before);

    const built = connectCalls[0] as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }> };
    const status = built.tools.find((tool) => tool.name === "workflow_status")!;

    await status.handler({ runId: "run-x" });

    expect(workflowListCalls).toHaveLength(1);
    expect(workflowListCalls[0]?.control).toEqual({
      callerJobId: "job-attached-root",
      delegationToken: "the-real-capability-token-from-the-file-not-ambient",
    });
  });

  it("budget_status with NO argument reads the seat's own mission budget", async () => {
    // Its description promises "omit it for this chat's mission", and the
    // omission resolves from the orchestrator scope's jobId — which the
    // observer wrapper used to drop, so a live seat was told "no jobId in
    // scope" by a tool advertising exactly that call (30-tool sweep,
    // 2026-08-13). Through the real boot path: the capability file's job must
    // arrive at the budget read.
    const target = writeAttachedCoordinatorCapabilityFile(validCapability(), dir);
    process.env.MUON_ATTACHED_CAPABILITY_FILE = target;

    const before = trackedSignalListeners();
    const { runAttachedCoordinator } = await import("../src/index.js");
    await runAttachedCoordinator();
    untrackNewSignalListeners(before);

    const built = connectCalls[0] as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }> }> };
    const budget = built.tools.find((tool) => tool.name === "budget_status")!;

    const result = await budget.handler({});

    expect(result.isError).not.toBe(true);
    expect(budgetCalls).toEqual(["job-attached-root"]);
  });

  it("persists each successful heartbeat expiry so a vendor restart can re-read the capability after the original lease", async () => {
    const originalExpiry = new Date(Date.now() + 120_000);
    const target = writeAttachedCoordinatorCapabilityFile(
      validCapability({ expiresAt: originalExpiry.toISOString() }),
      dir
    );
    process.env.MUON_ATTACHED_CAPABILITY_FILE = target;

    const before = trackedSignalListeners();
    const { runAttachedCoordinator } = await import("../src/index.js");
    await runAttachedCoordinator();
    await vi.advanceTimersByTimeAsync(30_000);
    untrackNewSignalListeners(before);

    expect(heartbeatCalls).toEqual(["job-attached-root"]);
    const restartedRead = readAttachedCoordinatorCapabilityFile(target, {
      now: new Date(originalExpiry.getTime() + 1),
    });
    expect(restartedRead.ok).toBe(true);
    if (restartedRead.ok) {
      expect(new Date(restartedRead.capability.expiresAt).getTime()).toBeGreaterThan(
        originalExpiry.getTime()
      );
    }
  });
});
