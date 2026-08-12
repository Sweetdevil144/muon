import { useMemo } from "react";
import { vendorShortLabel } from "@muon/client/vendors";
import type { SubagentTab } from "../lib/subagent-tabs.js";
import {
  buildChatTranscript,
  type TranscriptItem,
} from "../lib/chat-transcript.js";
import type { ChatMessage } from "../lib/chat-history.js";
import type { LiveChatEntry } from "../lib/live-chat.js";
import { ChatMarkdown } from "./chat-markdown.js";
import { ToolCardList } from "./chat-activity.js";
import {
  buildToolCards,
  conciseKey,
  toolCardProblems,
} from "./lib/tool-cards.js";

function TranscriptMessage(props: {
  item: Extract<TranscriptItem, { kind: "message" }>;
}) {
  const { item } = props;
  return (
    <div className={`msg ${item.role}${item.live ? " msg-live" : ""}`}>
      <span className="msg-role">
        {item.role === "user" ? "You" : item.finalSummary ? "MUON · Summary" : "MUON"}
      </span>
      {item.role === "assistant" ? (
        <ChatMarkdown text={item.text} />
      ) : (
        <span>{item.text}</span>
      )}
    </div>
  );
}

function TranscriptWork(props: {
  item: Extract<TranscriptItem, { kind: "work" }>;
  subagents: SubagentTab[];
  rawByLine?: ReadonlyMap<string, string>;
  onOpenSubagent?: (jobId: string) => void;
}) {
  const { item } = props;
  const showCrew = props.subagents.length > 0 && props.onOpenSubagent;
  // Cards are derived, never authoritative: a shape this projection cannot read
  // still becomes a plain note card, so an old chat can never blank the turn.
  const cards = buildToolCards(item.activities, {
    ...(props.rawByLine ? { rawByLine: props.rawByLine } : {}),
  });
  const problems = toolCardProblems(cards);
  return (
    <details
      className={`transcript-work${item.live ? " msg-live" : ""}${
        item.needsAttention || problems.label ? " needs-attention" : ""
      }`}
      open={item.live || item.needsAttention || Boolean(problems.label) || undefined}
    >
      <summary>
        <span>Worked for {item.duration}</span>
        {problems.label ? (
          <span
            aria-label={`Needs attention: ${problems.label}`}
            className="transcript-alert"
          >
            {problems.label}
          </span>
        ) : null}
        <span className="transcript-phase-list" aria-label="Execution phases">
          {item.phases.map((phase) => (
            <span className="transcript-phase" key={phase}>{phase}</span>
          ))}
        </span>
      </summary>
      <div className="transcript-work-body">
        <ToolCardList cards={cards} turnLive={item.live} />
        {item.phaseNotes.length > 0 ? (
          <ul aria-label="Phase summaries" className="transcript-phase-notes">
            {item.phaseNotes.map((note, index) => <li key={`${note}-${index}`}>{note}</li>)}
          </ul>
        ) : null}
        {showCrew ? (
          <div className="transcript-crew" aria-label="Dispatched subagents">
            <span>Dispatched crew</span>
            <div className="transcript-crew-actions">
              {props.subagents.map((tab) => (
                <button
                  key={tab.jobId}
                  onClick={() => props.onOpenSubagent?.(tab.jobId)}
                  type="button"
                >
                  <span className={`activity-dot ${tab.status}`} aria-hidden="true" />
                  Open {vendorShortLabel(tab.vendor)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/**
 * The turn projection concises each status row to its first line; the renderer
 * still holds the untruncated text, so index it here and hand it to the cards
 * as their (on-demand) expand body. A miss simply means the card shows the one
 * line it already had.
 */
function indexRawStatuses(
  history: ChatMessage[],
  live: LiveChatEntry[]
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const entry of [...history, ...live]) {
    if (entry.role !== "status") continue;
    const key = conciseKey(entry.text);
    if (!key || key === entry.text.trim()) continue;
    if (!index.has(key)) index.set(key, entry.text);
  }
  return index;
}

export function ChatTranscript(props: {
  history: ChatMessage[];
  live: LiveChatEntry[];
  running: boolean;
  subagents?: SubagentTab[];
  onOpenSubagent?: (jobId: string) => void;
}) {
  const transcript = buildChatTranscript({
    history: props.history,
    live: props.live,
    running: props.running,
  });
  const rawByLine = useMemo(
    () => indexRawStatuses(props.history, props.live),
    [props.history, props.live]
  );
  let latestWorkIndex = -1;
  transcript.forEach((item, index) => {
    if (item.kind === "work") latestWorkIndex = index;
  });
  return (
    <>
      {transcript.map((item, index) =>
        item.kind === "message" ? (
          <TranscriptMessage item={item} key={`message-${item.seq ?? index}-${index}`} />
        ) : (
          <TranscriptWork
            item={item}
            key={`work-${index}`}
            rawByLine={rawByLine}
            subagents={
              index === latestWorkIndex ? (props.subagents ?? []) : []
            }
            onOpenSubagent={props.onOpenSubagent}
          />
        )
      )}
    </>
  );
}
