import { describe, expect, it, vi } from "vitest";
import { evasionPayloads, residualDanger } from "@muon/client";
import type { MuonApiClient, RecordedEvent } from "@muon/client";
import {
  buildTimelineRows,
  TimelinePane,
  TIMELINE_MAX_ROWS,
} from "../src/shell/timeline-pane.js";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot, type BrainSnapshot } from "../src/lib/brain-store.js";
import { IMPLEMENTED_DESTINATIONS } from "../src/shell/nav.js";
import { NAV_DESTINATIONS } from "@muon/client";

/**
 * TIMELINE — the ledger, in order, and the destination list that names it.
 *
 * Two of the nine destinations were refusing while the desk already held what
 * they needed: `crew` was fully built as a drawer and reachable by `ctrl+b c`
 * the whole time, and `timeline`'s data (`BrainSnapshot.events`) was being
 * polled every tick with nowhere to put it. Founder law 6 has a second
 * direction nobody had written down: a surface that EXISTS must not be
 * advertised as missing.
 */

const ESC = String.fromCodePoint(0x1b);
const PREFIX = String.fromCodePoint(2);
const NOW = Date.parse("2026-08-09T12:00:00.000Z");

function plain(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;:]*m`, "g"), "");
}

function event(over: Partial<RecordedEvent> = {}): RecordedEvent {
  return {
    id: "ev-1",
    laneId: "claude",
    taskId: "task-1",
    kind: "task.progress",
    message: "did a thing",
    metadata: {},
    timestamp: "2026-08-09T11:59:00.000Z",
    ...over,
  } as RecordedEvent;
}

function makeDesk(events: RecordedEvent[] = []) {
  const snapshot: BrainSnapshot = { ...emptyBrainSnapshot(), events };
  const desk = new Desk({
    client: {
      listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
      getAutoConfirmAgentMemory: vi.fn(async () => false),
    } as unknown as MuonApiClient,
    getSnapshot: () => snapshot,
    geometry: () => ({ cols: 60, rows: 12 }),
    terminalRows: () => 30,
    cwd: () => "/repo",
    frozen: [],
    onChange: () => {},
    onQuit: () => {},
  });
  return { desk, snapshot };
}

/** Walk the destination list to `target` and press Enter. */
function openDestination(desk: Desk, target: string) {
  desk.handleKey(PREFIX);
  desk.handleKey("g");
  const index = NAV_DESTINATIONS.findIndex((entry) => entry.target === target);
  for (let step = 0; step < index; step += 1) desk.handleKey(`${ESC}[B`);
  desk.handleKey("\r");
}

describe("the destination list no longer refuses what the desk has", () => {
  it("CREW is reachable from the nav, not only from its chord", () => {
    expect(IMPLEMENTED_DESTINATIONS.has("crew")).toBe(true);
    const { desk } = makeDesk();
    openDestination(desk, "crew");
    expect(desk.centreKind()).toBe("crew");
  });

  it("TIMELINE opens the ledger", () => {
    expect(IMPLEMENTED_DESTINATIONS.has("timeline")).toBe(true);
    const { desk } = makeDesk([event()]);
    openDestination(desk, "timeline");
    expect(desk.centreKind()).toBe("timeline");
    expect(plain(desk.shell.render(100).join("\n"))).toContain("did a thing");
  });

  it("an UNBUILT destination still refuses, and names where to go", () => {
    // The honesty this preserves: the four that remain must keep saying so.
    const { desk } = makeDesk();
    openDestination(desk, "graph");
    expect(desk.centreKind()).not.toBe("timeline");
    expect(plain(desk.shell.render(100).join("\n"))).toContain(
      "not on this desk yet"
    );
  });

  it("Esc pops the timeline, exactly one layer", () => {
    const { desk } = makeDesk([event()]);
    openDestination(desk, "timeline");
    desk.handleKey(ESC);
    expect(desk.centreKind()).not.toBe("timeline");
  });
});

describe("what a ledger row owes the reader", () => {
  it("is NEWEST FIRST — a human opening it is asking what just happened", () => {
    const state = buildTimelineRows(
      [
        event({ id: "old", message: "older", timestamp: "2026-08-09T10:00:00.000Z" }),
        event({ id: "new", message: "newer", timestamp: "2026-08-09T11:00:00.000Z" }),
      ],
      NOW
    );
    expect(state.rows.map((row) => row.event.id)).toEqual(["new", "old"]);
  });

  it("names an agent act's ACCOUNTABLE human when the ledger has one", () => {
    // The row a post-incident read is actually looking for.
    const [row] = buildTimelineRows(
      [
        event({
          principalId: "agent:codex",
          principalKind: "agent",
          accountablePrincipalId: "human:casey",
        }),
      ],
      NOW
    ).rows;
    expect(row!.who).toContain("agent:codex");
    expect(row!.who).toContain("human:casey");
  });

  it("never invents a principal for a row that has none", () => {
    // Attributing an unattributed act is the confident wrong answer an audit
    // surface must not produce.
    const [row] = buildTimelineRows([event()], NOW).rows;
    expect(row!.who).toBe("—");
  });

  it("ages are relative, bounded, and never negative on a skewed clock", () => {
    const rows = buildTimelineRows(
      [
        event({ id: "a", timestamp: "2026-08-09T11:59:30.000Z" }),
        event({ id: "b", timestamp: "2026-08-09T11:30:00.000Z" }),
        event({ id: "c", timestamp: "2026-08-08T12:00:00.000Z" }),
        event({ id: "d", timestamp: "2026-08-09T12:30:00.000Z" }),
        event({ id: "e", timestamp: "not a date" }),
      ],
      NOW
    ).rows;
    const byId = new Map(rows.map((row) => [row.event.id, row.age]));
    expect(byId.get("a")).toBe("30s");
    expect(byId.get("b")).toBe("30m");
    expect(byId.get("c")).toBe("24h");
    expect(byId.get("d"), "a future timestamp is 0s, never negative").toBe("0s");
    expect(byId.get("e")).toBe("—");
  });

  it("BOUNDS the rows and says that it did", () => {
    // A bounded view that does not say it is bounded reads as "this is
    // everything that happened" — on an audit surface, of all places.
    const many = Array.from({ length: TIMELINE_MAX_ROWS + 25 }, (_x, index) =>
      event({ id: `ev-${index}`, timestamp: `2026-08-09T10:${String(index % 60).padStart(2, "0")}:00.000Z` })
    );
    const state = buildTimelineRows(many, NOW);
    expect(state.rows).toHaveLength(TIMELINE_MAX_ROWS);
    expect(state.total).toBe(many.length);
    const frame = plain(new TimelinePane(state, 40).render(120).join("\n"));
    expect(frame).toContain("older event(s) not shown");
  });

  it("says so when nothing has happened, rather than drawing an empty box", () => {
    const frame = plain(
      new TimelinePane(buildTimelineRows([], NOW), 20).render(80).join("\n")
    );
    expect(frame).toContain("nothing has happened yet");
  });

  it("windows around the CURSOR, so a selection cannot fall off the frame", () => {
    const many = Array.from({ length: 100 }, (_x, index) =>
      event({ id: `ev-${index}`, message: `row-${index}`, timestamp: `2026-08-09T10:00:${String(index % 60).padStart(2, "0")}.000Z` })
    );
    const state = buildTimelineRows(many, NOW);
    const frame = plain(
      new TimelinePane({ ...state, cursor: 60 }, 20).render(120).join("\n")
    );
    expect(frame).toContain(state.rows[60]!.message);
  });
});

describe("the ledger is AGENT-AUTHORED text on a MUON surface", () => {
  it("replays the evasion corpus through every rendered field", () => {
    // This is the class that has been broken twice on this desk. A pane that
    // renders ledger text raw hands an agent the ability to repaint the frame
    // a human is reading its own audit trail in.
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      const state = buildTimelineRows(
        [
          event({
            message: payload.text,
            kind: payload.text,
            principalId: payload.text,
            principalKind: "agent",
            accountablePrincipalId: payload.text,
          }),
        ],
        NOW
      );
      // PER LINE, not over a joined frame: `terminalSafe` is the LINE
      // sanitizer, so joining with "\n" would report the join's own newlines
      // as residual danger and the test would be asserting nothing about the
      // payload. Each rendered line must be clean on its own.
      for (const line of new TimelinePane(state, 20).render(200)) {
        expect(residualDanger(plain(line), []), payload.id).toEqual([]);
      }
    }
  });
});

describe("Tab is not dead on a centre reveal", () => {
  // An adversarial review found what the earlier version did: with the
  // timeline or settings open, Tab toggled the rail flags UNDERNEATH while the
  // overlay stayed on top, so nothing on screen changed and Tab read as dead —
  // the advertised-but-inert defect, on exactly the surfaces a human is most
  // likely to press Tab on. Tab means "go to the next zone", and a centre
  // reveal is not a zone, so leaving one is part of the move.
  it.each(["timeline", "settings", "graph"] as const)(
    "Tab leaves %s rather than doing nothing",
    (target) => {
      const { desk } = makeDesk([event()]);
      openDestination(desk, target);
      const before = desk.centreKind();
      desk.handleKey("\t");
      if (before === "timeline" || before === "settings") {
        expect(desk.centreKind(), target).not.toBe(before);
      }
    }
  );

  it("does NOT dismiss the spawn picker — that is a choice in progress", () => {
    // Tab is the key people press to look around. Throwing away a half-made
    // choice would be a worse surprise than an inert key.
    const { desk } = makeDesk();
    desk.bootstrap();
    expect(desk.centreKind()).toBe("spawn-menu");
    desk.handleKey("\t");
    expect(desk.centreKind()).toBe("spawn-menu");
  });
});

describe("the newest rows are selected, not sorted out of the whole history", () => {
  it("agrees with a full sort, including the ties", () => {
    // The output must be IDENTICAL to what a sort produced — the change is
    // only that the cost stops depending on how long the mission has run.
    const many = Array.from({ length: 5_000 }, (_x, index) =>
      event({
        id: `ev-${index}`,
        // Deliberately shuffled, with duplicate timestamps.
        timestamp: new Date(
          Date.parse("2026-08-09T00:00:00.000Z") + ((index * 7919) % 4000) * 1000
        ).toISOString(),
      })
    );
    const expected = [...many]
      .sort((l, r) => Date.parse(r.timestamp) - Date.parse(l.timestamp))
      .slice(0, TIMELINE_MAX_ROWS)
      .map((e) => Date.parse(e.timestamp));
    const actual = buildTimelineRows(many, NOW).rows.map((row) =>
      Date.parse(row.event.timestamp)
    );
    expect(actual).toEqual(expected);
  });

  it("keeps an unparseable timestamp as a row rather than dropping it", () => {
    // It is still a thing that happened; `ageOf` renders it honestly as "—".
    const rows = buildTimelineRows([event({ id: "bad", timestamp: "nope" })], NOW)
      .rows;
    expect(rows.map((row) => row.event.id)).toEqual(["bad"]);
  });

  it("touches each event a BOUNDED number of times, not n log n", () => {
    // A wall-clock ratio was the first version of this and it was flaky by
    // construction — it measured the machine, not the algorithm, and failed on
    // a loaded run (ADR-0037: a flaky check is still a failure). Counting the
    // work is deterministic and says the same thing better.
    //
    // One pass reads each event's timestamp ONCE, plus once more for each row
    // it keeps. A full sort reads them O(n log n) times.
    let reads = 0;
    const many = Array.from({ length: 20_000 }, (_x, index) => {
      const at = `2026-08-09T10:00:${String(index % 60).padStart(2, "0")}.000Z`;
      return {
        ...event({ id: `e${index}` }),
        get timestamp() {
          reads += 1;
          return at;
        },
      } as RecordedEvent;
    });

    buildTimelineRows(many, NOW);
    expect(
      reads,
      "one pass over the history, plus the rows it kept"
    ).toBeLessThan(many.length + TIMELINE_MAX_ROWS * 3);
  });
});
