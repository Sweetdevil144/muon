import {
  buildCapabilityPreflight,
  type AgentRecord,
  type ApprovalReceipt,
  type ApprovalRequest,
  type BlockingQuestion,
  type CapabilityPreflight,
  type CoordinationMetrics,
  type DispatchJobRecord,
  type Health,
  type Handoff,
  type Lane,
  type MuonApiClient,
  type RecordedEvent,
  type Task,
  type VendorReadiness,
} from "@muon/client";

export type LaneDoctorStatus = Record<string, "healthy" | "degraded" | "unavailable">;

/**
 * The brain this store is pointed at, surfaced honestly so the Header can name
 * the URL + data dir it tried (never a token). `source` records HOW we arrived
 * there: an explicit `flag`/`env` (never re-resolved — F1 no-hijack) vs an
 * auto-discovered `lockfile`/`default`/`spawned` brain (may rotate per boot).
 */
export type BrainTarget = {
  base: string;
  dataDir: string;
  source: "flag" | "env" | "lockfile" | "default" | "spawned";
};

export type BrainSnapshot = {
  health: Health | null;
  lanes: Lane[];
  /** The fleet: agent instances (0–3 per vendor) with live status. */
  agents: AgentRecord[];
  /**
   * Wave 4.2 parity: active dispatch jobs, so the FleetRail derives the SAME
   * crew-liveness state as the desktop crew tree (a silent child lights amber
   * before it dies) from the shared state machine — no drift between surfaces.
   */
  dispatchJobs: DispatchJobRecord[];
  tasks: Task[];
  approvals: ApprovalRequest[];
  /** OPEN blocking questions machine-wide (ADR-0043) — the human inbox half. */
  questions: BlockingQuestion[];
  handoffs: Handoff[];
  events: RecordedEvent[];
  metrics: CoordinationMetrics | null;
  pendingApprovals: number;
  activeHandoffs: number;
  /** Local adapter/auth health per lane key (binary present etc.). */
  laneDoctor: LaneDoctorStatus;
  /**
   * P2b onboarding: per-vendor readiness (installed? logged in?) with fix hints.
   * `null` = not yet probed OR the probe was unavailable. The first-run panel
   * renders from this; it never carries a token.
   */
  readiness: VendorReadiness[] | null;
  /**
   * P0.5 capability preflight — the ONE doctor contract every surface (CLI
   * `muon doctor --json`, the MCP tool, the desktop DiagnosticsStrip)
   * projects from. Built every poll from the SAME fetched evidence
   * (`buildCapabilityPreflight`, never re-derived locally); a fetch failure
   * still produces an honest blocked/unreachable projection, never a crash
   * and never a false "ready". `null` only before the very first poll lands.
   */
  preflight: CapabilityPreflight | null;
  /**
   * P0.4 TUI parity: live (unexpired, unrevoked) content-bound approval
   * receipts, for the ReviewInbox's active-receipts line (same contract as
   * the desktop inbox annotation, `DesktopState.activeReceipts`). `null` =
   * honest absence — not yet polled OR the last poll failed — so the caller
   * renders NOTHING rather than a stale count. Unlike `readiness` below,
   * this field is NEVER carried forward across a failed poll: a receipts
   * failure REPLACES the value with `null`, it does not keep the prior
   * successful count.
   */
  activeReceipts: ApprovalReceipt[] | null;
  /** The brain we are pointed at (base + data dir + how we found it). */
  target: BrainTarget;
  error: string | null;
  updatedAt: string;
};

export function emptyBrainSnapshot(): BrainSnapshot {
  return {
    health: null,
    lanes: [],
    agents: [],
    dispatchJobs: [],
    tasks: [],
    approvals: [],
    questions: [],
    handoffs: [],
    events: [],
    metrics: null,
    pendingApprovals: 0,
    activeHandoffs: 0,
    laneDoctor: {},
    readiness: null,
    preflight: null,
    activeReceipts: null,
    target: { base: "http://localhost:4000", dataDir: "", source: "default" },
    error: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export type BrainStore = {
  client: MuonApiClient;
  /** The CURRENT target base, paired with `apiToken` below — both rotate on
   *  an auto-discovered re-resolution and must be read together. */
  apiBase: string;
  apiToken: string | undefined;
  getSnapshot: () => BrainSnapshot;
  subscribe: (listener: () => void) => () => void;
  refresh: () => Promise<void>;
  start: (intervalMs?: number) => void;
  stop: () => void;
};

export type BrainStoreOptions = {
  /** The brain this store targets; surfaced honestly in the snapshot/Header. */
  target?: BrainTarget;
  /** The OPERATOR token paired with `target` — carried so callers that need
   *  base+token together (crew panel) read the store's pair, never a fresh
   *  resolve that could name a different profile's brain. */
  apiToken?: string;
  /**
   * Re-resolve the AUTO-discovered brain after a connection-level failure and
   * return a client re-pointed at the new base AND token together (both rotate
   * per brain boot). Return null when nothing reachable changed. The store also
   * guards on `target.source`, so this is never honored for an explicit
   * (flag/env) target — a user pointed at a known brain is never hijacked (F1).
   */
  reresolve?: () => Promise<
    { client: MuonApiClient; target: BrainTarget; token?: string } | null
  >;
  /** Seed an initial offline state (e.g. ensureBrain's failure note). */
  startupError?: string;
};

export function createBrainStore(
  client: MuonApiClient,
  /** Optional local lane doctor (checks vendor binaries/auth); runs once. */
  laneDoctorCheck?: (lanes: Lane[]) => Promise<LaneDoctorStatus>,
  options: BrainStoreOptions = {}
): BrainStore {
  // The client + target can rotate at runtime (a dead auto-discovered brain
  // replaced by a freshly-booted one on a new port/token), so both are mutable.
  let activeClient = client;
  let currentTarget: BrainTarget =
    options.target ?? emptyBrainSnapshot().target;
  let currentToken = options.apiToken;
  const reresolve = options.reresolve;
  const autoDiscovered =
    currentTarget.source !== "flag" && currentTarget.source !== "env";

  let snapshot: BrainSnapshot = {
    ...emptyBrainSnapshot(),
    target: currentTarget,
  };
  if (options.startupError) {
    // Boot the UI already honest about being offline (ensureBrain failed), with
    // the note that names the data dir / log / lockfile.
    snapshot = {
      ...snapshot,
      error: options.startupError,
      preflight: buildCapabilityPreflight({
        brain: { reachable: false, detail: options.startupError },
        readiness: null,
        runner: null,
      }),
    };
  }

  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let doctorRan = false;

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const refresh = async () => {
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      // Per-endpoint honesty: brain reachability derives ONLY from health(). A
      // health() failure is the ONE fail-closed path (CONTROL_PLANE_UNREACHABLE);
      // ANY OTHER endpoint failing keeps the brain "reachable" and records a
      // per-endpoint error — a single bad route never reads as "control offline".
      const endpointErrors: string[] = [];
      // Seat counts must degrade to UNKNOWN, not to the carried-forward prior
      // (which is `[]` on a first-poll failure and would read as "zero seats").
      let agentsUnread = false;
      const keep =
        <T>(label: string, prior: T) =>
        (error: unknown): T => {
          endpointErrors.push(
            `${label}: ${error instanceof Error ? error.message : String(error)}`
          );
          return prior;
        };

      try {
        const [
          healthResult,
          lanes,
          agents,
          dispatchJobs,
          tasks,
          approvals,
          questions,
          dashboard,
          metrics,
          readinessReport,
          runner,
          activeReceipts,
        ] = await Promise.all([
          activeClient
            .health()
            .then((health) => ({ ok: true as const, health }))
            .catch((error: unknown) => ({ ok: false as const, error })),
          activeClient.listLanes().catch(keep("lanes", snapshot.lanes)),
          activeClient.listAgents().catch(() => {
            agentsUnread = true;
            return snapshot.agents;
          }),
          // Wave 4.2 parity: active jobs feed the FleetRail's crew-liveness.
          // Degrade-safe (keep prior) so a transient failure never blanks the
          // fleet's live state.
          activeClient
            .listDispatchJobs({ activeOnly: true, limit: 200 })
            .catch(keep("dispatchJobs", snapshot.dispatchJobs)),
          activeClient.listTasks().catch(keep("tasks", snapshot.tasks)),
          activeClient
            .listApprovals()
            .catch(keep("approvals", snapshot.approvals)),
          // Surface-parity audit 2026-08-11: agents file blocking questions
          // (ADR-0043) and the TUI showed nothing. Through the CLIENT (so a
          // re-resolved brain is followed), and Promise-wrapped so a mock or
          // older client without the method rejects into keep() instead of
          // sync-throwing out of the Promise.all assembly.
          Promise.resolve()
            .then(() => activeClient.listOpenQuestions())
            .then((result) => result.questions)
            // TWO failure classes, deliberately split (cubic P2): an older
            // brain without the /open route (404, or a mocked client without
            // the method) degrades SILENTLY — a permanent banner would punish
            // every not-yet-upgraded install for a nicety. Everything else
            // (auth, outage, malformed) records through keep() like any
            // other endpoint, so a live failure stays visible.
            .catch((error: unknown) => {
              const message =
                error instanceof Error ? error.message : String(error);
              if (
                message.includes("404") ||
                message.includes("listOpenQuestions is not a function")
              ) {
                return snapshot.questions;
              }
              return keep("questions", snapshot.questions)(error);
            }),
          activeClient.dashboard().catch(
            keep("dashboard", {
              pendingApprovals: snapshot.pendingApprovals,
              activeHandoffs: snapshot.activeHandoffs,
            })
          ),
          activeClient.getMetrics().catch(keep("metrics", snapshot.metrics)),
          // Auth-aware readiness (P2b onboarding), the full report (vendors +
          // probe-freshness generatedAt) so it doubles as P0.5 preflight input.
          // Rides the backend's short cache, so the 2s poll never hammers the
          // vendor CLIs. null when the probe/route is unavailable, both the
          // first-run panel and the preflight degrade honestly.
          activeClient.getFleetReadinessReport().catch(() => null),
          // P0.5 preflight input: runner liveness. null when unreadable.
          activeClient.getRunner().catch(() => null),
          // P0.4 TUI parity: live receipts for the ReviewInbox annotation.
          // Deliberately NOT `keep()` — a receipts failure must clear to
          // null (honest absence), never carry forward a stale prior count.
          activeClient
            .listReceipts({ activeOnly: true })
            .catch((error: unknown) => {
              endpointErrors.push(
                `receipts: ${error instanceof Error ? error.message : String(error)}`
              );
              return null;
            }),
        ]);

        if (!healthResult.ok) {
          // Fail-closed: the control plane ITSELF is unreachable. Keep prior
          // section values; degrade the shared preflight to
          // CONTROL_PLANE_UNREACHABLE (the ONE honest blocked projection).
          const message =
            healthResult.error instanceof Error
              ? healthResult.error.message
              : "Refresh failed";
          snapshot = {
            ...snapshot,
            health: null,
            // Control plane unreachable ⇒ no honest receipts count either.
            activeReceipts: null,
            preflight: buildCapabilityPreflight({
              brain: { reachable: false, detail: message },
              readiness: null,
              runner: null,
            }),
            target: currentTarget,
            error: message,
            updatedAt: new Date().toISOString(),
          };
          // Auto-discovered targets can rotate (new port + token per boot).
          // Re-point at a freshly-booted brain — base AND token together;
          // explicit (flag/env) targets are never touched (F1 no-hijack).
          // Swap on ANY successful reresolve, not only a base change: a brain
          // that reboots onto the same ephemeral port has a fresh token, and
          // the base-only guard kept the stale bearer 401ing forever.
          if (autoDiscovered && reresolve) {
            const next = await reresolve().catch(() => null);
            if (next) {
              activeClient = next.client;
              currentTarget = next.target;
              currentToken = next.token ?? currentToken;
            }
          }
          return;
        }

        const health = healthResult.health;

        const activeTasks = tasks.filter(
          (task) => task.status === "in_progress" || task.status === "review"
        );
        const detailTargets =
          activeTasks.length > 0
            ? activeTasks.slice(0, 8)
            : tasks.slice(0, 5);

        let handoffs = snapshot.handoffs;
        let events = snapshot.events;
        try {
          const details = await Promise.all(
            detailTargets.map((task) => activeClient.getTaskDetail(task.id))
          );

          const eventLists = await Promise.all(
            detailTargets.map((task) => activeClient.listTaskEvents(task.id))
          );

          handoffs = details.flatMap((detail) =>
            detail.handoffs.map((handoff) => ({
              id: handoff.id,
              taskId: detail.id,
              fromLaneId: handoff.fromLane?.id ?? "",
              toLaneId: handoff.toLane?.id ?? "",
              packetTitle: handoff.packetTitle,
              packetBody: handoff.packetBody,
              status: handoff.status,
              fromLane: handoff.fromLane,
              toLane: handoff.toLane,
            }))
          );
          events = eventLists.flat();
        } catch (error) {
          endpointErrors.push(
            `task details: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }

        let laneDoctor = snapshot.laneDoctor;
        if (!doctorRan && laneDoctorCheck) {
          doctorRan = true;
          laneDoctor = await laneDoctorCheck(lanes).catch(() => ({}));
        }

        snapshot = {
          health,
          lanes,
          agents,
          dispatchJobs,
          tasks,
          approvals,
          questions,
          handoffs,
          events,
          metrics,
          pendingApprovals: dashboard.pendingApprovals,
          activeHandoffs: dashboard.activeHandoffs,
          laneDoctor,
          // Keep the last known readiness if a transient probe failure returns
          // null, a just-probed panel shouldn't flicker away on one bad poll.
          readiness: readinessReport?.vendors ?? snapshot.readiness,
          // P0.4 TUI parity: UNLIKE readiness above, a receipts failure is
          // NOT carried forward — `activeReceipts` is `null` here whenever
          // this poll's fetch failed, even if a prior poll succeeded. The
          // ReviewInbox's active-receipts line must never show a stale count.
          activeReceipts,
          // P0.5: the SAME contract the CLI/MCP surfaces project. Brain is
          // reachable (health OK) even if some routes failed, so this is built
          // with brain reachable — never a false CONTROL_PLANE_UNREACHABLE.
          preflight: buildCapabilityPreflight({
            brain: { reachable: true },
            readiness: readinessReport,
            runner,
            // Worker seats (the route already excludes reserved ordinal 0) —
            // the same rows the claim semaphore draws from. `null` when this
            // poll could not read them, so capacity says "unknown".
            fleet: agentsUnread ? null : { agents },
          }),
          target: currentTarget,
          // Per-endpoint failures (health was OK): honest, never "offline".
          error: endpointErrors.length > 0 ? endpointErrors.join("; ") : null,
          updatedAt: new Date().toISOString(),
        };
      } catch (error) {
        // Defensive: nothing above should reject (every fetch is caught), so a
        // throw here is a bug. Fail closed rather than crash the poll loop.
        const message =
          error instanceof Error ? error.message : "Refresh failed";
        snapshot = {
          ...snapshot,
          activeReceipts: null,
          preflight: buildCapabilityPreflight({
            brain: { reachable: false, detail: message },
            readiness: null,
            runner: null,
          }),
          target: currentTarget,
          error: message,
          updatedAt: new Date().toISOString(),
        };
      } finally {
        inFlight = null;
        emit();
      }
    })();

    return inFlight;
  };

  return {
    // A getter so the ~40 `store.client.*` call sites always see the CURRENT
    // client after an auto-discovered re-resolution swap.
    get client() {
      return activeClient;
    },
    // The CURRENT target base, for callers that must pass an apiBase alongside
    // the client (crew panel, mcp attach). Re-resolving from scratch at those
    // call sites could name a DIFFERENT brain than the client — one panel,
    // two ledgers.
    get apiBase() {
      return currentTarget.base;
    },
    /** The operator token PAIRED with apiBase above (same rotation). */
    get apiToken() {
      return currentToken;
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    start: (intervalMs = 2000) => {
      if (timer) {
        return;
      }
      void refresh();
      timer = setInterval(() => {
        void refresh();
      }, intervalMs);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
