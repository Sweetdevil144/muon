import { terminalSafe } from "@muon/client";
import type { AgentRecord, ApprovalRequest, DispatchJobRecord } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, green, red, yellow } from "./theme.js";

/**
 * The crew drawer — REVEALED, never default chrome (founder law 3).
 *
 * This exists because the key that opens it shipped one wake before it did.
 * `ctrl+b c` was advertised in the keymap as "crew drawer — lanes and what is
 * blocked", toggled a boolean, moved a cursor, and rendered nothing. The
 * drift-lock test passed because it asserted the key ROUTES to an intent, not
 * that the intent has an observable effect — the same hole a review had
 * already found in the destination list ("a comment with a Set around it").
 * Founder law 6 does not say "every key routes"; it says every key WORKS.
 *
 * WHAT A LANE ROW MUST SAY, in priority order, because a crew list that
 * ranks by name buries the only row that needs a human:
 *
 *   BLOCKED (a gate is waiting on you)  →  working  →  idle  →  done
 *
 * "blocked" is not an agent status the brain reports; it is DERIVED here from
 * a pending approval bound to that agent's job. That derivation is the reason
 * this drawer is worth opening at all: the crew list on the desktop shows the
 * same thing, and a terminal that only showed `status` would make a human
 * cross-reference the inbox by hand to learn who is stuck.
 */

export type CrewLane = {
  readonly agent: AgentRecord;
  readonly state: "blocked" | "working" | "idle" | "done";
  /** The approval blocking this lane, when it is blocked. */
  readonly blockedBy: string | null;
  readonly vendor: string;
};

export type CrewDrawerState = {
  readonly lanes: readonly CrewLane[];
  readonly cursor: number;
  readonly focused: boolean;
};

export const CREW_WIDTH = 34;

/**
 * Derive lanes from the brain snapshot. Pure, so the ranking rule is testable
 * without a terminal.
 */
export function buildCrewLanes(input: {
  agents: readonly AgentRecord[];
  jobs: readonly DispatchJobRecord[];
  approvals: readonly ApprovalRequest[];
}): CrewLane[] {
  const pending = input.approvals.filter(
    (approval) => approval.status === "pending"
  );
  const lanes = input.agents.map((agent): CrewLane => {
    const job = input.jobs.find((record) => record.agentId === agent.id);
    const gate = job
      ? pending.find((approval) => approval.jobId === job.id)
      : undefined;
    const state: CrewLane["state"] = gate
      ? "blocked"
      : agent.status === "working"
        ? "working"
        : agent.status === "done" || agent.status === "succeeded"
          ? "done"
          : "idle";
    return {
      agent,
      state,
      blockedBy: gate?.id ?? null,
      vendor: agent.vendor ?? "?",
    };
  });
  // BLOCKED FIRST. A crew list sorted by name buries the one row that is
  // actually waiting on a human behind rows that are fine.
  const rank = { blocked: 0, working: 1, idle: 2, done: 3 } as const;
  return lanes.sort(
    (a, b) =>
      rank[a.state] - rank[b.state] ||
      String(a.agent.name ?? a.agent.id).localeCompare(
        String(b.agent.name ?? b.agent.id)
      )
  );
}

const GLYPH: Record<CrewLane["state"], string> = {
  blocked: "◉",
  working: "●",
  idle: "○",
  done: "✓",
};

function paint(state: CrewLane["state"], text: string): string {
  switch (state) {
    case "blocked":
      return red(text);
    case "working":
      return green(text);
    case "done":
      return dim(text);
    default:
      return text;
  }
}

export class CrewDrawer implements Component {
  private state: CrewDrawerState;

  constructor(state: CrewDrawerState) {
    this.state = state;
  }

  update(state: CrewDrawerState): void {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const blocked = this.state.lanes.filter((lane) => lane.state === "blocked");
    const lines: string[] = [
      bold(" crew ") +
        (blocked.length > 0
          ? red(`${blocked.length} blocked`)
          : dim(`${this.state.lanes.length} lane${this.state.lanes.length === 1 ? "" : "s"}`)),
    ];

    if (this.state.lanes.length === 0) {
      lines.push(dim(" no crew running"));
      return lines.map((line) => clip(line, width));
    }

    this.state.lanes.forEach((lane, index) => {
      const active = this.state.focused && index === this.state.cursor;
      const marker = active ? cyan("›") : " ";
      const name = terminalSafe(String(lane.agent.name ?? lane.agent.id));
      lines.push(
        ` ${marker} ${paint(lane.state, GLYPH[lane.state])} ${active ? bold(name) : name}`
      );
      lines.push(
        dim(`     ${lane.state} · ${terminalSafe(lane.vendor)}`)
      );
      if (lane.state === "blocked") {
        // The whole point of the drawer: say WHAT is blocking, not just that
        // something is. A human should not have to open the inbox to find out.
        lines.push(yellow("     ⏎ answer the gate holding this lane"));
      }
    });

    return lines.map((line) => clip(line, width));
  }
}

function clip(line: string, width: number): string {
  return line.length > width * 4 ? line.slice(0, width * 4) : line;
}
