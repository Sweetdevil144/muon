import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { VENDOR_REGISTRY } from "@muon/protocol";
import { commandExists } from "./command-check.js";
import { buildProviderAwareLaneEnvironment } from "./lane-runner.js";
import {
  makeSessionEvent,
  type LaneSessionDriver,
  type SessionCapabilities,
  type SessionHandle,
  type SessionHandlers,
  type SessionStartInput,
} from "./session-driver.js";
import type { RpcTransport } from "./codex-session-driver.js";

/**
 * ACP (Agent Client Protocol) session driver — ADR-0007's accepted client
 * path, MUON-spawned (TODO 1.0/1.1). One driver serves every vendor that
 * speaks ACP over stdio; a vendor declares it as DATA (`session.driver:
 * "acp"` + `session.acp.{command,args}` in the registry), never as a bespoke
 * driver name (TODO 1.2).
 *
 * The ADR's guardrails are ENCODED here, not documented beside it:
 *
 *  - NEVER a tier-1 vendor. Claude Code, Codex and Cursor keep their bespoke
 *    drivers until ACP adapters reach profile fidelity; the constructor
 *    refuses those lane keys outright (ADR-0007 Decision 2).
 *  - NEVER implement `authenticate`. The user pre-authenticates the vendor
 *    CLI (BYO-auth); when an agent demands auth, this driver fails the
 *    session with an honest message and does not pass a token — there is no
 *    code path that could (ADR-0007 guardrails).
 *  - DOWNGRADE "allow always" to a single allow. MUON's approval bridge
 *    decides per action; a standing vendor-side grant would let a hot-symbol
 *    edit skip re-gating. The permission mapping below can never select an
 *    `allow_always` option — when an agent offers ONLY standing approval, the
 *    driver rejects and says why (fail closed, ADR-0007 guardrails).
 *  - Default DENY. A bridge error, an unrecognized option vocabulary, or a
 *    request while cancelled all land on the reject side.
 *  - Client capabilities are NOT advertised (no fs, no terminal). An agent
 *    that asks anyway gets a JSON-RPC error, not silence and not service —
 *    MUON's file/terminal authority flows through its own governed tools.
 *
 * `session/cancel` → `interrupt()` is TODO 1.3: the mechanical earner of
 * `canInterrupt`, the capability `ROLE_SPECS.orchestrator` requires.
 */

/** ACP method names (protocol v1), centralized like `CODEX_RPC`. */
export const ACP_RPC = {
  initialize: "initialize",
  /** Named ONLY so the refusal below can state what it refuses. */
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionPrompt: "session/prompt",
  /** Client → agent NOTIFICATION (no response). */
  sessionCancel: "session/cancel",
  /** Agent → client notification stream. */
  sessionUpdate: "session/update",
  /** Agent → client REQUEST — the approval bridge's wire shape. */
  requestPermission: "session/request_permission",
} as const;

export const ACP_PROTOCOL_VERSION = 1;

/**
 * ADR-0007 Decision 2: the moat lanes ACP may never carry. DERIVED from the
 * registry's `authority.tier1` flag, not a hand-maintained literal — a new
 * moat vendor is refused because IT declared itself tier-1, not because
 * someone remembered to edit this file. (The prior literal `["claude-code",
 * "codex", "cursor"]` could silently miss a fourth moat vendor; the registry
 * field cannot.)
 */
export const ACP_TIER1_REFUSED: readonly string[] = Object.values(
  VENDOR_REGISTRY
)
  .filter((entry) => entry.authority.tier1)
  .map((entry) => entry.id);

/** Bound any vendor-authored text before it rides an event/failure message. */
const ACP_TEXT_BOUND = 2_000;
/** How long an RPC waits before the driver calls the agent unresponsive. */
const ACP_RPC_TIMEOUT_MS = 60_000;
/** Bounded transport shutdown, mirroring the codex driver's discipline. */
const ACP_TRANSPORT_CLOSE_MS = 3_000;
/** Cap on accumulated assistant output (the tail carries the verdict). Matches
 *  the class the codex driver keeps for `SessionResult.output`. */
const ACP_OUTPUT_MAX = 64_000;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

export type AcpSessionDriverOptions = {
  /** The vendor lane this driver instance serves (registry id). */
  laneKey: string;
  /** The vendor's ACP entrypoint, e.g. `gemini` / `openhands`. */
  command: string;
  /** Args that put the binary into ACP mode, e.g. `["--experimental-acp"]`. */
  args?: readonly string[];
  /** Test seam: an in-process transport instead of a spawned child. */
  createTransport?: (
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    onDiagnostic?: (chunk: string) => void
  ) => RpcTransport;
  rpcTimeoutMs?: number;
  transportCloseMs?: number;
};

function bounded(text: unknown, max = ACP_TEXT_BOUND): string {
  const value = typeof text === "string" ? text : JSON.stringify(text) ?? "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** True when an agent's error says "authenticate first" — the one failure the
 *  driver must translate into the BYO-auth message instead of retrying or,
 *  worse, "helping". ACP's spec reserves `auth_required`; adapters also say it
 *  in prose. Substring match on both, fail toward the generic error. */
function isAuthRequired(error: { code?: number; message?: string }): boolean {
  // Keyed on the MESSAGE, not on code -32000: that is the GENERIC server-error
  // code in most JSON-RPC implementations, so an ordinary `session/new`
  // failure carries it too. Reporting every server error as "log in first"
  // would send the operator chasing a BYO-auth problem that isn't there. ACP's
  // reserved auth code is -32000 ONLY in combination with an auth-shaped
  // message, so require the message signal.
  return /auth[ _-]?required|not authenticated|please.*(log ?in|sign ?in)/i.test(
    error.message ?? ""
  );
}

function spawnAcpTransport(
  command: string,
  args: readonly string[],
  cwd?: string,
  env?: Record<string, string>,
  onDiagnostic?: (chunk: string) => void
): RpcTransport {
  if (!commandExists(command)) {
    throw new Error(
      `ACP sessions for this lane need the '${command}' CLI on PATH. Install it, or use \`muon run\` for one-shot execution.`
    );
  }
  // NEVER `?? process.env`. Every other driver composes a positive-allowlist
  // lane env (`buildProviderAwareLaneEnvironment`) precisely so the vendor
  // child does NOT inherit the runner's `MUON_AGENT_TOKEN`,
  // `MUON_RUNNER_LEASE_TOKEN`, or another vendor's API keys (ADR-0022 G5). A
  // silent inheritance here would be the worst outcome that ADR names, so an
  // unset env is a spawn ERROR, not a fallback to the ambient environment.
  if (!env) {
    throw new Error(
      "AcpSessionDriver requires a composed lane environment; refusing to " +
        "spawn a vendor child with the runner's ambient process.env (ADR-0022)."
    );
  }
  const child: ChildProcess = spawn(command, [...args], {
    cwd,
    // Env rides the child process only — never argv (S2), and never a token
    // MUON minted: the vendor CLI authenticates itself (BYO). The env is the
    // allowlisted lane env the caller composed, never `process.env`.
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const handlers: ((message: JsonRpcMessage) => void)[] = [];
  const exitWaiters: ((code: number) => void)[] = [];
  let exitCode: number | undefined;
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-ACP_TEXT_BOUND);
    onDiagnostic?.(text);
  });
  const settleExit = (code: number) => {
    if (exitCode !== undefined) return;
    exitCode = code;
    for (const waiter of exitWaiters) waiter(code);
    exitWaiters.length = 0;
  };
  child.on("error", () => settleExit(1));
  child.on("close", (code) => settleExit(code ?? 1));
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // Non-JSON stdout is ignored; ACP is line-delimited JSON-RPC. Kept
      // NARROW to the parse only — a handler throwing must not be swallowed
      // under this "non-JSON" comment (it would hide a real dispatch bug).
      return;
    }
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (error) {
        onDiagnostic?.(
          `[acp] message handler threw: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  });
  let closePromise: Promise<void> | undefined;
  return {
    send: (message) => {
      if (exitCode !== undefined) {
        throw new Error(
          stderrTail
            ? `ACP agent exited before RPC (${exitCode}): ${bounded(stderrTail, 800)}`
            : `ACP agent exited before RPC (${exitCode}).`
        );
      }
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    },
    onMessage: (handler) => {
      handlers.push(handler);
    },
    close: () => {
      closePromise ??= new Promise<void>((resolve) => {
        if (exitCode !== undefined) {
          resolve();
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(hardKill);
          clearTimeout(finalBound);
          child.removeListener("close", finish);
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          resolve();
        };
        const hardKill = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // the bounded waiter below still settles
          }
        }, Math.max(1, ACP_TRANSPORT_CLOSE_MS - 500));
        const finalBound = setTimeout(finish, ACP_TRANSPORT_CLOSE_MS);
        child.once("close", finish);
        try {
          child.kill("SIGTERM");
        } catch {
          finish();
        }
      });
      return closePromise;
    },
    waitForExit: () =>
      exitCode !== undefined
        ? Promise.resolve(exitCode)
        : new Promise<number>((resolve) => exitWaiters.push(resolve)),
  };
}

/** One permission option as ACP's `session/request_permission` carries it. */
type AcpPermissionOption = {
  optionId?: string;
  name?: string;
  kind?: string;
};

/**
 * The guardrail mapping, extracted pure so the adversarial tests hit exactly
 * the shipped rule (never a restatement):
 *
 *  - allow → the FIRST `allow_once` option, and only that kind. `allow_always`
 *    is structurally unreachable from an allow.
 *  - allow with no `allow_once` on offer → REJECT (prefer `reject_once`, then
 *    `reject_always`) — a standing grant is not MUON's to mint, so the action
 *    fails closed and the reason says so.
 *  - deny → `reject_once`, then `reject_always`.
 *  - nothing selectable → null; the caller answers with the `cancelled`
 *    outcome, which no agent may read as an allow.
 */
export function selectAcpPermissionOption(
  behavior: "allow" | "deny",
  options: readonly AcpPermissionOption[]
): { optionId: string; downgraded: boolean } | null {
  const byKind = (kind: string) =>
    options.find(
      (option) => option.kind === kind && typeof option.optionId === "string"
    );
  if (behavior === "allow") {
    const once = byKind("allow_once");
    if (once) return { optionId: once.optionId as string, downgraded: false };
    const rejectOnce = byKind("reject_once") ?? byKind("reject_always");
    return rejectOnce
      ? { optionId: rejectOnce.optionId as string, downgraded: true }
      : null;
  }
  const reject = byKind("reject_once") ?? byKind("reject_always");
  return reject ? { optionId: reject.optionId as string, downgraded: false } : null;
}

export class AcpSessionDriver implements LaneSessionDriver {
  readonly laneKey: string;
  readonly capabilities: SessionCapabilities = {
    canSend: true,
    // TODO 1.3: `session/cancel` is the wire form of `interrupt()` — this is
    // the mechanical earner of the coordinator seat's required capability.
    canInterrupt: true,
    // v1 posture: `session/load` support varies per agent and is unproven
    // here; resume stays false until a live agent demonstrates it.
    canResume: false,
  };
  /** The spawn transport tails the child's stderr into `onDiagnostic`. */
  readonly forwardsVendorStderr = true;

  private readonly options: AcpSessionDriverOptions;

  constructor(options: AcpSessionDriverOptions) {
    if (ACP_TIER1_REFUSED.includes(options.laneKey)) {
      throw new Error(
        `ADR-0007: '${options.laneKey}' is a tier-1 lane and may not be driven over ACP — its bespoke driver carries the profile fidelity ACP lacks.`
      );
    }
    this.laneKey = options.laneKey;
    this.options = options;
  }

  async start(
    input: SessionStartInput,
    handlers: SessionHandlers
  ): Promise<SessionHandle> {
    input.signal?.throwIfAborted();
    // ADR-0022 G5: compose the positive-allowlist lane env so the vendor child
    // inherits ONLY this lane's own credential keys plus the profile's explicit
    // overrides — never the runner's shared agent/lease bearers, never another
    // vendor's key. Identical discipline to `CodexSessionDriver`. A test seam
    // may inject its own transport and skip this, but production always spawns
    // with a composed env (the `?? process.env` fallback is gone).
    const laneEnv = buildProviderAwareLaneEnvironment(this.laneKey, process.env, {
      ...input.profile?.env,
    });
    const childEnv = Object.fromEntries(
      Object.entries(laneEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
    const transport = (this.options.createTransport ?? ((cwd, env, onDiag) =>
      spawnAcpTransport(
        this.options.command,
        this.options.args ?? [],
        cwd,
        env,
        onDiag
      )))(input.cwd, childEnv, handlers.onDiagnostic);

    const rpcTimeoutMs = this.options.rpcTimeoutMs ?? ACP_RPC_TIMEOUT_MS;
    let requestId = 0;
    const pending = new Map<
      number,
      {
        method: string;
        resolve: (message: JsonRpcMessage) => void;
        reject: (error: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let output = "";
    let exitFailure: string | undefined;
    let aborted = false;
    let sessionId = "";
    /** Prompt turns in flight or queued; wait() settles when this drains. */
    let activeTurns = 0;
    let turnsEverStarted = false;
    let settled = false;
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveDone();
    };
    const rejectPending = (reason: unknown) => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(reason);
      }
      pending.clear();
    };
    let closePromise: Promise<void> | undefined;
    const closeTransport = () => {
      closePromise ??= Promise.resolve()
        .then(() => transport.close())
        .catch(() => undefined) as Promise<void>;
      return closePromise;
    };

    const call = (
      method: string,
      params: Record<string, unknown>
    ): Promise<JsonRpcMessage> => {
      requestId += 1;
      const id = requestId;
      return new Promise<JsonRpcMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `ACP agent did not answer '${method}' within ${Math.round(rpcTimeoutMs / 1000)}s.`
            )
          );
        }, rpcTimeoutMs);
        timer.unref?.();
        pending.set(id, { method, resolve, reject, timer });
        try {
          transport.send({ id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    };
    const notify = (method: string, params: Record<string, unknown>) => {
      transport.send({ method, params });
    };
    const respond = (id: number | string, result: Record<string, unknown>) => {
      transport.send({ id, result });
    };
    const respondError = (
      id: number | string,
      code: number,
      message: string
    ) => {
      transport.send({ id, error: { code, message } } as JsonRpcMessage);
    };

    const emit = (
      kind: "task.progress" | "task.blocked",
      message: string,
      metadata: Record<string, unknown> = {}
    ) => {
      handlers.onEvent(
        makeSessionEvent(this.laneKey, input.taskId, kind, message, {
          controlPlane: true,
          acp: true,
          ...metadata,
        })
      );
    };

    // ── agent → client traffic ───────────────────────────────────────────────
    transport.onMessage((message) => {
      // Responses to our calls.
      if (message.id !== undefined && message.method === undefined) {
        const waiter = pending.get(message.id as number);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        pending.delete(message.id as number);
        if (message.error) {
          waiter.reject(
            Object.assign(
              new Error(bounded(message.error.message, 800)),
              { code: message.error.code }
            )
          );
        } else {
          waiter.resolve(message);
        }
        return;
      }
      const params = message.params ?? {};
      // Streamed session updates → LaneEvents. Coordinates and bounded text.
      if (message.method === ACP_RPC.sessionUpdate && message.id === undefined) {
        const update = (params.update ?? {}) as Record<string, unknown>;
        const updateKind = String(update.sessionUpdate ?? "");
        if (updateKind === "agent_message_chunk") {
          const content = (update.content ?? {}) as Record<string, unknown>;
          if (content.type === "text" && typeof content.text === "string") {
            // BOUNDED like every other text path (a looping/hostile agent must
            // not grow the runner heap or the job row without limit). The tail
            // is what a verdict lives in, so keep the last window.
            output = (output + content.text).slice(-ACP_OUTPUT_MAX);
          }
          return;
        }
        if (updateKind === "tool_call" || updateKind === "tool_call_update") {
          emit(
            "task.progress",
            `ACP tool ${bounded(update.title ?? update.toolCallId ?? "call", 200)}: ${bounded(
              update.status ?? "pending",
              40
            )}`,
            { acpUpdate: updateKind }
          );
          return;
        }
        // Thoughts, plans, and future update kinds: bounded progress marks,
        // never verbatim prose into the control-plane stream.
        if (updateKind && updateKind !== "agent_thought_chunk") {
          emit("task.progress", `ACP session update: ${bounded(updateKind, 80)}`);
        }
        return;
      }
      // The approval bridge — agent asks, MUON's inbox decides, default deny.
      if (
        message.method === ACP_RPC.requestPermission &&
        message.id !== undefined
      ) {
        const id = message.id;
        const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
        const options = Array.isArray(params.options)
          ? (params.options as AcpPermissionOption[])
          : [];
        if (aborted) {
          // The spec's answer for a cancelled turn; never readable as allow.
          respond(id, { outcome: { outcome: "cancelled" } });
          return;
        }
        void (async () => {
          // THE WHOLE BODY is wrapped: `respond`/`emit` call `transport.send`,
          // which THROWS BY DESIGN once the child has exited or been closed
          // (an interrupt or a mid-decision timeout races exactly here). This
          // is an unawaited promise, and the runner installs no
          // `unhandledRejection` handler (ADR-0025), so an uncaught throw here
          // would take the whole runner process down and kill every concurrent
          // job. A transport that is gone means the turn is already settling
          // via the exit waiter; swallowing is correct.
          try {
            let behavior: "allow" | "deny" = "deny";
            let denyMessage = "MUON denied this action.";
            try {
              const decision = await handlers.onApprovalRequest({
                toolName: bounded(
                  toolCall.title ?? toolCall.kind ?? "acp_tool",
                  200
                ),
                input: toolCall,
                taskId: input.taskId,
                laneKey: this.laneKey,
              });
              behavior = decision.behavior;
              if (decision.behavior === "deny") denyMessage = decision.message;
            } catch (error) {
              behavior = "deny";
              denyMessage = `MUON denied: ${
                error instanceof Error ? error.message : "approval bridge failed"
              }`;
            }
            // RE-CHECK abort AFTER the await: the human may have taken seconds
            // in the inbox while an interrupt fired. A decision that lands
            // post-abort must answer `cancelled`, never a stale `selected`
            // allow against a turn MUON already tore down.
            if (aborted) {
              respond(id, { outcome: { outcome: "cancelled" } });
              return;
            }
            const selected = selectAcpPermissionOption(behavior, options);
            if (!selected) {
              emit(
                "task.blocked",
                "ACP agent offered no selectable permission option; MUON answered 'cancelled' (fail closed)."
              );
              respond(id, { outcome: { outcome: "cancelled" } });
              return;
            }
            if (selected.downgraded) {
              // The allow-always downgrade guardrail, visible when it bites.
              emit(
                "task.blocked",
                "MUON approved this action once, but the ACP agent offered only a STANDING grant (allow_always). MUON never mints standing vendor-side authority (ADR-0007), so the action was rejected; the agent may re-ask per action."
              );
            } else if (behavior === "deny") {
              emit("task.blocked", bounded(denyMessage, 400));
            }
            respond(id, {
              outcome: { outcome: "selected", optionId: selected.optionId },
            });
          } catch {
            // transport gone mid-response; the exit waiter settles the turn.
          }
        })();
        return;
      }
      // Any other agent-initiated REQUEST (fs/*, terminal/*, future methods):
      // MUON advertised no such client capability; answer with an error, never
      // with service and never with silence (a hung request wedges the turn).
      if (message.method !== undefined && message.id !== undefined) {
        respondError(
          message.id,
          -32601,
          `MUON does not provide '${message.method}' to ACP agents; file and terminal authority flow through MUON's governed tools only.`
        );
        emit(
          "task.progress",
          `refused ACP client request '${bounded(message.method, 80)}' (capability never advertised)`
        );
      }
    });

    const transportExitPromise = Promise.resolve().then(() =>
      transport.waitForExit()
    );
    void transportExitPromise.then((code) => {
      const reason = new Error(`ACP agent exited (${code}).`);
      rejectPending(reason);
      if (!settled && turnsEverStarted && !aborted) {
        exitFailure = `ACP agent exited (${code}) before completing its turn.`;
      }
      settle();
    });

    const onAbort = () => {
      aborted = true;
      rejectPending(new Error("ACP session interrupted."));
      settle();
      void closeTransport();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    // ── handshake: initialize → session/new → first prompt ──────────────────
    try {
      const initialized = await call(ACP_RPC.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          // Deliberately empty: no fs, no terminal. MUON is the authority
          // surface; the agent gets tools through MUON's governed MCP server.
          fs: { readTextFile: false, writeTextFile: false },
        },
      });
      const agentVersion = initialized.result?.protocolVersion;
      if (
        typeof agentVersion === "number" &&
        agentVersion !== ACP_PROTOCOL_VERSION
      ) {
        emit(
          "task.progress",
          `ACP protocol version ${agentVersion} (client speaks ${ACP_PROTOCOL_VERSION}); continuing on the agent's declared version`
        );
      }
      let created: JsonRpcMessage;
      try {
        created = await call(ACP_RPC.sessionNew, {
          cwd: input.cwd ?? process.cwd(),
          mcpServers: [],
        });
      } catch (error) {
        const rpcError = error as { code?: number; message?: string };
        if (isAuthRequired(rpcError)) {
          // ADR-0007: BYO-auth, and no `authenticate` implementation exists to
          // be tempted with. The human logs the CLI in; MUON never carries it.
          throw new Error(
            `The '${this.laneKey}' ACP agent requires authentication. Log in with the vendor's own CLI first — MUON never passes or stores vendor tokens (ADR-0007).`
          );
        }
        throw error;
      }
      sessionId = String(created.result?.sessionId ?? "");
      if (!sessionId) {
        throw new Error("ACP agent returned no sessionId from session/new.");
      }
      handlers.onVendorSessionId?.(sessionId);
      input.signal?.throwIfAborted();
    } catch (error) {
      input.signal?.removeEventListener("abort", onAbort);
      await closeTransport();
      throw error;
    }

    const promptTurn = async (text: string) => {
      activeTurns += 1;
      turnsEverStarted = true;
      try {
        const response = await call(ACP_RPC.sessionPrompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        const stopReason = String(response.result?.stopReason ?? "end_turn");
        if (stopReason === "refusal") {
          exitFailure = "ACP agent refused the prompt (stopReason: refusal).";
        }
      } catch (error) {
        if (!aborted) {
          exitFailure = bounded(
            error instanceof Error ? error.message : String(error),
            800
          );
        }
      } finally {
        activeTurns -= 1;
        if (activeTurns === 0) settle();
      }
    };

    // First turn: the brief.
    void promptTurn(input.brief);

    return {
      vendorSessionId: sessionId,
      send: async (message: string) => {
        if (settled || aborted) {
          throw new Error("ACP session already ended.");
        }
        void promptTurn(message);
      },
      interrupt: async () => {
        // TODO 1.3: `session/cancel` IS `interrupt()`. A notification by spec,
        // so there is no response to await; the in-flight prompt returns with
        // stopReason `cancelled` or the transport goes down — either way the
        // turn settles and wait() reports the interrupt honestly.
        const alreadyAborted = aborted;
        aborted = true;
        if (!alreadyAborted && sessionId) {
          try {
            notify(ACP_RPC.sessionCancel, { sessionId });
          } catch {
            // transport already gone — the exit waiter settles the turn
          }
        }
        rejectPending(new Error("ACP session interrupted."));
        settle();
        await closeTransport();
      },
      wait: async () => {
        try {
          await done;
          await closeTransport();
          if (aborted) {
            return { exitCode: 130, output };
          }
          if (exitFailure) {
            return {
              exitCode: 1,
              output: output.trim()
                ? `${output}\n\n${exitFailure}`
                : exitFailure,
            };
          }
          return { exitCode: 0, output };
        } finally {
          input.signal?.removeEventListener("abort", onAbort);
        }
      },
    };
  }
}
