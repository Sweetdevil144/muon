"use client";

import { useEffect, useRef } from "react";

import { useDemoRun } from "@/lib/demo-run/store";

const BTN =
  "border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--muon-blue)]";

export function GateCard({ compact = false }: { compact?: boolean }) {
  const { state, frame, reduced, dispatch } = useDemoRun();
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  const open = frame.halted || state.decision !== null;

  useEffect(() => {
    if (frame.halted && !reduced && state.started) primaryRef.current?.focus();
  }, [frame.halted, reduced, state.started]);

  if (!open) {
    return (
      <div className="panel p-3">
        <div className="panel-label mb-2">Merge gate</div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Nothing has landed. The gate is filed by a person once the diff is ready.
        </p>
      </div>
    );
  }

  if (state.decision === "approved") {
    return (
      <div className="panel p-3" style={{ borderColor: "var(--trust-human)" }}>
        <div className="panel-label mb-2" style={{ color: "var(--trust-human)" }}>
          Merge gate · landed
        </div>
        <p className="text-[13px] leading-relaxed text-foreground/85">
          Approved by you. The lane&apos;s worktree commit landed on the primary checkout with{" "}
          <span className="font-mono">git merge --no-ff</span>.
        </p>
        {state.wrapFiled ? (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Wrap filed 3 unconfirmed memory proposals into your review queue. Nothing auto-promotes.
          </p>
        ) : null}
      </div>
    );
  }

  if (state.decision === "rejected") {
    return (
      <div className="panel p-3" style={{ borderColor: "var(--trust-unconfirmed)" }}>
        <div className="panel-label mb-2" style={{ color: "var(--trust-unconfirmed)" }}>
          Merge gate · not landed
        </div>
        <p className="text-[13px] leading-relaxed text-foreground/85">
          Rejected by you. Nothing merged. The lane keeps its worktree and its commit; the work goes
          back as a follow-on that cites this decision.
        </p>
        <button
          type="button"
          className={`${BTN} mt-3`}
          style={{ borderColor: "var(--muon-blue)", color: "var(--trust-human)" }}
          onClick={() => dispatch({ type: "continue" })}
        >
          Continue on this lane
        </button>
      </div>
    );
  }

  return (
    <div className="panel p-3" style={{ borderColor: "var(--trust-stale)" }}>
      <div className="mb-2 flex items-center gap-2">
        <span
          className={`${reduced ? "" : "animate-gate-pulse "}size-1.5 rounded-full`}
          style={{ backgroundColor: "var(--trust-stale)" }}
        />
        <span className="panel-label" style={{ color: "var(--trust-stale)" }}>
          Merge gate · waiting on you
        </span>
      </div>
      <p className="text-[13px] leading-relaxed text-foreground/85">
        Merge gate MRG-4417 filed. Nothing has landed yet — decide it here.
      </p>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--trust-stale)" }}>
        Approve is blocked — REVIEW BLIND: a changed file is unindexed, so 0 affected flows is not a
        pass.
      </p>

      {!state.attested ? (
        <button
          ref={primaryRef}
          type="button"
          className={`${BTN} mt-3`}
          style={{ borderColor: "var(--muon-blue)", color: "var(--trust-human)" }}
          onClick={() => dispatch({ type: "attest" })}
        >
          Review the blind file
        </button>
      ) : (
        <div className="mt-3 border border-border p-3">
          <p className="font-mono text-[11px]">src/checkout/idempotency.ts</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Attested against this exact diff digest and file set.
          </p>
          <button
            type="button"
            role="checkbox"
            aria-checked={state.acked}
            onClick={() => dispatch({ type: "ack" })}
            className="mt-3 flex items-center gap-2 text-left font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--muon-blue)]"
          >
            <span
              className="grid size-3.5 place-items-center border"
              style={{
                borderColor: state.acked ? "var(--muon-blue)" : "var(--border)",
                backgroundColor: state.acked ? "var(--muon-blue)" : "transparent",
              }}
            />
            I reviewed this file against this diff
          </button>
          <div
            className="mt-3 flex flex-wrap gap-2"
            style={{ display: state.acked ? undefined : "none" }}
          >
            <button
              type="button"
              className={BTN}
              style={{ borderColor: "var(--muon-blue)", color: "var(--trust-human)" }}
              onClick={() => dispatch({ type: "decide", decision: "approved" })}
            >
              Confirm the merge
            </button>
            <button
              type="button"
              className={BTN}
              style={{ color: "var(--muted-foreground)" }}
              onClick={() => dispatch({ type: "decide", decision: "rejected" })}
            >
              Send it back
            </button>
          </div>
        </div>
      )}

      {!compact ? (
        <p className="mt-3 border-t border-border pt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          The run has halted. Nothing continues until a person decides.
        </p>
      ) : null}
    </div>
  );
}
