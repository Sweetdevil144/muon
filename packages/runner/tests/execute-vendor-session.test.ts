import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyHarnessConfig, type MuonApiClient } from "@muon/client";
import { memoryDirectoryDigestPayload } from "@muon/protocol";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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
vi.mock("../src/preflight-coverage.js", () => ({
  verifyEditPreflightCoverage: vi.fn(async () => ({
    ok: true,
    changedFiles: [],
    coveredFiles: [],
    uncoveredFiles: [],
  })),
}));

import { executeJob } from "../src/execute.js";

const exec = promisify(execFile);
const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function governedSnapshot() {
  const files = [
    {
      path: "README.md" as const,
      content: "governed",
      mode: "0444" as const,
      sha256: hash("governed"),
    },
    {
      path: "index.tsv" as const,
      content: "id\n",
      mode: "0444" as const,
      sha256: hash("id\n"),
    },
    {
      path: "notes/mem-12345678-1234-4123-8123-123456789abc.txt",
      content: "human-confirmed fact",
      mode: "0444" as const,
      sha256: hash("human-confirmed fact"),
    },
  ];
  return {
    schemaVersion: 1 as const,
    source: "human_confirmed_gate" as const,
    noteCount: 1,
    truncated: false,
    files,
    digest: hash(memoryDirectoryDigestPayload(files)),
  };
}

function client() {
  const recordJobVendorSessionForLease = vi.fn(async () => ({
    vendorSessionId: "recorded",
  }));
  return {
    api: {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getHarness: vi.fn(async () => ({ config: emptyHarnessConfig })),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      searchMemory: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      recordEvent: vi.fn(async () => undefined),
      addMemoryNoteWithAction: vi.fn(async () => ({ action: "inserted" })),
      updateAgent: vi.fn(async () => undefined),
      getDispatchJob: vi.fn(async () => null),
      publishJobTerminalForLease: vi.fn(async () => ({
        accepted: 1,
        lastSeq: 1,
      })),
      recordDispatchExecutionPathForLease: vi.fn(async () => ({
        executionPath: "/tmp",
      })),
      recordJobVendorSessionForLease,
      drainDispatchSteer: vi.fn(async () => []),
    } as unknown as MuonApiClient,
    recordJobVendorSessionForLease,
  };
}

function job() {
  return {
    id: "job-vendor-session",
    kind: "oneshot",
    vendor: "codex",
    taskId: "task-vendor-session",
    brief: "Do the bounded task",
    status: "running",
    interruptRequested: false,
    steerMessages: [],
    dispatchedBy: "orchestrator",
  };
}

const SESSION_ID = "019fa043-e5c2-7731-b2f3-11312f91d2d2";

beforeEach(() => {
  coreMocks.runLaneTask.mockReset();
  coreMocks.runLoop.mockReset();
  coreMocks.startManagedSession.mockReset();
  coreMocks.startManagedSession.mockRejectedValue(
    new Error("interactive vendor launch must not be reached")
  );
});

describe("executeJob one-shot — real terminal + vendor-session backlink", () => {
  it("delivers the governed directory into a real worker brief and cwd", async () => {
    const { api } = client();
    const cwd = await mkdtemp(path.join(tmpdir(), "muon-execute-memory-"));
    const snapshot = governedSnapshot();
    (api as unknown as Record<string, unknown>).getMemoryDirectorySnapshot = vi.fn(
      async () => snapshot
    );
    let deliveredBrief = "";
    coreMocks.runLaneTask.mockImplementation(
      async (input: { brief: string }) => {
        deliveredBrief = input.brief;
        return { exitCode: 0, output: "done", errorOutput: "", durationMs: 2 };
      }
    );

    try {
      const result = await executeJob(
        api,
        { ...job(), workspacePath: cwd },
        { id: "agent-1", name: "codex-1" },
        {
          apiBase: "http://127.0.0.1:4000",
          jobClient: api,
        }
      );
      expect(result.status).toBe("done");
      const directory = (await readdir(path.join(cwd, ".muon/memory"))).find(
        (entry) => !entry.startsWith(".")
      );
      expect(directory).toBeTruthy();
      const relative = `.muon/memory/${directory}`;
      expect(deliveredBrief).toContain(`Governed memory directory: ${relative}.`);
      const note = path.join(cwd, relative, snapshot.files[2]!.path);
      expect(await readFile(note, "utf8")).toBe("human-confirmed fact");
      expect((await lstat(note)).mode & 0o777).toBe(0o444);
      expect(deliveredBrief).toContain(
        "Edits to that directory are ignored and never update MUON memory."
      );
    } finally {
      await exec("chmod", ["-R", "u+w", cwd]).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the pre-directory brief and runs when snapshot integrity fails", async () => {
    const { api } = client();
    const cwd = await mkdtemp(path.join(tmpdir(), "muon-execute-memory-"));
    const snapshot = governedSnapshot();
    snapshot.files[2]!.content = "forged bytes";
    (api as unknown as Record<string, unknown>).getMemoryDirectorySnapshot = vi.fn(
      async () => snapshot
    );
    let deliveredBrief = "";
    coreMocks.runLaneTask.mockImplementation(
      async (input: { brief: string }) => {
        deliveredBrief = input.brief;
        return { exitCode: 0, output: "done", errorOutput: "", durationMs: 2 };
      }
    );

    try {
      const result = await executeJob(
        api,
        { ...job(), workspacePath: cwd },
        { id: "agent-1", name: "codex-1" },
        { apiBase: "http://127.0.0.1:4000", jobClient: api }
      );
      expect(result.status).toBe("done");
      expect(deliveredBrief).toContain("Do the bounded task");
      expect(deliveredBrief).not.toContain("Governed memory directory:");
    } finally {
      await exec("chmod", ["-R", "u+w", cwd]).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("forwards the injected pty factory and stamps the vendor session once", async () => {
    const { api, recordJobVendorSessionForLease } = client();
    const ptySpawn = vi.fn();
    let sawPty: unknown;
    coreMocks.runLaneTask.mockImplementation(
      async (input: {
        pty?: { spawn: unknown };
        onVendorSessionId?: (id: string) => void;
      }) => {
        sawPty = input.pty;
        // First knowledge fires mid-run; a duplicate report must not re-post.
        input.onVendorSessionId?.(SESSION_ID);
        input.onVendorSessionId?.(SESSION_ID);
        return { exitCode: 0, output: "done", errorOutput: "", durationMs: 2 };
      }
    );

    const result = await executeJob(
      api,
      job(),
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        runnerLease: { host: "runner-host", leaseToken: "lease-token" },
        ptySpawn,
      }
    );

    expect(result.status).toBe("done");
    expect(sawPty).toEqual({ spawn: ptySpawn });
    expect(recordJobVendorSessionForLease).toHaveBeenCalledTimes(1);
    expect(recordJobVendorSessionForLease).toHaveBeenCalledWith({
      jobId: "job-vendor-session",
      vendorSessionId: SESSION_ID,
      host: "runner-host",
      leaseToken: "lease-token",
    });
  });

  it("keeps pipes when no pty factory is injected", async () => {
    const { api } = client();
    let sawPty: unknown = "unset";
    coreMocks.runLaneTask.mockImplementation(
      async (input: { pty?: unknown }) => {
        sawPty = input.pty;
        return { exitCode: 0, output: "done", errorOutput: "", durationMs: 2 };
      }
    );

    await executeJob(api, job(), { id: "agent-1", name: "codex-1" }, {
      apiBase: "http://127.0.0.1:4000",
      runnerLease: { host: "runner-host", leaseToken: "lease-token" },
    });

    expect(sawPty).toBeUndefined();
  });

  it("keeps pipes for a resolved vendor action's argv override", async () => {
    // An action subcommand's stdout is a machine contract (`--json`); the pty
    // transport must never re-parent it.
    const { api } = client();
    let sawPty: unknown = "unset";
    coreMocks.runLaneTask.mockImplementation(
      async (input: { pty?: unknown }) => {
        sawPty = input.pty;
        return { exitCode: 0, output: "done", errorOutput: "", durationMs: 2 };
      }
    );

    await executeJob(
      api,
      {
        ...job(),
        actionArgvOverride: { args: ["ultrareview", "target", "--json"] },
      },
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        runnerLease: { host: "runner-host", leaseToken: "lease-token" },
        ptySpawn: vi.fn(),
      }
    );

    expect(sawPty).toBeUndefined();
  });

  it("F9: never posts an id the brain would refuse (no wasted latch)", async () => {
    // The backlink route validates the vendors' uuid shape. Posting anything
    // else 400s, and because the latch used to be set BEFORE the POST
    // resolved, that one bad id cost the job its resume handle for good.
    const { api, recordJobVendorSessionForLease } = client();
    coreMocks.runLaneTask.mockImplementation(
      async (input: { onVendorSessionId?: (id: string) => void }) => {
        input.onVendorSessionId?.("not-a-uuid");
        input.onVendorSessionId?.("");
        // …and then a real one, which must still land.
        input.onVendorSessionId?.(SESSION_ID);
        return { exitCode: 0, output: "done", errorOutput: "", durationMs: 2 };
      }
    );

    await executeJob(api, job(), { id: "agent-1", name: "codex-1" }, {
      apiBase: "http://127.0.0.1:4000",
      runnerLease: { host: "runner-host", leaseToken: "lease-token" },
    });

    expect(recordJobVendorSessionForLease).toHaveBeenCalledTimes(1);
    expect(recordJobVendorSessionForLease).toHaveBeenCalledWith(
      expect.objectContaining({ vendorSessionId: SESSION_ID })
    );
  });

  it("F9: a failed stamp is retried, bounded, instead of being lost forever", async () => {
    const { api, recordJobVendorSessionForLease } = client();
    recordJobVendorSessionForLease
      .mockRejectedValueOnce(new Error("brain unreachable"))
      .mockResolvedValue({ vendorSessionId: SESSION_ID });

    coreMocks.runLaneTask.mockImplementation(
      async (input: { onVendorSessionId?: (id: string) => void }) => {
        input.onVendorSessionId?.(SESSION_ID);
        await new Promise((resolve) => setTimeout(resolve, 5));
        // A later report (the poll loop's re-assert) must find the latch OPEN
        // because the first attempt failed.
        input.onVendorSessionId?.(SESSION_ID);
        return { exitCode: 0, output: "done", errorOutput: "", durationMs: 2 };
      }
    );

    await executeJob(api, job(), { id: "agent-1", name: "codex-1" }, {
      apiBase: "http://127.0.0.1:4000",
      runnerLease: { host: "runner-host", leaseToken: "lease-token" },
    });

    expect(recordJobVendorSessionForLease).toHaveBeenCalledTimes(2);
  });

  it("F9: retries are capped, so a permanently failing brain cannot spin", async () => {
    const { api, recordJobVendorSessionForLease } = client();
    recordJobVendorSessionForLease.mockRejectedValue(new Error("down"));

    coreMocks.runLaneTask.mockImplementation(
      async (input: { onVendorSessionId?: (id: string) => void }) => {
        for (let attempt = 0; attempt < 25; attempt += 1) {
          input.onVendorSessionId?.(SESSION_ID);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        return { exitCode: 0, output: "done", errorOutput: "", durationMs: 2 };
      }
    );

    await executeJob(api, job(), { id: "agent-1", name: "codex-1" }, {
      apiBase: "http://127.0.0.1:4000",
      runnerLease: { host: "runner-host", leaseToken: "lease-token" },
    });

    expect(recordJobVendorSessionForLease.mock.calls.length).toBeLessThanOrEqual(
      3
    );
    expect(recordJobVendorSessionForLease.mock.calls.length).toBeGreaterThan(0);
  });

  it("last session wins: a NEW id re-stamps, a re-report of the same id does not", async () => {
    // A loop's later iteration opens a fresh vendor session; the transcript
    // the human's resume button reopens must be the FINAL one. The poll loop
    // re-asserts the current id every tick, so a same-id re-report must stay
    // a no-op while a different valid id posts again.
    const { api, recordJobVendorSessionForLease } = client();
    const SECOND_ID = "119fa043-e5c2-7731-b2f3-11312f91d2d3";
    coreMocks.runLaneTask.mockImplementation(
      async (input: { onVendorSessionId?: (id: string) => void }) => {
        input.onVendorSessionId?.(SESSION_ID);
        await new Promise((resolve) => setTimeout(resolve, 5));
        input.onVendorSessionId?.(SESSION_ID); // poll-tick re-assert: no-op
        input.onVendorSessionId?.(SECOND_ID); // new session: re-stamp
        await new Promise((resolve) => setTimeout(resolve, 5));
        input.onVendorSessionId?.(SECOND_ID); // re-assert of the new id: no-op
        return { exitCode: 0, output: "done", errorOutput: "", durationMs: 2 };
      }
    );

    await executeJob(api, job(), { id: "agent-1", name: "codex-1" }, {
      apiBase: "http://127.0.0.1:4000",
      runnerLease: { host: "runner-host", leaseToken: "lease-token" },
    });

    expect(recordJobVendorSessionForLease).toHaveBeenCalledTimes(2);
    expect(recordJobVendorSessionForLease).toHaveBeenLastCalledWith(
      expect.objectContaining({ vendorSessionId: SECOND_ID })
    );
  });

  it("never stamps without a runner lease (no lease, no write path)", async () => {
    const { api, recordJobVendorSessionForLease } = client();
    coreMocks.runLaneTask.mockImplementation(
      async (input: { onVendorSessionId?: (id: string) => void }) => {
        input.onVendorSessionId?.(SESSION_ID);
        return { exitCode: 0, output: "done", errorOutput: "", durationMs: 2 };
      }
    );

    await executeJob(api, job(), { id: "agent-1", name: "codex-1" }, {
      apiBase: "http://127.0.0.1:4000",
    });

    expect(recordJobVendorSessionForLease).not.toHaveBeenCalled();
  });
});

describe("VENDOR SPEND REACHES THE LEDGER, not only the transcript", () => {
  /**
   * THE COST CAP WAS DECORATIVE IN PRODUCTION, and every one of its unit tests
   * passed — because those tests build `Event` rows directly.
   *
   * The adapters report real dollars in `metadata.usage` on the lane-event
   * stream. The runner routed that stream to `streams.handle`, which writes
   * StreamChunks. `mission-cost.ts` reads EVENT rows. So
   * `laneCostsFromUsageEvents` saw nothing, every lane read
   * `reported: false`, `evaluateCap` was permanently `unenforceable`, and
   * `capRefusesDispatch` never refused a dispatch — for any spend at all.
   *
   * This asserts the wiring the cap depends on, at the seam where it was cut.
   */
  it("records a usage-bearing lane event as a ledger event", async () => {
    const { api } = client();
    coreMocks.runLaneTask.mockImplementation(
      async (input: { onEvent?: (event: unknown) => void }) => {
        input.onEvent?.({
          laneId: "codex",
          taskId: "task-vendor-session",
          kind: "task.completed",
          message: "Codex session completed",
          metadata: { usage: { vendor: "codex", costUsd: 1.25 } },
        });
        return { exitCode: 0, output: "done", errorOutput: "", durationMs: 2 };
      }
    );

    await executeJob(
      api,
      job(),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000", jobClient: api }
    ).catch(() => undefined);

    const usageWrites = api.recordEvent.mock.calls.filter(
      ([event]: [{ metadata?: Record<string, unknown> }]) =>
        event?.metadata?.usage !== undefined
    );
    expect(
      usageWrites.length,
      "vendor usage must be written where the cap can read it"
    ).toBeGreaterThan(0);
    expect(usageWrites[0]![0].metadata.usage).toMatchObject({
      vendor: "codex",
      costUsd: 1.25,
    });
  });

  it("does NOT write an event for a lane event carrying no usage", async () => {
    const { api } = client();
    coreMocks.runLaneTask.mockImplementation(
      async (input: { onEvent?: (event: unknown) => void }) => {
        input.onEvent?.({
          laneId: "codex",
          taskId: "task-vendor-session",
          kind: "task.progress",
          message: "thinking",
          metadata: {},
        });
        return { exitCode: 0, output: "done", errorOutput: "", durationMs: 2 };
      }
    );

    await executeJob(
      api,
      job(),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000", jobClient: api }
    ).catch(() => undefined);

    const usageWrites = api.recordEvent.mock.calls.filter(
      ([event]: [{ metadata?: Record<string, unknown> }]) =>
        event?.metadata?.usage !== undefined
    );
    expect(usageWrites.length, "no phantom spend").toBe(0);
  });
});
