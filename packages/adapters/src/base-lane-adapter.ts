import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  VENDOR_REGISTRY,
  isVendorId,
  type AgentRole,
  type LaneAdapter,
  type LaneCapabilities,
  type LaneEvent,
  type LaneHealth,
  type LaneProfile,
  type LaneSessionInput,
  type LaneTaskSubmission,
} from "@muon/protocol";
import { commandExists, firstAvailableCommand } from "./command-check.js";
import { runLaneCommand, type LaneCommandResult } from "./lane-runner.js";
import { compileProfileForLane } from "./profile-compiler.js";
import { sanitizeGuardedArgs } from "./vendor-capabilities.js";

/**
 * Run-scoped vendor config files currently held by at least one live run, keyed by
 * absolute path: the bytes to put back when the LAST holder finishes.
 *
 * Reference counted because these files are shared by construction, not by
 * accident. Every read-only harness — review, planner, research, security-audit —
 * is `worktree: false` and therefore runs in the primary checkout, and the runner's
 * default concurrency is 6, so two reviewers on one workspace share a cwd as a
 * matter of course. Snapshotting per-run made the second writer's "prior" the FIRST
 * writer's MUON content, so the first to finish either deleted or repo-reverted the
 * still-running lane's only `Task` suppression — reopening the hostile-repo hole by
 * dispatching two reviewers instead of one — and the human's tracked config was
 * then left holding MUON's bytes forever, which is the dirty-base breakage the
 * restore exists to prevent. Same process by construction: MUON spawns every lane.
 */
const runScopedConfigHolds = new Map<
  string,
  { prior: Buffer | null; holders: number }
>();

/**
 * TODO 1.14 — enforce the word "run-scoped", which until now was only a promise
 * in a doc comment.
 *
 * "MUON never writes user-global vendor config" is the claim the whole
 * containment posture rests on, and 1.14's decision (attach telemetry, not
 * lifecycle hooks) is chosen BECAUSE of it. Two escapes had to be closed:
 *
 * 1. Lexical: the field is named `relativePath` and the write was
 *    `path.join(baseDir, …)`, so `"../../.claude/settings.json"` compiled by any
 *    lane would have landed above the run cwd — the exact file 1.15 measured
 *    cursor replaying. Absolute paths are refused rather than reinterpreted:
 *    `path.join` already swallows a leading `/` into `<cwd>/…`, which is
 *    contained but is not what the caller wrote.
 *
 * 2. Symlink: `acquireRunScopedConfig` already replaces a SYMLINKED LEAF with a
 *    regular file so the write stays in-cwd. A hostile checkout can still check
 *    in an intermediate directory as a symlink (`.cursor` → `~/.cursor`); the
 *    lexical check passes, `lstat` on the leaf follows the directory link onto
 *    the user's global file, and the write lands outside the run. So every
 *    existing ancestor of the target is walked with `lstat`, and a symlink
 *    whose `realpath` escapes the run's realpath is refused. Missing ancestors
 *    are fine — `mkdirSync` creates ordinary directories.
 *
 * The comparison uses a separator suffix so `<cwd>-evil` cannot pass as a child
 * of `<cwd>`.
 */
export function assertInsideRunScope(
  baseDir: string,
  relativePath: string
): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(
      `run-scoped config write must be relative to the run cwd, got absolute '${relativePath}'`
    );
  }
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, relativePath);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) {
    throw new Error(
      `run-scoped config write '${relativePath}' escapes the run cwd — MUON does not write vendor config outside the run (TODO 1.14)`
    );
  }

  let realBase: string;
  try {
    realBase = realpathSync(resolvedBase);
  } catch {
    // The run cwd itself may not exist yet on a brand-new worktree; lexical
    // containment is then the whole answer, because there is nothing to follow.
    return target;
  }

  const relative = path.relative(resolvedBase, target);
  let cursor = resolvedBase;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      // Remaining path does not exist — mkdirSync will create ordinary dirs.
      break;
    }
    if (!st.isSymbolicLink()) {
      continue;
    }
    let real: string;
    try {
      real = realpathSync(cursor);
    } catch {
      throw new Error(
        `run-scoped config write '${relativePath}' escapes the run cwd via a dangling symlink at '${path.relative(resolvedBase, cursor)}' (TODO 1.14)`
      );
    }
    if (real !== realBase && !real.startsWith(realBase + path.sep)) {
      throw new Error(
        `run-scoped config write '${relativePath}' escapes the run cwd via symlink at '${path.relative(resolvedBase, cursor)}' (TODO 1.14)`
      );
    }
  }
  return target;
}

/**
 * Take a hold on one config path, writing MUON's contents. The FIRST holder
 * captures the prior bytes; later holders join the existing hold and write nothing,
 * so a concurrent lane cannot be handed a document MUON did not author.
 */
function acquireRunScopedConfig(target: string, contents: string): void {
  const existing = runScopedConfigHolds.get(target);
  if (existing) {
    existing.holders += 1;
    // Deliberately not rewritten: with identical guard documents this is a no-op,
    // and with differing ones the FIRST writer's posture is the one already being
    // enforced on a live child. Silently swapping it under that child is the race
    // this whole mechanism exists to stop.
    return;
  }
  // `lstat`, not `stat`: a symlinked config would make `writeFileSync` follow the
  // link and plant MUON's table OUTSIDE the run cwd — the opposite of run-scoped —
  // and a DANGLING link reads as "absent", so the restore's `rmSync` would delete
  // the human's link outright. Replacing the link with a regular file keeps the
  // write inside the cwd, and the link itself is what gets restored.
  let prior: Buffer | null = null;
  let symlinked = false;
  try {
    symlinked = lstatSync(target).isSymbolicLink();
    // Bytes, not a decoded string: this is the one code path whose entire purpose
    // is putting the human's EXACT file back, and a utf8 round-trip turns any
    // invalid sequence into U+FFFD.
    prior = symlinked
      ? Buffer.from(readlinkSync(target), "utf8")
      : readFileSync(target);
  } catch {
    prior = null;
    symlinked = false;
  }
  if (symlinked) {
    rmSync(target, { force: true });
    runScopedConfigSymlinks.add(target);
  }
  runScopedConfigHolds.set(target, { prior, holders: 1 });
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** Paths whose captured `prior` is a SYMLINK TARGET rather than file bytes. */
const runScopedConfigSymlinks = new Set<string>();

/** Drop one hold; the last one out restores what was there before. */
function releaseRunScopedConfig(target: string): void {
  const hold = runScopedConfigHolds.get(target);
  if (!hold) return;
  hold.holders -= 1;
  if (hold.holders > 0) return;
  runScopedConfigHolds.delete(target);
  const wasSymlink = runScopedConfigSymlinks.delete(target);
  try {
    if (hold.prior === null) {
      rmSync(target, { force: true });
    } else if (wasSymlink) {
      rmSync(target, { force: true });
      symlinkSync(hold.prior.toString("utf8"), target);
    } else {
      writeFileSync(target, hold.prior);
    }
  } catch {
    // Best-effort: a failed restore must never fail a completed run.
  }
}

/**
 * What a lane knows about the run while it builds its own invocation. Most
 * vendors take everything through the profile compiler, but some carry a value
 * on their OWN argv: cursor needs `--workspace <cwd>`, and the Codex OSS runtime
 * takes the local model as `-m` before the prompt. Both fields are optional so
 * an adapter that does not need them keeps the one-argument override.
 */
export type LaneTaskContext = {
  cwd?: string;
  profile?: LaneProfile;
};

/**
 * Everything one non-interactive run may be told. Named (it used to be an
 * inline literal on `runTask`) so the seams below — and a lane that executes
 * through a non-argv channel — all speak the SAME option set, instead of each
 * re-declaring a subset that could drift.
 */
export type LaneRunOptions = {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  profile?: LaneProfile;
  /**
   * ADR-0013 #52, a per-run subcommand override. When a resolved vendor
   * action uses the `subcommand` channel (e.g. `claude ultrareview <target>
   * --json`), the resolver supplies the argv and it REPLACES the default
   * `taskCommand`. `command` defaults to this lane's own binary so the
   * override only re-shapes the args, never escapes the vendor. This is the
   * one new dispatch capability v1 adds; everything else reuses the compiler.
   */
  argvOverride?: { command?: string; args: string[] };
  /**
   * Live stderr sink for a caller that must diagnose the child while it is
   * still running (the runner's liveness watchdog). Purely additive: the
   * returned `errorOutput` is unchanged whether or not it is supplied.
   */
  onDiagnostic?: (chunk: string) => void;
  /**
   * Live console-byte sink (see `LaneCommandInput.onBytes`). Reaches only the
   * SPAWN seam: a lane that executes through a non-argv channel has no console
   * to relay, and the absence of frames is exactly how the job reports that
   * honestly rather than offering a blank live pane.
   */
  onBytes?: (frame: { stream: "stdout" | "stderr"; data: string }) => void;
  /**
   * REAL-terminal transport for the spawn seam (see `LanePtyOptions`). Only a
   * lane that declares `prefersPtyConsole` uses it; every other lane keeps
   * pipes, because their contracts depend on them (cursor requires clean JSON
   * stdout, `codex app-server` speaks JSON-RPC that a pty's echo would corrupt).
   */
  pty?: import("./lane-runner.js").LanePtyOptions;
  /**
   * Fired once, as soon as the vendor's OWN session id for this run is known
   * (codex prints it in its exec banner; the Claude driver reads it from the
   * SDK stream). This is the resume/backlink handle: the caller persists it so
   * the human can reopen the SAME vendor session in the vendor's real TUI.
   */
  onVendorSessionId?: (vendorSessionId: string) => void;
};

export abstract class BaseLaneAdapter implements LaneAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly provider: string;
  abstract readonly role: "peer" | "worker";
  abstract readonly commandCandidates: string[];
  abstract readonly laneCapabilities: LaneCapabilities;
  /**
   * True for a lane whose one-shot child should run on a REAL pty when the
   * caller can supply one: its console then reaches the live viewer as the
   * vendor's native rendering. Default false — pipes are a CONTRACT for most
   * lanes (cursor's JSON stdout, opencode's line protocol), so a lane opts in
   * explicitly, never by omission.
   */
  readonly prefersPtyConsole: boolean = false;
  /**
   * ABSTRACT, not defaulted. A subclass does not compile until it has STATED
   * its role ceiling, which is the whole mechanism behind "a new adapter starts
   * with no authority": a default here — even `[]` — would let the answer be
   * inherited rather than typed, and inheriting it is how the optional field
   * this replaces came to admit every role (ADR-0022 §1.2(b)).
   */
  abstract readonly supportedRoles: readonly AgentRole[];

  protected getAvailableCommand() {
    return firstAvailableCommand(this.commandCandidates);
  }

  async health(): Promise<LaneHealth> {
    const available = this.getAvailableCommand();
    if (!available) {
      return {
        status: "unavailable",
        details: [
          `Missing CLI binary. Expected one of: ${this.commandCandidates.join(", ")}`,
        ],
      };
    }

    return {
      status: "healthy",
      details: [`Using '${available}' binary`],
    };
  }

  async capabilities(): Promise<LaneCapabilities> {
    return this.laneCapabilities;
  }

  async startSession(input: LaneSessionInput): Promise<{ sessionId: string }> {
    return {
      sessionId: `${this.id}:${input.taskId}:${Date.now()}`,
    };
  }

  async resumeSession(sessionId: string): Promise<{ sessionId: string }> {
    return { sessionId };
  }

  async submitTask(_input: LaneTaskSubmission): Promise<void> {
    return;
  }

  async interrupt(_taskId: string): Promise<void> {
    return;
  }

  /**
   * Maps a task brief to this lane's non-interactive CLI invocation.
   * Subclasses override to use the vendor's official one-shot mode.
   */
  taskCommand(
    brief: string,
    _context?: LaneTaskContext
  ): { command: string; args: string[] } {
    return { command: this.commandCandidates[0] ?? "", args: [brief] };
  }

  /**
   * Last-mile guard over the FINAL composed argv (invocation + compiled profile)
   * immediately before spawn. Identity here; a lane whose vendor owns flags that
   * WIDEN authority overrides it, so no composition path — a subcommand
   * override, the profile compiler, `extraArgs` — can reintroduce one. Same
   * bounded-surface rule as `sanitizeGuardedArgs`: the net is categorical, so a
   * new path into the argv is covered by construction.
   */
  protected guardFinalArgs(args: string[]): string[] {
    return args;
  }

  /**
   * The argv this run would spawn: this lane's own invocation, or the resolved
   * vendor action that REPLACES it (ADR-0013 #52).
   */
  protected resolveInvocation(
    input: LaneTaskSubmission,
    options?: LaneRunOptions
  ): { command: string; args: string[] } {
    const base = this.taskCommand(input.brief, {
      cwd: options?.cwd,
      profile: options?.profile,
    });
    return options?.argvOverride
      ? {
          command: options.argvOverride.command ?? base.command,
          args: options.argvOverride.args,
        }
      : base;
  }

  /**
   * Check the binary the task will actually spawn, not just any candidate,
   * e.g. the IDE launcher may exist while the agent CLI is missing.
   */
  protected assertLaneBinaryAvailable(command: string): void {
    if (!commandExists(command)) {
      throw new Error(
        `Lane '${this.id}' is not available. Install '${command}' (expected one of: ${this.commandCandidates.join(", ")})`
      );
    }
  }

  /**
   * The vendor config a governed run must get EVEN WITH NO PROFILE.
   *
   * Empty for most lanes. A lane overrides it when its isolation lives in a FILE
   * rather than on the argv, because `profile` is optional on both
   * `RunLaneTaskInput` and `LaneRunOptions` and `compileRunProfile` returns early
   * without one — so a guard that only rides the compiler is one omitted field away
   * from not existing. Codex solved the same problem for its argv half by putting
   * `CODEX_AMBIENT_SUPPRESSION_ARGS` in `taskCommand`; this is the file half.
   */
  protected mandatoryConfigWrites(): readonly {
    relativePath: string;
    contents: string;
  }[] {
    return [];
  }

  /**
   * Write run-scoped vendor config into the run cwd, never user-global, and
   * return the undo.
   *
   * The undo is not tidiness. Lanes whose `worktree` capability is `false` — every
   * read-only reviewer, cursor included — run in the human's REAL checkout, and
   * these paths (`.cursor/cli.json`, `.cursor/hooks.json`, `.claude/settings.local
   * .json`) are ones a repository may legitimately TRACK. Left behind, MUON's write
   * either appears as an untracked file or, worse, as a modification to the human's
   * committed config: `checkMergeReadiness` then reports "the primary checkout has
   * uncommitted changes" and every governed merge is blocked by MUON's own
   * footprint, while the human's real settings stay silently overwritten.
   *
   * So the prior bytes are captured before the write and put back after the run:
   * exact content if the file existed, removed if it did not. Restoring content is
   * preferred over exempting these paths from the dirty-base fence, because an
   * exemption would ALSO hide a genuine human edit to the same file.
   */
  private writeRunScopedConfig(
    writes: readonly { relativePath: string; contents: string }[],
    cwd?: string
  ): () => void {
    const baseDir = path.resolve(cwd ?? process.cwd());
    const held: string[] = [];
    const undo = () => {
      for (const target of held.reverse()) releaseRunScopedConfig(target);
      held.length = 0;
    };
    try {
      for (const write of writes) {
        const target = assertInsideRunScope(baseDir, write.relativePath);
        acquireRunScopedConfig(target, write.contents);
        held.push(target);
      }
    } catch (error) {
      // A write that fails PART WAY through must not leave the earlier ones
      // standing: the human's `.cursor/cli.json` would be permanently MUON's, with
      // nothing left holding the bytes to put back. Roll back, then report.
      undo();
      throw error;
    }
    return undo;
  }

  /**
   * Compile the lane profile for ONE run: write the run-scoped config, report
   * the fields this lane cannot express, and return the vendor argv segment
   * plus the child env.
   *
   * Extracted from `runTask` so a lane that executes through a NON-argv channel
   * (the Claude one-shot session, see claude-adapter.ts) compiles the profile
   * through exactly this seam. The compiler stays the single source of truth
   * for what a profile grants — a governance rule that only lives in the
   * compiler (e.g. `sandbox: "read-only"` adding the write-tool denials) can
   * then never be lost by a channel that re-derives the profile itself.
   */
  protected compileRunProfile(
    input: LaneTaskSubmission,
    onEvent: (event: LaneEvent) => void,
    options?: Pick<LaneRunOptions, "cwd" | "profile">
  ): {
    args: string[];
    env?: Record<string, string>;
    restoreConfig?: () => void;
  } {
    if (!options?.profile) {
      return {
        args: [],
        restoreConfig: this.writeRunScopedConfig(
          this.mandatoryConfigWrites(),
          options?.cwd
        ),
      };
    }
    // Whether this vendor's CLI HAS `--strict-mcp-config` — a property of its
    // flag vocabulary, not of its name (ADR-0022 §1.2(f), G9). The flag would
    // evict MUON's own governed MCP server, so the lanes that have it get their
    // argv sanitized. Fail-closed to `false` for an id outside the registry:
    // that is what the `this.id === "claude-code"` this replaces already did,
    // and MUON never constructs an adapter for an unregistered lane.
    const guardStrictMcpConfig =
      isVendorId(this.id) &&
      VENDOR_REGISTRY[this.id].execution.guards.strictMcpConfigFlag;
    const profile = guardStrictMcpConfig
      ? {
          ...options.profile,
          extraArgs: sanitizeGuardedArgs(options.profile.extraArgs).args,
        }
      : options.profile;
    const compiled = compileProfileForLane(this.id, profile);
    const args = guardStrictMcpConfig
      ? sanitizeGuardedArgs(compiled.args, {
          allowLeadingCompilerOwnedStrictMcpConfig: true,
        }).args
      : compiled.args;
    const env =
      Object.keys(compiled.env).length > 0 ? compiled.env : undefined;

    const restoreConfig = this.writeRunScopedConfig(
      compiled.configWrites,
      options.cwd
    );

    for (const item of compiled.unsupported) {
      onEvent({
        id: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        laneId: this.id,
        taskId: input.taskId,
        kind: "task.progress",
        message: `profile: '${item}' is not supported by this lane`,
        timestamp: new Date().toISOString(),
        // `controlPlane`: this is MUON's OWN statement about the run, not the
        // agent's words. Without it a lane-capability loss was filed as
        // ASSISTANT OUTPUT — it landed in the stream the human reads as the
        // agent talking, and in the text the report parsers read.
        metadata: { controlPlane: true, profileUnsupported: item },
      });
    }

    return { args, ...(env ? { env } : {}), restoreConfig };
  }

  /**
   * Spawn one already-compiled run. Split out of `runTask` so a lane that
   * decided against its non-argv channel can fall back here WITHOUT compiling
   * the profile a second time (which would duplicate the run-scoped config
   * writes and the `profileUnsupported` diagnostics).
   */
  protected spawnCompiledRun(
    input: LaneTaskSubmission,
    onEvent: (event: LaneEvent) => void,
    options: LaneRunOptions | undefined,
    invocation: { command: string; args: string[] },
    compiled: {
      args: string[];
      env?: Record<string, string>;
      restoreConfig?: () => void;
    }
  ): Promise<LaneCommandResult> {
    // The run-scoped config is put back once the child is GONE, not before: the
    // vendor reads these files at startup and may re-read them mid-run, so an
    // earlier restore would hand the run the very policy MUON replaced. The
    // argv guards are INSIDE the wrapper so a refusal restores too.
    return this.withRestoredConfig(compiled.restoreConfig, () => {
      const invocationArgs =
        isVendorId(this.id) &&
        VENDOR_REGISTRY[this.id].execution.guards.strictMcpConfigFlag
          ? sanitizeGuardedArgs(invocation.args).args
          : invocation.args;

      // Preserve provenance: invocation and compiled profile argv are guarded as
      // separate segments. Only index 0 of the compiled Claude segment can carry
      // the compiler-owned strict flag; concatenation grants no new authority.
      // `guardFinalArgs` is the lane's own last-mile net over the composed result.
      const args = this.guardFinalArgs([...invocationArgs, ...compiled.args]);

      return runLaneCommand({
        laneId: this.id,
        taskId: input.taskId,
        command: invocation.command,
        args,
        cwd: options?.cwd,
        env: compiled.env,
        // The vendor config references MCP env BY NAME (S2); the seam below is
        // where the deny-first lane filter runs, so it is also the only place
        // that can prove the named values actually survived it.
        ...(options?.profile ? { mcpServers: options.profile.mcpServers } : {}),
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        onEvent,
        ...(options?.onDiagnostic
          ? { onDiagnostic: options.onDiagnostic }
          : {}),
        ...(options?.onBytes ? { onBytes: options.onBytes } : {}),
        // The pty transport is DOUBLE-gated: the caller must supply it AND this
        // lane must have opted in. Neither alone re-parents a pipes-contract
        // lane.
        ...(options?.pty && this.prefersPtyConsole ? { pty: options.pty } : {}),
      });
    });
  }

  /**
   * Run `body`, then put the run-scoped vendor config back — on success, on
   * failure, and on cancellation alike. A restore that only happened on the happy
   * path would leave MUON's config in the human's checkout after exactly the runs
   * most likely to be retried.
   */
  protected async withRestoredConfig<T>(
    restore: (() => void) | undefined,
    body: () => Promise<T>
  ): Promise<T> {
    try {
      // `await` inside the try, not a returned promise: a body that throws
      // SYNCHRONOUSLY (an argv guard refusing, a spawn precondition) has to reach
      // the `finally` too, and `return body()` would let it escape past it.
      return await body();
    } finally {
      restore?.();
    }
  }

  async runTask(
    input: LaneTaskSubmission,
    onEvent: (event: LaneEvent) => void,
    options?: LaneRunOptions
  ): Promise<LaneCommandResult> {
    const invocation = this.resolveInvocation(input, options);
    this.assertLaneBinaryAvailable(invocation.command);
    const compiled = this.compileRunProfile(input, onEvent, options);
    return this.spawnCompiledRun(input, onEvent, options, invocation, compiled);
  }
}
