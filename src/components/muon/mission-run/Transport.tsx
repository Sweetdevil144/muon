"use client";

import { useDemoRun } from "@/lib/demo-run/store";
import { RUN_END } from "@/lib/demo-run/script";

const BTN =
  "border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--muon-blue)] disabled:opacity-40";

export function Transport() {
  const { state, frame, reduced, dispatch } = useDemoRun();

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
      {!reduced ? (
        <button
          type="button"
          className={BTN}
          disabled={frame.halted}
          onClick={() => dispatch({ type: "toggle" })}
        >
          {state.playing ? "Pause" : state.started ? "Play" : "Run the mission"}
        </button>
      ) : null}
      <button type="button" className={BTN} onClick={() => dispatch({ type: "step", dir: -1 })}>
        Step back
      </button>
      <button
        type="button"
        className={BTN}
        disabled={frame.halted}
        onClick={() => dispatch({ type: "step", dir: 1 })}
      >
        Step forward
      </button>
      {!reduced ? (
        <>
          <button type="button" className={BTN} onClick={() => dispatch({ type: "replay" })}>
            Replay
          </button>
          <label className="ml-auto flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <span className="sr-only">Scrub the scripted run</span>
            <input
              type="range"
              min={0}
              max={RUN_END}
              step={100}
              value={state.t}
              onChange={(e) => dispatch({ type: "scrub", t: Number(e.target.value) })}
              className="w-40 accent-[var(--muon-blue)]"
              aria-label="Scrub the scripted run"
            />
            <span>{(state.t / 1000).toFixed(1)}s / 21.0s</span>
          </label>
        </>
      ) : null}
    </div>
  );
}
