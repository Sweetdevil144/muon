import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";

// The handler-level runner gate (run.ts:239) fails `run --action` fast when no
// runner is live, so the action isn't enqueued to sit forever (false success).
// run-action.test.ts exercises the pure dispatchVendorAction helper and BYPASSES
// this gate; this drives the real command. ensureRunner also *starts* a runner
// when not live, so mock the module to control the gate deterministically.
vi.mock("../src/lib/ensure-runner.js", () => ({ ensureRunner: vi.fn() }));
import { ensureRunner } from "../src/lib/ensure-runner.js";
import { registerRunCommand } from "../src/commands/run.js";

const mockEnsureRunner = ensureRunner as unknown as ReturnType<typeof vi.fn>;

function runClient() {
  return {
    enqueueDispatch: vi.fn(async () => ({ id: "job-1", status: "queued" })),
    getVendorReadiness: vi.fn(async () => []),
  } as unknown as MuonApiClient;
}

async function driveAction(client: MuonApiClient): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerRunCommand(program, () => client);
  const stderr: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }
  );
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await program.parseAsync([
    "node",
    "muon",
    "run",
    "--action",
    "ultrareview",
    "--lane",
    "claude-code",
    "--task-id",
    "task-1",
    "--brief",
    "x",
  ]);
  return stderr.join("");
}

describe("muon run --action runner gate (handler-level, Wave 1 no-false-success)", () => {
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    mockEnsureRunner.mockReset();
  });

  it("fails fast WITHOUT enqueuing the action when no runner is live", async () => {
    mockEnsureRunner.mockResolvedValue({ live: false });
    const client = runClient();
    const err = await driveAction(client);
    // The action must NOT be dispatched to a dead runner (would sit queued
    // forever while the command exits 0 — the false-success Wave 1 closes).
    expect(client.enqueueDispatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(err).toMatch(/no persistent runner/i);
  });

  it("tells the operator to RE-RUN (not 'start one') when a runner is cold-booting", async () => {
    mockEnsureRunner.mockResolvedValue({
      live: false,
      started: true,
      note: "sandboxed runner is still starting (cold Seatbelt boot)",
    });
    const client = runClient();
    const err = await driveAction(client);
    expect(client.enqueueDispatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(err).toMatch(/still starting/i);
  });

  it("surfaces the runner reason DIRECTLY, never through the vendor classifier", async () => {
    // --lane claude-code is a known vendor; the runner-infra error must not be
    // reclassified as "Claude Code isn't connected".
    mockEnsureRunner.mockResolvedValue({ live: false });
    const client = runClient();
    const err = await driveAction(client);
    expect(err).not.toMatch(/isn't connected|not connected/i);
  });
});
