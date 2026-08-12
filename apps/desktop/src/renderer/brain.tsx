import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { DispatchJobRecord, RecordedEvent } from "@muon/client";
import { vendorLabel } from "@muon/client/vendors";
// SUBPATH, not the aggregate barrel: this is renderer code, and the
// architecture-fitness test forbids pulling a Node barrel in here.
import { buildMemoryDecision } from "@muon/client/memory-decision";
import type { DataBoundaryResponse } from "../shared/ipc.js";
import {
  MISSION_EVIDENCE_SECTIONS,
  buildMissionEvidence,
  filterMissionEvidence,
  type MissionEvidence,
  type MissionEvidenceItem,
} from "../lib/mission-evidence.js";

/**
 * U3 — job status in operator language. Mirrors the agent tab's own wording so
 * one mission cannot describe the same job two different ways on two surfaces.
 */
function jobStatusLabel(status?: string | null): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Working";
    case "done":
      return "Done";
    case "failed":
      return "Needs attention";
    case "interrupted":
      return "Stopped";
    default:
      return status ?? "Unknown";
  }
}

// ROADMAP 4.1b — the data_boundaries migration-risk line on the pre-edit Brain.
// Given the declared edit target file, surfaces which datastore tables it writes
// and — the point — how many OTHER files write each shared table (a schema/shape
// change is a migration touching them all). Lazy + silent when the file touches
// no table (most don't) or isn't a real path (symbols/fingerprints are skipped).
function MigrationRiskLine(props: { file: string | undefined }) {
  const [state, setState] = useState<"idle" | "loading" | DataBoundaryResponse>(
    "idle"
  );
  const file = props.file;
  useEffect(() => {
    // Only real repo-relative file paths — never a symbol or a fingerprint —
    // and only when the bridge is present (BrainContent renders bare in tests).
    if (
      !file ||
      !/[/.]/.test(file) ||
      /^module-[0-9a-f]+$/.test(file) ||
      typeof window === "undefined" ||
      !window.muon?.dataBoundaries
    ) {
      setState("idle");
      return;
    }
    let stopped = false;
    setState("loading");
    void window.muon
      .dataBoundaries({ file })
      .then((result) => {
        if (!stopped) setState(result);
      })
      .catch(() => {
        if (!stopped) setState({ status: "degraded", reason: "unavailable" });
      });
    return () => {
      stopped = true;
    };
  }, [file]);

  if (state === "idle" || state === "loading" || state.status === "degraded") {
    return null;
  }
  const boundary = state.boundary;
  if (!boundary.hasDataBoundary) return null;
  const shared = boundary.tables.filter((t) => t.shared);
  return (
    <div className={`brain-migration-risk${shared.length > 0 ? " shared" : ""}`}>
      <span className="brain-label">Data boundary</span>
      <p>
        Writes <code>{boundary.tables.map((t) => t.table).join(", ")}</code>.
        {shared.length > 0 ? (
          <>
            {" "}
            {shared.length} shared table
            {shared.length === 1 ? "" : "s"} — a schema/shape change is a{" "}
            <strong>migration</strong> touching{" "}
            {shared
              .map((t) => `${t.table} (${t.writerCount} writers)`)
              .join(", ")}
            .
          </>
        ) : null}
      </p>
    </div>
  );
}
import {
  buildConvergencePreflight,
  type ConvergencePreflight,
  type ConvergenceSection,
} from "@muon/client/convergence-preflight";
// Pure subpath (no node built-ins) so the browser renderer bundle stays clean.
import {
  buildPreEditView,
  parseEditTarget,
  type PreEditClient,
  type PreEditTargetInput,
  type PreEditView,
} from "@muon/client/preedit-view";
import type { MemoryLibrarySnapshot } from "@muon/client/memory-library";
import { MemoryWorkspace } from "./memory-workspace.js";

/**
 * P6a, the human pre-edit ("Brain") surface (the hero's human-facing arm).
 *
 * Enter a symbol or file/module → MUON fuses its code blast-radius with the
 * GOVERNED (human-confirmed) memory anchored to it and renders prior decisions
 * (on-target first, WITH text, they are trusted), contradiction warnings, and
 * pending PROPOSES_SUPERSEDE proposals as ACTIONABLE items.
 *
 * TRUST DISCIPLINE: a proposal is existence-only until the human clicks "View
 * text", which fetches its (untrusted) text ON DEMAND via the operator-tier
 * note-by-id path, never auto-injected. "Confirm"/"Reject" go through the
 * operator-tier KG-6 route, then the panel refreshes. Everything runs over the
 * OPERATOR client in the main process (P3-A: the human surface holds it).
 *
 * P6, HERO AUTO-CONTEXT: when opened during a real dispatch, the surface derives
 * its target from the ACTIVE task's touched modules/symbols (via main's
 * `autoContext`) and pre-fills itself, so the moat surfaces automatically. Manual
 * entry still works, and it falls back to it when there's no active task.
 *
 * Task #130/#132: Memory & Evidence used to be a single cramped modal
 * (BrainPanel, with an internal "context"/"memory" tab strip). That modal is
 * RETIRED — `useBrainState` now holds every bit of state/IPC verbatim (the
 * operationEpoch/mounted-guard request-fencing is untouched), and two thin
 * presentational surfaces sit on top of it: `EvidencePanel` (the search form +
 * auto-context note + errors + the full evidence view) and `MemoryPanel` (the
 * existing MemoryWorkspace). Both are mounted as first-class, closable CENTER
 * workspace tabs (app.tsx + workspace-tabs.tsx), alongside "Mission chat" and
 * the jobId subagent tabs — never as a modal, never blocking the rest of the
 * workspace.
 */

// Adapter: the shared PreEditClient over the IPC bridge, so the desktop renders
// from the exact same helpers as the TUI and CLI (one truth).
const brainClient: PreEditClient = {
  preEditContext: (input) => window.muon.preEditContext(input),
  getMemoryNote: (noteId) => window.muon.getMemoryNote(noteId),
  updateMemoryNote: (input) => window.muon.updateMemoryNote(input),
};

function humanChipLabel(chip: string): string {
  const exact: Record<string, string> = {
    "principal:human": "You",
    "principal:agent": "Agent",
    "principal:not-supplied": "User unavailable",
    "runner:live": "Runner ready",
    "runner:not-supplied": "Runner unavailable",
    sandboxed: "Sandbox on",
    unsandboxed: "Sandbox off",
    "sandbox:not-supplied": "Sandbox unknown",
    warning: "Needs review",
    attention: "Review",
    info: "Info",
  };
  if (exact[chip]) return exact[chip];
  if (chip.startsWith("depth:")) return `Depth ${chip.slice(6)}`;
  return chip;
}

function ConvergenceSectionCard(props: {
  section: ConvergenceSection;
  children: ReactNode;
  /** Hide the summary line when children already present it (e.g. Intent target). */
  hideSummary?: boolean;
  /** Max chips before "+N more". Defaults to 4 so status chips stay readable. */
  chipLimit?: number;
}) {
  const headingId = useId();
  const chipLimit = props.chipLimit ?? 4;
  const visibleChips = props.section.chips.slice(0, chipLimit);
  const hiddenChipCount = props.section.chips.length - visibleChips.length;
  return (
    <section
      className={`convergence-section ${props.section.key}${
        props.hideSummary ? " compact" : ""
      }`}
      aria-labelledby={headingId}
    >
      <div className="convergence-section-head">
        <h2 id={headingId} className="convergence-section-title">
          {props.section.title}
        </h2>
        <span className="convergence-count">{props.section.count}</span>
      </div>
      {!props.hideSummary ? (
        <div className="convergence-section-summary">
          {props.section.summary}
        </div>
      ) : null}
      {props.section.chips.length > 0 ? (
        <div className="convergence-chips">
          {visibleChips.map((chip, index) => (
            <span
              key={`${props.section.key}:${chip}:${index}`}
              className="brain-chip subtle"
            >
              {humanChipLabel(chip)}
            </span>
          ))}
          {hiddenChipCount > 0 ? (
            <span className="convergence-more">+{hiddenChipCount} more</span>
          ) : null}
        </div>
      ) : null}
      <div className="convergence-section-body">{props.children}</div>
    </section>
  );
}

export function BrainContent(props: {
  view: PreEditView;
  preflight: ConvergencePreflight;
  proposalText: Record<string, string | undefined>;
  acting: string | null;
  onViewProposal: (proposalNoteId: string) => Promise<void>;
  onAdjudicate: (
    proposalNoteId: string,
    decision: "confirm" | "reject"
  ) => Promise<void>;
}) {
  const nextAction = props.preflight.nextActions[0];
  const postureLabel = {
    clear: "Ready",
    coordinate: "Coordinate",
    "human-review": "Review needed",
    degraded: "Limited evidence",
  }[props.preflight.posture];
  const memoryById = new Map(
    props.view.memories.map((memory) => [memory.note.id, memory])
  );
  const warningRows = props.preflight.authority.rows.filter((row) =>
    row.id.startsWith("warning:")
  );
  // Task #130: evidence now lives in a full-height workspace tab, not a
  // cramped modal — long lists just scroll, so every module/symbol/evidence/
  // coordination row renders (no numeric cap, no "N more omitted" overflow).
  const targetSymbol = props.view.target.symbol;
  const orderedSymbols = targetSymbol
    ? [
        targetSymbol,
        ...props.view.blastRadius.symbols.filter(
          (symbol) => symbol !== targetSymbol
        ),
      ]
    : props.view.blastRadius.symbols;
  const orderedEvidenceRows = [
    ...props.preflight.evidence.rows.filter(
      (row) =>
        targetSymbol !== undefined &&
        memoryById.get(row.id)?.note.symbols.includes(targetSymbol)
    ),
    ...props.preflight.evidence.rows.filter(
      (row) =>
        targetSymbol === undefined ||
        !memoryById.get(row.id)?.note.symbols.includes(targetSymbol)
    ),
  ];
  const orderedCoordinationRows = [
    ...props.preflight.coordination.rows.filter(
      (row) => row.severity === "warning"
    ),
    ...props.preflight.coordination.rows.filter(
      (row) => row.severity !== "warning"
    ),
  ];

  return (
    <div className="brain-body">
      <div
        className={`convergence-posture posture-${props.preflight.posture}`}
      >
        <span className="brain-chip">{postureLabel}</span>
        <div className="convergence-posture-copy">
          <strong>{props.preflight.headline}</strong>
          {nextAction ? (
            <span>
              {nextAction.label}, {nextAction.reason}
            </span>
          ) : null}
        </div>
      </div>

      <div className="convergence-grid">
        <ConvergenceSectionCard section={props.preflight.intent} hideSummary>
          <div className="brain-intent-target">
            <code>{props.preflight.intent.summary}</code>
          </div>
          <div className="brain-empty">
            Review the declared edit target before changing code.
          </div>
        </ConvergenceSectionCard>

        <ConvergenceSectionCard section={props.preflight.evidence}>
          <div
            className={`brain-radius${
              props.view.blastRadius.degraded ? " degraded" : ""
            }`}
          >
            <div className="brain-radius-head">
              <span className="brain-label">Affected code</span>
              {/* Chips already carry the degraded source label; only restate
                  it when the radius is healthy so the section stays scannable. */}
              {!props.view.blastRadius.degraded ? (
                <span className="brain-source">
                  {props.view.blastRadius.sourceLabel}
                </span>
              ) : null}
            </div>
            {props.view.blastRadius.modules.length > 0 ? (
              <ul
                className="brain-coordinate-list"
                aria-label="Blast-radius modules"
              >
                {props.view.blastRadius.modules.map((module) => (
                  <li key={`module:${module}`}>
                    <span className="brain-coord-kind">File</span>
                    <code>{module}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            {orderedSymbols.length > 0 ? (
              <ul
                className="brain-coordinate-list"
                aria-label="Blast-radius symbols"
              >
                {orderedSymbols.map((symbol) => (
                  <li key={`symbol:${symbol}`}>
                    <span className="brain-coord-kind">Symbol</span>
                    <code>{symbol}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            <MigrationRiskLine file={props.view.target.module} />
          </div>

          <div className="brain-evidence-memory">
            <span className="brain-label">Trusted memory</span>
            {props.preflight.evidence.rows.length === 0 ? (
              <div className="brain-empty">
                No memory is linked to this change yet.
              </div>
            ) : (
              <ul className="brain-list">
                {orderedEvidenceRows.map((row) => {
                  const memory = memoryById.get(row.id);
                  return (
                    <li
                      key={row.id}
                      className={`brain-mem ${
                        memory?.proximityLabel ?? "neighbor"
                      }`}
                    >
                      <span
                        className={`brain-chip ${
                          row.severity === "attention" ? "warn" : ""
                        }`}
                      >
                        {row.label}
                      </span>
                      {memory ? (
                        <span className="brain-chip subtle">
                          {memory.note.trust}
                        </span>
                      ) : null}
                      {row.trustedText && row.detail ? (
                        <span className="brain-mem-text">{row.detail}</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </ConvergenceSectionCard>

        <ConvergenceSectionCard section={props.preflight.coordination}>
          {props.preflight.coordination.rows.length === 0 ? (
            <div className="brain-empty">
              No overlapping work.
            </div>
          ) : (
            <ul className="brain-list">
              {orderedCoordinationRows.map((row) => (
                <li key={row.id} className="convergence-row">
                  <span
                    className={`brain-chip ${
                      row.severity === "warning" ? "warn" : "subtle"
                    }`}
                  >
                    {humanChipLabel(row.severity)}
                  </span>
                  <span>{row.label}</span>
                </li>
              ))}
            </ul>
          )}
        </ConvergenceSectionCard>

        <ConvergenceSectionCard section={props.preflight.authority}>
          {warningRows.length > 0 ? (
            <ul className="brain-list">
              {warningRows.map((row) => (
                <li key={row.id} className="brain-warn">
                  <span className="brain-chip warn">{row.label}</span>
                  {row.detail ? <span>{row.detail}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {props.view.pendingCount === 0 ? (
            <div className="brain-empty">Nothing to confirm.</div>
          ) : (
            <ul className="brain-list">
              {props.view.pendingProposals.map((proposal) => {
                const row = props.preflight.authority.rows.find(
                  (candidate) =>
                    candidate.id === `proposal:${proposal.proposalNoteId}`
                );
                const text = props.proposalText[proposal.proposalNoteId];
                const busy = props.acting !== null;
                const informed = text !== undefined && text !== "…";
                return (
                  <li key={proposal.proposalNoteId} className="brain-proposal">
                    <div className="brain-proposal-line">
                      {row?.label ?? proposal.summary}
                    </div>
                    <div className="brain-proposal-ids">
                      {proposal.proposalNoteId} contests{" "}
                      {proposal.victimNoteId}
                    </div>
                    {text !== undefined ? (
                      // Untrusted text, shown ONLY after the human asked for it.
                      <div className="brain-proposal-text">{text}</div>
                    ) : null}
                    <div className="brain-proposal-actions">
                      <button
                        className="ghost-btn"
                        disabled={busy || text !== undefined}
                        onClick={() =>
                          void props.onViewProposal(proposal.proposalNoteId)
                        }
                      >
                        View proposal
                      </button>
                      <button
                        className="primary-btn"
                        disabled={busy || !informed}
                        onClick={() =>
                          void props.onAdjudicate(
                            proposal.proposalNoteId,
                            "confirm"
                          )
                        }
                      >
                        Confirm
                      </button>
                      <button
                        className="ghost-btn"
                        disabled={busy || !informed}
                        onClick={() =>
                          void props.onAdjudicate(
                            proposal.proposalNoteId,
                            "reject"
                          )
                        }
                      >
                        Reject
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {props.view.notices.length > 0 ? (
            <div className="brain-notices" aria-label="Evidence notices">
              {props.view.notices.map((notice) => (
                <div key={notice} className="brain-notice">
                  {notice}
                </div>
              ))}
            </div>
          ) : null}
        </ConvergenceSectionCard>
      </div>
    </div>
  );
}

/**
 * Task #130: every bit of BrainPanel's former state/IPC, lifted VERBATIM out
 * of the old modal component — the operationEpoch/mounted-guard request
 * fencing (stale-response suppression, single-flight adjudication, auto-
 * context vs. manual-intent races) is untouched, just relocated. `EvidencePanel`
 * and `MemoryPanel` each call this hook independently: since only the ACTIVE
 * workspace tab mounts at a time (mirroring how only the active jobId subagent
 * tab's SessionWorkspace mounts — see app.tsx), there is never a moment where
 * two instances of this hook are alive for the same human-visible surface, so
 * per-surface state is exactly as fresh (or as persistent while a tab stays
 * open) as the old per-open-modal-mount behavior was.
 */
function useBrainState(
  activeTaskId: string | null | undefined,
  // FIX 6: whether THIS surface renders the pre-edit `view` and so needs the
  // auto-context computation below. EvidencePanel passes true; MemoryPanel
  // passes false — it never renders `view`, so running the dual-graph gate
  // (autoContext + preEditContext) on every mount / activeTaskId change was
  // pure wasted work whose result was discarded. False skips it entirely; the
  // library path (loadLibrary/decideMemory) is unaffected.
  withContext: boolean,
  chatId?: string
) {
  const [target, setTarget] = useState("");
  const [view, setView] = useState<PreEditView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [autoLabel, setAutoLabel] = useState<string | null>(null);
  // Proposal text fetched ON DEMAND, keyed by proposalNoteId (never auto-loaded).
  const [proposalText, setProposalText] = useState<
    Record<string, string | undefined>
  >({});
  const [acting, setActing] = useState<string | null>(null);
  const [library, setLibrary] = useState<MemoryLibrarySnapshot | null>(null);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  // R3 TTL. `showExpired` is a SERVER parameter on the governed library read
  // (operator-tier, silently downgraded for agent callers) — never a renderer
  // filter — so flipping it re-asks the backend, exactly like `muon memory
  // library --show-expired` and the TUI's toggle do. Default OFF.
  const [showExpired, setShowExpired] = useState(false);
  // How many notes the CURRENT query hides because they lapsed; null when
  // unknown (never probed / the probe failed). Only ever used to make the empty
  // state honest — never to render a note the operator did not ask for.
  const [hiddenExpiredCount, setHiddenExpiredCount] = useState<number | null>(
    null
  );
  const [expiredProbing, setExpiredProbing] = useState(false);
  // Single-flight fence for the library: a toggle flap or a fast second search
  // must not let an older response repaint a newer posture (the badge/empty
  // copy are derived from the pair, so a crossed response would lie).
  const libraryRequestRef = useRef(0);
  // The exact input that produced the current view (a typed target OR the active
  // task's auto-context), used to REFRESH after an adjudication.
  const lastInputRef = useRef<PreEditTargetInput | null>(null);
  const loadedTargetRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const operationEpochRef = useRef(0);
  const proposalRequestSequenceRef = useRef(0);
  const proposalRequestsRef = useRef(new Map<string, number>());
  const resolvedProposalIdsRef = useRef(new Set<string>());
  const actingRef = useRef<string | null>(null);

  useEffect(() => {
    const proposalRequests = proposalRequestsRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationEpochRef.current += 1;
      proposalRequests.clear();
      actingRef.current = null;
    };
  }, []);

  const loadContext = useCallback(
    async (
      input: PreEditTargetInput,
      label: string,
      epoch: number,
      mode: "intent" | "refresh"
    ) => {
      const isCurrent = () =>
        mountedRef.current && operationEpochRef.current === epoch;
      if (!isCurrent()) {
        return false;
      }
      setLoading(true);
      if (mode === "intent") {
        setError(null);
        setRefreshError(null);
        setProposalText({});
      } else {
        setRefreshError(null);
        setProposalText((current) => {
          const pending = Object.entries(current).filter(
            ([, text]) => text === "…"
          );
          if (pending.length === 0) {
            return current;
          }
          const next = { ...current };
          for (const [proposalNoteId] of pending) {
            delete next[proposalNoteId];
          }
          return next;
        });
      }
      try {
        const context = await brainClient.preEditContext(
          chatId ? { ...input, chatId } : input
        );
        if (!isCurrent()) {
          return false;
        }
        let nextView = buildPreEditView(context);
        if (
          nextView.phase === "ready" &&
          resolvedProposalIdsRef.current.size > 0
        ) {
          const pendingProposals = nextView.pendingProposals.filter(
            (proposal) =>
              !resolvedProposalIdsRef.current.has(proposal.proposalNoteId)
          );
          nextView = {
            ...nextView,
            pendingProposals,
            pendingCount: pendingProposals.length,
          };
        }
        loadedTargetRef.current = label;
        lastInputRef.current = input;
        setView(nextView);
        return true;
      } catch (caught) {
        if (!isCurrent()) {
          return false;
        }
        const message =
          caught instanceof Error ? caught.message : "Pre-edit context failed.";
        if (mode === "refresh") {
          setRefreshError(
            `Proposal resolved, but context refresh failed: ${message}`
          );
        } else {
          setError(message);
        }
        return false;
      } finally {
        if (isCurrent()) {
          setLoading(false);
        }
      }
    },
    [chatId]
  );

  const load = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      const epoch = ++operationEpochRef.current;
      proposalRequestsRef.current.clear();
      resolvedProposalIdsRef.current.clear();
      // A manual load clears the auto-context note.
      setAutoLabel(null);
      await loadContext(parseEditTarget(trimmed), trimmed, epoch, "intent");
    },
    [loadContext]
  );

  // On open, auto-populate from the ACTIVE task's touched modules/symbols. Falls
  // back silently to manual entry when there's no active task / nothing touched.
  // FIX 6: only a surface that renders `view` (EvidencePanel, withContext=true)
  // needs this — MemoryPanel (withContext=false) never shows it, so it skips the
  // whole autoContext/preEditContext gate rather than computing a discarded
  // result on every activeTaskId change. The effect stays registered (hooks
  // order is stable); it just no-ops for the memory surface.
  useEffect(() => {
    if (!withContext) {
      return;
    }
    const epoch = ++operationEpochRef.current;
    proposalRequestsRef.current.clear();
    resolvedProposalIdsRef.current.clear();
    const taskId = activeTaskId;
    void (async () => {
      await Promise.resolve();
      if (
        !mountedRef.current ||
        operationEpochRef.current !== epoch
      ) {
        return;
      }
      setAutoLabel(null);
      setLoading(false);
      setError(null);
      setRefreshError(null);
      setProposalText({});
      if (!taskId) {
        return;
      }
      const auto = await window.muon
        .autoContext(taskId)
        .catch(() => null);
      if (
        !mountedRef.current ||
        !auto ||
        operationEpochRef.current !== epoch
      ) {
        return;
      }
      setTarget(auto.input.module ?? auto.input.symbol ?? "");
      setAutoLabel(auto.label);
      await loadContext(auto.input, auto.label, epoch, "intent");
    })();
  }, [activeTaskId, loadContext, withContext]);

  const viewProposalText = useCallback(async (proposalNoteId: string) => {
    if (!mountedRef.current) {
      return;
    }
    const epoch = operationEpochRef.current;
    const requestId = ++proposalRequestSequenceRef.current;
    proposalRequestsRef.current.set(proposalNoteId, requestId);
    const isCurrent = () =>
      mountedRef.current &&
      operationEpochRef.current === epoch &&
      !resolvedProposalIdsRef.current.has(proposalNoteId) &&
      proposalRequestsRef.current.get(proposalNoteId) === requestId;
    setProposalText((current) => ({ ...current, [proposalNoteId]: "…" }));
    try {
      const note = await brainClient.getMemoryNote(proposalNoteId);
      if (!isCurrent()) {
        return;
      }
      setProposalText((current) => ({
        ...current,
        [proposalNoteId]: note.text,
      }));
    } catch {
      if (!isCurrent()) {
        return;
      }
      setProposalText((current) => {
        const next = { ...current };
        delete next[proposalNoteId];
        return next;
      });
    } finally {
      if (proposalRequestsRef.current.get(proposalNoteId) === requestId) {
        proposalRequestsRef.current.delete(proposalNoteId);
      }
    }
  }, []);

  const adjudicate = useCallback(
    async (proposalNoteId: string, decision: "confirm" | "reject") => {
      if (!mountedRef.current || actingRef.current !== null) {
        return;
      }
      const epoch = operationEpochRef.current;
      actingRef.current = proposalNoteId;
      setActing(proposalNoteId);
      setError(null);
      setRefreshError(null);
      try {
        // The SHARED payload builder — the rule about which fields a reject
        // must carry lives in one function now, not in four comments.
        await brainClient.updateMemoryNote(
          buildMemoryDecision(
            proposalNoteId,
            decision === "confirm" ? "confirm" : "reject"
          )
        );
        if (
          !mountedRef.current ||
          operationEpochRef.current !== epoch
        ) {
          return;
        }
        resolvedProposalIdsRef.current.add(proposalNoteId);
        proposalRequestsRef.current.delete(proposalNoteId);
        setProposalText((current) => {
          if (!(proposalNoteId in current)) {
            return current;
          }
          const next = { ...current };
          delete next[proposalNoteId];
          return next;
        });
        setView((current) => {
          if (!current || current.phase !== "ready") {
            return current;
          }
          const pendingProposals = current.pendingProposals.filter(
            (proposal) => proposal.proposalNoteId !== proposalNoteId
          );
          if (pendingProposals.length === current.pendingProposals.length) {
            return current;
          }
          return {
            ...current,
            pendingProposals,
            pendingCount: pendingProposals.length,
          };
        });

        const refreshInput = lastInputRef.current;
        if (refreshInput) {
          await loadContext(
            refreshInput,
            loadedTargetRef.current ?? "",
            epoch,
            "refresh"
          );
        }
      } catch (caught) {
        if (
          mountedRef.current &&
          operationEpochRef.current === epoch
        ) {
          const message =
            caught instanceof Error
              ? caught.message
              : "Memory decision failed.";
          setError(`Memory decision failed: ${message}`);
        }
      } finally {
        if (actingRef.current === proposalNoteId) {
          actingRef.current = null;
          if (mountedRef.current) {
            setActing(null);
          }
        }
      }
    },
    [loadContext]
  );

  const loadLibrary = useCallback(
    async (options?: { showExpired?: boolean }) => {
      // The caller may override the posture for THIS request (the toggle sets
      // state and loads in the same tick, so the closure's copy is stale).
      const wantExpired = options?.showExpired ?? showExpired;
      const request = ++libraryRequestRef.current;
      const fresh = () =>
        mountedRef.current && libraryRequestRef.current === request;
      setLibraryLoading(true);
      setLibraryError(null);
      setExpiredProbing(false);
      const query = {
        q: libraryQuery.trim() || undefined,
        chatId,
        status: "all" as const,
        confirmed: "all" as const,
        showExpired: wantExpired,
      };
      try {
        const snapshot = await window.muon.memoryLibrary({
          ...query,
          limit: 200,
        });
        if (!fresh()) return;
        setLibrary(snapshot);
        if (wantExpired || snapshot.notes.length > 0) {
          // Nothing to disambiguate: either the lapsed notes are already in
          // hand, or there is a visible library to read.
          setHiddenExpiredCount(null);
          return;
        }
        // EMPTY-STATE HONESTY: the default read returns only LIVE notes, so an
        // all-expired brain is indistinguishable from an empty one. Ask the
        // SAME governed read once more — bounded to `limit: 1`, and only the
        // COUNT is kept — so the empty state can say WHY it is empty instead of
        // shrugging. Deliberately confined to the empty case: it must never
        // become a second full fetch on every library load.
        setExpiredProbing(true);
        try {
          const probe = await window.muon.memoryLibrary({
            ...query,
            showExpired: true,
            limit: 1,
          });
          if (!fresh()) return;
          setHiddenExpiredCount(Math.max(0, probe.total - snapshot.total));
        } catch {
          // A failed probe is not a library failure — the list loaded fine.
          // Fall back to the generic empty copy, which still points at the
          // toggle, rather than raising an error the user cannot act on.
          if (fresh()) setHiddenExpiredCount(null);
        } finally {
          if (fresh()) setExpiredProbing(false);
        }
      } catch (caught) {
        if (fresh()) {
          setLibraryError(
            caught instanceof Error
              ? caught.message
              : "The memory library could not be loaded."
          );
        }
      } finally {
        if (fresh()) setLibraryLoading(false);
      }
    },
    [chatId, libraryQuery, showExpired]
  );

  /** Flip the operator TTL posture and re-ask the backend in one action — the
   *  toggle is meaningless without the refetch, so they are never separable. */
  const toggleShowExpired = useCallback(
    (next: boolean) => {
      setShowExpired(next);
      void loadLibrary({ showExpired: next });
    },
    [loadLibrary]
  );

  const decideMemory = useCallback(
    async (
      noteId: string,
      decision:
        | "confirm"
        | "reject"
        | "pause"
        | "resume"
        | "pin"
        | "unpin"
        | "delete"
    ) => {
      setLibraryError(null);
      try {
        if (decision === "delete") {
          if (
            !window.confirm(
              "Permanently forget this memory? Its text will be tombstoned and cannot be restored."
            )
          ) {
            return;
          }
          await window.muon.deleteMemoryNote(noteId);
          await loadLibrary();
          return;
        }
        // The SHARED payload builder — behaviour-identical to the literal it
        // replaced, including `principal` on pin/unpin, which the ledger
        // enforces as a human-authority check on that branch.
        await window.muon.updateMemoryNote(buildMemoryDecision(noteId, decision));
        await loadLibrary();
      } catch (caught) {
        setLibraryError(
          caught instanceof Error
            ? caught.message
            : "The memory decision could not be recorded."
        );
      }
    },
    [loadLibrary]
  );

  const preflight =
    view && view.phase === "ready"
      ? buildConvergencePreflight({
          view,
          intent: {
            taskId: activeTaskId ?? undefined,
          },
          authority: {
            principal: "human",
          },
        })
      : null;

  return {
    target,
    setTarget,
    load,
    view,
    loading,
    error,
    refreshError,
    autoLabel,
    proposalText,
    acting,
    viewProposalText,
    adjudicate,
    preflight,
    library,
    libraryQuery,
    setLibraryQuery,
    libraryLoading,
    libraryError,
    loadLibrary,
    decideMemory,
    showExpired,
    toggleShowExpired,
    hiddenExpiredCount,
    expiredProbing,
  };
}

/**
 * The Evidence workspace tab (task #130) — the search form + auto-context
 * note + errors + the full evidence view (BrainContent), now default-expanded
 * (see BrainContent above) since a full-height tab has room to just scroll
 * instead of collapsing behind "N more omitted". Opened by the titlebar
 * "Pre-edit context" button, the hero's "Why this dispatch", and the command
 * palette (all via app.tsx's `openPanelTab("evidence")`).
 */
export function EvidencePanel(props: {
  activeTaskId?: string | null;
  chatId?: string;
  /**
   * U3 — this mission's own record, so the tab has content the moment it opens.
   * Passed in (not fetched) because app.tsx already holds the chat-scoped jobs
   * and ledger: Evidence needs no IPC of its own to show what MUON recorded.
   */
  jobs?: readonly DispatchJobRecord[];
  events?: readonly RecordedEvent[];
  taskTitles?: ReadonlyMap<string, string>;
  /** True while the mission's jobs/events are still being fetched. */
  missionLoading?: boolean;
  /** Why the mission record is unavailable, when it is. */
  missionError?: string | null;
}) {
  // FIX 6: withContext=true — the Evidence surface renders the pre-edit `view`,
  // so it runs the auto-context gate exactly as before (behavior unchanged).
  const brain = useBrainState(props.activeTaskId, true, props.chatId);

  // U3 — derived, not fetched. Recomputed only when the mission record moves.
  const mission = useMemo(
    () =>
      buildMissionEvidence({
        jobs: props.jobs ?? [],
        events: props.events ?? [],
        ...(props.taskTitles ? { taskTitles: props.taskTitles } : {}),
        vendorLabel,
        statusLabel: jobStatusLabel,
      }),
    [props.events, props.jobs, props.taskTitles]
  );
  const visible = useMemo(
    () => filterMissionEvidence(mission.items, brain.target),
    [mission.items, brain.target]
  );
  const filtering = brain.target.trim().length > 0;

  return (
    <div className="workspace-panel-scroll evidence-workspace">
      <form
        className="brain-search"
        onSubmit={(event) => {
          event.preventDefault();
          void brain.load(brain.target);
        }}
      >
        <input
          className="brain-input"
          aria-label="Filter this mission's evidence"
          autoFocus
          placeholder="Filter evidence, or type a symbol or file"
          value={brain.target}
          onChange={(event) => brain.setTarget(event.target.value)}
        />
        <button className="primary-btn" type="submit" disabled={brain.loading}>
          {brain.loading ? "Loading…" : "Pre-edit context"}
        </button>
      </form>

      {brain.autoLabel ? (
        <div className="brain-auto-note">↳ {brain.autoLabel}</div>
      ) : null}

      {brain.error ? <div className="brain-error">{brain.error}</div> : null}
      {brain.refreshError ? (
        <div className="brain-error brain-refresh-error" role="status">
          {brain.refreshError}
        </div>
      ) : null}

      <div className="brain-scroll-x">
        {brain.view && brain.view.phase === "ready" && brain.preflight ? (
          <BrainContent
            view={brain.view}
            preflight={brain.preflight}
            proposalText={brain.proposalText}
            acting={brain.acting}
            onViewProposal={brain.viewProposalText}
            onAdjudicate={brain.adjudicate}
          />
        ) : null}

        <MissionEvidenceSections
          evidence={mission}
          visible={visible}
          filtering={filtering}
          loading={props.missionLoading === true}
          error={props.missionError ?? null}
          hasPreEdit={Boolean(
            brain.view && brain.view.phase === "ready" && brain.preflight
          )}
        />
      </div>
    </div>
  );
}

/**
 * U3 — the mission's own evidence, always rendered. Three states are explicit
 * and none of them is a blank page: loading, error, and a genuinely empty
 * mission each say what is true. A filter that matches nothing says so without
 * claiming the mission has no evidence.
 */
function MissionEvidenceSections(props: {
  evidence: MissionEvidence;
  visible: readonly MissionEvidenceItem[];
  filtering: boolean;
  loading: boolean;
  error: string | null;
  hasPreEdit: boolean;
}) {
  return (
    <section className="mission-evidence" aria-label="This mission's evidence">
      <header className="mission-evidence-head">
        <strong>This mission</strong>
        <span>
          {props.filtering
            ? `${props.visible.length} of ${props.evidence.items.length} records match`
            : `${props.evidence.items.length} recorded ${
                props.evidence.items.length === 1 ? "item" : "items"
              }`}
          {props.evidence.omitted > 0
            ? ` · ${props.evidence.omitted} older omitted`
            : ""}
        </span>
      </header>

      {props.error ? (
        <div className="brain-error" role="alert">
          {props.error}
        </div>
      ) : null}

      {props.loading && props.evidence.empty ? (
        <div className="brain-empty loading-line">
          Reading this mission's record…
        </div>
      ) : null}

      {!props.loading && props.evidence.empty && !props.error ? (
        <div className="brain-empty">
          {props.hasPreEdit
            ? "No agent has run in this mission yet, so there is no crew record — the pre-edit context above is what MUON knows."
            : "No agent has run in this mission yet. Dispatch one and its work, citations, artifacts, and decisions appear here."}
        </div>
      ) : null}

      {!props.evidence.empty && props.visible.length === 0 ? (
        <div className="brain-empty">
          No record in this mission matches that filter. Clear it to see all{" "}
          {props.evidence.items.length}.
        </div>
      ) : null}

      {MISSION_EVIDENCE_SECTIONS.map((section) => {
        const rows = props.visible.filter((item) => item.kind === section.kind);
        if (rows.length === 0) return null;
        return (
          <div className="mission-evidence-section" key={section.kind}>
            <header>
              <strong>{section.label}</strong>
              <span>{rows.length}</span>
            </header>
            <p className="mission-evidence-note">{section.note}</p>
            <ul className="mission-evidence-list">
              {rows.map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong>
                  <span className="mission-evidence-meta">{item.meta}</span>
                  <p className="mission-evidence-body">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

/**
 * The Memory workspace tab (task #130) — the existing MemoryWorkspace (inbox/
 * library/graph/provenance) wired to `useBrainState`'s library/loadLibrary/
 * decideMemory, unchanged. Opened by the left-nav "Memory" item, the
 * control-rail's "Open memory" review action, and the command palette (all
 * via app.tsx's `openPanelTab("memory")`).
 */
export function MemoryPanel(props: {
  activeTaskId?: string | null;
  chatId: string;
  /**
   * The operator's LIVE standing-consent posture (`state.fullAuto`), passed by
   * app.tsx from the same polled state every other consent-reading surface
   * uses. A one-shot `getState()` read here went stale the moment the operator
   * changed the setting with the panel mounted — the most consent-sensitive
   * surface in the app was the only one not tracking consent.
   *
   * Deliberately the GLOBAL all-lanes coordinate, not the per-lane selection:
   * a note's lane would have to come from `createdBy`, which is agent-supplied
   * text — unlike approvals' server-derived `laneVendor` — so matching it
   * against a subset selection would let a spoofed author ride a narrower
   * consent. Under a subset this panel therefore stays strict (every unvouched
   * note is still a debt), which only ever narrows.
   */
  standingConsent?: boolean;
}) {
  // FIX 6: withContext=false — MemoryPanel never renders the pre-edit `view`,
  // so it skips the autoContext/preEditContext gate entirely (it only needs the
  // library path below). Opening the Memory tab no longer fires a discarded
  // dual-graph gate computation.
  const brain = useBrainState(props.activeTaskId, false, props.chatId);
  const { library, libraryLoading, loadLibrary } = brain;

  // WIN 3 (founder product decision): read the operator crew-visible toggle so
  // agent-authored, crew-visible notes present as "Auto · crew memory" (active)
  // rather than a "Review needed" queue. Read-only, best-effort: on any error
  // (e.g. non-operator tier) we leave it OFF and fall back to the strict
  // review-queue framing — never widen the presentation on uncertainty.
  const [autoConfirmAgentMemory, setAutoConfirmAgentMemory] = useState(false);
  useEffect(() => {
    let stopped = false;
    void window.muon
      ?.getAutoConfirmAgentMemory?.()
      .then((enabled) => {
        if (!stopped) setAutoConfirmAgentMemory(enabled);
      })
      .catch(() => {
        /* leave OFF (strict) on any read error */
      });
    return () => {
      stopped = true;
    };
  }, []);

  // This surface's own responsibility (not useBrainState's): load the
  // library the moment the Memory tab is actually mounted, mirroring the old
  // modal's "section === memory" auto-load — EvidencePanel never needs it.
  useEffect(() => {
    if (!library && !libraryLoading) {
      void loadLibrary();
    }
  }, [library, libraryLoading, loadLibrary]);

  return (
    <div className="workspace-panel-scroll">
      <MemoryWorkspace
        snapshot={brain.library}
        loading={brain.libraryLoading}
        error={brain.libraryError}
        query={brain.libraryQuery}
        onQueryChange={brain.setLibraryQuery}
        onRefresh={() => void brain.loadLibrary()}
        onDecide={(noteId, decision) => void brain.decideMemory(noteId, decision)}
        autoConfirmAgentMemory={autoConfirmAgentMemory}
        standingConsent={props.standingConsent ?? false}
        showExpired={brain.showExpired}
        onShowExpiredChange={brain.toggleShowExpired}
        hiddenExpiredCount={brain.hiddenExpiredCount}
        expiredProbing={brain.expiredProbing}
      />
    </div>
  );
}
