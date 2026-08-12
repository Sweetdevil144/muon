import { useEffect, useId, useRef, useState } from "react";
import { selectOneApprovableCard } from "@muon/client/approvable-inbox";
import { buildApprovalReview } from "@muon/client/approval-review";
import { vendorShortLabel } from "@muon/client/vendors";
import { buildAuditTrail } from "@muon/client/audit-trail";
import {
  buildDispatchForest,
  type DispatchForestSummary,
  type DispatchTreeNode,
} from "@muon/client/dispatch-view";
import {
  deriveCrewLiveness,
  crewLivenessLabel,
} from "@muon/client/crew-liveness";
import { DESCENDANT_POOL_CEILING_MS } from "@muon/client/budget-view";
import type {
  ManualReviewAttestation,
  ReviewCoverageCertification,
} from "@muon/client";
import type {
  ApprovalReceipt,
  ApprovalRequest,
  DispatchBudget,
  DispatchJobRecord,
  PreEditContext,
  RecordedEvent,
  WorkflowRunRecord,
} from "@muon/client/types";
import type { ReadinessSnapshotMeta, WorkspaceReview } from "../shared/ipc.js";
import { agentCodename } from "../lib/agent-codename.js";
import { freshnessLabel } from "./lib/lane-status.js";
import {
  REMEMBER_ACTION_TTL_MS,
  ReviewGateActions,
  useGateDecision,
  type GateResolve,
} from "./review-gate.js";
import type {
  CapabilityPreflight,
  PreflightVendor,
} from "@muon/client/capability-preflight";

export type DispatchSummary = {
  target: string;
  memory: string;
  codeRadius: string;
  symbolImpact: string;
  coordinates: string;
  degraded: boolean;
};

// No task is *idle*, not degraded; `degraded: true` stays on the real
// target-only/fetch-failure paths below so the yellow rule fires only for
// genuine degradation.
const EMPTY_SUMMARY: DispatchSummary = {
  target: "No active task yet",
  memory: "Shared context loads before edits",
  codeRadius: "Awaiting touched modules",
  symbolImpact: "Awaiting symbol evidence",
  coordinates: "No active lane coordinates",
  degraded: false,
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function summaryFromContext(context: PreEditContext): DispatchSummary {
  const modules = context.blastRadius.modules.length;
  const symbols = context.blastRadius.symbols?.length ?? 0;
  // Guard like the shared view-model (preedit-view): a degraded/partial backend
  // response can omit the activity/duplicateWork sibling channels, and reading
  // `.length` off undefined threw and collapsed the whole hero to "Evidence
  // unavailable". Coordinate them defensively so a missing channel reads as zero.
  const coordinates =
    (context.activity?.length ?? 0) + (context.duplicateWork?.length ?? 0);
  return {
    target:
      context.target.symbol ??
      context.target.module ??
      context.blastRadius.modules[0] ??
      "Target unresolved",
    memory: plural(context.memories.length, "note"),
    codeRadius: `${plural(modules, "module")} · ${context.blastRadius.source}`,
    symbolImpact: `${plural(symbols, "symbol")}${
      context.blastRadius.depth === undefined
        ? ""
        : ` · depth ${context.blastRadius.depth}`
    }`,
    coordinates:
      coordinates === 0
        ? "No live collision"
        : `${plural(coordinates, "live coordinate")} to review`,
    degraded: context.blastRadius.source === "target-only",
  };
}

export function LiveDispatchHero(props: {
  taskId: string | null;
  onOpenBrain: () => void;
}) {
  const [loaded, setLoaded] = useState<{
    taskId: string;
    summary: DispatchSummary;
  } | null>(null);

  useEffect(() => {
    let canceled = false;
    if (!props.taskId) {
      return;
    }
    const taskId = props.taskId;
    void window.muon
      .autoContext(taskId)
      .then((auto) => {
        if (!auto) return null;
        return window.muon.preEditContext(auto.input);
      })
      .then((context) => {
        if (!canceled) {
          // A null auto-context is a settled answer, not a pending one: keep
          // the idle summary but stop presenting the strip as loading.
          setLoaded({
            taskId,
            summary: context ? summaryFromContext(context) : EMPTY_SUMMARY,
          });
        }
      })
      .catch(() => {
        if (!canceled) {
          setLoaded({
            taskId,
            summary: {
              ...EMPTY_SUMMARY,
              target: "Evidence unavailable",
              memory: "Context degraded, open for the reason",
              degraded: true,
            },
          });
        }
      });
    return () => {
      canceled = true;
    };
  }, [props.taskId]);

  const summary =
    props.taskId && loaded?.taskId === props.taskId
      ? loaded.summary
      : EMPTY_SUMMARY;
  return (
    <DispatchHero
      summary={summary}
      idle={props.taskId == null}
      loading={props.taskId != null && loaded?.taskId !== props.taskId}
      onOpenBrain={props.onOpenBrain}
    />
  );
}

// A channel value that carries a "lead · tail" shape (e.g. "7 modules ·
// impact-graph") renders the tail as a dimmed sub-phrase, matching the
// prototype's evidence chips ("3 confirmed notes · loads before edits").
// Only splits where the data actually has that shape — never fabricates one.
function renderChannelValue(value: string) {
  const sep = " · ";
  const idx = value.indexOf(sep);
  if (idx === -1) return value;
  const lead = value.slice(0, idx);
  const tail = value.slice(idx + sep.length);
  return (
    <>
      {lead} <small>· {tail}</small>
    </>
  );
}

export function DispatchHero(props: {
  summary: DispatchSummary;
  idle?: boolean;
  loading?: boolean;
  onOpenBrain: () => void;
}) {
  // Progressive disclosure: the full evidence grid stays available but is
  // hidden by default so the hero stays Linear-dense. One truncated hint line
  // + an "i" toggle reveal the rationale without a permanent wide column.
  const [expanded, setExpanded] = useState(false);
  const channels = [
    ["Memory", props.summary.memory],
    ["Code radius", props.summary.codeRadius],
    ["Symbol impact", props.summary.symbolImpact],
    ["Crew activity", props.summary.coordinates],
  ] as const;
  const hint = channels
    .map(([, value]) => value.trim())
    .filter((value) => value.length > 0)
    .join(" · ");
  return (
    <section
      className={`dispatch-hero${props.summary.degraded ? " degraded" : ""}${
        props.idle ? " idle" : ""
      }${props.loading ? " loading-line" : ""}${
        expanded ? " expanded" : ""
      }`}
      aria-label="Why this dispatch"
    >
      <div className="dispatch-hero-bar">
        <button
          type="button"
          className="dispatch-hero-target"
          aria-expanded={expanded}
          aria-controls="dispatch-rationale"
          onClick={() => setExpanded((open) => !open)}
        >
          <span className="dispatch-hero-kicker">Why this dispatch</span>
          <strong>{props.summary.target}</strong>
          {!expanded && hint ? (
            <span className="dispatch-hero-hint">{hint}</span>
          ) : null}
        </button>
        <div className="dispatch-hero-actions">
          <button
            type="button"
            className="ghost-btn dispatch-hero-toggle"
            aria-expanded={expanded}
            aria-controls="dispatch-rationale"
            aria-label={
              expanded ? "Hide dispatch rationale" : "Show dispatch rationale"
            }
            onClick={() => setExpanded((open) => !open)}
          >
            i
          </button>
          <button
            type="button"
            className="secondary-btn"
            onClick={props.onOpenBrain}
          >
            Open evidence
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="dispatch-channels" id="dispatch-rationale">
          {channels.map(([label, value]) => (
            <div className="dispatch-channel" key={label}>
              <span>{label}</span>
              <strong>{renderChannelValue(value)}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Capability chip for one preflight vendor row, contract fields only. */
function capabilityChip(vendor: PreflightVendor): string {
  if (vendor.auth === "authenticated" && vendor.authMethod !== "vendor-login") {
    return "BYOK";
  }
  if (vendor.auth === "authenticated") return "ready";
  // Honest probe outage: NOT "signed out", the account may be fine.
  if (vendor.auth === "unknown") return "unknown";
  if (vendor.installed) return "setup";
  return "missing";
}

/**
 * The human Doctor surface. Renders the ONE P0.5 capability-preflight
 * contract (built in main, same projection as `muon doctor --json` and the
 * MCP tool), so the desktop can never drift from the other surfaces.
 */
export function DiagnosticsStrip(props: {
  preflight: CapabilityPreflight | null;
  runnerDetail?: string | null;
  /**
   * How old the readiness evidence in `preflight` is. Readiness is the one part
   * of the doctor contract that costs real subprocess time, so it is served
   * from a cache and its age is shown rather than implied. Absent on older
   * main processes — the strip simply omits the line then.
   */
  readinessMeta?: ReadinessSnapshotMeta;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshError?: string | null;
}) {
  const preflight = props.preflight;
  const freshness = freshnessLabel(props.readinessMeta);
  if (!preflight) {
    // Older main process without the contract: degrade honestly, never guess.
    return (
      <div className="diagnostics-strip" aria-label="MUON doctor">
        <details className="diagnostic-item systems-diagnostic">
          <summary>
            <span className="sysline-dot idle" aria-hidden="true" />
            Systems check unavailable
          </summary>
          <div className="diagnostic-detail systems-detail">
            <div className="system-group">
              <strong>Doctor evidence unavailable</strong>
              <span>This app build did not report doctor evidence.</span>
              <small>Restart MUON, then re-open diagnostics.</small>
            </div>
            <div className="system-group">
              <strong>Crew unavailable</strong>
              <div className="fleet-diagnostic-row">
                <strong>Crew check unavailable</strong>
                <span>Open Settings → Status and check providers again.</span>
              </div>
            </div>
          </div>
        </details>
      </div>
    );
  }

  const degradations = preflight.degradations;
  const attention = degradations.filter((d) => d.severity !== "info").length;
  // A hard control-plane/runner failure is not "setup", it's broken. Only
  // word it "needs setup" when every contributor is a crew-readiness gap.
  const hardFailure = degradations.some(
    (d) =>
      (d.surface === "brain" || d.surface === "runner") &&
      d.severity !== "info"
  );
  const brainDegradation =
    degradations.find((d) => d.surface === "brain") ?? null;
  const runnerDegradation =
    degradations.find((d) => d.surface === "runner") ?? null;
  const crewUnavailable = preflight.readiness.source === "unavailable";
  // "No verdict YET" vs "no verdict at all". The first probe spawns the vendor
  // CLIs (~3.8s, `cursor-agent status` alone is 3.3s) and no longer blocks the
  // poll, so a cold Status/Doctor legitimately has no lane evidence for a
  // moment — and must say so instead of reporting a failure.
  const crewChecking =
    crewUnavailable &&
    (props.readinessMeta?.state === "probing" ||
      props.readinessMeta?.state === "refreshing");
  const readyCount = preflight.vendors.filter((v) => v.dispatchReady).length;
  // A connected but ROLE-SCOPED lane (Cursor, OpenCode) reports VENDOR_ROLE_SCOPED
  // at `info` severity: it is neither "ready" for un-planned work nor "setup".
  const needsSetup = degradations.filter(
    (d) => d.surface === "vendor" && d.severity === "warning"
  ).length;
  const runnerReady = preflight.runnerHealth.state === "live";
  return (
    <div className="diagnostics-strip" aria-label="MUON doctor">
      <details
        open={attention > 0 ? true : undefined}
        className={`diagnostic-item systems-diagnostic${
          hardFailure && attention > 0 ? " bad" : ""
        }`}
      >
        <summary>
          <span
            className={`sysline-dot ${
              hardFailure && attention > 0 ? "bad" : attention > 0 ? "warn" : "ok"
            }`}
            aria-hidden="true"
          />
          {crewChecking && !hardFailure
            ? "Systems · checking agents…"
            : attention === 0
              ? "Systems ready"
              : `Systems · ${attention} need${attention === 1 ? "s" : ""} ${
                  hardFailure ? "attention" : "setup"
                }`}
        </summary>
        <div className="diagnostic-detail systems-detail">
          <div className="system-group">
            <strong>{`Control plane ${
              preflight.brainHealth.state === "ok" ? "ready" : "offline"
            }`}</strong>
            <span>
              {brainDegradation?.reason ??
                "The local control plane is responding."}
            </span>
            <small>
              {brainDegradation?.nextAction ?? "Ready to coordinate agent work."}
            </small>
          </div>
          <div className="system-group">
            <strong>{`Runner ${runnerReady ? "ready" : "needs attention"}`}</strong>
            <span>
              {props.runnerDetail ??
                runnerDegradation?.reason ??
                preflight.runnerHealth.detail}
            </span>
            <small>
              {runnerDegradation?.nextAction ??
                (runnerReady
                  ? "Ready to execute durable work."
                  : preflight.runnerHealth.detail)}
            </small>
          </div>
          <div className="system-group">
            <strong>
              Crew{" "}
              {crewChecking
                ? "checking…"
                : crewUnavailable
                  ? "unavailable"
                  : `${readyCount} ready${needsSetup > 0 ? ` · ${needsSetup} needs setup` : ""}`}
            </strong>
            {crewChecking ? (
              // The FIRST probe has not landed yet. That is not the same thing
              // as "unavailable" — one resolves itself in a few seconds, the
              // other needs the human. Saying "unavailable" for both is what
              // made a healthy cold start look broken.
              <div className="fleet-diagnostic-row">
                <strong>Checking your agents</strong>
                <span>
                  Running each vendor CLI&apos;s own install and sign-in check.
                </span>
                <small>
                  This takes a few seconds and never blocks the rest of MUON.
                </small>
              </div>
            ) : crewUnavailable ? (
              <div className="fleet-diagnostic-row">
                <strong>Crew check unavailable</strong>
                <span>Open Settings → Status and check providers again.</span>
              </div>
            ) : (
              preflight.vendors.map((vendor) => {
                const degradation = degradations.find(
                  (d) => d.surface === "vendor" && d.vendor === vendor.vendor
                );
                return (
                  <div className="fleet-diagnostic-row" key={vendor.vendor}>
                    <strong>
                      {vendor.label} · {capabilityChip(vendor)}
                    </strong>
                    <span>{vendor.detail}</span>
                    <small>
                      {degradation?.nextAction ??
                        `Ready to dispatch through the ${
                          vendor.authMethod === "vendor-login"
                            ? "vendor login"
                            : "selected API-key provider"
                        }.`}
                    </small>
                  </div>
                );
              })
            )}
          </div>
          {props.onRefresh ? (
            <div className="diagnostic-actions">
              <button
                type="button"
                className="secondary-btn"
                disabled={props.refreshing}
                onClick={props.onRefresh}
              >
                {props.refreshing ? "Checking providers…" : "Re-check providers"}
              </button>
              {props.refreshError ? (
                <span role="alert">{props.refreshError}</span>
              ) : (
                <small>
                  {/* Age first: a stale-but-LABELLED verdict is honest, an
                      unlabelled one is a claim MUON cannot back. */}
                  {freshness ? `${freshness}. ` : ""}
                  Re-runs local provider checks without exposing credentials.
                </small>
              )}
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}

/**
 * Compact titlebar status control. Full doctor detail lives in Settings →
 * Status; this only surfaces readiness and opens that Settings section.
 */
export function SystemsStatusButton(props: {
  preflight: CapabilityPreflight | null;
  /** Readiness freshness, so a cold start reads "Checking" not "1 setup". */
  readinessMeta?: ReadinessSnapshotMeta;
  onOpenSettings: () => void;
}) {
  const preflight = props.preflight;
  if (!preflight) {
    return (
      <button
        type="button"
        className="systems-status-btn"
        onClick={props.onOpenSettings}
        title="Open Status in Settings"
      >
        <span className="sysline-dot idle" aria-hidden="true" />
        <span>Status</span>
      </button>
    );
  }
  const attention = preflight.degradations.filter(
    (d) => d.severity !== "info"
  ).length;
  const hardFailure = preflight.degradations.some(
    (d) =>
      (d.surface === "brain" || d.surface === "runner") &&
      d.severity !== "info"
  );
  // While the FIRST vendor probe is still running the lane evidence is simply
  // absent, so the pill must not spend those seconds accusing the user of a
  // setup problem that may not exist.
  const checking =
    preflight.readiness.source === "unavailable" &&
    (props.readinessMeta?.state === "probing" ||
      props.readinessMeta?.state === "refreshing");
  const tone =
    hardFailure && attention > 0
      ? "bad"
      : checking
        ? "idle"
        : attention > 0
          ? "warn"
          : "ok";
  const label =
    hardFailure && attention > 0
      ? `${attention} issue${attention === 1 ? "" : "s"}`
      : checking
        ? "Checking"
        : attention === 0
          ? "Ready"
          : `${attention} setup`;
  return (
    <button
      type="button"
      className={`systems-status-btn ${tone}`}
      onClick={props.onOpenSettings}
      title="Open Status in Settings"
    >
      <span className={`sysline-dot ${tone}`} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

/**
 * #9: a compact "N files · +A −D" + top-N per-file readout for the right
 * dock's Review section, so a human doesn't have to open a subagent tab just
 * to see what changed. Reuses the SAME `.session-change-files`/`.numstat*`
 * markup/CSS as the center's own Changes tab (session-workspace.tsx) — no
 * second numstat recipe. Renders nothing when there is nothing to show
 * (degraded/no-files/no-job) so it never displaces the review inbox below it.
 */
const DOCK_CHANGES_FILE_LIMIT = 5;

function DockChanges(props: { review: WorkspaceReview | null | undefined }) {
  const review = props.review;
  if (!review || review.status !== "available" || review.files.length === 0) {
    return null;
  }
  const totals = review.fileStats?.reduce(
    (acc, stat) => ({
      additions: acc.additions + stat.additions,
      deletions: acc.deletions + stat.deletions,
    }),
    { additions: 0, deletions: 0 }
  );
  const shown = review.files.slice(0, DOCK_CHANGES_FILE_LIMIT);
  const remaining = review.files.length - shown.length;
  return (
    <div className="dock-changes" aria-label="File changes">
      <div className="dock-changes-summary">
        <strong>{plural(review.files.length, "file")}</strong>
        {totals ? (
          <span className="numstat">
            <span className="numstat-add">+{totals.additions}</span>
            <span className="numstat-del">−{totals.deletions}</span>
          </span>
        ) : null}
      </div>
      <ul className="session-change-files">
        {shown.map((file) => {
          const stat = review.fileStats?.find((s) => s.path === file);
          return (
            <li key={file}>
              <code>{file}</code>
              {stat ? (
                stat.binary ? (
                  <span className="numstat numstat-binary">binary</span>
                ) : (
                  <span className="numstat">
                    <span className="numstat-add">+{stat.additions}</span>
                    <span className="numstat-del">−{stat.deletions}</span>
                  </span>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
      {remaining > 0 ? (
        <span className="dock-changes-more">+{remaining} more file{remaining === 1 ? "" : "s"}</span>
      ) : null}
    </div>
  );
}

/**
 * P0-1 — one filed approval in the dock inbox, and a real decision surface.
 *
 * Three states, one card:
 *  - Full Auto is covering it → evidence only, NO actions. Standing consent
 *    already resolved through the governed path; a click site here would be a
 *    second consent path, which is exactly what this codebase must not grow.
 *  - `merge` → the decision legally needs the worktree review certification
 *    (and a REVIEW BLIND attestation), which lives in the evidence dialog. One
 *    routing control, not a decision MUON would have to refuse.
 *  - everything else → the three actions, decided in place.
 */
function ApprovalItem(props: {
  approval: ApprovalRequest;
  /** Same-job siblings folded into this card (TODO 5.16) — context only. */
  folded?: ApprovalRequest[];
  /** How many other jobs are waiting behind this one card. */
  queuedCount?: number;
  autoApproving?: boolean;
  onReview: () => void;
  onResolve: GateResolve;
}) {
  const review = buildApprovalReview(props.approval);
  const { busy, error, decide } = useGateDecision(props.onResolve);
  const folded = props.folded ?? [];
  const queuedCount = props.queuedCount ?? 0;
  if (props.autoApproving) {
    return (
      <article className="inbox-card auto-approving">
        <span className="inbox-kicker">Approving for you</span>
        <strong>{review.action}</strong>
        <p>{props.approval.reason}</p>
        <small>
          requested by {props.approval.requestedBy} · Full Auto is granting this
          as you, and recording it
        </small>
      </article>
    );
  }
  return (
    <article className="inbox-card urgent">
      <span className="inbox-kicker">Needs your decision</span>
      <strong>{review.action}</strong>
      <span className="inbox-scope">{review.scope}</span>
      <p>{props.approval.reason}</p>
      {folded.length > 0 ? (
        <small className="inbox-folded">
          Also waiting on this job:{" "}
          {folded.map((item) => buildApprovalReview(item).action).join(" · ")}
        </small>
      ) : null}
      {queuedCount > 0 ? (
        <small className="inbox-queued">
          {queuedCount} more decision{queuedCount === 1 ? "" : "s"} waiting
          after this one
        </small>
      ) : null}
      <small>requested by {props.approval.requestedBy}</small>
      {review.degraded && review.degradationReason ? (
        // Why Approve is unavailable, said once, where the operator is looking.
        <small className="inbox-degraded" role="alert">
          {review.degradationReason}
        </small>
      ) : null}
      {props.approval.kind === "merge" ? (
        <div className="inbox-actions">
          <button className="review" onClick={props.onReview} type="button">
            Review merge evidence
          </button>
        </div>
      ) : (
        <ReviewGateActions
          busy={busy}
          error={error}
          onDecide={decide}
          review={review}
          status={props.approval.status}
        />
      )}
    </article>
  );
}

function ApprovalReviewDialog(props: {
  approval: ApprovalRequest;
  onClose: () => void;
  onLoadMergeReview?: () => Promise<ReviewCoverageCertification>;
  /**
   * Resolves the decision. `receiptTtlMs` rides ONLY when the operator pressed
   * "Approve, don't ask again"; a rejected promise keeps the dialog open and
   * surfaces the server's reason (the approval stays pending).
   */
  onResolve: (
    status: "approved" | "rejected",
    receiptTtlMs?: number,
    manualReview?: ManualReviewAttestation
  ) => void | Promise<void>;
}) {
  const review = buildApprovalReview(props.approval);
  const approvalId = props.approval.id;
  const approvalKind = props.approval.kind;
  const [loadMergeReview] = useState(() => props.onLoadMergeReview);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [mergeReview, setMergeReview] =
    useState<ReviewCoverageCertification | null>(null);
  const [mergeReviewLoading, setMergeReviewLoading] = useState(
    approvalKind === "merge" && Boolean(props.onLoadMergeReview)
  );
  const [mergeReviewError, setMergeReviewError] = useState<string | null>(
    approvalKind === "merge" && !props.onLoadMergeReview
      ? "Merge review is unavailable. Restart MUON and retry; if it persists, update the app before approving."
      : null
  );
  const [manualReviewAcknowledged, setManualReviewAcknowledged] =
    useState(false);
  const [resolving, setResolving] = useState(false);
  const [mergeReviewReload, setMergeReviewReload] = useState(0);
  const consequenceId = useId();

  const resolve = (
    status: "approved" | "rejected",
    receiptTtlMs?: number
  ) => {
    if (resolving) return;
    setResolveError(null);
    setResolving(true);
    void (async () => {
      try {
        const manualReview: ManualReviewAttestation | undefined =
          status === "approved" &&
          mergeReview?.status === "blocked" &&
          mergeReview.blockCode === "review-blind" &&
          manualReviewAcknowledged
            ? {
                acknowledged: true,
                artifactDigest: mergeReview.artifactDigest,
                blindFiles: mergeReview.blindFiles ?? [],
              }
            : undefined;
        if (status === "approved" && receiptTtlMs !== undefined) {
          await props.onResolve(status, receiptTtlMs, manualReview);
        } else if (manualReview) {
          await props.onResolve(status, undefined, manualReview);
        } else {
          await props.onResolve(status);
        }
        // BUG 1: a receipt that can't be minted is NOT a failure — the decision
        // lands (200) and the server returns a soft `receiptSkipped` reason,
        // which the main process surfaces as a gentle note. Only a genuinely
        // rejected decision (a thrown error below) shows the red banner.
      } catch (error) {
        setResolveError(
          error instanceof Error ? error.message : "The decision failed."
        );
      } finally {
        setResolving(false);
      }
    })();
  };
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    const close = dialog?.querySelector<HTMLElement>("[data-dialog-close]");
    close?.focus();
    return () => {
      if (returnFocusRef.current?.isConnected) {
        returnFocusRef.current.focus();
      }
    };
  }, []);

  useEffect(() => {
    if (approvalKind !== "merge" || !loadMergeReview) {
      return;
    }
    let active = true;
    void loadMergeReview()
      .then((certification) => {
        if (!active) return;
        setMergeReview(certification);
      })
      .catch((error) => {
        if (!active) return;
        setMergeReviewError(
          error instanceof Error
            ? error.message
            : "Could not load merge review evidence."
        );
      })
      .finally(() => {
        if (active) setMergeReviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [approvalId, approvalKind, loadMergeReview, mergeReviewReload]);

  const reviewBlind =
    mergeReview?.status === "blocked" &&
    mergeReview.blockCode === "review-blind";
  const mergeApprovable =
    props.approval.kind !== "merge" ||
    (!mergeReviewLoading &&
      mergeReviewError === null &&
      (mergeReview?.status === "certified" ||
        (reviewBlind && manualReviewAcknowledged)));
  const approvable = review.approvable && mergeApprovable;
  // Why Approve is unavailable RIGHT NOW, in the operator's words. Reject is
  // never blocked by any of these — denying always stays one click.
  const approveBlockedReason = mergeApprovable
    ? null
    : mergeReviewLoading
      ? "Checking this exact worktree against GitNexus before a merge can be approved."
      : (mergeReviewError ??
        (reviewBlind
          ? "Review every blind file above and attest before approving this merge."
          : (mergeReview?.status === "blocked"
              ? mergeReview.reason
              : "Merge review evidence is not available yet.")));

  return (
    <div className="approval-review-overlay" role="presentation">
      <section
        ref={dialogRef}
        aria-describedby={consequenceId}
        aria-labelledby={`approval-review-${props.approval.id}`}
        aria-modal="true"
        className="approval-review-card"
        role="dialog"
        onKeyDown={(event) => {
          // Fast, keyboard-first decision: the single-key shortcuts below ARE
          // the review (the evidence <dl> stays fully visible). Three keys for
          // the three actions, byte-for-byte the TUI's bindings: `a` approve,
          // `A` (shift) approve + don't ask again, `r` reject. Guarded against
          // typing targets, modifier chords (Cmd+K, etc.), and — critically —
          // the OPPOSITE action's own button: focusing Reject and pressing 'a'
          // must never approve, and focusing an Approve and pressing 'r' must
          // never reject.
          //
          // Deliberately NOT handled here: Enter. There is no global
          // "Enter anywhere = approve" — Enter keeps standard button
          // semantics and only activates whichever button is actually
          // focused (native <button> behavior). "Close" is the default
          // focus on open, so a stray Enter right after opening the dialog
          // can only dismiss it, never approve.
          const target = event.target as HTMLElement;
          const tag = target.tagName;
          const typing =
            tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA";
          const focusedAction = target.dataset?.approvalAction;
          if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
            if (event.key === "A" && focusedAction !== "reject") {
              // Standing consent needs the deliberate shift — and is refused
              // outright for actions that can never be remembered.
              if (approvable && review.receiptEligible && !resolving) {
                event.preventDefault();
                resolve("approved", REMEMBER_ACTION_TTL_MS);
                return;
              }
            }
            if (event.key === "a" && focusedAction !== "reject") {
              if (approvable && !resolving) {
                event.preventDefault();
                resolve("approved");
                return;
              }
            }
            if (
              (event.key === "r" || event.key === "R") &&
              focusedAction !== "approve" &&
              focusedAction !== "approve-remember"
            ) {
              if (!resolving) {
                event.preventDefault();
                resolve("rejected");
                return;
              }
            }
          }
          if (event.key === "Escape") {
            if (resolving) return;
            // Deliberate deviation from "Esc-to-reject": Escape is a SAFE
            // dismiss (approval stays pending). Fast deny is the letter `r`.
            event.preventDefault();
            props.onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
            ) ?? []
          );
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <div>
            <span className="inbox-kicker">Needs your approval</span>
            <h2 id={`approval-review-${props.approval.id}`}>Approval review</h2>
          </div>
          <button
            data-dialog-close
            disabled={resolving}
            onClick={props.onClose}
          >
            Close
          </button>
        </header>

        {review.degraded ? (
          <div className="approval-review-warning" role="alert">
            {review.degradationReason}
          </div>
        ) : null}

        {props.approval.kind === "merge" ? (
          <div className="merge-review-certification" aria-live="polite">
            <div className="merge-review-heading">
              <strong>Merge review</strong>
              <button
                disabled={mergeReviewLoading || resolving}
                onClick={() => {
                  setMergeReview(null);
                  setMergeReviewLoading(true);
                  setMergeReviewError(null);
                  setManualReviewAcknowledged(false);
                  setMergeReviewReload((value) => value + 1);
                }}
                type="button"
              >
                Refresh
              </button>
            </div>
            {mergeReviewLoading ? (
              <p>Checking the exact worktree against GitNexus…</p>
            ) : mergeReviewError ? (
              <div className="approval-review-warning" role="alert">
                {mergeReviewError}
              </div>
            ) : mergeReview?.status === "certified" ? (
              <>
                <p className="merge-review-ok">
                  {mergeReview.verdict === "no-op"
                    ? "No worktree changes need to land."
                    : `Graph coverage is current for ${mergeReview.changedFiles.length} changed file${mergeReview.changedFiles.length === 1 ? "" : "s"}.`}
                </p>
                <small>
                  Artifact {mergeReview.artifactDigest.slice(0, 12)}…
                </small>
              </>
            ) : reviewBlind && mergeReview ? (
              <>
                <div className="approval-review-warning" role="alert">
                  {mergeReview.reason}
                </div>
                <p>
                  GitNexus cannot inspect the files below yet. Review their
                  complete contents and diff manually before attesting.
                </p>
                <ul className="merge-review-files">
                  {(mergeReview.blindFiles ?? []).map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
                <label className="merge-review-attestation">
                  <input
                    checked={manualReviewAcknowledged}
                    disabled={resolving}
                    onChange={(event) =>
                      setManualReviewAcknowledged(event.target.checked)
                    }
                    type="checkbox"
                  />
                  I reviewed every blind file for this exact artifact
                </label>
                <small>
                  Bound to {mergeReview.artifactDigest.slice(0, 12)}…; any
                  worktree change invalidates this attestation.
                </small>
              </>
            ) : mergeReview?.status === "blocked" ? (
              <div className="approval-review-warning" role="alert">
                {mergeReview.reason}
              </div>
            ) : null}
          </div>
        ) : null}

        <dl className="approval-evidence">
          <div>
            <dt>Bound action</dt>
            <dd>{review.action}</dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>{review.scope}</dd>
          </div>
          <div>
            <dt>Consequence</dt>
            <dd id={consequenceId}>{review.consequence}</dd>
          </div>
          <div>
            <dt>Approval scope</dt>
            <dd>{review.authority}</dd>
          </div>
          {review.risk ? (
            <div>
              <dt>Risk</dt>
              <dd className={`approval-risk ${review.risk}`}>{review.risk}</dd>
            </div>
          ) : null}
          <div>
            <dt>Requested by</dt>
            <dd>{props.approval.requestedBy}</dd>
          </div>
          <div>
            <dt>Request binding</dt>
            <dd className="approval-binding">{review.binding}</dd>
          </div>
          {review.payloadDigest ? (
            <div>
              <dt>Payload digest</dt>
              <dd className="approval-binding">{review.payloadDigest}</dd>
            </div>
          ) : null}
        </dl>

        {review.details?.length ? (
          <div className="approval-full-reason">
            <span>Safe payload details</span>
            <dl className="approval-payload-details">
              {review.details.map((detail) => (
                <div key={detail.label}>
                  <dt>{detail.label}</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        <div className="approval-full-reason">
          <span>Complete reason</span>
          <p>{props.approval.reason}</p>
        </div>

        {/* Three actions, nothing else. The evidence above is context for the
            decision; this row IS the decision. */}
        <ReviewGateActions
          approveBlockedReason={approveBlockedReason}
          busy={resolving}
          error={resolveError}
          onDecide={resolve}
          review={review}
          shortcuts
          status={props.approval.status}
        />
      </section>
    </div>
  );
}

function compactDuration(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  return `${Math.ceil(ms / 60_000)}m`;
}

export function DispatchTreeItem(props: {
  node: DispatchTreeNode;
  /** Optional: without it the row renders no revoke control at all. */
  onRevokeGrants?: (jobId: string) => Promise<{ revoked: number; note: string }>;
}) {
  const node = props.node;
  // TWO CLICKS, because this is sharp and unlike interrupt it is not obviously
  // recoverable: the lane's identity is gone and the process may still be
  // running. The confirm step also puts the consequence in front of the
  // operator at the moment they can still change their mind.
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const accessLabel =
    node.authority === "orchestrator" ? "Coordinator" : node.authority;
  // Wave 4.2: derive the live crew state so a silent/stalled child lights amber
  // BEFORE it dies (the signal the original hang lacked), and a failed/quiet one
  // reads honestly. Recomputed each render (the cockpit re-polls), so elapsed
  // time moves a launching node → stalled on its own.
  const liveness = deriveCrewLiveness(
    {
      status: node.status,
      exitCode: node.exitCode,
      // Time the startup window from LAUNCH (matches the runner watchdog), not
      // the enqueue time — a queued job's wait must not inflate its age.
      createdAt: node.startedAt ?? node.createdAt,
      lastProgressAt: node.lastProgressAt,
      waitingApproval: node.waitingApproval,
      result: node.result,
    },
    Date.now()
  );
  const dotClass = liveness.attention
    ? `activity-dot ${liveness.state} attention`
    : `activity-dot ${liveness.state}`;
  const progressAge =
    liveness.lastProgressAgeMs !== undefined
      ? ` · ${Math.round(liveness.lastProgressAgeMs / 1000)}s since progress`
      : "";
  return (
    <li
      className={`mission-node ${node.status}${liveness.attention ? " attention" : ""}`}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={false}
    >
      <div className="mission-node-line">
        <span className={dotClass} aria-hidden="true" />
        <div className="mission-node-copy">
          <div>
            {/* Display-only codename (agent-codename.ts) keyed by the dispatch
                id, with the vendor kept visible alongside the authority role. */}
            <strong>{agentCodename(node.id)}</strong>
            <span className="mission-authority">
              {vendorShortLabel(node.vendor)} · {accessLabel}
            </span>
          </div>
          <p className="mission-brief" title={node.brief}>
            {node.brief}
          </p>
          <small>
            {crewLivenessLabel(liveness.state)} · depth {node.depth}
            {progressAge}
          </small>
          {node.currentActivity ? (
            <small className="mission-node-activity" title={node.currentActivity}>
              {node.currentActivity}
            </small>
          ) : null}
          {liveness.attention && liveness.reason ? (
            <small className="mission-node-reason" role="alert">
              {liveness.reason}
            </small>
          ) : null}
          {outcome ? (
            <small className="mission-node-revoked">{outcome}</small>
          ) : null}
        </div>
        {props.onRevokeGrants ? (
          <div className="mission-node-controls">
            {confirming ? (
              <>
                <button
                  className="mission-revoke danger"
                  disabled={revoking}
                  type="button"
                  onClick={() => {
                    setRevoking(true);
                    props
                      .onRevokeGrants!(node.id)
                      .then((result) =>
                        setOutcome(
                          `Revoked ${result.revoked} grant(s) — ${result.note} The process may still be running; stop it separately.`
                        )
                      )
                      .catch((cause: unknown) =>
                        setOutcome(
                          cause instanceof Error
                            ? `Not revoked: ${cause.message}`
                            : "Not revoked."
                        )
                      )
                      .finally(() => {
                        setRevoking(false);
                        setConfirming(false);
                      });
                  }}
                >
                  {revoking ? "Revoking…" : "Kill credential"}
                </button>
                <button
                  className="mission-revoke"
                  disabled={revoking}
                  type="button"
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="mission-revoke"
                type="button"
                title="Kill this lane's live credential. It does NOT stop the process."
                onClick={() => setConfirming(true)}
              >
                Revoke credential
              </button>
            )}
          </div>
        ) : null}
      </div>
      {node.children.length > 0 ? (
        <ul role="group">
          {node.children.map((child) => (
            <DispatchTreeItem
              key={child.id}
              node={child}
              onRevokeGrants={props.onRevokeGrants}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function missionNodes(root: DispatchTreeNode): DispatchTreeNode[] {
  return [root, ...root.children.flatMap(missionNodes)];
}

function missionTerminalPosture(
  root: DispatchTreeNode,
  summary: DispatchForestSummary
) {
  const nodes = missionNodes(root);
  const failed = nodes.filter((node) => node.status === "failed").length;
  const interrupted = nodes.filter(
    (node) => node.status === "interrupted"
  ).length;
  if (summary.active > 0 || nodes.length === 0) return null;
  if (failed > 0) {
    return {
      tone: "failed",
      title: "Mission needs attention",
      detail: `${plural(failed, "lane")} failed. Next: open the audit log, inspect the failure evidence, then dispatch a bounded follow-up.`,
    };
  }
  if (interrupted > 0) {
    return {
      tone: "interrupted",
      title: "Mission stopped",
      detail: `${plural(interrupted, "lane")} stopped. No lanes are active. Next: review the audit evidence before resuming.`,
    };
  }
  return {
    tone: "done",
    title: "Mission complete",
    detail: `All ${plural(nodes.length, "lane")} finished successfully. Next: review captured memory and audit evidence.`,
  };
}

/**
 * S9 raise step: +10 minutes, hard-capped at the server's v2 ceiling
 * (8 descendants x 30 min). Returns null when a raise is impossible: v1
 * roots (no descendant pool — the route refuses) or already at the ceiling.
 * Pure + exported for tests.
 */
export function nextBudgetRaise(budget: DispatchBudget): number | null {
  if (budget.maxDescendantWallMs === null) return null;
  if (budget.maxDescendantWallMs >= DESCENDANT_POOL_CEILING_MS) return null;
  return Math.min(
    budget.maxDescendantWallMs + 600_000,
    DESCENDANT_POOL_CEILING_MS
  );
}

/**
 * Per-mission budget readout + the operator [Raise] act (two-step in-place
 * confirm, mirroring the chat-archive pattern: first press arms, second
 * fires). Numbers only; failures surface inline, never silently.
 */
function MissionBudgetControl(props: {
  rootJobId: string;
  /**
   * Cheap mission-state signature from the SAME jobs poll that drives the
   * sibling mission-limits line (descendants/reserved/status). The budget
   * refetches whenever it changes, so the readout can never freeze at its
   * mount value while the rail advances (review M1).
   */
  refreshKey: string;
  /** Terminal roots keep the readout but never a raise affordance (L2). */
  terminal: boolean;
}) {
  const [budget, setBudget] = useState<DispatchBudget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setArming(false);
    // Degrade to no readout when the preload bridge predates this API
    // (older packaged shell, minimal test harnesses) — never fake numbers.
    if (typeof window.muon?.getDispatchBudget !== "function") {
      setBudget(null);
      return () => {
        alive = false;
      };
    }
    // On a refresh (same root, new signature) keep the previous numbers on
    // screen until the new read lands — no flicker; a FAILED read still
    // clears them (stale numbers never survive a failed poll).
    window.muon
      .getDispatchBudget(props.rootJobId)
      .then((next) => {
        if (alive) {
          setBudget(next);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (alive) {
          setBudget(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      alive = false;
    };
  }, [props.rootJobId, props.refreshKey]);

  if (!budget) {
    return error ? (
      <div className="mission-budget">
        <span className="mission-budget-error">budget: {error}</span>
      </div>
    ) : null;
  }

  const raiseTo = props.terminal ? null : nextBudgetRaise(budget);
  const raise = async () => {
    if (!arming) {
      setArming(true);
      return;
    }
    if (raiseTo === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.muon.raiseDispatchBudget(
        props.rootJobId,
        raiseTo
      );
      if (aliveRef.current) {
        setBudget(next);
        setArming(false);
      }
    } catch (cause) {
      if (aliveRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        // Disarm after a failure: the next click re-arms against FRESH
        // numbers (the refreshKey refetch) instead of firing a stale target.
        setArming(false);
      }
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  return (
    <div className="mission-budget" aria-label="Mission descendant budget">
      <span className="mission-budget-numbers">
        {compactDuration(budget.remainingMs)} left of{" "}
        {compactDuration(budget.poolMs)} pool
      </span>
      <div className="mission-budget-meter" aria-hidden="true">
        <i
          style={{
            width: `${Math.max(
              0,
              Math.min(
                100,
                Math.round(
                  (budget.remainingMs / Math.max(budget.poolMs, 1)) * 100
                )
              )
            )}%`,
          }}
        />
      </div>
      {raiseTo !== null ? (
        <button
          className={`mission-budget-raise${arming ? " confirming" : ""}`}
          disabled={busy}
          onClick={() => void raise()}
        >
          {arming
            ? `Confirm +10 min (to ${compactDuration(raiseTo)})`
            : "Raise budget"}
        </button>
      ) : null}
      {error ? (
        <span className="mission-budget-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function MissionTree(props: { jobs: DispatchJobRecord[] }) {
  const forest = buildDispatchForest(props.jobs);
  return (
    <section className="mission-tree-section" aria-label="Mission and crew">
      <header>
        <span>Mission</span>
        <b>{forest.summary.active} active</b>
      </header>
      {forest.roots.length === 0 ? (
        <div className="rail-empty">Start a chat to see work here.</div>
      ) : (
        <>
          {forest.degraded ? (
            <div className="mission-degraded" role="alert">
              {forest.degradationReason}
            </div>
          ) : null}
          <div className="mission-list">
            {forest.missions.map(({ root, summary }) => {
              const terminalPosture = missionTerminalPosture(root, summary);
              return (
                <article className="mission-block" key={root.id}>
                  <div className="mission-root-heading">
                    <strong>{root.brief}</strong>
                    <span>{summary.active} active</span>
                  </div>
                  <div
                    className="mission-limits"
                    aria-label={`Delegation limits for ${root.brief}`}
                  >
                    <span>
                      Depth {summary.usedDepth} / {summary.maxDepth ?? "—"}
                    </span>
                    <span>
                      {summary.descendantsIssued} /{" "}
                      {summary.maxDescendants ?? "—"} descendants
                    </span>
                    <span>
                      {compactDuration(summary.reservedWallMs)} /{" "}
                      {summary.rootWallMs === null
                        ? "—"
                        : compactDuration(summary.rootWallMs)}{" "}
                      reserved
                    </span>
                  </div>
                  <MissionBudgetControl
                    rootJobId={root.id}
                    refreshKey={`${root.status}:${summary.active}:${summary.descendantsIssued}:${summary.reservedWallMs}`}
                    terminal={
                      root.status !== "queued" && root.status !== "running"
                    }
                  />
                  {terminalPosture ? (
                    <div
                      className={`mission-terminal ${terminalPosture.tone}`}
                      role={
                        terminalPosture.tone === "failed" ? "alert" : "status"
                      }
                    >
                      <strong>{terminalPosture.title}</strong>
                      <span>{terminalPosture.detail}</span>
                    </div>
                  ) : null}
                  <ul className="mission-tree" role="tree">
                    <DispatchTreeItem
                      node={root}
                      onRevokeGrants={
                        // Degrades to no control at all on an older preload,
                        // rather than a button that throws when pressed.
                        typeof window.muon?.revokeDispatchGrants === "function"
                          ? (jobId) =>
                              window.muon.revokeDispatchGrants({ jobId })
                          : undefined
                      }
                    />
                  </ul>
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

export function ControlRail(props: {
  approvals: ApprovalRequest[];
  /**
   * P0-1 — Full-Auto standing consent, plus the ids it IS actively granting
   * (covered — the only ids allowed the calm label) and the ids it is not.
   * Chooses which true sentence each inbox card shows; grants nothing.
   */
  fullAuto?: boolean;
  fullAutoCoveredApprovalIds?: string[];
  fullAutoUncoveredApprovalIds?: string[];
  proposals: WorkflowRunRecord[];
  jobs: DispatchJobRecord[];
  auditEvents?: RecordedEvent[];
  /** P0.4: live (unexpired, unrevoked) content-bound receipts, for the inbox line. */
  receipts?: ApprovalReceipt[];
  /**
   * #9: the active job's workspace review (same shape/IPC the center's
   * Changes tab uses), rendered as a compact file-change readout in the
   * Review section. Optional + nullable — undefined/null/degraded all just
   * render nothing (never a dead/broken block).
   */
  workspaceReview?: WorkspaceReview | null;
  focusApprovalId?: string | null;
  onReviewApproval?: (approvalId: string | null) => void;
  onLoadMergeReview?: (
    approvalId: string
  ) => Promise<ReviewCoverageCertification>;
  onResolveApproval: (
    approvalId: string,
    status: "approved" | "rejected",
    receiptTtlMs?: number,
    manualReview?: ManualReviewAttestation
  ) => void | Promise<void>;
  onApplyProposal: (runId: string) => void;
  onDismissProposal: (runId: string) => void;
  onOpenMemory: () => void;
  /** Quiet workspace: which sections render, so Crew/Control/Timeline can each
   *  be a separate contextual panel. Default is all three (back-compat). */
  sections?: ReadonlyArray<"review" | "mission" | "activity">;
}) {
  const sections = props.sections ?? (["review", "mission", "activity"] as const);
  const audit = buildAuditTrail(props.auditEvents ?? []);
  const reviewApproval =
    props.approvals.find(
      (approval) => approval.id === props.focusApprovalId
    ) ?? null;
  const activeReceipts = props.receipts ?? [];
  // Newest policy/receipt auto-allow: every non-human allow stays visible.
  const lastAutoApproval = (props.auditEvents ?? []).find(
    (event) => event.kind === "approval.auto"
  );
  // TODO 5.16: at most ONE approvable card. Same-job siblings fold into it;
  // everything else waits as a count, never as a second Approve surface.
  const inbox = selectOneApprovableCard(
    props.approvals,
    props.focusApprovalId
  );

  return (
    <>
      <aside className="control-rail" aria-label="Review, mission, and activity">
      {sections.includes("review") ? (
      <section>
        <header>
          <span>Review</span>
          <b>
            {(inbox.primary ? 1 : 0) +
              inbox.queued.length +
              props.proposals.length}
          </b>
        </header>
        {!inbox.primary && props.proposals.length === 0 ? (
          <div className="rail-empty saas-empty">
            <strong>You&apos;re clear</strong>
            <span>Nothing needs you right now.</span>
          </div>
        ) : null}
        {activeReceipts.length > 0 || lastAutoApproval ? (
          <div className="receipt-status">
            {activeReceipts.length} receipt
            {activeReceipts.length === 1 ? "" : "s"} active · last
            auto-approval:{" "}
            {lastAutoApproval ? lastAutoApproval.message : "none yet"}
          </div>
        ) : null}
        <DockChanges review={props.workspaceReview} />
        {inbox.primary ? (
          <ApprovalItem
            key={inbox.primary.id}
            approval={inbox.primary}
            folded={inbox.folded}
            queuedCount={inbox.queued.length}
            autoApproving={
              props.fullAuto === true &&
              (props.fullAutoCoveredApprovalIds ?? []).includes(
                inbox.primary.id
              ) &&
              !(props.fullAutoUncoveredApprovalIds ?? []).includes(
                inbox.primary.id
              )
            }
            onReview={() => props.onReviewApproval?.(inbox.primary!.id)}
            // Two-arg call when nothing is being remembered keeps the governed
            // decision payload (and the pinned call-shape tests) byte-identical
            // to the plain approve path.
            onResolve={(status, receiptTtlMs) =>
              receiptTtlMs === undefined
                ? props.onResolveApproval(inbox.primary!.id, status)
                : props.onResolveApproval(
                    inbox.primary!.id,
                    status,
                    receiptTtlMs
                  )
            }
          />
        ) : null}
        {props.proposals.slice(0, 1).map((proposal) => (
          <details className="inbox-card proposal-review" key={proposal.id}>
            <summary>
              <span className="inbox-kicker">Workflow proposal</span>
              <strong>{proposal.request}</strong>
              <span>
                Review workflow proposal · {proposal.proposal.steps.length} step
                {proposal.proposal.steps.length === 1 ? "" : "s"}
              </span>
            </summary>
            <div className="proposal-review-body">
              <p className="proposal-summary">{proposal.proposal.summary}</p>
              <ol>
                {proposal.proposal.steps.map((step, index) => (
                  <li key={step.stepKey}>
                    <div>
                      <span className="proposal-step-title">
                        <span className="proposal-step-index">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <strong>{step.title}</strong>
                      </span>
                      <span>{step.priority} priority</span>
                    </div>
                    <p>{step.brief}</p>
                    <dl>
                      <div>
                        <dt>Crew member</dt>
                        <dd>{step.laneKey ?? step.role}</dd>
                      </div>
                      <div>
                        <dt>Mode</dt>
                        <dd>{step.harnessKey ?? "default"}</dd>
                      </div>
                      <div>
                        <dt>Loop</dt>
                        <dd>
                          {step.loop
                            ? `${step.loop.kind} · ${step.loop.maxIterations} iterations`
                            : "none"}
                        </dd>
                      </div>
                      <div>
                        <dt>Approval</dt>
                        <dd>{step.gate ?? "none"}</dd>
                      </div>
                      <div>
                        <dt>Handoff</dt>
                        <dd>{step.handoffTo ?? "terminal"}</dd>
                      </div>
                      <div>
                        <dt>On failure</dt>
                        <dd>{step.onFail}</dd>
                      </div>
                    </dl>
                    {step.laneReason ? (
                      <small>Routing evidence: {step.laneReason}</small>
                    ) : null}
                  </li>
                ))}
              </ol>
              <p className="proposal-authority-note">
                Nothing runs until you apply this exact plan.
              </p>
              <div className="inbox-actions">
                <button
                  className="approve"
                  onClick={() => props.onApplyProposal(proposal.id)}
                >
                  Apply proposal
                </button>
                <button onClick={() => props.onDismissProposal(proposal.id)}>
                  Dismiss proposal
                </button>
              </div>
            </div>
          </details>
        ))}
        <button className="memory-review-button" onClick={props.onOpenMemory}>
          Open memory
        </button>
      </section>
      ) : null}

      {sections.includes("mission") ? (
        <MissionTree jobs={props.jobs} />
      ) : null}

      {sections.includes("activity") ? (
      <section className="activity-section" aria-label="Activity log">
        <header>
          <span>Activity</span>
          <b>{audit.length}</b>
        </header>
        {/* The provenance caveat is a property of the whole log, so it is
            stated once here instead of repeated verbatim under all twelve
            rows. The claim is unchanged: every line below is what an agent
            reported, held as data and never as an instruction. */}
        {audit.length > 0 ? (
          <p className="activity-provenance">
            Reported by the agent · treated as data
          </p>
        ) : null}
        {audit.length === 0 ? (
          <div className="rail-empty saas-empty">
            <strong>No activity yet</strong>
            <span>Activity appears after the first task on this mission.</span>
          </div>
        ) : (
          audit.slice(0, 12).map((entry) => (
            <article className={`audit-row ${entry.tone}`} key={entry.id}>
              <span className={`activity-dot ${entry.tone}`} aria-hidden="true" />
              <div className="audit-copy">
                <strong>
                  {entry.actor} · {entry.headline}
                </strong>
                <p>{entry.detail}</p>
                <small>
                  {entry.timestamp.slice(11, 16)} · task {entry.taskId.slice(-8)}
                </small>
              </div>
            </article>
          ))
        )}
      </section>
      ) : null}
      </aside>
      {reviewApproval ? (
        <ApprovalReviewDialog
          key={reviewApproval.id}
          approval={reviewApproval}
          onLoadMergeReview={
            reviewApproval.kind === "merge" && props.onLoadMergeReview
              ? () => props.onLoadMergeReview!(reviewApproval.id)
              : undefined
          }
          onClose={() => props.onReviewApproval?.(null)}
          onResolve={async (status, receiptTtlMs, manualReview) => {
            // Two-arg call when no opt-in keeps the decision payload (and the
            // pinned call-shape tests) byte-identical to today.
            if (manualReview) {
              await props.onResolveApproval(
                reviewApproval.id,
                status,
                receiptTtlMs,
                manualReview
              );
            } else if (receiptTtlMs !== undefined) {
              await props.onResolveApproval(
                reviewApproval.id,
                status,
                receiptTtlMs
              );
            } else {
              await props.onResolveApproval(reviewApproval.id, status);
            }
            // Only a successful decision closes the dialog; a rejected promise
            // is caught inside the dialog and rendered as the reason.
            props.onReviewApproval?.(null);
          }}
        />
      ) : null}
    </>
  );
}
