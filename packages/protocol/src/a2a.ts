import { z } from "zod";
import { agentRoleSchema } from "./agent-role.js";

/**
 * A2A — governed agent-to-agent coordination.
 *
 * Until now MUON coordination was strictly vertical: a parent delegates, a
 * child returns a handoff packet. Peers on the same mission could not ask each
 * other anything, so two workers editing adjacent code discovered the conflict
 * at merge time. A2A adds the horizontal edge — and adds it under the same
 * fail-closed contract as every other agent-facing surface:
 *
 * 1. DATA, NEVER INSTRUCTIONS. `body` is agent-produced UNTRUSTED text. It
 *    rides the same class of surface as a handoff packet body: it is rendered,
 *    it is quotable, it is never executed, never treated as a directive, never
 *    an authority claim, and never enters confirmed memory. A peer message
 *    cannot approve, cannot raise a budget, cannot widen a grant.
 * 2. NO AMBIENT ADDRESSING. Every envelope's `chatId`, `missionId`, `fromJobId`
 *    and `fromRole` are derived SERVER-SIDE from the authenticated exact-job
 *    bearer. A caller-supplied coordinate is a constraint to be checked, never
 *    a source of authority — supplying someone else's jobId must 403, not
 *    impersonate.
 * 3. CHAT-BOUNDED. Delivery is confined to one CHAT — the crew working one
 *    objective, however many orchestrator root turns dispatched its members.
 *    There is no cross-chat edge, so per-chat isolation survives. `missionId`
 *    records WHICH root turn wrote a row (provenance for the audit trail) and
 *    is never the delivery scope: a chat re-roots every turn, so comparing on
 *    it partitioned single crews and made delivery silently impossible.
 * 4. PULL-BASED. Nobody is pushed a peer's text mid-turn. An agent reads its
 *    inbox when it chooses, which keeps untrusted text out of a running model
 *    turn it did not ask for.
 * 5. BOUNDED. Size, count and rate caps below are enforced at the route, not
 *    merely documented, so a looping agent cannot flood the mission.
 */

export const A2A_PROTOCOL_VERSION = 1;

/**
 * Round-3 #4 — did this payload come from a DIFFERENT protocol version?
 *
 * Every versioned A2A artifact is server-minted and client-parsed, so skew
 * presents exactly one way: a reader's schema rejects an envelope whose
 * `version` is a number it does not speak. This detector lets that reader turn
 * a generic parse error into a typed `protocol.version_skew` refusal naming
 * both versions — WITHOUT loosening any schema (the literal stays a literal).
 *
 * Deliberately shallow: the payload's own `version`, each direct child
 * object's, and the first element of each direct child array's. That covers
 * every response shape this protocol mints (`{...version}`, `{message:{…}}`,
 * `{snapshot:{…}}`, `{messages:[{…}]}`) with no recursion into agent-produced
 * text.
 */
export function detectA2AVersionSkew(payload: unknown): number | null {
  const versionOf = (value: unknown): number | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const version = (value as Record<string, unknown>).version;
    // Integers only: every version this protocol has ever minted is one, and
    // requiring it keeps a random non-MUON JSON body ({"version":"2.1"} etc.)
    // from being relabelled as skew.
    return typeof version === "number" && Number.isInteger(version)
      ? version
      : null;
  };
  const candidates: (number | null)[] = [versionOf(payload)];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const child of Object.values(payload as Record<string, unknown>)) {
      candidates.push(versionOf(child));
      // EVERY element, not just the first: a staged swap mid-rollout can
      // produce a mixed-version page whose first row is the old (valid)
      // version — exactly the scenario this refusal exists for. Bounded scan,
      // still depth-2, still no recursion into agent-produced text.
      if (Array.isArray(child)) {
        for (const element of child.slice(0, 100)) {
          candidates.push(versionOf(element));
        }
      }
    }
  }
  for (const received of candidates) {
    if (received !== null && received !== A2A_PROTOCOL_VERSION) return received;
  }
  return null;
}

/** Envelope caps. Enforced at the route; mirrored here for every surface. */
export const MAX_PEER_SUBJECT_CHARS = 120;
export const MAX_PEER_BODY_CHARS = 2000;
export const MAX_PEER_REFS = 20;
export const MAX_PEER_MESSAGES_PER_JOB = 64;
export const MAX_PEER_INBOX_PAGE = 25;
/** Minimum spacing between two sends from one job, cheap anti-flood fence. */
export const MIN_PEER_SEND_INTERVAL_MS = 250;

/**
 * What a peer message is FOR. The kind is a typed coordination verb so the
 * receiving agent (and the crew UI) can route without parsing prose:
 * - `question` / `answer`  — bounded Q&A between peers.
 * - `review_request`       — "my diff is ready, look at these files".
 * - `review_verdict`       — a reviewer's bounded outcome for a request.
 * - `constraint`           — "this invariant must hold in your area too".
 *   NOTE: a constraint is still untrusted data. It is a HINT to the receiving
 *   agent; only a human-confirmed memory note is a binding constraint.
 * - `status`               — a coordinate-level progress ping.
 * - `blocked`              — "I cannot proceed until X"; escalates in the UI.
 */
/**
 * A POSITIVE list (ADR-0022 rule 2). `finding` was added deliberately when
 * `publish_finding` shipped — the inbox refused to serialize it until this
 * line existed, which is the deny-first design working rather than an obstacle
 * to route around.
 */
export const peerMessageKindSchema = z.enum([
  "finding",
  "question",
  "answer",
  "review_request",
  "review_verdict",
  "constraint",
  "status",
  "blocked",
]);
export type PeerMessageKind = z.infer<typeof peerMessageKindSchema>;

const recordId = z.string().trim().min(1).max(128);

/**
 * Addressing modes. `role` and `crew` fan out within the SAME mission only;
 * they are not a broadcast to the whole workspace.
 */
export const peerAddressSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("job"), jobId: recordId }),
  z.object({ kind: z.literal("role"), role: agentRoleSchema }),
  z.object({ kind: z.literal("crew") }),
]);
export type PeerAddress = z.infer<typeof peerAddressSchema>;

/**
 * Coordinate references. Paths, symbols, and note ids are COORDINATES, not
 * content: they let a peer say "look at src/foo.ts:bar" or "see note mem-…"
 * without shipping file/note text through an untrusted channel that bypasses
 * the memory gate. A `noteIds` cite never confirms or ingests (ADR-0027 D13).
 */
export const peerRefsSchema = z
  .object({
    files: z.array(z.string().min(1).max(260)).max(MAX_PEER_REFS).default([]),
    symbols: z.array(z.string().min(1).max(200)).max(MAX_PEER_REFS).default([]),
    /** Memory note ids as untrusted pointers — reader must recall, never obey. */
    noteIds: z.array(z.string().min(1).max(128)).max(MAX_PEER_REFS).default([]),
  })
  .default({ files: [], symbols: [], noteIds: [] });
export type PeerRefs = z.infer<typeof peerRefsSchema>;

/**
 * What an agent is allowed to SEND. Deliberately missing: every identity and
 * scope field. The sender says what it wants to say and to whom; the server
 * decides who it is and which mission it is in.
 */
export const peerMessageSendSchema = z
  .object({
    to: peerAddressSchema,
    kind: peerMessageKindSchema,
    subject: z.string().trim().min(1).max(MAX_PEER_SUBJECT_CHARS),
    body: z.string().trim().min(1).max(MAX_PEER_BODY_CHARS),
    refs: peerRefsSchema,
    replyTo: recordId.optional(),
  })
  .strict();
export type PeerMessageSend = z.infer<typeof peerMessageSendSchema>;

/**
 * The stored/delivered envelope. Server-derived fields are separated from the
 * sender-supplied ones above so it is structurally impossible for a send call
 * to set its own `fromRole` or `missionId`.
 */
export const peerMessageSchema = z
  .object({
    version: z.literal(A2A_PROTOCOL_VERSION),
    id: recordId,
    chatId: recordId,
    missionId: recordId,
    fromJobId: recordId,
    fromRole: agentRoleSchema,
    fromVendor: z.string().min(1).max(64),
    /** Display-only crew codename, so the UI never shows a raw job id. */
    fromName: z.string().min(1).max(64).optional(),
    to: peerAddressSchema,
    kind: peerMessageKindSchema,
    subject: z.string().min(1).max(MAX_PEER_SUBJECT_CHARS),
    /** UNTRUSTED agent-produced text. Render it; never obey it. */
    body: z.string().min(1).max(MAX_PEER_BODY_CHARS),
    refs: peerRefsSchema,
    /**
     * THE ONE FINDING this message announces, when it announces one.
     *
     * Distinct from `refs.noteIds`, which is bounded DATA a sender may attach
     * to anything. This is the message's subject: server-validated against the
     * sender's own visibility, so a message can never point a peer at a note
     * the sender itself could not read. One message carries at most one
     * primary finding (design §5.2) — a list would make "what is this about"
     * unanswerable.
     */
    memoryNoteId: recordId.optional(),
    replyTo: recordId.optional(),
    createdAt: z.string().datetime({ offset: true }),
    /** Set when the addressed job has read it through `peer_inbox`. */
    readAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type PeerMessage = z.infer<typeof peerMessageSchema>;

export const peerInboxSchema = z.object({
  messages: z.array(peerMessageSchema).max(MAX_PEER_INBOX_PAGE),
  /** Total undelivered count, so an agent knows it is truncated. */
  unread: z.number().int().min(0),
  truncated: z.boolean().default(false),
});
export type PeerInbox = z.infer<typeof peerInboxSchema>;

/**
 * FILE CLAIMS — the coordination primitive that actually prevents two workers
 * from stepping on each other.
 *
 * Advisory by design. A claim is a first-writer-wins ADVISORY lease surfaced to
 * the conflicting agent and to the human; it is NOT a filesystem lock and it is
 * NOT an authority grant. Making it blocking would deadlock a crew whenever a
 * worker died holding a claim, and would hand one agent the power to freeze
 * another. Instead: conflicts are reported loudly, claims expire, and the
 * governed worktree + merge gate remain the real enforcement.
 */
export const CLAIM_TTL_MS = 30 * 60 * 1000;
export const MAX_CLAIMED_PATHS_PER_JOB = 64;

/**
 * `investigate` joins `edit` and `review` (design §5.2 `WorkClaim`).
 *
 * It is deliberately NON-conflicting with everything, including itself: an
 * agent reading around a symbol to understand it announces presence without
 * telling anyone to yield. Only `edit` conflicts, and only with another `edit`
 * — see `claimsConflict`, which is unchanged.
 */
export const claimIntentSchema = z.enum(["edit", "review", "investigate"]);
export type ClaimIntent = z.infer<typeof claimIntentSchema>;

/**
 * WHAT A CLAIM IS ABOUT. The path-only shape could not express "I am editing
 * `Desk.handleMouse`", so two agents in one large file always collided and two
 * agents on one symbol reached through different files never did — stance test
 * T2 cannot reach 100% exact-claim recall on a path.
 *
 * `module` is retained as the coarse fallback the pre-edit anchors already use;
 * it is path-shaped, and overlaps a path of the same value.
 */
export const claimCoordinateKindSchema = z.enum(["path", "symbol", "module"]);
export type ClaimCoordinateKind = z.infer<typeof claimCoordinateKindSchema>;

/** Workspace-relative, canonical: no `.`/`..` segments, never absolute. */
const relativeCanonicalPath = (value: string): boolean =>
  !value.startsWith("/") &&
  !value
    .split(/[\\/]+/)
    .some((segment) => segment === "." || segment === "..");

/**
 * The file a coordinate lives in, or `null` when it names no file.
 *
 * A symbol coordinate is `relative/path.ts#Symbol` — the same spelling the
 * pre-edit anchors and the activity reader already use, so this introduces no
 * second vocabulary.
 */
export function claimCoordinateFile(
  kind: ClaimCoordinateKind,
  coordinate: string
): string | null {
  if (kind !== "symbol") return coordinate;
  const hash = coordinate.indexOf("#");
  return hash > 0 ? coordinate.slice(0, hash) : null;
}

/**
 * One claim coordinate on the wire.
 *
 * A symbol adds `#Symbol` to a canonical relative path, so the whole string is
 * validated by the same rule the path had — a claim can never name an absolute
 * path or escape the workspace with `..`, whichever kind it is.
 */
export const claimCoordinateSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine((value) => !value.startsWith("/"), "claim coordinates must be relative")
  .refine((value) => {
    const hash = value.indexOf("#");
    const filePart = hash === -1 ? value : value.slice(0, hash);
    return filePart.length > 0 && relativeCanonicalPath(filePart);
  }, "claim coordinates must be canonical")
  .refine(
    (value) => value.split("#").length <= 2,
    "a symbol coordinate names exactly one symbol"
  );

/**
 * The kind MUON derives from the coordinate the agent wrote.
 *
 * Derived rather than declared: a `kind` field the caller sets is a field the
 * caller can get wrong, and the spelling is already unambiguous — the schema
 * permits at most one `#`. `module` is not agent-settable in this slice; the
 * column carries it for producers that do not exist yet.
 */
export function claimKindFor(coordinate: string): ClaimCoordinateKind {
  return coordinate.includes("#") ? "symbol" : "path";
}

/**
 * DO TWO CLAIMS CONTEND FOR THE SAME GROUND?
 *
 * The rule that makes precision safe. Exact same coordinate always overlaps.
 * A SYMBOL overlaps a path/module naming its file, because someone editing the
 * whole file is editing that symbol — without this, adding symbol claims would
 * LOSE collisions that today's path-only claims catch, which would be a safety
 * regression sold as an improvement.
 *
 * Two DIFFERENT symbols in one file do not overlap. That is the entire point:
 * it is the precision a path cannot express.
 */
export function claimCoordinatesOverlap(
  a: { kind: ClaimCoordinateKind; coordinate: string },
  b: { kind: ClaimCoordinateKind; coordinate: string }
): boolean {
  if (a.kind === b.kind && a.coordinate === b.coordinate) return true;
  const fileA = claimCoordinateFile(a.kind, a.coordinate);
  const fileB = claimCoordinateFile(b.kind, b.coordinate);
  if (fileA === null || fileB === null) return false;
  // One of them must be the whole file for a cross-kind overlap; two distinct
  // symbols sharing a file are exactly the case this must NOT flag.
  if (a.kind === "symbol" && b.kind === "symbol") return false;
  return fileA === fileB;
}

export const fileClaimSchema = z
  .object({
    version: z.literal(A2A_PROTOCOL_VERSION),
    id: recordId,
    chatId: recordId,
    missionId: recordId,
    jobId: recordId,
    /**
     * REQUIRED (design §5.2). A claim without a workspace cannot be fenced,
     * and an unfenced claim is how two unrelated repositories with the same
     * relative paths report a false collision.
     */
    workspacePath: z.string().min(1).max(1024),
    coordinateKind: claimCoordinateKindSchema,
    /** Workspace-relative and canonical; `path#Symbol` when kind is `symbol`. */
    coordinate: claimCoordinateSchema,
    intent: claimIntentSchema,
    role: agentRoleSchema,
    vendor: z.string().min(1).max(64),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    releasedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type FileClaim = z.infer<typeof fileClaimSchema>;

export const claimConflictSchema = z.object({
  coordinateKind: claimCoordinateKindSchema,
  coordinate: z.string().min(1).max(320),
  /**
   * The coordinate the CALLER asked for, when the collision was an overlap
   * rather than an exact match — a symbol claim contended by someone editing
   * its whole file. Without it the caller is told "you lost" and cannot see
   * which of its own requests lost.
   */
  requestedCoordinate: z.string().min(1).max(320).optional(),
  /**
   * A job holding a conflicting `edit` claim on this path. A contested path
   * emits ONE row per contending holder, not one row per path — the human and
   * the orchestrator need to see every party to a collision, and a single row
   * could only ever name the first claimant, never the agent that was actually
   * blocked.
   */
  heldByJobId: recordId,
  heldByRole: agentRoleSchema,
  heldByVendor: z.string().min(1).max(64),
  heldByName: z.string().min(1).max(64).optional(),
  expiresAt: z.string().datetime({ offset: true }),
});
export type ClaimConflict = z.infer<typeof claimConflictSchema>;

export const claimResultSchema = z.object({
  granted: z.array(fileClaimSchema).max(MAX_CLAIMED_PATHS_PER_JOB),
  conflicts: z.array(claimConflictSchema).max(MAX_CLAIMED_PATHS_PER_JOB),
});
export type ClaimResult = z.infer<typeof claimResultSchema>;

/**
 * PUBLISH A FINDING — one call where there used to be two decisions.
 *
 * Today an agent records something with `memory_add` and then, separately and
 * only if it thinks to, tells a peer with `peer_message`. Nothing links the
 * two, so a reviewer's correct defect can exist in memory while the
 * implementer edits the same symbol having never seen it, and the human ends
 * up as the transport layer. This is the one call that makes a finding
 * ADDRESSABLE: the note and the message that announces it are created
 * together, and the message carries the note's id.
 *
 * The agent supplies text and claimed coordinates. Everything else — workspace,
 * chat, mission, job, role, vendor, principal — is derived from the bearer. It
 * cannot set confirmation, trust tier, or a recipient outside its own crew.
 */
export const publishFindingSchema = z
  .object({
    /** The finding itself. Becomes an UNCONFIRMED note; no agent can vouch. */
    text: z.string().trim().min(1).max(4000),
    kind: z.enum(["decision", "constraint", "convention", "attempt", "question"]),
    /**
     * Where it applies: paths, `path#Symbol`, or modules. Resolved by MUON and
     * recorded as unresolved when it cannot be — never silently dropped.
     */
    coordinates: z.array(claimCoordinateSchema).max(32).default([]),
    /** How the crew is told. Defaults to the whole crew. */
    to: peerAddressSchema.default({ kind: "crew" }),
    subject: z.string().trim().min(1).max(MAX_PEER_SUBJECT_CHARS),
    /** Defaults to the finding's own text — one thing said once. */
    body: z.string().trim().min(1).max(MAX_PEER_BODY_CHARS).optional(),
    /**
     * An `attempt`'s structured outcome (design §7.1), in the LEDGER's own
     * vocabulary rather than a second one — `MemoryNote.outcome` already
     * exists and already means this.
     *
     * I very nearly left this out, having convinced myself the column did not
     * exist; it does, and dropping a real capability on a wrong premise is the
     * more expensive mistake. `unknown` is the honest state for work still in
     * flight: it coordinates, and it is not settled knowledge.
     */
    outcome: z.enum(["worked", "abandoned", "superseded", "unknown"]).optional(),
  })
  .strict();
export type PublishFinding = z.infer<typeof publishFindingSchema>;

export const publishFindingResultSchema = z.object({
  noteId: recordId,
  messageId: recordId,
  // NO `unresolvedCoordinates` YET, though the design asks for it: the ingest
  // path resolves anchors internally and does not report which ones failed, so
  // this could only have been filled with a guess. A field that looks like
  // evidence and is not is worse than its absence.
});
export type PublishFindingResult = z.infer<typeof publishFindingResultSchema>;


/**
 * Two `edit` intents on one path conflict. An `edit` vs a `review`, or two
 * `review`s, do not — a reviewer reading a file a worker is editing is exactly
 * the workflow we want, and forcing it through a lock would break the
 * draft → critique → patch loop.
 */
export function claimsConflict(a: ClaimIntent, b: ClaimIntent): boolean {
  return a === "edit" && b === "edit";
}

/**
 * A crew-visible coordination summary: who is on the mission, what they hold,
 * and what is outstanding. Coordinates only — no message bodies — so it is safe
 * on any surface, including one that has not passed the memory text gate.
 */
export const coordinationSnapshotSchema = z.object({
  version: z.literal(A2A_PROTOCOL_VERSION),
  chatId: recordId,
  missionId: recordId,
  participants: z
    .array(
      z.object({
        jobId: recordId,
        vendor: z.string().min(1).max(64),
        role: agentRoleSchema,
        name: z.string().min(1).max(64).optional(),
        status: z.string().min(1).max(32),
        claimedPaths: z.number().int().min(0),
        unreadMessages: z.number().int().min(0),
      })
    )
    .max(32),
  openConflicts: z.array(claimConflictSchema).max(64).default([]),
  messageCount: z.number().int().min(0),
  /**
   * WHAT THE COORDINATION LAYER ACTUALLY DID, as numbers (task #92).
   *
   * A dogfood run is scored FROM THE RECORD, not from transcripts: a crew that
   * "felt coordinated" and a crew that took a claim, was refused one, and
   * re-planned are indistinguishable in prose. These are the stance tests of
   * docs/research/memory-crew-coordination-gap-2026-08-10.md, and a slice is
   * not done until its number moves.
   *
   * Optional so an older brain parses: absent means "this build does not
   * score", which is NOT the same as a run that scored zero.
   */
  score: z
    .object({
      /** Claims ever taken in this chat — the crew announced its ground. */
      claimsTaken: z.number().int().min(0),
      /** Claims live right now. */
      claimsActive: z.number().int().min(0),
      /**
       * Claims REFUSED because a peer held the ground (T2). The one number
       * that says coordination changed somebody's plan rather than merely
       * being available to.
       */
      claimsRefused: z.number().int().min(0),
      /** Peer messages of kind `finding`. */
      findingsPublished: z.number().int().min(0),
      /** Of those, the ones carrying a validated note id (slice 2). */
      findingsWithNoteLink: z.number().int().min(0),
      /** Findings that REACHED a peer at an edit boundary (T3, slice 3). */
      findingDeliveries: z.number().int().min(0),
      /**
       * True when a count hit its read bound, so the number is a FLOOR.
       * A bounded count that reads as exact is how "we did not measure it all"
       * becomes "that is all there was".
       */
      truncated: z.boolean(),
    })
    .optional(),
});
export type CoordinationSnapshot = z.infer<typeof coordinationSnapshotSchema>;
