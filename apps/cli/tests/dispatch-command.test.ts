import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerDispatchCommands } from "../src/commands/dispatch.js";
import type { MuonApiClient } from "../src/lib/api-client.js";

function run(argv: string[], client: Partial<MuonApiClient>) {
  const program = new Command();
  program.exitOverride();
  registerDispatchCommands(program, () => client as MuonApiClient);
  return program.parseAsync(["node", "muon", ...argv]);
}

describe("muon dispatch", () => {
  it("interrupt calls interruptDispatchJob with the job id (the crew kill switch)", async () => {
    const interruptDispatchJob = vi.fn().mockResolvedValue(undefined);
    await run(["dispatch", "interrupt", "--job-id", "job-1"], {
      interruptDispatchJob,
    } as unknown as Partial<MuonApiClient>);
    expect(interruptDispatchJob).toHaveBeenCalledWith("job-1");
  });

  it("steer forwards the message to steerDispatchJob", async () => {
    const steerDispatchJob = vi.fn().mockResolvedValue(undefined);
    await run(
      ["dispatch", "steer", "--job-id", "job-1", "--message", "focus on the API"],
      { steerDispatchJob } as unknown as Partial<MuonApiClient>
    );
    expect(steerDispatchJob).toHaveBeenCalledWith("job-1", "focus on the API");
  });

  it("status --job-id fetches the job + its crew budget", async () => {
    const getDispatchJob = vi.fn().mockResolvedValue({
      id: "job-1",
      status: "running",
      vendor: "codex",
      kind: "auto",
      taskId: "t1",
    });
    const getDispatchBudget = vi.fn().mockResolvedValue({
      childrenIssued: 1,
      maxChildren: 3,
      descendantsIssued: 1,
      maxDescendants: 8,
      remainingMs: 60_000,
    });
    await run(["dispatch", "status", "--job-id", "job-1", "--json"], {
      getDispatchJob,
      getDispatchBudget,
    } as unknown as Partial<MuonApiClient>);
    expect(getDispatchJob).toHaveBeenCalledWith("job-1");
    expect(getDispatchBudget).toHaveBeenCalledWith("job-1");
  });

  it("status (no id) filters active jobs SERVER-SIDE (never client-filters a capped, oldest-first page)", async () => {
    // The backend list is oldest-first + capped at 50; filtering client-side hid
    // every active (newest) job once >50 terminal jobs accrued. The command must
    // ask the server for active-only so discovery→interrupt/steer/raise works at
    // scale.
    const listDispatchJobs = vi.fn().mockResolvedValue([
      { id: "a", status: "running", vendor: "codex", taskId: "t" },
    ]);
    const chunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    await run(["dispatch", "status", "--json"], {
      listDispatchJobs,
    } as unknown as Partial<MuonApiClient>);
    spy.mockRestore();
    expect(listDispatchJobs).toHaveBeenCalledWith({
      activeOnly: true,
      limit: 200,
    });
    const parsed = JSON.parse(chunks.join("")) as { active: { id: string }[] };
    expect(parsed.active.map((j) => j.id)).toEqual(["a"]);
  });

  it("raise sets the new descendant pool directly (operator recourse for an exhausted crew)", async () => {
    const raiseDispatchBudget = vi.fn().mockResolvedValue({
      childrenIssued: 3,
      maxChildren: 3,
      descendantsIssued: 8,
      maxDescendants: 8,
      remainingMs: 300_000,
    });
    await run(
      ["dispatch", "raise", "--job-id", "root-1", "--pool-ms", "1200000"],
      { raiseDispatchBudget } as unknown as Partial<MuonApiClient>
    );
    // Operator applies directly — no gateApprovalId threaded from the CLI.
    expect(raiseDispatchBudget).toHaveBeenCalledWith("root-1", {
      maxDescendantWallMs: 1_200_000,
    });
  });

  it("raise fast-fails on a non-integer pool without calling the backend", async () => {
    const raiseDispatchBudget = vi.fn();
    await run(
      ["dispatch", "raise", "--job-id", "root-1", "--pool-ms", "not-a-number"],
      { raiseDispatchBudget } as unknown as Partial<MuonApiClient>
    );
    expect(raiseDispatchBudget).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
