"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

type Line =
  | { kind: "prompt"; text: string }
  | { kind: "out"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "gate"; text: string }
  | { kind: "human"; text: string }
  | { kind: "ok"; text: string };

const SESSION: Line[] = [
  { kind: "prompt", text: "claude" },
  { kind: "out", text: "Claude Code · muon MCP server connected" },
  { kind: "prompt", text: "> rename Invoice.total to Invoice.amountDue across the billing module" },
  { kind: "tool", text: "muon · memory_preedit(symbol: \"Invoice#total\")" },
  { kind: "out", text: "  blast radius   14 call sites · 3 modules · 2 tests" },
  { kind: "out", text: "  decision       currency stays minor units (human-confirmed)" },
  { kind: "out", text: "  proposal       \"rename to amount\" — unconfirmed, text withheld" },
  { kind: "tool", text: "muon · dispatch(crew: claude-code, codex, cursor)" },
  { kind: "out", text: "  claude-code    rewriting billing/invoice.ts + call sites" },
  { kind: "out", text: "  codex          updating the API serializer and fixtures" },
  { kind: "out", text: "  cursor         review only — no writes to your workspace" },
  { kind: "tool", text: "muon · claim_files(billing/invoice.ts) → held by claude-code" },
  { kind: "out", text: "  codex waits on the claim instead of editing the same file" },
  { kind: "gate", text: "gate filed · merge into main — waiting for you" },
  { kind: "out", text: "  certified      12 files reviewed against the code graph" },
  { kind: "out", text: "  review blind   billing/legacy-export.ts (not indexed)" },
  { kind: "human", text: "you  approve --attested billing/legacy-export.ts" },
  { kind: "ok", text: "merged · decision recorded: Invoice.amountDue (human-confirmed)" },
];

const STYLE: Record<Line["kind"], string> = {
  prompt: "text-foreground",
  out: "text-muted-foreground",
  tool: "text-trust-crew",
  gate: "text-trust-stale",
  human: "text-muon-blue",
  ok: "text-trust-crew",
};

function prefix(kind: Line["kind"]) {
  switch (kind) {
    case "prompt":
      return "$ ";
    case "tool":
      return "→ ";
    case "gate":
      return "■ ";
    case "human":
      return "▸ ";
    case "ok":
      return "✓ ";
    default:
      return "  ";
  }
}

export function TerminalReplay() {
  const [count, setCount] = useState(0);
  const [runId, setRunId] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);

  const restart = useCallback(() => {
    setCount(0);
    setRunId((r) => r + 1);
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCount(SESSION.length);
      return;
    }
    let i = 0;
    let timer = 0;
    const tick = () => {
      i += 1;
      setCount(i);
      if (i >= SESSION.length) return;
      const line = SESSION[i];
      const delay = line && (line.kind === "gate" || line.kind === "human") ? 900 : 430;
      timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, 500);
    return () => window.clearTimeout(timer);
  }, [runId]);


  const visible = SESSION.slice(0, count);
  const done = count >= SESSION.length;

  return (
    <div ref={hostRef} className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-trust-unconfirmed/70" />
          <span className="size-2.5 rounded-full bg-trust-stale/70" />
          <span className="size-2.5 rounded-full bg-trust-crew/70" />
          <span className="panel-label ml-2">claude code · muon mcp</span>
        </div>
        <button
          type="button"
          onClick={restart}
          className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
        >
          <RotateCcw className="size-3.5" />
          Replay
        </button>
      </div>

      <div className="min-h-[420px] overflow-x-auto p-5 font-mono text-[0.8125rem] leading-[1.75]">
        {visible.map((line, i) => (
          <div key={i} className={`whitespace-pre ${STYLE[line.kind]}`}>
            {prefix(line.kind)}
            {line.text}
          </div>
        ))}
        {!done && count > 0 ? (
          <span className="inline-block h-4 w-2 translate-y-0.5 bg-muon-blue animate-caret" />
        ) : null}
      </div>
    </div>
  );
}
