import { useState, type ReactNode } from "react";
import type { GitHubPullRequestAction, GitHubReview } from "@muon/client";
import type { WorkspaceReview } from "../shared/ipc.js";
import {
  FileChangeBadge,
  FileTree,
  type WorkspaceFileStat,
} from "./file-tree.js";

export type RightPanelTab = "files" | "changes" | "review";

const TABS: Array<{ id: RightPanelTab; label: string }> = [
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
  { id: "review", label: "Review" },
];

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function workspaceBasename(path: string | null | undefined): string {
  if (!path) {
    return "No workspace";
  }
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) ?? "Workspace";
}

function WorkspaceReviewState(props: {
  loading: boolean;
  review: WorkspaceReview | null;
  children: (review: Extract<WorkspaceReview, { status: "available" }>) => ReactNode;
}) {
  if (props.loading) {
    return <p className="right-panel-empty loading-line">Reading workspace…</p>;
  }
  if (!props.review) {
    return (
      <p className="right-panel-empty">
        No workspace review is bound to the active mission.
      </p>
    );
  }
  if (props.review.status === "degraded") {
    return (
      <div className="right-panel-callout degraded">
        <strong>Workspace evidence unavailable</strong>
        <p>{props.review.reason}</p>
        <p>{props.review.action}</p>
      </div>
    );
  }
  return <>{props.children(props.review)}</>;
}

function ChangedFileList(props: {
  files: ReadonlyArray<string>;
  fileStats: ReadonlyArray<WorkspaceFileStat>;
}) {
  const statByPath = new Map(props.fileStats.map((stat) => [stat.path, stat]));
  return (
    <ul className="session-change-files right-panel-change-files">
      {props.files.map((file) => (
        <li key={file}>
          <code title={file}>{file}</code>
          <FileChangeBadge stat={statByPath.get(file)} />
        </li>
      ))}
    </ul>
  );
}

function FilesPanel(props: {
  loading: boolean;
  review: WorkspaceReview | null;
}) {
  return (
    <div className="right-panel-scroll">
      <WorkspaceReviewState loading={props.loading} review={props.review}>
        {(review) => (
          <FileTree files={review.files} fileStats={review.fileStats} />
        )}
      </WorkspaceReviewState>
    </div>
  );
}

// ─── LAND THE CHILD'S WORK, FROM THE SEAT THAT REVIEWED IT ───────────────────
//
// The diff and the land action used to live on opposite sides of the app: this
// panel rendered a governed child's worktree diff with no way to act on it, and
// the approval dialog that performs the merge showed a certification digest with
// no diff. A desktop-only operator therefore depended on the AGENT choosing to
// call MCP `ship`; when it didn't, real work sat in `.muon/worktrees/<taskId>`
// and never reached the primary checkout.
//
// This section closes that, without inventing a path:
//   * it files the SAME governed `kind:"merge"` approval the CLI's `muon ship`
//     and the TUI's "Ship review" file (`{taskId, requestedBy, kind, reason}`),
//     so all four surfaces produce one shape;
//   * it never bypasses the gate — with gates on the operator still decides in
//     the approval dialog; under Full Auto the standing consent decides it, the
//     same as everywhere else;
//   * it reports what actually happened. "Approved" after a merge is not an
//     outcome, `landed as <sha>` is; and a refusal renders the refusal's own
//     words rather than a generic failure.
//
// Everything below is a pure function of facts the parent already holds, so
// each "you cannot land this" case is one testable sentence rather than a
// disabled button with no explanation.

/** Working-tree resolution for the shown job (`resolveJobTree`, lib/job-tree). */
export type ShipTree =
  | { status: "resolved"; kind: "worktree" | "workspace"; path: string }
  | { status: "unresolved"; reason: string; action: string };

/** Everything the panel needs to decide whether this job's work can be landed. */
export type ShipTarget = {
  /** The dispatch whose tree the Changes tab is currently showing. */
  jobId: string;
  /** Task the merge gate is filed against; null when the dispatch records none. */
  taskId: string | null;
  /** Lane that produced the work — becomes `requestedBy`, as `muon ship --lane`. */
  laneKey: string | null;
  /** Dispatch status. Only a terminal dispatch may land. */
  status: string;
  tree: ShipTree;
  /**
   * The fail-closed ship gate's verdict for this change
   * (`renderer/lib/ship-gate.ts`), or `null` when the gate is satisfied.
   * `undefined` = not evaluated here; the gate is still enforced at approval.
   */
  gateBlockReason?: string | null;
  /** True when Full Auto's standing consent will decide this merge gate. */
  fullAuto?: boolean;
};

/**
 * The governed payload. Byte-for-byte the shape `apps/cli/src/commands/ship.ts`
 * and `apps/tui/src/lib/ship.ts` send to `POST /api/approvals` — `jobId` rides
 * along only so main can authorize the renderer against the owning chat.
 */
export type ShipRequest = {
  jobId: string;
  taskId: string;
  requestedBy: string;
  kind: "merge";
  reason: string;
};

/** `WorktreeMergeResult` as it crosses the bridge (packages/core/src/worktree.ts). */
export type ShipMergeOutcome =
  | {
      status: "merged";
      sha: string;
      message?: string;
      changedFiles?: number;
      mergeCommit?: string;
      recovered?: boolean;
    }
  | { status: "no-op"; reason: string }
  | { status: "conflict"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string };

export type ShipOutcome = {
  approvalId: string;
  /**
   * True while the filed gate still awaits a human decision (gates on). The
   * panel must never call this "landed".
   */
  pending: boolean;
  /** Present only when the gate was also DECIDED in the same call (Full Auto). */
  merge?: ShipMergeOutcome;
};

export type ShipPanelProps = {
  /** Null when no dispatch is selected; the section then says so. */
  target: ShipTarget | null;
  onShip: (request: ShipRequest) => Promise<ShipOutcome>;
  /**
   * A LATER, more authoritative outcome for this job's gate than the one
   * `onShip` resolved with.
   *
   * Under Full Auto the standing consent decides the gate after the file call
   * has already returned `pending`, so without this the panel would be stuck on
   * "nothing has landed yet" for a merge that in fact landed. The parent passes
   * the decided outcome (from the approvals monitor) and it wins.
   */
  outcome?: ShipOutcome | null;
};

/** Dispatch statuses where the run is over — same set `muon ship` waits for. */
const TERMINAL_DISPATCH_STATUSES = new Set(["done", "failed", "interrupted"]);

export type ShipReadiness =
  | { can: true; request: ShipRequest; note: string }
  | {
      can: false;
      sentence: string;
      action?: string;
      /** The block is transient — evidence is still arriving, not missing. */
      awaiting?: boolean;
    };

const REASON_MAX = 300;

function treeNoun(kind: "worktree" | "workspace"): string {
  return kind === "worktree" ? "the task worktree" : "the workspace";
}

/**
 * Can this job's work be landed right now, and if not, exactly why not.
 *
 * Ordered most-fundamental first, so the operator is told the thing they can
 * actually act on: a tree that cannot be located is a different problem from a
 * tree that is simply empty, and neither is a stale review gate.
 */
export function shipReadiness(input: {
  target: ShipTarget | null | undefined;
  review: WorkspaceReview | null;
  loading: boolean;
}): ShipReadiness {
  const { target, review } = input;
  if (!target) {
    return {
      can: false,
      sentence: "No dispatch is selected, so there is no child's work to land.",
      action: "Open a dispatch from the mission to review and land its tree.",
    };
  }
  if (target.tree.status === "unresolved") {
    return {
      can: false,
      sentence: target.tree.reason,
      action: target.tree.action,
    };
  }
  if (target.tree.kind === "workspace") {
    return {
      can: false,
      sentence: `This dispatch ran directly in the primary checkout, not an isolated worktree, so there is no child tree to merge — its changes are already in ${target.tree.path}.`,
      action:
        "Review and commit them in place; landing applies only to work done in a task worktree.",
    };
  }
  if (!target.taskId) {
    return {
      can: false,
      sentence:
        "This dispatch records no task, so a merge gate cannot be filed against it.",
      action:
        "Re-dispatch the work bound to a task so its landing can be governed.",
    };
  }
  if (!target.laneKey) {
    return {
      can: false,
      sentence:
        "This dispatch records no lane, so the merge gate would have no author to attribute it to.",
      action: "Re-dispatch the work from a lane, then land it from here.",
    };
  }
  if (!TERMINAL_DISPATCH_STATUSES.has(target.status)) {
    return {
      can: false,
      sentence: `This dispatch is still ${target.status}, so its work is not finished and cannot be landed yet.`,
      action:
        "Landing unlocks once the run reaches done, failed, or interrupted.",
    };
  }
  if (input.loading) {
    return {
      can: false,
      awaiting: true,
      sentence: "Reading the tree — landing unlocks once the diff is known.",
    };
  }
  if (!review) {
    return {
      can: false,
      sentence:
        "No workspace review is bound to this dispatch, so what would land is unknown.",
      action: "MUON will not file a merge gate over an unread tree.",
    };
  }
  if (review.status === "degraded") {
    // No `action` here on purpose: the degraded callout directly below already
    // carries `review.action`, and repeating it reads as two separate problems.
    return {
      can: false,
      sentence: `The tree could not be read, so what would land is unknown: ${review.reason}`,
    };
  }
  if (review.files.length === 0) {
    return {
      can: false,
      sentence:
        "This dispatch's worktree has no changes against HEAD, so there is nothing to land.",
      action: `If you expected changes, confirm the agent wrote into ${target.tree.path}.`,
    };
  }
  if (typeof target.gateBlockReason === "string") {
    return { can: false, sentence: target.gateBlockReason };
  }

  const totals = review.fileStats.reduce(
    (summary, stat) => ({
      additions: summary.additions + stat.additions,
      deletions: summary.deletions + stat.deletions,
    }),
    { additions: 0, deletions: 0 }
  );
  // The reason is the audit record's own words, so it must not claim more than
  // was done. `muon ship` says "ship review passed" because it RAN the checks;
  // the desktop ran none, and says so.
  const reason = (
    `ship requested from MUON desktop: ${plural(review.files.length, "file")} changed ` +
    `(+${totals.additions}/−${totals.deletions}) in ${treeNoun(target.tree.kind)} ` +
    `${target.tree.path}; operator reviewed the diff, no automated checks were run.`
  ).slice(0, REASON_MAX);

  return {
    can: true,
    request: {
      jobId: target.jobId,
      taskId: target.taskId,
      requestedBy: target.laneKey,
      kind: "merge",
      reason,
    },
    note: target.fullAuto
      ? "Full Auto holds the standing consent for this gate, so the merge is decided without another prompt."
      : "Filing opens the governed merge gate. Nothing lands until you approve it in Review.",
  };
}

function ShipMergeOutcomeLine(props: { merge: ShipMergeOutcome }) {
  const { merge } = props;
  if (merge.status === "merged") {
    return (
      <>
        <p className="settings-saved">
          Landed as <code title={merge.sha}>{merge.sha.slice(0, 7)}</code>
          {typeof merge.changedFiles === "number"
            ? ` · ${plural(merge.changedFiles, "file")}`
            : ""}
          .
        </p>
        {merge.mergeCommit ? (
          <p className="right-panel-bound">
            Merge commit <code title={merge.mergeCommit}>
              {merge.mergeCommit.slice(0, 7)}
            </code>
            {merge.recovered
              ? " · recovered a merge that had already been written."
              : "."}
          </p>
        ) : null}
      </>
    );
  }
  if (merge.status === "no-op") {
    return (
      <div className="right-panel-callout">
        <strong>Nothing was landed</strong>
        <p>{merge.reason}</p>
      </div>
    );
  }
  const heading =
    merge.status === "conflict"
      ? "Merge conflicted — nothing was landed"
      : merge.status === "blocked"
        ? "Merge refused — nothing was landed"
        : "Merge failed — nothing was landed";
  return (
    <div className="right-panel-callout">
      <strong>{heading}</strong>
      <p>{merge.reason}</p>
    </div>
  );
}

function ShipSection(props: {
  ship: ShipPanelProps;
  review: WorkspaceReview | null;
  loading: boolean;
}) {
  const [shipping, setShipping] = useState(false);
  const [filed, setFiled] = useState<ShipOutcome | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The parent's outcome is the LATER fact (Full Auto decided the gate after
  // the file call returned), so it wins over what `onShip` resolved with.
  const outcome = props.ship.outcome ?? filed;
  const readiness = shipReadiness({
    target: props.ship.target,
    review: props.review,
    loading: props.loading,
  });

  const run = async (request: ShipRequest) => {
    setShipping(true);
    setRefusal(null);
    setFiled(null);
    try {
      setFiled(await props.ship.onShip(request));
    } catch (error) {
      // The backend refuses a merge it cannot execute with a 409 carrying the
      // reason ("Merge not executed (conflict): …"). Surface those words, never
      // a generic failure — the operator has to know WHICH thing stopped it.
      setRefusal(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The merge gate was refused, and no reason was returned."
      );
    } finally {
      setShipping(false);
    }
  };

  return (
    <section className="right-panel-section ship-section">
      <header>
        <strong>Land this work</strong>
        <span>governed merge</span>
      </header>
      {/* Once a gate exists the button is GONE, not disabled: re-pressing it
          would file a second merge gate for the same task. A refusal leaves
          `outcome` null, so a genuine retry still has its button. */}
      {readiness.can && outcome === null ? (
        <>
          <button
            type="button"
            className="settings-save"
            disabled={shipping}
            onClick={() => void run(readiness.request)}
          >
            {shipping ? "Filing the merge gate…" : "Land this work"}
          </button>
          <p className="right-panel-bound">{readiness.note}</p>
        </>
      ) : readiness.can ? null : (
        <>
          <p
            className={
              readiness.awaiting
                ? "right-panel-empty loading-line"
                : "right-panel-empty"
            }
          >
            {readiness.sentence}
          </p>
          {readiness.action ? (
            <p className="right-panel-empty">{readiness.action}</p>
          ) : null}
        </>
      )}
      <div aria-live="polite" className="ship-outcome">
        {refusal ? (
          <div className="right-panel-callout">
            <strong>Not landed</strong>
            <p>{refusal}</p>
          </div>
        ) : outcome ? (
          outcome.merge ? (
            <ShipMergeOutcomeLine merge={outcome.merge} />
          ) : outcome.pending ? (
            <p className="right-panel-bound">
              Merge gate <code>{outcome.approvalId}</code> filed. Nothing has
              landed yet — decide it in Review.
            </p>
          ) : (
            // Decided, but the brain returned no merge outcome. Say exactly
            // that; a silent "approved" here is the dishonesty this replaces.
            <div className="right-panel-callout">
              <strong>Decided, but the merge result is unknown</strong>
              <p>
                Gate <code>{outcome.approvalId}</code> was decided and the brain
                reported no merge outcome. Check the branch before assuming this
                work landed.
              </p>
            </div>
          )
        ) : null}
      </div>
    </section>
  );
}

function ChangesPanel(props: {
  loading: boolean;
  review: WorkspaceReview | null;
  ship?: ShipPanelProps;
}) {
  return (
    <div className="right-panel-scroll">
      {props.ship ? (
        <ShipSection
          ship={props.ship}
          review={props.review}
          loading={props.loading}
        />
      ) : null}
      <WorkspaceReviewState loading={props.loading} review={props.review}>
        {(review) => {
          const totals = review.fileStats.reduce(
            (summary, stat) => ({
              additions: summary.additions + stat.additions,
              deletions: summary.deletions + stat.deletions,
            }),
            { additions: 0, deletions: 0 }
          );
          return (
            <>
              <section className="right-panel-section">
                <header>
                  <strong>Combined working tree</strong>
                  <span>{plural(review.files.length, "file")}</span>
                </header>
                <p className="changes-honesty">
                  Line totals and the bounded diff are combined against HEAD;
                  file membership below comes from the same workspace review.
                </p>
                <span className="numstat right-panel-totals">
                  <span className="numstat-add">+{totals.additions}</span>
                  <span className="numstat-del">−{totals.deletions}</span>
                </span>
              </section>

              <section className="right-panel-section">
                <header>
                  <strong>Staged</strong>
                  <span>{plural(review.stagedFiles.length, "file")}</span>
                </header>
                {review.stagedFiles.length > 0 ? (
                  <ChangedFileList
                    files={review.stagedFiles}
                    fileStats={review.fileStats}
                  />
                ) : (
                  <p className="right-panel-empty">
                    No staged changes.
                  </p>
                )}
              </section>

              <section className="right-panel-section">
                <header>
                  <strong>Unstaged</strong>
                  <span>{plural(review.unstagedFiles.length, "file")}</span>
                </header>
                {review.unstagedFiles.length > 0 ? (
                  <ChangedFileList
                    files={review.unstagedFiles}
                    fileStats={review.fileStats}
                  />
                ) : (
                  <p className="right-panel-empty">
                    No unstaged or untracked changes.
                  </p>
                )}
              </section>

              <section className="right-panel-section">
                <header>
                  <strong>Diff stat</strong>
                </header>
                <pre className="right-panel-stat">
                  {review.stat || "No changed-line summary."}
                </pre>
              </section>

              <section className="right-panel-section">
                <header>
                  <strong>Bounded diff</strong>
                </header>
                <pre className="session-diff">
                  {review.diffText || "No diff."}
                </pre>
                <p className="right-panel-bound">
                  {review.truncated
                    ? `Truncated at ${review.maxBytes.toLocaleString()} bytes from ${review.totalBytes.toLocaleString()} total bytes.`
                    : `${review.totalBytes.toLocaleString()} bytes · complete within the review bound.`}
                </p>
              </section>
            </>
          );
        }}
      </WorkspaceReviewState>
    </div>
  );
}

export function GitHubReviewCard(props: {
  connected?: boolean;
  loading?: boolean;
  review?: GitHubReview | null;
  onRefresh?: () => void;
  onOpen?: (url: string) => void;
  onCreate?: () => Promise<GitHubPullRequestAction>;
  onMerge?: (input: {
    pullNumber: number;
    expectedHeadSha: string;
  }) => Promise<GitHubPullRequestAction>;
}) {
  const [publishing, setPublishing] = useState<"create" | "merge" | null>(null);
  const [publishResult, setPublishResult] =
    useState<GitHubPullRequestAction | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  const publish = async (
    kind: "create" | "merge",
    action: () => Promise<GitHubPullRequestAction>
  ) => {
    setPublishing(kind);
    setPublishError(null);
    try {
      setPublishResult(await action());
    } catch (error) {
      setPublishError(
        error instanceof Error && error.message.trim()
          ? error.message
          : "GitHub refused the publish action."
      );
    } finally {
      setPublishing(null);
    }
  };

  const publishStatus = publishError ? (
    <p className="github-publish-error" role="alert">{publishError}</p>
  ) : publishResult ? (
    <p className="settings-saved" role="status">
      {publishResult.operation === "merged"
        ? `Pull request #${publishResult.pullNumber} merged${
            publishResult.sha ? ` as ${publishResult.sha.slice(0, 7)}` : ""
          }.`
        : publishResult.operation === "created"
          ? `Pull request #${publishResult.review.pullRequest.number} created.`
          : `Pull request #${publishResult.review.pullRequest.number} already existed.`}
    </p>
  ) : null;

  if (
    props.connected === undefined &&
    props.loading === undefined &&
    props.review === undefined
  ) {
    return null;
  }
  if (!props.connected) {
    return (
      <section className="github-review-card disconnected">
        <strong>Pull request</strong>
        <p>Connect GitHub in Setup to load the branch PR and checks.</p>
      </section>
    );
  }
  if (props.loading) {
    return (
      <section className="github-review-card">
        <strong>Pull request</strong>
        <p className="loading-line">Loading PR checks…</p>
      </section>
    );
  }
  if (!props.review) {
    return (
      <section className="github-review-card">
        <strong>Pull request</strong>
        <p>No PR evidence loaded.</p>
        <button className="ghost-btn" onClick={props.onRefresh}>
          Refresh
        </button>
      </section>
    );
  }
  if (props.review.status === "degraded") {
    return (
      <section className="github-review-card degraded">
        <strong>Pull request unavailable</strong>
        <p>{props.review.reason}</p>
        {props.review.action ? <p>{props.review.action}</p> : null}
        <button className="ghost-btn" onClick={props.onRefresh}>
          Retry
        </button>
      </section>
    );
  }
  if (props.review.status === "no_pull_request") {
    return (
      <section className="github-review-card">
        <header>
          <strong>Pull request</strong>
          <span>{props.review.repository.owner}/{props.review.repository.repo}</span>
        </header>
        <p>No open PR found for <code>{props.review.branch}</code>.</p>
        <div className="github-publish-actions">
          {props.onCreate ? (
            <button
              className="settings-save"
              disabled={publishing !== null}
              onClick={() => void publish("create", props.onCreate!)}
            >
              {publishing === "create" ? "Creating PR…" : "Create PR"}
            </button>
          ) : null}
          <button className="ghost-btn" onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
        <small>
          The backend requires this dispatch's durable governed merge before it
          will publish remotely.
        </small>
        {publishStatus}
      </section>
    );
  }

  const { pullRequest, checks } = props.review;
  const checksReady =
    !checks.unavailable && ["success", "none"].includes(checks.state);
  const mergeReady = checksReady && !pullRequest.draft;
  return (
    <section className={`github-review-card ${checks.state}`}>
      <header>
        <div>
          <span>Pull request #{pullRequest.number}</span>
          <strong>{pullRequest.title}</strong>
        </div>
        <div className="github-publish-actions">
          <button
            className="ghost-btn"
            onClick={() => props.onOpen?.(pullRequest.url)}
          >
            Open PR
          </button>
          {props.onMerge && publishResult?.operation !== "merged" ? (
            <button
              className="settings-save"
              disabled={!mergeReady || publishing !== null}
              title={
                pullRequest.draft
                  ? "Mark this pull request ready for review first."
                  : checksReady
                    ? undefined
                    : "Checks must be green before MUON will merge."
              }
              onClick={() =>
                void publish("merge", () =>
                  props.onMerge!({
                    pullNumber: pullRequest.number,
                    expectedHeadSha: pullRequest.headSha,
                  })
                )
              }
            >
              {publishing === "merge" ? "Merging…" : "Merge PR"}
            </button>
          ) : null}
        </div>
      </header>
      <div className="github-check-summary">
        <span className={`github-check-state ${checks.state}`}>
          {checks.unavailable
            ? "Checks unavailable"
            : checks.state === "none"
              ? "No checks"
              : `${checks.state} · ${checks.total}`}
        </span>
        {checks.total > 0 ? (
          <small>
            {checks.passed} passed · {checks.pending} pending · {checks.failed} failed
          </small>
        ) : null}
      </div>
      {checks.items.length > 0 ? (
        <ul className="github-check-list">
          {checks.items.slice(0, 8).map((check, index) => (
            <li key={`${check.source}:${check.name}:${index}`}>
              <span className={`dot ${check.state}`} />
              <span title={check.name}>{check.name}</span>
              <small>{check.conclusion ?? check.status}</small>
            </li>
          ))}
        </ul>
      ) : null}
      <button className="ghost-btn github-review-refresh" onClick={props.onRefresh}>
        Refresh checks
      </button>
      {!mergeReady && props.onMerge ? (
        <p className="right-panel-bound">
          {pullRequest.draft
            ? "Mark the draft ready before merging."
            : "Merge unlocks when checks are green; unavailable checks fail closed."}
        </p>
      ) : null}
      {publishStatus}
    </section>
  );
}

export function RightPanel(props: {
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  workspacePath: string | null;
  workspaceReview: WorkspaceReview | null;
  loading?: boolean;
  /**
   * Governed landing for the job whose tree the Changes tab is showing. Omit
   * and the Changes tab renders exactly as before — a review surface with no
   * action, never a dead button.
   */
  ship?: ShipPanelProps;
  reviewContent: ReactNode;
  reviewLocked?: boolean;
  githubConnected?: boolean;
  /** Dispatch identity; remounts action state when Review switches jobs. */
  githubPublicationKey?: string;
  githubReview?: GitHubReview | null;
  githubReviewLoading?: boolean;
  onRefreshGitHubReview?: () => void;
  onOpenGitHubUrl?: (url: string) => void;
  onCreateGitHubPullRequest?: () => Promise<GitHubPullRequestAction>;
  onMergeGitHubPullRequest?: (input: {
    pullNumber: number;
    expectedHeadSha: string;
  }) => Promise<GitHubPullRequestAction>;
}) {
  const panelId = `right-panel-${props.activeTab}`;
  const branch =
    props.workspaceReview?.status === "available"
      ? props.workspaceReview.branch
      : workspaceBasename(props.workspacePath);
  return (
    <section className="right-panel" aria-label="Workspace files and review">
      <header className="right-panel-header">
        <div
          className="right-panel-tabs"
          role="tablist"
          aria-label="Workspace review"
        >
          {TABS.map((tab) => {
            const active = props.activeTab === tab.id;
            const disabled = Boolean(
              props.reviewLocked && tab.id !== "review"
            );
            return (
              <button
                key={tab.id}
                id={`right-panel-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-controls={`right-panel-${tab.id}`}
                aria-selected={active}
                className="right-panel-tab"
                disabled={disabled}
                title={
                  disabled
                    ? "Close the focused approval review before switching tabs."
                    : undefined
                }
                onClick={() => props.onTabChange(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <div
          className="right-panel-coordinate"
          title={props.workspacePath ?? undefined}
        >
          <span>Branch</span>
          <strong>{branch}</strong>
        </div>
      </header>

      <div
        key={panelId}
        id={panelId}
        className={`right-panel-body ${panelId}`}
        role="tabpanel"
        aria-labelledby={`right-panel-tab-${props.activeTab}`}
        tabIndex={0}
      >
        {props.activeTab === "files" ? (
          <FilesPanel
            loading={Boolean(props.loading)}
            review={props.workspaceReview}
          />
        ) : props.activeTab === "changes" ? (
          <ChangesPanel
            loading={Boolean(props.loading)}
            review={props.workspaceReview}
            ship={props.ship}
          />
        ) : (
          <div className="right-panel-review">
            <GitHubReviewCard
              key={props.githubPublicationKey}
              connected={props.githubConnected}
              loading={props.githubReviewLoading}
              review={props.githubReview}
              onRefresh={props.onRefreshGitHubReview}
              onOpen={props.onOpenGitHubUrl}
              onCreate={props.onCreateGitHubPullRequest}
              onMerge={props.onMergeGitHubPullRequest}
            />
            {props.reviewContent}
          </div>
        )}
      </div>
    </section>
  );
}
