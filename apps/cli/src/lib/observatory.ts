import { resolveDataDir } from "@muon/client/paths";
import {
  createSurfaceObservatory,
  gateRefusalReasonForState,
  type ObservatoryEvent,
} from "@muon/client/observatory";
import type {
  CliIdentityGate,
  CliIdentityGateVerdict,
} from "./identity-gate.js";

/**
 * ADR-0095 — the CLI end of the observatory, through the SAME shared module
 * (spool, consent, uploader) as the desktop and muon-mcp. Two pieces, split
 * so the decision is testable without a process:
 *
 *  - `cliGateObservatoryEvent` is the PURE mapping from this run's gate +
 *    verdict to at most one event. The honesty rules live here: an unarmed
 *    gate records nothing (no gate ran); an exempt command slipping through
 *    a locked gate (`muon login` on a locked machine) is NOT a pass and
 *    records nothing; a refusal carries only the coarse reason.
 *
 *  - `recordCliGateEvent` spools it (synchronously, so even a refusal path
 *    that exits keeps its local record). Egress is attempted ONLY when the
 *    caller passes `upload: true` — and the only caller that does is the
 *    refusal path, which `process.exit`s immediately after, so the request's
 *    socket can never outlive the command. The PASS path is spool-only: the
 *    reviewer measured Node's pooled keep-alive socket holding an otherwise
 *    finished `muon` command open for ~28s after a fire-and-forget POST
 *    (the 400ms bound resolves the AWAIT, not the connection), and a working
 *    command must never pay a telemetry tax measured in seconds.
 *    Never throws — observability is not authority.
 */
export function cliGateObservatoryEvent(
  gate: CliIdentityGate,
  verdict: CliIdentityGateVerdict
): ObservatoryEvent | undefined {
  if (!gate.required) return undefined;
  if (!verdict.allowed) {
    return {
      name: "identity.gate_refused",
      surface: "cli",
      reason: gateRefusalReasonForState(gate.state),
      trigger: "command",
    };
  }
  if (!gate.satisfied) return undefined;
  return { name: "identity.gate_passed", surface: "cli", trigger: "command" };
}

const DEFAULT_FLUSH_BOUND_MS = 400;

export async function recordCliGateEvent(
  event: ObservatoryEvent,
  options: {
    appVersion: string;
    /** Attempt one bounded egress flush — the name states the contract: the
     *  caller EXITS immediately after, which is what severs the socket. Any
     *  path that keeps running must not pass this (module docstring has the
     *  measured 28s socket-lifetime reason). */
    flushBeforeExit?: boolean;
    dataDir?: string;
    fetcher?: typeof fetch;
    flushBoundMs?: number;
  }
): Promise<void> {
  let surface: ReturnType<typeof createSurfaceObservatory> | undefined;
  try {
    surface = createSurfaceObservatory({
      dataDir: options.dataDir ?? resolveDataDir(),
      appVersion: options.appVersion,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
    surface.observatory.record(event);
    if (!options.flushBeforeExit) return;
    await Promise.race([
      surface.flush().catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          options.flushBoundMs ?? DEFAULT_FLUSH_BOUND_MS
        );
        timer.unref?.();
      }),
    ]);
  } catch {
    /* never let telemetry break a command */
  } finally {
    // One-shot: nothing may linger for the rest of the command process.
    try {
      surface?.stop();
    } catch {
      /* same rule */
    }
  }
}
