/**
 * Ask a running MUON MCP server what it serves.
 *
 * The I/O half of `@muon/client/mcp-probe` — deliberately thin, because
 * everything worth arguing about (what counts as stale, what an unreachable
 * server means) lives in the pure comparison next to it. This function's only
 * job is to get a `tools/list` answer out of a real process, or to return
 * `null` and let the comparison call that an unknown.
 *
 * It speaks the handshake by hand rather than pulling in an MCP client: the
 * dependency exists to CALL tools, and every extra layer between "what does the
 * process serve" and the answer is a place the answer could come from
 * somewhere other than the process.
 *
 * It lives in @muon/client rather than in the CLI because the desk probes too
 * (surface-parity item 5). Two spawns, two handshakes, two timeout policies
 * would mean the desk and `muon mcp probe` could disagree about what the same
 * server serves — and this measurement exists precisely to settle that kind of
 * disagreement. NODE-SIDE ONLY: the desktop calls it from main, never from the
 * renderer.
 */

import { spawn } from "node:child_process";
import {
  isIdentityGateState,
  type IdentityGateState,
} from "./github-identity-gate.js";

export type McpProbeOutcome = {
  /** Tool names the server listed, or null when it never answered. */
  readonly toolNames: readonly string[] | null;
  /**
   * ADR-0052 — whether the server that answered is IDENTITY-LOCKED.
   *
   * A gated `muon-mcp` answers `initialize` and `tools/list` in full, on
   * purpose, so a probe that stopped at the tool list reported "ok, 31 tools"
   * about a server that will refuse all 31. `null` means the question was not
   * answered (an old build with no `whoami`, or one that did not reply in
   * time) — an unknown, never a "no".
   *
   * RECOGNISED STATES ONLY. A server that reports a state this build does not
   * know lands in `unknownIdentityGate` below, not here, because a caller
   * switching on this field must never be handed a value it cannot reason about.
   */
  readonly identityGate: IdentityGateState | null;
  /**
   * THE SERVER ANSWERED, WITH A GATE STATE THIS BUILD DOES NOT UNDERSTAND.
   *
   * A THIRD outcome, and the one that used to be silently read as health: an
   * `identityGate` that was PRESENT but unrecognised (a newer server naming a
   * fifth state, or a typo) collapsed into `identityGate: null` — which every
   * caller correctly treats as "an old build with no `whoami` to ask", scores as
   * no lock, and reports `ok` with exit 0. The two facts are nothing alike. An
   * ABSENT field is genuinely an unknown; a present unreadable one is a server
   * telling us something about its own permission state that we cannot read, and
   * the honest answer to that is to say so and not claim ok.
   *
   * Carries the raw value (bounded, so a hostile or verbose server cannot make a
   * refusal unreadable) because the operator's next move is to compare versions,
   * and the value is the thing worth naming.
   */
  readonly unknownIdentityGate?: string;
  /** Present only on failure — why there is no answer. */
  readonly failure?: string;
  /** Anything the server said on stderr, kept for the operator. */
  readonly stderr: string;
};

const PROTOCOL_VERSION = "2024-11-05";

/**
 * How long the gate question may add to a probe.
 *
 * `whoami` is one of the two tools a LOCKED server still answers and it does
 * no I/O — every coordinate it reports is already in the process. So this is
 * short by design: the tool list is the measurement this command exists for,
 * and it must never be withheld because a second question went unanswered.
 */
const GATE_QUESTION_BUDGET_MS = 3_000;

/**
 * The tool the gate question is asked THROUGH.
 *
 * `whoami` and not a deliberate refusal from some ordinary tool: it is in the
 * positive exempt set (`MCP_IDENTITY_GATE_EXEMPT_TOOLS`), so it answers in
 * every state, and it is read-only and does no I/O — a probe must not perform
 * governed work to find out whether it may.
 */
const GATE_QUESTION_TOOL = "whoami";

/**
 * Spawn, handshake, list, kill.
 *
 * The server is started with the SAME command the vendor config points at, so
 * this measures the binary an agent would actually get rather than the one this
 * CLI was built beside — the entire point of probing.
 */
export async function probeMcpToolNames(options: {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): Promise<McpProbeOutcome> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  return await new Promise<McpProbeOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, [...(options.args ?? [])], {
        stdio: ["pipe", "pipe", "pipe"],
        env: options.env ?? process.env,
      });
    } catch (error) {
      resolve({
        toolNames: null,
        identityGate: null,
        failure: `could not start ${options.command}: ${String(error)}`,
        stderr: "",
      });
      return;
    }

    let settled = false;
    let stdout = "";
    let stderr = "";
    /** Held between `tools/list` and the gate answer, so a gate question that
     *  goes unanswered still reports the tool list it already has. */
    let listed: string[] | null = null;
    let gateTimer: ReturnType<typeof setTimeout> | undefined;

    // One exit path, so a late timer cannot resolve after a real answer and a
    // failure cannot leave the child running.
    const finish = (
      outcome: Omit<McpProbeOutcome, "stderr" | "identityGate"> &
        Partial<Pick<McpProbeOutcome, "identityGate">>
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (gateTimer) clearTimeout(gateTimer);
      child.kill("SIGKILL");
      resolve({
        ...outcome,
        // `?? null`, not a default the spread sits on top of: an explicit
        // `identityGate: undefined` would ride straight through a spread and
        // violate the declared type, and `printJson` would then drop the key.
        identityGate: outcome.identityGate ?? null,
        stderr: stderr.trim(),
      });
    };

    const timer = setTimeout(() => {
      // The overall budget can expire while the GATE question is outstanding,
      // and the tool list is the measurement this command exists for: once it
      // is in hand, running out of time reports it. Reporting
      // "did not answer tools/list" about a server that did would be a
      // confidently wrong sentence, and one that scores as a stale build.
      finish(
        listed
          ? { toolNames: listed }
          : {
              toolNames: null,
              failure: `the server did not answer tools/list within ${timeoutMs}ms`,
            }
      );
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      finish({ toolNames: null, failure: `spawn failed: ${String(error)}` });
    });
    child.on("exit", (code, signal) => {
      // Same rule as the timeout: dying DURING the gate question does not
      // unmake the tool list it already served. The gate stays `null` — an
      // unknown, which is what it is.
      finish(
        listed
          ? {
              toolNames: listed,
              failure: `the server exited (code ${code}, signal ${signal}) before answering whether it is identity-locked`,
            }
          : {
              toolNames: null,
              failure: `the server exited (code ${code}, signal ${signal}) before listing its tools`,
            }
      );
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Line-delimited JSON-RPC. A frame can arrive split across reads or two
      // to a read, so drain whole lines and keep the remainder.
      for (;;) {
        const cut = stdout.indexOf("\n");
        if (cut === -1) break;
        const line = stdout.slice(0, cut);
        stdout = stdout.slice(cut + 1);
        if (line.trim() === "") continue;
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue; // not our frame — a stray log line on stdout
        }
        // A JSON-RPC RESPONSE carries `result` or `error`. A structured log
        // line (pino and friends write `{"level":30,"msg":…}` on stdout, and
        // nothing stops one carrying an `id`) carries neither, and treating it
        // as an answer to a request we made is how a probe reports something
        // it was never told.
        const isResponse =
          message.result !== undefined || message.error !== undefined;
        if (message.id === 1 && isResponse) {
          write(child, {
            jsonrpc: "2.0",
            method: "notifications/initialized",
          });
          write(child, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          });
          continue;
        }
        if (message.id === 2 && isResponse) {
          const tools = (message.result as { tools?: { name?: unknown }[] })
            ?.tools;
          if (!Array.isArray(tools)) {
            finish({
              toolNames: null,
              failure: "the server answered tools/list without a tool array",
            });
            return;
          }
          listed = tools
            .map((tool) => tool?.name)
            .filter((name): name is string => typeof name === "string");
          // ADR-0052: ask the ONE tool a locked server still answers. Skipped
          // when it is not on offer — an older build, or a lapsed
          // attached-coordinator seat holding nothing — because calling a tool
          // that was not listed would answer "unknown tool", which says
          // nothing about the gate.
          if (!listed.includes(GATE_QUESTION_TOOL)) {
            finish({ toolNames: listed });
            return;
          }
          // The tool list is already in hand: from here every exit reports it,
          // including the one where the gate question is never answered.
          gateTimer = setTimeout(() => {
            finish({ toolNames: listed });
          }, Math.min(GATE_QUESTION_BUDGET_MS, timeoutMs));
          gateTimer.unref?.();
          write(child, {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: GATE_QUESTION_TOOL, arguments: {} },
          });
          continue;
        }
        // GUARDED ON `listed`, and that guard is load-bearing. A server is
        // free to log unstructured JSON on stdout (this suite already pins
        // that it does), and one stray line carrying `"id": 3` would
        // otherwise finish the probe before `tools/list` — reporting
        // `toolNames: null` with no `failure` at all — or land after the list
        // and DISCARD a real `locked` answer, silently restoring the bug this
        // question was added to close.
        if (message.id === 3 && isResponse && listed) {
          finish({ toolNames: listed, ...readIdentityGate(message.result) });
          return;
        }
      }
    });

    write(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "muon-mcp-probe", version: "1" },
      },
    });
  });
}

function write(
  child: ReturnType<typeof spawn>,
  message: Record<string, unknown>
): void {
  child.stdin?.write(`${JSON.stringify(message)}\n`);
}

/** How much of an unrecognised gate value is worth repeating to an operator.
 *  Bounded so a verbose (or hostile) server cannot bury the refusal it belongs
 *  to under its own payload. */
const UNKNOWN_GATE_MAX_CHARS = 64;

/** THREE outcomes, so no caller has to infer the third from the absence of the
 *  other two. */
type GateReading =
  /** A state this build knows. */
  | { readonly identityGate: IdentityGateState }
  /** Nothing was in there — an older server, or one that never answered. */
  | { readonly identityGate: null }
  /** Something WAS in there and this build cannot read it. */
  | { readonly identityGate: null; readonly unknownIdentityGate: string };

/**
 * The gate state out of a `whoami` result.
 *
 * TYPED FIELD ONLY, never the prose. `whoami` also carries a sentence naming
 * the lock, and matching on it would make an editorial pass to the copy
 * silently turn this check off — the exact failure mode the field was added to
 * replace.
 *
 * AN UNRECOGNISED VALUE IS NOT AN ABSENT ONE. It used to be: both returned
 * `null`, so a future or misspelled gate state read as "this server never
 * reported one", which every reader scores as no lock. `null` is now reserved
 * for the genuine unknown (no field, or `null` — JSON's own way of saying "no
 * value"), and anything else unrecognised comes back named.
 */
function readIdentityGate(result: unknown): GateReading {
  const structured = (result as { structuredContent?: unknown })
    ?.structuredContent;
  const value = (structured as { identityGate?: unknown })?.identityGate;
  if (isIdentityGateState(value)) return { identityGate: value };
  if (value === undefined || value === null) return { identityGate: null };
  const raw = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return {
    identityGate: null,
    // Never the empty string: the field's presence is the fact, and a caller
    // testing it for truthiness must not be told "absent" by an empty value.
    unknownIdentityGate: raw.slice(0, UNKNOWN_GATE_MAX_CHARS) || "(empty)",
  };
}
