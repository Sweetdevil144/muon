"use client";

import type { KeyboardEvent } from "react";

import { MISSION } from "@/lib/demo-run/script";
import { DemoRunProvider, useDemoRun } from "@/lib/demo-run/store";

import { EventLog } from "./mission-run/EventLog";
import { GateCard } from "./mission-run/GateCard";
import { LaneColumn } from "./mission-run/LaneColumn";
import { MemoryGraph } from "./mission-run/MemoryGraph";
import { MemoryPanel } from "./mission-run/MemoryPanel";
import { NextBriefPanel } from "./mission-run/NextBriefPanel";
import { Transport } from "./mission-run/Transport";

export function MissionRun({ variant }: { variant: "compact" | "full" }) {
  return (
    <DemoRunProvider autoplay={variant === "compact"}>
      {variant === "compact" ? <CompactRun /> : <FullRun />}
    </DemoRunProvider>
  );
}

function useSectionKeys() {
  const { dispatch } = useDemoRun();
  return (e: KeyboardEvent<HTMLElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === " ") {
      e.preventDefault();
      dispatch({ type: "toggle" });
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      dispatch({ type: "step", dir: 1 });
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      dispatch({ type: "step", dir: -1 });
    } else if (e.key === "r" || e.key === "R") {
      dispatch({ type: "replay" });
    }
  };
}

function MissionCard({ compact }: { compact?: boolean }) {
  const { state, frame } = useDemoRun();
  const landed =
    state.decision === "approved" ? "LANDED" : state.decision === "rejected" ? "NOT LANDED" : null;

  return (
    <div className="border-b border-border p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="panel-label">Sample project · checkout service</span>
        {landed ? (
          <span
            className="font-mono text-[10px] uppercase tracking-[0.14em]"
            style={{
              color: landed === "LANDED" ? "var(--trust-human)" : "var(--trust-unconfirmed)",
            }}
          >
            {landed}
          </span>
        ) : null}
      </div>
      <p className="font-mono text-[13px] leading-snug text-foreground">“{MISSION}”</p>
      {!compact ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={frame.landDisabled || state.decision !== null}
            className="border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--muon-blue)] disabled:opacity-40"
          >
            Land this work
          </button>
          {frame.degraded ? (
            <span className="text-[11px]" style={{ color: "var(--trust-stale)" }}>
              Missing evidence: the newest handoff packet is degraded.
            </span>
          ) : null}
          {frame.reviewBlind && state.decision === null ? (
            <span className="text-[11px]" style={{ color: "var(--trust-stale)" }}>
              Review blind: 1 new/unindexed file among 6 changed files.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CompactRun() {
  const { sectionRef } = useDemoRun();
  const onKeyDown = useSectionKeys();

  return (
    <section
      ref={sectionRef}
      onKeyDown={onKeyDown}
      aria-label="MUON mission run"
      className="panel rack-grid"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <span className="panel-label">How a mission runs</span>
      </div>
      <MissionCard compact />
      <LaneColumn compact />
      <div className="border-t border-border">
        <EventLog limit={3} />
      </div>
      <div className="border-t border-border px-3 py-2">
        <MemoryGraph compact />
      </div>
      <div className="border-t border-border p-3">
        <GateCard compact />
      </div>
    </section>
  );
}

function FullRun() {
  const { sectionRef } = useDemoRun();
  const onKeyDown = useSectionKeys();

  return (
    <section
      ref={sectionRef}
      onKeyDown={onKeyDown}
      aria-label="MUON mission run"
      className="panel rack-grid"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <span className="panel-label">One mission, four lanes, one human decision</span>
      </div>

      <div className="grid grid-cols-12">
        <div className="col-span-12 border-b border-border lg:col-span-4 lg:border-b-0 lg:border-r">
          <MissionCard />
          <LaneColumn />
        </div>
        <div className="col-span-12 border-b border-border lg:col-span-5 lg:border-b-0 lg:border-r">
          <div className="panel-label border-b border-border px-3 py-2">Mission log</div>
          <div className="max-h-[420px] overflow-y-auto">
            <EventLog />
          </div>
        </div>
        <div className="col-span-12 p-3 lg:col-span-3">
          <GateCard />
        </div>
      </div>

      <Transport />

      <div className="grid grid-cols-12 gap-4 border-t border-border p-4">
        <div className="col-span-12 lg:col-span-6">
          <div className="panel-label mb-2">What the crew knows about this project</div>
          <MemoryGraph />
        </div>
        <div className="col-span-12 lg:col-span-3">
          <MemoryPanel />
        </div>
        <div className="col-span-12 lg:col-span-3">
          <NextBriefPanel />
        </div>
      </div>
    </section>
  );
}

/** Graph + panel + later-mission brief, sharing the same store. */
export function MemoryExplorer() {
  return (
    <DemoRunProvider>
      <MemoryExplorerBody />
    </DemoRunProvider>
  );
}

function MemoryExplorerBody() {
  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="panel rack-grid col-span-12 p-4 lg:col-span-6">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="panel-label">What the crew knows about this project</span>
          </div>
        <MemoryGraph />
      </div>
      <div className="col-span-12 lg:col-span-3">
        <MemoryPanel />
      </div>
      <div className="col-span-12 lg:col-span-3">
        <NextBriefPanel />
      </div>
    </div>
  );
}
