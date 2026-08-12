import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerChatCommands } from "../src/commands/chat.js";
import type { MuonApiClient } from "../src/lib/api-client.js";

// ── Cross-surface parity for the chat-level cancel ───────────────────────────
//
// A governed op that exists in the desktop must be reachable from the CLI with
// the SAME governed payload. `muon chat --cancel` therefore runs the identical
// shared cancel over the identical per-job `POST /api/dispatch/:id/interrupt`
// — there is no chat-scoped kill route for either surface to reach for. And
// `--archive` now stops first and refuses honestly, instead of firing a DELETE
// straight into a precondition it has not satisfied.

/**
 * The cancel settles against the real ledger for a few seconds (a vendor needs
 * that long to drain), so the clock is faked here — the command runs its full
 * bounded poll loop, just not in real time.
 */
async function run(argv: string[], client: Partial<MuonApiClient>) {
  const program = new Command();
  program.exitOverride();
  registerChatCommands(program, () => client as MuonApiClient);
  vi.useFakeTimers();
  try {
    const done = program.parseAsync(["node", "muon", ...argv]);
    await vi.runAllTimersAsync();
    await done;
  } finally {
    vi.useRealTimers();
  }
}

function jobRow(id: string, status: string) {
  return {
    id,
    kind: "session",
    vendor: "claude-code",
    taskId: "task-1",
    chatId: "chat-1",
    brief: "work",
    status,
    dispatchedBy: "operator",
    interruptRequested: false,
    steerMessages: [],
    createdAt: "2026-07-25T00:00:00.000Z",
  };
}

/** A fake ledger that behaves like the backend: queued dies, running lingers. */
function ledgerClient(rows: ReturnType<typeof jobRow>[]) {
  const ledger = new Map(rows.map((row) => [row.id, { ...row }]));
  const interruptDispatchJob = vi.fn(async (jobId: string) => {
    const row = ledger.get(jobId)!;
    row.interruptRequested = true;
    if (row.status === "queued") row.status = "interrupted";
  });
  return {
    listChats: vi.fn(async () => [
      { id: "chat-1", title: "Mission", workspacePath: process.cwd() },
    ]),
    listDispatchJobs: vi.fn(async (filter?: { status?: string }) =>
      [...ledger.values()].filter(
        (row) => !filter?.status || row.status === filter.status
      )
    ),
    interruptDispatchJob,
    getRunner: vi.fn(async () => ({ runner: null, live: true })),
    archiveChat: vi.fn(async () => ({
      id: "chat-1",
      title: "Mission",
      status: "archived",
    })),
    ledger,
  };
}

const written: string[] = [];
const stdout = vi
  .spyOn(process.stdout, "write")
  .mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
const stderr = vi
  .spyOn(process.stderr, "write")
  .mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });

afterEach(() => {
  written.length = 0;
  process.exitCode = undefined;
});

afterEach(() => {
  stdout.mockClear();
  stderr.mockClear();
});

describe("muon chat --cancel", () => {
  it("interrupts every live job of the chat and leaves the chat alone", async () => {
    const client = ledgerClient([
      jobRow("root", "queued"),
      jobRow("child", "queued"),
      jobRow("old", "done"),
    ]);

    await run(["chat", "--cancel", "--chat-id", "chat-1"], client as never);

    expect(client.interruptDispatchJob).toHaveBeenCalledWith("root");
    expect(client.interruptDispatchJob).toHaveBeenCalledWith("child");
    expect(client.interruptDispatchJob).not.toHaveBeenCalledWith("old");
    // Cancel is not archive: the chat is untouched.
    expect(client.archiveChat).not.toHaveBeenCalled();
    expect(written.join("")).toContain("Stopped 2 jobs in this chat.");
    expect(process.exitCode).toBeUndefined();
  });

  it("fails closed for scripts when a job will not stop", async () => {
    const client = ledgerClient([jobRow("live", "running")]);

    await run(["chat", "--cancel", "--chat-id", "chat-1"], client as never);

    const output = written.join("");
    expect(output).toContain("still active");
    expect(output).toContain("live (claude-code, running)");
    // Never "stopped" for a job the ledger still shows running.
    expect(output).not.toMatch(/Stopped 1 job/);
    expect(process.exitCode).toBe(1);
  });

  it("resolves the chat for this folder when --chat-id is omitted", async () => {
    const client = ledgerClient([jobRow("root", "queued")]);
    await run(["chat", "--cancel"], client as never);
    expect(client.listChats).toHaveBeenCalledWith({ status: "active" });
    expect(client.interruptDispatchJob).toHaveBeenCalledWith("root");
  });
});

describe("muon chat --archive", () => {
  it("stops the chat's work first, then archives", async () => {
    const client = ledgerClient([jobRow("root", "queued")]);

    await run(["chat", "--archive", "--chat-id", "chat-1"], client as never);

    expect(client.interruptDispatchJob).toHaveBeenCalledWith("root");
    expect(client.archiveChat).toHaveBeenCalledWith("chat-1");
    expect(written.join("")).toContain("archived chat chat-1");
    expect(process.exitCode).toBeUndefined();
  });

  it("REGRESSION: refuses with the blocking job named, never a bare 409", async () => {
    const client = ledgerClient([jobRow("live", "running")]);

    await run(["chat", "--archive", "--chat-id", "chat-1"], client as never);

    const output = written.join("");
    expect(output).toContain("live (claude-code, running)");
    expect(output).toContain("Nothing was archived");
    expect(output).not.toContain("409");
    expect(client.archiveChat).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
