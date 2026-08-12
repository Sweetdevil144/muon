import { describe, expect, it, vi } from "vitest";
import { NAV_DESTINATIONS, type MuonApiClient } from "@muon/client";
import { IMPLEMENTED_DESTINATIONS, Nav } from "../src/shell/nav.js";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot, type BrainSnapshot } from "../src/lib/brain-store.js";

/**
 * The destination list (matrix row A1).
 *
 * NOTE the key model change: destinations open with the DESK PREFIX
 * (`ctrl+b g`), not a bare `g`. A bare letter cannot be a desk command once a
 * vendor CLI owns the pane — it would be stolen from the child. See
 * `keymap.ts`.
 *
 * The rule these defend is that the nav must not misrepresent the PRODUCT.
 * Most destinations are not built on this desk, and a nav that listed only
 * the working ones would tell a human MUON has three places rather than nine.
 */

const esc = String.fromCodePoint(0x1b);

function plain(lines: string[]): string {
  const csi = new RegExp(`${esc}\\[[0-9;]*m`, "g");
  return lines.join("\n").replace(csi, "");
}

function makeDesk(over: Partial<BrainSnapshot> = {}) {
  const snapshot: BrainSnapshot = { ...emptyBrainSnapshot(), ...over };
  const client = {
    listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
    getAutoConfirmAgentMemory: vi.fn(async () => false),
    resolveApproval: vi.fn(async () => ({})),
    updateMemoryNote: vi.fn(async () => ({})),
  } as unknown as MuonApiClient;
  return new Desk({
    client,
    getSnapshot: () => snapshot,
    geometry: () => ({ cols: 60, rows: 10 }),
    terminalRows: () => 30,
    cwd: () => "/repo",
    frozen: [],
    onChange: () => {},
    onQuit: () => {},
  });
}

const BASE = {
  active: "mission" as const,
  cursor: 0,
  focused: true,
  pendingDecisions: 0,
  crewActive: false,
  rows: 30,
};

describe("the nav lists the PRODUCT, not this desk's subset", () => {
  it("every destination appears, built or not", () => {
    const out = plain(new Nav(BASE).render(60));
    for (const entry of NAV_DESTINATIONS) {
      expect(out, `${entry.target} must be listed`).toContain(entry.label);
    }
    expect(NAV_DESTINATIONS.length).toBe(9);
  });

  it("an unbuilt destination says so, and says where it IS", () => {
    // Refusal WITH a reason and a place — never a silent omission and never a
    // dead key.
    const unbuilt = NAV_DESTINATIONS.findIndex(
      (entry) => !IMPLEMENTED_DESTINATIONS.has(entry.target)
    );
    const out = plain(new Nav({ ...BASE, cursor: unbuilt }).render(80));
    expect(out).toContain("not on this desk yet");
    expect(out).toContain("tui:ink");
  });

  it("selecting an unbuilt destination REFUSES and does not change where we are", () => {
    const desk = makeDesk();
    desk.handleKey(String.fromCodePoint(2)); desk.handleKey("g");
    const graph = NAV_DESTINATIONS.findIndex((e) => e.target === "graph");
    for (let i = 0; i < graph; i += 1) desk.handleKey("j");
    desk.handleKey("\r");
    expect(desk.activeDestination()).toBe("mission");
    expect(desk.shell.render(120).join("\n")).toContain("not on this desk yet");
  });

  it("selecting a BUILT destination moves there", async () => {
    const desk = makeDesk();
    desk.handleKey(String.fromCodePoint(2)); desk.handleKey("g");
    const memory = NAV_DESTINATIONS.findIndex((e) => e.target === "memory");
    for (let i = 0; i < memory; i += 1) desk.handleKey("j");
    desk.handleKey("\r");
    expect(desk.activeDestination()).toBe("memory");
    await vi.waitFor(() => expect(desk.centreKind()).toBe("memory"));
  });
});

describe("the badges ride the rows they belong to", () => {
  it("Control carries the pending count; zero hides it", () => {
    const withWork = plain(
      new Nav({ ...BASE, pendingDecisions: 3, focused: false }).render(60)
    );
    const controlRow = withWork
      .split("\n")
      .find((line) => line.includes("Control"))!;
    expect(controlRow).toContain("3");

    const idle = plain(new Nav({ ...BASE, focused: false }).render(60));
    const idleRow = idle.split("\n").find((line) => line.includes("Control"))!;
    expect(idleRow).not.toContain("3");
  });

  it("Crew carries a quiet dot only while an agent is working", () => {
    const busy = plain(
      new Nav({ ...BASE, crewActive: true, focused: false }).render(60)
    );
    const busyRow = busy.split("\n").find((line) => line.includes("Crew"))!;
    expect(busyRow).toContain("·");
  });

  it("the pending count comes from the SAME pending-only derivation as the rail", () => {
    const desk = makeDesk({
      approvals: [
        { id: "a", status: "approved", kind: "command", createdAt: "x" },
        { id: "b", status: "pending", kind: "command", createdAt: "y" },
      ] as never,
    });
    desk.handleKey(String.fromCodePoint(2)); desk.handleKey("g");
    const frame = desk.shell.render(120).join("\n");
    const controlRow = frame.split("\n").find((l) => l.includes("Control"))!;
    // ONE pending, not two — a decided approval must never inflate the badge.
    expect(controlRow).toContain("1");
  });
});

describe("the nav is a chooser, so it owns the keyboard", () => {
  it("q does not quit while the nav is open", () => {
    let quit = 0;
    const snapshot = emptyBrainSnapshot();
    const desk = new Desk({
      client: {
        listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
        getAutoConfirmAgentMemory: vi.fn(async () => false),
      } as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 60, rows: 10 }),
      terminalRows: () => 30,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {
        quit += 1;
      },
    });
    desk.handleKey(String.fromCodePoint(2)); desk.handleKey("g");
    desk.handleKey("q");
    expect(quit).toBe(0);
    // ctrl+q still always works.
    desk.handleKey(String.fromCodePoint(17));
    expect(quit).toBe(1);
  });

  it("esc closes it without navigating", () => {
    const desk = makeDesk();
    desk.handleKey(String.fromCodePoint(2)); desk.handleKey("g");
    desk.handleKey("j");
    desk.handleKey(esc);
    expect(desk.centreKind()).not.toBe("nav");
    expect(desk.activeDestination()).toBe("mission");
  });

  it("opening it starts on the CURRENT destination, not at the top", async () => {
    const desk = makeDesk();
    desk.handleKey(String.fromCodePoint(2)); desk.handleKey("g");
    const memory = NAV_DESTINATIONS.findIndex((e) => e.target === "memory");
    for (let i = 0; i < memory; i += 1) desk.handleKey("j");
    desk.handleKey("\r");
    await vi.waitFor(() => expect(desk.activeDestination()).toBe("memory"));
    // Re-open: the cursor must be on Memory, so Enter is a no-op rather than
    // silently jumping the human back to Mission.
    desk.handleKey(esc);
    desk.handleKey(String.fromCodePoint(2)); desk.handleKey("g");
    desk.handleKey("\r");
    expect(desk.activeDestination()).toBe("memory");
  });
});

describe("the nav windows only when it must", () => {
  it("shows every destination when there is room", () => {
    const out = plain(new Nav({ ...BASE, rows: 30 }).render(60));
    for (const entry of NAV_DESTINATIONS) expect(out).toContain(entry.label);
    expect(out).not.toContain("below");
  });

  it("on a SHORT terminal it windows, keeps the cursor on screen, and says so", () => {
    // The review's case: at 11 terminal rows the cursor walked off screen
    // while Enter still selected the invisible row.
    const settings = NAV_DESTINATIONS.length - 1;
    const out = plain(new Nav({ ...BASE, rows: 8, cursor: settings }).render(60));
    expect(out, "the selected row must be visible").toContain("Settings");
    expect(out, "and the hidden rows must be counted").toContain("above");
  });
});
