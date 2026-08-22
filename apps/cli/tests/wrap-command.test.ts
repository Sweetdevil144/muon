import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWrapCommand } from "../src/commands/wrap.js";
import type { MuonApiClient } from "../src/lib/api-client.js";

// ── H7: `muon wrap` reads the SAME coordinates the other surfaces read ───────
//
// The wrap is the typed handoff packet: same id a successor's handoff_read
// cites, same classifier the desktop handoff panel uses. These tests pin the
// three properties that make the CLI leg honest: the packet id is printed
// verbatim, the classification comes from the shared classifier (a degraded
// packet SAYS so), and absence is stated rather than rendered as emptiness.

function run(argv: string[], client: Partial<MuonApiClient>) {
  const program = new Command();
  program.exitOverride();
  registerWrapCommand(program, () => client as MuonApiClient);
  return program.parseAsync(["node", "muon", ...argv]);
}

const typedPacket = {
  schemaVersion: 2,
  taskGoal: "ship the thing",
  whatChanged: "changed the thing",
  whatFailed: "nothing",
  nextLaneRequest: "review it",
  commandsRun: [],
  checksStatus: [],
  openQuestions: [],
  provenance: { lane: "codex", createdAt: "2026-08-17T00:00:00.000Z" },
  degraded: { flag: false, reasons: [] },
};

function handoffRow(over: Record<string, unknown> = {}) {
  return {
    id: "handoff-1",
    packetTitle: "wrap of task-1",
    packetBody: "# Task goal\nship the thing\n",
    packetJson: typedPacket,
    status: "filed",
    createdAt: "2026-08-17T00:00:00.000Z",
    fromLane: { id: "l1", name: "codex-lane" },
    toLane: { id: "l2", name: "claude-lane" },
    ...over,
  };
}

let out: string[];
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  out = [];
  writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as never);
});

afterEach(() => {
  writeSpy.mockRestore();
});

describe("muon wrap", () => {
  it("prints the newest packet with its id and the shared classification", async () => {
    const getTaskDetail = vi.fn().mockResolvedValue({
      handoffs: [handoffRow({ id: "handoff-old" }), handoffRow()],
    });
    await run(["wrap", "--task-id", "task-1"], {
      getTaskDetail,
    } as unknown as Partial<MuonApiClient>);
    const text = out.join("");
    expect(getTaskDetail).toHaveBeenCalledWith("task-1");
    // Newest only by default — and the successor-citable id is verbatim.
    expect(text).toContain("wrap handoff-1");
    expect(text).not.toContain("handoff-old");
    expect(text).toContain("Typed packet");
    // The trust label rides every wrap: proposals never look confirmed.
    expect(text).toContain("UNCONFIRMED");
  });

  it("a degraded packet is classified as degraded, never as a clean wrap", async () => {
    const degraded = {
      ...typedPacket,
      degraded: { flag: true, reasons: ["no_check_evidence"] },
    };
    const getTaskDetail = vi.fn().mockResolvedValue({
      handoffs: [handoffRow({ packetJson: degraded })],
    });
    await run(["wrap", "--task-id", "task-1"], {
      getTaskDetail,
    } as unknown as Partial<MuonApiClient>);
    expect(out.join("")).toContain("DEGRADED");
  });

  it("says plainly when no packet exists instead of printing nothing", async () => {
    const getTaskDetail = vi.fn().mockResolvedValue({ handoffs: [] });
    await run(["wrap", "--task-id", "task-none"], {
      getTaskDetail,
    } as unknown as Partial<MuonApiClient>);
    expect(out.join("")).toContain("no wrap exists for task task-none");
  });
});
