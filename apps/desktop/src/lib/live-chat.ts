/**
 * Live (in-flight) chat entries for Mission Chat. Stream tokens arrive as
 * many `muon:assistant` events; they must merge into one bubble — history
 * already does this via {@link reduceChunks}.
 */

import type { ChatMessageDetail } from "./chat-history.js";

export type LiveChatEntry = {
  role: "user" | "assistant" | "status";
  text: string;
  /**
   * U4 — the bounded, already-redacted tool detail for THIS activity line.
   *
   * A settled turn re-reads its chunks from the brain and gets `detail` from
   * the persisted column, so its tool cards show what a call was made with and
   * what it returned. A LIVE turn was rendered from a relayed line only, so the
   * same call showed as bare `X started` / `X completed` until it settled —
   * which is exactly when the human most needs to see it. Carrying the field
   * here closes that gap without a second copy or a second redactor.
   */
  detail?: ChatMessageDetail;
};

/** Append an assistant delta onto the last assistant entry, or start a new one. */
export function appendLiveAssistant(
  entries: LiveChatEntry[],
  text: string,
  mode: "delta" | "message" = "delta"
): LiveChatEntry[] {
  if (!text) {
    return entries;
  }
  const last = entries[entries.length - 1];
  if (last?.role === "assistant") {
    const separator =
      mode === "message" && last.text.length > 0 && !last.text.endsWith("\n")
        ? "\n\n"
        : "";
    return [
      ...entries.slice(0, -1),
      { role: "assistant", text: `${last.text}${separator}${text}` },
    ];
  }
  return [...entries, { role: "assistant", text }];
}

/**
 * Append a status/activity line (always its own entry — never merged).
 *
 * `detail` is carried verbatim when the emitter supplied one. It is NOT
 * synthesised here: an absent detail stays absent, which the card reads as "no
 * detail was captured", never as "the tool returned nothing".
 */
export function appendLiveStatus(
  entries: LiveChatEntry[],
  line: string,
  detail?: ChatMessageDetail
): LiveChatEntry[] {
  if (!line) {
    return entries;
  }
  return [
    ...entries,
    { role: "status", text: line, ...(detail ? { detail } : {}) },
  ];
}
