import { describe, expect, it } from "vitest";
import {
  VENDOR_IDS,
  VENDOR_REGISTRY,
  laneProfileSchema,
  type AgentRole,
  type LaneCapabilities,
  type LaneEvent,
} from "@muon/protocol";
import { BaseLaneAdapter } from "../src/base-lane-adapter.js";
import { ClaudeAdapter } from "../src/claude-adapter.js";
import { CodexAdapter } from "../src/codex-adapter.js";
import { CursorAdapter } from "../src/cursor-adapter.js";
import { OpencodeAdapter } from "../src/opencode-adapter.js";

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

  taskCommand(brief: string) {
    return { command: "echo", args: [brief] };
  }
}

class ClaudeEchoAdapter extends EchoAdapter {
  override readonly id = "claude-code";
}

class CodexEchoAdapter extends EchoAdapter {
  override readonly id = "codex";
}

class CursorEchoAdapter extends EchoAdapter {
  override readonly id = "cursor";
}

describe("adapter task execution", () => {
  it("keeps Cursor to the read-only slice: supportsWorktrees honest, write roles refused", async () => {
    const adapter = new CursorAdapter();

    expect(await adapter.capabilities()).toEqual({
      canStreamEvents: true,
      canInterrupt: true,
      canBackground: true,
      supportsApprovals: false,
      // TODO 2.1: MUON already points Cursor at a MUON worktree via
      // `--workspace`. Write seats are refused via supportedRoles (see below),
      // not via a false capability label.
      supportsWorktrees: true,
    });
    await expect(
      adapter.runTask(
        {
          taskId: "cursor-write-role",
          brief: "must not dispatch",
          role: "implementer",
        },
        () => undefined,
        { argvOverride: { command: "echo", args: ["must-not-run"] } }
      )
    ).rejects.toThrow(/Cursor cannot hold the 'implementer' role/i);
    await expect(
      adapter.startSession({
        taskId: "cursor-write-role",
        goal: "must not create a fake session",
        role: "docs",
      })
    ).rejects.toThrow(/Cursor cannot hold the 'docs' role/i);
    await expect(
      adapter.submitTask({
        taskId: "cursor-write-role",
        brief: "must not accept a task",
        role: "orchestrator",
      })
    ).rejects.toThrow(/Cursor cannot hold the 'orchestrator' role/i);
  });

  it("runs a task through the lane command runner and emits events", async () => {
    const adapter = new EchoAdapter();
    const events: LaneEvent[] = [];

    const result = await adapter.runTask(
      { taskId: "task-9", brief: "summarize repo state" },
      (event) => events.push(event)
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("summarize repo state");
    expect(events[0]?.kind).toBe("task.started");
    expect(events[events.length - 1]?.kind).toBe("task.completed");
  });

  it("forwards a diagnostic sink to the child's stderr, and omitting it is inert", async () => {
    class StderrAdapter extends EchoAdapter {
      override readonly commandCandidates = ["sh"];
      override taskCommand(brief: string) {
        return { command: "sh", args: ["-c", `echo "${brief}" >&2`] };
      }
    }

    const adapter = new StderrAdapter();
    const chunks: string[] = [];
    const observed = await adapter.runTask(
      { taskId: "task-diag", brief: "vendor-said-this" },
      () => undefined,
      { onDiagnostic: (chunk) => chunks.push(chunk) }
    );
    expect(chunks.join("")).toContain("vendor-said-this");
    expect(observed.errorOutput).toContain("vendor-said-this");

    // Without a sink the result is the same; the seam adds nothing to observe.
    const unobserved = await adapter.runTask(
      { taskId: "task-diag-2", brief: "vendor-said-this" },
      () => undefined
    );
    expect(unobserved.errorOutput).toBe(observed.errorOutput);
    expect(unobserved.exitCode).toBe(observed.exitCode);
  });

  it("fails clearly when no binary is installed", async () => {
    class MissingAdapter extends EchoAdapter {
      override readonly commandCandidates = ["definitely-not-installed-xyz"];
      override taskCommand(brief: string) {
        return { command: "definitely-not-installed-xyz", args: [brief] };
      }
    }

    const adapter = new MissingAdapter();
    await expect(
      adapter.runTask({ taskId: "task-10", brief: "noop" }, () => {})
    ).rejects.toThrow(/not available/i);
  });

  it("fails clearly when only a fallback candidate exists but the task binary is missing", async () => {
    class FallbackOnlyAdapter extends EchoAdapter {
      // "echo" exists, so the lane looks installed, but the actual
      // non-interactive task binary does not.
      override readonly commandCandidates = [
        "definitely-not-installed-xyz",
        "echo",
      ];
      override taskCommand(brief: string) {
        return { command: "definitely-not-installed-xyz", args: [brief] };
      }
    }

    const adapter = new FallbackOnlyAdapter();
    await expect(
      adapter.runTask({ taskId: "task-11", brief: "noop" }, () => {})
    ).rejects.toThrow(/not available/i);
  });

  it("honors a per-run argv subcommand override (ADR-0013 ultrareview)", async () => {
    // The EchoAdapter's default taskCommand echoes the brief; the override
    // replaces the args entirely (command defaults to the lane's own binary).
    const adapter = new EchoAdapter();
    const events: LaneEvent[] = [];

    const result = await adapter.runTask(
      { taskId: "task-uv", brief: "unused brief" },
      (event) => events.push(event),
      { argvOverride: { args: ["ultrareview", "HEAD", "--json"] } }
    );

    expect(result.exitCode).toBe(0);
    // echo printed the override args, NOT the brief.
    expect(result.output).toContain("ultrareview HEAD --json");
    expect(result.output).not.toContain("unused brief");
  });

  it("override command defaults to the lane binary; explicit command is honored", async () => {
    const adapter = new EchoAdapter();
    const result = await adapter.runTask(
      { taskId: "task-uv2", brief: "b" },
      () => {},
      { argvOverride: { command: "echo", args: ["from-override"] } }
    );
    expect(result.output).toContain("from-override");
  });

  it("SPAWN BACKSTOP: strips --strict-mcp-config from the final argv (ADR-0013 v2)", async () => {
    // The governed-brain MCP server is non-evictable: even if --strict-mcp-config
    // is forced onto the argv override, it must NEVER reach the spawned command.
    // `echo` echoes exactly what it is handed, so its stdout is the final argv.
    const adapter = new ClaudeEchoAdapter();
    const result = await adapter.runTask(
      { taskId: "backstop", brief: "unused" },
      () => {},
      { argvOverride: { command: "echo", args: ["ultrareview", "--strict-mcp-config", "keep"] } }
    );
    expect(result.output).not.toContain("--strict-mcp-config");
    expect(result.output).toContain("ultrareview");
    expect(result.output).toContain("keep");
  });

  it("the strict-flag guard is the registry's column, not the lane's NAME (G9)", async () => {
    // ADR-0022 §1.2(f): `this.id === "claude-code"` decided whether MUON's own
    // governed MCP server could be evicted. It now reads
    // `execution.guards.strictMcpConfigFlag`, so the two statements below must
    // name the same lanes or the guard has quietly moved.
    expect(
      [...VENDOR_IDS].filter(
        (id) => VENDOR_REGISTRY[id].execution.guards.strictMcpConfigFlag
      )
    ).toEqual(["claude-code"]);

    // An adapter whose id is NOT in the registry: no declared flag vocabulary,
    // so no sanitization — byte-identical to the `=== "claude-code"` branch this
    // replaced, and unreachable in production (MUON only constructs adapters for
    // registered lanes).
    const unregistered = new EchoAdapter();
    expect(VENDOR_IDS as readonly string[]).not.toContain(unregistered.id);
    const result = await unregistered.runTask(
      { taskId: "unregistered", brief: "unused" },
      () => {},
      {
        argvOverride: {
          command: "echo",
          args: ["ultrareview", "--strict-mcp-config", "keep"],
        },
      }
    );
    expect(result.output).toContain("--strict-mcp-config");
  });

  it("preserves Codex prompt/extraArgs shaped like the Claude strict flag, but fails a guarded model closed (S5)", async () => {
    // For codex, `--strict-mcp-config` is claude-specific data, not a codex flag,
    // so a claude-flag-shaped BRIEF and extraArgs are still preserved verbatim.
    // The MODEL field, however, is now guarded (S5): a guarded value fails closed
    // to `unsupported` instead of reaching `--model` on the vendor argv.
    const adapter = new CodexEchoAdapter();
    const events: LaneEvent[] = [];
    const result = await adapter.runTask(
      { taskId: "codex-vendor-data", brief: "--strict-mcp-config" },
      (event) => events.push(event),
      {
        profile: laneProfileSchema.parse({
          model: "--strict-mcp-config",
          extraArgs: [
            "--strict-mcp-config",
            "--strict-mcp-config=codex-data",
          ],
        }),
      }
    );

    const argv = result.output.trim().split(/\s+/);
    // brief + one extraArg carry the bare flag as data; the model no longer does.
    expect(argv.filter((arg) => arg === "--strict-mcp-config")).toHaveLength(2);
    expect(argv).toContain("--strict-mcp-config=codex-data");
    // S5: the guarded model never reaches argv, and the rejection is surfaced.
    expect(argv).not.toContain("--model");
    expect(
      events.some(
        (e) => e.metadata.profileUnsupported === "guarded codex model value rejected"
      )
    ).toBe(true);
  });

  it("preserves Cursor override/extraArgs shaped like the Claude strict flag, but fails a guarded model closed (S5)", async () => {
    const adapter = new CursorEchoAdapter();
    const events: LaneEvent[] = [];
    const result = await adapter.runTask(
      { taskId: "cursor-vendor-data", brief: "unused" },
      (event) => events.push(event),
      {
        argvOverride: {
          command: "echo",
          args: [
            "--strict-mcp-config",
            "--strict-mcp-config=cursor-override",
          ],
        },
        profile: laneProfileSchema.parse({
          model: "--strict-mcp-config",
          extraArgs: ["--strict-mcp-config"],
        }),
      }
    );

    const argv = result.output.trim().split(/\s+/);
    // override + one extraArg carry the bare flag as data; the model no longer does.
    expect(argv.filter((arg) => arg === "--strict-mcp-config")).toHaveLength(2);
    expect(argv).toContain("--strict-mcp-config=cursor-override");
    // S5: the guarded model never reaches argv, and the rejection is surfaced.
    expect(argv).not.toContain("--model");
    expect(
      events.some(
        (e) => e.metadata.profileUnsupported === "guarded cursor model value rejected"
      )
    ).toBe(true);
  });

  it("keeps exactly one compiler-owned Claude strict MCP flag after stripping untrusted duplicates", async () => {
    const adapter = new ClaudeEchoAdapter();
    const result = await adapter.runTask(
      { taskId: "claude-strict", brief: "unused" },
      () => {},
      {
        argvOverride: {
          command: "echo",
          args: [
            "override",
            "--strict-mcp-config",
            "--strict-mcp-config=override",
            "tail",
          ],
        },
        profile: laneProfileSchema.parse({
          extraArgs: [
            "--strict-mcp-config",
            "--strict-mcp-config=profile",
            "--profile-tail",
          ],
        }),
      }
    );

    const argv = result.output.trim().split(/\s+/);
    expect(argv.filter((arg) => arg === "--strict-mcp-config")).toHaveLength(1);
    expect(argv.some((arg) => arg.startsWith("--strict-mcp-config="))).toBe(
      false
    );
    expect(argv).toEqual(
      expect.arrayContaining(["override", "tail", "--profile-tail"])
    );
  });

  it("rejects hostile Claude typed values before composing the final argv", async () => {
    const adapter = new ClaudeEchoAdapter();
    const result = await adapter.runTask(
      { taskId: "claude-hostile-typed", brief: "unused" },
      () => {},
      {
        argvOverride: {
          command: "echo",
          args: [
            "override-safe",
            "--strict-mcp-config",
            "--strict-mcp-config=override",
          ],
        },
        profile: laneProfileSchema.parse({
          model: "--strict-mcp-config",
          addDirs: ["../safe", "--strict-mcp-config=add-dir"],
          allowedTools: ["Read", "--strict-mcp-config"],
          deniedTools: ["WebFetch", "--strict-mcp-config=deny"],
          extraArgs: [
            "--safe-extra",
            "--strict-mcp-config",
            "--strict-mcp-config=extra",
          ],
          mcpServers: [
            {
              name: "muon",
              command: "muon-mcp",
              args: ["--stdio"],
            },
          ],
        }),
      }
    );

    const argv = result.output.trim().split(/\s+/);
    expect(argv.filter((arg) => arg === "--strict-mcp-config")).toHaveLength(1);
    expect(argv.some((arg) => arg.startsWith("--strict-mcp-config="))).toBe(
      false
    );
    expect(argv).not.toContain("--model");
    expect(argv).toEqual(
      expect.arrayContaining([
        "override-safe",
        "--add-dir",
        "../safe",
        "--allowedTools",
        "Read",
        "--disallowedTools",
        "WebFetch",
        "--safe-extra",
      ])
    );
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read");
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("WebFetch");

    const mcpIndex = argv.indexOf("--mcp-config");
    expect(JSON.parse(argv[mcpIndex + 1]!).mcpServers.muon.command).toBe(
      "muon-mcp"
    );
  });

  it("maps vendor adapters to official non-interactive commands", () => {
    expect(new ClaudeAdapter().taskCommand("do x")).toEqual({
      command: "claude",
      args: ["-p", "do x"],
    });
    expect(new CodexAdapter().taskCommand("do x")).toEqual({
      command: "codex",
      // The ambient-feature suppression rides the INVOCATION, not the compiled
      // profile, so a run that carries no profile at all is still isolated from
      // the operator's `codex_apps` bridge (169 ungranted tools, measured). The
      // brief stays the sole positional.
      args: [
        "exec",
        "-c",
        "features.apps=false",
        "-c",
        "features.plugins=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.multi_agent_v2=false",
        "do x",
      ],
    });
    const cursor = new CursorAdapter().taskCommand("do x", { cwd: "/repo" });
    expect(cursor.command).toMatch(/^(cursor-)?agent$/);
    expect(cursor.args).toEqual([
      "--print",
      "--output-format",
      "json",
      "--mode",
      "plan",
      "--trust",
      // TODO 2.6: trust is what lets a non-interactive run start in a fresh
      // worktree; this is what stops it also meaning "run the reviewed repo's
      // own `.cursor/worktrees.json` setup scripts".
      "--skip-worktree-setup",
      "--workspace",
      "/repo",
      "do x",
    ]);
    // No `--agent`: the agent is left at the default so exactly ONE permission
    // table is in play (the one MUON writes). Naming `plan` would look safer and
    // be worse — `plan` denies NOTHING. `--pure` drops the operator's ambient
    // global plugins (finding 5 egress vector), keeping auth and the deny table.
    expect(
      new OpencodeAdapter().taskCommand("do x", { cwd: "/repo" })
    ).toEqual({
      command: "opencode",
      args: ["run", "--pure", "--format", "json", "--dir", "/repo", "do x"],
    });
  });
});
