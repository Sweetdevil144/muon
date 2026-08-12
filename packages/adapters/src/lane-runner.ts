import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  allVendorCredentialEnvKeys,
  vendorCredentialEnvKeys,
  type LaneEvent,
  type LaneEventKind,
  type McpServerConfig,
} from "@muon/protocol";
import {
  ALL_LANE_GUARD_ENV_KEYS,
  LANE_GUARD_ENV_KEYS,
} from "./lane-guard-env.js";
import { assertMuonMcpEnvContract } from "./mcp-env-contract.js";
import {
  OPERATOR_TOKEN_ENV_VARS,
  RUNNER_ENV_ALLOWLIST,
} from "./sandbox/launcher.js";
import { normalizePtyOutput } from "./pty-text.js";
import { resolveVendorCredentialEvidence } from "./provider-credentials.js";

/**
 * The slice of a pty child this runner drives. Structurally node-pty's IPty,
 * stated locally so @muon/adapters never imports the native module — the
 * FACTORY is injected by the process that owns the dependency (the desktop
 * runner entry), and tests inject a fake.
 */
export type LanePtyProcess = {
  /**
   * The child's OS pid. Load-bearing, not diagnostic: node-pty calls setsid(),
   * so the child LEADS ITS OWN PROCESS GROUP and is unreachable from every
   * group-based teardown MUON otherwise has (the runner's parent guard signals
   * `-runnerPid`; the supervisor signals the runner's group). Killing
   * `-childPid` is the only way to take the vendor's own descendants with it.
   */
  pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
};

export type LanePtySpawn = (options: {
  file: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}) => LanePtyProcess;

/**
 * Opt-in REAL-terminal transport for one lane command. When present, the
 * vendor child is spawned on a pseudo-terminal instead of pipes: the raw
 * console bytes (native colours, spinner redraws, proper `\r\n` line
 * discipline) reach `onBytes` exactly as a human terminal would receive them,
 * which is what makes the desktop's live pane the vendor's REAL console
 * rather than a staircase of piped fragments. The returned `output` is the
 * ANSI-recovered plain text (see ./pty-text.ts), so every downstream parser —
 * final-report anchors, token usage, the recorded stream — keeps working.
 *
 * Two honest costs, both carried by the caller's own accounting rather than
 * papered over here: a pty merges stderr into stdout (so `errorOutput` is
 * empty and `onDiagnostic` never fires on this path), and the terminal size
 * is fixed at spawn (the read-only viewer renders at the same size).
 */
export type LanePtyOptions = {
  spawn: LanePtySpawn;
  cols?: number;
  rows?: number;
};

/** Fixed size for dispatched-job consoles; the viewer renders at the same
 *  geometry so wrapping is byte-faithful. */
export const LANE_PTY_COLS = 120;
export const LANE_PTY_ROWS = 32;

/**
 * Rolling cap on the recovered plain-text `output` of a pty run.
 *
 * The TAIL is kept, never the head: `parseWorkerFinalReport` anchors on labels
 * the agent writes at the END of its turn, and every consumer already slices a
 * tail (`result.output.slice(-4000)`). Without a cap a chatty multi-megabyte
 * run would pin an unbounded string in runner memory for the whole execution.
 */
const PTY_OUTPUT_TAIL_CHARS = 256 * 1024;

/**
 * Ceiling on text held back waiting for a line terminator.
 *
 * Normalization cuts at `\n` so a redraw run (`\r`-only spinner output) and a
 * split escape sequence are never torn mid-sequence. A vendor that writes this
 * much with no `\n` is not producing line output, so the buffer is flushed
 * rather than grown — bounded memory beats a perfectly-folded redraw.
 */
const PTY_PENDING_CEILING_CHARS = 64 * 1024;

/**
 * EVERY live pty child this process owns.
 *
 * The registry exists because a pty child cannot be reached the way every
 * other MUON child can. node-pty calls setsid(), so the child is its own
 * process-group leader: the runner's parent-loss guard (`kill(-runnerPid)`)
 * and the desktop supervisor's group signal both sweep the runner's group and
 * miss it entirely. On an Electron crash or a runner force-kill that left a
 * `danger-full-access` vendor child ALIVE — still editing the worktree, with
 * nothing observing it. The runner's own exit paths call
 * {@link terminateLanePtyChildren}, which reaches each child by its OWN group.
 */
const liveLanePtyChildren = new Set<LanePtyProcess>();

/** Live pty children owned by this process (teardown assertions + tests). */
export function liveLanePtyChildCount(): number {
  return liveLanePtyChildren.size;
}

/**
 * Signal one pty child's WHOLE process group, falling back to the handle.
 *
 * The group is what matters: a vendor CLI spawns shells of its own, and those
 * grandchildren inherit the child's group. Signalling only the pty leader
 * leaves them running.
 */
function signalLanePtyChild(child: LanePtyProcess, signal: string): void {
  const pid = child.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // No such group (already reaped), or a platform without process groups —
      // fall through to the handle's own kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone; onExit has settled or will.
  }
}

/**
 * Terminate every live pty child, group and all. Called from the runner's own
 * exit/signal handlers — the group-based sweeps cannot see these children.
 *
 * SIGTERM first so a vendor can flush, then SIGKILL for anything still alive.
 * Synchronous and total: a crash-path handler may not get another tick, so the
 * escalation timer is unref'd and the SIGTERM is what must land.
 */
export function terminateLanePtyChildren(graceMs = 2000): void {
  const children = [...liveLanePtyChildren];
  for (const child of children) {
    signalLanePtyChild(child, "SIGTERM");
  }
  if (children.length === 0) return;
  const hardKill = setTimeout(() => {
    for (const child of children) {
      if (liveLanePtyChildren.has(child)) {
        signalLanePtyChild(child, "SIGKILL");
      }
    }
  }, graceMs);
  hardKill.unref?.();
}

export type LaneCommandInput = {
  laneId: string;
  taskId: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Spawn on a real pseudo-terminal instead of pipes. See LanePtyOptions. */
  pty?: LanePtyOptions;
  onEvent: (event: LaneEvent) => void;
  /**
   * Live view of the child's stderr, chunk by chunk. `errorOutput` still
   * accumulates the same bytes for the terminal result, but a caller that must
   * reason about a child WHILE it runs (the runner's liveness watchdog) cannot
   * wait for close: a provider that rejects on quota/billing can take minutes to
   * answer, and its warnings on stderr are the only evidence available inside
   * the watchdog window. Optional, and raw — bounding and redaction belong to
   * the consumer that surfaces it.
   */
  onDiagnostic?: (chunk: string) => void;
  /**
   * Raw console bytes, exactly as the child wrote them, on whichever of its two
   * streams they arrived. This is the LIVE TERMINAL sink: `onEvent` already
   * carries stdout, but `.trimEnd()`-ed per chunk and mixed with MUON's own
   * lifecycle lines, so it cannot reconstruct what the console looked like.
   *
   * Purely observational and purely optional. It changes no argv, no env, and
   * no stdio: the child is spawned the same way either way, and stdout and
   * stderr stay separate pipes, which is what keeps `errorOutput` and the
   * liveness watchdog working. Omitting it leaves the run byte-identical.
   */
  onBytes?: (frame: { stream: "stdout" | "stderr"; data: string }) => void;
  /**
   * The profile's MCP servers, supplied so this seam can verify that the
   * governed MUON server's env survived the deny-first lane filter below. The
   * compiled `env` alone cannot express that: it is a flat bag of values, while
   * the vendor config references them BY NAME. Optional — a caller that omits
   * it keeps today's behavior exactly. See ./mcp-env-contract.ts.
   */
  mcpServers?: readonly McpServerConfig[];
};

export type LaneCommandResult = {
  exitCode: number;
  output: string;
  errorOutput: string;
  durationMs: number;
};

/**
 * WAVE C5: the per-vendor table this used to hold by hand is now
 * `credentials.envKeys` in the ADR-0022 registry, read through a FAIL-CLOSED
 * accessor. A vendor MUON has never heard of gets no credential at all, and a
 * vendor that states `envKeys: []` (opencode is BYO-provider, reading its own
 * `auth.json`) receives nothing rather than inheriting a neighbour's key.
 *
 * The union stays a UNION of stated keys — never a subtraction — because it is
 * the deny side of this filter: a key that falls out of it is one a stranger's
 * child would silently receive (ADR-0022 G5).
 */
const ALL_VENDOR_ENV_KEYS = new Set<string>(allVendorCredentialEnvKeys());
const RUNNER_CONTROL_ENV_KEYS = new Set<string>([
  ...OPERATOR_TOKEN_ENV_VARS,
  "MUON_RUNNER_HOST",
  "MUON_RUNNER_LEASE_TOKEN",
  "ELECTRON_RUN_AS_NODE",
]);
/**
 * Lane-guard keys are filtered OUT of the common slice on purpose. They ARE in
 * `RUNNER_ENV_ALLOWLIST` — the runner must be able to find an operator who
 * relocated their vendor install — but the ambient value must reach no child:
 * inheriting it is precisely the breach `codex-guard.ts` closes. Only MUON's
 * own explicit per-lane override sets one. See lane-guard-env.ts.
 */
const COMMON_LANE_ENV_KEYS = [
  ...RUNNER_ENV_ALLOWLIST.filter(
    (key) =>
      !ALL_VENDOR_ENV_KEYS.has(key) &&
      !ALL_LANE_GUARD_ENV_KEYS.has(key) &&
      !RUNNER_CONTROL_ENV_KEYS.has(key)
  ),
  "MUON_API_BASE",
  "MUON_SANDBOX_ACTIVE",
] as const;

/**
 * Build the environment visible to one vendor execution.
 *
 * The runner may coordinate multiple vendors, but a child receives only its
 * own API-key fallback plus the non-secret runtime/MCP coordinates it needs.
 * Operator and runner-control capabilities are categorically withheld.
 */
export function buildLaneEnvironment(
  laneId: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
  overrides?: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of COMMON_LANE_ENV_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  const allowedVendorKeys = new Set<string>(vendorCredentialEnvKeys(laneId));
  for (const key of allowedVendorKeys) {
    const value = parentEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Deliberately NOT copied from `parentEnv`: a guard key is MUON's to set, so
  // the ambient value must never be inherited — that inheritance was the breach.
  const allowedGuardKeys = new Set<string>(LANE_GUARD_ENV_KEYS[laneId] ?? []);

  for (const [key, value] of Object.entries(overrides ?? {})) {
    // The governed profile injects one runner-issued, per-job bearer for the
    // MUON MCP server. Ambient MUON_API_TOKEN remains denied above; only this
    // explicit profile override crosses into the vendor process.
    if (key === "MUON_API_TOKEN") {
      env[key] = value;
      continue;
    }
    if (RUNNER_CONTROL_ENV_KEYS.has(key)) continue;
    if (ALL_VENDOR_ENV_KEYS.has(key) && !allowedVendorKeys.has(key)) continue;
    if (ALL_LANE_GUARD_ENV_KEYS.has(key) && !allowedGuardKeys.has(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Add only credential keys proven necessary by the selected vendor's trusted
 * provider configuration. The shared static environment builder remains the
 * baseline and the resolver owns dynamic-key validation.
 */
export function buildProviderAwareLaneEnvironment(
  laneId: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
  overrides?: Record<string, string>
): NodeJS.ProcessEnv {
  const env = buildLaneEnvironment(laneId, parentEnv, overrides);
  // Provider selection (notably CODEX_HOME) may itself be task-scoped. Resolve
  // the trusted provider configuration against that effective configuration,
  // while retaining ambient credentials only as a fallback source.
  const credentialLookupEnv: NodeJS.ProcessEnv = {
    ...parentEnv,
    ...env,
  };
  const credentialEvidence = resolveVendorCredentialEvidence(laneId, {
    env: credentialLookupEnv,
  });
  for (const key of credentialEvidence.environmentKeys) {
    // An explicit governed profile value, including an explicit empty value,
    // always wins over ambient developer state. This keeps provider selection
    // deterministic and lets preflight fail closed instead of silently using a
    // different account when the task intentionally withheld a credential.
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      continue;
    }
    const value = credentialLookupEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function makeEvent(
  input: Pick<LaneCommandInput, "laneId" | "taskId">,
  kind: LaneEventKind,
  message: string,
  metadata: Record<string, unknown> = {}
): LaneEvent {
  return {
    id: randomUUID(),
    laneId: input.laneId,
    taskId: input.taskId,
    kind,
    message,
    timestamp: new Date().toISOString(),
    metadata,
  };
}

/**
 * The pty leg of `runLaneCommand`. Same contract, different transport: the
 * child owns a real terminal, `onBytes` carries its raw console verbatim
 * (stream is "stdout" — a pty has exactly one), and `output` is recovered
 * plain text. Timeout/abort semantics (`exitCode: 130`, SIGTERM → SIGKILL)
 * mirror the pipe leg so callers cannot tell the transports apart on failure.
 */
function runLanePtyCommand(
  input: LaneCommandInput,
  pty: LanePtyOptions,
  laneEnvironment: NodeJS.ProcessEnv,
  startedAt: number
): Promise<LaneCommandResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(laneEnvironment)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }

    let child: LanePtyProcess;
    try {
      child = pty.spawn({
        file: input.command,
        args: [...input.args],
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        env,
        cols: pty.cols ?? LANE_PTY_COLS,
        rows: pty.rows ?? LANE_PTY_ROWS,
      });
    } catch (error) {
      reject(error);
      return;
    }
    // Registered BEFORE any listener is wired: a teardown that arrives while
    // this function is still setting up must still find the child.
    liveLanePtyChildren.add(child);

    // INCREMENTAL, NOT CUMULATIVE. `pending` holds only the text after the
    // last line terminator; each chunk normalizes just the newly-completed
    // lines and appends them to `output`. Re-normalizing the whole accumulated
    // buffer per chunk (the obvious version) is O(total²): with node-pty's
    // ~66-byte chunks a 367 KB run performed 68.7 M characters of synchronous
    // normalization — measured — which starves the runner's own heartbeat,
    // watchdog and terminate timers, and the stall watchdog then blames the
    // vendor for a hang MUON caused.
    let pending = "";
    let output = "";
    let settled = false;
    let aborted = input.signal?.aborted ?? false;
    let hardKill: NodeJS.Timeout | undefined;

    /** Fold `text` to plain lines, append to the bounded output, and record it. */
    const admit = (text: string): void => {
      if (text.length === 0) return;
      const plain = normalizePtyOutput(text);
      if (plain.length === 0) return;
      output = `${output}${plain}`;
      if (output.length > PTY_OUTPUT_TAIL_CHARS) {
        output = output.slice(-PTY_OUTPUT_TAIL_CHARS);
      }
      // The recorded stream carries WHOLE, CORRECTED lines: cutting only at a
      // terminator is what makes an in-place `\r` correction ("STATUS: fail"
      // → "STATUS: pass") record the corrected text rather than the text it
      // replaced, and stops a line arriving in fragments from being recorded
      // as several torn ones.
      const message = plain.trimEnd();
      if (message.trim().length > 0) {
        input.onEvent(makeEvent(input, "task.progress", message));
      }
    };

    const terminate = () => {
      aborted = true;
      // The child's OWN group, not just the handle: the vendor's descendant
      // shells inherit that group, and killing only the pty leader would leave
      // them running against the worktree.
      signalLanePtyChild(child, "SIGTERM");
      hardKill ??= setTimeout(() => {
        signalLanePtyChild(child, "SIGKILL");
      }, 2000);
      hardKill.unref?.();
    };
    input.signal?.addEventListener("abort", terminate, { once: true });

    const timeout = input.timeoutMs
      ? setTimeout(() => {
          terminate();
        }, input.timeoutMs)
      : undefined;

    input.onEvent(
      makeEvent(input, "task.started", `Running ${input.command}`, {
        command: input.command,
        args: input.args,
        transport: "pty",
      })
    );

    child.onData((data) => {
      // Raw console bytes to the live sink FIRST, verbatim and unbuffered —
      // that is what makes the pane the vendor's REAL terminal. A throwing
      // viewer must never lose the vendor's output.
      try {
        input.onBytes?.({ stream: "stdout", data });
      } catch {
        // ignored on purpose
      }
      pending += data;
      // Cut at the LAST terminator: an ANSI escape can never contain `\n`, so
      // a sequence split across chunks stays whole in `pending`, and a `\r`
      // redraw run is folded as one piece rather than half-recorded.
      const boundary = pending.lastIndexOf("\n");
      if (boundary >= 0) {
        const complete = pending.slice(0, boundary + 1);
        pending = pending.slice(boundary + 1);
        admit(complete);
        return;
      }
      if (pending.length >= PTY_PENDING_CEILING_CHARS) {
        const flushed = pending;
        pending = "";
        admit(flushed);
      }
    });

    child.onExit(({ exitCode: rawExit }) => {
      // Deregistered even on a duplicate exit: a handle left in the registry
      // would be signalled again at teardown, and its pid may by then have
      // been recycled onto an unrelated process.
      liveLanePtyChildren.delete(child);
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (hardKill) {
        clearTimeout(hardKill);
      }
      input.signal?.removeEventListener("abort", terminate);

      // The vendor's last line often has no terminator (a prompt, a killed
      // run); recover it rather than silently dropping the final report.
      const trailing = pending;
      pending = "";
      admit(trailing);

      const exitCode = aborted ? 130 : rawExit;
      const durationMs = Date.now() - startedAt;

      if (exitCode === 0) {
        input.onEvent(
          makeEvent(input, "task.completed", "Command completed", {
            exitCode,
            durationMs,
          })
        );
      } else {
        input.onEvent(
          makeEvent(input, "task.blocked", `Command exited with code ${exitCode}`, {
            exitCode,
            durationMs,
            // A pty merges the two streams, so the honest tail is the console
            // itself; `errorOutput` stays empty rather than claiming a stderr
            // nobody separated.
            errorOutput: output.slice(-2000),
          })
        );
      }

      resolve({ exitCode, output, errorOutput: "", durationMs });
    });
  });
}

export function runLaneCommand(
  input: LaneCommandInput
): Promise<LaneCommandResult> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(input.signal.reason);
      return;
    }
    const laneEnvironment = buildProviderAwareLaneEnvironment(
      input.laneId,
      process.env,
      input.env
    );
    if (input.mcpServers) {
      try {
        assertMuonMcpEnvContract(input.mcpServers, laneEnvironment);
      } catch (error) {
        reject(error);
        return;
      }
    }
    if (input.pty) {
      runLanePtyCommand(input, input.pty, laneEnvironment, startedAt).then(
        resolve,
        reject
      );
      return;
    }
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: laneEnvironment,
      // THE BRIEF IS ARGV; STDIN MUST BE EOF, NOT AN OPEN PIPE.
      //
      // Node's default stdio is `["pipe","pipe","pipe"]`, and nothing on this
      // path ever writes to or ends `child.stdin` — so before this line every
      // one-shot vendor child was handed a pipe that would never carry a byte
      // and would never close. A CLI that reads stdin when it is not a TTY then
      // blocks forever on an EOF that cannot arrive.
      //
      // MEASURED against the installed codex 0.145.0. `codex exec [PROMPT]`
      // takes the brief as its positional argument but ALSO appends piped stdin
      // as a `<stdin>` block, so it reads stdin whenever stdin is not a tty.
      // Same argv, same cwd, same env, only this option differing:
      //   stdin = open pipe  → prints "Reading additional input from stdin...",
      //                        prints its banner, then hangs until killed
      //                        (SIGKILLed at 10s, never ran the turn)
      //   stdin = ignore     → same argv reaches the turn in 92ms
      // That hang is the founder's "one line and then nothing": both implementer
      // jobs burned their whole watchdog window without ever starting work.
      //
      // NOT caused by the ambient-config guard: the hang reproduces identically
      // with and without `CODEX_AMBIENT_SUPPRESSION_ARGS` on the argv, so the
      // isolation landed in 3574a20 is untouched here.
      //
      // `ignore` (a /dev/null fd) rather than closing a pipe after spawn: EOF is
      // then true from the child's first read, with no window in which a child
      // that reads immediately sees an open descriptor. It matches the stdio
      // every other spawn in this package already uses (vendor-readiness.ts,
      // command-check.ts). stdout/stderr stay separate pipes, so `errorOutput`,
      // `onDiagnostic`, and `onBytes` are unchanged.
      //
      // This grants nothing: /dev/null is strictly LESS input than an open pipe,
      // and the interactive lanes that genuinely speak over stdin
      // (`codex app-server`, the MUON MCP probe) spawn elsewhere and manage
      // their own stdin — they do not come through here.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let errorOutput = "";
    let settled = false;
    let aborted = input.signal?.aborted ?? false;
    let hardKill: NodeJS.Timeout | undefined;

    const terminate = () => {
      aborted = true;
      child.kill("SIGTERM");
      hardKill ??= setTimeout(() => {
        child.kill("SIGKILL");
      }, 2000);
      hardKill.unref?.();
    };
    input.signal?.addEventListener("abort", terminate, { once: true });

    const timeout = input.timeoutMs
      ? setTimeout(() => {
          terminate();
        }, input.timeoutMs)
      : undefined;

    input.onEvent(
      makeEvent(input, "task.started", `Running ${input.command}`, {
        command: input.command,
        args: input.args,
      })
    );

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      // The live sink sees the bytes BEFORE the trim, and is never allowed to
      // break the run: a throwing viewer must not lose the vendor's output.
      try {
        input.onBytes?.({ stream: "stdout", data: text });
      } catch {
        // ignored on purpose
      }
      input.onEvent(makeEvent(input, "task.progress", text.trimEnd()));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      errorOutput += text;
      try {
        input.onBytes?.({ stream: "stderr", data: text });
      } catch {
        // ignored on purpose
      }
      input.onDiagnostic?.(text);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (hardKill) {
        clearTimeout(hardKill);
      }
      input.signal?.removeEventListener("abort", terminate);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (hardKill) {
        clearTimeout(hardKill);
      }
      input.signal?.removeEventListener("abort", terminate);

      const exitCode = aborted ? 130 : (code ?? 1);
      const durationMs = Date.now() - startedAt;

      if (exitCode === 0) {
        input.onEvent(
          makeEvent(input, "task.completed", "Command completed", {
            exitCode,
            durationMs,
          })
        );
      } else {
        input.onEvent(
          makeEvent(input, "task.blocked", `Command exited with code ${exitCode}`, {
            exitCode,
            durationMs,
            errorOutput: errorOutput.slice(-2000),
          })
        );
      }

      resolve({ exitCode, output, errorOutput, durationMs });
    });
  });
}
