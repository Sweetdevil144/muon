import { useCallback, useEffect, useRef, useState } from "react";
import type { DispatchJobRecord } from "@muon/client";
import type {
  CoordinationResponse,
  CrewRolesResponse,
} from "../../shared/ipc.js";

/**
 * Crew-topology data lifecycle — the SAME shape as `useWorkspaceReviews`: no
 * interval of its own. The store's existing ~2s job poll already re-renders
 * this component; all this hook does is decide, on each of those renders,
 * whether the answers it holds are still the right ones.
 *
 * That decision is a KEY: the selected chat, the mission, a status signature of
 * the chat's jobs, and — while any job is still non-terminal — a coarse 5s time
 * bucket. The bucket is what makes peer traffic visible: two peers can stay
 * `running` for minutes while exchanging dozens of A2A messages and opening and
 * releasing claims, and NOTHING in a status signature moves. When every job is
 * terminal the bucket drops out, the key goes stable, and a settled mission
 * stops re-reading entirely.
 *
 * Per-scope isolation is absolute: every settle re-checks that the response
 * still belongs to the chat AND the mission that asked for it, and the effect
 * cleanup cancels in-flight work on switch/unmount. A late answer for chat A —
 * or for the previous mission of the SAME chat — can never paint what is on
 * screen now.
 */

export type CrewTopologyState = {
  roles: CrewRolesResponse | null;
  coordination: CoordinationResponse | null;
  loading: boolean;
  /** Bump to re-read both routes now (the panel's Refresh affordance). */
  refresh: () => void;
};

/**
 * How coarse the live-mission bucket is. Long enough that the ~2s job poll
 * coalesces into at most one re-read per bucket; short enough that a peer
 * exchange lands on the chart while the operator is still watching it.
 */
export const TOPOLOGY_LIVE_BUCKET_MS = 5_000;

/**
 * One bounded auto-retry after a TRANSIENT failure (see UnavailableIpc), and
 * only for a settled mission — a live one already re-reads on the next bucket,
 * so retrying there would just double the request rate during an outage.
 */
const RETRY_DELAY_MS = 3_000;

/** `DispatchStatus` minus the two states that can still change on their own. */
const TERMINAL_JOB_STATUSES = new Set([
  "done",
  "failed",
  "interrupted",
  "cancelled",
]);

/**
 * True while any job in this chat can still produce coordination traffic. An
 * unrecognized status counts as live: showing a stale chart is worse than one
 * extra read.
 */
export function hasLiveJobs(jobs: readonly DispatchJobRecord[]): boolean {
  return jobs.some((job) => !TERMINAL_JOB_STATUSES.has(job.status));
}

/**
 * The signature that drives a refetch: the scope, which jobs exist and what
 * status each one is in, plus a coarse time bucket WHILE the mission is live.
 * Exported (with an injectable clock) for the test that pins both halves of the
 * rule: a live mission re-reads with no status change, a settled one does not.
 */
export function topologyRefreshKey(
  chatId: string | null,
  missionId: string | null,
  jobs: readonly DispatchJobRecord[],
  now: number = Date.now()
): string {
  if (!chatId) return "";
  return [
    chatId,
    missionId ?? "no-mission",
    // The ONLY moving part for two peers that both stay `running`. Terminal ⇒
    // a constant, so a finished mission never polls again.
    hasLiveJobs(jobs)
      ? `t${Math.floor(now / TOPOLOGY_LIVE_BUCKET_MS)}`
      : "settled",
    ...jobs
      .map((job) => `${job.id}:${job.status}`)
      .sort((left, right) => left.localeCompare(right)),
  ].join("|");
}

/** A failure worth ONE more attempt — never a 404/501 "route not deployed". */
function isTransient(
  response: CrewRolesResponse | CoordinationResponse
): boolean {
  return response.status === "unavailable" && response.retryable === true;
}

export function useCrewTopologyData(
  chatId: string | null,
  /** The mission ROOT jobId — the coordination route is addressed by it. */
  missionId: string | null,
  jobs: readonly DispatchJobRecord[]
): CrewTopologyState {
  const key = topologyRefreshKey(chatId, missionId, jobs);
  const live = hasLiveJobs(jobs);
  const [nonce, setNonce] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  // The attempt this hook has ALREADY spent its one auto-retry on. Bounded by
  // construction: a retry cannot arm another retry, because the token it would
  // have to beat does not change when `retryTick` does.
  const retriedAttempt = useRef<string | null>(null);
  const [state, setState] = useState<{
    chatId: string | null;
    missionId: string | null;
    roles: CrewRolesResponse | null;
    coordination: CoordinationResponse | null;
    loading: boolean;
  }>({
    chatId: null,
    missionId: null,
    roles: null,
    coordination: null,
    loading: Boolean(chatId),
  });

  const refresh = useCallback(() => setNonce((current) => current + 1), []);

  useEffect(() => {
    if (!chatId) {
      setState({
        chatId: null,
        missionId: null,
        roles: null,
        coordination: null,
        loading: false,
      });
      return;
    }
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setState((current) =>
      // Keep the previous answers on screen while a refresh is in flight for
      // the SAME chat AND the same mission (no flash of empty on the 5s
      // bucket). A chat switch — or a new mission in this chat — clears them
      // outright: mission root-1's untrusted peer text and claim paths must
      // never render for one frame ATTRIBUTED to root-2.
      current.chatId === chatId && current.missionId === missionId
        ? { ...current, loading: true }
        : {
            chatId,
            missionId,
            roles: null,
            coordination: null,
            loading: true,
          }
    );

    const bridge = window.muon;
    // Feature detection, exactly like useWorkspaceReviews: an older preload
    // simply has no method here, which is a quiet "unavailable", not a crash.
    // No `retryable` — a missing bridge method never appears mid-session.
    const rolesCall =
      typeof bridge?.crewRoles === "function"
        ? bridge.crewRoles(chatId)
        : Promise.resolve<CrewRolesResponse>({
            status: "unavailable",
            reason: "This app build has no crew-roles bridge.",
          });
    const coordinationCall =
      typeof bridge?.coordination !== "function"
        ? Promise.resolve<CoordinationResponse>({
            status: "unavailable",
            reason: "This app build has no coordination bridge.",
          })
        : !missionId
          ? // The route is addressed by (chatId, missionId); asking without a
            // mission would 400. Say so instead of firing a doomed request.
            Promise.resolve<CoordinationResponse>({
              status: "unavailable",
              reason: "No mission has been dispatched in this chat yet.",
            })
          : bridge.coordination(chatId, missionId);

    // One auto-retry per (scope, explicit refresh) pair. Refresh mints a new
    // token, so the operator always gets a fresh allowance; the retry itself
    // does not.
    const attempt = `${key}|${nonce}`;

    const settle = (
      roles: CrewRolesResponse,
      coordination: CoordinationResponse
    ) => {
      if (stopped) return;
      setState((current) =>
        // Late answer for a scope we already left — discard it outright.
        current.chatId !== null &&
        (current.chatId !== chatId || current.missionId !== missionId)
          ? current
          : { chatId, missionId, roles, coordination, loading: false }
      );
      if (
        !live &&
        retriedAttempt.current !== attempt &&
        (isTransient(roles) || isTransient(coordination))
      ) {
        // A momentary brain outage on a finished mission would otherwise pin
        // "unavailable" until someone finds Refresh: nothing else will ever
        // move this key again. One attempt, then we stop and say so.
        retriedAttempt.current = attempt;
        retryTimer = setTimeout(() => {
          if (!stopped) setRetryTick((current) => current + 1);
        }, RETRY_DELAY_MS);
      }
    };

    void Promise.all([
      rolesCall.catch(
        (error: unknown): CrewRolesResponse => ({
          status: "unavailable",
          reason: reasonOf(error, "The role plan could not be read."),
          // A rejected bridge call is a transport failure, not a verdict.
          retryable: true,
        })
      ),
      coordinationCall.catch(
        (error: unknown): CoordinationResponse => ({
          status: "unavailable",
          reason: reasonOf(error, "The coordination snapshot could not be read."),
          retryable: true,
        })
      ),
    ]).then(([roles, coordination]) => settle(roles, coordination));

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
    // `key` folds the scope, every job's status, and (while live) the 5s
    // bucket; `nonce` is the explicit Refresh; `retryTick` is the single
    // bounded auto-retry. None of the three is a polling loop of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, retryTick]);

  // Until the effect has re-pointed at the newly selected chat/mission, report
  // LOADING with no data rather than the previous scope's answers — the
  // one-mission rule holds even for the single render between a switch and its
  // effect.
  const settled = state.chatId === chatId && state.missionId === missionId;
  return {
    roles: settled ? state.roles : null,
    coordination: settled ? state.coordination : null,
    loading: settled ? state.loading : Boolean(chatId),
    refresh,
  };
}

function reasonOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 200);
  }
  return fallback;
}
