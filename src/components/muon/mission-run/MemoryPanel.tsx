"use client";

import { MEMORY_NODES, TRUST_CHIP } from "@/lib/demo-run/script";
import { useDemoRun } from "@/lib/demo-run/store";

import { trustOf } from "./MemoryGraph";

const BTN =
  "border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--muon-blue)]";

export function MemoryPanel() {
  const { state, dispatch } = useDemoRun();
  const node = MEMORY_NODES.find((n) => n.id === state.selected);

  if (!node) {
    return (
      <div className="panel p-4">
        <div className="panel-label mb-2">Memory note</div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Select a node in the graph to read the claim, who proposed it, and what a human decided.
        </p>
        <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
          Recall ranks notes flat. These edges are provenance, not a search path.
        </p>
      </div>
    );
  }

  const trust = trustOf(node, state.memory);
  const chip = TRUST_CHIP[trust]!;
  const decided = state.memory[node.id];

  return (
    <div className="panel p-4">
      <div className="panel-label mb-2">Memory note</div>
      <p className="text-sm leading-relaxed text-foreground/90">{node.claim}</p>

      <dl className="mt-4 space-y-2 text-xs">
        <Row label="Kind" value={node.kind} />
        <Row label="Proposed by" value={node.proposedBy} />
        <Row label="Coordinate" value={node.coordinate} mono />
      </dl>

      <div className="mt-4 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em]">
        <span className="size-1.5 rounded-full" style={{ backgroundColor: chip.tone }} />
        <span style={{ color: chip.tone }}>
          {trust === "unconfirmed"
            ? `Unconfirmed — proposed by ${node.proposedBy.split(" · ")[0]}`
            : chip.text}
        </span>
      </div>
      {node.expires && trust === "unconfirmed" ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Expires unless confirmed
        </p>
      ) : null}

      <ul className="mt-4 space-y-1 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
        {node.provenance
          .filter((p) => !(decided && p === "No human decision yet"))
          .map((p) => (
            <li key={p}>{p}</li>
          ))}
      </ul>

      {trust === "unconfirmed" || trust === "corroborated" ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={BTN}
            style={{ borderColor: "var(--muon-blue)", color: "var(--trust-human)" }}
            onClick={() => dispatch({ type: "memory", id: node.id, decision: "confirmed" })}
          >
            Confirm
          </button>
          <button
            type="button"
            className={BTN}
            style={{ color: "var(--muted-foreground)" }}
            onClick={() => dispatch({ type: "memory", id: node.id, decision: "rejected" })}
          >
            Reject · kept for provenance
          </button>
        </div>
      ) : decided ? (
        <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Decided by you · the row stays either way
        </p>
      ) : null}

      <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
        Recall ranks notes flat. These edges are provenance, not a search path.
      </p>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={
          mono ? "break-all font-mono text-[11px] text-foreground/85" : "text-foreground/85"
        }
      >
        {value}
      </dd>
    </div>
  );
}
