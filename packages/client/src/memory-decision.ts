import type { MemoryNote } from "./types.js";
import { memoryNoteTier } from "./memory-tier.js";

/**
 * Governed memory writes, and the markers that describe a note — one
 * implementation, because both have already drifted once.
 *
 * THE REJECT PAYLOAD IS THE WARNING. A rejection must send `confirmed:false`
 * AND `status:"rejected"`, because the two fields do different work:
 *
 *  - `confirmed: false` is what makes it an ADJUDICATION. The ledger only
 *    mints a Confirmation when `confirmed !== undefined`
 *    (`memory-ledger.ts`), and only then is `principal` read at all — so a
 *    status-only write leaves no confirming principal in the note's lineage.
 *  - `status: "rejected"` is what durably RETIRES it. Without it a rejected
 *    note stays active and re-surfaces in recall — an operator-facing lie.
 *
 * PRECISION, because an earlier version of this comment (and my commit
 * message) claimed a bare status write "skipped the operator gate": it does
 * NOT. `requireOperator` is unconditional and FIRST on `PATCH /:noteId`
 * (`backend/src/routes/memory.ts`), deliberately, so the agent tier cannot
 * use PATCH as a note-existence oracle. What a status-only write skips is the
 * CONFIRMATION LINEAGE, not the HTTP gate. Corrected here rather than left to
 * propagate, since three surfaces already carry the looser wording.
 *
 * `principal` rides on confirm, reject AND pin/unpin — and the pin case is the
 * one I got wrong first. The ledger reads it in the `confirmed !== undefined`
 * branch AND in the `pinned !== undefined` branch, where it is an AUTHORITY
 * CHECK: `parsePrincipal(update.principal ?? "system")` must be human-kind or
 * the write throws "Only a human operator may pin or unpin memory"
 * (`backend/src/lib/memory-ledger.ts`). Omitting it survives today only
 * because the HTTP route overwrites the field with `confirmingPrincipal()`
 * before calling the ledger — so a caller using this "one place" builder
 * against the ledger directly would get a throw, which is precisely the
 * failure a shared builder exists to prevent.
 *
 * `pause`/`resume` genuinely do not need it: neither branch reads it.
 */

export type MemoryAction =
  | "confirm"
  | "reject"
  | "pause"
  | "resume"
  | "pin"
  | "unpin";

export type MemoryDecisionPayload = {
  noteId: string;
  confirmed?: boolean;
  status?: "active" | "paused" | "rejected";
  pinned?: boolean;
  principal?: string;
};

/**
 * The human principal. Only a HUMAN principal elevates a note into gate
 * views, so it is stamped on every governed decision rather than left to the
 * ledger's default — the default is right, but a surface that relies on a
 * default cannot be read as making a claim.
 */
const HUMAN_PRINCIPAL = "human";

export function buildMemoryDecision(
  noteId: string,
  action: MemoryAction
): MemoryDecisionPayload {
  switch (action) {
    case "confirm":
      // A human confirm also CLEARS expiry server-side — the redemption path.
      return { noteId, confirmed: true, principal: HUMAN_PRINCIPAL };
    case "reject":
      // BOTH halves. See the header: each was a separate production defect.
      return {
        noteId,
        confirmed: false,
        status: "rejected",
        principal: HUMAN_PRINCIPAL,
      };
    case "pause":
      return { noteId, status: "paused" };
    case "resume":
      return { noteId, status: "active" };
    case "pin":
      // The ledger ENFORCES a human principal on this branch — see the header.
      return { noteId, pinned: true, principal: HUMAN_PRINCIPAL };
    case "unpin":
      return { noteId, pinned: false, principal: HUMAN_PRINCIPAL };
  }
}

/**
 * The markers a note carries, derived once.
 *
 * `needsReview` is a DEBT marker (P0-2), and the rule is subtle enough that
 * two surfaces must not re-derive it: it must mean NOBODY has vouched for the
 * note — not merely that no human has. A note the orchestrator settled is
 * crew memory already in every brief, and flagging it billed the operator for
 * work MUON had done.
 */
export type MemoryMarkers = {
  readonly confirmed: boolean;
  /** Settled by MUON but not by a human — shown as `·muon`, not as debt. */
  readonly vouched: boolean;
  readonly needsReview: boolean;
  readonly autoCaptured: boolean;
  readonly expired: boolean;
  readonly stale: boolean;
  readonly pinned: boolean;
  readonly paused: boolean;
};

export function memoryNoteMarkers(
  note: MemoryNote,
  /**
   * The crew-visible posture. NOT optional-with-a-default: "settled" depends
   * on it (a crew-visible "auto" note is settled memory, not homework), and a
   * surface that forgot to pass it would silently bill the operator for work
   * MUON had done — which is exactly how this panel's private copy drifted.
   */
  autoConfirmAgentMemory: boolean
): MemoryMarkers {
  const settled = memoryNoteTier(note, autoConfirmAgentMemory) !== "open";
  return {
    confirmed: note.confirmed === true,
    vouched: !note.confirmed && settled,
    needsReview: !settled && note.status === "active",
    autoCaptured: note.createdBy.startsWith("muon-"),
    // Expiry is decided SERVER-side (derived from `expiresAt` at read time);
    // a surface only reports it. `expiredAt` is a sweeper audit marker and is
    // never read for this.
    expired: note.expired === true,
    stale: note.stale === true,
    pinned: note.pinned === true,
    paused: note.status === "paused",
  };
}

/** The compact `[kind·markers]` tag both desks print. */
export function memoryMarkerTag(
  note: MemoryNote,
  autoConfirmAgentMemory: boolean
): string {
  const markers = memoryNoteMarkers(note, autoConfirmAgentMemory);
  const suffix = markers.confirmed
    ? "·✓"
    : markers.vouched
      ? "·muon"
      : markers.needsReview && markers.autoCaptured
        ? "·review"
        : "";
  return `[${note.kind}${markers.stale ? "·stale" : ""}${suffix}]`;
}
