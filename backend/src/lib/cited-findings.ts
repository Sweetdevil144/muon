import type { PeerMessageKind } from "@muon/protocol";

/**
 * ADR-0035 — a sibling's finding arrives at the edit boundary.
 *
 * The join that was missing for stance test T1 ("a reviewer finds a defect and
 * the implementer learns it without the human relaying it"): `peer_message`
 * could already cite a note by coordinate (`refs.noteIds`, ADR-0027 D13), and
 * the pre-edit gate could already push notes onto an edit radius (§3.3's
 * path-triggered injection). Nothing connected them, so a finding from thirty
 * seconds ago sat in an inbox the implementer had no reason to re-read.
 *
 * The safety property is structural rather than checked: this module never
 * fetches a note BY ID. It is handed the notes the reader's own governed read
 * already returned, and it only reorders and labels them. A citation therefore
 * cannot promote a note's trust tier, cannot reach across a partition, and
 * cannot surface something the reader was not already permitted to see — the
 * D13-D laundering path stays closed by construction, not by a guard someone
 * could forget.
 */

/** The kinds that carry a finding. Chatter is not a finding. */
const FINDING_KINDS: readonly PeerMessageKind[] = [
  "review_verdict",
  "constraint",
  "blocked",
  // Slice 2's atomic publish (2026-08-10): `publish_finding` writes the note
  // and the announcement together, with `refs.noteIds` carrying the note id —
  // built for exactly this join, and then never added here, so the one kind
  // NAMED "finding" was the one kind the citation channel ignored. The live
  // two-contender test measured the gap: the loser's inbox was empty while
  // the winner had already published.
  "finding",
];

export type CitingPeer = {
  readonly jobId: string;
  readonly role: string;
  readonly kind: PeerMessageKind;
  readonly messageId: string;
  readonly createdAt: string;
};

/** The subset of a peer message this module needs. Deliberately no body. */
export type CitationSource = {
  readonly id: string;
  readonly fromJobId: string;
  readonly fromRole: string;
  readonly kind: string;
  readonly createdAt: Date | string;
  /**
   * Stored JSON, so it arrives as `unknown` from the database and is narrowed
   * below rather than trusted. A malformed `refs` yields no citations instead
   * of throwing inside a gate read — a finding that cannot be parsed is a
   * finding not delivered, never a failed gate.
   */
  readonly refs?: unknown;
};

/** Read `refs.noteIds` out of arbitrary stored JSON, or nothing. */
function noteIdsOf(refs: unknown): string[] {
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return [];
  const ids = (refs as { noteIds?: unknown }).noteIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id !== "");
}

export type CitedNote<T> = {
  readonly note: T;
  readonly citedBy: CitingPeer;
};

function isFindingKind(kind: string): kind is PeerMessageKind {
  return (FINDING_KINDS as readonly string[]).includes(kind);
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Map note id → the peer citation that should be shown with it.
 *
 * When several peers cite the same note, the MOST RECENT citation wins: the
 * operator-visible question is "who is telling me this now", and an older
 * citation of the same coordinate adds nothing the note itself does not carry.
 * Self-citations are dropped — a lane pointing at its own note has not learned
 * anything from the crew, and labelling it as a peer finding would be a lie.
 */
export function citationsByNote(
  messages: readonly CitationSource[],
  readerJobId: string
): Map<string, CitingPeer> {
  const out = new Map<string, CitingPeer>();
  for (const message of messages) {
    if (!isFindingKind(message.kind)) continue;
    if (message.fromJobId === readerJobId) continue;
    const noteIds = noteIdsOf(message.refs);
    for (const noteId of noteIds) {
      const candidate: CitingPeer = {
        jobId: message.fromJobId,
        role: message.fromRole,
        kind: message.kind,
        messageId: message.id,
        createdAt: asIso(message.createdAt),
      };
      const existing = out.get(noteId);
      if (!existing || existing.createdAt < candidate.createdAt) {
        out.set(noteId, candidate);
      }
    }
  }
  return out;
}

/**
 * Split candidate notes into the cited ones and the rest, preserving each
 * group's incoming order.
 *
 * `candidates` MUST be the output of the reader's own governed read. Passing a
 * wider set here is the one way to break ADR-0035 D1, which is why this
 * function takes notes rather than ids.
 */
export function partitionCited<T extends { id: string }>(
  candidates: readonly T[],
  citations: ReadonlyMap<string, CitingPeer>
): { cited: CitedNote<T>[]; uncited: T[] } {
  const cited: CitedNote<T>[] = [];
  const uncited: T[] = [];
  for (const note of candidates) {
    const citedBy = citations.get(note.id);
    if (citedBy) {
      cited.push({ note, citedBy });
    } else {
      uncited.push(note);
    }
  }
  return { cited, uncited };
}

/**
 * Injection order under one shared budget (D4): cited findings first, then
 * standing notes.
 *
 * A finding about THIS radius from THIS mission is fresher evidence than a
 * standing convention the agent has probably already seen. Sharing the cap
 * rather than adding a channel is what makes a chatty crew degrade to "some
 * findings wait for the next preflight" instead of "the gate is full of peer
 * chatter".
 */
export function orderForInjection<T extends { id: string }>(
  candidates: readonly T[],
  citations: ReadonlyMap<string, CitingPeer>
): { note: T; citedBy?: CitingPeer }[] {
  const { cited, uncited } = partitionCited(candidates, citations);
  return [
    ...cited.map((entry) => ({ note: entry.note, citedBy: entry.citedBy })),
    ...uncited.map((note) => ({ note })),
  ];
}

/**
 * The label shown with an injected finding. Coordinates only — the citing
 * message's subject and body never travel (D2); an implementer that wants the
 * reviewer's wording calls `peer_inbox`, which is the boundary it opens itself.
 */
export function describeCitation(citedBy: CitingPeer): string {
  return `cited by ${citedBy.role} (${citedBy.kind})`;
}
