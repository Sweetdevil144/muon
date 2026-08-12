import { useEffect, useRef, useState } from "react";
import type { AgentRecord } from "@muon/client";
import { isNearBottom } from "./lib/stick-scroll.js";
import { agentCodename } from "../lib/agent-codename.js";
import { principalColor } from "../lib/principal-color.js";
import { VendorIcon } from "./vendor-icon.js";

const PANE_POLL_MS = 2000;
const PANE_PAGE = 300;
const PANE_BUFFER = 400;

type PaneChunk = {
  seq: number;
  kind: string;
  content: string;
};

export function AgentPanes(props: {
  agents: AgentRecord[];
  defaultOpen?: boolean;
  taskTitles: Map<string, string>;
  onOpen: (agentId: string, jobId: string | null) => void;
  onClose: (jobId: string | null) => void;
}) {
  // Collapsed to a one-line band by default; opens when a pane was explicitly
  // opened, and the operator's manual toggle wins afterwards.
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  // TODO 7.11 — the five-wide desk. Focus moves between lanes WITHOUT
  // unmounting anything: every pane stays mounted and polling, switching is a
  // class flip + scrollIntoView, so a lane change costs a paint, not a
  // remount (the sub-40ms bar). -1 = no lane focused (review finding 9: a
  // ring nobody asked for reads as state that does not exist).
  const [focusedIndex, setFocusedIndex] = useState(-1);
  // Re-clamp when the crew shrinks so the ring never points past the desk.
  useEffect(() => {
    if (focusedIndex >= props.agents.length) {
      setFocusedIndex(props.agents.length - 1);
    }
  }, [focusedIndex, props.agents.length]);
  const paneRefs = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Cmd/Ctrl+1..5: jump to that lane; opens the desk if collapsed.
      if (!(event.metaKey || event.ctrlKey)) return;
      const digit = Number(event.key);
      if (!Number.isInteger(digit) || digit < 1 || digit > 5) return;
      const index = digit - 1;
      if (index >= props.agents.length) return;
      event.preventDefault();
      setOpen(true);
      setFocusedIndex(index);
      paneRefs.current[index]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      paneRefs.current[index]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.agents.length]);
  useEffect(() => {
    if (props.defaultOpen) {
      setOpen(true);
    }
  }, [props.defaultOpen]);
  // Display-only codenames (agent-codename.ts) — the crew-stream summary reads
  // "Nova · Cipher", not "claude-code-1 · claude-code-2".
  const streamNames = props.agents
    .map((agent) => agentCodename(agent.id))
    .join(" · ");
  // Count only agents actually working: panes stay open (explicitly opened)
  // even after their agent finishes or fails, and those must not inflate
  // the "N working" claim. With zero working, fall back to a neutral count.
  const workingCount = props.agents.filter(
    (agent) => agent.status === "working"
  ).length;
  const summaryLabel =
    workingCount > 0
      ? `Crew streams · ${workingCount} working`
      : `Crew streams · ${props.agents.length} stream${
          props.agents.length === 1 ? "" : "s"
        }`;
  return (
    <section className={`panes${open ? " open" : ""}`}>
      <button
        aria-controls="crew-stream-grid"
        aria-expanded={open}
        className="panes-title"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{summaryLabel}</span>
        <span className="panes-title-meta">
          <small>{streamNames}</small>
          <span aria-hidden="true" className="panes-chevron">
            {open ? "▾" : "▴"}
          </span>
        </span>
      </button>
      {open ? (
        <div
          className="panes-grid desk"
          id="crew-stream-grid"
          aria-label="Live crew streams"
          // Explicit column count (capped at five) instead of auto-fit:
          // auto-fit reflows every pane when one appears or dies — the
          // zero-layout-shift half of the 7.11 bar.
          style={{
            gridTemplateColumns: `repeat(${Math.max(1, Math.min(5, props.agents.length))}, minmax(0, 1fr))`,
          }}
        >
          {props.agents.map((agent, index) => (
            <AgentPane
              key={agent.currentJobId ?? agent.id}
              agent={agent}
              index={index}
              focused={index === focusedIndex}
              paneRef={(el) => {
                paneRefs.current[index] = el;
              }}
              onFocusPane={() => setFocusedIndex(index)}
              taskTitle={
                agent.currentTaskId
                  ? (props.taskTitles.get(agent.currentTaskId) ??
                    agent.currentTaskId)
                  : null
              }
              onOpen={() =>
                props.onOpen(agent.id, agent.currentJobId ?? null)
              }
              onClose={() => props.onClose(agent.currentJobId ?? null)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AgentPane(props: {
  agent: AgentRecord;
  index: number;
  taskTitle: string | null;
  focused?: boolean;
  paneRef?: (el: HTMLElement | null) => void;
  onFocusPane?: () => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [chunks, setChunks] = useState<PaneChunk[]>([]);
  const lastSeqRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  // AgentPanes keys this component by dispatch id (falling back to agent id
  // only for an unbound fleet row), so a reused agent slot still gets a fresh
  // mount: chunks and the seq cursor cannot bleed across two jobs.
  useEffect(() => {
    const runId = props.agent.currentJobId;
    if (!runId) {
      setChunks([]);
      lastSeqRef.current = 0;
      return;
    }
    let stopped = false;
    const tick = async () => {
      try {
        const fetched = await window.muon.streams({
          runId,
          afterSeq: lastSeqRef.current,
          limit: PANE_PAGE,
        });
        if (stopped || fetched.length === 0) {
          return;
        }
        lastSeqRef.current = Math.max(
          lastSeqRef.current,
          ...fetched.map((chunk) => chunk.seq)
        );
        setChunks((current) =>
          [
            ...current,
            ...fetched.map((chunk) => ({
              seq: chunk.seq,
              kind: chunk.kind,
              content: chunk.content,
            })),
          ].slice(-PANE_BUFFER)
        );
      } catch {
        // brain offline; the next tick retries
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), PANE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [props.agent.currentJobId]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chunks]);

  return (
    <section
      className={`pane${props.focused ? " pane-focused" : ""}`}
      ref={(el) => props.paneRef?.(el)}
      tabIndex={-1}
      onMouseDown={() => props.onFocusPane?.()}
      onFocus={() => props.onFocusPane?.()}
    >
      <header className="pane-header">
        <span className="pane-index">
          {String(props.index + 1).padStart(2, "0")}
        </span>
        <span
          className={`dot ${props.agent.status}`}
          style={{ backgroundColor: principalColor(props.agent.id) }}
        />
        <VendorIcon vendor={props.agent.vendor} />
        <span className="pane-title" title={`${props.agent.name} · ${props.agent.vendor}`}>
          {agentCodename(props.agent.id)}
        </span>
        <span className="pane-task">{props.taskTitle ?? props.agent.status}</span>
        <button className="pane-open" onClick={props.onOpen} title="Open full session">
          Open
        </button>
        <button className="pane-close" onClick={props.onClose} title="Close pane">
          ×
        </button>
      </header>
      <div
        className="pane-body"
        onScroll={() => {
          const el = bodyRef.current;
          if (el) {
            stickToBottomRef.current = isNearBottom(el);
          }
        }}
        ref={bodyRef}
      >
        {chunks.length === 0 ? (
          <span className="pane-empty">
            Connected. Waiting for the next agent event…
          </span>
        ) : (
          chunks.map((chunk, index) => (
            <div
              key={`${chunk.seq}-${index}`}
              className={chunk.kind === "milestone" ? "chunk-milestone" : undefined}
            >
              {chunk.content}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
