/**
 * Maps persisted StreamChunks (taskId = chat id) into renderable chat
 * messages. Trusted human turns use the structural `user.message` kind on the
 * `muon-chat` lane and retain the `[you] ` prefix for readable raw-ledger
 * inspection; everything else is assistant output or a status line.
 */

export const USER_PREFIX = "[you] ";

export type ChatRole = "user" | "assistant" | "status";

/**
 * Bounded, redacted args/result of the tool call a status line announced.
 * Structural mirror of `StreamChunkDetail` (@muon/client) so this module stays
 * dependency-free; UNTRUSTED text either way.
 */
export type ChatMessageDetail = {
  args?: string;
  argsTruncated?: boolean;
  result?: string;
  resultTruncated?: boolean;
};

export type ChatMessage = {
  role: ChatRole;
  text: string;
  seq: number;
  /** Durable stream time, used only for transcript elapsed-time display. */
  timestamp?: string;
  /**
   * Status rows only: what the tool actually did. Absent for every row written
   * before the ledger recorded it, so the transcript degrades to today's
   * coordinates-only card rather than showing an empty panel.
   */
  detail?: ChatMessageDetail;
};

export type ChatHistory = {
  messages: ChatMessage[];
  /** Poll cursor: pass as afterSeq on the next listStreamChunks call. */
  lastSeq: number;
};

export type HistoryChunk = {
  seq: number;
  kind: string;
  content: string;
  laneId?: string;
  timestamp?: string;
  detail?: ChatMessageDetail | null;
  /**
   * The ROOT dispatch job this row was written under. ADR-0024: a mission is a
   * CHAT, and every turn of it re-roots with a new dispatch job — so this is
   * what tells one turn's rows from the next's inside one chat's stream.
   * Absent on rows written before the column existed, and on the orchestrator's
   * own out-of-band milestones.
   */
  runId?: string | null;
};

/**
 * The rows of a chat's stream that belong to turns which have ALREADY SETTLED —
 * i.e. everything before the live turn starts.
 *
 * WHY THIS EXISTS. The transcript renders persisted history plus an optimistic
 * live mirror of the turn in flight. History polling used to stop entirely
 * while a turn ran, to keep the live turn from being printed twice. That is
 * correct about the live turn and wrong about every turn before it: a
 * transcript that mounts during a turn (a workspace-tab switch back to Mission
 * chat, a window reload, a relaunch) then has NO history to show and no way to
 * get any until the turn ends — and the live mirror only ever holds the current
 * turn. The whole earlier conversation disappears, which is exactly the
 * "only the latest turn is visible" the founder hit. ADR-0024 is explicit that
 * the mission is the chat, not one turn.
 *
 * So: keep polling, and cut the page at the live turn's first row instead. The
 * boundary is that turn's ROOT job id, which the brain stamps on the trusted
 * `[you]` row in the same transaction that admits the root — so everything at
 * or after it belongs to the turn the live mirror is already rendering,
 * including the orchestrator's own milestone rows, which carry no runId of
 * their own and would otherwise slip through a per-row filter.
 *
 * FAIL-CLOSED: with no known live root the answer is NOTHING, never "all of
 * it". Not knowing where the live turn starts is not a licence to print it
 * twice.
 *
 * WHICH ROOT (this is load-bearing — read `pinLiveTurnRoots` in
 * ./mission-turn-state.ts before changing a caller). It must be the root the
 * LIVE MIRROR belongs to, i.e. the root of the turn the human started — NOT
 * merely whichever root is active right now. A crew-contract CORRECTION root is
 * a SECOND root inside ONE logical turn, and it stamps no row anywhere (no
 * human message, no continuation, and its own admission milestone carries no
 * runId), so passing it here would find no boundary at all.
 *
 * `boundary < 0` therefore means exactly one thing under that contract, and
 * absorbing the whole page is right for it: the live turn has not written a row
 * into THIS page yet (the ordinary mount-mid-turn case — the page holds only
 * settled turns and the mirror holds the new one). Do NOT "fix" this arm by
 * returning `[]`; it was tried, and it breaks the primary case this function
 * exists for ("keeps earlier turns visible while a NEW turn is running"). The
 * other reading of `boundary < 0` — the mirror is still rendering a turn whose
 * rows ARE in this page — is prevented upstream by pinning the boundary, not
 * compensated for here.
 */
export function settledHistoryChunks<Chunk extends { runId?: string | null }>(
  chunks: readonly Chunk[],
  liveTurnRootJobId: string | null | undefined
): Chunk[] {
  if (!liveTurnRootJobId) {
    return [];
  }
  const boundary = chunks.findIndex(
    (chunk) => chunk.runId === liveTurnRootJobId
  );
  return boundary < 0 ? [...chunks] : chunks.slice(0, boundary);
}

function messageTimestamp(chunk: HistoryChunk): { timestamp?: string } {
  return chunk.timestamp ? { timestamp: chunk.timestamp } : {};
}

/**
 * Carry the chunk's tool detail only when it has a string field worth showing.
 * A malformed or empty `detail` degrades to no detail, never to an empty panel
 * that would read as "the tool returned nothing".
 */
function messageDetail(chunk: HistoryChunk): { detail?: ChatMessageDetail } {
  const detail = chunk.detail;
  if (!detail || typeof detail !== "object") return {};
  const args = typeof detail.args === "string" ? detail.args : undefined;
  const result = typeof detail.result === "string" ? detail.result : undefined;
  if (!args && !result) return {};
  return {
    detail: {
      ...(args ? { args, argsTruncated: detail.argsTruncated === true } : {}),
      ...(result
        ? { result, resultTruncated: detail.resultTruncated === true }
        : {}),
    },
  };
}

/**
 * Compatibility for rows written before control-plane progress was persisted
 * as a milestone. This exact provider lifecycle message is not model prose;
 * classifying it as Activity also prevents it joining the first model delta as
 * `completednext:`.
 */
function isLegacyControlPlaneOutput(content: string): boolean {
  return content.trim() === "Codex capability preflight completed";
}

export function emptyHistory(): ChatHistory {
  return { messages: [], lastSeq: 0 };
}

export function chunkToMessage(chunk: HistoryChunk): ChatMessage | null {
  if (!chunk.content.trim()) {
    return null;
  }
  if (
    chunk.kind === "user.message" &&
    chunk.laneId === "muon-chat" &&
    chunk.content.startsWith(USER_PREFIX)
  ) {
    return {
      role: "user",
      text: chunk.content.slice(USER_PREFIX.length),
      seq: chunk.seq,
      ...messageTimestamp(chunk),
    };
  }
  if (
    chunk.kind === "activity" ||
    chunk.kind === "milestone" ||
    chunk.kind === "gate" ||
    (chunk.kind === "output" && isLegacyControlPlaneOutput(chunk.content))
  ) {
    return {
      role: "status",
      text: chunk.content,
      seq: chunk.seq,
      ...messageTimestamp(chunk),
      ...messageDetail(chunk),
    };
  }
  return {
    role: "assistant",
    text: chunk.content,
    seq: chunk.seq,
    ...messageTimestamp(chunk),
  };
}

/**
 * Appends new chunks to a history. Chunks at or below the cursor are
 * dropped, so re-feeding an overlapping page is safe (idempotent).
 * Consecutive assistant chunks merge into one bubble.
 */
export function reduceChunks(
  history: ChatHistory,
  chunks: HistoryChunk[]
): ChatHistory {
  const fresh = chunks
    .filter((chunk) => chunk.seq > history.lastSeq)
    .sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) {
    return history;
  }

  const messages = [...history.messages];
  let lastSeq = history.lastSeq;

  for (const chunk of fresh) {
    lastSeq = Math.max(lastSeq, chunk.seq);
    const message = chunkToMessage(chunk);
    if (!message) {
      continue;
    }
    const previous = messages[messages.length - 1];
    // Stream tokens/deltas land as many consecutive output chunks and join
    // byte-for-byte. A whole provider message has an explicit typed boundary,
    // so consecutive Claude messages remain readable rather than producing
    // strings such as "completednext:".
    if (message.role === "assistant" && previous?.role === "assistant") {
      const separator =
        chunk.kind === "output.message" &&
        previous.text.length > 0 &&
        !previous.text.endsWith("\n")
          ? "\n\n"
          : "";
      messages[messages.length - 1] = {
        role: "assistant",
        text: `${previous.text}${separator}${message.text}`,
        seq: message.seq,
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      };
    } else {
      messages.push(message);
    }
  }

  return { messages, lastSeq };
}
