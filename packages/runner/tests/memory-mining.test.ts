import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MuonApiHttpError, type MuonApiClient } from "@muon/client";
import type { LaneEvent } from "@muon/protocol";

// ── R4: the self-filling brain actually fills ────────────────────────────────
//
// The regression these lock down is a REAL founder session that produced an
// empty brain. `extractMemoriesViaLane` was wired into all three execution
// paths and hardened, but it sat behind `MUON_MEMORY_MINE === "1"` and so never
// ran; only three deterministic signals could ever land, and that session
// produced none of them. Mining is now a governed DEFAULT-ON setting, its
// failures are observable, and the path the founder actually used — a desktop
// chat whose ROOT COORDINATOR dispatches subagents — is proven here rather than
// read.
//
// Every job below is a `session` job, so the ONLY runLaneTask call in the run is
// the extractor's: asserting on that mock is asserting on mining itself.

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

import { executeJob, runPendingCapture } from "../src/execute.js";

/** Long enough to clear the >40-char floor that bounds mining cost. */
const CHAT_OUTPUT =
  "Dispatched the backend specialist. It replaced the additive scorer with RRF in packages/graph/src/memory-ranking.ts and recall improved.";

const MINED_REPLY = {
  exitCode: 0,
  output:
    '{"notes": [{"kind": "decision", "text": "Rank fused memory with RRF instead of additive scoring", "topics": ["memory", "ranking"], "evidence": [1]}]}',
};

let evidenceRoot: string;
let evidenceFixtureRoot: string;
const EVIDENCE_MODULE = "packages/graph/src/memory-ranking.ts";

beforeAll(() => {
  evidenceFixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "muon-tool-memory-")
  );
  const sourceRoot = path.join(evidenceFixtureRoot, "source");
  evidenceRoot = path.join(evidenceFixtureRoot, "worktree");
  fs.mkdirSync(sourceRoot, { recursive: true });
  const target = path.join(sourceRoot, EVIDENCE_MODULE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "export const ranker = 'additive';\n", "utf8");
  execFileSync("git", ["init"], { cwd: sourceRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tests@muon.local"], {
    cwd: sourceRoot,
  });
  execFileSync("git", ["config", "user.name", "MUON Tests"], {
    cwd: sourceRoot,
  });
  execFileSync("git", ["add", EVIDENCE_MODULE], { cwd: sourceRoot });
  execFileSync("git", ["commit", "-m", "fixture"], {
    cwd: sourceRoot,
    stdio: "ignore",
  });
  execFileSync("git", ["worktree", "add", "-b", "memory-test", evidenceRoot], {
    cwd: sourceRoot,
    stdio: "ignore",
  });
  fs.writeFileSync(
    path.join(evidenceRoot, EVIDENCE_MODULE),
    "export const ranker = 'rrf';\n",
    "utf8"
  );
});

afterAll(() => {
  fs.rmSync(evidenceFixtureRoot, { recursive: true, force: true });
});

function mutationEvent(
  phase: "started" | "completed",
  content: string
): LaneEvent {
  return {
    id: `tool-${phase}`,
    laneId: "lane-1",
    taskId: "task-chat",
    kind: "task.progress",
    message: `Edit ${phase}`,
    timestamp: "2026-08-01T00:00:00.000Z",
    metadata: {
      controlPlane: true,
      toolActivity: {
        provider: "claude-code",
        phase,
        itemId: "edit-1",
        tool: "Edit",
        ...(phase === "started"
          ? {
              fileMutation: true,
              paths: [EVIDENCE_MODULE],
              detail: {
                args: `file_path: ${EVIDENCE_MODULE}\nnew_string: ${content}`,
              },
            }
          : { detail: { result: "updated" } }),
      },
    },
  };
}

function mockSessionOutput(
  output: string,
  options: {
    sessionId?: string;
    vendorSessionId?: string;
    emitMutation?: boolean;
  } = {}
) {
  coreMocks.startManagedSession.mockImplementation(async (_ledger, input) => {
    if (options.emitMutation !== false) {
      input.onEvent(mutationEvent("started", output));
      input.onEvent(mutationEvent("completed", output));
    }
    return {
      sessionId: options.sessionId ?? "session-1",
      handle: {
        vendorSessionId: options.vendorSessionId ?? "claude-session-42",
        send: async () => undefined,
        interrupt: async () => undefined,
        wait: async () => ({ exitCode: 0, output }),
      },
    };
  });
}

function rootCoordinatorJob(overrides: Record<string, unknown> = {}) {
  const workspace = process.cwd();
  const deadlineAt = new Date(Date.now() + 600_000).toISOString();
  // The delegation manifest is BOUND to the job id, so an override has to reach
  // both or the run refuses to launch before it ever gets near memory.
  const id = (overrides.id as string | undefined) ?? "job-chat";
  return {
    id,
    kind: "session",
    vendor: "claude-code",
    taskId: "task-chat",
    chatId: "chat-mine",
    brief: "swap the memory ranker for RRF",
    workspacePath: workspace,
    // The desktop chat's root coordinator: orchestrator capability, a chatId,
    // and NO parentJobId — exactly what `isRootCoordinator` requires.
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

type FakeNote = {
  id: string;
  kind: string;
  text: string;
  confirmed: boolean;
  stale: boolean;
  createdBy?: string;
};

type FakeClientOptions = {
  memoryMining?: boolean | Error;
  notes?: FakeNote[];
};

function fakeClient(options: FakeClientOptions = {}) {
  const addMemoryNoteWithAction = vi.fn(async () => ({ action: "inserted" }));
  const recordEvent = vi.fn(async () => undefined);
  // Mutable so a test can flip the operator's posture BETWEEN jobs of one chat,
  // which is the whole point of the F6 off→on regression below.
  let memoryMining: boolean | Error = options.memoryMining ?? true;
  const getMemoryMining = vi.fn(async () => {
    if (memoryMining instanceof Error) throw memoryMining;
    return memoryMining;
  });
  const client = {
    listLanes: vi.fn(async () => [
      { id: "lane-1", key: "claude-code" },
      { id: "lane-2", key: "codex" },
    ]),
    getTaskDetail: vi.fn(async () => undefined),
    getLaneProfile: vi.fn(async () => ({ profile: undefined })),
    recallRelatedToTask: vi.fn(async () => options.notes ?? []),
    markMemoryUsed: vi.fn(async () => undefined),
    updateAgent: vi.fn(async () => ({})),
    drainDispatchSteer: vi.fn(async () => []),
    getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
    recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
    updateChat: vi.fn(async () => ({})),
    recordEvent,
    addMemoryNoteWithAction,
    getMemoryMining,
  };
  return {
    client: client as unknown as MuonApiClient,
    addMemoryNoteWithAction,
    recordEvent,
    getMemoryMining,
    markMemoryUsed: client.markMemoryUsed,
    setMemoryMining: (next: boolean | Error) => {
      memoryMining = next;
    },
  };
}

/**
 * B2: mining now runs AFTER the terminal write, so its note writes go through
 * the lease-fenced capture route instead of the (by then dead) per-job
 * capability. This mirrors the runner's `leaseMemorySink` PLUS the route's
 * server-side partition derivation (`chatId` comes from the stored job row), so
 * every assertion below still measures the note that actually lands.
 */
function captureSink(client: MuonApiClient, chatId: string | undefined) {
  return {
    addMemoryNoteWithAction: (candidate: Parameters<
      MuonApiClient["addMemoryNoteWithAction"]
    >[0]) => client.addMemoryNoteWithAction({ ...candidate, chatId }),
  };
}

async function runChat(
  client: MuonApiClient,
  overrides: Record<string, unknown> = {},
  logs: string[] = []
) {
  const job = rootCoordinatorJob(overrides);
  const result = await executeJob(
    client,
    job as never,
    { id: "agent-1", name: "claude-code-1" },
    {
      apiBase: "http://127.0.0.1:4000",
      delegationToken: "root-job-token",
      steerPollMs: 1,
      onLog: (line) => logs.push(line),
    }
  );
  // B2: the runner does this after committing the terminal (and after the fleet
  // seat is released); these tests drive the SAME entry point so they keep
  // proving that mining still happens, just no longer on the critical path.
  if (result.capture) {
    // Real git + real changed-file discovery. The session is intentionally a
    // primary-checkout job in this focused test; supplying the disposable repo
    // here exercises the deferred capture's governed-worktree proof without
    // letting a test create nested MUON worktrees in the source checkout.
    result.capture.worktreeCwd = evidenceRoot;
    await runPendingCapture(client, result.capture, {
      sink: captureSink(client, job.chatId as string | undefined),
      onLog: (line) => logs.push(line),
    });
  }
  return result;
}

beforeEach(() => {
  delete process.env.MUON_MEMORY_MINE;
  coreMocks.startManagedSession.mockReset();
  mockSessionOutput(CHAT_OUTPUT);
  coreMocks.runLaneTask.mockReset();
  coreMocks.runLaneTask.mockResolvedValue(MINED_REPLY);
});

afterEach(() => {
  delete process.env.MUON_MEMORY_MINE;
});

describe("R4 mining is on by default", () => {
  it("the deferred session path mines structured edit evidence and lands the note in the chat partition", async () => {
    const { client, addMemoryNoteWithAction, getMemoryMining } = fakeClient();
    const result = await runChat(client, { chatId: "chat-default-on" });

    expect(result.status).toBe("done");
    // Proof of WHICH branch ran: only the isRootCoordinator session path binds
    // the vendor session to the chat, and capture is the very next statement.
    // So this really is the desktop-chat coordinator, not the one-shot path.
    expect(client.updateChat).toHaveBeenCalledWith({
      chatId: "chat-default-on",
      vendorSessionId: "claude-session-42",
      vendorSessionVendor: "claude-code",
      vendorSessionRootJobId: "job-chat",
    });
    // Nothing in the environment asked for mining — the operator setting did.
    expect(getMemoryMining).toHaveBeenCalledTimes(1);
    expect(coreMocks.runLaneTask).toHaveBeenCalledTimes(1);
    expect(addMemoryNoteWithAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "decision",
        text: "Rank fused memory with RRF instead of additive scoring",
        // #126: the note carries the chat partition, not a global write.
        chatId: "chat-default-on",
        // Provisional by construction: UNCONFIRMED, low trust, human-gated.
        trust: "low",
        createdBy: "muon-extractor",
      })
    );
  });

  it("keeps the extractor LOCKED DOWN: no tools, no MCP servers, read-only, time-boxed", async () => {
    const { client } = fakeClient();
    await runChat(client, { chatId: "chat-lockdown" });

    const [input] = coreMocks.runLaneTask.mock.calls[0]!;
    // It reads UNTRUSTED tool-call payload, so a prompt-injection payload must
    // have nothing to reach for. This is finding S3's fix — never widen it.
    expect(input.profile.allowedTools).toEqual([]);
    expect(input.profile.mcpServers).toEqual([]);
    expect(input.profile.sandbox).toBe("read-only");
    expect(input.profile.permissionMode).toBe("strict");
    // And it can never pin the job it runs after.
    expect(input.timeoutMs).toBe(120_000);
  });

  it("4.18: identical grounded tool evidence in one chat is mined once", async () => {
    const { client, addMemoryNoteWithAction } = fakeClient();
    await runChat(client, { chatId: "chat-dedup", id: "job-dedup-1" });
    await runChat(client, { chatId: "chat-dedup", id: "job-dedup-2" });

    expect(coreMocks.runLaneTask).toHaveBeenCalledTimes(1);
    expect(addMemoryNoteWithAction).toHaveBeenCalledTimes(1);
  });

  it("still mines when the operator setting cannot be read (this one does NOT fail closed)", async () => {
    const { client, addMemoryNoteWithAction } = fakeClient({
      memoryMining: new Error("brain unreachable"),
    });
    await runChat(client, { chatId: "chat-unreadable" });

    expect(coreMocks.runLaneTask).toHaveBeenCalledTimes(1);
    expect(addMemoryNoteWithAction).toHaveBeenCalledOnce();
  });

  it("F7: a control OUTAGE (5xx) keeps the permissive default — failing closed there recreates the empty brain", async () => {
    const { client, addMemoryNoteWithAction, recordEvent } = fakeClient({
      memoryMining: new MuonApiHttpError(
        503,
        "Service Unavailable",
        "503 Service Unavailable"
      ),
    });
    await runChat(client, { chatId: "chat-transient" });

    expect(coreMocks.runLaneTask).toHaveBeenCalledTimes(1);
    expect(addMemoryNoteWithAction).toHaveBeenCalledOnce();
    // A transient failure is not an authorization event and must not be filed
    // as one — the loud diagnostic is reserved for the standing condition.
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ stage: "mining-auth" }),
      })
    );
  });

  it("skips the lane when no completed Edit/Write call can be grounded", async () => {
    mockSessionOutput("ok", { emitMutation: false });
    const logs: string[] = [];
    const { client, getMemoryMining } = fakeClient();
    await runChat(client, { chatId: "chat-short" }, logs);

    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
    // The posture still governs CAPTURE (whether this turn may join the rolling
    // window), so it is resolved before the structured-evidence guard.
    expect(getMemoryMining).toHaveBeenCalledTimes(1);
    expect(logs).toContain(
      "memory mining skipped: no git-grounded Edit/Write tool calls"
    );
  });
});

describe("R4 mining off switches", () => {
  it("MUON_MEMORY_MINE=0 is a kill switch honoured WITHOUT asking the brain", async () => {
    process.env.MUON_MEMORY_MINE = "0";
    const logs: string[] = [];
    const { client, addMemoryNoteWithAction, getMemoryMining } = fakeClient();
    await runChat(client, { chatId: "chat-kill" }, logs);

    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
    // No lookup at all: the switch works even against an unreachable brain.
    expect(getMemoryMining).not.toHaveBeenCalled();
    expect(addMemoryNoteWithAction).not.toHaveBeenCalled();
    expect(logs).toContain(
      "memory mining skipped: MUON_MEMORY_MINE=0 kill switch"
    );
  });

  it("an operator who turned the setting OFF gets no lane call, and the log says which switch fired", async () => {
    const logs: string[] = [];
    const { client, addMemoryNoteWithAction } = fakeClient({ memoryMining: false });
    await runChat(client, { chatId: "chat-operator-off" }, logs);

    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
    expect(addMemoryNoteWithAction).not.toHaveBeenCalled();
    expect(logs).toContain("memory mining skipped: operator setting off");
  });

  it("MUON_MEMORY_MINE=1 still forces mining on even with the setting off", async () => {
    process.env.MUON_MEMORY_MINE = "1";
    const { client, getMemoryMining } = fakeClient({ memoryMining: false });
    await runChat(client, { chatId: "chat-force-on" });

    expect(getMemoryMining).not.toHaveBeenCalled();
    expect(coreMocks.runLaneTask).toHaveBeenCalledTimes(1);
  });

  // ── F7: an AUTH failure is not an outage ──────────────────────────────────
  //
  // `client.getMemoryMining()` throws on 401/403 exactly as readily as on a
  // transient blip, so a rotated or misconfigured shared agent token used to
  // make the runner mine on EVERY job forever while the operator's setting said
  // off — with `MUON_MEMORY_MINE=0` + a runner restart the only real override.
  it("F7: a REFUSED credential (401) fails CLOSED and files a loud diagnostic", async () => {
    const logs: string[] = [];
    const { client, addMemoryNoteWithAction, recordEvent } = fakeClient({
      memoryMining: new MuonApiHttpError(401, "Unauthorized", "401 Unauthorized"),
    });
    const result = await runChat(client, { chatId: "chat-401" }, logs);

    // Best-effort still means best-effort: the job itself is untouched.
    expect(result.status).toBe("done");
    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
    expect(addMemoryNoteWithAction).not.toHaveBeenCalled();
    expect(
      logs.some((line) =>
        line.includes("control refused this runner's credential")
      )
    ).toBe(true);
    // Loud, not just skipped: a standing credential fault has to reach the
    // event spine, or it persists unnoticed exactly like the old silent mining
    // failure did.
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "memory capture degraded (mining-auth)",
        metadata: expect.objectContaining({
          controlPlane: true,
          memoryCapture: "degraded",
          stage: "mining-auth",
        }),
      })
    );
  });

  it("F7: 403 fails closed for the same reason 401 does", async () => {
    const { client } = fakeClient({
      memoryMining: new MuonApiHttpError(403, "Forbidden", "403 Forbidden"),
    });
    await runChat(client, { chatId: "chat-403" });

    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
  });
});

// ── F6: the kill switch must stop CAPTURE, not only the model call ───────────
//
// Both rolling-window appends used to sit OUTSIDE the `if (mining.enabled)`
// branch, so with mining off a job's brief and the tail of its output were still
// recorded. Flipping the operator setting back on then shipped that content to a
// vendor model inside the NEXT job's extractor prompt. The comment claimed the
// switch was "honoured before it ever asks" — true of the current job, false of
// the current job's CONTENT.
describe("F6 nothing captured while mining is off may later leave the machine", () => {
  it("an OFF→ON flip cannot resurrect the off-period's brief or output", async () => {
    const { client, setMemoryMining } = fakeClient({ memoryMining: false });

    // Job 1 runs while the operator has mining OFF.
    await runChat(client, {
      chatId: "chat-offthenon",
      brief: "OFFPERIOD private objective",
    });
    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();

    // The operator flips it back on; job 2 is the first job allowed to mine.
    setMemoryMining(true);
    mockSessionOutput(
      "Second turn changed the ranker with structured edit evidence.",
      { sessionId: "session-2", vendorSessionId: "claude-session-43" }
    );
    await runChat(client, {
      chatId: "chat-offthenon",
      id: "job-chat-2",
      brief: "ONPERIOD objective",
    });

    expect(coreMocks.runLaneTask).toHaveBeenCalledTimes(1);
    const brief = coreMocks.runLaneTask.mock.calls[0]![0]!.brief as string;
    // The off-period turn is GONE — neither its ask nor its output tail.
    expect(brief).not.toContain("OFFPERIOD private objective");
    expect(brief).not.toContain("RRF in packages/graph/src/memory-ranking.ts");
    expect(brief).toContain("Human: ONPERIOD objective");
  });

  it("turning mining OFF also drops what the session had already buffered", async () => {
    const { client, setMemoryMining } = fakeClient();

    // Job 1 mines normally, so the window is warm.
    await runChat(client, {
      chatId: "chat-onthenoff",
      brief: "WARMED private objective",
    });
    expect(coreMocks.runLaneTask).toHaveBeenCalledTimes(1);

    // The operator turns it off; job 2 must not mine AND must clear the buffer.
    setMemoryMining(false);
    await runChat(client, {
      chatId: "chat-onthenoff",
      id: "job-chat-2",
      brief: "during the off period",
    });
    expect(coreMocks.runLaneTask).toHaveBeenCalledTimes(1);

    // Back on: the extractor starts from an empty window, not from text that
    // was staged for an errand the operator cancelled.
    setMemoryMining(true);
    await runChat(client, {
      chatId: "chat-onthenoff",
      id: "job-chat-3",
      brief: "after the off period",
    });
    const brief = coreMocks.runLaneTask.mock.calls[1]![0]!.brief as string;
    expect(brief).not.toContain("WARMED private objective");
    expect(brief).not.toContain("during the off period");
    expect(brief).toContain("Human: after the off period");
  });

  it("a chat that switches vendors never feeds vendor A's output into vendor B's prompt", async () => {
    const { client } = fakeClient();

    await runChat(client, {
      chatId: "chat-vendorswap",
      vendor: "claude-code",
      brief: "VENDOR-A private objective",
    });
    expect(coreMocks.runLaneTask).toHaveBeenCalledTimes(1);
    expect(coreMocks.runLaneTask.mock.calls[0]![0]!.laneKey).toBe("claude-code");

    // A distinct second call proves one vendor's transcript is not shared with
    // another; only MUON's grounded file summary may enter the rolling window.
    mockSessionOutput("Vendor B changed the CLI entrypoint.", {
      sessionId: "session-2",
      vendorSessionId: "codex-session-7",
    });
    await runChat(client, {
      chatId: "chat-vendorswap",
      id: "job-chat-2",
      vendor: "codex",
      brief: "vendor B objective",
    });

    const briefB = coreMocks.runLaneTask.mock.calls[1]![0]!.brief as string;
    expect(coreMocks.runLaneTask.mock.calls[1]![0]!.laneKey).toBe("codex");
    // The extractor runs ON the vendor lane, so a shared window would ship one
    // chat's content to a SECOND third party.
    expect(briefB).not.toContain("VENDOR-A private objective");
    expect(briefB).not.toContain("RRF in packages/graph/src/memory-ranking.ts");
    expect(briefB).toContain("Human: vendor B objective");
  });
});

describe("R4 extraction failure is observable", () => {
  it("files a diagnostic event AND a log line naming the reason, and never fails the job", async () => {
    // A vendor that is installed but logged out: exits non-zero, says nothing
    // parseable. This used to end in `.catch(() => [])` and vanish.
    coreMocks.runLaneTask.mockResolvedValue({ exitCode: 1, output: "not logged in" });
    const logs: string[] = [];
    const { client, recordEvent } = fakeClient();
    const result = await runChat(client, { chatId: "chat-fail" }, logs);

    // Best-effort still means best-effort: the job is untouched.
    expect(result.status).toBe("done");
    // …but the failure is now on the event spine, where debug:report reads it.
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        taskId: "task-chat",
        kind: "task.progress",
        message: "memory capture degraded (mine)",
        metadata: expect.objectContaining({
          controlPlane: true,
          memoryCapture: "degraded",
          stage: "mine",
          reason: expect.stringContaining("lane exit 1"),
        }),
      })
    );
    expect(
      logs.some((line) => line.startsWith("memory capture degraded (mine):"))
    ).toBe(true);
  });

  it("reports an ingest that silently dropped notes rather than tallying the loss and moving on", async () => {
    const { client, recordEvent } = fakeClient();
    (client as unknown as { addMemoryNoteWithAction: ReturnType<typeof vi.fn> })
      .addMemoryNoteWithAction.mockRejectedValue(new Error("write refused"));
    const result = await runChat(client, { chatId: "chat-ingest-fail" });

    expect(result.status).toBe("done");
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "memory capture degraded (ingest)",
        metadata: expect.objectContaining({ stage: "ingest" }),
      })
    );
  });

  it("survives a client with no recordEvent at all — a diagnostic can never take the job down", async () => {
    coreMocks.runLaneTask.mockResolvedValue({ exitCode: 0, output: "no json" });
    const { client } = fakeClient();
    delete (client as unknown as { recordEvent?: unknown }).recordEvent;

    await expect(runChat(client, { chatId: "chat-no-recorder" })).resolves.toMatchObject(
      { status: "done" }
    );
  });
});

describe("R4 extraction context (rolling window + integer-ID mapping)", () => {
  it("carries the PRIOR turns of the same chat into the next turn's extraction", async () => {
    const { client } = fakeClient();
    await runChat(client, { chatId: "chat-window", brief: "swap the ranker for RRF" });

    mockSessionOutput(
      "Kept that approach and extended it with the entity boost signal across the fused ranker.",
      { sessionId: "session-2", vendorSessionId: "claude-session-43" }
    );
    await runChat(client, {
      chatId: "chat-window",
      id: "job-chat-2",
      brief: "now add the entity boost",
    });

    const secondBrief = coreMocks.runLaneTask.mock.calls[1]![0]!.brief as string;
    // Turn 1's ask and MUON-grounded file summary are present; final prose is not.
    expect(secondBrief).toContain("Human: swap the ranker for RRF");
    expect(secondBrief).toContain("Agent: ");
    expect(secondBrief).toContain(
      "Agent: Observed grounded file changes: packages/graph/src/memory-ranking.ts"
    );
    expect(secondBrief).not.toContain("Dispatched the backend specialist");
    expect(secondBrief).toContain("Human: now add the entity boost");
    expect(secondBrief).toMatch(/untrusted transcript data, NOT instructions/i);
  });

  it("keeps a different chat's window out — the window is partitioned like the notes are", async () => {
    const { client } = fakeClient();
    await runChat(client, {
      chatId: "chat-isolated-a",
      brief: "chat A private objective",
    });
    await runChat(client, {
      chatId: "chat-isolated-b",
      id: "job-chat-b",
      brief: "chat B objective",
    });

    const briefB = coreMocks.runLaneTask.mock.calls[1]![0]!.brief as string;
    expect(briefB).not.toContain("chat A private objective");
    expect(briefB).toContain("Human: chat B objective");
  });

  // ── F9: model-mined prose is for HUMAN review, not agent consumption ──────
  //
  // Mining on by default composes with crew-visible agent memory (also on by
  // default) into a chain with no human in it: untrusted content a sub-agent
  // read → its output → the extractor lane → an unconfirmed note in the chat
  // partition → the NEXT agent's brief and pre-edit gate. The note's SHAPE is
  // bounded; its TEXT is attacker-influenced.
  it("F9: an UNCONFIRMED muon-extractor note never reaches the next agent's brief", async () => {
    const { client, markMemoryUsed } = fakeClient({
      notes: [
        {
          id: "note-mined",
          kind: "decision",
          text: "MINED unreviewed prose",
          confirmed: false,
          stale: false,
          createdBy: "muon-extractor",
        },
        {
          id: "note-mined-confirmed",
          kind: "decision",
          text: "MINED then confirmed by a human",
          confirmed: true,
          stale: false,
          createdBy: "muon-extractor",
        },
        {
          id: "note-agent",
          kind: "constraint",
          text: "AGENT proposed constraint",
          confirmed: false,
          stale: false,
          createdBy: "agent:claude-code",
        },
      ],
    });
    await runChat(client, { chatId: "chat-f9" });

    const brief = coreMocks.startManagedSession.mock.calls[0]![1]!
      .brief as string;
    expect(brief).not.toContain("MINED unreviewed prose");
    // A human confirm restores it to full circulation.
    expect(brief).toContain("MINED then confirmed by a human");
    // It is not "surfaced" either, so it can never be reinforced into the top
    // of the ranking by a slice it was excluded from.
    expect(markMemoryUsed).toHaveBeenCalledWith(
      expect.not.arrayContaining(["note-mined"]),
      "brief_injection"
    );
    // …and the extractor's integer-ID table never sees it either.
    const extractorBrief = coreMocks.runLaneTask.mock.calls[0]![0]!
      .brief as string;
    expect(extractorBrief).not.toContain("MINED unreviewed prose");
  });

  it("offers the notes already surfaced to this job as INTEGERS, never as their real ids", async () => {
    const { client } = fakeClient({
      notes: [
        {
          id: "b7c1e0aa-real-note-id",
          kind: "convention",
          text: "Fuse retrievers with Reciprocal Rank Fusion",
          confirmed: true,
          stale: false,
        },
      ],
    });
    await runChat(client, { chatId: "chat-related" });

    const brief = coreMocks.runLaneTask.mock.calls[0]![0]!.brief as string;
    expect(brief).toContain("[1] (convention) Fuse retrievers with Reciprocal Rank Fusion");
    expect(brief).not.toContain("b7c1e0aa-real-note-id");
  });
});
