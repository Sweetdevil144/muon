import type { ChatMessage, ChatMessageDetail } from "./chat-history.js";
import type { LiveChatEntry } from "./live-chat.js";

export type TranscriptPhase =
  | "Explored"
  | "Edited"
  | "Dispatched"
  | "Verified"
  | "Reviewed"
  | "Worked";

export type TranscriptActivity = {
  text: string;
  count: number;
  needsAttention: boolean;
  live: boolean;
  /**
   * Bounded, redacted args/result of the tool call this line announced, when
   * the ledger recorded them. UNTRUSTED — the card renders it behind an expand.
   */
  detail?: ChatMessageDetail;
};

export type TranscriptItem =
  | {
      kind: "message";
      role: "user" | "assistant";
      text: string;
      seq?: number;
      live: boolean;
      finalSummary: boolean;
    }
  | {
      kind: "work";
      phases: TranscriptPhase[];
      activities: TranscriptActivity[];
      phaseNotes: string[];
      duration: string;
      live: boolean;
      needsAttention: boolean;
    };

type TranscriptEntry = {
  role: "user" | "assistant" | "status";
  text: string;
  seq?: number;
  timestamp?: string;
  live: boolean;
  detail?: ChatMessageDetail;
};

const ATTENTION_PATTERN =
  /^(?:✗|×)|\b(?:blocked|failed|denied|missing environment variable|not ready)\b/i;

function entrySignature(entry: Pick<TranscriptEntry, "role" | "text">): string {
  return `${entry.role}\0${entry.text.trim()}`;
}

/** Identity of a tool call's captured detail; "" when nothing was captured. */
function detailSignature(detail: ChatMessageDetail | undefined): string {
  if (!detail) return "";
  return `${detail.args ?? ""}\0${detail.result ?? ""}`;
}

/**
 * During live → persisted settlement React may briefly hold both projections.
 * Suppress only entries proven to belong to the same optimistic human turn,
 * consuming persisted signatures as a multiset so repeated real tool events
 * are not accidentally erased.
 */
function withoutSettledLiveDuplicates(
  persisted: TranscriptEntry[],
  live: TranscriptEntry[],
  running: boolean
): TranscriptEntry[] {
  if (running || live.length === 0 || live[0]?.role !== "user") return live;
  let persistedTurnStart = -1;
  for (let index = persisted.length - 1; index >= 0; index -= 1) {
    const entry = persisted[index];
    if (
      entry?.role === "user" &&
      entry.text.trim() === live[0]?.text.trim()
    ) {
      persistedTurnStart = index;
      break;
    }
  }
  if (persistedTurnStart < 0) return live;

  const available = new Map<string, number>();
  for (const entry of persisted.slice(persistedTurnStart)) {
    const signature = entrySignature(entry);
    available.set(signature, (available.get(signature) ?? 0) + 1);
  }
  return live.filter((entry) => {
    const signature = entrySignature(entry);
    const count = available.get(signature) ?? 0;
    if (count === 0) return true;
    available.set(signature, count - 1);
    return false;
  });
}

function isInternalStatusEcho(entry: TranscriptEntry): boolean {
  if (entry.role !== "status") return false;
  const text = entry.text.trim();
  // Human turns are authoritative only when structurally projected as `user`.
  // Old/internal milestone echoes must not create a second pseudo-human row.
  if (text.startsWith("[you] ")) return true;
  // Admission prose is an internal coordinator contract, not useful progress.
  if (/^\[contract\.single\]\s/i.test(text)) return true;
  // Generic provider start/finish rows are duplicated by the running state and
  // final summary. Failures/blocks intentionally do not match this pattern.
  return /^\[task\.(?:started|completed)\]\s+(?:Claude|Codex) (?:session|turn) (?:started|completed)$/i.test(
    text
  );
}

function concise(text: string, max = 180): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, max - 1)}…`;
}

export function transcriptPhase(text: string): TranscriptPhase {
  if (/\b(?:dispatch|delegate|crew|subagent|worker)\b/i.test(text)) {
    return "Dispatched";
  }
  if (/\b(?:edit|write|patch|apply_patch|created? file|updated?)\b/i.test(text)) {
    return "Edited";
  }
  if (/\b(?:tests?|checks?|build|lint|typecheck|verify|verified)\b/i.test(text)) {
    return "Verified";
  }
  if (/\b(?:approval|gate|review|attest)\b/i.test(text)) {
    return "Reviewed";
  }
  if (/\b(?:read|search|find|query|context|impact|explor|list|inspect)\b/i.test(text)) {
    return "Explored";
  }
  return "Worked";
}

function elapsedLabel(entries: TranscriptEntry[]): string {
  const times = entries
    .map((entry) => entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN)
    .filter(Number.isFinite);
  if (times.length < 2) return "this turn";
  const elapsedSeconds = Math.max(
    0,
    Math.round((Math.max(...times) - Math.min(...times)) / 1000)
  );
  if (elapsedSeconds < 1) return "under a second";
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function projectTurn(entries: TranscriptEntry[]): TranscriptItem[] {
  if (entries.length === 0) return [];
  const statuses = entries.filter(
    (entry) => entry.role === "status" && !isInternalStatusEcho(entry)
  );
  const assistants = entries.filter(
    (entry) => entry.role === "assistant" && entry.text.trim().length > 0
  );

  const finalAssistant = assistants.at(-1);
  const progressAssistants = finalAssistant
    ? assistants.slice(0, -1)
    : assistants;
  const workEntries = [...statuses, ...progressAssistants].sort(
    (left, right) => (left.seq ?? Number.MAX_SAFE_INTEGER) - (right.seq ?? Number.MAX_SAFE_INTEGER)
  );
  const result: TranscriptItem[] = [];
  if (workEntries.length > 0) {
    const activities: TranscriptActivity[] = [];
    for (const status of statuses) {
      const text = concise(status.text);
      if (!text) continue;
      const previous = activities.at(-1);
      if (
        previous &&
        previous.text === text &&
        previous.needsAttention === ATTENTION_PATTERN.test(status.text) &&
        // Two lines that read alike but DID different things are two events.
        // Collapsing them would attach one call's output to another's row.
        detailSignature(previous.detail) === detailSignature(status.detail)
      ) {
        previous.count += 1;
        previous.live ||= status.live;
        continue;
      }
      activities.push({
        text,
        count: 1,
        needsAttention: ATTENTION_PATTERN.test(status.text),
        live: status.live,
        ...(status.detail ? { detail: status.detail } : {}),
      });
    }
    const phaseNotes = progressAssistants
      .map((entry) => concise(entry.text, 220))
      .filter(Boolean);
    const phaseEntries = statuses.length > 0 ? statuses : progressAssistants;
    const phases = [...new Set(phaseEntries.map((entry) => transcriptPhase(entry.text)))];
    result.push({
      kind: "work",
      phases,
      activities,
      phaseNotes,
      duration: elapsedLabel(workEntries),
      live: workEntries.some((entry) => entry.live),
      needsAttention: activities.some((activity) => activity.needsAttention),
    });
  }
  if (finalAssistant) {
    result.push({
      kind: "message",
      role: "assistant",
      text: finalAssistant.text,
      seq: finalAssistant.seq,
      live: finalAssistant.live,
      finalSummary: !finalAssistant.live,
    });
  }
  return result;
}

export function buildChatTranscript(input: {
  history: ChatMessage[];
  live: LiveChatEntry[];
  running: boolean;
}): TranscriptItem[] {
  const persisted: TranscriptEntry[] = input.history.map((message) => ({
    ...message,
    live: false,
  }));
  const live: TranscriptEntry[] = input.live.map((entry) => ({
    ...entry,
    live: true,
  }));
  const entries = [
    ...persisted,
    ...withoutSettledLiveDuplicates(persisted, live, input.running),
  ];

  const result: TranscriptItem[] = [];
  let turn: TranscriptEntry[] = [];
  const flushTurn = () => {
    result.push(...projectTurn(turn));
    turn = [];
  };

  for (const entry of entries) {
    if (entry.role === "user") {
      flushTurn();
      result.push({
        kind: "message",
        role: "user",
        text: entry.text,
        seq: entry.seq,
        live: entry.live,
        finalSummary: false,
      });
      continue;
    }
    turn.push(entry);
  }
  flushTurn();
  return result;
}
