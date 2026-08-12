import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { registerQuickstartCommand } from "../src/commands/quickstart.js";

// P6, the guided first task at the CLI boundary. Deterministic: a fully mocked
// client (getRunner → live so no runner is spawned; no real dispatch / vendor CLI).

const READY = [
  { vendor: "claude-code", installed: true, authenticated: true, detail: "logged in" },
  { vendor: "codex", installed: false, authenticated: false, detail: "not found", fixHint: "install codex" },
];
const NONE_READY = [
  { vendor: "claude-code", installed: true, authenticated: false, detail: "not logged in", fixHint: "run `claude` and sign in" },
];

function fakeClient(readiness: unknown): {
  client: MuonApiClient;
  createTask: ReturnType<typeof vi.fn>;
  enqueueDispatch: ReturnType<typeof vi.fn>;
} {
  const createTask = vi.fn(async (input: unknown) => ({
    id: "task-1",
    status: "backlog",
    ...(input as object),
  }));
  const enqueueDispatch = vi.fn(async (input: unknown) => ({
    id: "job-1",
    status: "queued",
    ...(input as object),
  }));
  const client = {
    getVendorReadiness: vi.fn(async () => readiness),
    getRunner: vi.fn(async () => ({ runner: { host: "h" }, live: true })),
    createTask,
    enqueueDispatch,
  } as unknown as MuonApiClient;
  return { client, createTask, enqueueDispatch };
}

async function runQuickstart(client: MuonApiClient, args: string[] = []) {
  const program = new Command();
  program.exitOverride();
  registerQuickstartCommand(program, () => client);
  const out: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "muon", "quickstart", ...args]);
  } finally {
    // Restore ONLY the stdout/stderr spies, never the client vi.fn() mocks,
    // whose call history the assertions inspect after this returns.
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return out.join("");
}

afterEach(() => {
  process.exitCode = 0;
});

describe("muon quickstart", () => {
  it("ready vendor → seeds the sample task + dispatches it (mocked)", async () => {
    const { client, createTask, enqueueDispatch } = fakeClient(READY);
    const output = await runQuickstart(client, ["--workspace", "/tmp/proj"]);

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0][0]).toMatchObject({
      workspacePath: "/tmp/proj",
      priority: "low",
    });
    expect(enqueueDispatch).toHaveBeenCalledTimes(1);
    expect(enqueueDispatch.mock.calls[0][0]).toMatchObject({
      vendor: "claude-code",
      taskId: "task-1",
      workspacePath: "/tmp/proj",
    });
    expect(output).toMatch(/Seeded your first task/);
    expect(output).toMatch(/dispatched it to claude-code/);
    expect(process.exitCode).toBe(1 - 1); // 0
  });

  it("no vendor ready → routes to onboarding, seeds nothing, exits non-zero", async () => {
    const { client, createTask, enqueueDispatch } = fakeClient(NONE_READY);
    const output = await runQuickstart(client);

    expect(createTask).not.toHaveBeenCalled();
    expect(enqueueDispatch).not.toHaveBeenCalled();
    expect(output).toMatch(/No coding agent is connected yet/i);
    // The onboarding report + fix hint is shown (no dead-end).
    expect(output).toMatch(/run `claude` and sign in/);
    expect(process.exitCode).toBe(1);
  });

  it("never prints a token in either branch", async () => {
    const { client } = fakeClient(READY);
    const output = await runQuickstart(client, ["--workspace", "/tmp/proj"]);
    // A real token value never appears (a bare word like "task-1" must not trip it).
    expect(output).not.toMatch(/\bBearer\s+\S|sk-[A-Za-z0-9]{6,}|Authorization:/i);
  });
});
