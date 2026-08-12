import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import {
  MUON_DELEGATE_CAPABILITY_TOOL_NAMES,
  MUON_ORCHESTRATOR_TOOL_NAMES,
  VENDOR_IDS,
} from "@muon/protocol";

// ── The vendor × position matrix, at the LAUNCH boundary ─────────────────────
//
// The route half of this matrix lives in backend/tests/vendor-position-matrix;
// this is the half that decides what the vendor process actually receives.
// For BOTH coordinator-capable vendors, in BOTH positions, it pins:
//   • the governed MUON MCP server survives into the launch profile,
//   • its lineage env is COMPLETE for the capability mode it declares (this is
//     the exact contract whose absence kills muon-mcp inside `initialize`),
//   • the capability grant is exactly the bounded set for that position,
//   • and executeJob's own launch assertions PASS rather than refusing.
//
// Everything here is hermetic: `startManagedSession` is mocked, so no vendor
// CLI is ever spawned. What is proven is the profile MUON hands the driver.

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

/** Both vendors the product promises in both seats. */
const VENDORS = ["claude-code", "codex"] as const;
type Vendor = (typeof VENDORS)[number];

const WORKSPACE = process.cwd();
const DEADLINE = new Date(Date.now() + 600_000).toISOString();

function laneClient(vendor: Vendor): MuonApiClient {
  return {
    listLanes: vi.fn(async () => [{ id: "lane-1", key: vendor }]),
    getTaskDetail: vi.fn(async () => undefined),
    getLaneProfile: vi.fn(async () => ({ profile: undefined })),
    recallRelatedToTask: vi.fn(async () => []),
    markMemoryUsed: vi.fn(async () => undefined),
    updateAgent: vi.fn(async () => ({})),
    drainDispatchSteer: vi.fn(async () => []),
    getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
    recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
    updateChat: vi.fn(async () => ({})),
    recordEvent: vi.fn(async () => undefined),
  } as unknown as MuonApiClient;
}

/** The profile the (mocked) driver was handed for the launch under test. */
function launchedProfile() {
  return coreMocks.startManagedSession.mock.calls[0]![1].profile;
}

function muonServer() {
  return launchedProfile().mcpServers.find(
    (server: { name: string }) => server.name === "muon"
  );
}

/**
 * The lineage `muon-mcp` refuses to start without, per declared mode. Mirrors
 * MODE_REQUIRED_ENV in @muon/adapters' mcp-env-contract (asserted here by name
 * rather than by import, so the runner keeps its dependency set unchanged).
 */
const MODE_REQUIRED_ENV: Record<string, readonly string[]> = {
  orchestrator: ["MUON_JOB_ID", "MUON_DELEGATION_TOKEN"],
  delegate: ["MUON_JOB_ID"],
};

/** Every declared name carries a real value — an empty one reads as absent. */
function expectCompleteEnvContract(env: Record<string, string>) {
  const mode = env.MUON_MCP_MODE;
  for (const name of MODE_REQUIRED_ENV[mode ?? ""] ?? []) {
    expect(typeof env[name]).toBe("string");
    expect(env[name]!.trim().length).toBeGreaterThan(0);
  }
  for (const [name, value] of Object.entries(env)) {
    expect(
      value.trim().length,
      `${name} was declared on the governed MUON MCP server with no value`
    ).toBeGreaterThan(0);
  }
}

beforeEach(() => {
  coreMocks.startManagedSession.mockReset();
  coreMocks.startManagedSession.mockImplementation(async () => ({
    sessionId: "session-1",
    handle: {
      send: async () => undefined,
      interrupt: async () => undefined,
      wait: async () => ({ exitCode: 0, output: "done" }),
    },
  }));
});

describe("vendor × position: SUPERAGENT (the coordinator seat) launches", () => {
  it.each(VENDORS)(
    "%s reaches launch with a complete orchestrator MCP env contract and the exact coordinator grant",
    async (vendor) => {
      const result = await executeJob(
        laneClient(vendor),
        {
          id: "job-chat",
          kind: "session",
          vendor,
          taskId: "task-mission",
          chatId: "chat-1",
          brief: "orchestrate",
          workspacePath: WORKSPACE,
          capabilityMode: "orchestrator",
          maxDelegationDepth: 3,
          maxChildren: 3,
          maxTotalDescendants: 8,
          maxDelegationIterations: 10,
          delegationDeadline: DEADLINE,
          delegationManifest: {
            version: 1,
            jobId: "job-chat",
            workspacePath: WORKSPACE,
            maxDepth: 3,
            maxChildrenPerParent: 3,
            maxTotalDescendants: 8,
            maxIterations: 10,
            deadlineAt: DEADLINE,
            authority: "orchestrator",
            childAuthority: "work",
            narrowingRequired: true,
          },
          status: "running",
          interruptRequested: false,
          steerMessages: [],
          dispatchedBy: "orchestrator",
        },
        { id: "agent-1", name: `${vendor}-coordinator` },
        {
          apiBase: "http://127.0.0.1:4000",
          delegationToken: "root-job-token",
          steerPollMs: 1,
        }
      );

      // The launch assertions PASSED: a refusal returns status "failed" with a
      // "refusing … launch" result, never a session.
      expect(result.status).toBe("done");
      expect(coreMocks.startManagedSession).toHaveBeenCalledTimes(1);
      // The driver is selected by lane key, so the seat really is this vendor's.
      expect(coreMocks.startManagedSession.mock.calls[0]![1].laneKey).toBe(
        vendor
      );

      const muon = muonServer();
      expect(muon).toBeDefined();
      expect(muon.env).toMatchObject({
        MUON_MCP_MODE: "orchestrator",
        MUON_JOB_ID: "job-chat",
        MUON_DELEGATION_TOKEN: "root-job-token",
        MUON_CHAT_ID: "chat-1",
        MUON_CHAT_TASK_ID: "task-mission",
        MUON_WORKSPACE: WORKSPACE,
      });
      expectCompleteEnvContract(muon.env);

      // The coordinator grant is bounded identically for both vendors.
      expect(launchedProfile().allowedTools).toEqual(
        MUON_ORCHESTRATOR_TOOL_NAMES.map((name) => `mcp__muon__${name}`)
      );
      expect(launchedProfile().permissionMode).toBe("default");
      expect(launchedProfile().extraArgs).toEqual([]);
      // TODO 1.16: and for claude that exact-set bound IS the fan-out
      // suppression — its `Task` tool has no config key to turn off, so the only
      // thing keeping a native sub-agent out is that `Task` was never granted.
      // Asserted as an absence because the grant is a whitelist: anything the
      // list does not name cannot be spawned.
      expect(launchedProfile().allowedTools).not.toContain("Task");
      expect(
        launchedProfile().allowedTools.some((name: string) =>
          name.startsWith("Task")
        )
      ).toBe(false);
    }
  );

  it("narrows ONLY Codex's native fan-out, and does so on every Codex coordinator", async () => {
    // A documented, intentional asymmetry: Codex ships a native multi-agent
    // fleet MUON cannot see, govern, or budget. Claude Code has no equivalent
    // config key, so its coordinator carries no such override. Pinned so the
    // narrowing cannot be dropped, and so the CLAUDE side is not "fixed" into
    // carrying a Codex-only key it would reject.
    await executeJob(
      laneClient("codex"),
      {
        id: "job-chat",
        kind: "session",
        vendor: "codex",
        taskId: "task-mission",
        chatId: "chat-1",
        brief: "orchestrate",
        workspacePath: WORKSPACE,
        capabilityMode: "orchestrator",
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 10,
        delegationDeadline: DEADLINE,
        delegationManifest: {
          version: 1,
          jobId: "job-chat",
          workspacePath: WORKSPACE,
          maxDepth: 3,
          maxChildrenPerParent: 3,
          maxTotalDescendants: 8,
          maxIterations: 10,
          deadlineAt: DEADLINE,
          authority: "orchestrator",
          childAuthority: "work",
          narrowingRequired: true,
        },
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "orchestrator",
      },
      { id: "agent-1", name: "codex-coordinator" },
      {
        apiBase: "http://127.0.0.1:4000",
        delegationToken: "root-job-token",
        steerPollMs: 1,
      }
    );
    expect(launchedProfile().rawConfig).toEqual({
      "features.multi_agent": false,
    });
  });

});

describe("vendor × position: SUBAGENT (a delegated worker) launches", () => {
  it.each(VENDORS)(
    "%s reaches launch with a complete delegate MCP env contract and the exact worker grant",
    async (vendor) => {
      const manifest = {
        version: 1 as const,
        rootJobId: "job-root",
        parentJobId: "job-parent",
        jobId: "job-child",
        depth: 2,
        maxDepth: 3,
        maxChildrenPerParent: 3,
        maxTotalDescendants: 8,
        rootWorkspace: WORKSPACE,
        workspacePath: WORKSPACE,
        budget: { maxWallMs: 120_000 },
        deadlineAt: DEADLINE,
        delegationIterationCap: 3,
        authority: "work" as const,
        forbiddenAuthority: ["govern", "approve", "merge", "ship"] as const,
        canDelegate: true,
        propagatedTools: [...MUON_DELEGATE_CAPABILITY_TOOL_NAMES],
        narrowingAttested: true as const,
      };

      const result = await executeJob(
        laneClient(vendor),
        {
          id: "job-child",
          kind: "session",
          vendor,
          taskId: "task-child",
          chatId: "chat-1",
          brief: "fix the parser",
          workspacePath: WORKSPACE,
          parentJobId: "job-parent",
          rootJobId: "job-root",
          delegationDepth: 2,
          maxDelegationDepth: 3,
          maxChildren: 3,
          maxTotalDescendants: 8,
          maxDelegationIterations: 3,
          maxWallMs: 120_000,
          delegationDeadline: DEADLINE,
          capabilityMode: "delegate",
          delegationManifest: manifest,
          status: "running",
          interruptRequested: false,
          steerMessages: [],
          dispatchedBy: "agent:delegate",
        },
        { id: "agent-1", name: `${vendor}-1` },
        {
          apiBase: "http://127.0.0.1:4000",
          delegationToken: "child-job-token",
          steerPollMs: 1,
        }
      );

      expect(result.status).toBe("done");
      expect(coreMocks.startManagedSession.mock.calls[0]![1].laneKey).toBe(
        vendor
      );

      const muon = muonServer();
      expect(muon).toBeDefined();
      expect(muon.env).toMatchObject({
        MUON_MCP_MODE: "delegate",
        MUON_DELEGATE_CAN_SPAWN: "true",
        MUON_JOB_ID: "job-child",
        MUON_DELEGATION_TOKEN: "child-job-token",
        MUON_PARENT_JOB_ID: "job-parent",
        MUON_ROOT_JOB_ID: "job-root",
        MUON_CHAT_ID: "chat-1",
      });
      expectCompleteEnvContract(muon.env);

      // The governed brain is the ONLY server a delegate sees, and its grant is
      // exactly the propagated manifest — identical for both vendors.
      expect(
        launchedProfile().mcpServers.map(
          (server: { name: string }) => server.name
        )
      ).toEqual(["muon"]);
      expect(launchedProfile().allowedTools).toEqual(
        MUON_DELEGATE_CAPABILITY_TOOL_NAMES.map((name) => `mcp__muon__${name}`)
      );
      expect(launchedProfile().permissionMode).toBe("default");
      expect(launchedProfile().rawConfig).toEqual({});
    }
  );
});

describe("vendor × position: SUBAGENT (a plain dispatched worker) launches", () => {
  it.each(VENDORS)(
    "%s reaches launch as a worker with the governed brain attached",
    async (vendor) => {
      const result = await executeJob(
        laneClient(vendor),
        {
          id: "job-worker",
          kind: "session",
          vendor,
          taskId: "task-worker",
          brief: "fix the parser",
          workspacePath: WORKSPACE,
          status: "running",
          interruptRequested: false,
          steerMessages: [],
          dispatchedBy: "human",
        },
        { id: "agent-1", name: `${vendor}-1` },
        { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
      );

      expect(result.status).toBe("done");
      expect(coreMocks.startManagedSession.mock.calls[0]![1].laneKey).toBe(
        vendor
      );

      const muon = muonServer();
      expect(muon).toBeDefined();
      // "worker" is the BASE mode since 830681e (§3.3): absence used to mean
      // both "plain worker" and "human attached this", so the most common
      // session MUON spawns was reading the attached-session voice — told
      // "MUON never spawned you" and "a human is at this terminal", all false
      // for a worker. Only `muon mcp install` writes NO mode now, which is
      // what makes an absent mode genuinely mean "a human attached this".
      // (This pin previously expected `undefined` and kept passing against a
      // STALE core dist for a day — rebuilt 2026-07-31, it now pins the
      // committed contract.)
      expect(muon.env.MUON_MCP_MODE).toBe("worker");
      expect(muon.env.MUON_JOB_ID).toBe("job-worker");
      expectCompleteEnvContract(muon.env);

      // TODO 1.16: a worker seat must never GRANT the native spawner.
      //
      // Deliberately a weak, standing assertion rather than a claim about the
      // suppression: a coordinator is bounded by an exact allow-list so `Task` was
      // absent there for free, a plain worker gets no list at all, and the
      // categorical denial that closes that gap lives in the compiler and the
      // session driver — pinned in packages/adapters, where it can actually be
      // observed. What the RUNNER owes is only this: an allow-listed `Task` would be
      // a MUON decision rather than a vendor default, and there must never be one.
      expect(launchedProfile().allowedTools).not.toContain("Task");
    }
  );
});

// ── The interactive determination, pinned verbatim (the Wave C4 baseline) ────
//
// `executeJob` decides interactive-vs-one-shot with a name-derived branch:
//   kind === "auto" && (vendor === "claude-code" || vendor === "codex")
// spelled a second time in backend/src/routes/dispatch.ts. It is observable
// here without exporting anything: the interactive path calls
// `startManagedSession`, the one-shot path calls `runLaneTask`. Pinned per
// vendor so the later swap to a session-capability read is provably
// behaviour-preserving for the vendors MUON ships.

/**
 * Every registry lane key, plus an id the registry has never heard of.
 *
 * STALE-ID NOTE: this listed `ollama` until Wave C4, five commits after that
 * lane was removed. It still passed, because an unknown id and a driverless
 * lane both answer "one-shot" — a pin that keeps passing for the wrong reason.
 * Naming the ids from `VENDOR_IDS` is what stops that recurring, and the
 * unregistered control is now explicit rather than accidental.
 */
const ALL_LANE_KEYS = [...VENDOR_IDS, "kiro"] as const;

/**
 * Does `kind:"auto"` reach the managed-session path? Unchanged by C4: the swap
 * from `vendor === "claude-code" || vendor === "codex"` to
 * `vendorSupportsInteractive(vendor)` (`session.driver !== "none"`) answers
 * identically for every lane MUON ships.
 */
const AUTO_IS_INTERACTIVE: Readonly<Record<string, boolean>> = {
  // driver: "claude-sdk" / "codex-app-server".
  "claude-code": true,
  codex: true,
  // No session driver: one `cursor-agent --print` per dispatch.
  cursor: false,
  // No session driver: one `opencode run` per dispatch.
  opencode: false,
  // The hermetic double runs its whole task in-process.
  fake: false,
  // Not in the registry at all → no session posture → one-shot, fail-closed.
  kiro: false,
};

describe("vendor × execution mode: the `kind:\"auto\"` interactive determination", () => {
  it.each(ALL_LANE_KEYS)(
    "%s auto-dispatch takes the interactive path === its pinned value",
    async (vendor) => {
      coreMocks.runLaneTask.mockReset();
      coreMocks.runLaneTask.mockResolvedValue({ exitCode: 0, output: "done" });
      const client = {
        ...laneClient("claude-code"),
        listLanes: vi.fn(async () => [{ id: "lane-1", key: vendor }]),
      } as unknown as MuonApiClient;

      await executeJob(
        client,
        {
          id: "job-auto",
          kind: "auto",
          vendor,
          taskId: "task-auto",
          brief: "fix the parser",
          workspacePath: WORKSPACE,
          status: "running",
          interruptRequested: false,
          steerMessages: [],
          dispatchedBy: "human",
        },
        { id: "agent-1", name: `${vendor}-1` },
        { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
      );

      const interactive = AUTO_IS_INTERACTIVE[vendor]!;
      expect(
        coreMocks.startManagedSession.mock.calls.length > 0,
        `${vendor} interactive`
      ).toBe(interactive);
      expect(
        coreMocks.runLaneTask.mock.calls.length > 0,
        `${vendor} one-shot`
      ).toBe(!interactive);
    }
  );

  it("`kind:\"session\"` still runs cursor one-shot — the second, name-derived net", () => {
    // `session` forces `interactive`, but the managed-session launch is ALSO
    // guarded by `vendor !== "cursor"`. Pinned because it is a second
    // name-derived branch on the same decision, and losing it would hand a
    // session driver to a lane that has none.
    coreMocks.runLaneTask.mockReset();
    coreMocks.runLaneTask.mockResolvedValue({ exitCode: 0, output: "done" });
    const client = {
      ...laneClient("claude-code"),
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "cursor" }]),
    } as unknown as MuonApiClient;

    return executeJob(
      client,
      {
        id: "job-session-cursor",
        kind: "session",
        vendor: "cursor",
        taskId: "task-auto",
        brief: "review the parser change",
        workspacePath: WORKSPACE,
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "human",
      },
      { id: "agent-1", name: "cursor-1" },
      { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
    ).then(() => {
      expect(coreMocks.startManagedSession).not.toHaveBeenCalled();
      expect(coreMocks.runLaneTask).toHaveBeenCalled();
    });
  });
});
