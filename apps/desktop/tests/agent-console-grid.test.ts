import { describe, expect, it } from "vitest";
import { LANE_PTY_COLS, LANE_PTY_ROWS } from "@muon/adapters";
import { terminalTakeoverVendorIds } from "@muon/client/vendors";
import {
  AGENT_CONSOLE_GRIDS,
  LANE_CONSOLE_GRID,
  agentConsoleGrid,
} from "../src/renderer/lib/agent-console-grid.js";

/**
 * U3 — the DRIFT LOCK behind "the viewer renders at the same geometry so
 * wrapping is byte-faithful" (@muon/adapters, lane-runner.ts).
 *
 * The renderer cannot import lane-runner.ts — it pulls node-pty and
 * child_process — so the two numbers are mirrored. Mirrored numbers rot. This
 * test runs in node, imports the REAL constants, and fails the moment the
 * dispatched console's geometry and the viewer's stop being the same fact.
 */
describe("the live viewer's grid tracks the dispatched console's grid", () => {
  it("mirrors LANE_PTY_COLS / LANE_PTY_ROWS exactly", () => {
    expect(LANE_CONSOLE_GRID).toEqual({
      cols: LANE_PTY_COLS,
      rows: LANE_PTY_ROWS,
    });
  });

  it("pins codex — the one lane that dispatches onto a real pty", () => {
    expect(agentConsoleGrid("codex")).toEqual({
      cols: LANE_PTY_COLS,
      rows: LANE_PTY_ROWS,
    });
  });

  it("pins nothing for a lane with no console of its own", () => {
    // claude-code runs in-process through the Agent SDK: MUON never owns that
    // child's stdio, so there is no source geometry and nothing to pin.
    expect(agentConsoleGrid("claude-code")).toBeNull();
    expect(agentConsoleGrid("cursor")).toBeNull();
    expect(agentConsoleGrid("opencode")).toBeNull();
  });

  it("answers null for an unknown vendor rather than guessing a geometry", () => {
    expect(agentConsoleGrid("some-future-lane")).toBeNull();
    expect(agentConsoleGrid(null)).toBeNull();
    expect(agentConsoleGrid(undefined)).toBeNull();
  });

  it("states an answer for every vendor that can hold a terminal", () => {
    // Totality is the mechanism: a lane that later opts into a pty console
    // must not inherit a silently wrong geometry by being forgotten.
    for (const vendor of terminalTakeoverVendorIds()) {
      expect(Object.prototype.hasOwnProperty.call(AGENT_CONSOLE_GRIDS, vendor)).toBe(
        true
      );
    }
  });
});
