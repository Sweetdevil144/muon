import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_RPC,
  CodexSessionDriver,
  createCodexStderrTail,
  type RpcTransport,
} from "../src/codex-session-driver.js";
import {
  MUON_CONTEXT_TOOL_NAMES,
  laneProfileSchema,
  TOOL_ACTIVITY_ARGS_CHARS,
  TOOL_ACTIVITY_RESULT_CHARS,
  type LaneEvent,
} from "@muon/protocol";

type Message = Parameters<RpcTransport["send"]>[0];

/** In-memory fake of the codex app-server JSON-RPC endpoint (v2). */
function fakeAppServer(
  onSend?: (message: Message) => void,
  override?: (message: Message) => Message | undefined
) {
  const received: Message[] = [];
  let deliver: (message: Message) => void = () => undefined;
  let resolveExit: (code: number) => void = () => undefined;
  let exitSettled = false;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const exit = (code: number) => {
    if (exitSettled) return;
    exitSettled = true;
    resolveExit(code);
  };
  const tools = Object.fromEntries(
    MUON_CONTEXT_TOOL_NAMES.map((name) => [
      name,
      { name, inputSchema: { type: "object" } },
    ])
  );

  const transport: RpcTransport = {
    send: (message) => {
      received.push(message);
      onSend?.(message);
      const overridden = override?.(message);
      if (overridden) {
        deliver({ id: message.id, ...overridden });
        return;
      }
      if (message.method === CODEX_RPC.initialize) {
        deliver({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.144.4",
            codexHome: "/tmp/codex",
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      }
      if (message.method === CODEX_RPC.threadStart) {
        deliver({
          id: message.id,
          result: {
            thread: { id: "thread-7" },
            model: "codex-test",
            modelProvider: "openai",
            cwd: "/repo",
            runtimeWorkspaceRoots: ["/repo"],
            instructionSources: [],
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: {
              type: "workspaceWrite",
              writableRoots: ["/repo"],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
            activePermissionProfile: null,
            reasoningEffort: null,
            multiAgentMode: "explicitRequestOnly",
          },
        });
        // Production waits for this before preflight when muon is injected.
        setTimeout(() => {
          deliver({
            method: CODEX_RPC.mcpStartupStatus,
            params: {
              threadId: "thread-7",
              name: "muon",
              status: "ready",
              error: null,
            },
          });
        }, 0);
      }
      if (message.method === CODEX_RPC.accountRead) {
        deliver({
          id: message.id,
          result: { account: null, requiresOpenaiAuth: true },
        });
      }
      if (message.method === CODEX_RPC.configRead) {
        deliver({
          id: message.id,
          result: {
            config: {
              model_provider: "openai",
              approval_policy: "on-request",
              sandbox_mode: "workspace-write",
              apps: null,
            },
            origins: {},
            layers: null,
          },
        });
      }
      if (message.method === CODEX_RPC.configRequirementsRead) {
        deliver({ id: message.id, result: { requirements: null } });
      }
      if (message.method === CODEX_RPC.pluginList) {
        deliver({
          id: message.id,
          result: {
            marketplaces: [],
            marketplaceLoadErrors: [],
            featuredPluginIds: [],
          },
        });
      }
      if (message.method === CODEX_RPC.mcpServerStatusList) {
        deliver({
          id: message.id,
          result: {
            data: [
              {
                name: "muon",
                serverInfo: null,
                tools,
                resources: [],
                resourceTemplates: [],
                authStatus: "unsupported",
              },
            ],
            nextCursor: null,
          },
        });
      }
      if (message.method === CODEX_RPC.turnStart) {
        deliver({ id: message.id, result: {} });
      }
    },
    onMessage: (handler) => {
      deliver = handler;
    },
    close: vi.fn(async () => {
      exit(0);
    }),
    waitForExit: async () => exitPromise,
  };

  return {
    transport,
    received,
    emit: (message: Message) => deliver(message),
    exit,
  };
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

describe("CodexSessionDriver", () => {
  it("initializes, opens a thread, and streams agent messages as events", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);
    const events: LaneEvent[] = [];

    const handle = await driver.start(
      { taskId: "task-1", brief: "fix the bug" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    expect(handle.vendorSessionId).toBe("thread-7");
    expect(server.received.map((m) => m.method)).toEqual([
      CODEX_RPC.initialize,
      CODEX_RPC.initialized,
      CODEX_RPC.threadStart,
      CODEX_RPC.accountRead,
      CODEX_RPC.configRead,
      CODEX_RPC.configRequirementsRead,
      CODEX_RPC.pluginList,
      CODEX_RPC.mcpServerStatusList,
      CODEX_RPC.turnStart,
    ]);
    expect(
      server.received.find((message) => message.method === CODEX_RPC.pluginList)
        ?.params
    ).toEqual({
      cwds: [],
      marketplaceKinds: ["local"],
    });
    expect(
      server.received.some((message) => message.method === "app/list")
    ).toBe(false);

    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "working on it" },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });

    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("working on it");
    expect(events.some((e) => e.kind === "task.progress")).toBe(true);
    expect(events.some((e) => e.kind === "task.completed")).toBe(true);
  });

  it("binds the v2 token notification and turn latency to the completed audit event", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);
    const events: LaneEvent[] = [];
    const handle = await driver.start(
      { taskId: "task-usage", brief: "measure this turn" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    server.emit({
      method: CODEX_RPC.tokenUsageUpdated,
      params: {
        threadId: "thread-7",
        turnId: "turn-9",
        tokenUsage: {
          total: {
            inputTokens: 1_000,
            cachedInputTokens: 600,
            outputTokens: 100,
            reasoningOutputTokens: 20,
            totalTokens: 1_100,
          },
          last: {
            inputTokens: 300,
            cachedInputTokens: 200,
            outputTokens: 40,
            reasoningOutputTokens: 5,
            totalTokens: 340,
          },
          modelContextWindow: 128_000,
        },
      },
    });
    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "measured" },
    });
    server.emit({
      method: CODEX_RPC.turnCompleted,
      params: {
        turn: { id: "turn-9", status: "completed", durationMs: 2_500 },
      },
    });

    await handle.wait();
    const completed = events.find((event) => event.kind === "task.completed");
    expect(completed?.metadata.usage).toEqual({
      vendor: "codex",
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 200,
      totalTokens: 340,
      latencyMs: 2_500,
      contextUsedTokens: 300,
      contextWindowTokens: 128_000,
    });
  });

  it("announces the thread id exactly once, at first knowledge (P0.1 Slice A)", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);
    const announced: string[] = [];

    const handle = await driver.start(
      { taskId: "task-1", brief: "go" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
        onVendorSessionId: (vendorSessionId) => announced.push(vendorSessionId),
      }
    );

    // Fired during start (the moment threadId is extracted), not at wait().
    expect(announced).toEqual(["thread-7"]);

    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "ok" },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
    expect(announced).toEqual(["thread-7"]);
  });

  it("preserves a distinct completed agent message after streamed deltas", async () => {
    const server = fakeAppServer();
    const events: LaneEvent[] = [];
    const driver = new CodexSessionDriver(() => server.transport);
    const handle = await driver.start(
      { taskId: "task-1", brief: "go" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "Progress update." },
    });
    server.emit({
      method: CODEX_RPC.itemCompleted,
      params: {
        item: {
          type: "agentMessage",
          text: "Final answer with different content.",
        },
      },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });

    const result = await handle.wait();
    expect(result.output).toContain("Progress update.");
    expect(result.output).toContain("Final answer with different content.");
    expect(
      events.some(
        (event) =>
          event.message === "Final answer with different content." &&
          event.metadata.outputMode === "message"
      )
    ).toBe(true);
  });

  it("reports context compaction as a marker without inventing forgotten content", async () => {
    const server = fakeAppServer();
    const events: LaneEvent[] = [];
    const driver = new CodexSessionDriver(() => server.transport);
    const handle = await driver.start(
      { taskId: "task-context", brief: "go" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    server.emit({
      method: CODEX_RPC.itemCompleted,
      params: {
        item: {
          id: "compact-7",
          type: "contextCompaction",
        },
      },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();

    const marker = events.find(
      (event) => event.metadata.contextCondensation !== undefined
    );
    expect(marker?.message).toBe("Codex reported context compaction");
    expect(marker?.metadata.contextCondensation).toEqual({
      origin: "vendor_reported",
      sourceResponseId: "codex:item:compact-7",
    });
    expect(JSON.stringify(marker)).not.toContain("summary");
    expect(JSON.stringify(marker)).not.toContain("members");
  });

  it("bridges server-initiated approvals and answers denied on deny", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);
    const events: LaneEvent[] = [];

    const handle = await driver.start(
      { taskId: "task-1", brief: "risky work" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async (request) => ({
          behavior: "deny",
          message: `not allowed: ${request.toolName}`,
        }),
      }
    );

    server.emit({
      id: 99,
      method: "command/exec/approval",
      params: { command: "rm -rf /" },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const answer = server.received.find((m) => m.id === 99 && m.result);
    expect(answer?.result).toMatchObject({ decision: "decline" });
    const persistedActivity = events.map((event) => event.message).join("\n");
    expect(persistedActivity).not.toContain("rm -rf");
    expect(
      events.some((event) => event.metadata.approvalResolved === true)
    ).toBe(true);

    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "denied path" },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });

  it("carries the approval's SUBJECT so a human can read what they refused", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);
    const events: LaneEvent[] = [];

    const handle = await driver.start(
      { taskId: "task-approval-subject", brief: "risky work" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "deny", message: "no" }),
      }
    );

    server.emit({
      id: 77,
      method: "command/exec/approval",
      params: { command: `rm -rf /${"x".repeat(10 * 1024 * 1024)}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const detail = events
      .map(
        (event) =>
          (event.metadata.toolActivity as Record<string, unknown> | undefined)
            ?.detail as Record<string, unknown> | undefined
      )
      .find(Boolean)!;
    expect(String(detail.args).startsWith("rm -rf /")).toBe(true);
    // Bounded at the source: a hostile 10 MB command cannot ride the event.
    expect(String(detail.args)).toHaveLength(TOOL_ACTIVITY_ARGS_CHARS);
    expect(detail.argsTruncated).toBe(true);
    // The activity LINE stays coordinates-only; the subject lives in `detail`.
    expect(events.map((event) => event.message).join("\n")).not.toContain(
      "rm -rf"
    );

    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });

  // This test used to pin the opposite contract: that an item lifecycle copied
  // NOTHING. That posture was reopened deliberately (Codex tool cards were blank
  // while Claude's were readable), so the test keeps its job and changes its
  // claim — the payload IS captured, and every control that makes capturing it
  // safe is still asserted here.
  it("captures a BOUNDED item payload, never the raw one, and keeps the line coordinates-only", async () => {
    const server = fakeAppServer();
    const events: LaneEvent[] = [];
    const driver = new CodexSessionDriver(() => server.transport);
    const handle = await driver.start(
      { taskId: "task-item-coordinates", brief: "work safely" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    const huge = "x".repeat(10 * 1024 * 1024);
    server.emit({
      method: CODEX_RPC.itemStarted,
      params: {
        item: {
          id: "item-1",
          type: "commandExecution",
          command: `echo ITEM_ARG_HEAD${huge}`,
        },
      },
    });
    server.emit({
      method: CODEX_RPC.itemCompleted,
      params: {
        item: {
          id: "item-1",
          type: "commandExecution",
          status: "completed",
          command: `echo ITEM_ARG_HEAD${huge}`,
          aggregatedOutput: `${huge}ITEM_OUTPUT_TAIL`,
        },
      },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();

    const activity = events.filter((event) => event.metadata.codexActivity);
    expect(activity).toHaveLength(2);

    // 1. The activity LINE stays coordinates-only; the payload lives in `detail`.
    expect(activity.map((event) => event.message).join("\n")).toBe(
      "Codex command started\nCodex command completed"
    );
    // 2. The coordinate record carries no payload, exactly as it always did —
    //    so exactly ONE copy of a vendor payload rides the event.
    const coordinates = JSON.stringify(
      activity.map((event) => event.metadata.codexActivity)
    );
    expect(coordinates).not.toContain("ITEM_ARG_HEAD");
    expect(coordinates).not.toContain("ITEM_OUTPUT_TAIL");

    // 3. The detail IS present, on the same `toolActivity.detail` shape the
    //    Claude driver emits, so @muon/core redacts it through one redactor.
    const details = activity.map(
      (event) =>
        (event.metadata.toolActivity as Record<string, unknown>)
          .detail as Record<string, unknown>
    );
    expect(String(details[0]!.args).startsWith("echo ITEM_ARG_HEAD")).toBe(true);
    // 4. Bounded at the source: a hostile 10 MB payload cannot ride the event.
    //    Args are head-kept (the command is the call's identity); results are
    //    tail-kept (the end of an output is where the error is).
    expect(String(details[0]!.args)).toHaveLength(TOOL_ACTIVITY_ARGS_CHARS);
    expect(details[0]!.argsTruncated).toBe(true);
    expect(String(details[1]!.result).endsWith("ITEM_OUTPUT_TAIL")).toBe(true);
    expect(String(details[1]!.result)).toHaveLength(
      TOOL_ACTIVITY_RESULT_CHARS
    );
    expect(details[1]!.resultTruncated).toBe(true);
  });

  it("S2: delivers the MCP token via the child env, never on argv", async () => {
    const server = fakeAppServer();
    let captured: {
      cwd?: string;
      args?: string[];
      env?: Record<string, string>;
    } = {};
    const driver = new CodexSessionDriver((cwd, args, env) => {
      captured = { cwd, args, env };
      return server.transport;
    });

    const profile = laneProfileSchema.parse({
      mcpServers: [
        {
          name: "muon",
          command: "muon-mcp",
          env: {
            MUON_API_TOKEN: "job-bound-token",
            MUON_API_BASE: "http://x",
          },
        },
      ],
    });

    const handle = await driver.start(
      { taskId: "task-1", brief: "go", profile },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    expect(captured.env?.MUON_API_TOKEN).toBe("job-bound-token");
    expect(captured.env).not.toHaveProperty("MUON_AGENT_TOKEN");
    const argv = (captured.args ?? []).join(" ");
    expect(argv).not.toContain("job-bound-token");
    expect(argv).toContain("mcp_servers.muon.env_vars=");

    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "ok" },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });

  it("uses the exact task-scoped child env for API-key evidence", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "muon-codex-preflight-"));
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const server = fakeAppServer();
    let capturedEnv: Record<string, string> | undefined;
    const driver = new CodexSessionDriver((_cwd, _args, env) => {
      capturedEnv = env;
      return server.transport;
    });
    const events: LaneEvent[] = [];

    try {
      process.env.OPENAI_API_KEY = "ambient-openai-key-must-not-win";
      const profile = laneProfileSchema.parse({
        env: {
          CODEX_HOME: codexHome,
          OPENAI_API_KEY: "task-scoped-openai-key",
        },
      });
      const handle = await driver.start(
        { taskId: "task-env", brief: "go", profile },
        {
          onEvent: (event) => events.push(event),
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      );

      expect(capturedEnv?.OPENAI_API_KEY).toBe("task-scoped-openai-key");
      const preflight = events.find(
        (event) => event.metadata.capabilityPreflight
      )?.metadata.capabilityPreflight as
        | { account?: { state?: string } }
        | undefined;
      expect(preflight?.account?.state).toBe("native-api-key");
      expect(JSON.stringify(events)).not.toContain("task-scoped-openai-key");

      server.emit({
        method: CODEX_RPC.agentMessageDelta,
        params: { delta: "ok" },
      });
      server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
      await handle.wait();
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  /**
   * The refusal MOVED, it did not disappear.
   *
   * It used to fire in the capability preflight, from a child that could still
   * read the operator's `~/.codex/config.toml` and had discovered the active
   * custom provider's credential was missing. The ambient-config guard means
   * the child can no longer read that file at all — which also means it would
   * quietly use the built-in `openai` provider, i.e. a DIFFERENT ACCOUNT than
   * the operator configured. So the same rule ("never start a turn that will
   * surprise the operator about which account it used") is now enforced one
   * layer earlier, by the only code that can still see both configurations, and
   * it refuses whether or not the credential happens to be present.
   */
  it("blocks an active custom provider before turn/start, because a governed child cannot use it", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "muon-codex-missing-provider-"));
    const previousHome = process.env.CODEX_HOME;
    const previousAzure = process.env.AZURE_OPENAI_API_KEY;
    const events: LaneEvent[] = [];
    const server = fakeAppServer(undefined, (message) => {
      if (message.method === CODEX_RPC.threadStart) {
        return {
          result: {
            thread: { id: "thread-7" },
            model: "provider-default",
            modelProvider: "azure",
            cwd: "/repo",
            approvalPolicy: "on-request",
            sandbox: {
              type: "workspaceWrite",
              writableRoots: ["/repo"],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
          },
        };
      }
      if (message.method === CODEX_RPC.configRead) {
        return {
          result: {
            config: {
              model_provider: "azure",
              approval_policy: "on-request",
              sandbox_mode: "workspace-write",
              apps: null,
            },
            origins: {},
            layers: null,
          },
        };
      }
      return undefined;
    });
    const driver = new CodexSessionDriver(() => server.transport);

    try {
      writeFileSync(
        join(codexHome, "config.toml"),
        [
          'model_provider = "azure"',
          "",
          "[model_providers.azure]",
          'env_key = "AZURE_OPENAI_API_KEY"',
        ].join("\n")
      );
      process.env.CODEX_HOME = codexHome;
      delete process.env.AZURE_OPENAI_API_KEY;

      await expect(
        driver.start(
          { taskId: "task-missing-provider", brief: "must not start" },
          {
            onEvent: (event) => events.push(event),
            onApprovalRequest: async () => ({ behavior: "allow" }),
          }
        )
      ).rejects.toThrow(/custom model provider 'azure'/i);

      expect(server.received.map((message) => message.method)).not.toContain(
        CODEX_RPC.turnStart
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "task.blocked",
            message: expect.stringMatching(/custom model provider 'azure'/i),
          }),
        ])
      );
      // Refused BEFORE the guard home was even consulted, so the run never
      // reached the point where it could have silently used another account.
      expect(events.some((event) => event.kind === "task.progress")).toBe(false);
      expect(JSON.stringify(events)).not.toContain("AZURE_OPENAI_API_KEY");
    } finally {
      if (previousHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousHome;
      }
      if (previousAzure === undefined) {
        delete process.env.AZURE_OPENAI_API_KEY;
      } else {
        process.env.AZURE_OPENAI_API_KEY = previousAzure;
      }
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("sends explicit profile policy on thread/start and attests the effective response", async () => {
    const server = fakeAppServer();
    const events: LaneEvent[] = [];
    const driver = new CodexSessionDriver(() => server.transport);
    const profile = laneProfileSchema.parse({
      model: "codex-test",
      permissionMode: "default",
      sandbox: "workspace-write",
    });

    const handle = await driver.start(
      { taskId: "task-policy", brief: "go", cwd: "/repo", profile },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    const threadStartParams = server.received.find(
      (message) => message.method === CODEX_RPC.threadStart
    )?.params as Record<string, unknown>;
    expect(threadStartParams).toMatchObject({
      cwd: "/repo",
      model: "codex-test",
      // NOT "on-request": that mode is measured (0.145.0) to mean "the model
      // decides", i.e. zero approval requests across a write-authority
      // session. A must-ask MUON mode on this transport is `untrusted` — the
      // mode that actually routes every action to MUON's bridge.
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
    // REGRESSION (resume backlink): the thread must PERSIST. `ephemeral: true`
    // is measured (0.145.0) to make app-server write NO rollout at all —
    // the stamped thread id then names a session codex never saved, and the
    // desktop's resume affordance dies with "No saved session found with ID".
    expect(threadStartParams.ephemeral).toBeUndefined();
    const preflight = events.find(
      (event) => event.metadata.capabilityPreflight
    )?.metadata.capabilityPreflight as
      | {
          policy?: {
            source?: string;
            approvalPolicy?: string;
            sandboxMode?: string;
          };
        }
      | undefined;
    expect(preflight?.policy).toMatchObject({
      source: "thread",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    });

    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "ok" },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });

  it("blocks before turn/start when supported MCP inventory is malformed", async () => {
    const server = fakeAppServer(undefined, (message) =>
      message.method === CODEX_RPC.mcpServerStatusList
        ? {
            result: {
              data: [
                {
                  name: "muon",
                  tools: {
                    memory_search: {
                      name: "memory_recall",
                      inputSchema: { type: "object" },
                    },
                  },
                  authStatus: "unsupported",
                },
              ],
              nextCursor: null,
            },
          }
        : undefined
    );
    const events: LaneEvent[] = [];
    const driver = new CodexSessionDriver(() => server.transport);

    await expect(
      driver.start(
        { taskId: "task-block", brief: "must not start" },
        {
          onEvent: (event) => events.push(event),
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      )
    ).rejects.toThrow(/capability preflight blocked/i);

    expect(
      server.received.map((message) => message.method)
    ).not.toContain(CODEX_RPC.turnStart);
    expect(events.some((event) => event.kind === "task.blocked")).toBe(true);
  });

  it("keeps compatibility behavior when MCP inventory is unsupported", async () => {
    const server = fakeAppServer(undefined, (message) =>
      message.method === CODEX_RPC.mcpServerStatusList
        ? { error: { code: -32601, message: "method not found" } }
        : undefined
    );
    const events: LaneEvent[] = [];
    const driver = new CodexSessionDriver(() => server.transport);

    const handle = await driver.start(
      { taskId: "task-compatible", brief: "continue" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    expect(
      server.received.map((message) => message.method)
    ).toContain(CODEX_RPC.turnStart);
    const preflight = events.find(
      (event) => event.metadata.capabilityPreflight
    )?.metadata.capabilityPreflight as
      | { posture?: string; mcp?: { inventory?: string } }
      | undefined;
    expect(preflight).toMatchObject({
      posture: "compatibility-import",
      mcp: { inventory: "unsupported" },
    });

    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "ok" },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });

  it("fails closed when Codex completes with no assistant output", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);
    const handle = await driver.start(
      { taskId: "task-1", brief: "say hi" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    const result = await handle.wait();
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/no assistant output/i);
  });

  it("ends the turn when app-server exits after turn/start is acknowledged", async () => {
    const server = fakeAppServer();
    const events: LaneEvent[] = [];
    const driver = new CodexSessionDriver(() => server.transport);
    const handle = await driver.start(
      { taskId: "task-exit", brief: "do the work" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    server.exit(9);

    await expect(handle.wait()).resolves.toMatchObject({
      exitCode: 9,
    });
    expect(
      events.find(
        (event) =>
          event.kind === "task.blocked" &&
          event.metadata.reason === "provider-exit"
      )?.message
    ).toMatch(/exited before turn\/completed.*code 9/i);
  });

  it("ends an admitted turn after bounded protocol inactivity", async () => {
    const server = fakeAppServer();
    const events: LaneEvent[] = [];
    const driver = new CodexSessionDriver(() => server.transport, {
      turnIdleTimeoutMs: 20,
    });
    const handle = await driver.start(
      { taskId: "task-idle", brief: "do the work" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    const result = await handle.wait();

    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.output).toMatch(/no protocol activity/i);
    expect(server.transport.close).toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.kind === "task.blocked" &&
          event.metadata.reason === "provider-idle-timeout"
      )
    ).toBe(true);
  });

  it("pauses protocol-idle expiry while a human approval is pending", async () => {
    const server = fakeAppServer();
    let resolveApproval!: () => void;
    const approval = new Promise<{ behavior: "allow" }>((resolve) => {
      resolveApproval = () => resolve({ behavior: "allow" });
    });
    const driver = new CodexSessionDriver(() => server.transport, {
      turnIdleTimeoutMs: 20,
    });
    const handle = await driver.start(
      { taskId: "task-approval-wait", brief: "do gated work" },
      {
        onEvent: () => undefined,
        onApprovalRequest: () => approval,
      }
    );
    let settled = false;
    void handle.wait().then(() => {
      settled = true;
    });

    server.emit({
      id: 71,
      method: "command/exec/approval",
      params: { command: "sensitive command" },
    });
    await new Promise((resolve) => setTimeout(resolve, 45));

    expect(settled).toBe(false);
    expect(server.transport.close).not.toHaveBeenCalled();

    resolveApproval();
    await new Promise((resolve) => setTimeout(resolve, 5));
    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "approved work completed" },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await expect(handle.wait()).resolves.toMatchObject({ exitCode: 0 });
  });

  it("keeps protocol idle paused until every concurrent approval settles", async () => {
    const server = fakeAppServer();
    const approvals: Array<
      (decision: { behavior: "allow" }) => void
    > = [];
    const events: LaneEvent[] = [];
    const driver = new CodexSessionDriver(() => server.transport, {
      turnIdleTimeoutMs: 20,
    });
    const handle = await driver.start(
      { taskId: "task-concurrent-approvals", brief: "do gated work" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: () =>
          new Promise((resolve) => {
            approvals.push(resolve);
          }),
      }
    );

    server.emit({
      id: 71,
      method: "command/exec/approval",
      params: { command: "first sensitive command" },
    });
    server.emit({
      id: 72,
      method: "command/exec/approval",
      params: { command: "second sensitive command" },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(approvals).toHaveLength(2);

    approvals[0]!({ behavior: "allow" });
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(server.transport.close).not.toHaveBeenCalled();
    expect(
      events.filter((event) => event.metadata.approvalResolved === true)
    ).toHaveLength(0);

    approvals[1]!({ behavior: "allow" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      events.filter((event) => event.metadata.approvalResolved === true)
    ).toHaveLength(1);
    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "approved work completed" },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await expect(handle.wait()).resolves.toMatchObject({ exitCode: 0 });
  });

  it("bounds wait when close and process exit never settle", async () => {
    const server = fakeAppServer();
    server.transport.close = vi.fn(
      () => new Promise<void>(() => undefined)
    );
    server.transport.waitForExit = () =>
      new Promise<number>(() => undefined);
    const driver = new CodexSessionDriver(() => server.transport, {
      transportCloseTimeoutMs: 10,
      transportExitTimeoutMs: 15,
    });
    const handle = await driver.start(
      { taskId: "task-stubborn-exit", brief: "finish cleanly" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "finished" },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    const result = await mustSettleWithin(handle.wait());

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/did not exit after bounded shutdown/i);
    expect(server.transport.close).toHaveBeenCalledOnce();
  });

  it("bounds interrupt when its RPC, close, and process exit never settle", async () => {
    const server = fakeAppServer();
    server.transport.close = vi.fn(
      () => new Promise<void>(() => undefined)
    );
    server.transport.waitForExit = () =>
      new Promise<number>(() => undefined);
    const driver = new CodexSessionDriver(() => server.transport, {
      interruptRpcTimeoutMs: 10,
      transportCloseTimeoutMs: 10,
      transportExitTimeoutMs: 15,
    });
    const handle = await driver.start(
      { taskId: "task-stubborn-interrupt", brief: "stop safely" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    await mustSettleWithin(handle.interrupt());
    await expect(mustSettleWithin(handle.wait())).resolves.toMatchObject({
      exitCode: 130,
    });
    expect(server.transport.close).toHaveBeenCalledOnce();
  });

  it("redacts environment, JSON, URL, and authorization credentials in failures", async () => {
    const server = fakeAppServer();
    const events: LaneEvent[] = [];
    const driver = new CodexSessionDriver(() => server.transport);
    const handle = await driver.start(
      { taskId: "task-redacted-error", brief: "fail safely" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );
    server.emit({
      method: CODEX_RPC.turnCompleted,
      params: {
        turn: {
          status: "failed",
          error: {
            message: [
              "AZURE_OPENAI_API_KEY=AZURE_SECRET_VALUE",
              "MUON_API_TOKEN=MUON_SECRET_VALUE",
              '{"CUSTOM_PROVIDER_SECRET":"JSON_SECRET_VALUE"}',
              "Authorization: Bearer BEARER_SECRET_VALUE",
              "https://example.test?api_key=URL_SECRET_VALUE",
            ].join(" "),
          },
        },
      },
    });

    const result = await handle.wait();
    expect(result.exitCode).toBe(1);
    const failure = events.find((event) => event.kind === "task.blocked");
    for (const secret of [
      "AZURE_SECRET_VALUE",
      "MUON_SECRET_VALUE",
      "JSON_SECRET_VALUE",
      "BEARER_SECRET_VALUE",
      "URL_SECRET_VALUE",
    ]) {
      expect(result.output).not.toContain(secret);
      expect(failure?.message).not.toContain(secret);
    }
  });

  it("emits bounded tool coordinates without persisting provider payloads", async () => {
    const server = fakeAppServer();
    const events: LaneEvent[] = [];
    const driver = new CodexSessionDriver(() => server.transport);
    const handle = await driver.start(
      { taskId: "task-tools", brief: "delegate safely" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );
    const oversized = "x".repeat(300);

    server.emit({
      method: CODEX_RPC.itemStarted,
      params: {
        item: {
          id: `item\n<script>${oversized}`,
          type: "mcpToolCall",
          server: `muon\n<script>${oversized}`,
          tool: `dispatch\u0000${oversized}`,
          status: `inProgress\n${oversized}`,
          arguments: { token: "TOP_SECRET_ARGUMENT" },
          result: { content: "TOP_SECRET_RESULT" },
        },
      },
    });
    server.emit({
      method: CODEX_RPC.mcpToolCallProgress,
      params: {
        itemId: `item\n<script>${oversized}`,
        message: "TOP_SECRET_PROGRESS",
      },
    });
    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "done" },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();

    const activityEvents = events.filter(
      (event) => event.metadata.codexActivity
    );
    expect(activityEvents).toHaveLength(2);
    const persisted = JSON.stringify(activityEvents);
    // Coordinates are sanitized to an identifier alphabet, so vendor markup can
    // never become one — and a progress ping still carries no payload at all.
    expect(persisted).not.toContain("<script>");
    expect(persisted).not.toContain("TOP_SECRET_PROGRESS");
    // The arguments/result of the call ARE captured now, but only on the
    // bounded, redacted-downstream `toolActivity.detail`, never on the
    // coordinate record and never on the activity line.
    const coordinates = JSON.stringify(
      activityEvents.map((event) => event.metadata.codexActivity)
    );
    expect(coordinates).not.toContain("TOP_SECRET_ARGUMENT");
    expect(coordinates).not.toContain("TOP_SECRET_RESULT");
    expect(activityEvents.map((event) => event.message).join("\n")).not.toContain(
      "TOP_SECRET_"
    );
    const detail = (
      activityEvents[0]!.metadata.toolActivity as Record<string, unknown>
    ).detail as Record<string, unknown>;
    expect(String(detail.args)).toContain("TOP_SECRET_ARGUMENT");
    expect(String(detail.args).length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_ARGS_CHARS
    );
    expect(String(detail.result)).toContain("TOP_SECRET_RESULT");
    expect(String(detail.result).length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_RESULT_CHARS
    );
    const firstActivity = activityEvents[0]!.metadata
      .codexActivity as Record<string, unknown>;
    expect(String(firstActivity.itemId)).toHaveLength(128);
    expect(String(firstActivity.server).length).toBeLessThanOrEqual(96);
    expect(String(firstActivity.tool).length).toBeLessThanOrEqual(96);
    expect(String(firstActivity.status).length).toBeLessThanOrEqual(32);
  });

  it("sends follow-up turns into the same thread", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);

    const handle = await driver.start(
      { taskId: "task-1", brief: "start" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    await handle.send("also update the tests");

    const turns = server.received.filter((m) => m.method === CODEX_RPC.turnStart);
    expect(turns).toHaveLength(2);
    expect(turns[1]!.params).toMatchObject({
      threadId: "thread-7",
      input: [{ type: "text", text: "also update the tests" }],
    });

    server.emit({
      method: CODEX_RPC.agentMessageDelta,
      params: { delta: "ok" },
    });
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });

  it("does not create a transport for a pre-aborted session", async () => {
    const controller = new AbortController();
    controller.abort();
    const server = fakeAppServer();
    const createTransport = vi.fn(() => server.transport);
    const driver = new CodexSessionDriver(createTransport);

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

    expect(createTransport).not.toHaveBeenCalled();
  });

  it("closes the transport and stops initialization when authority is lost", async () => {
    const controller = new AbortController();
    const server = fakeAppServer((message) => {
      if (message.method === CODEX_RPC.initialize) {
        controller.abort();
      }
    });
    const driver = new CodexSessionDriver(() => server.transport);

    await expect(
      driver.start(
        {
          taskId: "task-1",
          brief: "must not reach turn start",
          signal: controller.signal,
        },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      )
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(server.transport.close).toHaveBeenCalled();
    expect(server.received.map((message) => message.method)).not.toContain(
      CODEX_RPC.turnStart
    );
  });

  it("preserves authority-loss aborts during capability preflight", async () => {
    const controller = new AbortController();
    const server = fakeAppServer((message) => {
      if (message.method === CODEX_RPC.accountRead) {
        controller.abort();
      }
    });
    const driver = new CodexSessionDriver(() => server.transport);

    await expect(
      driver.start(
        {
          taskId: "task-preflight-abort",
          brief: "must stop",
          signal: controller.signal,
        },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      )
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(server.transport.close).toHaveBeenCalled();
    expect(server.received.map((message) => message.method)).not.toContain(
      CODEX_RPC.turnStart
    );
  });
  it("forwards the app-server child's stderr to the caller's diagnostic sink", async () => {
    // The founder's live failure: codex was rejected on a workspace SPEND CAP and
    // took ~5 minutes to say so on stderr, while the runner's watchdog fired at
    // 90s with four guessed causes. The sink is how that stderr reaches a stall
    // report WHILE the session is still hanging.
    const server = fakeAppServer();
    let transportSink: ((chunk: string) => void) | undefined;
    const driver = new CodexSessionDriver((_cwd, _args, _env, onDiagnostic) => {
      transportSink = onDiagnostic;
      return server.transport;
    });

    const chunks: string[] = [];
    const handle = await driver.start(
      { taskId: "task-stderr", brief: "run" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
        onDiagnostic: (chunk) => chunks.push(chunk),
      }
    );
    transportSink?.(
      "ERROR: You hit your spend cap set by the owner of your workspace."
    );
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();

    expect(driver.forwardsVendorStderr).toBe(true);
    expect(chunks.join("")).toContain("You hit your spend cap");
  });

  /**
   * The driver now ALWAYS attaches a stderr sink, because it keeps its own
   * bounded tail to attribute an exit code with (see `codexStartupExitDetail`).
   * The property that still matters — and that this test now pins — is that
   * MUON does not invent a caller sink: with no `handlers.onDiagnostic`, the
   * chunk is recorded and forwarded NOWHERE, and calling the transport's sink
   * must not throw.
   */
  it("attaches its own stderr tail even without a caller diagnostic sink", async () => {
    const server = fakeAppServer();
    let transportSink: ((chunk: string) => void) | undefined;
    const driver = new CodexSessionDriver((_cwd, _args, _env, onDiagnostic) => {
      transportSink = onDiagnostic;
      return server.transport;
    });

    const handle = await driver.start(
      { taskId: "task-no-sink", brief: "run" },
      {
        onEvent: () => undefined,
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );
    expect(transportSink).toBeTypeOf("function");
    expect(() => transportSink?.("MCP client for `x` failed to start")).not.toThrow();
    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });
});

describe("createCodexStderrTail", () => {
  it("forwards vendor stderr live and keeps a bounded rolling tail", () => {
    const chunks: string[] = [];
    const stderr = createCodexStderrTail((chunk) => chunks.push(chunk));

    stderr.observe("first line\n");
    stderr.observe("ERROR: You hit your spend cap set by the owner of your workspace.");

    expect(chunks).toHaveLength(2);
    expect(stderr.read()).toContain("You hit your spend cap");
  });

  it("bounds each chunk BEFORE concatenating, so one huge write is never materialized", () => {
    const stderr = createCodexStderrTail();

    stderr.observe("X".repeat(1_000_000));
    stderr.observe("LAST_MARKER");

    // 800-char transport bound: the newest bytes survive, the flood does not.
    expect(stderr.read().length).toBeLessThanOrEqual(800);
    expect(stderr.read().endsWith("LAST_MARKER")).toBe(true);
  });

  it("records MUON-side spawn failures WITHOUT presenting them as vendor stderr", () => {
    // `append` feeds the "app-server exited before RPC" detail only. Forwarding it
    // would let a MUON-authored string be reported as the vendor's own output.
    const chunks: string[] = [];
    const stderr = createCodexStderrTail((chunk) => chunks.push(chunk));

    stderr.append(" spawn codex ENOENT");

    expect(chunks).toEqual([]);
    expect(stderr.read()).toContain("ENOENT");
  });

  it("ignores empty chunks", () => {
    const chunks: string[] = [];
    const stderr = createCodexStderrTail((chunk) => chunks.push(chunk));

    stderr.observe("");

    expect(chunks).toEqual([]);
    expect(stderr.read()).toBe("");
  });
});

/**
 * F-A on the INTERACTIVE transport. `compiled.unsupported` was computed one
 * line above the transport and then discarded here, so a declared capability
 * this lane could not hold left no trace at all on a session run — the same
 * silence the one-shot lane had, minus even the runner-log line.
 */
describe("CodexSessionDriver capability degradation", () => {
  it("states the boundary in force and what the profile lost", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);
    const events: LaneEvent[] = [];

    const handle = await driver.start(
      {
        taskId: "task-1",
        brief: "go",
        profile: laneProfileSchema.parse({
          sandbox: "workspace-write",
          deniedTools: ["Write", "mcp__muon__memory_delete"],
          mcpServers: [{ name: "muon", command: "muon-mcp", args: [], env: {} }],
        }),
      },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    const notice = events.find(
      (event) => event.metadata.codexCapabilityDegraded !== undefined
    )!;
    expect(notice.metadata.controlPlane).toBe(true);
    // Unlike `codex exec`, a session DOES have a gate — MUON's own bridge.
    expect(notice.metadata.codexApprovalGate).toBe("muon-bridge");
    expect(notice.message).toContain("approval bridge");
    expect(notice.message).toContain("sandbox_mode=workspace-write");
    // Enforced at the vendor…
    expect(notice.message).toContain("muon.memory_delete");
    // …and named where it could not be.
    expect(notice.message).toContain("Write");

    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });

  it("says nothing when the profile lost nothing", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);
    const events: LaneEvent[] = [];

    const handle = await driver.start(
      {
        taskId: "task-1",
        brief: "go",
        profile: laneProfileSchema.parse({ sandbox: "workspace-write" }),
      },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async () => ({ behavior: "allow" }),
      }
    );

    expect(
      events.filter(
        (event) => event.metadata.codexCapabilityDegraded !== undefined
      )
    ).toEqual([]);

    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });
});

/**
 * REGRESSION FIXTURES: the governed-codex approval gate.
 *
 * The live failure these lock out: a governed codex child ran four minutes of
 * write-authority work and filed ZERO approval requests, because (a) the exec
 * transport has no approval channel at all and (b) the session transport
 * compiled must-ask modes to `on-request`, which codex treats as "the model
 * decides". Every claim below was measured against codex 0.145.0 live
 * (app-server JSON-RPC, isolated CODEX_HOME) before being encoded here.
 */
describe("governed codex gate fixtures", () => {
  it("a governed codex child must not run ungated: full access (approval 'never') is only reachable through explicit full-auto consent", async () => {
    // Deriving an ungated mode from anything OTHER than the operator's
    // explicit full-auto is the tier-by-subtraction hazard: a new or absent
    // permissionMode must land on the must-ask default, never on the vendor's
    // model-decides default.
    const cases: {
      profile?: Record<string, unknown>;
      approvalPolicy: string;
    }[] = [
      { approvalPolicy: "untrusted" },
      { profile: { permissionMode: "strict" }, approvalPolicy: "untrusted" },
      { profile: { permissionMode: "default" }, approvalPolicy: "untrusted" },
      {
        profile: { permissionMode: "auto-edits" },
        approvalPolicy: "untrusted",
      },
      {
        profile: { permissionMode: "full-auto", sandbox: "workspace-write" },
        approvalPolicy: "never",
      },
    ];
    for (const testCase of cases) {
      const server = fakeAppServer();
      const driver = new CodexSessionDriver(() => server.transport);
      const handle = await driver.start(
        {
          taskId: "task-approval-mapping",
          brief: "go",
          ...(testCase.profile
            ? { profile: laneProfileSchema.parse(testCase.profile) }
            : {}),
        },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      );
      expect(
        server.received.find(
          (message) => message.method === CODEX_RPC.threadStart
        )?.params
      ).toMatchObject({ approvalPolicy: testCase.approvalPolicy });
      server.emit({
        method: CODEX_RPC.agentMessageDelta,
        params: { delta: "ok" },
      });
      server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
      await handle.wait();
    }
  });

  it("a gated command reaches MUON's bridge in the gate's own vocabulary, and a deny stops it", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);
    const events: LaneEvent[] = [];
    const bridged: { toolName: string; input: unknown }[] = [];

    const handle = await driver.start(
      { taskId: "task-cmd-gate", brief: "write things" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async (request) => {
          bridged.push({ toolName: request.toolName, input: request.input });
          return { behavior: "deny", message: "not on my watch" };
        },
      }
    );

    // The REAL 0.145.0 shape: the wrapped shell line plus the parsed inner
    // command on `commandActions`.
    server.emit({
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-7",
        itemId: "call_1",
        command: "/bin/zsh -lc 'npm test'",
        cwd: "/repo",
        commandActions: [{ type: "unknown", command: "npm test" }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The bridge saw the canonical shell action with the UNWRAPPED command —
    // what the classifier, policy simulation, and test receipts key on.
    expect(bridged).toEqual([
      { toolName: "Bash", input: { command: "npm test", cwd: "/repo" } },
    ]);
    // The deny reached codex in its own accept/decline vocabulary.
    const answer = server.received.find((m) => m.id === 41 && m.result);
    expect(answer?.result).toMatchObject({ decision: "decline" });
    // The request was visible where a human reads, with its subject bounded.
    const requested = events.find(
      (event) => event.kind === "approval.requested"
    );
    expect(requested).toBeDefined();
    expect(
      (requested?.metadata.toolActivity as { detail?: { args?: string } })
        ?.detail?.args
    ).toBe("npm test");

    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });

  it("a granted muon MCP tool call is pre-authorized by the profile grant, not silently ungated", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);
    const events: LaneEvent[] = [];
    const bridged: string[] = [];

    const handle = await driver.start(
      {
        taskId: "task-mcp-granted",
        brief: "record memory",
        profile: laneProfileSchema.parse({
          allowedTools: ["mcp__muon__memory_add"],
        }),
      },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async (request) => {
          bridged.push(request.toolName);
          return { behavior: "deny", message: "should not be consulted" };
        },
      }
    );

    // Measured order: the mcpToolCall item starts, THEN codex asks.
    server.emit({
      method: CODEX_RPC.itemStarted,
      params: {
        item: {
          id: "call_mcp_1",
          type: "mcpToolCall",
          server: "muon",
          tool: "memory_add",
          status: "inProgress",
        },
      },
    });
    server.emit({
      id: 51,
      method: CODEX_RPC.mcpElicitation,
      params: {
        threadId: "thread-7",
        serverName: "muon",
        mode: "form",
        message: 'Allow the muon MCP server to run tool "memory_add"?',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Accepted FROM THE GRANT — the elicitation vocabulary, no bridge call,
    // no approval event: exactly the Claude SDK's allowedTools posture.
    const answer = server.received.find((m) => m.id === 51 && m.result);
    expect(answer?.result).toEqual({ action: "accept" });
    expect(bridged).toEqual([]);
    expect(
      events.filter((event) => event.kind === "approval.requested")
    ).toEqual([]);

    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });

  it("an ungranted MCP tool call must reach MUON's gate and fail closed on deny", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);
    const events: LaneEvent[] = [];
    const bridged: string[] = [];

    const handle = await driver.start(
      { taskId: "task-mcp-ungranted", brief: "reach out" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async (request) => {
          bridged.push(request.toolName);
          return { behavior: "deny", message: "no grant" };
        },
      }
    );

    server.emit({
      method: CODEX_RPC.itemStarted,
      params: {
        item: {
          id: "call_mcp_2",
          type: "mcpToolCall",
          server: "thirdparty",
          tool: "exfiltrate",
          status: "inProgress",
        },
      },
    });
    server.emit({
      id: 52,
      method: CODEX_RPC.mcpElicitation,
      params: {
        threadId: "thread-7",
        serverName: "thirdparty",
        mode: "form",
        message: 'Allow the thirdparty MCP server to run tool "exfiltrate"?',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(bridged).toEqual(["mcp__thirdparty__exfiltrate"]);
    const answer = server.received.find((m) => m.id === 52 && m.result);
    expect(answer?.result).toEqual({ action: "decline" });
    expect(
      events.some((event) => event.kind === "approval.requested")
    ).toBe(true);

    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });

  it("a file change approval names its file and diff, and edits gate as edits", async () => {
    const server = fakeAppServer();
    const driver = new CodexSessionDriver(() => server.transport);
    const events: LaneEvent[] = [];
    const bridged: { toolName: string; input: unknown }[] = [];

    const handle = await driver.start(
      { taskId: "task-filechange", brief: "patch it" },
      {
        onEvent: (event) => events.push(event),
        onApprovalRequest: async (request) => {
          bridged.push({ toolName: request.toolName, input: request.input });
          return { behavior: "deny", message: "reviewed and refused" };
        },
      }
    );

    // Measured 0.145.0: the approval request carries only coordinates; the
    // paths and diff ride the fileChange item started immediately before it.
    server.emit({
      method: CODEX_RPC.itemStarted,
      params: {
        item: {
          id: "call_fc_1",
          type: "fileChange",
          changes: [
            {
              path: "/repo/src/index.ts",
              kind: { type: "add" },
              diff: "HELLO\n",
            },
          ],
          status: "inProgress",
        },
      },
    });
    server.emit({
      id: 61,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-7", itemId: "call_fc_1", reason: null },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(bridged).toEqual([
      { toolName: "Edit", input: { file_path: "/repo/src/index.ts" } },
    ]);
    expect(
      events.find(
        (event) =>
          (event.metadata.toolActivity as { itemId?: string } | undefined)
            ?.itemId === "call_fc_1"
      )?.metadata.toolActivity
    ).toMatchObject({
      fileMutation: true,
      paths: ["/repo/src/index.ts"],
    });
    const answer = server.received.find((m) => m.id === 61 && m.result);
    expect(answer?.result).toMatchObject({ decision: "decline" });

    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await handle.wait();
  });

  it("ADR-0023 on this transport: the thread/start sandbox param must agree with the composed argv, because the param wins", async () => {
    // Measured: a `thread/start` sandbox param DEFEATS an argv
    // `-c sandbox_mode` statement. Under MUON's confined runner the override
    // says danger-full-access; a param still saying workspace-write would
    // silently restore the nested-sandbox lockout (the child could not run
    // `pwd`).
    const previous = process.env.MUON_SANDBOX_ACTIVE;
    process.env.MUON_SANDBOX_ACTIVE = "1";
    try {
      const server = fakeAppServer();
      const driver = new CodexSessionDriver(() => server.transport);
      const handle = await driver.start(
        {
          taskId: "task-adr23",
          brief: "go",
          profile: laneProfileSchema.parse({ sandbox: "workspace-write" }),
        },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      );
      expect(
        server.received.find(
          (message) => message.method === CODEX_RPC.threadStart
        )?.params
      ).toMatchObject({
        approvalPolicy: "untrusted",
        sandbox: "danger-full-access",
      });
      server.emit({
        method: CODEX_RPC.agentMessageDelta,
        params: { delta: "ok" },
      });
      server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
      await handle.wait();
    } finally {
      if (previous === undefined) delete process.env.MUON_SANDBOX_ACTIVE;
      else process.env.MUON_SANDBOX_ACTIVE = previous;
    }
  });

  it("a read-only profile keeps read-only on the thread param — the fix never widens a reviewer", async () => {
    const previous = process.env.MUON_SANDBOX_ACTIVE;
    process.env.MUON_SANDBOX_ACTIVE = "1";
    try {
      const server = fakeAppServer();
      const driver = new CodexSessionDriver(() => server.transport);
      const handle = await driver.start(
        {
          taskId: "task-adr23-ro",
          brief: "review only",
          profile: laneProfileSchema.parse({ sandbox: "read-only" }),
        },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      );
      expect(
        server.received.find(
          (message) => message.method === CODEX_RPC.threadStart
        )?.params
      ).toMatchObject({ sandbox: "read-only" });
      server.emit({
        method: CODEX_RPC.agentMessageDelta,
        params: { delta: "ok" },
      });
      server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
      await handle.wait();
    } finally {
      if (previous === undefined) delete process.env.MUON_SANDBOX_ACTIVE;
      else process.env.MUON_SANDBOX_ACTIVE = previous;
    }
  });
});
