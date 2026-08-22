import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { IdentityGateState } from "@muon/client/github-identity-gate";
import { dataOnlyMcpError, toMcpToolDefinition } from "./agent-ui.js";
import { gitNexusCliReachable } from "./gitnexus-tools.js";
import type { SessionSurface, ToolDefinition } from "./handlers.js";
import { muonServerInstructions } from "./instructions.js";

/** Every mode this factory can be built as. Positive, ADR-0022 rule 2. */
const KNOWN_SERVER_MODES = [
  "worker",
  "observer",
  "delegate",
  "orchestrator",
  "attached-coordinator",
] as const;
type ServerMode = (typeof KNOWN_SERVER_MODES)[number];

/**
 * MCP-server telemetry: REMOVED.
 *
 * This used to hand the whole MCP server to `@posthog/mcp`'s `instrument()`.
 * A first pass gated that on an explicit `MUON_MCP_TELEMETRY=1` rather than
 * the mere presence of a token, which fixed *who could turn it on* and left
 * the actual problem untouched: **when it was on, the payload was unbounded.**
 *
 * `instrument()` wraps request and response handling for a server whose
 * traffic is governed memory text, task context, peer-message bodies and tool
 * arguments. There is no allowlist, no redaction, and no vocabulary anyone at
 * MUON has reviewed. ADR-0031 set the standard for MUON telemetry and it is
 * privacy-by-SHAPE — every field an enum, a number or a boolean, with nowhere
 * to put a prompt — and a third-party wrapper over arbitrary tool payloads
 * cannot meet that standard by being switched on more carefully.
 *
 * MUON captured no custom events through this client, so removing it loses
 * nothing that was being measured. If MCP analytics are wanted later they get
 * what the observatory got: a positive event vocabulary, a consent gate the
 * user can see, and an ADR — not a wrapper over everything.
 *
 * Nothing is exported in its place. The four `posthog.shutdown()` call sites
 * went with it — a shutdown for a client that never existed is the kind of
 * residue that makes the next reader think telemetry is still wired.
 */

/**
 * ADR-0052 — the tools a GATED `muon-mcp` still answers. POSITIVE list
 * (ADR-0022); every other tool refuses while the gate is closed.
 *
 * ONE TOOL. `whoami` answers "what am I and what may I do here" — it is how an
 * agent, and the human reading over its shoulder, discovers that MUON is locked
 * at all, and it is where `muon mcp probe` reads the typed `identityGate`
 * discriminator from. It computes from the session surface this factory already
 * bound: no brain call, no memory, no filesystem.
 *
 * `capability_preflight` WAS HERE AND IS GONE (2026-08-17 review), and the
 * justification comment beside it — "neither touches memory, the crew, or the
 * filesystem" — was simply false. `collectCapabilityPreflight` fans out to four
 * governed brain reads in a `Promise.all`: brain health, vendor/fleet readiness,
 * the runner, and `getFleet` — which IS the crew. So a locked install served
 * crew composition, per-vendor readiness and runner state to any agent that
 * asked, through the one exemption whose stated reason was that it did not.
 *
 * Losing it costs an agent the "would this be allowed" answer while locked, and
 * that answer is already known: nothing is allowed, and the refusal says so in
 * three sentences. Everything that reads governed state, writes memory,
 * coordinates, or dispatches is ABSENT — and now that is true of this set rather
 * than merely claimed by it.
 */
export const MCP_IDENTITY_GATE_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  "whoami",
]);

/**
 * ADR-0052 — the gate as this server sees it.
 *
 * BOTH members are read PER CALL, not captured: a `muon login` in another
 * terminal opens every live MCP session immediately, with no restart and no
 * re-registration — the same live-read the desktop's IPC gate uses.
 *
 * `refusal` became a function for the same reason `state` is one. It used to be
 * a string fixed at construction, which meant a session that started while the
 * install registration was still deferred kept telling every agent to "Run
 * `muon login`" — the action the human had already completed.
 */
export type McpIdentityGate = {
  /** `locked` | `locked-unregistered` | `open`. Both locked states refuse. */
  readonly state: () => IdentityGateState;
  /** The one shared refusal copy for the CURRENT state, from @muon/client. */
  readonly refusal: () => string;
};

/** Closed for work: either locked state. Derived in ONE place so a third state
 *  cannot be added and accidentally read as permission at one of the three
 *  sites below. */
function gateClosed(gate: McpIdentityGate | undefined): boolean {
  const state = gate?.state();
  return state !== undefined && state !== "open";
}

export type BuildMuonServerOptions = {
  readonly mode?: string;
  /**
   * REPLACE the composed instructions entirely (ADR-0049).
   *
   * For a session that holds NOTHING and exists only to say why — a lapsed
   * attached seat. The ordinary voice describes a tier this session does not
   * have, so echoing it beside zero tools would be the overclaim the voice
   * exists to prevent.
   */
  readonly instructions?: string;
  /**
   * ADR-0052. Absent (every dev run, every test) means UNGATED and this file
   * behaves exactly as it did before the ADR.
   */
  readonly identityGate?: McpIdentityGate;
  /**
   * ADR-0095 — the observatory's tap on the ONE tools/call choke point.
   * Callbacks the ENTRY provides; this factory stays pure (no token, no env,
   * no consent logic here — the entry owns all of that). Usage coordinates
   * only: the raw tool name (the tap coerces it to the closed vocabulary),
   * a duration, a coarse outcome. Never arguments, never results.
   */
  readonly telemetry?: McpTelemetryTaps;
};

export type McpTelemetryTaps = {
  /** Every tools/call, however it ended: "none" | "refused" | "unknown". */
  readonly toolCall?: (tool: string, durationMs: number, error: "none" | "refused" | "unknown") => void;
  /** Each call an ARMED, closed gate refused. */
  readonly gateRefused?: () => void;
  /** The first call an ARMED, open gate admitted — at most once per session.
   *  Never fired on an ungated session: no gate ran, so no gate passed. */
  readonly gatePassed?: () => void;
};

/** A tap must never break the surface it observes. */
function tapSafely(record: (() => void) | undefined): void {
  try {
    record?.();
  } catch {
    /* observability is not authority — swallow */
  }
}

/**
 * P14: the ONE place that wires an MCP `Server`'s `tools/list` and
 * `tools/call` handlers against a fixed, already-composed tool list. Pulled
 * out of stdio's `main()` (`index.ts`) so the loopback HTTP/SSE transport
 * (`http-transport.ts`) shares this exact request-handling path instead of a
 * second copy that could drift.
 *
 * A session's authority is entirely decided by WHICH `tools` were composed
 * before this call — this function reads no token, no mode, no env. That is
 * what keeps the HTTP transport's "never operator-on-MCP widening" invariant
 * true by construction: whatever calls this always hands it the same fixed
 * base tool list, so there is nothing here to widen.
 */
export function buildMuonServer(
  tools: ToolDefinition[],
  options: BuildMuonServerOptions = {}
): Server {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // Feature #10: tell `whoami` what this session actually holds. Bound here
  // because this is the only place that sees the FINAL list — the base
  // definitions are extended by the observer/coordinator/orchestrator
  // composers after they are built, so anything computed earlier would
  // under-report. Every tool asking is offered the same surface; only the
  // identity tool implements the hook.
  //
  // `options.mode` originates in MUON_MCP_MODE, which the vendor process can
  // set. An unrecognised value must NOT be echoed back as this session's tier:
  // `MUON_MCP_MODE=ORCHESTRATOR` would otherwise have whoami answer
  // "ORCHESTRATOR" beside a worker's 27 tools. Positive list, and anything
  // else reports what was actually built.
  const surface: SessionSurface = {
    mode: KNOWN_SERVER_MODES.includes(options.mode as ServerMode)
      ? (options.mode as string)
      : "worker",
    toolNames: tools.map((tool) => tool.name),
    // ADR-0052. THIS gate — the one the `tools/call` handler below reads —
    // never a second resolution, so `whoami` and the refusal can never
    // disagree. Read per call: no gate object is `unarmed`, and an armed one
    // reports its own state (`locked`, `locked-unregistered`, or `open`).
    identityGate: () => options.identityGate?.state() ?? "unarmed",
  };
  for (const tool of tools) {
    tool.bindSessionSurface?.(surface);
  }

  const server = new Server(
    { name: "muon", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      // §3.3: the FIRST thing an attached session is told, mirrored verbatim
      // from stdio's main() — a session must read the same instructions
      // regardless of which transport carried it here.
      instructions:
        (options.instructions ??
          muonServerInstructions({
            toolCount: tools.length,
            mode: options.mode,
            // THE SAME resolver `whoami` reports `grant.codeGraph` from, called
            // here rather than re-derived: an install with no reachable
            // `gitnexus` CLI registers all seven code-graph tools and refuses
            // every one of them, and the first thing a session reads must not
            // send it to them. `whoami` and `initialize` cannot disagree,
            // because there is one function to disagree with.
            codeGraph: gitNexusCliReachable() ? "available" : "unavailable",
          })) +
        // ADR-0052: `initialize` and `tools/list` stay answerable while gated —
        // reading the tool list is not work — but the session is told once, in
        // the first thing it is handed, why every call it makes will refuse.
        // Silently listing tools that all fail would be the worse lie.
        (gateClosed(options.identityGate)
          ? `\n\nMUON IS LOCKED ON THIS MACHINE. Every tool here except ` +
            // Named FROM the set, never retyped beside it: a prose list that
            // drifts from the enforced one is a confidently wrong instruction.
            `${[...MCP_IDENTITY_GATE_EXEMPT_TOOLS].join(" and ")} will refuse ` +
            `until a human runs \`muon login\`. Say so plainly and continue ` +
            `without MUON's tools; do not attempt to open the gate yourself.`
          : ""),
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(toMcpToolDefinition),
  }));

  // ADR-0095: gate_passed is a SESSION fact, not a per-call one — dedupe here,
  // where the session lives.
  let gatePassRecorded = false;
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const startedAt = Date.now();
    // ADR-0052 — checked BEFORE the tool is even resolved, so a gated session
    // cannot use this handler to probe which tool names exist either.
    if (
      gateClosed(options.identityGate) &&
      !MCP_IDENTITY_GATE_EXEMPT_TOOLS.has(request.params.name)
    ) {
      tapSafely(options.telemetry?.gateRefused);
      tapSafely(() =>
        options.telemetry?.toolCall?.(request.params.name, 0, "refused")
      );
      return dataOnlyMcpError(
        request.params.name,
        options.identityGate!.refusal()
      );
    }
    // An ARMED, OPEN gate that admits its first call: the session passed the
    // gate. An ungated session records nothing — no gate ran, so no gate
    // passed. The open check matters: an EXEMPT call (whoami) reaches here
    // through a LOCKED gate too, and that is not a pass either.
    if (
      options.identityGate &&
      !gateClosed(options.identityGate) &&
      !gatePassRecorded
    ) {
      gatePassRecorded = true;
      tapSafely(options.telemetry?.gatePassed);
    }
    const finish = (error: "none" | "unknown") => {
      tapSafely(() =>
        options.telemetry?.toolCall?.(
          request.params.name,
          Date.now() - startedAt,
          error
        )
      );
    };
    const tool = byName.get(request.params.name);
    if (!tool) {
      finish("unknown");
      return dataOnlyMcpError(
        request.params.name,
        `Unknown tool '${request.params.name}'`
      );
    }
    try {
      const result = await tool.handler(
        (request.params.arguments ?? {}) as Record<string, unknown>
      );
      finish("none");
      return result;
    } catch (error) {
      finish("unknown");
      return dataOnlyMcpError(
        request.params.name,
        error instanceof Error ? error.message : "Tool failed"
      );
    }
  });

  return server;
}
