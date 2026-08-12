import { describe, expect, it, vi } from "vitest";
import { laneProfileSchema, type LaneEvent } from "@muon/protocol";
import {
  ClaudeAdapter,
  claudeVendorOptionsFromCompiledArgs,
  type ClaudeSessionDriverFactory,
} from "../src/claude-adapter.js";
import {
  ClaudeSdkUnavailableError,
  ClaudeSessionDriver,
  type ClaudeSessionDriverOptions,
} from "../src/claude-session-driver.js";

/**
 * `muon run` on the Claude lane no longer spawns `claude -p`: the brief travels
 * through the Agent SDK's streaming input so the MUON MCP readiness gate can
 * withhold it. These tests pin BOTH halves of that: the gate really gates, and
 * the one-shot contract callers depend on (result shape, event stream,
 * timeout/abort, the diagnostic sink, the compiler as the only source of vendor
 * authority) is unchanged.
 */

type SdkMessage = {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: { content?: { type: string; text?: string }[] };
};

type FakeMcpStatus = {
  name?: string;
  status?: string;
  error?: string;
  tools?: { name?: string }[];
};

type FakeSdkConfig = {
  /** One row per `mcpServerStatus()` poll; omitted ⇒ the probe is absent. */
  statuses?: FakeMcpStatus[][];
  /** Messages streamed back once the brief actually lands. */
  reply?: SdkMessage[];
  /** Never emit anything, even after the brief (abort/timeout fixtures). */
  hang?: boolean;
  /** Written to the SDK's stderr sink while the vendor is still running. */
  stderr?: string;
};

function fakeSdk(config: FakeSdkConfig) {
  const captured = {
    options: {} as Record<string, unknown>,
    sent: [] as string[],
    queries: 0,
  };
  let polls = 0;
  const sdk = {
    query: ({
      prompt,
      options,
    }: {
      prompt: unknown;
      options: Record<string, unknown>;
    }) => {
      captured.options = options;
      captured.queries += 1;
      if (config.stderr !== undefined) {
        (options.stderr as ((chunk: string) => void) | undefined)?.(
          config.stderr
        );
      }
      const briefLanded = (async () => {
        for await (const message of prompt as AsyncIterable<{
          message: { content: string };
        }>) {
          captured.sent.push(message.message.content);
        }
      })();
      return {
        async *[Symbol.asyncIterator]() {
          // A real vendor emits nothing until a turn begins, i.e. until the
          // gated brief is released (or the generator closes un-briefed).
          await briefLanded;
          if (config.hang) await new Promise(() => undefined);
          for (const message of config.reply ?? []) {
            yield message;
          }
        },
        interrupt: async () => undefined,
        ...(config.statuses
          ? {
              mcpServerStatus: async () => {
                const index = Math.min(polls, config.statuses!.length - 1);
                polls += 1;
                return config.statuses![index]!;
              },
            }
          : {}),
      };
    },
  };
  return { sdk, captured, pollCount: () => polls };
}

/**
 * The real adapter, with only the vendor BINARY swapped for one every machine
 * has. `id` stays `claude-code`, so profile compilation, the argv guards and
 * the lane env filter are exercised exactly as in production.
 */
class TestClaudeAdapter extends ClaudeAdapter {
  override taskCommand(brief: string) {
    return { command: "echo", args: ["-p", brief] };
  }
}

function adapterWith(config: FakeSdkConfig, driverOptions?: ClaudeSessionDriverOptions) {
  const fake = fakeSdk(config);
  const factory: ClaudeSessionDriverFactory = (options) =>
    new ClaudeSessionDriver(async () => fake.sdk, {
      muonMcpPollIntervalMs: 1,
      ...driverOptions,
      ...options,
    });
  return { adapter: new TestClaudeAdapter(factory), fake };
}

const muonProfile = (overrides: Record<string, unknown> = {}) =>
  laneProfileSchema.parse({
    allowedTools: ["mcp__muon__memory_add"],
    mcpServers: [
      {
        name: "muon",
        command: "muon-mcp",
        args: ["--stdio"],
        env: { MUON_API_TOKEN: "job-bound-secret", MUON_JOB_ID: "job-1" },
      },
    ],
    ...overrides,
  });

const connected = (tools: string[]): FakeMcpStatus[] => [
  { name: "muon", status: "connected", tools: tools.map((name) => ({ name })) },
];

describe("claude one-shot through the session driver", () => {
  it("withholds the brief until the MUON MCP handshake is verified", async () => {
    const { adapter, fake } = adapterWith({
      statuses: [
        [{ name: "muon", status: "pending" }],
        connected(["memory_add"]),
      ],
      reply: [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "wrote the note" }] },
        },
        { type: "result", subtype: "success", result: "done" },
      ],
    });
    const events: LaneEvent[] = [];

    const result = await adapter.runTask(
      { taskId: "task-gate", brief: "record what you learned" },
      (event) => events.push(event),
      { profile: muonProfile() }
    );

    // The brief was handed over exactly once, and only after `connected`.
    expect(fake.captured.sent).toEqual(["record what you learned"]);
    expect(fake.pollCount()).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("wrote the note");
    expect(events[0]?.kind).toBe("task.started");
    expect(events.at(-1)?.kind).toBe("task.completed");
  });

  it("refuses the run, without briefing the vendor, when the handshake fails", async () => {
    const { adapter, fake } = adapterWith({
      statuses: [
        [{ name: "muon", status: "failed", error: "spawn muon-mcp ENOENT" }],
      ],
    });
    const events: LaneEvent[] = [];

    await expect(
      adapter.runTask(
        { taskId: "task-blind", brief: "record what you learned" },
        (event) => events.push(event),
        { profile: muonProfile() }
      )
    ).rejects.toThrow(/'muon' reported status 'failed'/);

    expect(fake.captured.sent).toEqual([]);
    const blocked = events.find((event) => event.kind === "task.blocked");
    expect(blocked?.metadata.reason).toBe("muon-mcp-handshake-failed");
    expect(blocked?.message).toContain("withheld the brief");
    expect(events.some((event) => event.kind === "task.completed")).toBe(false);
  });

  it("refuses when a granted MUON tool never reaches the session", async () => {
    const { adapter, fake } = adapterWith({
      statuses: [connected(["memory_search"])],
    });

    await expect(
      adapter.runTask(
        { taskId: "task-missing-tool", brief: "go" },
        () => undefined,
        { profile: muonProfile() }
      )
    ).rejects.toThrow(/never exposed 1 granted tool.*mcp__muon__memory_add/s);
    expect(fake.captured.sent).toEqual([]);
  });

  it("keeps the LaneCommandResult shape and the event stream contract", async () => {
    const { adapter, fake } = adapterWith({
      reply: [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "the answer" }] },
        },
        { type: "result", subtype: "success", result: "the answer" },
      ],
    });
    const events: LaneEvent[] = [];
    const diagnostics: string[] = [];

    const result = await adapter.runTask(
      { taskId: "task-shape", brief: "answer this" },
      (event) => events.push(event),
      { onDiagnostic: (chunk) => diagnostics.push(chunk) }
    );

    expect(Object.keys(result).sort()).toEqual([
      "durationMs",
      "errorOutput",
      "exitCode",
      "output",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("the answer");
    expect(result.errorOutput).toBe("");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Same envelope the spawn path emits: one start, streamed progress, one
    // terminal event — all carrying this lane's id and the run's task id.
    expect(events.filter((event) => event.kind === "task.started")).toHaveLength(1);
    expect(events[0]?.kind).toBe("task.started");
    expect(events.at(-1)?.kind).toBe("task.completed");
    expect(
      events.filter(
        (event) =>
          event.kind === "task.completed" || event.kind === "task.blocked"
      )
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.kind === "task.progress" && event.message.includes("the answer")
      )
    ).toBe(true);
    for (const event of events) {
      expect(event.laneId).toBe("claude-code");
      expect(event.taskId).toBe("task-shape");
    }

    // A run without the governed MCP server is not gated, so nothing was polled.
    expect(fake.captured.sent).toEqual(["answer this"]);
    expect(diagnostics).toEqual([]);
  });

  it("feeds the vendor's stderr to errorOutput and to the live sink", async () => {
    // The SDK hands the `claude` process's stderr to the `stderr` option while
    // the run is still going; both the live sink and the terminal result must
    // see it, exactly as the spawn path's `errorOutput`/`onDiagnostic` do.
    const { adapter } = adapterWith({
      stderr: "ERROR: You hit your spend cap",
      reply: [{ type: "result", subtype: "success", result: "ok" }],
    });
    const diagnostics: string[] = [];

    const result = await adapter.runTask(
      { taskId: "task-stderr", brief: "go" },
      () => undefined,
      { onDiagnostic: (chunk) => diagnostics.push(chunk) }
    );

    expect(diagnostics.join("")).toContain("You hit your spend cap");
    expect(result.errorOutput).toContain("You hit your spend cap");

    // Omitting the sink changes nothing about the result.
    const { adapter: unobserved } = adapterWith({
      stderr: "ERROR: You hit your spend cap",
      reply: [{ type: "result", subtype: "success", result: "ok" }],
    });
    await expect(
      unobserved.runTask({ taskId: "task-stderr-2", brief: "go" }, () => undefined)
    ).resolves.toMatchObject({
      exitCode: result.exitCode,
      errorOutput: result.errorOutput,
    });
  });

  it("reports exit 130 when the caller's signal aborts mid-run", async () => {
    const { adapter } = adapterWith(
      { hang: true },
      { interruptSettleTimeoutMs: 10 }
    );
    const controller = new AbortController();

    const running = adapter.runTask(
      { taskId: "task-abort", brief: "wait forever" },
      () => undefined,
      { signal: controller.signal }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("runner authority lost"));

    await expect(running).resolves.toMatchObject({ exitCode: 130 });
  });

  it("reports exit 130 when the timeout budget elapses", async () => {
    const { adapter } = adapterWith(
      { hang: true },
      { interruptSettleTimeoutMs: 10 }
    );

    await expect(
      adapter.runTask(
        { taskId: "task-timeout", brief: "wait forever" },
        () => undefined,
        { timeoutMs: 10 }
      )
    ).resolves.toMatchObject({ exitCode: 130 });
  });

  it("rejects before launching when authority was already lost", async () => {
    const { adapter, fake } = adapterWith({});
    const controller = new AbortController();
    controller.abort(new Error("runner authority lost"));

    await expect(
      adapter.runTask({ taskId: "task-pre-abort", brief: "no" }, () => undefined, {
        signal: controller.signal,
      })
    ).rejects.toThrow(/runner authority lost/);
    expect(fake.captured.queries).toBe(0);
  });

  it("hands the compiler's authority — not a re-reading of the profile — to the SDK", async () => {
    const { adapter, fake } = adapterWith({
      statuses: [connected(["memory_add"])],
      reply: [{ type: "result", subtype: "success", result: "ok" }],
    });

    await adapter.runTask({ taskId: "task-authority", brief: "review" }, () => undefined, {
      profile: muonProfile({
        model: "claude-opus-4",
        permissionMode: "auto-edits",
        // The read-only denials exist ONLY inside the compiler; a channel that
        // re-read the profile itself would silently drop them.
        sandbox: "read-only",
        addDirs: ["../shared"],
        deniedTools: ["WebFetch"],
      }),
    });

    const options = fake.captured.options;
    expect(options.model).toBe("claude-opus-4");
    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.additionalDirectories).toEqual(["../shared"]);
    expect(options.allowedTools).toEqual(["mcp__muon__memory_add"]);
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(["WebFetch", "Bash", "Write", "Edit"])
    );
    expect(options.strictMcpConfig).toBe(true);
    // One-shot is governed exactly as `claude -p` is; there is no operator
    // watching an inbox, so no `canUseTool` interpose is installed.
    expect("canUseTool" in options).toBe(false);
    // The CLI's own settings layers still load, so the run-scoped
    // `.claude/settings.local.json` the compiler writes is not made inert.
    expect("settingSources" in options).toBe(false);
  });

  it("keeps the MCP token off argv and delivers it through the child env (S2)", async () => {
    const { adapter, fake } = adapterWith({
      statuses: [connected(["memory_add"])],
      reply: [{ type: "result", subtype: "success", result: "ok" }],
    });

    await adapter.runTask({ taskId: "task-s2", brief: "go" }, () => undefined, {
      profile: muonProfile(),
    });

    const mcpServers = fake.captured.options.mcpServers as Record<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    >;
    expect(mcpServers.muon?.command).toBe("muon-mcp");
    // By NAME in the vendor config…
    expect(mcpServers.muon?.env).toEqual({
      MUON_API_TOKEN: "${MUON_API_TOKEN}",
      MUON_JOB_ID: "${MUON_JOB_ID}",
    });
    expect(JSON.stringify(mcpServers)).not.toContain("job-bound-secret");
    // …and by VALUE only in the deny-first child environment.
    const env = fake.captured.options.env as NodeJS.ProcessEnv;
    expect(env.MUON_API_TOKEN).toBe("job-bound-secret");
    expect(env.MUON_JOB_ID).toBe("job-1");
    expect(env.MUON_RUNNER_LEASE_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("refuses a governed run when the muon MCP env contract is broken", async () => {
    const { adapter, fake } = adapterWith({ statuses: [connected(["memory_add"])] });

    await expect(
      adapter.runTask({ taskId: "task-lineage", brief: "go" }, () => undefined, {
        profile: muonProfile({
          mcpServers: [
            {
              name: "muon",
              command: "muon-mcp",
              args: ["--stdio"],
              // Declares the delegate capability without the lineage muon-mcp
              // needs, so it would die during initialize with no reason.
              env: { MUON_MCP_MODE: "delegate" },
            },
          ],
        }),
      })
    ).rejects.toThrow(/governed MUON MCP server env is incomplete/);
    expect(fake.captured.queries).toBe(0);
  });

  // ── documented fallbacks ────────────────────────────────────────────────
  // Each one leaves the run on the ORIGINAL argv spawn and says so on the
  // event stream: an operator must never believe a run was gated when it
  // was not.
  describe("spawn fallbacks", () => {
    it("keeps a resolved vendor action on argv, and announces the gap", async () => {
      const { adapter, fake } = adapterWith({});
      const events: LaneEvent[] = [];

      const result = await adapter.runTask(
        { taskId: "task-action", brief: "unused" },
        (event) => events.push(event),
        { argvOverride: { command: "echo", args: ["ultrareview", "HEAD"] } }
      );

      expect(fake.captured.queries).toBe(0);
      expect(result.output).toContain("ultrareview HEAD");
      const notice = events.find(
        (event) => event.metadata.oneShotSessionFallback !== undefined
      );
      expect(notice?.metadata.controlPlane).toBe(true);
      expect(String(notice?.metadata.oneShotSessionFallback)).toContain(
        "vendor action"
      );
      // The spawn path's own envelope is intact behind the notice.
      expect(events.some((event) => event.kind === "task.started")).toBe(true);
      expect(events.at(-1)?.kind).toBe("task.completed");
    });

    it("spawns when a compiled argument cannot be proven expressible", async () => {
      const { adapter, fake } = adapterWith({});
      const events: LaneEvent[] = [];

      const result = await adapter.runTask(
        { taskId: "task-extra", brief: "hello" },
        (event) => events.push(event),
        {
          profile: laneProfileSchema.parse({
            // A dash-leading value is exactly the shape this channel refuses to
            // guess about.
            extraArgs: ["--append-system-prompt", "-be terse"],
          }),
        }
      );

      expect(fake.captured.queries).toBe(0);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("--append-system-prompt");
      expect(
        events.some(
          (event) =>
            String(event.metadata.oneShotSessionFallback ?? "").includes(
              "dash-leading"
            )
        )
      ).toBe(true);
      // Compiled exactly once: no duplicated profile diagnostics.
      expect(
        events.filter((event) => event.metadata.profileUnsupported !== undefined)
      ).toHaveLength(0);
    });

    it("spawns without the SDK only when no governed MCP server was granted", async () => {
      const missingSdk: ClaudeSessionDriverFactory = (options) =>
        new ClaudeSessionDriver(async () => {
          throw new ClaudeSdkUnavailableError("missing");
        }, options);
      const adapter = new TestClaudeAdapter(missingSdk);
      const events: LaneEvent[] = [];

      const result = await adapter.runTask(
        { taskId: "task-no-sdk", brief: "hello" },
        (event) => events.push(event)
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("hello");
      expect(
        events.some(
          (event) =>
            String(event.metadata.oneShotSessionFallback ?? "").includes(
              "Agent SDK is not installed"
            )
        )
      ).toBe(true);

      // With the governed server granted there IS a gate to lose: refuse.
      await expect(
        adapter.runTask({ taskId: "task-no-sdk-2", brief: "hello" }, () => undefined, {
          profile: muonProfile(),
        })
      ).rejects.toThrow(ClaudeSdkUnavailableError);
    });

    it("refuses a run whose vendor binary is not installed, before compiling", async () => {
      class MissingBinaryAdapter extends ClaudeAdapter {
        override taskCommand(brief: string) {
          return { command: "definitely-not-installed-xyz", args: ["-p", brief] };
        }
      }
      const factory = vi.fn();
      await expect(
        new MissingBinaryAdapter(
          factory as unknown as ClaudeSessionDriverFactory
        ).runTask({ taskId: "task-missing", brief: "x" }, () => undefined)
      ).rejects.toThrow(/not available/i);
      expect(factory).not.toHaveBeenCalled();
    });
  });
});

describe("claudeVendorOptionsFromCompiledArgs", () => {
  it("translates every flag compileClaudeProfile emits", () => {
    const translated = claudeVendorOptionsFromCompiledArgs([
      "--strict-mcp-config",
      "--model",
      "claude-opus-4",
      "--permission-mode",
      "acceptEdits",
      "--add-dir",
      "/repo/a",
      "--add-dir",
      "/repo/b",
      "--allowedTools",
      "Read",
      "mcp__muon__memory_add",
      "--disallowedTools",
      "Bash",
      "Write",
      "--mcp-config",
      JSON.stringify({ mcpServers: { muon: { command: "muon-mcp" } } }),
      "--verbose",
      "--output-format=json",
      "--max-thinking",
      "8000",
    ]);

    expect(translated).toEqual({
      ok: true,
      vendorOptions: {
        model: "claude-opus-4",
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "mcp__muon__memory_add"],
        disallowedTools: ["Bash", "Write"],
        mcpServers: { muon: { command: "muon-mcp" } },
        additionalDirectories: ["/repo/a", "/repo/b"],
        extraArgs: {
          verbose: null,
          "output-format": "json",
          "max-thinking": "8000",
        },
      },
    });
  });

  it("refuses rather than guessing at anything it cannot place", () => {
    expect(claudeVendorOptionsFromCompiledArgs(["--model"])).toMatchObject({
      ok: false,
    });
    expect(
      claudeVendorOptionsFromCompiledArgs(["--mcp-config", "not-json"])
    ).toMatchObject({ ok: false });
    expect(
      claudeVendorOptionsFromCompiledArgs(["--mcp-config", "{}"])
    ).toMatchObject({ ok: false });
    expect(
      claudeVendorOptionsFromCompiledArgs(["--flag", "-1"])
    ).toMatchObject({ ok: false });
    expect(claudeVendorOptionsFromCompiledArgs(["bare"])).toMatchObject({
      ok: false,
    });
    expect(claudeVendorOptionsFromCompiledArgs(["-p", "brief"])).toMatchObject({
      ok: false,
    });
  });

  it("treats a trailing or flag-followed passthrough as boolean", () => {
    expect(
      claudeVendorOptionsFromCompiledArgs(["--verbose", "--debug"])
    ).toEqual({
      ok: true,
      vendorOptions: { extraArgs: { verbose: null, debug: null } },
    });
  });
});
