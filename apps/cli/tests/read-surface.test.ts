import { Command } from "commander";
import { describe, expect, it, vi, afterEach } from "vitest";
import { registerRoutingCommands } from "../src/commands/routing.js";
import { registerStreamCommands } from "../src/commands/stream.js";
import type { MuonApiClient } from "../src/lib/api-client.js";

function run(
  register: (p: Command, c: () => MuonApiClient) => void,
  argv: string[],
  client: Partial<MuonApiClient>
) {
  const program = new Command();
  program.exitOverride();
  register(program, () => client as MuonApiClient);
  return program.parseAsync(["node", "muon", ...argv]);
}

describe("muon routing suggest (free-text pre-task planning)", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  it("passes free text through as the text arg (no task id)", async () => {
    const suggestLanes = vi.fn().mockResolvedValue([
      { laneId: "l1", laneKey: "codex", laneName: "Codex", score: 9, reason: "fit" },
    ]);
    await run(registerRoutingCommands, ["routing", "suggest", "add", "OAuth", "support"], {
      suggestLanes,
    } as unknown as Partial<MuonApiClient>);
    expect(suggestLanes).toHaveBeenCalledWith(undefined, "add OAuth support");
  });

  it("scores against an existing task with --task-id", async () => {
    const suggestLanes = vi.fn().mockResolvedValue([]);
    await run(registerRoutingCommands, ["routing", "suggest", "--task-id", "task-1"], {
      suggestLanes,
    } as unknown as Partial<MuonApiClient>);
    expect(suggestLanes).toHaveBeenCalledWith("task-1", undefined);
  });

  it("fails fast when neither text nor --task-id is given", async () => {
    const suggestLanes = vi.fn();
    await run(registerRoutingCommands, ["routing", "suggest"], {
      suggestLanes,
    } as unknown as Partial<MuonApiClient>);
    expect(suggestLanes).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("muon stream read (replay recorded chunks)", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  it("forwards the filter and replays chunk content in sequence", async () => {
    const listStreamChunks = vi.fn().mockResolvedValue([
      { seq: 1, taskId: "t", laneId: "l", kind: "stdout", content: "hello ", timestamp: "" },
      { seq: 2, taskId: "t", laneId: "l", kind: "stdout", content: "world", timestamp: "" },
    ]);
    const chunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    await run(
      registerStreamCommands,
      ["stream", "read", "--task-id", "t", "--after-seq", "0", "--latest"],
      { listStreamChunks } as unknown as Partial<MuonApiClient>
    );
    spy.mockRestore();
    expect(listStreamChunks).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t", afterSeq: 0, latest: true })
    );
    expect(chunks.join("")).toBe("hello world");
  });

  it("fails fast when no selector is given", async () => {
    const listStreamChunks = vi.fn();
    await run(registerStreamCommands, ["stream", "read"], {
      listStreamChunks,
    } as unknown as Partial<MuonApiClient>);
    expect(listStreamChunks).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
