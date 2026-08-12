import { describe, expect, it, vi } from "vitest";
import { evasionPayloads, residualDanger } from "@muon/client";
import type { MuonApiClient } from "@muon/client";
import { buildCrewLanes, CrewDrawer } from "../src/shell/crew-drawer.js";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot, type BrainSnapshot } from "../src/lib/brain-store.js";

/**
 * The crew drawer (founder law 3: crew is a REVEAL, never default chrome).
 *
 * The drawer's reason to exist is the BLOCKED state — an agent waiting on a
 * human. It is not a status the brain reports; it is derived from a pending
 * approval bound to that agent's job. Everything below defends that
 * derivation, its ranking, and the one gesture that pays it off.
 */

const esc = String.fromCodePoint(0x1b);
const PREFIX = String.fromCodePoint(2);

function plain(lines: string[]): string {
  const csi = new RegExp(`${esc}\\[[0-9;]*m`, "g");
  return lines.join("\n").replace(csi, "");
}

const agent = (id: string, status: string) =>
  ({ id, name: id, status, vendor: "codex" }) as never;
const job = (id: string, agentId: string) =>
  ({ id, agentId, kind: "task", vendor: "codex", taskId: "t", brief: "b", status: "running" }) as never;
const approval = (id: string, jobId?: string) =>
  ({
    id,
    jobId,
    kind: "command",
    status: "pending",
    summary: "run it",
    createdAt: "2026-01-01",
    evidence: {
      action: "Run a command",
      scope: "the workspace",
      impactIfApproved: "runs",
      details: {},
      payloadDigest: "d",
    },
  }) as never;

describe("BLOCKED is derived, and it ranks first", () => {
  it("an agent whose job has a pending approval is BLOCKED, not 'working'", () => {
    // The brain reports `working`. Only the join with a pending approval
    // reveals that it is actually waiting on a human.
    const lanes = buildCrewLanes({
      agents: [agent("a1", "working")],
      jobs: [job("j1", "a1")],
      approvals: [approval("ap1", "j1")],
    });
    expect(lanes[0]!.state).toBe("blocked");
    expect(lanes[0]!.blockedBy).toBe("ap1");
  });

  it("a DECIDED approval does not block a lane", () => {
    const lanes = buildCrewLanes({
      agents: [agent("a1", "working")],
      jobs: [job("j1", "a1")],
      approvals: [{ ...(approval("ap1", "j1") as object), status: "approved" } as never],
    });
    expect(lanes[0]!.state).toBe("working");
  });

  it("blocked lanes sort ABOVE working, idle and done", () => {
    // A crew list ordered by name buries the one row that needs a human.
    const lanes = buildCrewLanes({
      agents: [
        agent("zeta-working", "working"),
        agent("alpha-idle", "idle"),
        agent("mid-blocked", "working"),
        agent("beta-done", "done"),
      ],
      jobs: [job("j1", "mid-blocked")],
      approvals: [approval("ap1", "j1")],
    });
    expect(lanes.map((lane) => lane.state)).toEqual([
      "blocked",
      "working",
      "idle",
      "done",
    ]);
    expect(lanes[0]!.agent.id).toBe("mid-blocked");
  });

  it("the header counts what is blocked, and the row says a gate holds it", () => {
    const lanes = buildCrewLanes({
      agents: [agent("a1", "working")],
      jobs: [job("j1", "a1")],
      approvals: [approval("ap1", "j1")],
    });
    const out = plain(new CrewDrawer({ lanes, cursor: 0, focused: true }).render(60));
    expect(out).toContain("1 blocked");
    expect(out).toContain("answer the gate holding this lane");
  });

  it("an empty crew says so rather than rendering a blank box", () => {
    const out = plain(
      new CrewDrawer({ lanes: [], cursor: 0, focused: true }).render(60)
    );
    expect(out).toContain("no crew running");
  });

  it("replays the corpus through agent names and vendors", () => {
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      const lanes = buildCrewLanes({
        agents: [
          { id: payload.text, name: payload.text, status: "idle", vendor: payload.text } as never,
        ],
        jobs: [],
        approvals: [],
      });
      const out = plain(new CrewDrawer({ lanes, cursor: 0, focused: true }).render(80));
      expect(residualDanger(out, ["\n"]), payload.id).toEqual([]);
    }
  });
});

describe("the gesture that pays the drawer off", () => {
  function makeDesk() {
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      agents: [agent("a1", "working")],
      dispatchJobs: [job("j1", "a1")],
      approvals: [approval("ap1", "j1")],
    };
    return new Desk({
      client: {
        listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
        getAutoConfirmAgentMemory: vi.fn(async () => false),
        resolveApproval: vi.fn(async () => ({})),
      } as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 60, rows: 10 }),
      terminalRows: () => 40,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
  }

  it("Enter on a BLOCKED lane opens that lane's gate — evidence first", () => {
    const desk = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("c");
    expect(desk.centreKind()).toBe("crew");
    desk.handleKey("\r");
    // It opens the REVIEW (the decision is still a second press) and closes
    // the drawer, so the human is looking at the evidence, not the list.
    expect(desk.centreKind()).toBe("review");
    expect(desk.reviewState()?.approval.id).toBe("ap1");
  });

  it("the drawer is HIDDEN until asked, and Esc puts it away", () => {
    const desk = makeDesk();
    expect(desk.revealed().crew).toBe(false);
    desk.handleKey(PREFIX);
    desk.handleKey("c");
    expect(desk.revealed().crew).toBe(true);
    desk.handleKey(esc);
    expect(desk.revealed().crew).toBe(false);
  });

  it("the drawer shows the DERIVED state, not the raw agent status", () => {
    const desk = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("c");
    desk.render();
    const out = plain(desk.shell.render(140));
    expect(out).toContain("blocked");
  });
});
