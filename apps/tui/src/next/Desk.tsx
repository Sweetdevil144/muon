import {
  buildApprovalReview,
  listCustomAgents,
  terminalSafe,
  terminalSafeBlock,
  REMEMBER_ACTION_INELIGIBLE_SENTENCE,
  REMEMBER_ACTION_TTL_MS,
  type ApprovalRequest,
  type HarnessRecord,
  type MemoryNote,
  type ReviewCoverageCertification,
} from "@muon/client";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BrainSnapshot, BrainStore } from "../lib/brain-store.js";
import {
  buildActionForm,
  executeAction,
  type ActionForm,
} from "../lib/actions.js";
import { FormPrompt } from "../components/FormPrompt.js";
import { MemoryPanel } from "../components/MemoryPanel.js";
import { describeRunFailure, dispatchRun } from "../lib/run-dispatcher.js";
import { ApprovalReviewOverlay } from "../components/ApprovalReviewOverlay.js";
import { buildApprovalDecision, sanitizeVendorErrorMessage } from "@muon/client";
import { resolveCatalogueAction } from "../lib/catalogue-actions.js";
import {
  buildCatalogue,
  filterCatalogue,
  KIND_LABEL,
  type CatalogueEntry,
} from "../lib/catalogue.js";
import {
  activateTab,
  activateTabByOrdinal,
  activeTab,
  CHAT_TAB,
  closeTab,
  cycleTab,
  deskTabId,
  openTab,
  type DeskTabsState,
} from "../lib/desk-tabs.js";
import { resolveKeyAction, type KeyScope } from "../lib/key-dispatch.js";
import { hub } from "../lib/theme.js";
import type { FocusZone } from "../lib/layout.js";
import { buildPaletteCommands } from "../lib/palette.js";
import {
  appendChunks,
  bufferFor,
  pruneBuffers,
  type StreamBuffers,
} from "../lib/stream-buffers.js";
import { editText, isTextEdit } from "../lib/text-input.js";
import {
  byAttention,
  fit,
  headline,
  layoutSections,
  railOwnsCursor,
  statusGlyph,
  type RowStatus,
} from "./sections.js";

/**
 * ADR-0042 — the desk, rebuilt.
 *
 * What the old screen did wrong, and what this does instead:
 *
 *  - FIVE regions at equal visual weight → THREE zones with a hierarchy. The
 *    doctor block and the first-run block are gone from the permanent chrome;
 *    a degraded runner is a thing that needs a person, so it belongs in the
 *    inbox, not in four lines above every screen forever.
 *  - Load-bearing sentences truncated mid-word (`Cursor is a m…`) → nothing
 *    that matters is truncated, because nothing that long is on the main
 *    screen. Labels fit; prose moves to the pane that owns it.
 *  - Three competing hint lines → one footer.
 *  - Twelve identical `○` glyphs → one glyph and one word per row, sorted by
 *    attention, so the fleet looks different when it is on fire.
 *  - `/` focused a bare text line → `/` opens the catalogue: commands,
 *    harnesses and custom agents in one filterable list (D6).
 */

type RailRow = {
  readonly key: string;
  readonly label: string;
  readonly status: RowStatus;
};

/** Last path segment — the rail shows a name, not a path (D7). */
function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

type DeskProps = {
  readonly store: BrainStore;
  readonly workspace?: string;
};

function agentStatus(agent: {
  status?: string;
  currentJobId?: string | null;
}): RowStatus {
  switch (agent.status) {
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "failed":
    case "error":
      return "failed";
    case "idle":
      return agent.currentJobId ? "done" : "idle";
    default:
      return "unknown";
  }
}

export function Desk({ store, workspace }: DeskProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState<BrainSnapshot>(store.getSnapshot());
  const [query, setQuery] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [zone, setZone] = useState<"crew" | "inbox">("crew");
  const [status, setStatus] = useState<string>("");
  // ADR-0042 D4 — the centre is TABS: `chat` permanent, one `stream:<agent>`
  // tab per opened lane. `desk-tabs.ts` finally gets its consumer; on this
  // desk the crew list lives in the rail, so the classic DESK_TAB is not one
  // of the permanent tabs here.
  const [deskTabs, setDeskTabs] = useState<DeskTabsState>({
    tabs: [CHAT_TAB],
    activeId: CHAT_TAB.id,
  });
  const [streamBuffers, setStreamBuffers] = useState<StreamBuffers>({});
  const streamCursorRef = useRef<Record<string, number>>({});
  /** Bumped on every review open. A certification that resolves after a
   *  reopen must NOT overwrite the newer one — same approval id, older
   *  answer, and the overlay would render a stale `certified` as green
   *  (the classic desk's `approvalReviewLoadVersion`, dropped in the port). */
  const reviewLoadVersion = useRef(0);
  /** The inbox cursor, remembered across a palette open — `selected` is
   *  shared with the palette list, so the palette cannot read it. */
  const inboxCursorRef = useRef(0);
  /** ONE dispatch at a time from this desk. A second `run` submitted while
   *  the first is in flight would enqueue a second job against the same task
   *  — the classic desk's `runningRef`, and the reason it exists. */
  const runningRef = useRef(false);
  /** Mirrors `approvalReview` for the dispatch closure, which outlives the
   *  render that created it and would otherwise read a stale `null`. */
  const approvalReviewRef = useRef(false);
  // The last run status suppressed because a gate was open (pass 11 F1).
  // Held rather than dropped: the run really did finish, and the human
  // should learn that the moment the refusal is no longer what matters.
  const pendingRunStatusRef = useRef<string | null>(null);
  /** Last time this terminal told the brain a human is here (ADR-0040 D3a). */
  const lastPresenceRef = useRef(0);
  /** The memory results pane. `null` = not open; this desk's third scope. */
  const [memoryView, setMemoryView] = useState<{
    query: string;
    notes: MemoryNote[];
    showExpired: boolean;
    workspacePath: string;
    busy: boolean;
  } | null>(null);
  const [memoryIndex, setMemoryIndex] = useState(0);
  /** Ported from the classic desk, and load-bearing: two searches in flight
   *  (type, Enter, `e`, Enter again) resolve in arrival order, not request
   *  order, so a slow FIRST response would overwrite a fast second one and
   *  the pane would show results for a query the human already replaced. */
  const memorySearchVersion = useRef(0);
  /** The operator's crew-visible posture, for the SHARED tier rule
   *  (`memoryNoteTier`). Strict (false) until read, and strict on failure — a
   *  note is never described as MORE settled than the rule allows. */
  const [autoConfirmAgentMemory, setAutoConfirmAgentMemory] = useState(false);
  // ADR-0032 D5 — the review is bound to an APPROVAL, never to a list index:
  // the 2s poll reorders `needsYou` under the cursor, and a decision must act
  // on the request the human actually read.
  const [approvalReview, setApprovalReview] = useState<{
    approval: ApprovalRequest;
    certification: ReviewCoverageCertification | null;
    certificationError: string | null;
    resolving: boolean;
  } | null>(null);
  // The FORM scope, ported: the same buildActionForm/executeAction pair the
  // classic desk submits through, so a governed write leaves both desks
  // byte-identically (governed-op cross-surface parity).
  const [activeForm, setActiveForm] = useState<{
    form: ActionForm;
    values: Record<string, string>;
    fieldIndex: number;
    error: string | null;
    busy: boolean;
  } | null>(null);

  approvalReviewRef.current = approvalReview !== null;

  // Flush the run status suppressed while a gate was open (pass 11 F1). The
  // refusal has done its job once the review closes, and at that point the
  // run's outcome is the most useful thing this single line can say. Without
  // this the suppression would be silent loss rather than deferral.
  useEffect(() => {
    if (approvalReview === null && pendingRunStatusRef.current !== null) {
      setStatus(pendingRunStatusRef.current);
      pendingRunStatusRef.current = null;
    }
  }, [approvalReview]);

  useEffect(() => {
    let stopped = false;
    void Promise.resolve()
      .then(() => store.client.getAutoConfirmAgentMemory())
      .then((enabled) => {
        if (!stopped) setAutoConfirmAgentMemory(Boolean(enabled));
      })
      .catch(() => {
        /* strict on failure — see the declaration */
      });
    return () => {
      stopped = true;
    };
  }, [store]);

  useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  // A lane that leaves the fleet takes its tab and its buffer with it —
  // otherwise the desk shows a frozen transcript for an agent that no longer
  // exists (the classic desk shipped exactly that bug; see App.tsx).
  useEffect(() => {
    const live = (snapshot.agents ?? []).map((agent) => agent.id);
    setStreamBuffers((current) => pruneBuffers(current, live));
    setDeskTabs((current) => {
      let next = current;
      for (const tab of current.tabs) {
        if (tab.kind === "stream" && tab.subject && !live.includes(tab.subject)) {
          next = closeTab(next, tab.id);
        }
      }
      return next;
    });
    for (const subject of Object.keys(streamCursorRef.current)) {
      if (!live.includes(subject)) delete streamCursorRef.current[subject];
    }
  }, [snapshot.agents]);

  // Live tail for the ACTIVE stream tab only. Buffer + cursor are retained per
  // agent (ADR-0032 D2), so switching tabs resumes instead of refetching, and
  // an overlapping poll cannot duplicate chunks (`appendChunks` drops ≤cursor).
  const activeTabRecord = activeTab(deskTabs);
  const activeStreamSubject =
    activeTabRecord.kind === "stream" ? activeTabRecord.subject : undefined;
  useEffect(() => {
    if (!activeStreamSubject) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const chunks = await store.client.listStreamChunks({
          agentId: activeStreamSubject,
          afterSeq: streamCursorRef.current[activeStreamSubject] ?? 0,
          limit: 200,
        });
        if (cancelled) return;
        setStreamBuffers((current) => {
          const next = appendChunks(current, activeStreamSubject, chunks);
          streamCursorRef.current[activeStreamSubject] = bufferFor(
            next,
            activeStreamSubject
          ).cursor;
          return next;
        });
      } catch {
        // keep polling — a transient fetch failure must not kill the tail
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const interval = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeStreamSubject, store]);

  const rows = stdout?.rows ?? 30;
  const columns = stdout?.columns ?? 120;
  // Chrome: header + footer + the separators around them.
  const bodyHeight = Math.max(6, rows - 4);
  const railWidth = Math.max(18, Math.min(28, Math.floor(columns * 0.22)));
  const inboxWidth = Math.max(18, Math.min(30, Math.floor(columns * 0.22)));

  const crew = useMemo(
    () => byAttention(snapshot.agents ?? [], (agent) => agentStatus(agent)),
    [snapshot.agents]
  );

  const needsYou = snapshot.approvals ?? [];

  // One uniform row type for the whole rail. Mixing shapes per section is how
  // a rail ends up with per-section rendering branches and a different
  // truncation rule in each one.
  const railSections = useMemo(
    () =>
      layoutSections<RailRow>(
        [
          {
            id: "workspaces",
            title: "workspaces",
            rows: workspace
              ? [{ key: workspace, label: basename(workspace), status: "idle" }]
              : [],
          },
          {
            id: "crew",
            title: "crew",
            rows: crew.map((agent) => ({
              key: agent.id,
              // STORED text — an agent name is not MUON's own string (pass
              // 11 F7). `fit()` is a plain slice and neutralizes nothing.
              label: terminalSafe(agent.name ?? agent.id),
              status: agentStatus(agent),
            })),
          },
        ],
        bodyHeight
      ),
    [crew, workspace, bodyHeight]
  );

  // Harnesses come from the brain. `null` = the source has not loaded —
  // which buildCatalogue renders as ABSENT, never as "you have none"; the
  // palette footer names the failure. A failed load RETRIES on the next
  // palette open and on the refresh action (review finding: the one-shot
  // fetch poisoned the catalogue for the whole session when the brain was
  // still booting at mount).
  const [harnesses, setHarnesses] = useState<HarnessRecord[] | null>(null);
  const [harnessesFailed, setHarnessesFailed] = useState(false);
  const [harnessAttempt, setHarnessAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    store.client
      .listHarnesses()
      .then((rows) => {
        if (!cancelled) {
          setHarnesses(rows);
          setHarnessesFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setHarnessesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [store, harnessAttempt]);

  // Custom agents live in the brain's own data dir (host-local file store).
  // HONESTY LIMIT, stated because a prior revision pretended otherwise: the
  // store itself collapses an unreadable file to [] (`readCustomAgents`
  // swallows read/parse errors and `listCustomAgents` never throws), so this
  // surface CANNOT tell "none" from "unreadable" and does not claim to. The
  // palette footer therefore names only the harness source.
  const customAgents = useMemo(() => {
    const dataDir = snapshot.target.dataDir;
    return listCustomAgents(dataDir === "" ? undefined : dataDir).map(
      (agent) => ({
        id: agent.id,
        slug: agent.slug,
        name: agent.displayName,
      })
    );
  }, [snapshot.target.dataDir]);

  // The REAL command set — readiness-aware, same builder as the classic desk
  // (vendor actions appear with the same enabled/badge state), plus whatever
  // sources loaded. A failed source is simply absent (buildCatalogue's rule).
  const catalogue = useMemo(
    () =>
      buildCatalogue({
        commands: buildPaletteCommands(snapshot.readiness),
        ...(harnesses ? { harnesses } : {}),
        customAgents,
      }),
    [snapshot.readiness, harnesses, customAgents]
  );
  // The list the OPEN palette filters is frozen at open time: the 2s poll
  // rebuilds `catalogue`, and a list that reorders between the frame the
  // user read and the keypress they made can execute a neighbour instead.
  const [frozenCatalogue, setFrozenCatalogue] = useState<
    readonly CatalogueEntry[] | null
  >(null);
  const results = useMemo(
    () => filterCatalogue(frozenCatalogue ?? catalogue, query),
    [frozenCatalogue, catalogue, query]
  );
  // A harness ARRIVAL re-freezes the open palette in place — otherwise the
  // retry the palette itself triggered succeeds invisibly and the freshly
  // loaded harnesses stay hidden until a close/reopen (review round 6 #3).
  useEffect(() => {
    setFrozenCatalogue((frozen) => (frozen === null ? null : catalogue));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnesses]);
  // Derived, never stored: a list that SHRINKS under a parked cursor must
  // clamp at render, or the highlight vanishes while Enter acts on nothing
  // (review round 6 #10).
  const zoneLength = zone === "crew" ? crew.length : needsYou.length;
  const cursor = Math.min(selected, Math.max(0, zoneLength - 1));
  if (zone === "inbox" && !paletteOpen) inboxCursorRef.current = cursor;
  const paletteCursor = Math.min(selected, Math.max(0, results.length - 1));
  /** See `railOwnsCursor` — pure, because the frame cannot express a
   *  colour-only highlight and therefore cannot test this. */
  const cockpitOwnsInput = railOwnsCursor({
    paletteOpen,
    formOpen: activeForm !== null,
    reviewOpen: approvalReview !== null,
    memoryOpen: memoryView !== null,
  });

  /**
   * FIRST press: load the evidence. A merge additionally fetches its coverage
   * certification, because approving a merge without knowing whether the
   * graph could see the changed files is the one decision MUON refuses to let
   * a human make blind.
   */
  const openApprovalReview = (approval: ApprovalRequest | undefined): void => {
    if (!approval) {
      setStatus("✗ nothing in the inbox to review");
      return;
    }
    const version = ++reviewLoadVersion.current;
    setApprovalReview({
      approval,
      certification: null,
      certificationError: null,
      resolving: false,
    });
    if (approval.kind !== "merge") return;
    void store.client
      .getApprovalReviewCertification(approval.id)
      .then((certification) => {
        // Id alone is NOT enough: reopening the SAME approval starts a second
        // fetch, and a slow first answer would overwrite the fresh one.
        if (version !== reviewLoadVersion.current) return;
        setApprovalReview((current) =>
          current && current.approval.id === approval.id
            ? { ...current, certification }
            : current
        );
      })
      .catch((error: unknown) => {
        if (version !== reviewLoadVersion.current) return;
        setApprovalReview((current) =>
          current && current.approval.id === approval.id
            ? {
                ...current,
                certificationError:
                  error instanceof Error
                    ? error.message
                    : "Could not load merge review evidence.",
              }
            : current
        );
      });
  };

  /**
   * ONE search path for both entries (submit, and the `e` expired toggle), so
   * the two cannot drift on the stale-response guard or on the workspace
   * fence. `workspace` is the invoking directory: ADR-0026 §1 measured a TUI
   * search that sent NO partition coordinate and therefore read every repo on
   * the machine. The SERVER canonicalizes it and reduces a worktree to its
   * repo root, so this surface never restates that rule.
   */
  const runMemorySearch = (
    query: string,
    showExpired: boolean,
    workspacePath: string
  ) => {
    const version = ++memorySearchVersion.current;
    // OPEN THE PANE SYNCHRONOUSLY, and close the form. Holding the form open
    // in a `busy` state instead meant its own branch swallowed every key
    // (`if (activeForm.busy) return`), so while a search was in flight `esc`
    // could not cancel it and `/` could not start another — and the response
    // then landed and rendered anyway. The run form already had this shape;
    // the memory form now matches it.
    setActiveForm(null);
    setMemoryView((current) =>
      current && current.query === query
        ? { ...current, busy: true, showExpired }
        : { query, notes: [], showExpired, workspacePath, busy: true }
    );
    void store.client
      .searchMemory(query, { workspace: workspacePath, showExpired })
      .then((notes) => {
        if (memorySearchVersion.current !== version) return;
        setMemoryIndex(0);
        setMemoryView({ query, notes, showExpired, workspacePath, busy: false });
        setStatus(
          `memory: ${notes.length} note(s)${showExpired ? ", expired included" : ""}`
        );
      })
      .catch((error: unknown) => {
        if (memorySearchVersion.current !== version) return;
        // A pane that never got results closes rather than sitting empty:
        // "no notes match" and "the search failed" are different facts, and
        // MemoryPanel can only render the first one.
        setMemoryView((current) =>
          current && current.notes.length > 0
            ? { ...current, busy: false }
            : null
        );
        setStatus(`✗ memory search failed: ${sanitizeVendorErrorMessage(error)}`);
      });
  };

  useInput((input, key) => {
    // ADR-0040 D3a — a KEYSTROKE proves a person is at this terminal; a poll
    // never does. This desk needs its own call: attendance first shipped on
    // the classic desk only, which meant a session driven from the new desk
    // aged toward the horizon and would be reaped with a human watching it.
    // Throttled so holding a key is not a request per character.
    const presenceNow = Date.now();
    if (presenceNow - lastPresenceRef.current > 30_000) {
      lastPresenceRef.current = presenceNow;
      void store.client.noteHumanPresent("tui").catch(() => undefined);
    }
    const scope: KeyScope = activeForm
      ? "form"
      : approvalReview
        ? "approval"
        : paletteOpen
          ? "palette"
          : memoryView
            ? "memory"
            : "cockpit";
    // A status message lives until the NEXT keypress, not forever: the first
    // refusal used to replace the footer hints for the whole session (review
    // round 6 #2 — "a one-way door"). Cleared here, then any branch below
    // that wants a message sets it after; same-event setState batches, so
    // the branch's message wins.
    setStatus("");
    // This desk's two zones map onto the table's zone vocabulary so
    // zone-gated entries (lane-stream on `enter`, approve on `a`) resolve
    // exactly where the table says they are live.
    const zoneHint: FocusZone = zone === "crew" ? "lanes" : "approvals";

    // ADR-0042 D2 — the table resolves first, so a modal scope cannot swallow
    // a binding it never named. This is the Tab-after-`/` cure.
    const resolved = resolveKeyAction(scope, key, input, zoneHint);
    // Zone cycling is inherited by the modal scopes, but NOT while a review
    // is open: moving the zone under an open gate changes what the rail
    // highlights while the human is reading evidence.
    if (resolved?.id === "cycle-zone" && !approvalReview) {
      setZone((current) => (current === "crew" ? "inbox" : "crew"));
      setSelected(0);
      return;
    }

    // ── the APPROVAL REVIEW scope ────────────────────────────────────────
    if (approvalReview) {
      if (approvalReview.resolving) return;
      if (key.escape) {
        setApprovalReview(null);
        setStatus("review closed — no decision was recorded");
        return;
      }
      const decide = (
        decision: "approved" | "rejected",
        receiptTtlMs?: number
      ) => {
        const target = approvalReview.approval;
        // The SAME two local refusals the classic desk makes before it calls
        // the route. Without them this desk would submit decisions the other
        // surfaces refuse to submit — the exact per-surface dialect that
        // governed-op parity forbids. The server is still the final
        // authority; this is about the surfaces agreeing on what they SEND.
        const review = buildApprovalReview(target);
        if (decision === "approved" && !review.approvable) {
          setStatus(
            `✗ ${review.degradationReason ?? "approval is not safely bound; reject and re-file"}`
          );
          return;
        }
        if (receiptTtlMs !== undefined && !review.receiptEligible) {
          setStatus(`✗ ${REMEMBER_ACTION_INELIGIBLE_SENTENCE}`);
          return;
        }
        // The approval must still be PENDING. Another surface (desktop, CLI,
        // full-auto) may have decided it while this review was open; the
        // route answers a re-decide idempotently, so without this the desk
        // would print "✓ approved" for a decision it did not make.
        if (!needsYou.some((pending) => pending.id === target.id)) {
          setApprovalReview(null);
          setStatus(`✗ ${target.id} is no longer pending — another surface decided it`);
          return;
        }
        // A MERGE may only be approved on evidence the human has actually
        // seen. These are the classic desk's three refusals, and their
        // absence was a real hole: the desk teaches "a opens, a decides", so
        // a fast second press landed a merge while the certification was
        // still being computed — the overlay was not even offering approve.
        if (decision === "approved" && target.kind === "merge") {
          if (approvalReview.certificationError) {
            setStatus(`✗ ${approvalReview.certificationError}`);
            return;
          }
          if (!approvalReview.certification) {
            setStatus("… merge review evidence is still loading");
            return;
          }
          if (approvalReview.certification.status === "blocked") {
            setStatus(
              approvalReview.certification.blockCode === "review-blind"
                ? "✗ review-blind merge: attest on the classic desk (npm run tui:legacy) or Desktop"
                : `✗ ${approvalReview.certification.reason}`
            );
            return;
          }
        }
        setApprovalReview({ ...approvalReview, resolving: true });
        // The SAME governed client method the classic desk and the CLI call,
        // with the same payload shape — a governed write must not have a
        // per-surface dialect (governed-op cross-surface parity).
        void store.client
          .resolveApproval(
            // The SHARED payload builder, not a hand-assembled literal: the
            // surface attribution the audit event and `muon report` consume
            // is applied by construction, so a surface cannot forget it.
            buildApprovalDecision({
              approvalId: target.id,
              status: decision,
              surface: "MUON TUI",
              receiptTtlMs,
            })
          )
          .then((result) => {
            setApprovalReview(null);
            // Standing consent is AFFIRMED, never silent: `A` mints a
            // 15-minute auto-approve, and the one affordance built around
            // informed consent must say when it took effect.
            const receiptNote = result.receiptSkipped
              ? ` · receipt not minted: ${result.receiptSkippedReason ?? "ineligible"}`
              : receiptTtlMs !== undefined
                ? " · receipt minted for this exact action"
                : "";
            setStatus(
              `${decision === "approved" ? "✓" : "✗"} ${decision} ${target.id}${receiptNote}`
            );
            void store.refresh();
          })
          .catch((error: unknown) => {
            setApprovalReview((current) =>
              current ? { ...current, resolving: false } : current
            );
            setStatus(
              `✗ decision failed: ${error instanceof Error ? error.message : "unknown"}`
            );
          });
      };
      if (input === "a") {
        decide("approved");
        return;
      }
      if (input === "A") {
        // "Approve, don't ask again" — the SAME content-bound receipt the
        // desktop button and the classic desk send, same lifetime constant.
        // The server mint stays the final authority on eligibility.
        decide("approved", REMEMBER_ACTION_TTL_MS);
        return;
      }
      if (input === "r") {
        decide("rejected");
        return;
      }
      if (input === "m") {
        // `m` is the REVIEW BLIND attestation, and it exists ONLY on a merge
        // gate. On the classic desk this once fell through to a plain
        // approve — an unadvertised fourth approve key. It refuses here.
        setStatus(
          approvalReview.approval.kind === "merge"
            ? "✗ attest is not on this desk yet — decide on the classic desk (npm run tui:legacy)"
            : "✗ m (attest) applies only to a merge gate — a approve, r reject"
        );
        return;
      }
      return;
    }

    // ── the MEMORY scope ────────────────────────────────────────────────
    if (memoryView && !activeForm && !approvalReview && !paletteOpen) {
      if (key.escape) {
        // Invalidate anything in flight: a response that lands after the pane
        // is closed must not reopen it.
        memorySearchVersion.current += 1;
        setMemoryView(null);
        setStatus("memory closed");
        return;
      }
      if (key.downArrow || input === "j") {
        setMemoryIndex((index) =>
          Math.min(Math.max(0, memoryView.notes.length - 1), index + 1)
        );
        return;
      }
      if (key.upArrow || input === "k") {
        setMemoryIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (input === "e") {
        // R3 TTL parity: the posture is a SERVER parameter on the governed
        // search, so this re-asks the backend rather than filtering what is
        // already on screen. Re-asks the SAME query and the SAME workspace —
        // re-deriving the workspace here would let a toggle silently move the
        // partition.
        runMemorySearch(
          memoryView.query,
          !memoryView.showExpired,
          memoryView.workspacePath
        );
        return;
      }
      // A GOVERNED WRITE is not silently absent — it refuses BY NAME. `c`
      // confirms a note and `p` pauses one on the classic desk; both are
      // governed writes whose parity this desk has not earned yet, and a key
      // that quietly does nothing is how a human concludes it worked.
      if (input === "c" || input === "p" || input === "P") {
        setStatus(
          `${input} writes to memory — not on this desk yet · classic desk: npm run tui:legacy`
        );
        return;
      }
      // Anything this scope INHERITS (zone cycling, opening the catalogue)
      // falls through to the shared dispatch below. Everything else is
      // swallowed, so a cockpit key cannot fire under a results pane.
      if (!resolved) return;
    }

    if (activeForm) {
      if (activeForm.busy) return;
      if (key.escape) {
        setActiveForm(null);
        setStatus("form cancelled — nothing was written");
        return;
      }
    const fields = activeForm.form.fields;
      const onLastField = activeForm.fieldIndex >= fields.length - 1;
      if (key.return && onLastField) {
        const submission = activeForm;
        // A RUN is a dispatch, not a ledger write: it goes through
        // `dispatchRun` (runner liveness → assign → enqueue → stream), the
        // same shared seam the classic desk calls. Branching here rather
        // than inside executeAction keeps the two seams honestly separate.
        if (submission.form.commandId === "memory-search") {
          const query = (submission.values.query ?? "").trim();
          if (!query) {
            setActiveForm({
              ...submission,
              busy: false,
              error: "a query is required — memory search needs something to match",
            });
            return;
          }
          // Expired notes stay hidden on the FIRST read (the hygienic default
          // every MUON surface shares); `e` re-asks with them included.
          runMemorySearch(query, false, process.cwd());
          return;
        }
        if (submission.form.commandId === "run") {
          if (runningRef.current) {
            // REFUSE ON THE STATUS LINE, do not re-open the form (review pass
            // 11 F6). Re-opening wedged the desk in the modal form scope while
            // a run was in flight, and escaping it then printed "form
            // cancelled — nothing was written", which is false: a dispatch was
            // running. Worse, pressing Enter again once the run finished
            // re-dispatched the same task with the same values and no
            // confirmation. The form is dismissed and the refusal is stated.
            setActiveForm(null);
            setStatus(
              "✗ a run from this desk is already active — wait for it to finish"
            );
            return;
          }
          const laneKey = (submission.values.laneKey ?? "").trim();
          const lane = (snapshot.lanes ?? []).find(
            (entry) => entry.key === laneKey
          );
          if (!lane) {
            const known = (snapshot.lanes ?? []).map((entry) => entry.key);
            setActiveForm({
              ...submission,
              busy: false,
              // NAME them. The desk holds the list it just searched, and
              // this desk shows no lane list anywhere else — so "not found"
              // with nothing to try next is a dead end, not an error.
              error:
                known.length === 0
                  ? "no lanes loaded yet — wait for the next poll and retry"
                  : `lane '${terminalSafe(laneKey)}' not found · available: ${known
                      .map((entry) => terminalSafe(entry))
                      .join(", ")}`,
            });
            return;
          }
          const taskId = (submission.values.taskId ?? "").trim();
          const brief = (submission.values.brief ?? "").trim();
          // The form marks all three required, but the run branch returns
          // before executeAction's `validateFormValues` — so an empty brief
          // reached `enqueueDispatch` and STARTED AN AGENT WITH NO
          // INSTRUCTION. The classic desk has the same hole; this desk does
          // not inherit it just because parity would allow it.
          const missing = [
            taskId ? null : "task id",
            brief ? null : "brief",
          ].filter(Boolean);
          if (missing.length > 0) {
            setActiveForm({
              ...submission,
              busy: false,
              error: `${missing.join(" and ")} required — an agent is not started without an instruction`,
            });
            return;
          }
          runningRef.current = true;
          setActiveForm(null);
          // ONE WRITER for everything this dispatch says (review pass 11 F1).
          // The guard used to sit inside `onLiveEvent` alone, so the ✓ finished
          // line and the ✗ failure line still erased an open merge gate's
          // refusal — and a green ✓ under an open gate is strictly WORSE than
          // the progress line that was fixed, because it reads as "it went
          // through". A bounded surface has to cover every writer, not the
          // first one found; that is the same completeness rule the gate
          // itself is built on. Suppressed lines are not lost: the last one is
          // held and flushed when the review closes.
          const sayRun = (line: string) => {
            if (approvalReviewRef.current) {
              pendingRunStatusRef.current = line;
              return;
            }
            setStatus(line);
          };
          sayRun(`▶ running ${terminalSafe(lane.key)} on ${taskId}…`);
          void store.client
            .getTaskDetail(taskId)
            .then((detail) => detail.workspacePath ?? undefined)
            .catch(() => undefined)
            .then((cwd) =>
              dispatchRun({
                client: store.client,
                lane,
                taskId,
                brief,
                ...(cwd ? { cwd } : {}),
                onLiveEvent: (event) => {
                  // Live progress on the one line this desk has. The message
                  // is AGENT-AUTHORED, so it is sanitized and clipped like
                  // every other agent field that reaches a frame. `lane.key` is
                  // STORED text and was not sanitized here (pass 11 F7).
                  sayRun(
                    `▶ ${terminalSafe(lane.key)} · ${event.kind} · ${fit(
                      terminalSafe(event.message),
                      48
                    )}`
                  );
                },
              })
            )
            .then((result) => {
              sayRun(
                `✓ run finished (exit ${result.exitCode}, ${result.recorded} events recorded)`
              );
            })
            .catch((error: unknown) => {
              // MUON'S OWN failures are not vendor failures (pass 11 F5).
              // `dispatchRun` wraps five CONTROL-PLANE calls, so handing every
              // error to `classifyVendorFailure` made a MUON API-token 401
              // render as "Codex isn't connected, run `codex login`" with the
              // vendor perfectly healthy, and replaced "Start one with `muon
              // runner`" — the only actionable sentence in the commonest
              // first-run failure — with onboarding copy. A pre-vendor failure
              // is now tagged at the seam and shown as itself.
              // The SHARED decision, so this desk and the classic desk cannot
              // disagree about whether a failure is MUON's or the vendor's.
              sayRun(
                describeRunFailure({
                  error,
                  vendor: lane.key,
                  readiness: snapshot.readiness,
                })
              );
            })
            .finally(() => {
              runningRef.current = false;
              void store.refresh();
            })
            // A throw INSIDE the handlers above (pass 11 F10) would otherwise
            // become an unhandled rejection, which under Node's default kills
            // the process — the TUI dying on an error path.
            .catch(() => {
              runningRef.current = false;
            });
          return;
        }
        // Submit through the SAME governed path the classic desk uses.
        setActiveForm({ ...submission, busy: true, error: null });
        void executeAction(
          store.client,
          submission.form,
          submission.values
        ).then((result) => {
          if (result.ok) {
            setActiveForm(null);
            setStatus(`✓ ${result.message}`);
            void store.refresh();
          } else {
            setActiveForm((current) =>
              current ? { ...current, busy: false, error: result.message } : current
            );
          }
        });
        return;
      }
      if (key.return || key.tab) {
        setActiveForm((current) =>
          current
            ? {
                ...current,
                fieldIndex: (current.fieldIndex + 1) % fields.length,
              }
            : current
        );
        return;
      }
      if (key.upArrow) {
        setActiveForm((current) =>
          current
            ? { ...current, fieldIndex: Math.max(0, current.fieldIndex - 1) }
            : current
        );
        return;
      }
      if (key.downArrow) {
        setActiveForm((current) =>
          current
            ? {
                ...current,
                fieldIndex: Math.min(fields.length - 1, current.fieldIndex + 1),
              }
            : current
        );
        return;
      }
      if (isTextEdit(key, input)) {
        setActiveForm((current) => {
          if (!current) return current;
          const field = current.form.fields[current.fieldIndex];
          if (!field) return current;
          const value = editText(current.values[field.id] ?? "", key, input);
          return value === null
            ? current
            : {
                ...current,
                values: { ...current.values, [field.id]: value },
              };
        });
      }
      return;
    }

    if (paletteOpen) {
      if (key.escape) {
        setPaletteOpen(false);
        setQuery("");
        setFrozenCatalogue(null);
        // The cursor was a palette index; leaving it dangling makes the rail
        // highlight nothing while Enter acts on an off-screen row.
        setSelected(0);
        return;
      }
      if (key.downArrow) {
        setSelected((index) => Math.min(index + 1, Math.max(0, results.length - 1)));
        return;
      }
      if (key.upArrow) {
        setSelected((index) => Math.max(0, index - 1));
        return;
      }
      if (key.return) {
        const entry = results[paletteCursor];
        setPaletteOpen(false);
        setQuery("");
        setFrozenCatalogue(null);
        if (!entry) {
          setStatus("");
          setSelected(0);
          return;
        }
        // D6 second half: Enter EXECUTES. The resolver's union has no
        // approval/dispatch/memory verb at all — see catalogue-actions.ts.
        const action = resolveCatalogueAction(entry);
        switch (action.type) {
          case "quit":
            exit();
            return;
          case "refresh":
            void store.refresh();
            setHarnessAttempt((attempt) => attempt + 1);
            setSelected(0);
            setStatus("⟳ refreshing control state");
            return;
          case "focus":
            setZone(action.zone);
            setSelected(0);
            setStatus(action.note ? `→ ${action.zone} · ${action.note}` : `→ ${action.zone}`);
            return;
          case "review-approval": {
            // The SELECTED request, not the first one: `selected` is the
            // palette's index while the palette is open, so the inbox cursor
            // is remembered separately. Opening someone else's request on a
            // gate surface is a mis-binding even when evidence-first reveals
            // it.
            const index = Math.min(
              inboxCursorRef.current,
              Math.max(0, needsYou.length - 1)
            );
            setZone("inbox");
            setSelected(index);
            openApprovalReview(needsYou[index]);
            return;
          }
          case "form": {
            const form = buildActionForm(action.form, {});
            if (!form) {
              setSelected(0);
              setStatus(`✗ ${entry.label}: no form definition`);
              return;
            }
            const values: Record<string, string> = {};
            for (const field of form.fields) {
              if (field.prefill) values[field.id] = field.prefill;
            }
            setActiveForm({
              form,
              values,
              fieldIndex: 0,
              error: null,
              busy: false,
            });
            setSelected(0);
            return;
          }
          case "elsewhere":
          case "disabled":
            setSelected(0);
            // Label clipped so the REASON — the governance half — survives
            // an 80-column footer whole (review pass 7 #9).
            setStatus(`✗ ${fit(entry.label, 24)}: ${action.reason}`);
            return;
          default: {
            // Exhaustiveness lock: a new CatalogueAction member fails to
            // compile here instead of being silently swallowed.
            const unhandled: never = action;
            void unhandled;
            setSelected(0);
            setStatus(`✗ ${entry.label}: this action is not implemented on this desk`);
            return;
          }
        }
      }
      if (isTextEdit(key, input)) {
        setQuery((value) => editText(value, key, input) ?? value);
        setSelected(0);
      }
      return;
    }

    // Cockpit: EVERYTHING dispatches from the table now — this desk has no
    // inline `if (input === …)` cascade to drift from it. An id the table
    // resolves but this desk has not ported yet refuses by name (same honesty
    // as `catalogue-actions.ts`), so a documented key is never silently dead.
    if (!resolved) return;
    switch (resolved.id) {
      case "focus-command":
      case "palette": {
        // `/`, `i`, and ctrl+k all open the SAME catalogue — on this desk the
        // palette IS the command surface, so refusing ctrl+k was a lie.
        setPaletteOpen(true);
        setQuery("");
        setSelected(0);
        setFrozenCatalogue(catalogue);
        // A FAILED harness load retries on open — keyed on the failure flag,
        // not on `harnesses === null`: a later failure over a previously
        // loaded list must retry too (review round 6 #4).
        if (harnesses === null || harnessesFailed) {
          setHarnessAttempt((attempt) => attempt + 1);
        }
        return;
      }
      case "help":
        // ≤76 chars so it survives an 80-column terminal whole; lists itself.
        setStatus(
          "/ cmds ⇥ zones jk move ⏎ stream o inbox 1-9][x tabs esc chat q quit ? this"
        );
        return;
      case "quit":
        exit();
        return;
      case "move-down": {
        // Clamped to the focused zone's list, so the cursor cannot walk off
        // the end and leave the desk with an invisible selection.
        const limit = zone === "crew" ? crew.length : needsYou.length;
        setSelected((index) => Math.min(index + 1, Math.max(0, limit - 1)));
        return;
      }
      case "move-up":
        setSelected((index) => Math.max(0, index - 1));
        return;
      case "needs-you":
        setZone("inbox");
        setSelected(0);
        return;
      case "approve":
      case "approve-remember":
      case "reject":
        // Two-press (ADR-0032 D5): the cockpit press OPENS the evidence; the
        // decision happens inside the review scope, bound to THIS approval.
        // A cockpit key can never decide, which is what makes a moving list
        // unable to move a decision onto the wrong request.
        openApprovalReview(needsYou[cursor]);
        return;
      case "back":
        setDeskTabs((tabs) => activateTab(tabs, CHAT_TAB.id));
        return;
      case "tab-ordinal":
        setDeskTabs((tabs) => activateTabByOrdinal(tabs, Number(input)));
        return;
      case "tab-next":
        setDeskTabs((tabs) => cycleTab(tabs, "next"));
        return;
      case "tab-prev":
        setDeskTabs((tabs) => cycleTab(tabs, "prev"));
        return;
      case "tab-close":
        setDeskTabs((tabs) => closeTab(tabs, tabs.activeId));
        return;
      case "lane-stream": {
        const agent = crew[cursor];
        if (!agent) {
          setStatus("✗ select a crew row first");
          return;
        }
        // ADR-0042 D4 default, decided: a dispatched lane's pane is the
        // GOVERNED TRANSCRIPT (what MUON can attest); the live pty arrives
        // with the pty port and will be one toggle away, not the default.
        setDeskTabs((tabs) =>
          openTab(tabs, {
            id: deskTabId("stream", agent.id),
            kind: "stream",
            // Same stored name, second render path (pass 11 F7).
            title: terminalSafe(agent.name ?? agent.id),
            closable: true,
            subject: agent.id,
          })
        );
        return;
      }
      default:
        setStatus(
          `✗ ${resolved.entry.description} — not here yet; use npm run tui:legacy`
        );
        return;
    }
  });

  const counts = {
    running: crew.filter((a) => agentStatus(a) === "working").length,
    blocked: crew.filter((a) => agentStatus(a) === "blocked").length,
    failed: crew.filter((a) => agentStatus(a) === "failed").length,
    needsYou: needsYou.length,
  };

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {/* ── header: one line ─────────────────────────────────────────── */}
      <Box>
        <Text bold color="cyan">
          muon
        </Text>
        <Text dimColor> · {fit(workspace ?? "no workspace", 40)}</Text>
        <Box flexGrow={1} />
        <Text color={counts.blocked + counts.failed > 0 ? "yellow" : "green"}>
          {headline(counts)}
        </Text>
      </Box>
      <Text dimColor>{"─".repeat(Math.max(0, columns))}</Text>

      {/* ── body: three zones ────────────────────────────────────────── */}
      <Box flexGrow={1} height={bodyHeight}>
        {/* left rail */}
        <Box flexDirection="column" width={railWidth} paddingRight={1}>
          {railSections.map((section) => (
            <Box key={section.id} flexDirection="column">
              <Text dimColor>{section.title}</Text>
              {section.rows.map((row, index) => {
                // THE RAIL ONLY GLOWS WHEN IT OWNS THE KEYS. `cursor` derives
                // from the same `selected` state the palette's cursor does, so
                // with a modal scope open an arrow key moved BOTH — the
                // palette row AND this rail row highlighted and stepped
                // together, which reads as two cursors and makes it ambiguous
                // what Enter will act on. A highlight is a claim about where
                // your next keypress lands; while a scope owns input, the rail
                // has no such claim to make.
                const active =
                  cockpitOwnsInput &&
                  zone === "crew" &&
                  section.id === "crew" &&
                  index === cursor;
                return (
                  <Text
                    key={row.key}
                    color={active ? "cyan" : undefined}
                    bold={active}
                  >
                    {" "}
                    {statusGlyph(row.status)} {fit(row.label, railWidth - 5)}
                  </Text>
                );
              })}
              {section.hidden > 0 ? (
                <Text dimColor> +{section.hidden} more</Text>
              ) : null}
              <Text> </Text>
            </Box>
          ))}
        </Box>

        {/* center — the loud zone */}
        <Box
          flexDirection="column"
          flexGrow={1}
          paddingX={1}
          borderStyle="round"
          borderColor="gray"
        >
          {memoryView && !approvalReview && !activeForm && !paletteOpen ? (
            <>
              <MemoryPanel
                title={`memory · "${terminalSafe(memoryView.query)}"`}
                notes={memoryView.notes}
                selectedIndex={memoryIndex}
                showExpired={memoryView.showExpired}
                workspacePath={memoryView.workspacePath}
                busy={memoryView.busy}
                autoConfirmAgentMemory={autoConfirmAgentMemory}
              />
              <Text dimColor>
                ↑/↓ move · e {memoryView.showExpired ? "hide" : "show"} expired ·
                esc close
              </Text>
            </>
          ) : approvalReview ? (
            <ApprovalReviewOverlay
              approval={approvalReview.approval}
              certification={approvalReview.certification}
              certificationError={approvalReview.certificationError}
              resolving={approvalReview.resolving}
              width={Math.max(
                20,
                Math.min(72, columns - railWidth - inboxWidth - 6)
              )}
            />
          ) : activeForm ? (
            <FormPrompt
              form={activeForm.form}
              values={activeForm.values}
              fieldIndex={activeForm.fieldIndex}
              error={activeForm.error}
              busy={activeForm.busy}
              hint="⇥/⏎ next field · ⏎ on the last field submits · esc cancels"
            />
          ) : paletteOpen ? (
            <>
              <Text>
                <Text color="cyan">/</Text>
                {query}
                <Text color="cyan">▏</Text>
                <Text dimColor>
                  {"  "}
                  {results.length} of {(frozenCatalogue ?? catalogue).length} · esc to close
                </Text>
              </Text>
              {harnessesFailed ? (
                // The two failure shapes are different facts (round 6 #4):
                // never loaded = the list above is missing a whole source;
                // failed AFTER a load = the harnesses shown may be stale.
                // (Only the harness source can fail visibly: the custom-agent
                // store collapses unreadable to empty at the store layer.)
                <Text color="yellow" dimColor>
                  {harnesses === null
                    ? "harnesses unreadable — retries on next open"
                    : "harness list may be stale — last refresh failed; retries on next open"}
                </Text>
              ) : null}
              <Text> </Text>
              {results.slice(0, Math.max(1, bodyHeight - 4)).map((entry, index) => (
                <Text
                  key={entry.id}
                  color={index === paletteCursor ? "cyan" : undefined}
                  bold={index === paletteCursor}
                >
                  {index === paletteCursor ? "›" : " "} {fit(entry.label, 34)}
                  <Text dimColor>
                    {"  "}
                    {KIND_LABEL[entry.kind]}
                    {entry.badge ? ` · ${entry.badge}` : ""}
                  </Text>
                </Text>
              ))}
              {results[paletteCursor] ? (
                <>
                  <Text> </Text>
                  <Text dimColor>{fit(results[paletteCursor]!.effect, columns - railWidth - inboxWidth - 8)}</Text>
                  {/* AUTHORITY IS NOT DECORATION (catalogue.ts) — and until
                      now this desk rendered none of it. `CatalogueEntry.
                      authority` had ZERO consumers (pass 11 F4), so the only
                      thing shown for a harness was its own `description`: a
                      harness granting full filesystem access and pre-authorized
                      Bash could label itself "Read-only audit." and the palette
                      agreed, on the surface whose Enter executes. The
                      authority line is MUON's sentence about what running the
                      thing can do; the effect line is the thing's own claim
                      about itself. Showing the second without the first is how
                      someone runs `ship` looking for `status`. */}
                  {results[paletteCursor]!.authority ? (
                    // WRAPPED, never `fit`. The grant is at the END of the
                    // sentence ("… PRE-AUTHORIZES Bash — those run WITHOUT
                    // asking you"), so clipping it to the pane width removes
                    // exactly the part that matters and leaves a reassuring
                    // prefix. ADR-0042 D7: nothing that matters is truncated.
                    <Text color={hub.warn} wrap="wrap">
                      {results[paletteCursor]!.authority}
                    </Text>
                  ) : (
                    <Text dimColor>
                      authority: UNKNOWN — MUON cannot say what running this does
                    </Text>
                  )}
                </>
              ) : null}
            </>
          ) : (
            <>
              {/* tab strip — the ordinal IS the key (1…9), so the strip
                  teaches its own bindings */}
              <Text>
                {deskTabs.tabs.map((tab, index) => {
                  const active = tab.id === deskTabs.activeId;
                  return (
                    <Text
                      key={tab.id}
                      color={active ? "cyan" : undefined}
                      bold={active}
                      dimColor={!active}
                    >
                      {index > 0 ? "   " : ""}
                      {index + 1} {fit(tab.title, 16)}
                    </Text>
                  );
                })}
              </Text>
              <Text> </Text>
              {activeTabRecord.kind === "stream" && activeStreamSubject ? (
                (() => {
                  const chunks = bufferFor(
                    streamBuffers,
                    activeStreamSubject
                  ).chunks.slice(-Math.max(1, bodyHeight - 6));
                  return (
                    <>
                      {/* ADR-0042 D4: the governed transcript is the default
                          pane — it is what MUON can attest. */}
                      <Text dimColor>
                        governed transcript · live pty arrives with the pty port
                      </Text>
                      {chunks.length === 0 ? (
                        <Text dimColor>
                          no output yet — chunks appear the moment this lane
                          works
                        </Text>
                      ) : (
                        chunks.map((chunk) => (
                          <Text
                            key={chunk.seq}
                            wrap="wrap"
                            bold={chunk.kind === "milestone"}
                          >
                            {terminalSafeBlock(chunk.content)}
                          </Text>
                        ))
                      )}
                    </>
                  );
                })()
              ) : (
                <>
                  <Text dimColor>chat</Text>
                  <Text> </Text>
                  <Text>Press <Text color="cyan">/</Text> for commands, harnesses and agents.</Text>
                  <Text dimColor>⏎ on a crew row opens its transcript tab</Text>
                </>
              )}
            </>
          )}
        </Box>

        {/* right — only what needs a person */}
        <Box flexDirection="column" width={inboxWidth} paddingLeft={1}>
          <Text dimColor>inbox</Text>
          {needsYou.length === 0 ? (
            <Text dimColor> nothing needs you</Text>
          ) : (
            needsYou.slice(0, bodyHeight - 2).map((approval, index) => (
              <Text
                key={approval.id}
                color={zone === "inbox" && index === cursor ? "cyan" : "yellow"}
              >
                {" "}
                ▸ {fit(approval.kind ?? "approval", inboxWidth - 4)}
              </Text>
            ))
          )}
        </Box>
      </Box>

      {/* ── footer: ONE line ─────────────────────────────────────────── */}
      <Text dimColor>{"─".repeat(Math.max(0, columns))}</Text>
      <Text dimColor>
        {/* One line, but never a mangled one: when a status (usually a
            refusal that must stay readable — it is a direction, not a wall)
            is present it takes the WHOLE line; the hints return when it
            clears. `?` lists every live binding into this line. */}
        {/* SANITIZE AT THE RENDER BOUNDARY, not at each writer. Review found a
            task id reaching this line raw; enumerating the line then found a
            certification error and an executeAction result doing the same,
            both carrying backend text. Patching the three would have left the
            fourth writer to be found by the next review — this desk has ~40
            `setStatus` callers and the whole point of a bounded surface is
            that it cannot be missed. `terminalSafe` is a no-op on MUON's own
            glyphs and prose, so flattening the composed line costs nothing and
            covers every present and future writer. `fit` is a plain slice and
            neutralizes nothing, so it must run AFTER. */}
        {status
          ? fit(terminalSafe(status), columns)
          : "/ commands · ⇥ zones · ⏎ stream · ? keys · q quit"}
      </Text>
    </Box>
  );
}
