import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { laneProfileSchema } from "@muon/protocol";
import {
  CODEX_RPC,
  CodexSessionDriver,
  type RpcTransport,
} from "../src/codex-session-driver.js";
import {
  buildProviderAwareLaneEnvironment,
  runLaneCommand,
} from "../src/lane-runner.js";
import {
  assertMuonMcpEnvContract,
  findMuonMcpEnvContractViolations,
} from "../src/mcp-env-contract.js";
import { readMuonMcpStartupFailure } from "../src/muon-mcp-diagnostic.js";
import { compileCodexProfile } from "../src/profile-compiler.js";

const DELEGATION_TOKEN = "delegation-token-0123456789abcdef";
const API_TOKEN = "api-token-0123456789abcdef";

/**
 * The env the runner composes for a codex ORCHESTRATOR session, mirrored field
 * for field from `withMuonMcpServer` + `executeJob`'s orchestrator branch. It
 * lives here (not imported) because @muon/core depends on this package.
 */
function orchestratorMuonEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string> {
  const env: Record<string, string | undefined> = {
    MUON_API_BASE: "http://127.0.0.1:57450",
    MUON_TASK_ID: "task-1",
    MUON_LANE_KEY: "muon-orchestrator",
    MUON_JOB_ID: "job-1",
    MUON_WORKSPACE: "/repo",
    MUON_PREFLIGHT_NONCE: "n".repeat(64),
    MUON_API_TOKEN: API_TOKEN,
    MUON_CHAT_ID: "chat-1",
    MUON_MCP_MODE: "orchestrator",
    MUON_DELEGATION_TOKEN: DELEGATION_TOKEN,
    MUON_CHAT_TASK_ID: "task-1",
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    )
  );
}

function orchestratorProfile(
  envOverrides: Record<string, string | undefined> = {}
) {
  return laneProfileSchema.parse({
    permissionMode: "default",
    rawConfig: { "features.multi_agent": false },
    mcpServers: [
      {
        name: "muon",
        command: "muon-mcp",
        env: orchestratorMuonEnv(envOverrides),
      },
    ],
    allowedTools: ["mcp__muon__dispatch"],
  });
}

/** The exact env the codex child (and therefore muon-mcp) is handed. */
function codexChildEnv(profile: ReturnType<typeof orchestratorProfile>) {
  const compiled = compileCodexProfile(profile);
  const lane = buildProviderAwareLaneEnvironment("codex", process.env, compiled.env);
  return {
    compiled,
    childEnv: Object.fromEntries(
      Object.entries(lane).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"
      )
    ),
  };
}

function envVarNamesFromArgs(args: string[]): string[] {
  const entry = args.find((arg) =>
    arg.startsWith("mcp_servers.muon.env_vars=")
  );
  if (!entry) return [];
  return JSON.parse(entry.slice("mcp_servers.muon.env_vars=".length)) as string[];
}

describe("governed MUON MCP env contract (codex by-name delivery)", () => {
  it("delivers every name codex is told to forward, including the orchestrator lineage", () => {
    const profile = orchestratorProfile();
    const { compiled, childEnv } = codexChildEnv(profile);

    const names = envVarNamesFromArgs(compiled.args);
    expect(names).toEqual(Object.keys(profile.mcpServers[0]!.env));

    // The two-sided contract: every NAME on the vendor's side resolves to a
    // non-empty VALUE on the env side. This is the assertion whose absence let
    // a dropped variable become a sub-second, causeless vendor death.
    for (const name of names) {
      expect(childEnv[name], `${name} never reached the codex child env`)
        .toBeTruthy();
    }
    // Exactly what packages/mcp/src/index.ts refuses to start without.
    expect(childEnv.MUON_MCP_MODE).toBe("orchestrator");
    expect(childEnv.MUON_JOB_ID).toBe("job-1");
    expect(childEnv.MUON_DELEGATION_TOKEN).toBe(DELEGATION_TOKEN);

    expect(() =>
      assertMuonMcpEnvContract(profile.mcpServers, childEnv)
    ).not.toThrow();
  });

  it("fails loudly, naming the variable, when orchestrator lineage is missing", () => {
    const profile = orchestratorProfile({ MUON_DELEGATION_TOKEN: undefined });
    const { childEnv } = codexChildEnv(profile);

    const violations = findMuonMcpEnvContractViolations(
      profile.mcpServers,
      childEnv
    );
    expect(violations.mode).toBe("orchestrator");
    expect(violations.missingLineage).toEqual(["MUON_DELEGATION_TOKEN"]);

    expect(() =>
      assertMuonMcpEnvContract(profile.mcpServers, childEnv)
    ).toThrow(/MUON_DELEGATION_TOKEN/);
    expect(() =>
      assertMuonMcpEnvContract(profile.mcpServers, childEnv)
    ).toThrow(/refusing vendor launch/);
  });

  it("fails loudly when MUON_JOB_ID is missing", () => {
    const profile = orchestratorProfile({ MUON_JOB_ID: undefined });
    const { childEnv } = codexChildEnv(profile);
    expect(() =>
      assertMuonMcpEnvContract(profile.mcpServers, childEnv)
    ).toThrow(/MUON_JOB_ID/);
  });

  it("catches a declared name the deny-first lane filter silently drops", () => {
    // Cross-vendor credential names are stripped on the codex lane, so this
    // name survives into `env_vars` but never into the child env — the exact
    // shape of the failure, without needing a lineage variable to prove it.
    const profile = orchestratorProfile({ ANTHROPIC_API_KEY: "leaked-key" });
    const { compiled, childEnv } = codexChildEnv(profile);

    expect(envVarNamesFromArgs(compiled.args)).toContain("ANTHROPIC_API_KEY");
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(
      findMuonMcpEnvContractViolations(profile.mcpServers, childEnv).undelivered
    ).toEqual(["ANTHROPIC_API_KEY"]);
    expect(() =>
      assertMuonMcpEnvContract(profile.mcpServers, childEnv)
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("treats a whitespace-only value as undelivered, like muon-mcp does", () => {
    const profile = orchestratorProfile();
    const { childEnv } = codexChildEnv(profile);
    expect(() =>
      assertMuonMcpEnvContract(profile.mcpServers, {
        ...childEnv,
        MUON_JOB_ID: "  ",
      })
    ).toThrow(/MUON_JOB_ID/);
  });

  it("does not refuse an optional coordinate the profile itself never set", () => {
    // A non-chat orchestrator dispatch leaves MUON_CHAT_ID empty. That is an
    // upstream composition choice, not a delivery failure — refusing it would
    // break launches that work today, while the lineage rule still holds.
    const profile = orchestratorProfile({ MUON_CHAT_ID: "" });
    const { childEnv } = codexChildEnv(profile);
    expect(childEnv.MUON_CHAT_ID ?? "").toBe("");
    expect(() =>
      assertMuonMcpEnvContract(profile.mcpServers, childEnv)
    ).not.toThrow();
  });

  it("is inert for a plain worker profile with no capability mode", () => {
    const profile = laneProfileSchema.parse({
      mcpServers: [
        {
          name: "muon",
          command: "muon-mcp",
          env: { MUON_API_BASE: "http://x", MUON_TASK_ID: "t" },
        },
      ],
    });
    const { childEnv } = codexChildEnv(profile);
    expect(() =>
      assertMuonMcpEnvContract(profile.mcpServers, childEnv)
    ).not.toThrow();
  });

  it("requires the job-bound token only for a delegate that may spawn", () => {
    const base = {
      MUON_API_BASE: "http://x",
      MUON_MCP_MODE: "delegate",
      MUON_JOB_ID: "job-1",
    };
    const cannotSpawn = laneProfileSchema.parse({
      mcpServers: [
        {
          name: "muon",
          command: "muon-mcp",
          env: { ...base, MUON_DELEGATE_CAN_SPAWN: "false" },
        },
      ],
    });
    expect(() =>
      assertMuonMcpEnvContract(
        cannotSpawn.mcpServers,
        cannotSpawn.mcpServers[0]!.env
      )
    ).not.toThrow();

    const canSpawn = laneProfileSchema.parse({
      mcpServers: [
        {
          name: "muon",
          command: "muon-mcp",
          env: { ...base, MUON_DELEGATE_CAN_SPAWN: "true" },
        },
      ],
    });
    expect(() =>
      assertMuonMcpEnvContract(
        canSpawn.mcpServers,
        canSpawn.mcpServers[0]!.env
      )
    ).toThrow(/MUON_DELEGATION_TOKEN/);
  });

  it("never puts a secret VALUE in the refusal message", () => {
    const profile = orchestratorProfile({ ANTHROPIC_API_KEY: "leaked-key" });
    const { childEnv } = codexChildEnv(profile);
    let message = "";
    try {
      assertMuonMcpEnvContract(profile.mcpServers, childEnv);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ANTHROPIC_API_KEY");
    expect(message).not.toContain("leaked-key");
    expect(message).not.toContain(DELEGATION_TOKEN);
    expect(message).not.toContain(API_TOKEN);
  });
});

describe("CodexSessionDriver MUON MCP startup failures", () => {
  it("refuses to spawn codex at all when the lineage env is incomplete", async () => {
    const createTransport = vi.fn(() => {
      throw new Error("transport must not be created");
    });
    const driver = new CodexSessionDriver(
      createTransport as unknown as () => RpcTransport
    );

    await expect(
      driver.start(
        {
          taskId: "task-1",
          brief: "go",
          profile: orchestratorProfile({ MUON_DELEGATION_TOKEN: undefined }),
        },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      )
    ).rejects.toThrow(/MUON_DELEGATION_TOKEN/);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("reports muon-mcp's OWN reason instead of the opaque vendor string", async () => {
    // Codex swallows the MCP server's stderr and reports only this summary —
    // the founder's live failure, verbatim.
    const vendorSummary =
      "MCP client for `muon` failed to start: MCP startup failed: handshaking with MCP server failed: connection closed: initialize response";
    const serverReason =
      "muon-mcp failed: orchestrator MCP mode requires a job-bound delegation token.";

    let deliver: (message: Record<string, unknown>) => void = () => undefined;
    const transport: RpcTransport = {
      send: (message) => {
        if (message.method === CODEX_RPC.initialize) {
          deliver({ id: message.id, result: {} });
        }
        if (message.method === CODEX_RPC.threadStart) {
          deliver({ id: message.id, result: { thread: { id: "thread-7" } } });
          setTimeout(() => {
            deliver({
              method: CODEX_RPC.mcpStartupStatus,
              params: {
                threadId: "thread-7",
                name: "muon",
                status: "failed",
                error: vendorSummary,
              },
            });
          }, 0);
        }
      },
      onMessage: (handler) => {
        deliver = handler as typeof deliver;
      },
      close: async () => undefined,
      waitForExit: () => new Promise<number>(() => undefined),
    };

    const diagnostics: string[] = [];
    const driver = new CodexSessionDriver(
      () => transport,
      { readMuonMcpStartupFailure: async () => serverReason }
    );

    const failure = await driver
      .start(
        { taskId: "task-1", brief: "go", profile: orchestratorProfile() },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
          onDiagnostic: (chunk) => diagnostics.push(chunk),
        }
      )
      .then(
        () => undefined,
        (error: unknown) => error
      );

    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain(vendorSummary);
    expect(message).toContain(serverReason);
    // Reuses the runner's existing vendor-stderr sink rather than a second path.
    expect(diagnostics.join("")).toContain(serverReason);
    expect(message).not.toContain(DELEGATION_TOKEN);
  });

  it("keeps the vendor's message unchanged when the probe observes nothing", async () => {
    const vendorSummary = "MCP client for `muon` failed to start: opaque";
    let deliver: (message: Record<string, unknown>) => void = () => undefined;
    const transport: RpcTransport = {
      send: (message) => {
        if (message.method === CODEX_RPC.initialize) {
          deliver({ id: message.id, result: {} });
        }
        if (message.method === CODEX_RPC.threadStart) {
          deliver({ id: message.id, result: { thread: { id: "t" } } });
          setTimeout(() => {
            deliver({
              method: CODEX_RPC.mcpStartupStatus,
              params: { name: "muon", status: "failed", error: vendorSummary },
            });
          }, 0);
        }
      },
      onMessage: (handler) => {
        deliver = handler as typeof deliver;
      },
      close: async () => undefined,
      waitForExit: () => new Promise<number>(() => undefined),
    };
    const driver = new CodexSessionDriver(
      () => transport,
      { readMuonMcpStartupFailure: async () => "" }
    );

    const failure = await driver
      .start(
        { taskId: "task-1", brief: "go", profile: orchestratorProfile() },
        {
          onEvent: () => undefined,
          onApprovalRequest: async () => ({ behavior: "allow" }),
        }
      )
      .then(
        () => undefined,
        (error: unknown) => error
      );
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toBe(vendorSummary);
    expect(message).not.toContain("muon-mcp itself reported");
  });
});

describe("one-shot lane spawn", () => {
  it("refuses before spawning when the governed MCP env is incomplete", async () => {
    const profile = orchestratorProfile({ MUON_JOB_ID: undefined });
    const events: string[] = [];
    await expect(
      runLaneCommand({
        laneId: "codex",
        taskId: "task-1",
        // A command that would fail loudly if the guard let the spawn happen.
        command: "muon-nonexistent-binary",
        args: [],
        env: compileCodexProfile(profile).env,
        mcpServers: profile.mcpServers,
        onEvent: (event) => events.push(event.kind),
      })
    ).rejects.toThrow(/MUON_JOB_ID/);
    // Refused before the lane emitted its task.started milestone.
    expect(events).toEqual([]);
  });

  it("stays inert when no mcpServers are supplied", async () => {
    const result = await runLaneCommand({
      laneId: "codex",
      taskId: "task-1",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      onEvent: () => undefined,
    });
    expect(result.exitCode).toBe(0);
  });
});

describe("readMuonMcpStartupFailure", () => {
  function fakeSpawn(stderrChunks: string[], exitCode = 1) {
    return (() => {
      const child = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        stdin: { end: () => void };
        kill: () => void;
      };
      child.stderr = new EventEmitter();
      child.stdin = { end: () => undefined };
      child.kill = () => undefined;
      setTimeout(() => {
        for (const chunk of stderrChunks) {
          child.stderr.emit("data", Buffer.from(chunk));
        }
        child.emit("close", exitCode);
      }, 0);
      return child;
    }) as never;
  }

  it("returns the server's own fail-closed sentence", async () => {
    const detail = await readMuonMcpStartupFailure({
      command: "muon-mcp",
      env: orchestratorMuonEnv(),
      spawn: fakeSpawn([
        "muon-mcp failed: orchestrator MCP mode requires MUON_JOB_ID lineage.\n",
      ]),
    });
    expect(detail).toBe(
      "muon-mcp failed: orchestrator MCP mode requires MUON_JOB_ID lineage."
    );
  });

  it("blanks an injected credential VALUE printed bare on stderr", async () => {
    const detail = await readMuonMcpStartupFailure({
      command: "muon-mcp",
      env: orchestratorMuonEnv(),
      spawn: fakeSpawn([`boom while using ${DELEGATION_TOKEN} and ${API_TOKEN}`]),
    });
    expect(detail).not.toContain(DELEGATION_TOKEN);
    expect(detail).not.toContain(API_TOKEN);
    expect(detail).toContain("[redacted]");
  });

  it("returns nothing when the server starts cleanly", async () => {
    const detail = await readMuonMcpStartupFailure({
      command: "muon-mcp",
      env: orchestratorMuonEnv(),
      spawn: fakeSpawn([], 0),
    });
    expect(detail).toBe("");
  });
});
