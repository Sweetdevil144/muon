import type { FleetReadinessReport } from "@muon/client";

/**
 * A NON-BLOCKING, main-process readiness cache.
 *
 * ## Why this exists (measured, not assumed)
 *
 * `collectState()` used to `await client.getFleetReadinessReport()` inside its
 * one big `Promise.all`. That call SPAWNS REAL VENDOR CLI SUBPROCESSES — two per
 * lane (`--version`, then the auth probe) — and the lanes only run concurrently
 * with each other, never within a lane. Measured on a fully-installed machine
 * (2026-07-26, all four lanes present and logged in):
 *
 *   claude   --version  84ms   claude auth status --json   249ms
 *   codex    --version 100ms   codex login status          104ms
 *   opencode --version 455ms   opencode auth list          486ms
 *   cursor-agent --version 497ms   cursor-agent status    3363ms   <- the floor
 *
 *   getFleetReadinessReport (cold)  3835 ms
 *   every OTHER collectState leg     2-40 ms
 *
 * The backend caches the probe for 8s (DEFAULT_READINESS_TTL_MS) but the
 * renderer polls every 2s, so roughly every fourth poll paid ~3.8s — and
 * because it rode in the same `Promise.all` as the chats, fleet, approvals and
 * dispatch ledger, the WHOLE desktop state stalled behind it. The first poll
 * after launch always paid it, so Crew / Status / Doctor opened onto empty
 * scaffolding for ~4 seconds. That, not React rendering, was the "taking time".
 *
 * ## What this changes
 *
 * Readiness leaves the critical path. `read()` is synchronous and answers with
 * whatever is already known, plus HONEST metadata about how old it is and
 * whether a probe is running right now. When the value is missing or older than
 * `ttlMs` it schedules a probe in the background and returns immediately.
 *
 * ## What this deliberately does NOT change
 *
 * This is a DISPLAY cache and nothing else. No governance gate reads it:
 * `requireOrchestratorReady` still calls `client.getVendorReadiness` on its own
 * path (cached verdict first, one cache-bypassing re-probe before it enforces a
 * definite block), and the dispatch routes in the brain are the real authority.
 * A stale value here can therefore never turn a refusal into an admission — it
 * can only make a LABEL slightly old, which the UI renders as "checked Ns ago".
 *
 * It also never invents a verdict. With no probe result yet the state is
 * `probing`/`unknown` and `report` is null — the surfaces render "Checking
 * providers…", never a fabricated "ready".
 */

/** Freshness of the readiness value the desktop is currently showing. */
export type ReadinessFreshness =
  /** No probe has ever completed. The first probe is running now. */
  | "probing"
  /** No probe has ever completed and none is running (last attempt failed). */
  | "unknown"
  /** Value is younger than the TTL. */
  | "fresh"
  /** Value is older than the TTL; a refresh is running in the background. */
  | "refreshing"
  /** Value is older than the TTL and no refresh is running (last one failed). */
  | "stale";

/** Non-secret projection of the cache, safe to put on the IPC state. */
export type ReadinessSnapshotMeta = {
  state: ReadinessFreshness;
  /** ISO time the CURRENT value was probed, or null when there is no value. */
  checkedAt: string | null;
  /** Age of the current value in ms, or null when there is no value. */
  ageMs: number | null;
  /** Why the last probe attempt failed. Never contains credential material. */
  error: string | null;
};

export type ReadinessSnapshot = {
  report: FleetReadinessReport | null;
  meta: ReadinessSnapshotMeta;
};

export type ReadinessCache = {
  /**
   * Whatever is known RIGHT NOW. Never awaits a subprocess. Schedules a
   * background refresh when the value is missing or older than the TTL.
   */
  read: () => ReadinessSnapshot;
  /**
   * Force a probe that BYPASSES the brain's own short cache and await it (the
   * explicit "Re-check providers" act, run right after a vendor login). Joins
   * an in-flight forced probe; queues behind a background one rather than
   * racing it, so the newest result always wins.
   */
  refresh: () => Promise<ReadinessSnapshot>;
  /** Kick a background probe without awaiting it (boot priming). */
  prime: () => void;
  /** Drop the value — e.g. the brain restarted on new coordinates. */
  clear: () => void;
};

/**
 * How long a displayed readiness value stays "fresh".
 *
 * Longer than the brain's own 8s probe cache ON PURPOSE. Once readiness is off
 * the critical path its interval no longer costs the user latency, only ambient
 * subprocess churn: at the old 8s cadence a desktop left open re-spawned every
 * vendor CLI ~7 times a minute forever. 30s keeps the lane lights genuinely
 * live while cutting that by ~4x, and the human always has an explicit
 * "Re-check" that bypasses it entirely.
 */
export const READINESS_DISPLAY_TTL_MS = 30_000;

export function createReadinessCache(options: {
  /**
   * Probe the vendors. `refresh` asks the brain to bypass its own short cache.
   * Rejections are recorded as an error string, never thrown to callers.
   */
  probe: (refresh: boolean) => Promise<FleetReadinessReport | null>;
  ttlMs?: number;
  now?: () => number;
  /** Reported when a probe attempt fails or the route is unavailable. */
  onError?: (message: string) => void;
}): ReadinessCache {
  const ttlMs = options.ttlMs ?? READINESS_DISPLAY_TTL_MS;
  const now = options.now ?? Date.now;

  let value: { at: number; report: FleetReadinessReport } | null = null;
  let error: string | null = null;
  // In-flight dedupe, tracked separately for the two kinds of probe. Without it
  // the 2s poll (a probe takes ~3.8s) and the getState() calls that
  // fleet/settings mutations make would stampede: three concurrent cold probes
  // measured 5576ms against 3717ms for one.
  let background: Promise<ReadinessSnapshot> | null = null;
  let forced: Promise<ReadinessSnapshot> | null = null;

  const snapshot = (): ReadinessSnapshot => {
    const running = background !== null || forced !== null;
    if (!value) {
      return {
        report: null,
        meta: {
          state: running ? "probing" : "unknown",
          checkedAt: null,
          ageMs: null,
          error,
        },
      };
    }
    const ageMs = Math.max(0, now() - value.at);
    const state: ReadinessFreshness =
      ageMs < ttlMs ? "fresh" : running ? "refreshing" : "stale";
    return {
      report: value.report,
      meta: {
        state,
        checkedAt: new Date(value.at).toISOString(),
        ageMs,
        error,
      },
    };
  };

  const runProbe = async (isForced: boolean): Promise<ReadinessSnapshot> => {
    // Stamp the value with when the probe STARTED, not when it landed: a 3.8s
    // probe would otherwise read as fresher than the evidence actually is.
    const startedAt = now();
    try {
      const report = await options.probe(isForced);
      if (report) {
        // LAST STARTED WINS. A forced re-check runs CONCURRENTLY with any
        // background probe already in flight (queueing behind it measured
        // 7675ms for a human-initiated re-check against ~3.8s for one probe —
        // an unacceptable wait for a button press). Because the forced probe
        // starts later, this guard makes its cache-bypassing answer the one
        // that survives even if the older background probe resolves after it.
        if (!value || startedAt >= value.at) {
          value = { at: startedAt, report };
          error = null;
        }
      } else {
        // The route is unavailable on this brain. Keep any previous value
        // (its age labels it) rather than blanking every surface.
        error = "Provider checks are unavailable on this control plane.";
        options.onError?.(error);
      }
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "Provider checks could not run.";
      options.onError?.(error);
    }
    return snapshot();
  };

  const startBackground = (): Promise<ReadinessSnapshot> => {
    // A forced probe already covers a background one — never spawn both for
    // the same staleness.
    if (forced) return forced;
    if (background) return background;
    const run = runProbe(false).then((result) => {
      if (background === run) background = null;
      return result;
    });
    background = run;
    return run;
  };

  const startForced = (): Promise<ReadinessSnapshot> => {
    if (forced) return forced;
    const run = runProbe(true).then((result) => {
      if (forced === run) forced = null;
      return result;
    });
    forced = run;
    return run;
  };

  const staleOrMissing = (): boolean =>
    value === null || now() - value.at >= ttlMs;

  return {
    read: () => {
      if (staleOrMissing()) {
        // Fire and forget — the whole point is that no caller ever waits.
        void startBackground();
      }
      return snapshot();
    },
    refresh: () => startForced(),
    prime: () => {
      if (staleOrMissing()) {
        void startBackground();
      }
    },
    clear: () => {
      value = null;
      error = null;
      // Deliberately does NOT cancel an in-flight probe: it was issued against
      // the LOCAL vendor CLIs, which a brain restart does not change, so
      // letting it land is better than throwing the answer away.
    },
  };
}
