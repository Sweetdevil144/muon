/**
 * Agent activity rendering.
 *
 * A tool call is ONE entity, so it renders as ONE card: a titled header stating
 * what the call was for, the exact wire tool name beside it, a live/done/failed
 * state, and — only when the human asks — the raw lines MUON actually holds.
 *
 * Untrusted-by-default: every string here (titles derive from tool names, and
 * detail lines are raw agent/tool output) is rendered as a React text node.
 * There is no `dangerouslySetInnerHTML` on this path, and the raw body renders
 * ON DEMAND — it is not in the DOM until the human expands the card — matching
 * the "untrusted text, shown only after the human asked for it" pattern used by
 * the brain inspector.
 *
 * The expanded body now also carries what the call was invoked WITH and what it
 * RETURNED, each in its own bounded, independently scrollable box. That content
 * is MORE untrusted than the coordinates around it, not less: it keeps the
 * `Tool activity · untrusted` framing, it is mounted only on expand, and it
 * scrolls inside its own container so a 8 KB result can never push the page's
 * x-axis or grow the transcript.
 */

import { useState } from "react";
import type { ToolCard, ToolCardIcon, ToolCardStatus } from "./lib/tool-cards.js";
import {
  ToolInvocation,
  ToolInvocationRawData,
  type ToolInvocationPhase,
} from "./ui/tool-invocation.js";

/**
 * Collapsible Activity row — kept for single status lines rendered outside the
 * turn ledger. Short one-liners stay compact (no empty expand target).
 */
export function ChatActivity(props: {
  text: string;
  needsAttention?: boolean;
  live?: boolean;
}) {
  const summary = activitySummary(props.text);
  const expandable = props.text.includes("\n") || props.text.length > 96;
  const className = `msg msg-activity${props.live ? " msg-live" : ""} status${
    props.needsAttention ? " needs-attention" : ""
  }`;

  if (!expandable) {
    return (
      <div className={className}>
        <span className="msg-role">Activity</span>
        <span className="msg-activity-label">{summary}</span>
      </div>
    );
  }

  return (
    <details
      className={className}
      open={props.needsAttention || undefined}
    >
      <summary className="msg-activity-summary">
        <span className="msg-role">Activity</span>
        <span className="msg-activity-label">{summary}</span>
      </summary>
      <pre className="msg-activity-body">{props.text}</pre>
    </details>
  );
}

export function activitySummary(text: string): string {
  const first = text.split("\n")[0]?.trim() || "Activity";
  if (first.length <= 96) {
    return first;
  }
  return `${first.slice(0, 93)}…`;
}

/** Monospace glyphs, not new colours — the icon reads at 11px on dark. */
const ICON_GLYPH: Record<ToolCardIcon, string> = {
  terminal: ">_",
  graph: "◇",
  brain: "◈",
  file: "≡",
  edit: "±",
  crew: "⁂",
  gate: "!",
  step: "·",
};

const STATE_LABEL: Record<ToolCardStatus, string> = {
  pending: "running",
  ok: "done",
  failed: "failed",
  denied: "denied by MUON governance",
  note: "",
};

function stateLabel(card: ToolCard, running: boolean): string {
  if (card.status === "note" && card.governance) return card.governance;
  // A settled turn whose call never reported back is not "running" — saying so
  // would be a lie, and claiming "done" would be a bigger one.
  if (card.status === "pending" && !running) return "no result recorded";
  return STATE_LABEL[card.status];
}

function phaseFor(
  card: ToolCard,
  running: boolean
): ToolInvocationPhase {
  if (card.status === "failed" || card.status === "denied") {
    return "output-error";
  }
  if (card.status === "pending") {
    return running ? "input-streaming" : "input-available";
  }
  return "output-available";
}

export function ToolCallCard(props: { card: ToolCard; turnLive?: boolean }) {
  const { card } = props;
  const running =
    card.status === "pending" && (card.live || props.turnLive === true);
  const problem = card.status === "failed" || card.status === "denied";
  // A failure or a governance denial opens itself: the reason is the point, and
  // a consumer must never have to hunt for why a turn went wrong.
  const [open, setOpen] = useState(problem);
  const hasBody =
    card.detail.length > 0 ||
    Boolean(card.reason) ||
    card.args !== undefined ||
    card.output !== undefined;
  const expanded = open && hasBody;
  const phase = phaseFor(card, running);

  const head = (
    <>
      <span aria-hidden="true" className="tool-card-icon">
        {ICON_GLYPH[card.icon]}
      </span>
      <span className="tool-card-title">{card.title}</span>
      {card.tool && card.tool !== card.title ? (
        <span className="tool-card-tool" title={card.tool}>
          {card.tool}
        </span>
      ) : null}
      {card.summary ? (
        <span className="tool-card-args">{card.summary}</span>
      ) : null}
      {card.repeat > 1 ? (
        <span
          aria-label={`repeated ${card.repeat} times`}
          className="tool-card-repeat"
        >
          ×{card.repeat}
        </span>
      ) : null}
      <span className="tool-card-state">
        {running ? (
          <span aria-hidden="true" className="tool-card-spinner" />
        ) : null}
        {stateLabel(card, running)}
      </span>
    </>
  );

  return (
    <ToolInvocation
      className={`tool-card tool-card-${card.status}${
        card.live ? " tool-card-live" : ""
      }${card.status === "pending" && !running ? " tool-card-stalled" : ""}${
        phase === "output-error" ? " tool-invocation-error" : ""
      }`}
      data-tool-phase={phase}
      {...(problem ? { role: "alert" as const } : {})}
    >
      {hasBody ? (
        <button
          aria-expanded={expanded}
          className="tool-card-head tool-invocation-header"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <span aria-hidden="true" className="tool-card-caret">
            {expanded ? "▾" : "▸"}
          </span>
          {head}
        </button>
      ) : (
        <div className="tool-card-head tool-card-head-static tool-invocation-header">
          <span aria-hidden="true" className="tool-card-caret tool-card-caret-empty">
            ·
          </span>
          {head}
        </div>
      )}
      {expanded ? (
        <div className="tool-card-body tool-invocation-content-body">
          {card.reason ? <p className="tool-card-reason">{card.reason}</p> : null}
          {card.args !== undefined ||
          card.output !== undefined ||
          card.detail.length > 0 ? (
            <span className="tool-card-body-label">
              Tool activity · untrusted
            </span>
          ) : null}
          {card.args !== undefined ? (
            <>
              <ToolInvocationRawData data={card.args} title="Called with" />
              {card.argsTruncated ? (
                <span className="tool-card-body-label">
                  Arguments truncated by MUON.
                </span>
              ) : null}
            </>
          ) : null}
          {card.output !== undefined ? (
            <>
              <ToolInvocationRawData data={card.output} title="Returned" />
              {card.outputTruncated ? (
                <span className="tool-card-body-label">
                  Earlier output dropped; MUON kept the end.
                </span>
              ) : null}
            </>
          ) : null}
          {card.detail.length > 0 ? (
            <>
              <ToolInvocationRawData
                data={card.detail.join("\n")}
                title={
                  card.args !== undefined || card.output !== undefined
                    ? "Ledger lines"
                    : "Tool Details"
                }
              />
              {card.detailTruncated ? (
                <span className="tool-card-body-label">
                  Output truncated for display.
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </ToolInvocation>
  );
}

export function ToolCardList(props: { cards: ToolCard[]; turnLive?: boolean }) {
  if (props.cards.length === 0) return null;
  return (
    <ol aria-label="Tool and execution activity" className="tool-card-list">
      {props.cards.map((card) => (
        <li key={card.key}>
          <ToolCallCard
            card={card}
            {...(props.turnLive ? { turnLive: true } : {})}
          />
        </li>
      ))}
    </ol>
  );
}
