import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerScheduleCommands } from "../src/commands/schedule.js";
import type { MuonApiClient } from "../src/lib/api-client.js";

const schedule = {
  id: "schedule-1",
  title: "Morning review",
  objective: "Review outstanding work",
  workspacePath: "/repo",
  vendor: "codex",
  nextRunAt: "2026-08-02T03:00:00.000Z",
  maxRuns: 1,
  runCount: 0,
  maxWallMs: 1_800_000,
  maxDescendantWallMs: 9_600_000,
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  occurrences: [],
} as const;

function stubClient(overrides: Partial<MuonApiClient> = {}): MuonApiClient {
  return {
    listSchedules: vi.fn(async () => [schedule]),
    createSchedule: vi.fn(async () => schedule),
    updateSchedule: vi.fn(async () => schedule),
    ...overrides,
  } as unknown as MuonApiClient;
}

describe("muon schedule", () => {
  const writes: string[] = [];

  afterEach(() => {
    writes.length = 0;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function run(argv: string[], client: MuonApiClient) {
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = new Command();
    program.exitOverride();
    registerScheduleCommands(program, () => client);
    return program.parseAsync(["node", "muon", ...argv]);
  }

  it("creates a one-shot with explicit root and crew budgets", async () => {
    const createSchedule = vi.fn(async () => schedule);
    await run(
      [
        "schedule",
        "create",
        "--title",
        "Morning review",
        "--objective",
        "Review outstanding work",
        "--workspace",
        "/repo",
        "--next-run",
        "2026-08-02T03:00:00Z",
        "--vendor",
        "codex",
      ],
      stubClient({ createSchedule })
    );
    expect(createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        maxWallMs: 1_800_000,
        maxDescendantWallMs: 9_600_000,
        nextRunAt: "2026-08-02T03:00:00.000Z",
      })
    );
    expect(writes.join("")).toContain("live standing-approver lease");
  });

  it("lists stable ids and supports JSON", async () => {
    await run(["schedule", "list", "--json"], stubClient());
    expect(JSON.parse(writes.join("")).schedules[0].id).toBe("schedule-1");
  });

  it("pauses without deleting the record", async () => {
    const updateSchedule = vi.fn(async () => ({ ...schedule, status: "paused" as const }));
    await run(
      ["schedule", "pause", "--id", "schedule-1"],
      stubClient({ updateSchedule })
    );
    expect(updateSchedule).toHaveBeenCalledWith({
      scheduleId: "schedule-1",
      status: "paused",
    });
  });
});
