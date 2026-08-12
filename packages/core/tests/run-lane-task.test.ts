import { describe, expect, it } from "vitest";
import { laneProfileSchema, type AgentRole, type LaneCapabilities, type LaneEvent } from "@muon/protocol";
import {
  BaseLaneAdapter,
  ClaudeAdapter,
  ClaudeSessionDriver,
  type ClaudeSessionDriverFactory,
} from "@muon/adapters";
import { runLaneTask } from "../src/run-lane-task.js";

class EchoAdapter extends BaseLaneAdapter {
  readonly id = "echo-lane";
  readonly displayName = "Echo Lane";
  readonly provider = "test";
  readonly role = "worker" as const;
  readonly commandCandidates = ["echo"];

  readonly laneCapabilities: LaneCapabilities = {
    canStreamEvents: true,
    canInterrupt: true,
    canBackground: false,
    supportsApprovals: false,
    supportsWorktrees: false,
  };

  // REQUIRED on every adapter now, and `[]` is the honest answer for a test
  // double that never goes through role admission: it holds no crew role.
  readonly supportedRoles: readonly AgentRole[] = [];

  override taskCommand(brief: string) {
    return { command: "echo", args: [brief] };
  }
}

describe("runLaneTask", () => {
  it("executes a brief on the requested lane and returns the result", async () => {
    const events: LaneEvent[] = [];

    const result = await runLaneTask(
      {
        laneKey: "echo-lane",
        taskId: "task-42",
        brief: "check repo health",
        onEvent: (event) => events.push(event),
      },
      [new EchoAdapter()]
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("check repo health");
    expect(events.some((event) => event.kind === "task.started")).toBe(true);
    expect(events.some((event) => event.kind === "task.completed")).toBe(true);
  });

  it("threads a briefPrefix + argvOverride to the adapter (ADR-0013 v2)", async () => {
    // The prefix prepends to the brief; the argv override replaces the args (echo
    // prints exactly what it is spawned with), the plumbing executeJob relies on.
    const result = await runLaneTask(
      {
        laneKey: "echo-lane",
        taskId: "task-uv",
        brief: "base brief",
        briefPrefix: "PREFIX",
        argvOverride: { command: "echo", args: ["ultrareview", "HEAD", "--json"] },
        onEvent: () => {},
      },
      [new EchoAdapter()]
    );
    expect(result.output).toContain("ultrareview HEAD --json");
    expect(result.output).not.toContain("base brief");
  });

  it("threads a diagnostic sink through to the vendor child's stderr", async () => {
    // The runner's liveness watchdog subscribes here: without this thread the
    // stderr a stalled vendor DID produce never reaches the watchdog, and the
    // stall gets reported with a cause nobody observed.
    class StderrAdapter extends EchoAdapter {
      override readonly commandCandidates = ["sh"];
      override taskCommand(brief: string) {
        return { command: "sh", args: ["-c", `echo "${brief}" >&2`] };
      }
    }

    const chunks: string[] = [];
    const result = await runLaneTask(
      {
        laneKey: "echo-lane",
        taskId: "task-diagnostic",
        brief: "spend cap reached",
        onEvent: () => {},
        onDiagnostic: (chunk) => chunks.push(chunk),
      },
      [new StderrAdapter()]
    );

    expect(chunks.join("")).toContain("spend cap reached");
    expect(result.errorOutput).toContain("spend cap reached");
  });

  // The one-shot dispatch path the runner drives (`kind: "oneshot"`, and every
  // loop iteration) reaches Claude through here. It used to spawn
  // `claude -p "<brief>"`, which begins the turn at process launch — so a run
  // granted `mcp__muon__*` tools could start before the MCP handshake finished
  // and hunt for tools that did not exist yet. These two pin that the gate now
  // applies from THIS seam, not just inside the adapter package.
  describe("claude one-shot MCP readiness (via the session channel)", () => {
    const claudeProfile = laneProfileSchema.parse({
      allowedTools: ["mcp__muon__memory_add"],
      mcpServers: [
        { name: "muon", command: "muon-mcp", args: ["--stdio"], env: {} },
      ],
    });

    function claudeLane(statuses: {
      name: string;
      status: string;
      error?: string;
      tools?: { name: string }[];
    }[][]) {
      const sent: string[] = [];
      let polls = 0;
      const sdk = {
        query: ({ prompt }: { prompt: unknown; options: unknown }) => {
          const briefLanded = (async () => {
            for await (const message of prompt as AsyncIterable<{
              message: { content: string };
            }>) {
              sent.push(message.message.content);
            }
          })();
          return {
            async *[Symbol.asyncIterator]() {
              await briefLanded;
              yield {
                type: "assistant",
                message: { content: [{ type: "text", text: "noted" }] },
              };
              yield { type: "result", subtype: "success", result: "noted" };
            },
            interrupt: async () => undefined,
            mcpServerStatus: async () => {
              const row = statuses[Math.min(polls, statuses.length - 1)]!;
              polls += 1;
              return row;
            },
          };
        },
      };
      const factory: ClaudeSessionDriverFactory = (options) =>
        new ClaudeSessionDriver(async () => sdk as never, {
          muonMcpPollIntervalMs: 1,
          ...options,
        });
      // Only the vendor binary is swapped, so compilation and the lane env
      // filter run exactly as in production.
      class TestClaudeAdapter extends ClaudeAdapter {
        override taskCommand(brief: string) {
          return { command: "echo", args: ["-p", brief] };
        }
      }
      return { adapter: new TestClaudeAdapter(factory), sent };
    }

    it("withholds the brief until the muon MCP server exposes its granted tools", async () => {
      const { adapter, sent } = claudeLane([
        [{ name: "muon", status: "pending" }],
        [
          {
            name: "muon",
            status: "connected",
            tools: [{ name: "memory_add" }],
          },
        ],
      ]);

      const result = await runLaneTask(
        {
          laneKey: "claude-code",
          taskId: "task-mcp-ready",
          brief: "record the decision",
          profile: claudeProfile,
          onEvent: () => {},
        },
        [adapter]
      );

      expect(sent).toEqual(["record the decision"]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("noted");
    });

    it("refuses the run with an honest reason when the handshake fails", async () => {
      const { adapter, sent } = claudeLane([
        [{ name: "muon", status: "failed", error: "spawn muon-mcp ENOENT" }],
      ]);

      await expect(
        runLaneTask(
          {
            laneKey: "claude-code",
            taskId: "task-mcp-blind",
            brief: "record the decision",
            profile: claudeProfile,
            onEvent: () => {},
          },
          [adapter]
        )
      ).rejects.toThrow(/withheld the brief/);
      expect(sent).toEqual([]);
    });
  });

  it("throws a clear error for unknown lanes", async () => {
    await expect(
      runLaneTask(
        {
          laneKey: "nonexistent-lane",
          taskId: "task-43",
          brief: "noop",
          onEvent: () => {},
        },
        [new EchoAdapter()]
      )
    ).rejects.toThrow(/unknown lane/i);
  });
});
