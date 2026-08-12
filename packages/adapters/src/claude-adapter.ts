import type {
  AgentRole,
  LaneCapabilities,
  LaneEvent,
  LaneTaskSubmission,
} from "@muon/protocol";
import { BaseLaneAdapter, type LaneRunOptions } from "./base-lane-adapter.js";
import {
  ClaudeSdkUnavailableError,
  ClaudeSessionDriver,
  type ClaudeOneShotVendorOptions,
  type ClaudeSessionDriverOptions,
} from "./claude-session-driver.js";
import {
  buildProviderAwareLaneEnvironment,
  type LaneCommandResult,
} from "./lane-runner.js";
import type { SessionHandle, SessionStartInput, SessionHandlers } from "./session-driver.js";

/** The MUON MCP server's name, mirrored from the session driver's own literal. */
const MUON_MCP_SERVER_NAME = "muon";

/**
 * Constructs the driver one one-shot run executes through. Injectable so tests
 * can drive a fake Agent SDK; production always builds the real driver.
 */
export type ClaudeSessionDriverFactory = (
  options: ClaudeSessionDriverOptions
) => { start: (
  input: SessionStartInput,
  handlers: SessionHandlers
) => Promise<SessionHandle> };

export type ClaudeVendorOptionTranslation =
  | { ok: true; vendorOptions: ClaudeOneShotVendorOptions }
  | { ok: false; reason: string };

/**
 * Project the COMPILED claude argv (`compileClaudeProfile`) onto the Agent
 * SDK's option names, so a one-shot run executed through the session channel
 * grants exactly what the same run would have granted on argv.
 *
 * Deliberately a translation of the compiler's OUTPUT rather than a second
 * reading of the lane profile: a governance rule that lives only in the
 * compiler (`sandbox: "read-only"` appending the write-tool denials is the
 * sharp example) then cannot be lost by this channel.
 *
 * Fail-closed on anything it cannot prove it preserved. The caller's answer to
 * `ok: false` is to run the ORIGINAL spawn — today's behaviour exactly — and
 * say so, never to drop the argument and continue.
 */
export function claudeVendorOptionsFromCompiledArgs(
  args: readonly string[]
): ClaudeVendorOptionTranslation {
  const vendorOptions: {
    model?: string;
    permissionMode?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    additionalDirectories?: string[];
    mcpServers?: Record<string, unknown>;
    extraArgs?: Record<string, string | null>;
  } = {};
  const additionalDirectories: string[] = [];
  const extraArgs: Record<string, string | null> = {};
  const unexpressible = (arg: string, why: string): ClaudeVendorOptionTranslation => ({
    ok: false,
    reason: `compiled Claude argument '${arg}' ${why}`,
  });

  let index = 0;
  /** The single value of `--flag <value>`; absent when the next token is a flag. */
  const takeValue = (): string | undefined => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) return undefined;
    index += 1;
    return value;
  };
  /** The variadic tail of `--allowedTools a b c`, as the CLI itself reads it. */
  const takeList = (): string[] => {
    const values: string[] = [];
    while (index + 1 < args.length && !args[index + 1]!.startsWith("-")) {
      index += 1;
      values.push(args[index]!);
    }
    return values;
  };

  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--strict-mcp-config") {
      // The driver sets `strictMcpConfig` unconditionally; the compiler-owned
      // flag is therefore already honoured, never dropped.
      continue;
    }
    if (arg === "--model" || arg === "--permission-mode") {
      const value = takeValue();
      if (value === undefined) return unexpressible(arg, "carries no value");
      if (arg === "--model") vendorOptions.model = value;
      else vendorOptions.permissionMode = value;
      continue;
    }
    if (arg === "--add-dir") {
      const value = takeValue();
      if (value === undefined) return unexpressible(arg, "carries no value");
      additionalDirectories.push(value);
      continue;
    }
    if (arg === "--allowedTools") {
      vendorOptions.allowedTools = [
        ...(vendorOptions.allowedTools ?? []),
        ...takeList(),
      ];
      continue;
    }
    if (arg === "--disallowedTools") {
      vendorOptions.disallowedTools = [
        ...(vendorOptions.disallowedTools ?? []),
        ...takeList(),
      ];
      continue;
    }
    if (arg === "--mcp-config") {
      const value = takeValue();
      if (value === undefined) return unexpressible(arg, "carries no value");
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return unexpressible(arg, "is not the JSON the compiler emits");
      }
      const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
      if (!servers || typeof servers !== "object") {
        return unexpressible(arg, "has no 'mcpServers' object");
      }
      vendorOptions.mcpServers = servers as Record<string, unknown>;
      continue;
    }
    // Everything else is the profile's own passthrough (`extraArgs`), already
    // guard-sanitized upstream. Only the forms whose meaning is unambiguous
    // translate; anything else refuses rather than guessing at the boundary
    // between a boolean flag and a dash-leading value.
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals > 2) {
        extraArgs[arg.slice(2, equals)] = arg.slice(equals + 1);
        continue;
      }
      const key = arg.slice(2);
      if (!key) return unexpressible(arg, "is not a named flag");
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        extraArgs[key] = null;
        continue;
      }
      if (next.startsWith("-")) {
        return unexpressible(
          arg,
          "is followed by a dash-leading token that could be either its value or another flag"
        );
      }
      index += 1;
      extraArgs[key] = next;
      continue;
    }
    return unexpressible(arg, "is a bare token this channel cannot place");
  }

  return {
    ok: true,
    vendorOptions: {
      ...vendorOptions,
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
      ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
    },
  };
}

export class ClaudeAdapter extends BaseLaneAdapter {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";
  readonly provider = "anthropic";
  readonly role = "peer" as const;
  readonly commandCandidates = ["claude"];

  readonly laneCapabilities: LaneCapabilities = {
    canStreamEvents: true,
    canInterrupt: true,
    canBackground: true,
    supportsApprovals: true,
    supportsWorktrees: true,
  };

  /**
   * Claude Code can hold every role: it streams, interrupts, backgrounds,
   * honours approvals and runs inside a MUON worktree, so no role's required
   * capabilities are out of reach.
   */
  readonly supportedRoles: readonly AgentRole[] = [
    "orchestrator",
    "architect",
    "implementer",
    "reviewer",
    "qa",
    "scout",
    "docs",
  ];

  /**
   * Strongest where long-horizon context and prose matter: designing the change,
   * making it, and writing the documentation that goes with it. Reviewing is a
   * real strength but not what sets it apart from the other frontier lane, and
   * spending a frontier lane on cheap reconnaissance is waste, so `scout` sits
   * deliberately low — a local lane should win that job on cost.
   */
  readonly roleAffinity: Partial<Record<AgentRole, number>> = {
    orchestrator: 0.9,
    architect: 0.92,
    implementer: 0.9,
    docs: 0.88,
    reviewer: 0.8,
    qa: 0.7,
    scout: 0.5,
  };

  constructor(
    private readonly sessionDriverFactory: ClaudeSessionDriverFactory = (
      options
    ) => new ClaudeSessionDriver(undefined, options)
  ) {
    super();
  }

  override taskCommand(brief: string) {
    // Official non-interactive print mode: claude -p "<prompt>"
    return { command: "claude", args: ["-p", brief] };
  }

  /**
   * MUON's one-shot contract, executed through the Agent SDK session channel.
   *
   * WHY: on argv (`claude -p "<brief>"`) the turn begins at process launch, so
   * there is no moment at which MUON can verify that the governed `muon` MCP
   * server finished its handshake. Measured, `claude -p` starts with
   * `mcp:[{"name":"muon","status":"pending"}]` and NO `mcp__muon__*` tools — a
   * run that needs `memory_add` or `preflight_edit` was a coin flip. Streaming
   * input makes the brief ours to withhold, so the session path's readiness
   * gate (`awaitMuonMcpReadiness`) applies to one-shot runs too, and an
   * unverifiable handshake refuses the run instead of starting it blind.
   *
   * WHAT IS PRESERVED: the `LaneCommandResult` shape, the timeout/abort
   * semantics (`exitCode: 130`), the diagnostic stderr sink, the profile
   * compiler as the single source of vendor authority, the deny-first lane
   * environment, and the missing-binary refusal.
   *
   * WHAT STILL SPAWNS (documented gaps, each announced on the event stream):
   *   • a resolved vendor action's `argvOverride` (ADR-0013 #52) — it REPLACES
   *     the argv with a different subcommand (`claude ultrareview <target>
   *     --json`), which the SDK, whose only entry point is a prompt turn,
   *     cannot express at all;
   *   • a compiled profile argument this channel cannot prove it preserved;
   *   • an absent Agent SDK, but ONLY when the profile granted no `muon` MCP
   *     server — with the server present there is a real gate to lose, so the
   *     run refuses instead.
   */
  override async runTask(
    input: LaneTaskSubmission,
    onEvent: (event: LaneEvent) => void,
    options?: LaneRunOptions
  ): Promise<LaneCommandResult> {
    const invocation = this.resolveInvocation(input, options);
    // Checked before anything is compiled or written, exactly as the spawn
    // path does. The SDK ships its own CLI, but a lane whose binary the user
    // never installed is not a ready lane on any channel.
    this.assertLaneBinaryAvailable(invocation.command);

    if (options?.argvOverride) {
      this.announceSpawnFallback(
        input,
        onEvent,
        "a resolved vendor action replaces the argv, which the Agent SDK session channel cannot express"
      );
      const compiled = this.compileRunProfile(input, onEvent, options);
      return this.spawnCompiledRun(
        input,
        onEvent,
        options,
        invocation,
        compiled
      );
    }

    // Compiled ONCE: both channels below use this exact result, so a fallback
    // never duplicates the run-scoped config writes or the `profileUnsupported`
    // diagnostics.
    const compiled = this.compileRunProfile(input, onEvent, options);
    const translated = claudeVendorOptionsFromCompiledArgs(compiled.args);
    if (!translated.ok) {
      this.announceSpawnFallback(input, onEvent, translated.reason);
      return this.spawnCompiledRun(
        input,
        onEvent,
        options,
        invocation,
        compiled
      );
    }

    const expectsMuonMcp = (options?.profile?.mcpServers ?? []).some(
      (server) => server.name === MUON_MCP_SERVER_NAME
    );
    const startedAt = Date.now();
    let errorOutput = "";
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options?.signal?.reason);
    const timeout =
      options?.timeoutMs !== undefined && options.timeoutMs > 0
        ? setTimeout(
            () =>
              controller.abort(
                new Error(
                  `Claude one-shot run exceeded its ${options.timeoutMs}ms budget`
                )
              ),
            options.timeoutMs
          )
        : undefined;
    timeout?.unref?.();
    if (options?.signal?.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options?.signal?.addEventListener("abort", abortFromCaller, {
        once: true,
      });
    }
    const release = () => {
      if (timeout) clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", abortFromCaller);
    };

    let handle: SessionHandle;
    try {
      handle = await this.sessionDriverFactory({
        oneShot: {
          vendorOptions: translated.vendorOptions,
          // The identical deny-first environment `runLaneCommand` builds, so
          // the MCP env the vendor config references BY NAME resolves from the
          // child's own env — the value never reaches argv or the workspace (S2).
          env: buildProviderAwareLaneEnvironment(
            this.id,
            process.env,
            compiled.env
          ),
        },
      }).start(
        {
          taskId: input.taskId,
          brief: input.brief,
          cwd: options?.cwd,
          profile: options?.profile,
          signal: controller.signal,
        },
        {
          onEvent,
          // The vendor session id is the resume/backlink handle: with it the
          // human can reopen this exact run in the real Claude Code TUI
          // (`claude --resume <id>`), dispatched prompt visible as the first
          // turn. Reported at FIRST knowledge, so a mid-run kill keeps it.
          ...(options?.onVendorSessionId
            ? { onVendorSessionId: options.onVendorSessionId }
            : {}),
          // Unreachable by construction: a one-shot session installs no
          // `canUseTool`, so nothing routes here. Denying is the only correct
          // answer if that ever changes — there is no operator watching a
          // one-shot run's approvals inbox.
          onApprovalRequest: async () => ({
            behavior: "deny",
            message:
              "MUON denied: a one-shot run has no approver; dispatch an interactive session for gated tools.",
          }),
          // Feeds `errorOutput` so the result shape is unchanged, and forwards
          // to the caller's live sink (the runner's liveness watchdog).
          onDiagnostic: (chunk) => {
            errorOutput += chunk;
            options?.onDiagnostic?.(chunk);
          },
        }
      );
    } catch (error) {
      release();
      if (error instanceof ClaudeSdkUnavailableError && !expectsMuonMcp) {
        // No governed MCP server was granted, so there is no readiness gate to
        // lose: refusing here would break a run that works today for no
        // governance gain. With the server present this branch is NOT taken and
        // the refusal propagates.
        this.announceSpawnFallback(
          input,
          onEvent,
          "the Claude Agent SDK is not installed and this run was granted no governed MUON MCP server"
        );
        return this.spawnCompiledRun(
          input,
          onEvent,
          options,
          invocation,
          compiled
        );
      }
      compiled.restoreConfig?.();
      throw error;
    }

    try {
      const result = await handle.wait();
      return {
        exitCode: result.exitCode,
        output: result.output,
        errorOutput,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      release();
      // The SESSION channel never reaches `spawnCompiledRun`, so it has to put the
      // run-scoped config back itself — otherwise `.claude/settings.local.json`
      // survives in the human's checkout on exactly the path MUON prefers.
      compiled.restoreConfig?.();
    }
  }

  /**
   * Say, on the run's own event stream, that this one-shot did NOT get the MCP
   * readiness gate and why. Control-plane metadata so it lands as activity, not
   * as agent prose. Silence here would recreate the exact defect being fixed:
   * an operator believing a run was gated when it was not.
   */
  private announceSpawnFallback(
    input: LaneTaskSubmission,
    onEvent: (event: LaneEvent) => void,
    reason: string
  ): void {
    onEvent({
      id: `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      laneId: this.id,
      taskId: input.taskId,
      kind: "task.progress",
      message: `claude one-shot ran on argv without the MUON MCP readiness gate: ${reason}`,
      timestamp: new Date().toISOString(),
      metadata: { controlPlane: true, oneShotSessionFallback: reason },
    });
  }
}
