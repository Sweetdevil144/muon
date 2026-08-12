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

vi.mock("@muon/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/client")>();
  class SpyMuonApiClient extends actual.MuonApiClient {
    constructor(apiBase: string, fetcher: unknown, apiToken?: string, ...rest: unknown[]) {
      // @ts-expect-error forwarding a variadic constructor to the real class
      super(apiBase, fetcher, apiToken, ...rest);
      capabilityConstructions.push({ apiBase, apiToken: apiToken ?? "" });
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
