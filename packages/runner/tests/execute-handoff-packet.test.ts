import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HANDOFF_DEGRADATION,
  HANDOFF_FINAL_MESSAGE_CHARS,
} from "@muon/protocol";
import type { MuonApiClient } from "@muon/client";

const coreMocks = vi.hoisted(() => ({
  startManagedSession: vi.fn(),
  runLaneTask: vi.fn(),
  runLoop: vi.fn(),
}));
const preflightMocks = vi.hoisted(() => ({
  verifyEditPreflightCoverage: vi.fn(),
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
vi.mock("../src/preflight-coverage.js", () => ({
  verifyEditPreflightCoverage: preflightMocks.verifyEditPreflightCoverage,
}));

import { executeJob } from "../src/execute.js";

/**
 * P0-2. `done` has to mean something.
 *
 * In the founder's mission both docs jobs committed `status: done,
 * exitCode: 0` and `handoff_read` came back empty for both. One had edited the
 * README and one had not, and nothing in the ledger told them apart, so the
 * coordinator could not confirm any of its own crew's work.
 *
 * The cause was not a parse failure: `mode: auto` opens a SESSION for
 * claude-code and codex, and the session branch returned no `packet` field at
 * all — `parseWorkerFinalReport` was never reached. These tests pin both halves:
 * a session terminal now emits a typed packet, and a packet built from a run
 * that produced no typed final report SAYS SO rather than looking identical to
 * one that did.
 */

/** The exact ten-label suffix `WORKER_PREAMBLE` asks a worker to end with. */
const TYPED_FINAL_REPORT = [
  "GOAL: add a --version flag to the CLI",
  "CHANGED: src/cli.ts now registers --version",
  "FAILED: nothing",
  "COMMANDS RUN: npm test",
  "CHECKS: npm test passed",
  "CHANGED FILES: src/cli.ts",
  "OPEN QUESTIONS: should --version print the build sha too?",
  "UNCERTAINTIES: none",
  "NEXT ACTION: land the change",
  "MEMORY PROPOSALS:",
  "- [decision] the version string is read from package.json at build time",
].join("\n");

function makeClient(): MuonApiClient {
  return {
    listLanes: vi.fn(async () => [{ id: "lane-1", key: "claude-code" }]),
    getTaskDetail: vi.fn(async () => undefined),
    getLaneProfile: vi.fn(async () => ({ profile: undefined })),
    recallRelatedToTask: vi.fn(async () => []),
    markMemoryUsed: vi.fn(async () => undefined),
    updateAgent: vi.fn(async () => ({})),
    recordEvent: vi.fn(async () => undefined),
    requestApproval: vi.fn(async () => ({ id: "a-1", status: "pending" })),
    consumeCommandApproval: vi.fn(async () => undefined),
  } as unknown as MuonApiClient;
}

function sessionJob() {
  return {
    id: "job-1",
    kind: "session" as const,
    vendor: "claude-code",
    taskId: "task-1",
    brief: "Add a --version flag to the CLI and update the README",
    status: "running",
    interruptRequested: false,
    steerMessages: [],
    dispatchedBy: "orchestrator",
  };
}

async function runSessionWithOutput(output: string) {
  coreMocks.startManagedSession.mockResolvedValue({
    sessionId: "session-1",
    handle: {
      send: async () => undefined,
      interrupt: vi.fn(async () => undefined),
      wait: async () => ({ exitCode: 0, output }),
    },
  });
  return executeJob(
    makeClient(),
    sessionJob() as never,
    { id: "agent-1", name: "claude-code-1" } as never,
    { apiBase: "http://127.0.0.1:4000" }
  );
}

describe("session terminals emit a typed handoff packet", () => {
  beforeEach(() => {
    coreMocks.startManagedSession.mockReset();
    preflightMocks.verifyEditPreflightCoverage.mockReset();
    preflightMocks.verifyEditPreflightCoverage.mockResolvedValue({ ok: true });
  });

  it("returns a packet when the worker delivered a typed final report", async () => {
    const result = await runSessionWithOutput(
      `I added the flag and updated the docs.\n\n${TYPED_FINAL_REPORT}`
    );

    expect(result.status).toBe("done");
    // The regression itself: this field was absent on every session terminal.
    expect(result.packet).toBeDefined();
    expect(result.packet!.taskGoal).toContain("--version");
    // The worker's own coordination fields survived into the packet.
    expect(result.packet!.openQuestions.join(" ")).toContain("build sha");
    expect(result.packet!.recommendedNextAction).toContain("land the change");
    expect(result.packet!.memoryProposals[0]!.kind).toBe("decision");
    // And it is NOT flagged as missing a worker report.
    expect(result.packet!.degraded.reasons).not.toContain(
      HANDOFF_DEGRADATION.noWorkerReport
    );
  });

  it("still returns a packet when the worker reported nothing, and names the absence", async () => {
    const result = await runSessionWithOutput(
      "Sure! I had a look at the repo. Let me know if you want me to continue."
    );

    // Same terminal status as the run above — which is exactly why the packet
    // has to carry the difference.
    expect(result.status).toBe("done");
    expect(result.packet).toBeDefined();
    expect(result.packet!.degraded.flag).toBe(true);
    expect(result.packet!.degraded.reasons).toContain(
      HANDOFF_DEGRADATION.noWorkerReport
    );
  });

  it("makes 'worked, no evidence' distinguishable from 'worked, here is the evidence'", async () => {
    // The founder's two docs jobs, side by side. Before this change both
    // produced `done, exitCode 0` and an empty handoff_read; the ONLY thing a
    // coordinator can reconcile on is that these two now differ.
    const withEvidence = await runSessionWithOutput(
      `done\n\n${TYPED_FINAL_REPORT}`
    );
    const withoutEvidence = await runSessionWithOutput("done");

    expect(withEvidence.status).toBe(withoutEvidence.status);
    expect(withEvidence.packet!.degraded.reasons).not.toContain(
      HANDOFF_DEGRADATION.noWorkerReport
    );
    expect(withoutEvidence.packet!.degraded.reasons).toContain(
      HANDOFF_DEGRADATION.noWorkerReport
    );
  });

  /**
   * A SECOND DURABLE COPY of the worker's own words.
   *
   * In the founder's mission the codex child's final report existed in exactly
   * one place — a stream chunk cut at 4 000 characters — and its `result` column
   * held the loop verdict ("loop passed in 1 iteration(s)…", 58 characters)
   * rather than any of the output. The tail was unrecoverable. The packet now
   * carries the closing message itself, so "bounded" can never again mean
   * "lost".
   */
  it("carries the worker's closing message on the packet, report or no report", async () => {
    const reported = await runSessionWithOutput(
      `I added the flag.\n\n${TYPED_FINAL_REPORT}`
    );
    const unreported = await runSessionWithOutput(
      "Sure! I had a look at the repo, and here is a wall of prose about it."
    );

    expect(reported.packet!.finalMessage).toContain(
      "MEMORY PROPOSALS"
    );
    // Unparseable prose is PRESERVED, not discarded: a reader can see WHY
    // nothing parsed instead of being told only that nothing did.
    expect(unreported.packet!.finalMessage).toContain("wall of prose");
    expect(unreported.packet!.degraded.reasons).toContain(
      HANDOFF_DEGRADATION.noWorkerReport
    );
  });

  it("bounds the closing message and never lets a credential ride it", async () => {
    const huge = `${"w".repeat(50_000)}\nAWS_SECRET_ACCESS_KEY=SECRET_TAIL_VALUE\ndone`;

    const result = await runSessionWithOutput(huge);

    expect(result.packet!.finalMessage!.length).toBeLessThanOrEqual(
      HANDOFF_FINAL_MESSAGE_CHARS + 1
    );
    // Tail-kept: the END of a report is the part that carries its verdict.
    expect(result.packet!.finalMessage!.endsWith("done")).toBe(true);
    expect(JSON.stringify(result.packet)).not.toContain("SECRET_TAIL_VALUE");
  });

  it("emits no packet for an interrupted session, and never fabricates one", async () => {
    const controller = new AbortController();
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "session-1",
      handle: {
        send: async () => undefined,
        interrupt: vi.fn(async () => undefined),
        wait: async () => {
          controller.abort();
          return { exitCode: 0, output: TYPED_FINAL_REPORT };
        },
      },
    });

    const result = await executeJob(
      makeClient(),
      sessionJob() as never,
      { id: "agent-1", name: "claude-code-1" } as never,
      { apiBase: "http://127.0.0.1:4000", signal: controller.signal }
    );

    expect(result.status).toBe("interrupted");
    // An interrupted run has no completed thought to report; absence here is
    // the honest answer, not a gap.
    expect(result.packet).toBeUndefined();
  });
});
