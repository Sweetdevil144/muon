import { createHash } from "node:crypto";

/**
 * R4 phase 0, the rolling conversational window. Ported in spirit (not in code)
 * from mem0's `add()` pipeline phase 0 and its `PAST_MESSAGE_TRUNCATION_LIMIT`;
 * see docs/research/mem0-capability-reference.md §4 and §7.6. mem0ai/mem0 is
 * Apache-2.0 (read @ main, 2026-07-26); only the algorithm shape is taken.
 *
 * Why it exists: the extractor used to see ONE blob (this turn's output), so a
 * note like "keep the second approach" or "it still fails" had no referent and
 * either rotted or was dropped. Feeding it the last few turns of the SAME
 * session lets it resolve pronouns and back-references before it writes a note
 * that has to stand alone forever.
 *
 * Everything here is bounded twice over — per message and per window — because
 * this text is UNTRUSTED vendor/human transcript that ends up inside an LLM
 * prompt. Pure functions plus a small in-process store; no I/O, no deps.
 */

export type MemoryWindowRole = "human" | "agent";

export type MemoryWindowMessage = {
  role: MemoryWindowRole;
  text: string;
};

/** Messages retained per session (mem0 loads the last 10). */
export const MEMORY_WINDOW_MESSAGES = 10;
/** Per-message clip, mem0's `PAST_MESSAGE_TRUNCATION_LIMIT`. */
export const MEMORY_WINDOW_MESSAGE_CHARS = 300;
/** Hard ceiling on the RENDERED window, so a full window can never dominate
 *  the prompt no matter how the per-message bound is tuned. */
export const MEMORY_WINDOW_TOTAL_CHARS = 3_000;
/** Sessions one runner process keeps warm before evicting the least-recent. */
const MEMORY_WINDOW_SESSIONS = 64;
/** Mined-output hashes retained per session (idempotent mining dedup). */
const MEMORY_WINDOW_MINED_HASHES = 64;

/** Normalize before hashing so trivial whitespace/case differences collapse. */
function normalizeMiningText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Stable content identity for one agent output blob. Mirrors the ledger's
 * normalize+sha256 text hash so mining dedup and note dedup speak the same language.
 */
export function hashMiningOutput(text: string): string {
  return createHash("sha256").update(normalizeMiningText(text)).digest("hex");
}

/**
 * Clip one message to the per-message bound. HEAD-kept for a human turn (the
 * ask is the first thing said) and TAIL-kept for an agent turn (the conclusion
 * and the error are at the end) — the same head/tail split MUON already uses
 * for tool args vs tool results.
 */
export function truncateWindowMessage(
  message: MemoryWindowMessage,
  limit = MEMORY_WINDOW_MESSAGE_CHARS
): MemoryWindowMessage {
  const text = message.text.trim().replace(/\s+/g, " ");
  if (text.length <= limit) {
    return { role: message.role, text };
  }
  return {
    role: message.role,
    text:
      message.role === "human"
        ? `${text.slice(0, limit - 3)}...`
        : `...${text.slice(-(limit - 3))}`,
  };
}

/**
 * Append one message to a window, returning a NEW bounded window. Empty text is
 * ignored (an empty turn is not context), so callers can push unconditionally.
 */
export function appendMemoryWindow(
  window: MemoryWindowMessage[],
  message: MemoryWindowMessage,
  maxMessages = MEMORY_WINDOW_MESSAGES
): MemoryWindowMessage[] {
  const clipped = truncateWindowMessage(message);
  if (clipped.text.length === 0 || maxMessages < 1) {
    return window.slice(-Math.max(maxMessages, 0));
  }
  return [...window, clipped].slice(-maxMessages);
}

/**
 * Render the window as labelled lines for the extraction prompt. Returns "" for
 * an empty window so the brief can omit the section entirely. The result is
 * clipped to `MEMORY_WINDOW_TOTAL_CHARS`, keeping the TAIL — the turns nearest
 * the one being extracted are the ones that resolve its references.
 */
export function renderMemoryWindow(
  window: MemoryWindowMessage[],
  totalLimit = MEMORY_WINDOW_TOTAL_CHARS
): string {
  const lines = window
    .map((message) => truncateWindowMessage(message))
    .filter((message) => message.text.length > 0)
    .map((message) => `${message.role === "human" ? "Human" : "Agent"}: ${message.text}`);
  if (lines.length === 0) {
    return "";
  }
  const rendered = lines.join("\n");
  return rendered.length > totalLimit
    ? `...${rendered.slice(-(totalLimit - 3))}`
    : rendered;
}

export type MemoryWindowStore = {
  /** Prior turns for a session, oldest first. Never the caller's own array. */
  read(sessionKey: string): MemoryWindowMessage[];
  /** Record one turn; returns the resulting bounded window. */
  append(sessionKey: string, message: MemoryWindowMessage): MemoryWindowMessage[];
  /**
   * Forget ONE session's buffered turns. This window exists solely to be fed to
   * a vendor model, so the moment the operator withdraws consent for that (the
   * mining kill switch) whatever is already buffered has to go with it —
   * otherwise flipping the switch back on later resurrects text that was held
   * only for an errand the operator cancelled.
   */
  clear(sessionKey: string): void;
  /** True when this session already mined identical output (TODO 4.18). */
  hasMinedContent(sessionKey: string, contentHash: string): boolean;
  /** Record a successfully mined output hash for this session. */
  markMinedContent(sessionKey: string, contentHash: string): void;
  /** Sessions currently held (test/observability hook). */
  size(): number;
  reset(): void;
};

type MemoryWindowSession = {
  window: MemoryWindowMessage[];
  minedHashes: string[];
};

/**
 * In-process, doubly-bounded session store: at most `maxMessages` per session
 * and `maxSessions` sessions, least-recently-touched evicted first. A long-lived
 * runner serves many chats, so an unbounded map here would be a slow leak; the
 * window is a best-effort recall aid, never a source of truth, so losing it on
 * eviction or restart degrades extraction quality and nothing else.
 */
export function createMemoryWindowStore(options?: {
  maxSessions?: number;
  maxMessages?: number;
  maxMinedHashes?: number;
}): MemoryWindowStore {
  const maxSessions = Math.max(1, options?.maxSessions ?? MEMORY_WINDOW_SESSIONS);
  const maxMessages = Math.max(1, options?.maxMessages ?? MEMORY_WINDOW_MESSAGES);
  const maxMinedHashes = Math.max(
    1,
    options?.maxMinedHashes ?? MEMORY_WINDOW_MINED_HASHES
  );
  const sessions = new Map<string, MemoryWindowSession>();

  const readSession = (sessionKey: string): MemoryWindowSession => ({
    window: [...(sessions.get(sessionKey)?.window ?? [])],
    minedHashes: [...(sessions.get(sessionKey)?.minedHashes ?? [])],
  });

  const touch = (sessionKey: string, session: MemoryWindowSession) => {
    // Delete-then-set moves the key to the end of Map iteration order, which is
    // what makes the first key the least-recently-touched one.
    sessions.delete(sessionKey);
    sessions.set(sessionKey, session);
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
  };

  return {
    read(sessionKey) {
      return readSession(sessionKey).window;
    },
    append(sessionKey, message) {
      const current = readSession(sessionKey);
      const next = appendMemoryWindow(current.window, message, maxMessages);
      touch(sessionKey, { ...current, window: next });
      return [...next];
    },
    clear(sessionKey) {
      sessions.delete(sessionKey);
    },
    hasMinedContent(sessionKey, contentHash) {
      return readSession(sessionKey).minedHashes.includes(contentHash);
    },
    markMinedContent(sessionKey, contentHash) {
      const current = readSession(sessionKey);
      if (current.minedHashes.includes(contentHash)) {
        return;
      }
      const minedHashes = [...current.minedHashes, contentHash].slice(
        -maxMinedHashes
      );
      touch(sessionKey, { ...current, minedHashes });
    },
    size() {
      return sessions.size;
    },
    reset() {
      sessions.clear();
    },
  };
}
