import { describe, expect, it } from "vitest";
import {
  TOOL_ACTIVITY_ARGS_CHARS,
  TOOL_ACTIVITY_RESULT_CHARS,
  type LaneEvent,
} from "@muon/protocol";
import { createCodexExecStream } from "../src/codex-exec-stream.js";

/**
 * F-B. Measured live against codex 0.145.0: `codex exec` writes its whole
 * activity console to STDERR and only the final agent message to STDOUT, so a
 * loop-dispatched codex child's durable stream was its closing sentence and
 * nothing else — the founder's mission recorded 1 activity chunk and 2 output
 * chunks over four minutes while the child called `preflight_edit`,
 * `claim_files`, `peer_inbox` and `peer_message`. `--json` puts the vendor's
 * own event stream on stdout; these assert the translation of it.
 *
 * The JSONL fixtures below are VERBATIM shapes captured from a real
 * `codex exec --json` run (isolated CODEX_HOME, scratch repo), not invented.
 */
function collect(lines: string[], chunking: "line" | "byte" = "line") {
  const events: LaneEvent[] = [];
  const console_: string[] = [];
  let sessionId: string | undefined;
  const stream = createCodexExecStream({
    laneId: "codex",
    taskId: "task-1",
    onEvent: (event) => events.push(event),
    onVendorSessionId: (id) => {
      sessionId = id;
    },
    onConsole: (line) => console_.push(line),
  });
  const payload = `${lines.join("\n")}\n`;
  if (chunking === "byte") {
    for (const character of payload) stream.admit(character);
  } else {
    stream.admit(payload);
  }
  return { events, console: console_, sessionId, stream };
}

const MCP_CALL_STARTED = JSON.stringify({
  type: "item.started",
  item: {
    id: "item_0",
    type: "mcp_tool_call",
    server: "muon",
    tool: "preflight_edit",
    arguments: { target: "compileCodexProfile", filePath: "src/x.ts" },
    result: null,
    error: null,
    status: "in_progress",
  },
});

const MCP_CALL_COMPLETED = JSON.stringify({
  type: "item.completed",
  item: {
    id: "item_0",
    type: "mcp_tool_call",
    server: "muon",
    tool: "preflight_edit",
    arguments: { target: "compileCodexProfile", filePath: "src/x.ts" },
    result: { risk: "LOW" },
    error: null,
    status: "completed",
  },
});

describe("codex exec --json → lane activity", () => {
  it("surfaces every MCP tool call the child makes, started and completed", () => {
    const { events } = collect([
      '{"type":"thread.started","thread_id":"019fa10c-5f2c-7862-8997-f800efbb95b6"}',
      '{"type":"turn.started"}',
      MCP_CALL_STARTED,
      MCP_CALL_COMPLETED,
    ]);
    const activity = events.filter((event) => event.metadata.codexActivity);
    expect(activity).toHaveLength(2);
    expect(activity.map((event) => event.message)).toEqual([
      "muon.preflight_edit started",
      "muon.preflight_edit completed",
    ]);
    // Control-plane, so the stream recorder files these as ACTIVITY chunks —
    // the class that was empty for the whole of the founder's codex run.
    expect(activity.every((event) => event.metadata.controlPlane === true)).toBe(
      true
    );
  });

  it("emits the SAME toolActivity shape the interactive Codex driver emits", () => {
    const { events } = collect([MCP_CALL_STARTED, MCP_CALL_COMPLETED]);
    const tool = events[0]!.metadata.toolActivity as Record<string, unknown>;
    expect(tool.provider).toBe("codex");
    expect(tool.phase).toBe("started");
    expect(tool.tool).toBe("muon.preflight_edit");
    expect(tool.itemId).toBe("item_0");
    expect(
      (events[1]!.metadata.toolActivity as Record<string, unknown>).phase
    ).toBe("completed");
  });

  it("keeps the Codex no-payload invariant: coordinates on the line, payload only in detail", () => {
    const { events } = collect([
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_9",
          type: "command_execution",
          command: "/bin/zsh -lc 'echo TOP_SECRET_ARGUMENT'",
          aggregated_output: "TOP_SECRET_RESULT\n",
          exit_code: 0,
          status: "completed",
        },
      }),
    ]);
    const event = events[0]!;
    expect(event.message).toBe("Codex command completed");
    const coordinates = JSON.stringify(event.metadata.codexActivity);
    expect(coordinates).not.toContain("TOP_SECRET_ARGUMENT");
    expect(coordinates).not.toContain("TOP_SECRET_RESULT");
    const detail = (event.metadata.toolActivity as Record<string, unknown>)
      .detail as Record<string, unknown>;
    // snake_case `aggregated_output` is the exec spelling of the app-server's
    // `aggregatedOutput`; one extractor has to read both or the exec path goes
    // blank exactly where the result matters.
    expect(String(detail.args)).toContain("TOP_SECRET_ARGUMENT");
    expect(String(detail.result)).toContain("TOP_SECRET_RESULT");
    expect(String(detail.args).length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_ARGS_CHARS
    );
    expect(String(detail.result).length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_RESULT_CHARS
    );
  });

  it("bounds an oversized payload at the emission site", () => {
    const { events } = collect([
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_big",
          type: "command_execution",
          command: "x".repeat(50_000),
          aggregated_output: "y".repeat(200_000),
          status: "completed",
        },
      }),
    ]);
    const detail = (events[0]!.metadata.toolActivity as Record<string, unknown>)
      .detail as Record<string, unknown>;
    expect(String(detail.args).length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_ARGS_CHARS
    );
    expect(String(detail.result).length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_RESULT_CHARS
    );
    expect(detail.argsTruncated).toBe(true);
    expect(detail.resultTruncated).toBe(true);
  });

  it("reports a failed MCP call as blocked, and carries its cause", () => {
    // Measured: a call codex could not run comes back `status: "failed"` with
    // the reason ONLY in `error.message` — without it the tool card is a blank
    // box where the failure should be.
    const { events } = collect([
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "mcp_tool_call",
          server: "muon",
          tool: "claim_files",
          arguments: { paths: ["a.ts"] },
          result: null,
          error: { message: "user cancelled MCP tool call" },
          status: "failed",
        },
      }),
    ]);
    expect(events[0]!.kind).toBe("task.blocked");
    expect(events[0]!.message).toBe("muon.claim_files failed");
    const detail = (events[0]!.metadata.toolActivity as Record<string, unknown>)
      .detail as Record<string, unknown>;
    expect(String(detail.result)).toContain("user cancelled");
    expect(
      (events[0]!.metadata.toolActivity as Record<string, unknown>).phase
    ).toBe("failed");
  });

  it("records a file change as activity, an agent message as OUTPUT", () => {
    const { events, stream } = collect([
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_2",
          type: "file_change",
          changes: [{ path: "/w/touched.txt", kind: "add" }],
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_3", type: "agent_message", text: "GOAL: done" },
      }),
    ]);
    expect(events[0]!.metadata.controlPlane).toBe(true);
    expect(events[0]!.message).toBe("Codex file change completed");
    expect(events[0]!.metadata.toolActivity).toMatchObject({
      fileMutation: true,
      paths: ["/w/touched.txt"],
    });
    // The agent's words are OUTPUT, on the whole-message boundary — not a
    // control-plane line, or the run's own report would file as activity.
    expect(events[1]!.metadata.controlPlane).toBeUndefined();
    expect(events[1]!.metadata.outputMode).toBe("message");
    expect(events[1]!.message).toBe("GOAL: done");
    expect(stream.finalMessage()).toBe("GOAL: done");
  });

  it("reports the vendor thread id once — the resume/backlink handle", () => {
    const { sessionId, events } = collect([
      '{"type":"thread.started","thread_id":"019fa10c-5f2c-7862-8997-f800efbb95b6"}',
      '{"type":"thread.started","thread_id":"second-should-be-ignored"}',
    ]);
    expect(sessionId).toBe("019fa10c-5f2c-7862-8997-f800efbb95b6");
    expect(events).toEqual([]);
  });

  it("reassembles items split across arbitrary transport chunk boundaries", () => {
    // stdout arrives in ~64 KB pipe chunks that cut lines anywhere; a parser
    // that assumed one chunk per line would drop most of the stream.
    const { events } = collect([MCP_CALL_STARTED, MCP_CALL_COMPLETED], "byte");
    expect(events.filter((event) => event.metadata.codexActivity)).toHaveLength(
      2
    );
  });

  it("ignores non-JSON console noise instead of guessing at it", () => {
    const { events, stream } = collect([
      "OpenAI Codex v0.145.0",
      "--------",
      "{ this is not json",
      MCP_CALL_STARTED,
    ]);
    expect(events).toHaveLength(1);
    expect(stream.sawEvents()).toBe(true);
  });

  it("drops one over-long line rather than growing the parse buffer with it", () => {
    const events: LaneEvent[] = [];
    const stream = createCodexExecStream({
      laneId: "codex",
      taskId: "task-1",
      onEvent: (event) => events.push(event),
    });
    // A single unterminated line past the cap: swallowed to its terminator, and
    // the stream keeps working afterwards.
    stream.admit("x".repeat(1_000_001));
    stream.admit("still the same line\n");
    stream.admit(`${MCP_CALL_STARTED}\n`);
    expect(events).toHaveLength(1);
  });

  it("renders coordinates — never payload — into the live terminal", () => {
    const { console: rendered } = collect([
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_9",
          type: "command_execution",
          command: "echo TOP_SECRET_ARGUMENT",
          aggregated_output: "TOP_SECRET_RESULT",
          status: "completed",
        },
      }),
    ]);
    expect(rendered.join("")).toBe("[muon] Codex command completed\r\n");
    expect(rendered.join("")).not.toContain("TOP_SECRET");
  });

  it("never lets a throwing terminal viewer cost the run its stream", () => {
    const events: LaneEvent[] = [];
    const stream = createCodexExecStream({
      laneId: "codex",
      taskId: "task-1",
      onEvent: (event) => events.push(event),
      onConsole: () => {
        throw new Error("viewer exploded");
      },
    });
    expect(() => stream.admit(`${MCP_CALL_STARTED}\n`)).not.toThrow();
    expect(events).toHaveLength(1);
  });
});
