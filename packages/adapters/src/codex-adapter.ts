import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentRole,
  LaneCapabilities,
  LaneEvent,
  LaneTaskSubmission,
} from "@muon/protocol";
import { BaseLaneAdapter, type LaneRunOptions } from "./base-lane-adapter.js";
import {
  CODEX_AMBIENT_SUPPRESSION_ARGS,
  CODEX_GUARD_NOTICE,
  CODEX_NESTED_SANDBOX_NOTICE,
  codexGuardEnv,
  codexSandboxOverrideArgs,
  effectiveCodexSandboxMode,
  guardedCodexArgs,
  prepareCodexGuardHome,
} from "./codex-guard.js";
import {
  CODEX_EXEC_JSON_ARGS,
  createCodexExecStream,
} from "./codex-exec-stream.js";
import type { LaneCommandResult } from "./lane-runner.js";
import {
  codexCapabilityNotice,
  compileCodexProfile,
  compileCodexToolPolicy,
} from "./profile-compiler.js";
import { codexSessionIdFromOutput } from "./pty-text.js";

/**
 * Injection seam for the ambient-config guard. The real one reads the
 * DEVELOPER's own `~/.codex` and creates a directory in their tmpdir — a unit
 * test that did either would pass or fail based on whose machine it ran on.
 */
export type CodexAdapterOptions = {
  prepareGuardHome?: typeof prepareCodexGuardHome;
};

export class CodexAdapter extends BaseLaneAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly provider = "openai";
  readonly role = "peer" as const;
  readonly commandCandidates = ["codex"];

  readonly laneCapabilities: LaneCapabilities = {
    canStreamEvents: true,
    canInterrupt: true,
    canBackground: true,
    supportsApprovals: true,
    supportsWorktrees: true,
  };

  /** Full capability set, so like Claude Code it can hold every role. */
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
   * Strongest at making a change and at proving it: its native sandbox and
   * approval policy make `codex exec` the most controllable writer MUON drives,
   * and running the checks and reporting what actually failed is where it is
   * hardest to beat. It reviews well; prose-heavy design and documentation are
   * where it ranks below Claude Code, and `scout` is low for the same
   * cost reason.
   */
  readonly roleAffinity: Partial<Record<AgentRole, number>> = {
    implementer: 0.9,
    qa: 0.88,
    orchestrator: 0.85,
    reviewer: 0.8,
    architect: 0.75,
    docs: 0.6,
    scout: 0.55,
  };

  /**
   * Overridden to install the ambient-config guard, which is the whole reason
   * this lane needs a `runTask` at all: the boundary is an ENV fact
   * (`CODEX_HOME`), so the guard directory has to exist and the variable has to
   * be merged into the compiled env before the child starts. Same shape, and
   * for the same reason, as `OpencodeAdapter.runTask`.
   */
  private readonly options: CodexAdapterOptions;

  constructor(options: CodexAdapterOptions = {}) {
    super();
    this.options = options;
  }

  /** One-shot codex renders its real console; the live viewer earns the
   *  vendor's native output instead of a piped staircase. */
  override readonly prefersPtyConsole = true;

  override async runTask(
    input: LaneTaskSubmission,
    onEvent: (event: LaneEvent) => void,
    options?: LaneRunOptions
  ): Promise<LaneCommandResult> {
    const invocation = this.resolveInvocation(input, options);
    this.assertLaneBinaryAvailable(invocation.command);
    const compiled = this.compileRunProfile(input, onEvent, options);

    // Throws rather than degrading to the ambient home: see CodexGuardHomeError.
    // A throw here is a throw AFTER `compileRunProfile` wrote the run-scoped
    // config, so the undo runs before it propagates. Codex's own `configWrites` is
    // empty today (its guard is environmental), which makes this a no-op — kept
    // because it is one configWrite away from mattering, and the reader should not
    // have to know which lanes are currently exempt.
    let guard: ReturnType<typeof prepareCodexGuardHome>;
    try {
      guard = (this.options.prepareGuardHome ?? prepareCodexGuardHome)({});
    } catch (error) {
      compiled.restoreConfig?.();
      throw error;
    }
    onEvent({
      id: `codex-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      laneId: this.id,
      taskId: input.taskId,
      kind: "task.progress",
      message: CODEX_GUARD_NOTICE,
      timestamp: new Date().toISOString(),
      // `controlPlane`, as `CodexSessionDriver` already marks the same notice.
      // Without it MUON's own prose was recorded as the AGENT's words: two of
      // the three output chunks the founder's four-minute codex child produced
      // were this notice and the profile-unsupported line, not the agent.
      metadata: {
        controlPlane: true,
        codexGuardHome: true,
        codexAuthLinked: guard.authLinked,
      },
    });

    // Nested-sandbox lockout fix: appended AFTER the compiled profile args so
    // the last `-c sandbox_mode` wins (verified live). Only ever non-empty
    // inside MUON's own Seatbelt-confined runner, and never for a read-only
    // profile — see codex-guard.ts.
    // Derived from the COMPOSED argv, not from `profile.sandbox`: rawConfig and
    // extraArgs can each state `sandbox_mode` too, and an override appended
    // after them would silently reverse an operator's explicit tightening.
    const sandboxOverride = codexSandboxOverrideArgs(process.env, [
      ...invocation.args,
      ...compiled.args,
    ]);
    if (sandboxOverride.length > 0) {
      onEvent({
        id: `codex-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        laneId: this.id,
        taskId: input.taskId,
        kind: "task.progress",
        message: CODEX_NESTED_SANDBOX_NOTICE,
        timestamp: new Date().toISOString(),
        metadata: { controlPlane: true, codexNestedSandboxOverride: true },
      });
    }
    const compiledWithOverride = {
      ...compiled,
      args: [...compiled.args, ...sandboxOverride],
      // The guard env wins over anything the profile supplied: a profile that
      // set CODEX_HOME itself would otherwise re-point the child at the
      // operator's own configuration, which is the breach this closes.
      env: { ...compiled.env, ...codexGuardEnv(guard.home) },
    };

    // A resolved vendor action replaces the argv with a subcommand whose
    // stdout is a machine contract (`--json`) — pipes stay authoritative there.
    const ptyRun =
      options?.pty !== undefined && options?.argvOverride === undefined;

    // ONE statement of what actually bounds this child (F-A). Emitted after the
    // guard/sandbox notices and before the spawn, so a run that lost a declared
    // capability says so where the operator reads, not only in a runner log
    // line the event recorder coalesces away. `canAskApproval: false` is the
    // measured truth of this transport, pty or pipes: `codex exec` reports
    // `approval: never` however `approval_policy` was compiled (0.145.0), so no
    // tool call on this transport is ever put to a human. That is why governed
    // LOOP iterations no longer ride it — the runner routes them through the
    // app-server managed session, whose approval bridge is real — and why the
    // runs that legitimately remain here (an explicit one-shot, a resolved
    // vendor action's argv) carry this loud disclosure instead of a pretend
    // gate.
    //
    // Recompiled rather than threaded out of `compileRunProfile`: both calls
    // are pure, codex's registry entry sets `strictMcpConfigFlag: false` so no
    // sanitizing happens in between, and the alternative was widening the
    // shared base-adapter seam for one lane's notice.
    const declared = options?.profile
      ? compileCodexProfile(options.profile)
      : undefined;
    const toolPolicy = options?.profile
      ? compileCodexToolPolicy(options.profile)
      : undefined;
    const notice = codexCapabilityNotice({
      unsupported: declared?.unsupported ?? [],
      honoredDenials: toolPolicy?.honoredDenials ?? [],
      sandboxMode: effectiveCodexSandboxMode([
        ...invocation.args,
        ...compiledWithOverride.args,
      ]),
      canAskApproval: false,
    });
    if (notice) {
      onEvent({
        id: `codex-boundary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        laneId: this.id,
        taskId: input.taskId,
        kind: "task.progress",
        message: notice,
        timestamp: new Date().toISOString(),
        metadata: {
          controlPlane: true,
          codexCapabilityDegraded: declared?.unsupported ?? [],
          codexHonoredDenials: toolPolicy?.honoredDenials ?? [],
          codexApprovalGate: "none",
        },
      });
    }

    if (!ptyRun) {
      const { pty: _pty, ...rest } = options ?? {};
      const pipeOptions = options ? rest : options;
      // A resolved vendor action owns its own stdout contract, so MUON does not
      // re-shape it. Everything else on this transport goes through `--json`.
      if (options?.argvOverride !== undefined) {
        return this.spawnCompiledRun(
          input,
          onEvent,
          pipeOptions,
          invocation,
          compiledWithOverride
        );
      }
      return this.runJsonExec(
        input,
        onEvent,
        pipeOptions,
        invocation,
        compiledWithOverride
      );
    }

    // REAL-terminal run. Two extras ride along, both because a tty transcript
    // is a rendering rather than a parse surface:
    //  - `--output-last-message <file>`: the agent's final message lands as
    //    plain text on disk, so the handoff parser reads the authoritative
    //    report instead of fishing it out of ANSI (verified live, 0.145.0).
    //  - the exec banner's `session id:` line is captured from the console and
    //    reported as the vendor session id — the resume/backlink handle.
    // OWNER-ONLY, and a directory MUON created. The file holds the agent's
    // final report verbatim; in a shared /tmp a default umask left it
    // world-readable, and a bare predictable path could be pre-created by
    // another local user. `mkdtemp` yields a fresh unguessable directory and
    // the chmod removes group/other outright.
    const lastMessageDir = mkdtempSync(path.join(tmpdir(), "muon-codex-last-"));
    chmodSync(lastMessageDir, 0o700);
    const lastMessagePath = path.join(lastMessageDir, "last-message.txt");
    const brief = invocation.args[invocation.args.length - 1] ?? "";
    const ptyInvocation = {
      command: invocation.command,
      args: [
        ...invocation.args.slice(0, -1),
        "--output-last-message",
        lastMessagePath,
        brief,
      ],
    };
    let sessionIdReported = false;
    let bannerTail = "";
    const wrappedOptions: LaneRunOptions = {
      ...options,
      onBytes: (frame) => {
        options?.onBytes?.(frame);
        if (!sessionIdReported && bannerTail.length < 16_384) {
          bannerTail += frame.data;
          const sessionId = codexSessionIdFromOutput(bannerTail);
          if (sessionId) {
            sessionIdReported = true;
            bannerTail = "";
            options?.onVendorSessionId?.(sessionId);
          }
        }
      },
    };
    try {
      const result = await this.spawnCompiledRun(
        input,
        onEvent,
        wrappedOptions,
        ptyInvocation,
        compiledWithOverride
      );
      let lastMessage = "";
      try {
        lastMessage = readFileSync(lastMessagePath, "utf8").trim();
      } catch {
        // No file ⇒ the run died before a final message; the console text is
        // all there is, and that is what the result already carries.
      }
      return lastMessage.length > 0
        ? {
            ...result,
            // The recovered console keeps the transcript; the authoritative
            // final message is appended LAST so `^GOAL:`-style anchors resolve
            // to the agent's actual report, exactly as the pipes path ends
            // with the final message.
            output: `${result.output.trimEnd()}\n\n${lastMessage}`,
          }
        : result;
    } finally {
      // The whole directory, so nothing of the report is left behind.
      rmSync(lastMessageDir, { recursive: true, force: true });
    }
  }

  /**
   * PIPES run, on the vendor's MACHINE stream (F-B).
   *
   * Measured live (0.145.0): `codex exec` writes its whole activity console to
   * STDERR and only the final agent message to STDOUT. MUON's pipes transport
   * records stdout as the agent's stream and hands stderr to the watchdog, so a
   * loop-dispatched codex child's feed was its closing sentence and nothing
   * else — no tool call it made ever appeared, including the governed `muon`
   * ones. `--json` moves the vendor's own event stream onto stdout, which is a
   * contract rather than a rendering; ./codex-exec-stream.ts translates it into
   * the SAME activity events the interactive driver emits.
   *
   * Three consequences are handled here, and each is the reason for its line:
   *  - the raw JSONL must NOT be recorded as the agent's words, so the
   *    transport's own stdout progress events are dropped and replaced;
   *  - `output` must stay what every downstream reader already expects — the
   *    agent's final message — so it comes from `--output-last-message`, the
   *    same authoritative file the pty path reads, never from the JSONL;
   *  - the live terminal must not become a JSON firehose, so it receives
   *    MUON's own compact per-item rendering instead of the vendor bytes.
   */
  private async runJsonExec(
    input: LaneTaskSubmission,
    onEvent: (event: LaneEvent) => void,
    options: LaneRunOptions | undefined,
    invocation: { command: string; args: string[] },
    compiled: { args: string[]; env?: Record<string, string> }
  ): Promise<LaneCommandResult> {
    // OWNER-ONLY, and a directory MUON created — same reasoning as the pty
    // path: the file holds the agent's final report verbatim.
    const lastMessageDir = mkdtempSync(path.join(tmpdir(), "muon-codex-last-"));
    chmodSync(lastMessageDir, 0o700);
    const lastMessagePath = path.join(lastMessageDir, "last-message.txt");
    const brief = invocation.args[invocation.args.length - 1] ?? "";
    const jsonInvocation = {
      command: invocation.command,
      // The brief stays the SOLE trailing positional; the flags go before it.
      args: [
        ...invocation.args.slice(0, -1),
        ...CODEX_EXEC_JSON_ARGS,
        "--output-last-message",
        lastMessagePath,
        brief,
      ],
    };
    const stream = createCodexExecStream({
      laneId: this.id,
      taskId: input.taskId,
      onEvent,
      ...(options?.onVendorSessionId
        ? { onVendorSessionId: options.onVendorSessionId }
        : {}),
      ...(options?.onBytes
        ? {
            onConsole: (line: string) =>
              options.onBytes?.({ stream: "stdout", data: line }),
          }
        : {}),
    });
    const wrappedOptions: LaneRunOptions = {
      ...options,
      onBytes: (frame) => {
        if (frame.stream === "stdout") {
          // Translated above into typed activity; the raw JSONL never reaches
          // the pane. stderr still passes through untouched — under `--json`
          // that is where a fatal codex failure is written.
          stream.admit(frame.data);
          return;
        }
        options?.onBytes?.(frame);
      },
    };
    const onEventFiltered = (event: LaneEvent): void => {
      // The transport's stdout progress events ARE the raw JSONL. MUON's own
      // control-plane events and the run lifecycle (started/completed/blocked)
      // pass through unchanged.
      if (
        event.kind === "task.progress" &&
        event.metadata.controlPlane !== true
      ) {
        return;
      }
      onEvent(event);
    };
    try {
      const result = await this.spawnCompiledRun(
        input,
        onEventFiltered,
        wrappedOptions,
        jsonInvocation,
        compiled
      );
      let lastMessage = "";
      try {
        lastMessage = readFileSync(lastMessagePath, "utf8").trim();
      } catch {
        // No file ⇒ the run died before a final message.
      }
      const finalMessage = lastMessage || stream.finalMessage().trim();
      return {
        ...result,
        // Byte-for-byte what this path produced BEFORE `--json`: stdout was
        // the final agent message and nothing else. When the vendor never
        // spoke the machine stream at all (an older codex without `--json`),
        // its stdout is kept verbatim rather than replaced with silence.
        output: stream.sawEvents() ? finalMessage : result.output,
      };
    } finally {
      // The whole directory, so nothing of the report is left behind.
      rmSync(lastMessageDir, { recursive: true, force: true });
    }
  }

  /**
   * Official non-interactive mode. The suppression args sit between the
   * subcommand and the brief so the brief stays the sole positional; they are
   * emitted HERE rather than in `compileCodexProfile` because a run that
   * carries no profile at all must still be isolated.
   */
  override taskCommand(brief: string) {
    return {
      command: "codex",
      args: ["exec", ...CODEX_AMBIENT_SUPPRESSION_ARGS, brief],
    };
  }

  /** Categorical last-mile net; see `stripCodexWideningArgs`. */
  protected override guardFinalArgs(args: string[]): string[] {
    return guardedCodexArgs(args);
  }
}
