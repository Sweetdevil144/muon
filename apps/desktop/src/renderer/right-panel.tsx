import {
  ForkMissionSection,
  type ForkMissionProps,
} from "./fork-mission-section.js";
import { useEffect, useState, type ReactNode } from "react";
import type {
  ApprovalRequest,
  GitHubPullRequestAction,
  GitHubReview,
  ReviewCoverageCertification,
} from "@muon/client";
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
      /**
       * H2 — the block is on the EVIDENCE, not on the shape of the target.
       *
       * Every other refusal here means there is nothing to land (no tree, no
       * task, still running), so no button belongs on screen. This one means
       * there IS landable work and MUON is refusing it, which is a different
       * sentence: the control stays visible and DISABLED, so the operator sees
       * the thing they came for being withheld and reads why, instead of
       * hunting for a button that silently vanished.
       */
      gated?: boolean;
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
    return { can: false, gated: true, sentence: target.gateBlockReason };
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
          {/* H2: an evidence block keeps the control on screen, disabled, so
              the refusal is attached to the thing being refused. */}
          {readiness.gated ? (
            <button
              type="button"
              className="settings-save"
              disabled
              title={readiness.sentence}
            >
              Land this work
            </button>
          ) : null}
          <p
            className={
              readiness.gated
                ? "right-panel-callout degraded ship-gate-block"
                : readiness.awaiting
                  ? "right-panel-empty loading-line"
                  : "right-panel-empty"
            }
            role={readiness.gated ? "alert" : undefined}
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

// ─── DECIDE THE GATE WHERE THE DIFF IS (ROADMAP H3) ─────────────────────────
//
// Filing the merge gate already lives here ("Land this work", above). Deciding
// it did not: the operator had to leave the diff, find the approval card in the
// Control rail, and open a modal — on the same screen where they had just read
// every changed line. So a certified merge sat pending because the decision
// surface was somewhere else.
//
// This section moves UI OWNERSHIP, not authority. It loads the certification
// through the SAME `reviewApproval` leg the dialog uses, and decides through
// the SAME `onResolveApproval` every other surface calls — which still runs the
// fail-closed desktop ship gate before it sends, and whose PATCH the backend
// still re-derives certification for. Nothing here can approve a merge the
// dialog would have refused.
//
// ONE THING STAYS MODAL ON PURPOSE: the REVIEW BLIND manual attestation. That
// flow makes the human personally assert they read files the graph could not
// see, and a second implementation of it is a second place for that assertion
// to drift. The dock shows the block and routes to the dialog that owns it.

export type DockMergeProps = {
  /**
   * The PENDING `kind:"merge"` approval bound to the task whose tree is shown,
   * or null when this task has no open merge gate (the section then renders
   * nothing — "Land this work" above is the affordance at that point).
   */
  approval: ApprovalRequest | null;
  /**
   * The same certification read the modal performs. `undefined` = a preload
   * older than the review surface; the section then says exactly that and
   * offers no approval, matching the dialog rather than failing open.
   */
  loadCertification?: (
    approvalId: string
  ) => Promise<ReviewCoverageCertification>;
  /** The ONE governed decision path, shared with the rail, dialog and TUI. */
  onResolve: (
    approvalId: string,
    status: "approved" | "rejected"
  ) => void | Promise<void>;
  /** Opens the existing ApprovalReviewDialog — the only attestation surface. */
  onOpenEvidence: (approvalId: string) => void;
  /** Standing consent is deciding this gate: evidence only, no click site. */
  autoApproving?: boolean;
};

function MergeSection(props: { merge: DockMergeProps }) {
  const approval = props.merge.approval;
  const approvalId = approval?.id ?? null;
  const load = props.merge.loadCertification;
  const [certification, setCertification] =
    useState<ReviewCoverageCertification | null>(null);
  const [loading, setLoading] = useState(Boolean(approvalId && load));
  const [loadError, setLoadError] = useState<string | null>(
    approvalId && !load
      ? "Merge review is unavailable. Restart MUON and retry; if it persists, update the app before approving."
      : null
  );
  const [reload, setReload] = useState(0);
  const [deciding, setDeciding] = useState<"approved" | "rejected" | null>(
    null
  );
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    if (!approvalId || !load) return;
    let active = true;
    setLoading(true);
    setLoadError(null);
    void load(approvalId)
      .then((result) => {
        if (active) setCertification(result);
      })
      .catch((error) => {
        if (!active) return;
        // A certification that could not be READ is not a certification that
        // passed. No Approve is offered on this path.
        setLoadError(
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Could not load merge review evidence."
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [approvalId, load, reload]);

  if (!approval || !approvalId) return null;

  const reviewBlind =
    certification?.status === "blocked" &&
    certification.blockCode === "review-blind";
  // Fail closed on every unknown: only a POSITIVE `certified` earns Approve.
  const approvable =
    !loading && loadError === null && certification?.status === "certified";
  const blockSentence = loading
    ? "Checking this exact worktree against GitNexus before a merge can be approved."
    : (loadError ??
      (reviewBlind
        ? "REVIEW BLIND: changed files are unindexed or the index is stale, so 0 affected flows is not a pass. Review every blind file and attest in the evidence dialog."
        : certification?.status === "blocked"
          ? certification.reason
          : certification
            ? null
            : "Merge review evidence is not available yet."));

  const decide = (status: "approved" | "rejected") => {
    if (deciding) return;
    setDeciding(status);
    setRefusal(null);
    void (async () => {
      try {
        await props.merge.onResolve(approvalId, status);
      } catch (error) {
        // The desktop ship gate's own refusal sentence arrives here (app.tsx
        // throws `mergeShipBlockReason`), as does a server-side refusal. Both
        // are the operator's words for WHY, and both belong on this screen
        // rather than in a console.
        setRefusal(
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The decision was refused, and no reason was returned."
        );
      } finally {
        setDeciding(null);
      }
    })();
  };

  return (
    <section className="right-panel-section merge-section">
      <header>
        <strong>Decide the merge gate</strong>
        <span>operator decision</span>
      </header>
      <p className="right-panel-bound">{approval.reason}</p>
      <p className="right-panel-bound">
        Filed by {approval.requestedBy} · gate <code>{approvalId}</code>
      </p>

      <div className="merge-certification" aria-live="polite">
        {loading ? (
          <p className="right-panel-empty loading-line">{blockSentence}</p>
        ) : certification?.status === "certified" ? (
          <p className="settings-saved">
            Certified · {certification.verdict} ·{" "}
            {plural(certification.changedFiles.length, "changed file")} covered
            by the graph.
          </p>
        ) : blockSentence ? (
          <div className="right-panel-callout degraded">
            <strong>Not certified — approval is withheld</strong>
            <p>{blockSentence}</p>
            {certification?.status === "blocked" &&
            (certification.blindFiles?.length ?? 0) > 0 ? (
              <p className="right-panel-bound">
                {plural(certification.blindFiles!.length, "blind file")}, e.g.{" "}
                <code>{certification.blindFiles![0]}</code>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {props.merge.autoApproving ? (
        // Standing consent already owns this gate through the governed path. A
        // second click site here would be a second consent path, which is
        // exactly what this codebase must not grow.
        <p className="right-panel-bound">
          Full Auto is granting this gate as you, and recording it. Nothing to
          decide here.
        </p>
      ) : (
        <div className="merge-actions">
          {approvable ? (
            <button
              type="button"
              className="settings-save"
              data-merge-action="approve"
              disabled={deciding !== null}
              onClick={() => decide("approved")}
            >
              {deciding === "approved" ? "Approving…" : "Approve merge"}
            </button>
          ) : null}
          {/* Denying is NEVER blocked by missing evidence — a human who cannot
              verify the work must always be one click from refusing it. */}
          <button
            type="button"
            className="ghost-btn"
            data-merge-action="reject"
            disabled={deciding !== null}
            onClick={() => decide("rejected")}
          >
            {deciding === "rejected" ? "Rejecting…" : "Reject merge"}
          </button>
          {!approvable ? (
            <button
              type="button"
              className="ghost-btn"
              data-merge-action="evidence"
              onClick={() => props.merge.onOpenEvidence(approvalId)}
            >
              {reviewBlind ? "Review blind files & attest" : "Open evidence"}
            </button>
          ) : null}
          {loadError ? (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setReload((count) => count + 1)}
            >
              Retry
            </button>
          ) : null}
        </div>
      )}

      {refusal ? (
        <div className="right-panel-callout" role="alert">
          <strong>Not decided</strong>
          <p>{refusal}</p>
        </div>
      ) : null}
    </section>
  );
}

// ─── CONTINUE THE MISSION ON ANOTHER LANE (ROADMAP H12) ─────────────────────
//
// Handing a live mission from one lane to another was a five-step manual
// ritual: read the wrap packet, copy its goal and its next-lane request into a
// new brief, remember the packet id, pick the other vendor, dispatch. Every
// step was a chance to lose the thread — and the step people actually dropped
// was the citation, which is the one that makes the successor's report
// checkable.
//
// This is that ritual as ONE button per ready lane. What it is NOT:
//
//   * not a new authority — it files an ORDINARY dispatch through the same
//     route as any other, so role ceilings, budgets, claims and the chat
//     partition are exactly what they were before the click;
//   * not a new approval — nothing is gated here that was not gated before,
//     and nothing that was gated becomes ungated;
//   * not a new brief format — `buildContinuationDispatch` (@muon/client) is
//     the ONE composer, and it lives in the shared client so a second surface
//     adopts it rather than writing a second brief. Measured 2026-08-17: this
//     desk is its only caller today (no TUI palette; A12's MCP shape is the
//     `dispatch` tool + `sourcePacketId`, fenced by the backend's citation
//     guard). Say "shared by construction", not "shared by every surface".
//
// The refusals are the honest half. This panel does not pre-judge: it asks on
// the press and renders the composer's OWN sentence, so "there is no typed wrap
// packet to seed from" and "that lane is not dispatch-ready" reach the operator
// in the same words the CLI would use.

export type ContinueOnLaneOutcome =
  | { ok: true; jobId: string; packetId: string; vendor: string }
  | { ok: false; reason: string };

export type ContinueOnLaneProps = {
  /** The mission task the dock is reviewing; null → nothing to continue. */
  taskId: string | null;
  /**
   * Lane that produced the work. Excluded from the buttons: continuing on the
   * same lane is a re-run, not a hand-off, and the desk already has re-run.
   */
  currentVendor: string | null;
  /**
   * Dispatch-ready EXECUTION lanes, derived by the caller from the state
   * snapshot's capability preflight — never a hard-coded pair here.
   */
  vendors: ReadonlyArray<string>;
  /** Human label for a lane key (the registry's, passed in by the caller). */
  laneLabel: (vendor: string) => string;
  /** Human-speakable slug for a job id (the ONE projection, `sessionSlug`). */
  slugOf: (jobId: string) => string;
  /**
   * True when the readiness probe could not answer. The lanes are still
   * offered — MUON re-checks on the press and the dispatch route is the real
   * authority — but the strip says so rather than implying a green check.
   */
  readinessUnknown?: boolean;
  onContinue: (vendor: string) => Promise<ContinueOnLaneOutcome>;
};

type ContinueLaneState =
  | { phase: "idle" }
  | { phase: "dispatching" }
  | { phase: "refused"; reason: string }
  | { phase: "continued"; jobId: string; packetId: string };

function ContinueOnLaneSection(props: { continueOnLane: ContinueOnLaneProps }) {
  const spec = props.continueOnLane;
  const [lanes, setLanes] = useState<Record<string, ContinueLaneState>>({});
  const targets = spec.vendors.filter(
    (vendor) => vendor !== spec.currentVendor
  );

  if (!spec.taskId) {
    return null;
  }

  const stateFor = (vendor: string): ContinueLaneState =>
    lanes[vendor] ?? { phase: "idle" };

  const run = (vendor: string) => {
    setLanes((current) => ({ ...current, [vendor]: { phase: "dispatching" } }));
    void (async () => {
      try {
        const outcome = await spec.onContinue(vendor);
        setLanes((current) => ({
          ...current,
          [vendor]: outcome.ok
            ? {
                phase: "continued",
                jobId: outcome.jobId,
                packetId: outcome.packetId,
              }
            : // VERBATIM: the composer's words, not a desk paraphrase.
              { phase: "refused", reason: outcome.reason },
        }));
      } catch (error) {
        setLanes((current) => ({
          ...current,
          [vendor]: {
            phase: "refused",
            reason:
              error instanceof Error && error.message.trim().length > 0
                ? error.message
                : "The continuation was refused, and no reason was returned.",
          },
        }));
      }
    })();
  };

  return (
    <section className="right-panel-section continue-lane-section">
      <header>
        <strong>Continue on another lane</strong>
        <span>this mission&apos;s next turn</span>
      </header>
      {/* HONEST FRAMING, corrected in adversarial review (2026-08-17).
          This used to read "an ordinary dispatch … no wider budget", which was
          false: naming the chat (which the packet-citation guard REQUIRES) files
          the successor as this mission's chat root, so it gets the standard root
          turn budget and the mission's normal delegation allowance. That is the
          same shape every turn here already has — not a new tier, not a raised
          ceiling, no approval filed — and the copy now says exactly that
          instead of implying the successor is a plain worker. */}
      <p className="changes-honesty">
        Files this mission&apos;s next turn on another lane, seeded from its
        newest typed wrap packet and made to cite that packet. The successor is
        this mission&apos;s coordinator turn, with the same standard turn budget
        and delegation allowance every turn here already gets — no approval is
        filed and no ceiling is raised. MUON runs one turn at a time, so a live
        turn must finish or be interrupted first.
      </p>
      {targets.length === 0 ? (
        <p className="right-panel-empty">
          {spec.currentVendor
            ? `No other execution lane reported as dispatch-ready, so ${spec.laneLabel(spec.currentVendor)} is the only seat MUON can see for this mission. Check the lanes in Settings — a lane MUON could not probe reads the same as one that is missing.`
            : "No execution lane reported as dispatch-ready. Check the lanes in Settings, then continue this mission on one."}
        </p>
      ) : (
        <div className="merge-actions continue-lane-actions">
          {targets.map((vendor) => {
            const state = stateFor(vendor);
            if (state.phase === "continued") {
              return null;
            }
            return (
              <button
                key={vendor}
                type="button"
                className="settings-save"
                data-continue-lane={vendor}
                disabled={
                  state.phase === "dispatching" || state.phase === "refused"
                }
                title={state.phase === "refused" ? state.reason : undefined}
                onClick={() => run(vendor)}
              >
                {state.phase === "dispatching"
                  ? `Continuing on ${spec.laneLabel(vendor)}…`
                  : `Continue on ${spec.laneLabel(vendor)}`}
              </button>
            );
          })}
        </div>
      )}
      {spec.readinessUnknown ? (
        <p className="right-panel-bound">
          Lane readiness could not be checked just now, so these lanes are
          listed from the registry. MUON re-checks when you press.
        </p>
      ) : null}
      <div aria-live="polite" className="continue-lane-outcome">
        {targets.map((vendor) => {
          const state = stateFor(vendor);
          if (state.phase === "continued") {
            return (
              <p className="settings-saved" key={vendor}>
                {spec.laneLabel(vendor)} continued as{" "}
                <strong>{spec.slugOf(state.jobId)}</strong> (
                <code>{state.jobId}</code>) citing packet{" "}
                <code>{state.packetId}</code>.
              </p>
            );
          }
          if (state.phase === "refused") {
            return (
              <div className="right-panel-callout" role="alert" key={vendor}>
                <strong>Not continued on {spec.laneLabel(vendor)}</strong>
                <p>{state.reason}</p>
                <button
                  type="button"
                  className="ghost-btn"
                  data-continue-lane-retry={vendor}
                  onClick={() =>
                    setLanes((current) => ({
                      ...current,
                      [vendor]: { phase: "idle" },
                    }))
                  }
                >
                  Try again
                </button>
              </div>
            );
          }
          return null;
        })}
      </div>
    </section>
  );
}

function ChangesPanel(props: {
  loading: boolean;
  review: WorkspaceReview | null;
  ship?: ShipPanelProps;
  merge?: DockMergeProps;
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
      {props.merge ? (
        // Keyed by gate: a different approval is a different certification, and
        // a remount is the only way its load/decide state can never be
        // inherited from the gate before it.
        <MergeSection
          key={props.merge.approval?.id ?? "no-merge-gate"}
          merge={props.merge}
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
  /**
   * H3 — deciding the governed merge gate from the dock that reviewed it. Omit
   * and the Changes tab renders exactly as before: filing a gate here, deciding
   * it in the rail's dialog.
   */
  merge?: DockMergeProps;
  /**
   * H1 — the bound review thread's digest, rendered ABOVE everything else in
   * the Review tab. It leads because it is the only thing on this screen that
   * answers "what do I actually have to look at this time"; the full inbox
   * below it is the archaeology it exists to replace.
   */
  reviewDigest?: ReactNode;
  /**
   * H12 — one-gesture continue-on-lane for the mission this dock is reviewing.
   * Omitted (or with no task) renders nothing, never a dead button.
   */
  continueOnLane?: ContinueOnLaneProps;
  /**
   * ADR-0044/0071 — fork a NEW mission from the settled step this dock is
   * reviewing. Omitted (no settled job on screen) renders nothing, never a
   * dead button.
   */
  forkMission?: ForkMissionProps;
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
            merge={props.merge}
          />
        ) : (
          <div className="right-panel-review">
            {props.reviewDigest}
            {props.continueOnLane ? (
              // Keyed by MISSION: a different task is a different continuation,
              // and a remount is the only way "continued as quiet-heron citing
              // packet h-1" can never be inherited by the mission after it.
              <ContinueOnLaneSection
                key={props.continueOnLane.taskId ?? "no-mission-task"}
                continueOnLane={props.continueOnLane}
              />
            ) : null}
            {props.forkMission ? (
              // Keyed by SOURCE STEP: a different settled job is a different
              // fork, and a remount is the only way "forked into mission X"
              // can never be inherited by the step after it.
              <ForkMissionSection
                key={props.forkMission.sourceJobId}
                forkMission={props.forkMission}
              />
            ) : null}
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
