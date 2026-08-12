import { describe, expect, it, vi } from "vitest";
import { ClaudeSessionDriver } from "../src/claude-session-driver.js";
import {
  emptyLaneProfile,
  TOOL_ACTIVITY_ARGS_CHARS,
  TOOL_ACTIVITY_RESULT_CHARS,
  type LaneEvent,
} from "@muon/protocol";

type SdkMessage = {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  tool_use_id?: string;
  tool_name?: string;
  message?: {
    content?: {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      tool_use_id?: string;
      is_error?: boolean;
      input?: unknown;
      content?: unknown;
    }[];
  };
};

/** The bounded detail one tool-lifecycle event carries, if any. */
function toolDetail(event: LaneEvent): Record<string, unknown> | undefined {
  const activity = event.metadata.toolActivity as
    | Record<string, unknown>
    | undefined;
  return activity?.detail as Record<string, unknown> | undefined;
}

function fakeSdk(script: (options: Record<string, unknown>) => SdkMessage[]) {
  return {
    query: ({ options }: { prompt: unknown; options: Record<string, unknown> }) => {
      const messages = script(options);
      const iterable = {
        async *[Symbol.asyncIterator]() {
          for (const message of messages) {
            yield message;
          }
        },
        interrupt: async () => undefined,
      };
      return iterable;
    },
  };
}

type FakeMcpStatus = {
  name?: string;
  status?: string;
  error?: string;
  tools?: { name?: string }[];
};

const muonMcpProfile = (allowedTools: string[]) => ({
  ...emptyLaneProfile,
  allowedTools,
  mcpServers: [
    { name: "muon", command: "muon-mcp", args: [], env: {} },
  ],
});

/**
 * A fake SDK whose `mcpServerStatus()` walks a scripted status sequence, and
 * which drains the streaming-input prompt so the test can assert exactly WHEN
 * (and whether) the brief was handed to the vendor.
 */
function fakeMcpSdk(options: {
  statuses: FakeMcpStatus[][];
  omitStatusProbe?: boolean;
  onStatusPoll?: (index: number) => void;
}) {
  const sent: string[] = [];
  let polls = 0;
  const sdk = {
    query: ({
      prompt,
    }: {
      prompt: unknown;
      options: Record<string, unknown>;
    }) => {
      void (async () => {
        for await (const message of prompt as AsyncIterable<{
          message: { content: string };
        }>) {
          sent.push(message.message.content);
        }
      })();
      return {
        async *[Symbol.asyncIterator]() {
          // Nothing streams back until the brief lands; a real vendor emits its
          // `system`/`init` message only once a turn begins.
          await new Promise(() => undefined);
          yield { type: "result", subtype: "success" } as SdkMessage;
        },
        interrupt: async () => undefined,
        ...(options.omitStatusProbe
          ? {}
          : {
              mcpServerStatus: async () => {
                const index = Math.min(polls, options.statuses.length - 1);
                polls += 1;
                options.onStatusPoll?.(index);
                return options.statuses[index]!;
              },
            }),
      };
    },
  };
  return { sdk, sent, pollCount: () => polls };
}

async function mustSettleWithin<T>(
  promise: Promise<T>,
  timeoutMs = 250
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`promise did not settle within ${timeoutMs}ms`)),
      timeoutMs
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

describe("ClaudeSessionDriver", () => {
  it("streams SDK messages as lane events and captures the session id", async () => {
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk(() => [
        { type: "system", subtype: "init", session_id: "claude-sess-1" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Analyzing the repo" }] },
        },
        {
          type: "result",
          subtype: "success",
          result: "All done",
          usage: { input_tokens: 11, output_tokens: 7 },
        },
      ])
    );

    const events: LaneEvent[] = [];
    const handle = await driver.start(
      { taskId: "task-1", brief: "fix it" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    const result = await handle.wait();

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Analyzing the repo");
    expect(handle.vendorSessionId).toBe("claude-sess-1");
    expect(events.map((e) => e.kind)).toEqual([
      "task.started",
      "task.progress",
      "task.completed",
    ]);
    expect(events[1]?.metadata.outputMode).toBe("message");
    expect(events.at(-1)?.metadata).toMatchObject({
      usage: {
        vendor: "claude-code",
        inputTokens: 11,
        outputTokens: 7,
      },
    });
  });

  // MUON captures the SDK's own `input`/`content` fields (below); anything
  // else a provider hangs off a block is still never copied.
  it("emits redacted typed tool lifecycle, copying no unrecognized payload field", async () => {
    const secretInput = "TOP_SECRET_INPUT";
    const secretResult = "TOP_SECRET_RESULT";
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk(() => [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool\n<script>",
                name: "Read<script>",
                text: secretInput,
              },
            ],
          },
        },
        {
          type: "tool_progress",
          tool_use_id: "tool\n<script>",
          tool_name: "Read<script>",
          result: secretResult,
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool\n<script>",
                text: secretResult,
              },
            ],
          },
        },
        { type: "result", subtype: "success", result: "done" },
      ])
    );
    const events: LaneEvent[] = [];

    const handle = await driver.start(
      { taskId: "task-tools", brief: "inspect safely" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );
    await handle.wait();

    const lifecycle = events.filter(
      (event) => event.metadata.toolActivity !== undefined
    );
    expect(lifecycle.map((event) => event.message)).toEqual([
      "Read_script_ started",
      "Read_script_ is still working",
      "Read_script_ completed",
    ]);
    const persisted = JSON.stringify(lifecycle);
    expect(persisted).not.toContain(secretInput);
    expect(persisted).not.toContain(secretResult);
    expect(persisted).not.toContain("<script>");
  });

  it("carries the call's args on `started` and its result TAIL on `completed`", async () => {
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk(() => [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "Bash",
                input: { command: "npm test", description: "run the suite" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "PASS 12 tests\nDone in 4s",
              },
            ],
          },
        },
        { type: "result", subtype: "success", result: "done" },
      ])
    );
    const events: LaneEvent[] = [];

    const handle = await driver.start(
      { taskId: "task-detail", brief: "run tests" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );
    await handle.wait();

    const lifecycle = events.filter(
      (event) => event.metadata.toolActivity !== undefined
    );
    expect(toolDetail(lifecycle[0]!)).toEqual({
      args: "command: npm test\ndescription: run the suite",
      argsTruncated: false,
    });
    expect(toolDetail(lifecycle[1]!)).toEqual({
      result: "PASS 12 tests\nDone in 4s",
      resultTruncated: false,
    });
  });

  it("carries bounded structured paths only for Edit/Write-family calls", async () => {
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk(() => [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "edit-1",
                name: "Edit",
                input: { file_path: "src/auth guard.ts", new_string: "safe" },
              },
              {
                type: "tool_use",
                id: "read-1",
                name: "Read",
                input: { file_path: "src/secret.ts" },
              },
            ],
          },
        },
        { type: "result", subtype: "success", result: "done" },
      ])
    );
    const events: LaneEvent[] = [];
    const handle = await driver.start(
      { taskId: "task-paths", brief: "edit safely" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );
    await handle.wait();

    const activities = events
      .map((event) => event.metadata.toolActivity)
      .filter((value): value is Record<string, unknown> =>
        Boolean(value && typeof value === "object")
      );
    expect(activities.find((activity) => activity.tool === "Edit")).toMatchObject({
      fileMutation: true,
      paths: ["src/auth guard.ts"],
    });
    expect(activities.find((activity) => activity.tool === "Read")).not.toHaveProperty(
      "paths"
    );
  });

  it("BOUNDS a 100 MB tool result at the source and flags the truncation", async () => {
    const huge = `${"n".repeat(100 * 1024 * 1024)}\nError: exit 1`;
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk(() => [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "Bash",
                input: `find / ${"x".repeat(10 * 1024 * 1024)}`,
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: huge },
            ],
          },
        },
        { type: "result", subtype: "success", result: "done" },
      ])
    );
    const events: LaneEvent[] = [];

    const handle = await driver.start(
      { taskId: "task-huge", brief: "search everything" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );
    await handle.wait();

    const lifecycle = events.filter(
      (event) => event.metadata.toolActivity !== undefined
    );
    const started = toolDetail(lifecycle[0]!)!;
    const completed = toolDetail(lifecycle[1]!)!;

    expect(String(started.args)).toHaveLength(TOOL_ACTIVITY_ARGS_CHARS);
    expect(started.argsTruncated).toBe(true);
    expect(String(started.args).startsWith("find / ")).toBe(true);
    expect(String(completed.result)).toHaveLength(TOOL_ACTIVITY_RESULT_CHARS);
    expect(completed.resultTruncated).toBe(true);
    // The END of the output survived — that is where the error is.
    expect(String(completed.result).endsWith("Error: exit 1")).toBe(true);
  });

  it("names the subject of the governance decision it just recorded", async () => {
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk((options) => {
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: unknown
        ) => Promise<unknown>;
        void canUseTool("Bash", { command: "rm -rf /" });
        return [{ type: "result", subtype: "success", result: "ok" }];
      })
    );
    const events: LaneEvent[] = [];

    const handle = await driver.start(
      { taskId: "task-approval", brief: "delete things" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "deny", message: "no" }),
      }
    );
    await handle.wait();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const verdict = events.find((event) => event.message.endsWith(" denied"));
    expect(toolDetail(verdict!)).toEqual({
      args: "command: rm -rf /",
      argsTruncated: false,
    });
  });

  it("announces the vendor session id exactly once, at first knowledge (P0.1 Slice A)", async () => {
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk(() => [
        { type: "system", subtype: "init", session_id: "claude-sess-1" },
        // A second system message repeating the id must NOT re-announce.
        { type: "system", subtype: "status", session_id: "claude-sess-1" },
        { type: "result", subtype: "success", result: "done" },
      ])
    );
    const announced: string[] = [];

    const handle = await driver.start(
      { taskId: "task-1", brief: "fix it" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
        onVendorSessionId: (vendorSessionId) => announced.push(vendorSessionId),
      }
    );
    await handle.wait();

    expect(announced).toEqual(["claude-sess-1"]);
  });

  it("routes canUseTool through the approval bridge and denies on deny", async () => {
    let bridgeDecision: unknown;
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk((options) => {
        // Simulate the SDK invoking canUseTool during the run.
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: unknown
        ) => Promise<unknown>;
        void canUseTool("Bash", { command: "rm -rf /" }).then((decision) => {
          bridgeDecision = decision;
        });
        return [{ type: "result", subtype: "success", result: "ok" }];
      })
    );

    const handle = await driver.start(
      { taskId: "task-1", brief: "risky" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({
          behavior: "deny",
          message: "human said no",
        }),
      }
    );
    await handle.wait();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(bridgeDecision).toMatchObject({
      behavior: "deny",
      message: "human said no",
    });
  });

  it("marks only the last concurrent approval as fully resolved", async () => {
    let capturedOptions: Record<string, unknown> = {};
    let releaseStream: () => void = () => undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const driver = new ClaudeSessionDriver(async () => ({
      query: ({ options }) => {
        capturedOptions = options;
        return {
          async *[Symbol.asyncIterator]() {
            await streamGate;
            yield { type: "result", subtype: "success", result: "done" };
          },
          interrupt: async () => undefined,
        };
      },
    }));
    const approvals: Array<
      (decision: { behavior: "allow" }) => void
    > = [];
    const events: LaneEvent[] = [];
    const handle = await driver.start(
      { taskId: "task-concurrent-approvals", brief: "two gated tools" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: () =>
          new Promise((resolve) => {
            approvals.push(resolve);
          }),
      }
    );
    const canUseTool = capturedOptions.canUseTool as (
      toolName: string,
      input: unknown
    ) => Promise<unknown>;
    const first = canUseTool("Bash", { command: "first" });
    const second = canUseTool("Write", { path: "second" });
    expect(approvals).toHaveLength(2);

    approvals[0]!({ behavior: "allow" });
    await first;
    expect(
      events.filter((event) => event.metadata.approvalResolved === true)
    ).toHaveLength(0);

    approvals[1]!({ behavior: "allow" });
    await second;
    expect(
      events.filter((event) => event.metadata.approvalResolved === true)
    ).toHaveLength(1);

    releaseStream();
    await expect(handle.wait()).resolves.toMatchObject({ exitCode: 0 });
  });

  it("settles exit 130 after abort even when iterator and interrupt never settle", async () => {
    const controller = new AbortController();
    let sdkAbortController: AbortController | undefined;
    const interrupt = vi.fn(
      () => new Promise<void>(() => undefined)
    );
    const driver = new ClaudeSessionDriver(async () => ({
      query: ({ options }) => {
        sdkAbortController = options.abortController as AbortController;
        return {
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise<IteratorResult<SdkMessage>>(() => undefined),
          };
        },
        interrupt,
        };
      },
    }), { interruptSettleTimeoutMs: 10 });
    const handle = await driver.start(
      {
        taskId: "task-stubborn-sdk",
        brief: "wait forever",
        signal: controller.signal,
      },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    controller.abort(new Error("runner authority lost"));
    await expect(mustSettleWithin(handle.wait())).resolves.toEqual({
      exitCode: 130,
      output: "",
    });
    expect(interrupt).toHaveBeenCalledOnce();
    expect(sdkAbortController?.signal.aborted).toBe(true);
  });

  it("waits for abort-driven SDK cleanup before reporting interruption", async () => {
    const controller = new AbortController();
    let cleaned = false;
    const driver = new ClaudeSessionDriver(async () => ({
      query: ({ options }) => {
        const sdkAbortController =
          options.abortController as AbortController;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<SdkMessage>>((resolve) => {
                  sdkAbortController.signal.addEventListener(
                    "abort",
                    () => {
                      setTimeout(() => {
                        cleaned = true;
                        resolve({ done: true, value: undefined });
                      }, 15);
                    },
                    { once: true }
                  );
                }),
            };
          },
          interrupt: () => new Promise<void>(() => undefined),
        };
      },
    }), { interruptSettleTimeoutMs: 100 });
    const handle = await driver.start(
      {
        taskId: "task-abort-cleanup",
        brief: "clean up before returning",
        signal: controller.signal,
      },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    controller.abort(new Error("runner authority lost"));
    await expect(mustSettleWithin(handle.wait())).resolves.toEqual({
      exitCode: 130,
      output: "",
    });
    expect(cleaned).toBe(true);
  });

  it("treats interruption after a completed SDK query as an idempotent no-op", async () => {
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk(() => [
        { type: "result", subtype: "success", result: "already done" },
      ])
    );
    const handle = await driver.start(
      { taskId: "task-completed-interrupt", brief: "finish first" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    await expect(handle.wait()).resolves.toEqual({
      exitCode: 0,
      output: "already done",
    });
    await expect(mustSettleWithin(handle.interrupt())).resolves.toBeUndefined();
  });

  it("bounds and redacts SDK errors before emitting them", async () => {
    const secrets = [
      "AZURE_OPENAI_API_KEY=AZURE_SECRET_VALUE",
      "MUON_API_TOKEN=MUON_SECRET_VALUE",
      '{"CUSTOM_PROVIDER_SECRET":"JSON_SECRET_VALUE"}',
      "Authorization: Basic BASIC_SECRET_VALUE",
      "https://example.test?api_key=URL_SECRET_VALUE",
    ];
    const driver = new ClaudeSessionDriver(async () => ({
      query: () => ({
        async *[Symbol.asyncIterator]() {
          throw new Error(`${secrets.join(" ")} ${"x".repeat(1_000)}`);
        },
        interrupt: async () => undefined,
      }),
    }));
    const events: LaneEvent[] = [];
    const handle = await driver.start(
      { taskId: "task-redacted-error", brief: "fail safely" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    await expect(handle.wait()).resolves.toMatchObject({ exitCode: 1 });
    const failure = events.find((event) => event.kind === "task.blocked");
    for (const secret of [
      "AZURE_SECRET_VALUE",
      "MUON_SECRET_VALUE",
      "JSON_SECRET_VALUE",
      "BASIC_SECRET_VALUE",
      "URL_SECRET_VALUE",
    ]) {
      expect(failure?.message).not.toContain(secret);
    }
    expect(failure?.message.length).toBeLessThanOrEqual(
      "Claude session error: ".length + 500
    );
  });

  it("uses strict isolated MCP settings and exact callback preauthorization", async () => {
    let capturedOptions: Record<string, unknown> = {};
    const bridge = vi.fn(async () => ({ behavior: "allow" as const }));
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk((options) => {
        capturedOptions = options;
        return [{ type: "result", subtype: "success", result: "ok" }];
      })
    );
    const handle = await driver.start(
      {
        taskId: "task-1",
        brief: "safe permissions",
        profile: {
          ...emptyLaneProfile,
          allowedTools: [
            "Read*",
            "mcp__muon__memory_preedit",
            "mcp__muon__*",
            "Bash(npm test:*)",
            "WebFetch",
          ],
          deniedTools: ["WebFetch"],
        },
      },
      {
        onEvent: () => undefined,
        onApprovalRequest: bridge,
      }
    );
    const canUseTool = capturedOptions.canUseTool as (
      toolName: string,
      input: unknown
    ) => Promise<Record<string, unknown>>;

    expect(capturedOptions.strictMcpConfig).toBe(true);
    expect(capturedOptions.settingSources).toEqual([]);
    expect(capturedOptions.skills).toEqual([]);
    expect(capturedOptions.settings).toEqual({
      disableClaudeAiConnectors: true,
    });
    expect(capturedOptions.allowedTools).toBeUndefined();
    await expect(
      canUseTool("ReadFile", { file_path: "src/a.ts" })
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      canUseTool("mcp__muon__memory_preedit", { target: "runLoop" })
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(bridge).not.toHaveBeenCalled();
    await expect(
      canUseTool("mcp__muon__task_context", { taskId: "task-1" })
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(bridge).toHaveBeenCalledOnce();
    await expect(
      canUseTool("WebFetch", { url: "https://example.com" })
    ).resolves.toMatchObject({ behavior: "deny" });
    expect(bridge).toHaveBeenCalledOnce();
    // Scoped SDK rules cannot be safely evaluated from the tool name alone, so
    // they stay human-gated instead of being broadened to all Bash calls.
    await expect(
      canUseTool("Bash", { command: "npm test" })
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(bridge).toHaveBeenCalledTimes(2);
    await handle.wait();
  });

  it("applies MCP wildcard denies before an overlapping exact allow", async () => {
    let capturedOptions: Record<string, unknown> = {};
    const bridge = vi.fn(async () => ({ behavior: "allow" as const }));
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk((options) => {
        capturedOptions = options;
        return [{ type: "result", subtype: "success", result: "ok" }];
      })
    );

    const handle = await driver.start(
      {
        taskId: "task-deny-wildcard",
        brief: "do not ship",
        profile: {
          ...emptyLaneProfile,
          allowedTools: ["mcp__muon__ship"],
          deniedTools: ["mcp__muon__*"],
        },
      },
      {
        onEvent: () => undefined,
        onApprovalRequest: bridge,
      }
    );
    const canUseTool = capturedOptions.canUseTool as (
      toolName: string,
      input: unknown
    ) => Promise<Record<string, unknown>>;

    await expect(canUseTool("mcp__muon__ship", {})).resolves.toMatchObject({
      behavior: "deny",
    });
    expect(bridge).not.toHaveBeenCalled();
    await handle.wait();
  });

  it("rejects duplicate MCP server names before the SDK query", async () => {
    const query = vi.fn(() =>
      fakeSdk(() => []).query({ prompt: "", options: {} })
    );
    const driver = new ClaudeSessionDriver(async () => ({ query }));
    let thrown: unknown;

    try {
      await driver.start(
        {
          taskId: "task-duplicate-mcp",
          brief: "must not launch",
          profile: {
            ...emptyLaneProfile,
            mcpServers: [
              {
                name: "muon",
                command: "trusted-muon",
                args: [],
                env: { MUON_API_TOKEN: "first-secret" },
              },
              {
                name: "muon",
                command: "replacement",
                args: [],
                env: { REPLACEMENT_SECRET: "second-secret" },
              },
            ],
          },
        },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      );
    } catch (error) {
      thrown = error;
    }

    expect(query).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/duplicate MCP server name.*muon/i);
    expect(message.length).toBeLessThanOrEqual(128);
    expect(message).not.toContain("first-secret");
    expect(message).not.toContain("second-secret");
  });

  it("fails with an actionable error when the Agent SDK is missing", async () => {
    const driver = new ClaudeSessionDriver(async () => {
      throw new Error("module not found");
    });

    await expect(
      driver.start(
        { taskId: "task-1", brief: "x" },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      )
    ).rejects.toThrow(/claude-agent-sdk/);
  });

  it("does not call the SDK after authority is lost while the SDK loads", async () => {
    const controller = new AbortController();
    const query = vi.fn(() => fakeSdk(() => []).query({
      prompt: "",
      options: {},
    }));
    const driver = new ClaudeSessionDriver(async () => {
      controller.abort();
      return { query };
    });

    await expect(
      driver.start(
        {
          taskId: "task-1",
          brief: "must not launch",
          signal: controller.signal,
        },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      )
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(query).not.toHaveBeenCalled();
  });

  it("interrupts a launched SDK query immediately when authority is lost", async () => {
    const controller = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fallback = setTimeout(finish, 25);
    const interrupt = vi.fn(async () => {
      finish();
    });
    const stream = {
      async *[Symbol.asyncIterator]() {
        await finished;
      },
      interrupt,
    };
    const driver = new ClaudeSessionDriver(async () => ({
      query: () => stream,
    }));

    const handle = await driver.start(
      {
        taskId: "task-1",
        brief: "stop on lease loss",
        signal: controller.signal,
      },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    controller.abort();
    await handle.wait();
    clearTimeout(fallback);

    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("resume passes the vendor session id to the SDK", async () => {
    let capturedOptions: Record<string, unknown> = {};
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk((options) => {
        capturedOptions = options;
        return [{ type: "result", subtype: "success" }];
      })
    );

    const handle = await driver.start(
      { taskId: "task-1", brief: "continue", resumeVendorSessionId: "claude-sess-1" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );
    await handle.wait();

    expect(capturedOptions.resume).toBe("claude-sess-1");
  });
  it("wires the SDK's stderr callback to the caller's diagnostic sink", async () => {
    // The SDK owns the `claude` process; its `stderr` option is the only place a
    // provider quota/billing rejection shows up while the launch is still
    // hanging. Without it a stall report could only guess at the cause.
    let capturedOptions: Record<string, unknown> = {};
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk((options) => {
        capturedOptions = options;
        return [{ type: "result", subtype: "success" }];
      })
    );

    const chunks: string[] = [];
    const handle = await driver.start(
      { taskId: "task-1", brief: "go" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
        onDiagnostic: (chunk) => chunks.push(chunk),
      }
    );
    await handle.wait();

    expect(driver.forwardsVendorStderr).toBe(true);
    expect(typeof capturedOptions.stderr).toBe("function");
    (capturedOptions.stderr as (data: string) => void)(
      "ERROR: You hit your spend cap set by the owner of your workspace."
    );
    expect(chunks.join("")).toContain("You hit your spend cap");
  });

  // ── MUON MCP readiness gate ───────────────────────────────────────────────
  // The SDK connects `mcpServers` asynchronously, so a brief sent at query()
  // time reaches a model whose `muon` server is still `pending` and whose MUON
  // tools do not exist yet. That produced a real run that hunted for `dispatch`
  // ~197 times, then fell back to provider-native subagents and shipped nothing
  // governed. The brief is now withheld until the handshake is verified.
  describe("MUON MCP readiness gate", () => {
    const grants = ["mcp__muon__dispatch", "mcp__muon__ship"];
    const connected = (tools: string[]) => [
      {
        name: "muon",
        status: "connected",
        tools: tools.map((name) => ({ name })),
      },
    ];

    it("holds the brief until the muon server is connected with its granted tools", async () => {
      const sentAtPoll: number[] = [];
      const fake = fakeMcpSdk({
        statuses: [
          [{ name: "muon", status: "pending" }],
          [{ name: "muon", status: "pending" }],
          connected(["dispatch", "ship"]),
        ],
        onStatusPoll: () => sentAtPoll.push(fake.sent.length),
      });
      const driver = new ClaudeSessionDriver(async () => fake.sdk, {
        muonMcpPollIntervalMs: 1,
      });

      await driver.start(
        {
          taskId: "task-gate",
          brief: "coordinate the fleet",
          profile: muonMcpProfile(grants),
        },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Nothing was handed to the vendor on any poll, including the one that
      // observed `connected` — only after start() returned.
      expect(sentAtPoll).toEqual([0, 0, 0]);
      expect(fake.sent).toEqual(["coordinate the fleet"]);
    });

    it("ends the run without sending the brief when the muon server fails", async () => {
      const fake = fakeMcpSdk({
        statuses: [
          [
            {
              name: "muon",
              status: "failed",
              error: "spawn muon-mcp ENOENT",
            },
          ],
        ],
      });
      const driver = new ClaudeSessionDriver(async () => fake.sdk, {
        muonMcpPollIntervalMs: 1,
      });
      const events: LaneEvent[] = [];

      await expect(
        driver.start(
          {
            taskId: "task-failed-mcp",
            brief: "coordinate the fleet",
            profile: muonMcpProfile(grants),
          },
          {
            onEvent: (event) => events.push(event),
            onApprovalRequest: async () => ({ behavior: "allow" }),
          }
        )
      ).rejects.toThrow(/'muon' reported status 'failed'/);
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(fake.sent).toEqual([]);
      const blocked = events.find((event) => event.kind === "task.blocked");
      expect(blocked?.metadata.reason).toBe("muon-mcp-handshake-failed");
      expect(blocked?.message).toContain("spawn muon-mcp ENOENT");
      expect(blocked?.message).toContain("withheld the brief");
      // The vendor session is torn down, not left running un-briefed.
      expect(events.some((event) => event.kind === "task.completed")).toBe(
        false
      );
    });

    it("ends the run when the handshake never completes inside the bound", async () => {
      const fake = fakeMcpSdk({
        statuses: [[{ name: "muon", status: "pending" }]],
      });
      const driver = new ClaudeSessionDriver(async () => fake.sdk, {
        muonMcpReadyTimeoutMs: 0,
        muonMcpPollIntervalMs: 1,
      });

      await expect(
        driver.start(
          {
            taskId: "task-timeout-mcp",
            brief: "coordinate the fleet",
            profile: muonMcpProfile(grants),
          },
          {
            onEvent: () => undefined,
            onApprovalRequest: async () => ({ behavior: "allow" }),
          }
        )
      ).rejects.toThrow(
        /did not reach 'connected' within 0ms \(last status 'pending'\)/
      );
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(fake.sent).toEqual([]);
    });

    it("names the granted tools a connected server never exposed", async () => {
      const fake = fakeMcpSdk({ statuses: [connected(["dispatch"])] });
      const driver = new ClaudeSessionDriver(async () => fake.sdk, {
        muonMcpPollIntervalMs: 1,
      });
      let thrown: unknown;

      try {
        await driver.start(
          {
            taskId: "task-missing-tools",
            brief: "coordinate the fleet",
            profile: muonMcpProfile([
              ...grants,
              // Wildcard/scoped rules name no specific tool, so they are not
              // asserted against the inventory.
              "mcp__muon__*",
              "Bash(npm test:*)",
            ]),
          },
          {
            onEvent: () => undefined,
            onApprovalRequest: async () => ({ behavior: "allow" }),
          }
        );
      } catch (error) {
        thrown = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));

      const message = (thrown as Error).message;
      expect(message).toContain("connected but never exposed 1 granted tool");
      expect(message).toContain("mcp__muon__ship");
      expect(message).not.toContain("mcp__muon__dispatch");
      expect(fake.sent).toEqual([]);
    });

    it("fails closed when the SDK build cannot report MCP status", async () => {
      const fake = fakeMcpSdk({ statuses: [], omitStatusProbe: true });
      const driver = new ClaudeSessionDriver(async () => fake.sdk);

      await expect(
        driver.start(
          {
            taskId: "task-no-probe",
            brief: "coordinate the fleet",
            profile: muonMcpProfile(grants),
          },
          {
            onEvent: () => undefined,
            onApprovalRequest: async () => ({ behavior: "allow" }),
          }
        )
      ).rejects.toThrow(/exposes no mcpServerStatus\(\) control request/);
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(fake.sent).toEqual([]);
    });

    it("does not gate a session that was never given the muon server", async () => {
      let prompt: unknown;
      const driver = new ClaudeSessionDriver(async () => ({
        query: (params: { prompt: unknown; options: Record<string, unknown> }) => {
          prompt = params.prompt;
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "result", subtype: "success", result: "ok" };
            },
            interrupt: async () => undefined,
          };
        },
      }));

      const handle = await driver.start(
        { taskId: "task-no-muon", brief: "plain run" },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      );
      await handle.wait();

      const sent: string[] = [];
      for await (const message of prompt as AsyncIterable<{
        message: { content: string };
      }>) {
        sent.push(message.message.content);
      }
      expect(sent).toEqual(["plain run"]);
    });
  });

  // ── Permission determinism ────────────────────────────────────────────────
  // "The first Bash slipped through; the second was denied by MUON governance"
  // must be unrepresentable: the session decides against rules snapshotted
  // before the vendor existed, so the same tool decides the same way every time.
  describe("permission determinism", () => {
    async function startWithProfile(profile: {
      allowedTools: string[];
      deniedTools: string[];
    }) {
      let capturedOptions: Record<string, unknown> = {};
      const bridge = vi.fn(async () => ({
        behavior: "deny" as const,
        message:
          "MUON denied: coordinator tool is not pre-authorized and no operator watches the coordinator's approval inbox.",
      }));
      const driver = new ClaudeSessionDriver(async () =>
        fakeSdk((options) => {
          capturedOptions = options;
          return [{ type: "result", subtype: "success", result: "ok" }];
        })
      );
      const live = { ...emptyLaneProfile, ...profile };
      const handle = await driver.start(
        { taskId: "task-determinism", brief: "go", profile: live },
        { onEvent: () => undefined, onApprovalRequest: bridge }
      );
      return {
        handle,
        bridge,
        live,
        /** What the SDK was actually handed, for the options the driver owns. */
        options: capturedOptions as { disallowedTools?: string[] },
        canUseTool: capturedOptions.canUseTool as (
          toolName: string,
          input: unknown
        ) => Promise<Record<string, unknown>>,
      };
    }

    it("denies the FIRST orchestrator Bash exactly as it denies the tenth", async () => {
      // The orchestrator's bounded grant is MCP-only: no Bash, ever.
      const { canUseTool, handle, bridge } = await startWithProfile({
        allowedTools: ["mcp__muon__dispatch", "mcp__muon__ship"],
        deniedTools: [],
      });

      const decisions = [];
      for (let call = 0; call < 10; call += 1) {
        decisions.push(await canUseTool("Bash", { command: "npm test" }));
      }

      expect(new Set(decisions.map((d) => JSON.stringify(d))).size).toBe(1);
      expect(decisions[0]).toMatchObject({ behavior: "deny" });
      expect(bridge).toHaveBeenCalledTimes(10);
      await handle.wait();
    });

    it("keeps profile-level verdicts identical across repeated identical calls", async () => {
      const { canUseTool, handle } = await startWithProfile({
        allowedTools: ["Read"],
        deniedTools: ["WebFetch"],
      });

      for (let call = 0; call < 5; call += 1) {
        await expect(
          canUseTool("Read", { file_path: "src/a.ts" })
        ).resolves.toMatchObject({ behavior: "allow" });
        await expect(
          canUseTool("WebFetch", { url: "https://example.com" })
        ).resolves.toMatchObject({
          behavior: "deny",
          message: "MUON denied 'WebFetch' by the governed lane profile.",
        });
      }
      await handle.wait();
    });

    it("ignores tool-rule mutations made after the session started", async () => {
      const { canUseTool, handle, live, bridge } = await startWithProfile({
        allowedTools: ["mcp__muon__dispatch"],
        deniedTools: ["WebFetch"],
      });

      await expect(
        canUseTool("Bash", { command: "npm test" })
      ).resolves.toMatchObject({ behavior: "deny" });

      // A late widening of the live profile object must not reach a running
      // session; narrowing a running session is interrupt(), not mutation.
      live.allowedTools.push("Bash");
      live.deniedTools.length = 0;

      await expect(
        canUseTool("Bash", { command: "npm test" })
      ).resolves.toMatchObject({ behavior: "deny" });
      await expect(
        canUseTool("WebFetch", { url: "https://example.com" })
      ).resolves.toMatchObject({
        behavior: "deny",
        message: "MUON denied 'WebFetch' by the governed lane profile.",
      });
      expect(bridge).toHaveBeenCalledTimes(2);
      await handle.wait();
    });

    it("TODO 1.16: the native `Task` spawner is denied LOCALLY, on the interactive channel too", async () => {
      // The interactive channel never touches `compileRunProfile` —
      // `startManagedSession` hands the dispatch profile straight to this driver —
      // so the compiler's categorical `--disallowedTools Task` did not reach
      // claude's DEFAULT transport. `Task` arrived at `canUseTool`, where
      // `classifyToolAction` has no class for it, and became an ordinary approval:
      // fast-denied for a coordinator with no standing approver, but a
      // human-approvable GATE for a worker. A gate is not a suppression, and the
      // registry claimed one. So the assertion is specifically that the verdict is
      // LOCAL — the bridge is never consulted — and that the SDK is told as well.
      const { canUseTool, handle, bridge, options } = await startWithProfile({
        allowedTools: [],
        deniedTools: [],
      });

      await expect(canUseTool("Task", { prompt: "spawn" })).resolves.toMatchObject(
        { behavior: "deny" }
      );
      expect(bridge).not.toHaveBeenCalled();
      expect(options.disallowedTools).toContain("Task");
      await handle.wait();
    });

    it("decides concurrent identical calls identically", async () => {
      const { canUseTool, handle } = await startWithProfile({
        allowedTools: ["mcp__muon__dispatch"],
        deniedTools: [],
      });

      const decisions = await Promise.all(
        Array.from({ length: 8 }, () =>
          canUseTool("Bash", { command: "npm test" })
        )
      );

      expect(new Set(decisions.map((d) => JSON.stringify(d))).size).toBe(1);
      await handle.wait();
    });
  });

  it("omits the SDK stderr option entirely when no sink was supplied", async () => {
    let capturedOptions: Record<string, unknown> = {};
    const driver = new ClaudeSessionDriver(async () =>
      fakeSdk((options) => {
        capturedOptions = options;
        return [{ type: "result", subtype: "success" }];
      })
    );

    const handle = await driver.start(
      { taskId: "task-1", brief: "go" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );
    await handle.wait();

    expect("stderr" in capturedOptions).toBe(false);
  });
});
