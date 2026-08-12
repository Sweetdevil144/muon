// HTTP request logging policy for the embedded brain.
//
// The default Fastify logger emitted TWO info lines ("incoming request",
// "request completed") for every request. MUON's surfaces poll the loopback API
// every ~2 seconds (approvals, jobs, streams, fleet, runner heartbeats), so on
// the founder's machine brain.log reached 83 MB in which real events were
// impossible to find. That is a debuggability bug, not a taste issue.
//
// The policy here keeps ONE line per request and grades it:
//
//   5xx                    → error   (always visible)
//   4xx                    → warn    (always visible)
//   read-only poll traffic → debug   (invisible at the default level)
//   everything else        → info    (writes: dispatch, approve, confirm, …)
//
// "Read-only poll traffic" is GET/HEAD/OPTIONS: every polling loop in MUON is a
// read, and every state change is a POST/PATCH/PUT/DELETE. So the default level
// shows exactly what the system DID, and `MUON_LOG_LEVEL=debug`
// (`npm run dev:desktop:debug`) shows everything, polls included.

import { redactForLog } from "@muon/core";
import { LogController, type FastifyReply, type FastifyRequest } from "fastify";

export type RequestLogLevel = "error" | "warn" | "info" | "debug";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Machine-plane heartbeats that are writes by HTTP method but polls in fact:
 * the runner heartbeats every ~5s for its whole life, which is ~17k log lines a
 * day saying only "still alive". Liveness belongs in `npm run debug:report`
 * (which reads the Runner table), not in the info-level log.
 */
const POLL_PATHS = ["/api/runner/heartbeat"];

/** Valid pino levels, so a typo in MUON_LOG_LEVEL cannot silence the brain. */
const LOG_LEVELS = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

export const DEFAULT_LOG_LEVEL = "info";

export function resolveLogLevel(
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = env.MUON_LOG_LEVEL?.trim().toLowerCase();
  return raw && LOG_LEVELS.has(raw) ? raw : DEFAULT_LOG_LEVEL;
}

export function requestLogLevel(
  method: string,
  statusCode: number,
  url = ""
): RequestLogLevel {
  if (statusCode >= 500) {
    return "error";
  }
  if (statusCode >= 400) {
    return "warn";
  }
  const path = url.split("?")[0] ?? "";
  if (POLL_PATHS.some((poll) => path === poll || path.startsWith(`${poll}/`))) {
    return "debug";
  }
  return READ_METHODS.has(method.toUpperCase()) ? "debug" : "info";
}

/**
 * The single per-request record. Deliberately method/url/status/duration only:
 * headers (which carry the bearer token) and bodies NEVER enter a log line.
 */
export function requestLogFields(input: {
  method: string;
  url: string;
  statusCode: number;
  durationMs: number;
}): Record<string, string | number> {
  return {
    method: input.method,
    // Strip the query string: it is not needed for triage and is the one part
    // of a URL that could carry a caller-supplied value.
    url: input.url.split("?")[0] ?? input.url,
    status: input.statusCode,
    ms: Math.round(input.durationMs),
  };
}

/**
 * Fastify's log controller (>= 5.10), overridden to apply the policy above.
 *
 * `incomingRequest` is suppressed outright — it carried no information the
 * completion line lacks, and it doubled the volume. `requestCompleted` emits ONE
 * graded line whose fields are coordinates only: no headers (the `Authorization`
 * bearer lives there), no body, no query string.
 */
export class MuonLogController extends LogController {
  override incomingRequest(): void {
    // Deliberately silent: one line per request, emitted on completion.
  }

  override requestCompleted(
    error: Error | null,
    request: FastifyRequest,
    reply: FastifyReply
  ): void {
    const fields = requestLogFields({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
    });
    if (error) {
      // TODO 7.1: never put a raw Error.message on brain.log.
      request.log.error(
        { ...fields, err: redactForLog(error.message) },
        "request failed"
      );
      return;
    }
    request.log[
      requestLogLevel(request.method, reply.statusCode, request.url)
    ](fields, "request");
  }
}
