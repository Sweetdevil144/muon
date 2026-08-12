import { describe, expect, it, vi } from "vitest";
import { ChatStopBlockedError } from "@muon/client";
import type {
  DispatchJobRecord,
  OrchestratorChatRecord,
} from "@muon/client";
import {
  archiveChatAfterStopping,
  cancelChat,
  type ChatLifecycleClient,
} from "../src/lib/chat-lifecycle.js";

// ── The chat's two lifecycle acts, against a ledger that behaves like the real
// backend ────────────────────────────────────────────────────────────────────
//
// The fake below models the ONE property that broke archiving in production:
// `POST /interrupt` terminalizes a QUEUED job synchronously, but for a RUNNING
// job it only records `interruptRequested` — the runner terminalizes it later,
// after the vendor actually drains, and never at all if no runner is live. Any
// flow that assumes "interrupt returned ⇒ the job is gone" archives into a
// precondition that is still false and gets a 409.

function job(
  id: string,
  status: DispatchJobRecord["status"],
  overrides: Partial<DispatchJobRecord> = {}
): DispatchJobRecord {
  return {
    id,
    kind: "task",
    vendor: "codex",
    taskId: "task-1",
    chatId: "chat-1",
    brief: "work",
    status,
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    createdAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  } as DispatchJobRecord;
}

function chat(): OrchestratorChatRecord {
  return {
    id: "chat-1",
    title: "Mission",
    workspacePath: "/repo",
    status: "archived",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:01.000Z",
  };
}

type LedgerOptions = {
  /** Called after each interrupt, e.g. to let a "runner" drain a job. */
  onInterrupt?: (jobId: string, ledger: Map<string, DispatchJobRecord>) => void;
  runnerLive?: boolean;
  archive?: () => Promise<OrchestratorChatRecord>;
};

function ledgerClient(jobs: DispatchJobRecord[], options: LedgerOptions = {}) {
  const ledger = new Map(jobs.map((entry) => [entry.id, { ...entry }]));
  const interruptDispatchJob = vi.fn(async (jobId: string) => {
    const entry = ledger.get(jobId);
    if (!entry) throw new Error(`404 Not Found, no job ${jobId}`);
    entry.interruptRequested = true;
    // Queued work dies with the request; running work only gets the request.
    if (entry.status === "queued") {
      entry.status = "interrupted";
    }
    options.onInterrupt?.(jobId, ledger);
  });
  const listDispatchJobs = vi.fn(
    async (filter?: { status?: string; chatId?: string }) => {
      const all = [...ledger.values()];
      return filter?.status
        ? all.filter((entry) => entry.status === filter.status)
        : all;
    }
  );
  const archiveChat = vi.fn(
    options.archive ??
      (async () => {
        // The real backend refuses while anything is queued/running.
        const active = [...ledger.values()].filter(
          (entry) => entry.status === "queued" || entry.status === "running"
        );
        if (active.length > 0) {
          throw new Error(
            "409 Conflict, Stop every queued or running chat job before archiving."
          );
        }
        return chat();
      })
  );
  const client = {
    listDispatchJobs,
    interruptDispatchJob,
    archiveChat,
    getRunner: vi.fn(async () => ({
      runner: null,
      live: options.runnerLive ?? true,
    })),
  } as unknown as ChatLifecycleClient;
  return { client, ledger, interruptDispatchJob, archiveChat };
}

const noWait = { settleMs: 0, pollMs: 1, sleep: async () => undefined };

describe("cancelChat", () => {
  it("stops every queued job the chat owns and leaves the chat alone", async () => {
    const { client, archiveChat, ledger } = ledgerClient([
      job("root", "queued"),
      job("child", "queued"),
      job("old", "done"),
    ]);

    const result = await cancelChat(client, "chat-1", noWait);

    expect(result.found).toBe(2);
    expect(result.requested).toBe(2);
    expect(result.stopped.map((state) => state.jobId).sort()).toEqual([
      "child",
      "root",
    ]);
    expect(result.blocked).toEqual([]);
    expect(result.summary).toBe("Stopped 2 jobs in this chat.");
    // Cancel is NOT archive.
    expect(archiveChat).not.toHaveBeenCalled();
    expect(ledger.get("old")?.status).toBe("done");
  });

  it("never reports a still-running job as stopped", async () => {
    const { client } = ledgerClient([
      job("root", "running"),
      job("child", "queued"),
    ]);

    const result = await cancelChat(client, "chat-1", noWait);

    expect(result.stopped.map((state) => state.jobId)).toEqual(["child"]);
    expect(result.blocked).toEqual([
      expect.objectContaining({
        jobId: "root",
        status: "running",
        reason: "stopping",
      }),
    ]);
    expect(result.summary).toContain("Stopped 1 of 2");
    expect(result.summary).toContain("root (codex, running)");
  });

  it("explains a job that cannot drain because no runner is online", async () => {
    const { client } = ledgerClient([job("root", "running")], {
      runnerLive: false,
    });

    const result = await cancelChat(client, "chat-1", noWait);

    expect(result.runnerLive).toBe(false);
    expect(result.summary).toContain("No runner is online");
  });

  it("is idempotent: an already-fenced job is not interrupted twice", async () => {
    const { client, interruptDispatchJob } = ledgerClient([
      job("root", "running", { interruptRequested: true }),
    ]);

    const result = await cancelChat(client, "chat-1", noWait);

    expect(interruptDispatchJob).not.toHaveBeenCalled();
    expect(result.requested).toBe(1);
    expect(result.blocked[0]).toMatchObject({ reason: "stopping" });
  });

  it("surfaces an interrupt that was refused, without stranding its siblings", async () => {
    const { client } = ledgerClient([
      job("denied", "running"),
      job("ok", "queued"),
    ]);
    const interrupt =
      client.interruptDispatchJob as unknown as ReturnType<typeof vi.fn>;
    const realInterrupt = interrupt.getMockImplementation()!;
    interrupt.mockImplementation(async (jobId: string) => {
      if (jobId === "denied") throw new Error("403 Forbidden, control denied");
      return realInterrupt(jobId);
    });

    const result = await cancelChat(client, "chat-1", noWait);

    expect(result.blocked).toEqual([
      expect.objectContaining({
        jobId: "denied",
        reason: "interrupt-failed",
        error: expect.stringContaining("403 Forbidden"),
      }),
    ]);
    expect(result.summary).toContain("could not be stopped");
    // The sibling was still asked to stop.
    expect(client.interruptDispatchJob).toHaveBeenCalledWith("ok");
  });

  it("reports nothing to stop for an idle chat", async () => {
    const { client, interruptDispatchJob } = ledgerClient([job("old", "done")]);
    const result = await cancelChat(client, "chat-1", noWait);
    expect(result.found).toBe(0);
    expect(interruptDispatchJob).not.toHaveBeenCalled();
    expect(result.summary).toMatch(/Nothing to stop/);
  });
});

describe("archiveChatAfterStopping", () => {
  it("interrupts every active job and archives once they are all terminal", async () => {
    const { client, archiveChat } = ledgerClient([
      job("root", "queued"),
      job("child", "queued"),
    ]);

    const result = await archiveChatAfterStopping(client, "chat-1", noWait);

    expect(client.interruptDispatchJob).toHaveBeenCalledWith("root");
    expect(client.interruptDispatchJob).toHaveBeenCalledWith("child");
    expect(archiveChat).toHaveBeenCalledTimes(1);
    expect(result.jobIds.sort()).toEqual(["child", "root"]);
  });

  it("waits for the runner to terminalize a running job, then archives", async () => {
    // The vendor drains on a later poll — exactly the window the old flow gave
    // up on (and then archived anyway, into a 409).
    let polls = 0;
    const { client, archiveChat } = ledgerClient([job("root", "running")]);
    const list = client.listDispatchJobs as unknown as ReturnType<typeof vi.fn>;
    const realList = list.getMockImplementation()!;
    list.mockImplementation(async (filter?: { status?: string }) => {
      polls += 1;
      if (polls > 4) {
        // The runner finished draining and wrote the terminal row.
        const jobs = (await realList({})) as DispatchJobRecord[];
        jobs.forEach((entry) => {
          if (entry.status === "running") entry.status = "interrupted";
        });
      }
      return realList(filter);
    });

    const result = await archiveChatAfterStopping(client, "chat-1", {
      settleMs: 1_000,
      pollMs: 10,
      now: (() => {
        let clock = 0;
        return () => (clock += 10);
      })(),
      sleep: async () => undefined,
    });

    expect(archiveChat).toHaveBeenCalledTimes(1);
    expect(result.chat.status).toBe("archived");
  });

  it("REGRESSION: refuses (naming the job) instead of archiving into a 409", async () => {
    // A running job whose runner never drains it — the founder's case.
    const { client, archiveChat } = ledgerClient([job("wedged", "running")], {
      runnerLive: false,
    });

    const failure = await archiveChatAfterStopping(
      client,
      "chat-1",
      noWait
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ChatStopBlockedError);
    const message = (failure as Error).message;
    expect(message).toContain("wedged");
    expect(message).toContain("Nothing was archived");
    expect(message).toContain("No runner is online");
    expect(message).not.toContain("409");
    // Fail-closed: the archive was never attempted.
    expect(archiveChat).not.toHaveBeenCalled();
    // …and the stop was still requested, so it drains when the runner returns.
    expect(client.interruptDispatchJob).toHaveBeenCalledWith("wedged");
  });

  it("leaves the chat active when a job cannot be stopped at all", async () => {
    const { client, archiveChat } = ledgerClient([job("root", "running")]);
    (
      client.interruptDispatchJob as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("control denied"));

    await expect(
      archiveChatAfterStopping(client, "chat-1", noWait)
    ).rejects.toThrow(/control denied/);
    expect(archiveChat).not.toHaveBeenCalled();
  });

  it("retries once when a job is dispatched into the gap before the DELETE", async () => {
    // Nothing is active, so the first pass archives — but a job lands between
    // the final read and the DELETE, so the backend 409s. The bounded retry
    // stops the newcomer and archives for real (never a silent swallow).
    const { client, archiveChat, ledger } = ledgerClient([job("old", "done")]);
    let armed = true;
    (
      client.archiveChat as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async () => {
      if (armed) {
        armed = false;
        ledger.set("late", job("late", "queued"));
        throw new Error(
          "409 Conflict, Stop every queued or running chat job before archiving."
        );
      }
      return chat();
    });

    const result = await archiveChatAfterStopping(client, "chat-1", noWait);

    expect(archiveChat).toHaveBeenCalledTimes(2);
    expect(client.interruptDispatchJob).toHaveBeenCalledWith("late");
    expect(result.chat.status).toBe("archived");
  });
});
