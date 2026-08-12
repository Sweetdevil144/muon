import { useCallback, useEffect, useState } from "react";
import type {
  GitNexusIndexStatus,
  GitNexusReindexResult,
} from "../shared/ipc.js";

// The masthead GitNexus column: a live, token-free read of the local code-graph
// index (idle → indexing → ready → …), the "Open Graph" affordance, and the
// operator's re-index escape hatch. Status is pushed from main via
// `muon:gitnexus` (and mirrored in DesktopState); the re-index goes back out
// over `muon:gitnexusReindex`, which drives the user's OWN bundled
// `gitnexus analyze` locally — no network, no token, no hosted service.

type Phase = GitNexusIndexStatus["status"];
/** Kept in sync with the supervisor by construction (no parallel union). */
type Reason = NonNullable<GitNexusIndexStatus["reason"]>;

/**
 * The command an operator runs by hand when MUON cannot spawn the indexer for
 * them. Mirrors GITNEXUS_MANUAL_REINDEX_COMMAND in the supervisor; duplicated
 * (not imported) because the renderer must not pull in a main-process module.
 */
export const MANUAL_REINDEX_COMMAND =
  "npx gitnexus analyze . --index-only --force";

const PHASE_LABEL: Record<Phase, string> = {
  unknown: "unavailable",
  idle: "not indexed",
  indexing: "indexing…",
  ready: "ready",
  error: "error",
};

/** Bauhaus tone class per phase (drives the pill fill). */
const PHASE_TONE: Record<Phase, string> = {
  unknown: "gnx-tone-dim",
  idle: "gnx-tone-warn",
  indexing: "gnx-tone-busy",
  ready: "gnx-tone-ready",
  error: "gnx-tone-danger",
};

/**
 * "NOT INDEXED" alone made four different situations look identical — a user
 * could not tell whether to wait, open a repo, or report a bug. The supervisor
 * now says WHICH one; these are the labels/lines for each.
 */
const IDLE_DETAIL: Record<Reason, string> = {
  "no-repo": "no git repository here — nothing to index",
  "never-indexed": "no local graph yet — first index queued",
  queued: "queued behind the other repos",
  "rate-limited": "cooling down after the last attempt — will retry",
  "last-attempt-failed": "last attempt failed — will retry",
  "cli-missing": "GitNexus CLI not found — indexing unavailable",
};

/** Pill overrides where "not indexed" would be actively misleading. */
const IDLE_LABEL: Partial<Record<Reason, string>> = {
  "no-repo": "no git repo",
  "rate-limited": "retrying",
  queued: "queued",
};

/** How many member repos failed their last index. 0 for a single-repo workspace. */
function failedRepoCount(status: GitNexusIndexStatus): number {
  return (status.repos ?? []).filter((r) => r.status === "error").length;
}

/** How many member repos are indexed at an older commit than their HEAD. */
function staleRepoCount(status: GitNexusIndexStatus): number {
  return (status.repos ?? []).filter((r) => r.stale === true).length;
}

/**
 * Is the graph BEHIND the code? True for a single repo whose indexed commit is
 * not HEAD, and for a multi-repo workspace where any member is.
 */
function isStale(status: GitNexusIndexStatus): boolean {
  return status.stale === true || staleRepoCount(status) > 0;
}

function phaseLabel(status: GitNexusIndexStatus): string {
  if (status.status === "idle" && status.reason) {
    return IDLE_LABEL[status.reason] ?? PHASE_LABEL.idle;
  }
  if (status.status === "ready") {
    // A workspace where SOME repo failed to index is not "ready" — the graph
    // answers, but with holes the operator never agreed to. Say so in the pill;
    // a green READY over a failed index is the exact lie this column must not tell.
    if (failedRepoCount(status) > 0) return "partial";
    // Indexed, but at an older commit than HEAD. "ready" would claim the graph
    // matches the code, and every impact/review answer built on it would inherit
    // that claim.
    if (isStale(status)) return "stale";
  }
  return PHASE_LABEL[status.status];
}

function phaseTone(status: GitNexusIndexStatus): string {
  // Nothing to index is not a warning — it is simply nothing to do.
  if (status.status === "idle" && status.reason === "no-repo") {
    return "gnx-tone-dim";
  }
  // A degraded "ready" must not wear the ready fill.
  if (
    status.status === "ready" &&
    (failedRepoCount(status) > 0 || isStale(status))
  ) {
    return "gnx-tone-warn";
  }
  return PHASE_TONE[status.status];
}

function symbols(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  return `${n.toLocaleString()} symbol${n === 1 ? "" : "s"}`;
}

/**
 * The detail line under the pill: the most useful token-free fact for the phase
 * (symbol count when ready, the error note when failed, a hint otherwise).
 */
function detail(status: GitNexusIndexStatus): string {
  switch (status.status) {
    case "ready": {
      // Multi-repo (a monorepo of separate repos): show the REPO count, not a
      // summed symbol total — per-repo symbol counts belong on each graph tab,
      // not as one misleading aggregate "on top".
      const repos = status.repos ?? [];
      if (repos.length > 1) {
        const failed = failedRepoCount(status);
        const ready = repos.filter((r) => r.status === "ready").length;
        // A failed member is the most important fact here and used to be
        // invisible: the aggregate note carried it, and this line dropped it.
        if (failed > 0) {
          return `${ready} of ${repos.length} repos · ${failed} failed — retry now`;
        }
        const stale = staleRepoCount(status);
        return stale > 0
          ? `${repos.length} repos · ${stale} behind HEAD`
          : `${repos.length} repos`;
      }
      const count = symbols(status.symbolCount);
      if (isStale(status)) {
        // Name the actual condition (the graph is older than the code) instead
        // of promising a future event the operator cannot see or hurry.
        return count ? `${count} · behind HEAD` : "behind HEAD";
      }
      return count || "indexed";
    }
    case "indexing":
      // Real progress ONLY. The supervisor reports repo-level progress for a
      // multi-repo workspace ("Indexing 2/3 repos"); `analyze` itself reports
      // nothing per repo, so we say what is happening and invent no percentage.
      if (status.note) return status.note;
      return status.trigger === "manual"
        ? "rebuilding the local code graph"
        : "building local code graph";
    case "idle": {
      // A multi-repo workspace's own progress note ("1/3 repos indexed") is more
      // specific than the generic reason copy, so it wins when present.
      if (status.reason === "queued" && status.note) return status.note;
      if (status.reason) return IDLE_DETAIL[status.reason];
      return status.note ?? "will index this workspace";
    }
    case "error":
      // Name the failure AND point at the thing the operator can do about it.
      // This used to read "— will retry", which was true and useless: the retry
      // sits behind a five-minute cooldown with nothing to click meanwhile.
      return status.note ? `${status.note} — retry now` : "indexing failed — retry now";
    case "unknown":
    default:
      return status.note ?? "GitNexus CLI not found";
  }
}

/** The re-index button's state, derived from the same one status value. */
export type ReindexAffordance = {
  /** Hidden only when there is genuinely nothing here to index. */
  visible: boolean;
  enabled: boolean;
  label: string;
  title: string;
};

export function reindexAffordance(
  status: GitNexusIndexStatus
): ReindexAffordance {
  const failed = status.status === "error";
  const label = failed ? "Retry index" : "Re-index";
  if (status.reason === "no-repo") {
    return {
      visible: false,
      enabled: false,
      label,
      title: "No git repository here to index",
    };
  }
  if (status.reason === "cli-missing") {
    // Honest dead end: MUON cannot drive the indexer, so it hands over the
    // exact command instead of offering a button that would do nothing.
    return {
      visible: true,
      enabled: false,
      label,
      title: `GitNexus CLI not found — run \`${MANUAL_REINDEX_COMMAND}\` in the repository yourself`,
    };
  }
  if (status.status === "indexing") {
    return {
      visible: true,
      enabled: false,
      label,
      title: "An index run is already in progress",
    };
  }
  return {
    visible: true,
    enabled: true,
    label,
    title: failed
      ? "Run the indexer again from scratch to recover the code graph"
      : "Re-index this workspace's code graph from the current commit",
  };
}

export function GitNexusColumn(props: {
  status: GitNexusIndexStatus | null | undefined;
  onOpenGraph: () => void;
  /**
   * Ask main to re-index. Defaults to the preload bridge so the button works
   * without threading a handler through the whole app tree; injectable for tests.
   */
  onReindex?: () => Promise<GitNexusReindexResult>;
}) {
  const status: GitNexusIndexStatus = props.status ?? { status: "unknown" };
  const phase = status.status;
  const canOpenGraph = phase === "ready";
  const detailLine = detail(status);
  const openGraphTitle = canOpenGraph
    ? "Open the full knowledge graph GitNexus parsed for this workspace"
    : phase === "indexing"
      ? "The graph opens once indexing finishes"
      : `No graph to open yet — ${detailLine}`;

  const reindex = reindexAffordance(status);
  const { onReindex } = props;
  /** The last answer main gave us. A refusal is shown, never swallowed. */
  const [outcome, setOutcome] = useState<GitNexusReindexResult | null>(null);
  /** In flight between the click and main's answer — bounds double-clicks. */
  const [requesting, setRequesting] = useState(false);

  // Once the index really starts, the pill tells the story better than our
  // "requested" line does. A REFUSAL stays up: nothing else will report it.
  useEffect(() => {
    if (phase === "indexing" && outcome?.accepted) setOutcome(null);
  }, [phase, outcome]);

  const requestReindex = useCallback(() => {
    if (requesting) return; // client-side half of the no-double-run guard
    setRequesting(true);
    const call = onReindex ?? (() => window.muon.gitnexusReindex());
    void Promise.resolve()
      .then(call)
      .then((result) => setOutcome(result))
      .catch((error: unknown) =>
        setOutcome({
          accepted: false,
          reason: "stopped",
          note:
            error instanceof Error
              ? `Could not start indexing: ${error.message}`
              : "Could not start indexing.",
        })
      )
      .finally(() => setRequesting(false));
  }, [onReindex, requesting]);

  return (
    <div
      className="gitnexus-column"
      aria-label="GitNexus code-graph status"
      role="group"
    >
      <div className="gnx-readout">
        <span className="gnx-title">GitNexus</span>
        <span
          className={"gnx-pill " + phaseTone(status)}
          aria-live="polite"
        >
          {phaseLabel(status)}
        </span>
        <span className="gnx-detail" title={detailLine}>
          {detailLine}
        </span>
        {outcome ? (
          <span
            className={
              "gnx-reindex-note" + (outcome.accepted ? "" : " gnx-refused")
            }
            role="status"
            title={outcome.note}
          >
            {outcome.note}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className="gnx-graph-button"
        onClick={props.onOpenGraph}
        disabled={!canOpenGraph}
        aria-disabled={!canOpenGraph}
        title={openGraphTitle}
      >
        Open Graph
      </button>
      {reindex.visible ? (
        <button
          type="button"
          className={
            "gnx-reindex-button" + (phase === "error" ? " gnx-urgent" : "")
          }
          onClick={requestReindex}
          disabled={!reindex.enabled || requesting}
          aria-disabled={!reindex.enabled || requesting}
          title={reindex.title}
        >
          {reindex.label}
        </button>
      ) : null}
    </div>
  );
}
