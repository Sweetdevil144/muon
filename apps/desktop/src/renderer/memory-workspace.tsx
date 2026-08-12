import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MemoryLibraryImport,
  MemoryLibraryNote,
  MemoryLibrarySnapshot,
} from "@muon/client/memory-library";
import type { MemoryExplainResult, MemoryNeighborsResult } from "@muon/client";
// Subpath, not the aggregate barrel: the renderer must not pull the Node
// package barrel in at runtime (P11 architecture fitness).
import { memoryNoteTier } from "@muon/client/memory-tier";
import { MemoryGovernancePanel } from "./memory-governance.js";
import forceAtlas2 from "graphology-layout-forceatlas2";
// `sigma` touches WebGL/canvas at module-eval time, which crashes in the
// jsdom test env — LAZY-imported inside the render effect below (mirrors
// graph-view.tsx). `graphology-layout-forceatlas2` above and the adapter
// below are pure JS (no canvas/window access), so they stay static — same
// split graph-view.tsx itself uses (forceAtlas2 static, sigma lazy).
import type SigmaType from "sigma";
import {
  activeMemoryNotes,
  buildMemoryGraph,
  noteNodeId,
  type MemoryGraphEdgeAttributes,
  type MemoryGraphNodeAttributes,
} from "./lib/memory-graph-adapter.js";

type MemoryTab =
  | "inbox"
  | "library"
  | "graph"
  | "provenance"
  | "governance";

type Props = {
  snapshot: MemoryLibrarySnapshot | null;
  loading: boolean;
  error: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onDecide: (
    noteId: string,
    decision:
      | "confirm"
      | "reject"
      | "pause"
      | "resume"
      | "pin"
      | "unpin"
      | "delete"
  ) => void;
  /** R3 TTL — the operator "Show expired" posture. OWNED BY THE CALLER because
   *  it is a SERVER-side parameter on the governed read (`showExpired`), not a
   *  renderer filter: flipping it re-asks the backend, exactly like the CLI and
   *  the TUI do. Default OFF (lapsed notes hidden), matching every other
   *  surface. */
  showExpired?: boolean;
  onShowExpiredChange?: (next: boolean) => void;
  /** How many notes the CURRENT query hides because they lapsed, or null when
   *  that is unknown (never probed, or the probe failed). Drives the honest
   *  empty state — "everything here expired" must never render as "no memories".
   *  Only meaningful while `showExpired` is OFF. */
  hiddenExpiredCount?: number | null;
  /** True while that count is being resolved, so the empty state can say it is
   *  still checking rather than claim the brain is empty. */
  expiredProbing?: boolean;
  /** WIN 3 (founder product decision): the operator crew-visible toggle
   *  (`autoConfirmAgentMemory`, default ON). When on, agent-authored active
   *  notes are framed as "Auto · crew memory" (usable now) rather than a
   *  "Review needed" queue. Optional so callers/tests that don't fetch it fall
   *  back to the strict (OFF) presentation. */
  autoConfirmAgentMemory?: boolean;
  /**
   * The operator's STANDING CONSENT posture (Full Auto / per-lane
   * auto-approve). When armed, crew-visible-but-unvouched notes stop being
   * presented as a review queue: the operator has explicitly delegated routine
   * decisions, and a surface that keeps asking anyway is friction they turned
   * off on purpose. It moves notes between two reading surfaces ONLY — it can
   * never confirm a note, and confirmed-only remains the edit-gate rule.
   * Optional and defaulting to false, so a caller that does not pass it keeps
   * today's strict presentation exactly.
   *
   * This is the GLOBAL all-lanes coordinate (`state.fullAuto`), deliberately
   * not the per-lane selection: a note's lane could only come from
   * `createdBy`, which is agent-supplied text — unlike approvals'
   * server-derived `laneVendor` — so a subset match would let a spoofed
   * author ride a narrower consent. Under a subset this stays false and the
   * queue stays strict, which only ever narrows.
   */
  standingConsent?: boolean;
};

// Confirmation.decision is wider than confirm/reject: the ledger also writes
// system "reconcile" markers (conflict/tombstone review flags). Anything
// unknown renders as a neutral label — never as a confirm or a reject.
function decisionLabel(decision: string): string {
  if (decision === "confirm") return "confirmed";
  if (decision === "reject") return "rejected";
  if (decision === "pin") return "pinned";
  if (decision === "unpin") return "unpinned";
  // R3 TTL: the sweeper's OWN audit row (`principal: "system:ttl"`). An
  // automatic retention eviction is not a review flag, and rendering it as one
  // read as "system:ttl flagged for review (expire)" — telling the operator to
  // adjudicate something no human is ever asked to touch. It is still neither a
  // confirm nor a reject: `deriveConfirmedSet` counts human rows only.
  if (decision === "expire") return "expired by retention policy";
  return `flagged for review (${decision})`;
}

// ── WIN 3 — FOUNDER PRODUCT DECISION (de-emphasizes the human memory-review
// step) ──────────────────────────────────────────────────────────────────────
//
// Agent-authored memory is AUTO-WRITTEN by the LLMs and crew-visible in-chat, so
// it is PRESENTED as already-active ("Auto · crew memory") instead of a "Review
// needed · low confidence" review queue whenever the operator's crew-visible
// toggle (`autoConfirmAgentMemory`, default ON — see backend
// operator-settings.ts) is on. This is a FRAMING + default-presentation change
// only, NOT a gate removal: the governance wedge's memory gate stays fully
// available — the human-only `confirmed` flag still guards the DURABLE tier,
// cross-chat isolation is untouched, and flipping the operator toggle OFF
// restores the strict "Review needed" presentation for every agent note. A human
// may still confirm-for-durable or reject via the affordances kept below.

// Human-vs-agent authorship (the KG-5 convention) and the crew-auto framing
// now live in @muon/client's memory-tier.ts — see `isHumanMemoryPrincipal` and
// `memoryNoteTier`. They moved because the CLI restated the tier rule
// privately and drifted; one home, two consumers.

/** The LLM extractor's principal — the ONE author that means "a model wrote this
 *  prose", as opposed to an agent proposing a note (`agent:<vendor>`) or MUON
 *  capturing one deterministically (`muon-capture`). A dependency-free mirror of
 *  `@muon/core`'s `isModelMinedMemoryPrincipal` (memory-extract-lane.ts), kept
 *  tiny for the same reason `isHumanAuthored` above is, and pinned to that source
 *  by a drift canary in the workspace test. */
const MEMORY_EXTRACTOR_PRINCIPAL = "muon-extractor";

function isMachineExtracted(createdBy: string): boolean {
  return createdBy.trim().toLowerCase() === MEMORY_EXTRACTOR_PRINCIPAL;
}

/** A note a MACHINE wrote and NO HUMAN has vouched for. Model-mined notes ride
 *  the crew-visible toggle like any other agent note, so with it ON this text is
 *  already reaching the crew — which is exactly why the review surfaces have to
 *  keep saying where it came from. `confirmed` ends the label: a human looked. */
function machineExtractedUnreviewed(
  note: Pick<MemoryLibraryNote, "confirmed" | "createdBy">
): boolean {
  return !note.confirmed && isMachineExtracted(note.createdBy);
}

// ── R3 TTL (memory expiry) ───────────────────────────────────────────────────
//
// An unconfirmed, low/medium-trust, AGENT-authored note is stamped with an
// `expiresAt` at ingest. Past that deadline it is hidden from recall by default
// — it is NOT deleted, and confirming it clears the expiry outright. That
// redemption path is the whole point, so this surface has to (a) let the
// operator see lapsed notes, (b) mark them unmistakably, (c) keep Confirm
// reachable on them, and (d) show a live note's remaining life BEFORE it lapses.

/** Expiry is decided SERVER-SIDE (`expired`, derived from `expiresAt` at read
 *  time) and simply reported here. Never re-derive it from `expiresAt` in the
 *  renderer: the backend re-applies the never-expire invariants (confirmed /
 *  human-authored / high-trust) when it computes the flag, so a note that has
 *  earned permanence reads live even while a stale deadline sits in the column.
 *  `expiredAt` is a sweeper audit marker and is deliberately never read here. */
function isExpiredNote(note: Pick<MemoryLibraryNote, "expired">): boolean {
  return note.expired === true;
}

function humanizeSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

// ── P0-3 — ONE tier vocabulary for the whole workspace ───────────────────────
//
// The same note used to be called three things in three places: "Auto-approved
// by MUON · crew memory" on the card, "muon-approved" in the graph table, and
// "Auto · crew" in the graph's node inspector. The third one named the WEAKER
// crew-visible tier for a note MUON had actually vouched for, so the Graph tab
// and the Crew-memory tab described one note two ways. Every label below is now
// derived from this single function.
type NoteTier =
  /** A PERSON confirmed it. The strongest statement on any surface, and the
   *  only tier that unlocks global-scope promotion, pack export, the KG-6
   *  destructive-write protection and the merge attestation (see
   *  `orchestratorConfirmingPrincipal` in the backend's memory-ledger). */
  | "human"
  /** The crew's coordinator vouched for it on the record: settled, durable, and
   *  already in every agent's brief. Nothing is owed on it. */
  | "muon"
  /** Crew-VISIBLE under the operator's auto posture, but nobody vouched for it
   *  on the record. */
  | "auto"
  /** Nobody vouched and nothing is carrying it: a foreign pack import, an agent
   *  note written while the auto posture was off, or a note that lapsed. This is
   *  the ONE tier that is a debt. */
  | "open";

function noteTier(
  note: Pick<
    MemoryLibraryNote,
    "confirmed" | "confirmedBy" | "createdBy" | "expired" | "status"
  >,
  autoConfirmAgentMemory: boolean
): NoteTier {
  // The rule itself lives in @muon/client (memory-tier.ts) because the CLI
  // restated it privately and drifted — one home, two consumers. This wrapper
  // only narrows the type to this file's vocabulary.
  return memoryNoteTier(note, autoConfirmAgentMemory);
}

/**
 * P0-2 — the one-word tier for a dense row (the graph tab's table). Only "open"
 * is a debt, so only "open" may say "pending" — the crew-visible "auto" tier
 * used to fall through to it, calling in-use crew memory a pending proposal.
 */
function noteTierLabel(tier: NoteTier): string {
  if (tier === "human") return "trusted";
  if (tier === "muon") return "muon-approved";
  if (tier === "auto") return "auto · crew";
  return "pending";
}

/** The one TTL sentence a card/inspector shows. A LIVE note counts down (the
 *  warning we owe the user before it vanishes); a lapsed one says how long ago
 *  it went. Null when the note never expires — the common case, and it must
 *  stay silent rather than imply a deadline that does not exist. */
function ttlLabel(
  note: Pick<MemoryLibraryNote, "expiresAt" | "expired">,
  now: number
): string | null {
  if (!note.expiresAt) return null;
  const deadline = Date.parse(note.expiresAt);
  if (!Number.isFinite(deadline)) return null;
  const delta = deadline - now;
  if (isExpiredNote(note) || delta <= 0) {
    return `Expired ${humanizeSpan(Math.abs(delta))} ago`;
  }
  return `Expires in ${humanizeSpan(delta)}`;
}

/** The tooltip on the ONE place a settled note still offers a human confirm.
 *  It has to say what the confirm BUYS, because on a settled note it buys
 *  promotion — not permission, which MUON already granted. */
const PROMOTE_TITLE =
  "MUON already vouched for this and the crew is working from it. A human " +
  "confirm is the stronger tier: it promotes the note to global scope, " +
  "includes it in team pack exports, protects it from low-trust overwrites, " +
  "and signs it into merge attestation.";

function MemoryCard(props: {
  note: MemoryLibraryNote;
  /** P1.4: import provenance for this note — origin EVIDENCE, never local trust. */
  origin?: MemoryLibraryImport;
  review?: boolean;
  /** P0-3 — this surface is where PROMOTION is the user's own intent (the
   *  Library: you searched for a note, you want it to travel). Only here may a
   *  SETTLED note offer a human confirm, and even here it is quiet and labelled
   *  for what it unlocks. The crew log never sets it. */
  promote?: boolean;
  /** Library-only lifecycle controls: pin/unpin and permanent forget. */
  manage?: boolean;
  /** WIN 3: the operator crew-visible toggle — drives the "Auto · crew memory"
   *  framing for agent notes (see memoryNoteTier). Defaults OFF (strict). */
  autoConfirmAgentMemory?: boolean;
  /** Standing consent: with it armed, an "auto"-tier note is SETTLED on this
   *  card too (same rule as the tab's isDebt — one coordinate, two readers,
   *  no drift). Defaults OFF (strict). */
  standingConsent?: boolean;
  onDecide?: (
    noteId: string,
    decision:
      | "confirm"
      | "reject"
      | "pause"
      | "resume"
      | "pin"
      | "unpin"
      | "delete"
  ) => void;
}) {
  const coordinates = [
    ...props.note.modules,
    ...props.note.symbols,
    ...props.note.topics,
  ];
  const visibleCoordinates = coordinates.slice(0, 4);
  const expired = isExpiredNote(props.note);
  const paused = props.note.status === "paused";
  // A lapsed note is never "Auto · crew memory": it stopped reaching the crew
  // the moment it expired, and saying otherwise would be the exact lie this
  // feature exists to stop. (`noteTier` enforces that; `auto` is just its
  // crew-visible-but-unvouched tier.)
  const tier = noteTier(props.note, props.autoConfirmAgentMemory ?? false);
  // SETTLED: the operator owes this note nothing. Two ways there — MUON's
  // vouch, or the crew-visible "auto" tier UNDER STANDING CONSENT (the same
  // rule the tab's own isDebt uses; this card's private `tier === "muon"`
  // had drifted from it, so a card labeled "Auto · crew memory" under the
  // section that says "Nothing here is waiting on you" still rendered a
  // primary Confirm — the founder read it as demanded review, correctly).
  const settled =
    tier === "muon" || (tier === "auto" && props.standingConsent === true);
  const ttl = ttlLabel(props.note, Date.now());
  const decisionCanonEntry =
    props.note.kind === "decision" &&
    props.note.confirmed &&
    props.note.scope === "global";
  // ── P0-3 — what this card may ASK, decided by the note AND the surface ─────
  //
  // Rejection stays available wherever the surface reviews (and on any lapsed
  // note, so an expired note the operator can SEE is never one they cannot
  // RESCUE or kill).
  const showReject =
    Boolean(props.onDecide) && (props.review === true || expired || paused);
  const showPause =
    Boolean(props.onDecide) && props.note.status === "active" && !expired;
  const showResume = Boolean(props.onDecide) && paused;
  // A SETTLED note is never asked to be confirmed. A row of Confirm buttons IS
  // a review queue — the founder read it as "memory is still waiting on me"
  // three times running, and they were right: nothing on a note the whole crew
  // is already working from should invite a decision. The human confirm is not
  // deleted (it is the tier that unlocks global scope, pack export, KG-6
  // protection and merge attestation); it moved to the Library, where promoting
  // a note is the user's own intent — `props.promote`.
  const showConfirm =
    Boolean(props.onDecide) &&
    !paused &&
    // Confirming an already-human-confirmed note is a no-op; never offer it.
    !props.note.confirmed &&
    // A lapsed note: redemption has to stay reachable wherever it is visible,
    // or the "Show expired" toggle is a museum rather than a fix.
    (expired ||
      // Genuinely pending, on a surface that reviews → the real ask.
      (props.review === true && !settled) ||
      // Settled, on the surface where promotion is the user's own intent → an
      // offer, never an ask.
      (props.promote === true && settled));
  const compactText = props.note.text.replace(/\s+/g, " ").trim();
  const collapsible =
    props.note.text.length > 520 || props.note.text.split("\n").length > 8;
  return (
    <article
      className={`memory-library-card ${props.note.status}${
        expired ? " expired" : ""
      }`}
    >
      <header>
        <span className={`memory-kind ${props.note.kind}`}>{props.note.kind}</span>
        {/* P0-2 — WHO vouched, ranked. A human confirm stays the strongest
            statement on the card and is named as such; MUON's vouch says the
            note is settled and usable WITHOUT claiming a person read it. */}
        <span
          className={`memory-status-copy${
            tier === "muon" || tier === "auto" ? " active" : ""
          }`}
        >
          {paused
            ? "Paused · hidden from crew"
            : tier === "human"
            ? `Confirmed by you · ${props.note.trust} evidence`
            : tier === "muon"
              ? "Auto-approved by MUON · crew memory"
              : tier === "auto"
                ? "Auto · crew memory"
                : `Review needed · ${props.note.trust} confidence`}
        </span>
        {props.note.stale ? <span className="warn">May be outdated</span> : null}
        {/* PROVENANCE, not a warning. "Auto · crew memory" says a note is usable
            now; it does not say a MODEL wrote it and no human has read it. Both
            facts are true of a crew-visible mined note, and the second is the one
            a reviewer needs. */}
        {machineExtractedUnreviewed(props.note) ? (
          <span
            className="memory-machine-badge"
            title="Extracted by a model from agent output. No human has confirmed it."
          >
            Machine-extracted
          </span>
        ) : null}
        {/* A THIRD state, not a variant of stale: stale says "this may be
            wrong", expired says "we stopped vouching for it". */}
        {expired ? <span className="memory-expired-badge">EXPIRED</span> : null}
        {paused ? <span className="memory-paused-badge">PAUSED</span> : null}
        {props.note.pinned ? (
          <span className="memory-pinned-badge">PINNED</span>
        ) : null}
      </header>
      {collapsible ? (
        <details className="memory-card-text">
          <summary>
            <span>{compactText.slice(0, 320)}…</span>
            <small>Show full memory</small>
          </summary>
          <p>{props.note.text}</p>
        </details>
      ) : (
        <p>{props.note.text}</p>
      )}
      {expired ? (
        <p className="memory-expired-note">
          Lapsed unconfirmed, so recall hides it. Nothing was deleted — confirm
          it to restore it permanently.
        </p>
      ) : null}
      {paused ? (
        <p className="memory-paused-note">
          Not rejected and nothing was deleted. Resume restores the same trust
          and confirmation state to crew reads.
        </p>
      ) : null}
      <div className="memory-coordinates">
        {visibleCoordinates.map((coordinate) => (
          <span key={coordinate}>{coordinate}</span>
        ))}
        {coordinates.length > visibleCoordinates.length ? (
          <small>+{coordinates.length - visibleCoordinates.length} more</small>
        ) : null}
      </div>
      {ttl ? (
        <div
          className={`memory-ttl${expired ? " lapsed" : ""}`}
          title={new Date(props.note.expiresAt ?? "").toLocaleString()}
        >
          {ttl}
        </div>
      ) : null}
      <footer>
        <span>{props.note.createdBy}</span>
        <span>{new Date(props.note.updatedAt).toLocaleString()}</span>
      </footer>
      {props.note.provenance &&
      // Congestion fix: when the provenance ref is the SAME job the footer's
      // author line already names (`agent:job:X` above, `Saved during job:X ·
      // <same minute>` below), the row is pure duplication — every crew note
      // wore it, and the card read as a form. Kept for any provenance the
      // footer does NOT already state (packs, captures, foreign refs).
      !(
        props.note.provenance.sourceType === "job" &&
        props.note.provenance.rawRef &&
        props.note.createdBy.includes(
          props.note.provenance.rawRef.replace(/^job:/, "")
        )
      ) ? (
        <div className="memory-note-provenance">
          Saved {props.note.provenance.sourceType === "job" ? "during" : "from"}{" "}
          <code>
            {props.note.provenance.rawRef ?? props.note.provenance.sourceType}
          </code>{" "}
          · {new Date(props.note.provenance.createdAt).toLocaleString()}
        </div>
      ) : null}
      {props.origin ? (
        <div className="memory-import-origin">
          from {props.origin.originLabel} ({props.origin.originWorkspace}) ·
          authored by {props.origin.originAuthor} · confirmed at origin by{" "}
          {props.origin.originConfirmedBy}{" "}
          {new Date(props.origin.originConfirmedAt).toLocaleString()}
        </div>
      ) : null}
      {showConfirm || showReject || showPause || showResume || props.manage ? (
        // P0-3 action TIERING. On a SETTLED card the only action is Reject, and
        // it is quiet: the operator can still kill a wrong memory, but nothing
        // asks them to adjudicate knowledge the crew is already using. On an
        // unvouched (or lapsed) note Confirm is primary, because that one really
        // is pending.
        <div className="memory-decision-actions">
          {/* A GENUINE pending decision (unvouched on a review surface, or a
              lapsed note) leads the row. The settled-card promotion offer does
              NOT render here — it trails the row below, after the management
              actions, and drops the review-verb entirely ("Promote", never
              "Confirm …"): the founder read a leading Confirm as a demand
              three missions running, and on a settled card they were right. */}
          {showConfirm && !(settled && !expired) ? (
            <button
              className="primary-btn"
              onClick={() => props.onDecide?.(props.note.id, "confirm")}
            >
              {expired ? "Confirm to restore" : "Confirm"}
            </button>
          ) : null}
          {showReject ? (
            <button
              className="ghost-btn"
              onClick={() => props.onDecide?.(props.note.id, "reject")}
            >
              Reject
            </button>
          ) : null}
          {showPause ? (
            <button
              className="ghost-btn"
              onClick={() => props.onDecide?.(props.note.id, "pause")}
            >
              Pause
            </button>
          ) : null}
          {showResume ? (
            <button
              className="primary-btn"
              onClick={() => props.onDecide?.(props.note.id, "resume")}
            >
              Resume
            </button>
          ) : null}
          {props.manage ? (
            <button
              className="ghost-btn"
              onClick={() =>
                props.onDecide?.(
                  props.note.id,
                  props.note.pinned ? "unpin" : "pin"
                )
              }
              title={
                decisionCanonEntry
                  ? props.note.pinned
                    ? "Remove retention protection and stop delivering this decision in new agent briefs"
                    : "Protect this decision and deliver it in every new agent brief for this workspace"
                  : props.note.pinned
                    ? "Allow automatic expiry, compaction, and forgetting again"
                    : "Protect from automatic expiry, compaction, and forgetting"
              }
            >
              {props.note.pinned ? "Unpin" : "Pin"}
            </button>
          ) : null}
          {props.manage ? (
            <button
              className="ghost-btn danger"
              disabled={props.note.pinned}
              onClick={() => props.onDecide?.(props.note.id, "delete")}
              title={
                props.note.pinned
                  ? "Unpin before permanently forgetting this note"
                  : "Permanently forget this note"
              }
            >
              Forget permanently
            </button>
          ) : null}
          {/* The settled card's promotion OFFER, last and quiet. The human
              confirm capability is not deleted (it still unlocks global scope,
              pack export, KG-6 protection, merge attestation — the title says
              so); it just never again reads as the card's ask. */}
          {showConfirm && settled && !expired ? (
            <button
              className="ghost-btn memory-promote-offer"
              onClick={() => props.onDecide?.(props.note.id, "confirm")}
              title={PROMOTE_TITLE}
            >
              Promote
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

const LAYOUT_TOTAL_ITERATIONS = 300;
const LAYOUT_BATCH = 4;

// ── B1 — the note's bounded NEIGHBOURHOOD ────────────────────────────────────
//
// `memory_neighbors` already existed backend-side and as an agent tool while no
// human surface read it, so a capability MUON ships was invisible to the person
// who governs it. This renders it where a human looks for it: from the note they
// selected, one hop out.
//
// Three rules it must not break:
//   1. BOUNDED — main asks for one hop and a small cap, and this list shows at
//      most NEIGHBOR_DISPLAY_CAP rows, so one note can never pull in a wall of
//      graph.
//   2. COORDINATES-ONLY STAYS COORDINATES-ONLY — the backend's text gate decides
//      which nodes carry `text`. A node without it is rendered as its coordinate
//      and labelled; the renderer NEVER substitutes prose it happens to hold
//      locally, which would defeat the gate from the display side.
//   3. DEGRADED ≠ EMPTY — a graph outage says the graph is unavailable, never
//      "this note has no neighbours" (the same distinction /explain makes).

const NEIGHBOR_DISPLAY_CAP = 12;

/** Human label for a graph node type. Unknown types fall through to the raw
 *  value rather than being hidden — an unlabelled node is still evidence. */
const NEIGHBOR_TYPE_LABEL: Record<string, string> = {
  note: "memory",
  principal: "author",
  module: "module",
  symbol: "symbol",
  task: "task",
  lane: "lane",
  approval: "approval",
};

type NeighborRow = {
  id: string;
  entityId: string;
  type: string;
  relation: string;
  text?: string;
};

/**
 * Flatten the traversal into one row per neighbour, annotated with the relation
 * that reached it. The ROOT note is dropped — it is the thing being inspected,
 * not a neighbour of itself.
 */
export function neighborRows(
  result: Pick<MemoryNeighborsResult, "nodes" | "edges" | "provenance">
): NeighborRow[] {
  const root = result.provenance.root;
  const relationByNode = new Map<string, string>();
  for (const edge of result.edges) {
    if (edge.from === root && !relationByNode.has(edge.to)) {
      relationByNode.set(edge.to, edge.relation);
    } else if (edge.to === root && !relationByNode.has(edge.from)) {
      relationByNode.set(edge.from, edge.relation);
    }
  }
  return result.nodes
    .filter((node) => node.id !== root)
    .map((node) => ({
      id: node.id,
      entityId: node.entityId,
      type: node.type,
      relation: relationByNode.get(node.id) ?? "LINKED",
      ...(node.text ? { text: node.text } : {}),
    }));
}

/**
 * Task #131 — the Memory graph, now an INTERACTIVE force-directed instrument
 * (was: a hand-rolled static 3-column-grid SVG). Same zero-dep sigma +
 * graphology + graphology-layout-forceatlas2 stack graph-view.tsx already
 * proved CSP-clean — no new force-graph dependency. Every active note (per
 * the existing `showUntrusted` filter) becomes a node EMBEDDING its entire
 * MemoryLibraryNote (memory-graph-adapter.ts's buildMemoryGraph); clicking a
 * node opens the per-node inspector below with the full text, trust/
 * confirmed/stale badges, every coordinate, author, timestamps, and
 * relations. The accessible `<table>` fallback (a11y) is unconditionally
 * kept alongside the canvas.
 */
function MemoryGraph(props: {
  snapshot: MemoryLibrarySnapshot;
  /** WIN 3: operator crew-visible toggle, threaded for the node-inspector badge. */
  autoConfirmAgentMemory: boolean;
}) {
  const [showUntrusted, setShowUntrusted] = useState(false);
  const [selected, setSelected] = useState<MemoryLibraryNote | null>(null);
  const [explanation, setExplanation] =
    useState<MemoryExplainResult | null>(null);
  const [explanationLoading, setExplanationLoading] = useState(false);
  const [explanationError, setExplanationError] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<MemoryNeighborsResult | null>(null);
  const [neighborsLoading, setNeighborsLoading] = useState(false);
  const [neighborsError, setNeighborsError] = useState<string | null>(null);
  // Set only when the interactive canvas itself could not be mounted (e.g. no
  // WebGL in this environment) — the accessible table stays the source of
  // truth either way, so this only ever downgrades the EXTRA interactive view.
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<SigmaType<
    MemoryGraphNodeAttributes,
    MemoryGraphEdgeAttributes
  > | null>(null);
  const rafRef = useRef<number | null>(null);
  // Mirrors `selected` for the sigma nodeReducer/edgeReducer closures — sigma
  // is imperative, a React state change alone never repaints the canvas.
  const selectedRef = useRef<string | null>(null);

  const notes = useMemo(
    () =>
      activeMemoryNotes(
        props.snapshot,
        showUntrusted,
        props.autoConfirmAgentMemory
      ),
    [props.snapshot, showUntrusted, props.autoConfirmAgentMemory]
  );
  /** One tally per tier — the posture line, the cells, and the admission all
   *  read the SAME `noteTier`, so they cannot drift apart. */
  const tierCounts = useMemo(() => {
    const counts = { human: 0, muon: 0, auto: 0, open: 0 };
    for (const note of notes) {
      counts[noteTier(note, props.autoConfirmAgentMemory)] += 1;
    }
    return counts;
  }, [notes, props.autoConfirmAgentMemory]);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (notes.length === 0) {
      teardown();
      setSelected(null);
      selectedRef.current = null;
      return;
    }
    let cancelled = false;
    setSelected(null);
    setCanvasError(null);
    selectedRef.current = null;
    const graph = buildMemoryGraph(
      props.snapshot,
      showUntrusted,
      props.autoConfirmAgentMemory
    );

    async function render() {
      try {
        // Lazy WebGL dep: only loaded once the graph tab is actually visible
        // and there is something to draw — mirrors graph-view.tsx exactly.
        const { default: Sigma } = await import("sigma");
        const container = containerRef.current;
        if (cancelled || !container) return;
        const sigma = new Sigma<
          MemoryGraphNodeAttributes,
          MemoryGraphEdgeAttributes
        >(graph, container, {
          renderLabels: true,
          labelColor: { color: "#F3F4F6" },
          labelFont: "JetBrains Mono, ui-monospace, monospace",
          labelSize: 10,
          labelWeight: "500",
          labelRenderedSizeThreshold: 7,
          defaultNodeColor: "#9ca3af",
          defaultEdgeColor: "#4a4a5a",
          minCameraRatio: 0.05,
          maxCameraRatio: 20,
          hideEdgesOnMove: true,
          // Click-selection highlight — same dim/highlight shape as
          // graph-view.tsx's nodeReducer/edgeReducer, ported to this graph's
          // (undirected, unweighted) edges.
          nodeReducer: (node, nodeData) => {
            const sel = selectedRef.current;
            if (!sel) return nodeData;
            const res = { ...nodeData };
            if (node === sel) {
              res.size = nodeData.size * 1.8;
              res.zIndex = 2;
              res.highlighted = true;
              return res;
            }
            const isNeighbor = graph.hasEdge(node, sel) || graph.hasEdge(sel, node);
            if (isNeighbor) {
              res.size = nodeData.size * 1.3;
              res.zIndex = 1;
              return res;
            }
            res.zIndex = 0;
            return res;
          },
          edgeReducer: (edge, edgeData) => {
            const sel = selectedRef.current;
            if (!sel) return edgeData;
            const res = { ...edgeData };
            const [source, target] = graph.extremities(edge);
            const connected = source === sel || target === sel;
            res.size = connected
              ? Math.max(2, edgeData.size * 2.5)
              : Math.max(0.4, edgeData.size * 0.4);
            res.zIndex = connected ? 2 : 0;
            return res;
          },
        });
        sigmaRef.current = sigma;

        sigma.on("clickNode", ({ node }) => {
          const attrs = graph.getNodeAttributes(node);
          selectedRef.current = node;
          setSelected(attrs.kind === "note" ? (attrs.note ?? null) : null);
          sigma.refresh();
        });
        sigma.on("clickStage", () => {
          selectedRef.current = null;
          setSelected(null);
          sigma.refresh();
        });

        // Incremental force layout on rAF (same batching as graph-view.tsx).
        const settings = forceAtlas2.inferSettings(graph);
        let done = 0;
        const tick = () => {
          forceAtlas2.assign(graph, { iterations: LAYOUT_BATCH, settings });
          sigma.refresh();
          done += LAYOUT_BATCH;
          if (done >= LAYOUT_TOTAL_ITERATIONS) {
            sigma.getCamera().animatedReset({ duration: 250 });
            rafRef.current = null;
            return;
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (caught) {
        if (cancelled) return;
        setCanvasError(
          caught instanceof Error
            ? caught.message
            : "The interactive graph could not be rendered."
        );
      }
    }
    requestAnimationFrame(() => {
      if (!cancelled) void render();
    });

    return () => {
      cancelled = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    notes.length,
    props.snapshot,
    showUntrusted,
    props.autoConfirmAgentMemory,
    teardown,
  ]);

  // Keep sigma's canvas in sync with the container (splitter drag, window
  // resize, sidebar collapse — none of those fire a graph rebuild).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      sigmaRef.current?.resize();
      sigmaRef.current?.refresh();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [notes.length]);

  useEffect(() => {
    if (!selected || typeof window.muon?.memoryExplain !== "function") {
      setExplanation(null);
      setExplanationLoading(false);
      setExplanationError(null);
      return;
    }
    let stopped = false;
    setExplanation(null);
    setExplanationLoading(true);
    setExplanationError(null);
    void window.muon
      .memoryExplain(selected.id)
      .then((result) => {
        if (stopped) return;
        setExplanationLoading(false);
        // B3: /explain now DEGRADES instead of throwing when the memory graph
        // is down, so the `.catch` below no longer fires for that case. Without
        // this branch an outage would render an empty provenance graph — which
        // reads as "this note has no provenance", a different and false claim.
        if (result?.degraded) {
          setExplanation(null);
          setExplanationError(
            `The provenance graph is unavailable (${result.degraded.reason}) — this is not "no provenance".`
          );
          return;
        }
        setExplanation(result);
      })
      .catch(() => {
        if (!stopped) {
          setExplanationError("Provenance is unavailable for this note.");
          setExplanationLoading(false);
        }
      });
    return () => {
      stopped = true;
    };
  }, [selected?.id]);

  // B1 neighbourhood — same lifecycle shape as the provenance read above, and
  // the same three-way honesty: unavailable-bridge, degraded-graph, and truly
  // empty are three DIFFERENT statements and never collapse into one.
  useEffect(() => {
    if (!selected || typeof window.muon?.memoryNeighbors !== "function") {
      setNeighbors(null);
      setNeighborsLoading(false);
      setNeighborsError(null);
      return;
    }
    let stopped = false;
    setNeighbors(null);
    setNeighborsLoading(true);
    setNeighborsError(null);
    void window.muon
      .memoryNeighbors(selected.id)
      .then((result) => {
        if (stopped) return;
        setNeighborsLoading(false);
        if (result?.degraded) {
          setNeighbors(null);
          setNeighborsError(
            `The memory graph is unavailable (${result.degraded.reason}) — this is not "no neighbours".`
          );
          return;
        }
        setNeighbors(result);
      })
      .catch(() => {
        if (!stopped) {
          setNeighborsError("The neighbourhood is unavailable for this note.");
          setNeighborsLoading(false);
        }
      });
    return () => {
      stopped = true;
    };
  }, [selected?.id]);

  return (
    <div className="memory-graph-shell">
      <label className="memory-graph-toggle">
        <input
          checked={showUntrusted}
          onChange={(event) => setShowUntrusted(event.target.checked)}
          type="checkbox"
        />
        Include pending proposals
      </label>
      {/* P0-3: the counts are derived from the SAME `noteTier` the table cells
          and the Crew-memory tab read, so this line can never describe a note
          one way here and another way one tab over. The DEFAULT view is the
          memory the crew is working from — human + vouched + auto tiers — not
          only the vouched slice (which once left 12 of 13 notes in neither
          bucket of this very line). */}
      <strong className="memory-graph-posture">
        <span>
          {showUntrusted ? "Pending proposals included" : "In crew use"}
        </span>
        <small>
          {[
            `${tierCounts.human + tierCounts.muon} settled`,
            ...(tierCounts.auto > 0 ? [`${tierCounts.auto} auto`] : []),
            `${tierCounts.open} pending`,
          ].join(" · ")}
        </small>
      </strong>
      {notes.length === 0 ? (
        <div className="brain-empty">
          No crew memory yet. Your crew's notes appear here as they work.
        </div>
      ) : (
        <>
          <div className="memory-graph-stage">
            <div
              aria-label="Memory relationship graph"
              className="memory-graph-canvas"
              ref={containerRef}
              role="img"
            />
            {canvasError ? (
              <div className="memory-graph-canvas-error" role="status">
                Interactive graph unavailable — the table below has the full
                data.
              </div>
            ) : null}
            {selected ? (
              <div className="graph-detail memory-graph-detail" role="status">
                <button
                  className="graph-detail-close"
                  onClick={() => {
                    setSelected(null);
                    selectedRef.current = null;
                    sigmaRef.current?.refresh();
                  }}
                  title="Dismiss"
                >
                  ×
                </button>
                <div className="memory-graph-detail-badges">
                  {(() => {
                    // WIN 3: auto-written crew memory reads as active, not a
                    // yellow "review" flag (framing only — see memoryNoteTier).
                    // R3: a lapsed note is never framed as active crew memory.
                    // P0-3: and a MUON-VOUCHED note is named for the tier it
                    // actually holds. This chip used to say "Auto · crew" for a
                    // note the Crew-memory tab calls "Auto-approved by MUON" and
                    // this very table calls "muon-approved" — one note, three
                    // names, one of them a demotion.
                    const tier = noteTier(selected, props.autoConfirmAgentMemory);
                    return (
                      <span
                        className={`brain-chip${tier === "open" ? " warn" : ""}`}
                      >
                        {tier === "human"
                          ? "Trusted"
                          : tier === "muon"
                            ? "Auto-approved by MUON"
                            : tier === "auto"
                              ? "Auto · crew"
                              : "Review needed"}
                      </span>
                    );
                  })()}
                  <span className="brain-chip subtle">{selected.trust} confidence</span>
                  {/* Same provenance fact as the card badge: a model wrote it and
                      nobody has confirmed it. The Author row below spells the
                      principal out; this makes it legible at a glance. */}
                  {machineExtractedUnreviewed(selected) ? (
                    <span
                      className="brain-chip subtle"
                      title="Extracted by a model from agent output. No human has confirmed it."
                    >
                      Machine-extracted
                    </span>
                  ) : null}
                  {selected.stale ? (
                    <span className="brain-chip warn">May be outdated</span>
                  ) : null}
                  {isExpiredNote(selected) ? (
                    <span className="brain-chip lapsed">EXPIRED</span>
                  ) : null}
                  <span className="brain-chip subtle">{selected.kind}</span>
                </div>
                <p className="memory-graph-detail-text">{selected.text}</p>
                <dl className="memory-graph-detail-meta">
                  <dt>Author</dt>
                  <dd>{selected.createdBy}</dd>
                  <dt>Created</dt>
                  <dd>{new Date(selected.createdAt).toLocaleString()}</dd>
                  <dt>Updated</dt>
                  <dd>{new Date(selected.updatedAt).toLocaleString()}</dd>
                  <dt>Accessed</dt>
                  <dd>
                    {selected.accessCount} time{selected.accessCount === 1 ? "" : "s"}
                  </dd>
                  {/* R3: a deadline is only legible if it is shown BEFORE it
                      passes, so the live countdown lives here too. Absent when
                      the note never expires. */}
                  {selected.expiresAt ? (
                    <>
                      <dt>{isExpiredNote(selected) ? "Expired" : "Expires"}</dt>
                      <dd>
                        {ttlLabel(selected, Date.now()) ??
                          new Date(selected.expiresAt).toLocaleString()}{" "}
                        · {new Date(selected.expiresAt).toLocaleString()}
                      </dd>
                    </>
                  ) : null}
                  {selected.taskId ? (
                    <>
                      <dt>Task</dt>
                      <dd>{selected.taskId}</dd>
                    </>
                  ) : null}
                  {selected.laneId ? (
                    <>
                      <dt>Lane</dt>
                      <dd>{selected.laneId}</dd>
                    </>
                  ) : null}
                  <dt>Scope</dt>
                  <dd>{selected.scope}</dd>
                </dl>
                {[...selected.modules, ...selected.symbols, ...selected.topics].length >
                0 ? (
                  <div className="memory-graph-detail-coordinates">
                    <span className="brain-label">Coordinates</span>
                    <div className="memory-coordinates">
                      {[
                        ...selected.modules,
                        ...selected.symbols,
                        ...selected.topics,
                      ].map((coordinate) => (
                        <span key={coordinate}>{coordinate}</span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="memory-graph-detail-relations">
                  <span className="brain-label">Relations</span>
                  {props.snapshot.edges.filter(
                    (edge) => edge.fromId === selected.id || edge.toId === selected.id
                  ).length === 0 ? (
                    <span className="brain-empty">None</span>
                  ) : (
                    <ul className="brain-list">
                      {props.snapshot.edges
                        .filter(
                          (edge) =>
                            edge.fromId === selected.id || edge.toId === selected.id
                        )
                        .map((edge) => (
                          <li key={edge.id}>
                            {edge.kind} ·{" "}
                            {edge.fromId === selected.id ? edge.toId : edge.fromId}
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
                <div className="memory-graph-detail-relations">
                  <span className="brain-label">Why the brain believes this</span>
                  {explanationLoading ? (
                    <span className="brain-empty">Tracing provenance…</span>
                  ) : explanationError ? (
                    <span className="brain-empty">{explanationError}</span>
                  ) : explanation && explanation.path.nodes.length > 0 ? (
                    <>
                      <ol className="brain-list">
                        {explanation.path.nodes.map((node, index) => (
                          <li key={node.id}>
                            {index > 0 ? (
                              <strong>
                                {explanation.path.edges[index - 1]?.relation ?? "RELATED"}{" "}
                                ·{" "}
                              </strong>
                            ) : null}
                            <code>{node.entityId}</code>
                            {node.text ? <span> — {node.text}</span> : null}
                          </li>
                        ))}
                      </ol>
                      {explanation.contradictions.length > 0 ? (
                        <>
                          <span className="brain-label">Contradictions</span>
                          <ul className="brain-list">
                            {explanation.contradictions.map((node) => (
                              <li key={node.id}>
                                <code>{node.entityId}</code>
                                {node.text ? <span> — {node.text}</span> : null}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <span className="brain-empty">
                      No governed provenance path is available.
                    </span>
                  )}
                </div>
                <div className="memory-graph-detail-relations">
                  <span className="brain-label">
                    What this is connected to
                  </span>
                  {neighborsLoading ? (
                    <span className="brain-empty">
                      Reading the neighbourhood…
                    </span>
                  ) : neighborsError ? (
                    <span className="brain-empty">{neighborsError}</span>
                  ) : neighbors ? (
                    (() => {
                      const rows = neighborRows(neighbors);
                      if (rows.length === 0) {
                        return (
                          <span className="brain-empty">
                            Nothing is linked to this note yet.
                          </span>
                        );
                      }
                      const shown = rows.slice(0, NEIGHBOR_DISPLAY_CAP);
                      return (
                        <>
                          <ul className="brain-list memory-neighbor-list">
                            {shown.map((row) => (
                              <li key={row.id}>
                                <strong>{row.relation} · </strong>
                                <span className="memory-neighbor-type">
                                  {NEIGHBOR_TYPE_LABEL[row.type] ?? row.type}
                                </span>{" "}
                                <code>{row.entityId}</code>
                                {row.text ? (
                                  <span> — {row.text}</span>
                                ) : (
                                  /* The gate withheld this node's text. Say so
                                     rather than leaving a bare coordinate that
                                     reads like a rendering bug — and never fill
                                     it in from locally-held prose. */
                                  <span className="memory-neighbor-gated">
                                    {" "}
                                    — coordinates only
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                          <span className="memory-neighbor-bound">
                            {rows.length > shown.length
                              ? `Showing ${shown.length} of ${rows.length} · one hop out`
                              : `${rows.length} link${rows.length === 1 ? "" : "s"} · one hop out`}
                            {neighbors.provenance.truncated
                              ? " · the graph had more than this bound allows"
                              : ""}
                          </span>
                        </>
                      );
                    })()
                  ) : (
                    <span className="brain-empty">
                      The neighbourhood has not been read for this note.
                    </span>
                  )}
                </div>
              </div>
            ) : null}
          </div>
          <div className="memory-graph-table-wrap">
            <table aria-label="Accessible memory graph data">
              <thead>
                <tr>
                  <th>Memory</th>
                  <th>Status</th>
                  <th>Coordinates</th>
                  <th>Relations</th>
                </tr>
              </thead>
              <tbody>
                {notes.map((note) => (
                  <tr key={note.id}>
                    <td>
                      <button
                        className="link-button"
                        onClick={() => {
                          selectedRef.current = noteNodeId(note.id);
                          setSelected(note);
                          sigmaRef.current?.refresh();
                        }}
                        type="button"
                      >
                        {note.text}
                      </button>
                    </td>
                    {/* P0-2: "pending" is a DEBT word. A MUON-vouched note read
                        as pending here — the same string class that had the
                        founder confirming settled memory by hand — so the
                        vouched tier is named instead, and "pending" is kept for
                        notes nobody has vouched for. An EXPIRED note is pending
                        again whatever once vouched for it. */}
                    <td>
                      {noteTierLabel(
                        noteTier(note, props.autoConfirmAgentMemory)
                      )}{" "}
                      · {note.trust}
                      {isExpiredNote(note) ? " · expired" : ""}
                    </td>
                    <td>{[...note.modules, ...note.symbols].join(", ") || "none"}</td>
                    <td>
                      {props.snapshot.edges
                        .filter((edge) => edge.fromId === note.id || edge.toId === note.id)
                        .map((edge) => edge.kind)
                        .join(", ") || "none"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * R3 TTL — the library's honest empty state. "No memories" is a LIE when the
 * only thing wrong is that every match lapsed, and that lie is exactly how a
 * brain looks broken: notes vanish, the shelf reads empty, the user concludes
 * memory is gone. Each branch says which world it is in and, when there is
 * something to recover, offers the one action that recovers it.
 */
function LibraryEmptyState(props: {
  expiredProbing: boolean;
  hiddenExpired: number;
  onShowExpired: () => void;
  query: string;
  showExpired: boolean;
}) {
  if (props.showExpired) {
    return (
      <div className="brain-empty memory-library-empty">
        <strong>
          {props.query
            ? "Nothing matches this search, including expired memories."
            : "No memories yet — not even expired ones."}
        </strong>
        <span>
          Memory fills itself as the crew works; confirmed notes never expire.
        </span>
      </div>
    );
  }
  if (props.expiredProbing) {
    return (
      <div className="brain-empty memory-library-empty loading-line">
        <strong>Checking whether anything expired…</strong>
      </div>
    );
  }
  if (props.hiddenExpired > 0) {
    return (
      <div className="brain-empty memory-library-empty">
        <strong>
          Nothing live here — {props.hiddenExpired} memor
          {props.hiddenExpired === 1 ? "y" : "ies"} expired.
        </strong>
        <span>
          They lapsed unconfirmed, so recall hides them — hidden, not deleted.
          Confirming one restores it permanently.
        </span>
        <button className="ghost-btn" onClick={props.onShowExpired} type="button">
          Show expired
        </button>
      </div>
    );
  }
  return (
    <div className="brain-empty memory-library-empty">
      <strong>
        {props.query ? "Nothing matches this search." : "No memories yet."}
      </strong>
      <span>
        If something you expect is missing, turn on Show expired — a lapsed note
        is hidden, never deleted.
      </span>
    </div>
  );
}

export function MemoryWorkspace(props: Props) {
  const [tab, setTab] = useState<MemoryTab>("inbox");
  // Everything the crew has learned that is still live. P0-2: this is the LOG,
  // not the queue — with the orchestrator vouching, most of it is settled
  // knowledge the operator never has to touch.
  const learned = useMemo(
    () =>
      props.snapshot?.notes.filter(
        (note) => note.status === "active" && !note.confirmed
      ) ?? [],
    [props.snapshot]
  );
  // The QUEUE: what still wants a human. Two tiers can sit here, and the
  // second one depends on the operator's STANDING CONSENT posture:
  //
  //  - tier "open" is always a debt. Nobody vouched, nothing is carrying it.
  //  - tier "auto" (crew-VISIBLE under the auto posture, but nobody vouched on
  //    the record) is a debt ONLY while the operator is still reviewing. With
  //    standing consent armed, the operator has said in the loudest control
  //    the app has that routine decisions are delegated — so presenting these
  //    as a queue is MUON demanding review it was explicitly told not to ask
  //    for. They move to the settled log, where Reject is still one click.
  //
  // Byte-identical to the previous behaviour when standing consent is off,
  // which is what the "auto is weaker than a vouch" tests pin.
  //
  // What this NEVER changes: an "auto" note is still `confirmed: false`, so it
  // still cannot gate an edit. ADR-0027's human-confirmed-only rule is
  // untouched — this moves a note between two READING surfaces, never between
  // trust tiers.
  const isDebt = useCallback(
    (note: MemoryLibraryNote) => {
      const tier = noteTier(note, props.autoConfirmAgentMemory ?? false);
      if (tier === "open") return true;
      return tier === "auto" && !props.standingConsent;
    },
    [props.autoConfirmAgentMemory, props.standingConsent]
  );
  const pending = useMemo(
    () => learned.filter((note) => isDebt(note)),
    [learned, isDebt]
  );
  /** Settled crew knowledge: already usable by every agent, nothing owed. */
  const vouched = useMemo(
    () => learned.filter((note) => !isDebt(note)),
    [learned, isDebt]
  );
  const hotModules = useMemo(
    () => props.snapshot?.analytics?.hotModules.slice(0, 8) ?? [],
    [props.snapshot]
  );
  const showExpired = props.showExpired ?? false;
  // With the toggle ON the lapsed notes are IN the snapshot, so the count is
  // exact and free; with it OFF they were never sent and the caller's probe is
  // the only honest source. Never guess from an absent field.
  const expiredInSnapshot = useMemo(
    () => props.snapshot?.notes.filter(isExpiredNote).length ?? 0,
    [props.snapshot]
  );
  const hiddenExpired = showExpired ? 0 : (props.hiddenExpiredCount ?? 0);
  // P1.4: first import-provenance row per note (rows arrive newest-first) so a
  // card can show WHERE an imported proposal came from before it is trusted.
  const importsByNote = useMemo(() => {
    const map = new Map<string, MemoryLibraryImport>();
    for (const row of props.snapshot?.imports ?? []) {
      if (row.noteId && !map.has(row.noteId)) {
        map.set(row.noteId, row);
      }
    }
    return map;
  }, [props.snapshot]);
  /**
   * ADR-0026 §9 — WHICH WORKSPACE this page is showing, derived from the rows the
   * server actually returned rather than from a prop.
   *
   * The desktop is chat-forced AND (as of step 4) workspace-forced in `main.ts`, so
   * this should always be exactly one value. Deriving it from the DATA rather than
   * echoing the request is what makes it a check as well as a label: if the fence
   * ever regresses, a second entry appears here instead of the page quietly mixing
   * two repos the way §1 measured the operator library doing. `null` renders as
   * "unscoped", the §8 residue.
   */
  const workspaceScope = useMemo(() => {
    const seen = new Set<string>();
    for (const note of props.snapshot?.notes ?? []) {
      seen.add(note.workspacePath ?? "unscoped");
    }
    return [...seen].sort();
  }, [props.snapshot]);
  const provenance = useMemo(() => {
    if (!props.snapshot) return [];
    return [
      ...props.snapshot.notes.map((note) => ({
        id: `author:${note.id}`,
        at: note.createdAt,
        text: `${note.createdBy} authored`,
        note: note.text,
      })),
      ...props.snapshot.confirmations.map((confirmation) => ({
        id: confirmation.id,
        at: confirmation.at,
        text: `${confirmation.principal} ${decisionLabel(confirmation.decision)}`,
        note:
          props.snapshot?.notes.find(
            (note) => note.id === confirmation.noteId
          )?.text ?? confirmation.noteId,
      })),
    ].sort((left, right) => right.at.localeCompare(left.at));
  }, [props.snapshot]);

  return (
    <section className="memory-workspace" aria-label="Memory workspace">
      <header className="workspace-page-head">
        <strong>Memory</strong>
        <span>
          What the crew has learned in this workspace, and what still needs you.
        </span>
      </header>
      <div className="memory-workspace-tabs" role="tablist">
        {(
          ["inbox", "library", "graph", "provenance", "governance"] as const
        ).map((key) => (
          <button
            aria-selected={tab === key}
            className={tab === key ? "active" : ""}
            key={key}
            onClick={() => setTab(key)}
            role="tab"
          >
            {/* P0-2: named for what it IS now — a log of what the crew learned.
                The count is a DEBT counter, so it appears only when something
                genuinely still wants a human; vouched crew memory never inflates
                it. Calling settled knowledge "Review inbox (24)" is what made
                usable memory read as homework. */}
            {key === "inbox"
              ? `Crew memory${pending.length ? ` (${pending.length})` : ""}`
              : key[0]!.toUpperCase() + key.slice(1)}
          </button>
        ))}
      </div>

      {workspaceScope.length > 0 ? (
        <p className="memory-workspace-scope">
          <strong>Workspace</strong>
          {/* One entry is the invariant. More than one is a fence regression and is
              shown as such rather than silently concatenated into prose. */}
          {workspaceScope.map((workspace) => (
            <code key={workspace}>{workspace}</code>
          ))}
          {workspaceScope.length > 1 ? (
            <em>
              This page spans more than one workspace — memory is scoped per repo,
              so this is unexpected.
            </em>
          ) : null}
        </p>
      ) : null}

      {hotModules.length > 0 ? (
        <aside className="memory-hot-modules" aria-label="Hot memory modules">
          <strong>Hot modules</strong>
          <div className="memory-coordinates">
            {hotModules.map((module) => (
              <span key={module.module}>
                {module.module}
                <small>
                  {Math.round(module.score * 100)} · {module.noteCount} notes
                </small>
              </span>
            ))}
          </div>
        </aside>
      ) : null}

      {props.error ? <div className="brain-error">{props.error}</div> : null}
      {props.loading && !props.snapshot ? (
        <div className="brain-empty loading-line">Loading memory…</div>
      ) : null}

      {tab === "inbox" && props.snapshot ? (
        <>
          {/* The exception path, first and only when it exists. */}
          {pending.length > 0 ? (
            <>
              <h3 className="memory-section-heading">Needs you</h3>
              <div className="memory-card-grid">
                {pending.map((note) => (
                  <MemoryCard
                    key={note.id}
                    note={note}
                    origin={importsByNote.get(note.id)}
                    review
                    autoConfirmAgentMemory={props.autoConfirmAgentMemory}
                standingConsent={props.standingConsent}
                    onDecide={props.onDecide}
                  />
                ))}
              </div>
            </>
          ) : null}

          <h3 className="memory-section-heading">What the crew learned</h3>
          <p className="memory-section-note">
            {vouched.length > 0
              ? "MUON auto-approved these, so every agent is already working from them. Nothing here is waiting on you — reject one if it is wrong."
              : "Notes your agents learn appear here, ready for the whole crew to use."}
          </p>
          <div className="memory-card-grid">
            {vouched.map((note) => (
              <MemoryCard
                key={note.id}
                note={note}
                origin={importsByNote.get(note.id)}
                // `review` here buys exactly ONE action: Reject. A settled card
                // renders no confirm affordance at all (MemoryCard's
                // `showConfirm`) — this tab is a log of settled knowledge, and a
                // row of Confirm buttons is what a review queue looks like. The
                // human confirm lives on the Library, where it is a PROMOTION.
                review
                autoConfirmAgentMemory={props.autoConfirmAgentMemory}
                standingConsent={props.standingConsent}
                onDecide={props.onDecide}
              />
            ))}
            {vouched.length === 0 && pending.length === 0 ? (
              <div className="brain-empty saas-empty">
                <strong>Nothing learned yet</strong>
                <span>
                  Finished runs and confirmed notes will show up here for this
                  mission.
                </span>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "library" && props.snapshot ? (
        <>
          <form
            className="memory-library-search"
            onSubmit={(event) => {
              event.preventDefault();
              props.onRefresh();
            }}
          >
            <input
              aria-label="Search all memory"
              onChange={(event) => props.onQueryChange(event.target.value)}
              placeholder="Search decisions, files, or symbols…"
              role="searchbox"
              value={props.query}
            />
            <button
              className={`primary-btn${props.loading ? " loading-line" : ""}`}
              disabled={props.loading}
              type="submit"
            >
              {props.loading ? "Searching…" : "Search"}
            </button>
          </form>
          {/* R3 TTL. Deliberately an OPERATOR affordance on the human review
              surface only — the flag is silently downgraded for agent-tier
              callers server-side, and nothing here is ever rendered into an
              agent-facing view. */}
          <div className="memory-library-controls">
            <label className="memory-library-toggle">
              <input
                checked={showExpired}
                onChange={(event) =>
                  props.onShowExpiredChange?.(event.target.checked)
                }
                type="checkbox"
              />
              Show expired
            </label>
            <span className="memory-library-toggle-hint">
              {showExpired
                ? "Lapsed memories are listed — confirm one to restore it permanently."
                : "Unconfirmed agent notes lapse after their TTL and drop out of recall."}
            </span>
          </div>
          {/* P0-3: the ONE place the human confirm is explained, so the quiet
              "Confirm to promote" on a settled card is legible without turning
              every card into a request. Capability, never debt. */}
          <p className="memory-section-note">
            Everything the crew can recall. MUON-approved notes are already in
            use — confirming one yourself promotes it: global scope, team pack
            export, protection from low-trust overwrites, merge attestation. Pin
            a confirmed global decision to include it in every new agent brief
            for this workspace.
          </p>
          <div className="memory-library-summary">
            {props.snapshot.total} memories
            {props.snapshot.truncated ? " · showing the newest 200" : ""}
            {showExpired && expiredInSnapshot > 0
              ? ` · ${expiredInSnapshot} expired`
              : ""}
            {!showExpired && hiddenExpired > 0
              ? ` · ${hiddenExpired} expired hidden`
              : ""}
          </div>
          <div className="memory-card-grid">
            {props.snapshot.notes.map((note) => (
              <MemoryCard
                key={note.id}
                note={note}
                origin={importsByNote.get(note.id)}
                autoConfirmAgentMemory={props.autoConfirmAgentMemory}
                standingConsent={props.standingConsent}
                // P0-3: the Library is the durable shelf — you searched for a
                // note because you want something done with it — so this is the
                // one surface where a SETTLED note offers the human confirm, as
                // a quiet, explicitly-labelled PROMOTION (global scope, pack
                // export, KG-6 protection, merge attestation). It is never an
                // "approve this" ask: MUON already approved it for the crew.
                promote
                manage
                // Redemption has to be reachable from the library, not only
                // from the inbox: the toggle is where a lapsed note is found.
                onDecide={props.onDecide}
              />
            ))}
            {props.snapshot.notes.length === 0 ? (
              <LibraryEmptyState
                expiredProbing={props.expiredProbing ?? false}
                hiddenExpired={hiddenExpired}
                onShowExpired={() => props.onShowExpiredChange?.(true)}
                query={props.query}
                showExpired={showExpired}
              />
            ) : null}
          </div>
        </>
      ) : null}

      {tab === "graph" && props.snapshot ? (
        <MemoryGraph
          snapshot={props.snapshot}
          autoConfirmAgentMemory={props.autoConfirmAgentMemory ?? false}
        />
      ) : null}

      {/* Item 6: the controls OVER memory's lifecycle, on the surface where a
          human reads it. Deliberately not gated on `props.snapshot`: a policy
          is machine-wide and readable even when this workspace has no notes. */}
      {tab === "governance" ? <MemoryGovernancePanel /> : null}

      {tab === "provenance" && props.snapshot ? (
        <ol className="memory-provenance-list">
          {provenance.map((event) => (
            <li key={event.id}>
              <time>{new Date(event.at).toLocaleString()}</time>
              <strong>{event.text}</strong>
              <span>{event.note}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
