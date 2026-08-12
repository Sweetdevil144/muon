import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot, type BrainSnapshot } from "../src/lib/brain-store.js";

/**
 * SPLITS, the default session, and the sidebar's content.
 *
 * The founder opened `npm run tui:shell` and saw one dead "chat" tab, the
 * literal string "centre — phase 2 puts the real pty here", and a footer of
 * chords. Every test here defends one part of the answer: the desk boots into
 * something real, `ctrl+b |` puts a second terminal beside the first,
 * keystrokes reach the pane that has focus, and the rail says what session
 * you are in.
 *
 * These spawn REAL /bin/sh children — the standing rule for an embedded
 * runtime, and the only way a split proves it hosts two live ptys.
 */

const PREFIX = String.fromCodePoint(2);
const ESC = String.fromCodePoint(0x1b);

function plain(lines: string[]): string {
  const csi = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
  return lines.join("\n").replace(csi, "");
}

function makeDesk(over: Partial<BrainSnapshot> = {}) {
  const snapshot: BrainSnapshot = { ...emptyBrainSnapshot(), ...over };
  const desk = new Desk({
    client: {
      listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
      getAutoConfirmAgentMemory: vi.fn(async () => false),
    } as unknown as MuonApiClient,
    getSnapshot: () => snapshot,
    geometry: () => ({ cols: 40, rows: 8 }),
    terminalRows: () => 40,
    cwd: () => "/Users/x/muon-labs",
    branch: () => "main",
    frozen: [],
    onChange: () => {},
    onQuit: () => {},
  });
  return desk;
}

/** Open one real shell session through the picker, as a human would. */
function openShell(desk: Desk): void {
  desk.handleKey(PREFIX);
  desk.handleKey("t");
  // The picker lists shell last; walk to it and choose.
  for (let i = 0; i < 8; i += 1) desk.handleKey("j");
  desk.handleKey("\r");
}

describe("the desk never boots empty", () => {
  it("with no sessions it opens the PICKER, not a placeholder", () => {
    const desk = makeDesk();
    desk.bootstrap();
    expect(desk.centreKind()).toBe("spawn-menu");
    // The string the founder saw must not exist anywhere in the frame.
    expect(plain(desk.shell.render(120))).not.toContain("phase 2");
  });

  it("a RESTORED session is content — the picker must not hide it", () => {
    const snapshot = emptyBrainSnapshot();
    const desk = new Desk({
      client: {} as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 40, rows: 8 }),
      terminalRows: () => 40,
      cwd: () => "/repo",
      frozen: [
        {
          id: "shell-1",
          kind: "shell",
          ordinal: 1,
          label: "Terminal",
          text: "WHAT-YOU-LEFT",
          cols: 80,
          rows: 24,
        },
      ],
      onChange: () => {},
      onQuit: () => {},
    });
    desk.bootstrap();
    expect(desk.centreKind()).toBe("frozen");
    expect(plain(desk.shell.render(120))).toContain("WHAT-YOU-LEFT");
  });
});

describe("ctrl+b | splits, and the panes are both real", () => {
  it("opens a second pane beside the first, and toggles it closed", () => {
    const desk = makeDesk();
    try {
      openShell(desk);
      expect(desk.centreKind()).toBe("pty");
      expect(desk.shell.paneCount(), "one pane before the split").toBe(1);

      desk.handleKey(PREFIX);
      desk.handleKey("|");
      // The split asks WHICH kind — a shell or another vendor beside it.
      expect(desk.centreKind()).toBe("spawn-menu");
      for (let i = 0; i < 8; i += 1) desk.handleKey("j");
      desk.handleKey("\r");
      desk.render();
      expect(desk.shell.paneCount(), "two panes after the split").toBe(2);

      // A second `|` closes it rather than stacking unreachable panes.
      desk.handleKey(PREFIX);
      desk.handleKey("|");
      desk.render();
      expect(desk.shell.paneCount()).toBe(1);
    } finally {
      desk.dispose();
    }
  });

  it("a split is a PANE, not a tab — the strip still shows one", () => {
    const desk = makeDesk();
    try {
      openShell(desk);
      desk.handleKey(PREFIX);
      desk.handleKey("|");
      for (let i = 0; i < 8; i += 1) desk.handleKey("j");
      desk.handleKey("\r");
      desk.render();
      expect(desk.liveSessions().length, "two live ptys").toBe(2);
      const strip = plain(desk.shell.render(140)).split("\n")[0]!;
      // One tab label, not two: the right pane is reached with ctrl+b o.
      expect(strip.match(/Terminal/g)?.length ?? 0).toBe(1);
    } finally {
      desk.dispose();
    }
  });

  it("splitting with nothing open REFUSES with a reason", () => {
    const desk = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("|");
    expect(plain(desk.shell.render(120))).toContain("nothing to split");
  });
});

describe("focus decides which child gets the keystrokes", () => {
  it("ctrl+b o moves focus, and typing follows it", async () => {
    const desk = makeDesk();
    try {
      openShell(desk);
      desk.handleKey(PREFIX);
      desk.handleKey("|");
      for (let i = 0; i < 8; i += 1) desk.handleKey("j");
      desk.handleKey("\r");
      // The new split takes focus — you asked for it, you are in it.
      expect(desk.focusedPaneIndex()).toBe(1);

      const [main, split] = desk.liveSessions();
      // Type into the RIGHT pane and prove only it received the bytes.
      desk.handleKey("printf RIGHT-PANE-GOT-IT\r");
      await vi.waitFor(
        () =>
          expect(split!.session.renderScreen().join("\n")).toContain(
            "RIGHT-PANE-GOT-IT"
          ),
        { timeout: 8000 }
      );
      expect(
        main!.session.renderScreen().join("\n"),
        "the main pane must not see the split's keystrokes"
      ).not.toContain("RIGHT-PANE-GOT-IT");

      desk.handleKey(PREFIX);
      desk.handleKey("o");
      expect(desk.focusedPaneIndex()).toBe(0);
    } finally {
      desk.dispose();
    }
  }, 20_000);

  it("ctrl+b o with no split REFUSES rather than silently doing nothing", () => {
    const desk = makeDesk();
    try {
      openShell(desk);
      desk.handleKey(PREFIX);
      desk.handleKey("o");
      expect(plain(desk.shell.render(120))).toContain("no split");
    } finally {
      desk.dispose();
    }
  });
});

describe("the sidebar says what session you are in", () => {
  it("shows SPACES, SESSIONS and INFO — and no crew tree", () => {
    const desk = makeDesk();
    try {
      openShell(desk);
      desk.handleKey(PREFIX);
      desk.handleKey("s");
      desk.render();
      const frame = plain(desk.shell.render(140));
      expect(frame).toContain("SPACES");
      expect(frame).toContain("muon-labs");
      expect(frame).toContain("main");
      expect(frame).toContain("SESSIONS");
      expect(frame).toContain("INFO");
      // Crew is a DRAWER (ctrl+b c), never a permanent rail.
      expect(frame).not.toContain("CREW");
    } finally {
      desk.dispose();
    }
  });

  it("INFO reports the pane count and the governance mode", () => {
    const desk = makeDesk();
    try {
      openShell(desk);
      desk.handleKey(PREFIX);
      desk.handleKey("s");
      desk.render();
      const frame = plain(desk.shell.render(140));
      expect(frame).toContain("panes");
      // A human-opened pane is ungoverned, and the rail says so (D5).
      expect(frame).toContain("UNGOVERNED");
    } finally {
      desk.dispose();
    }
  });
});

describe("review findings, pinned", () => {
  it("a VISIBLE sidebar does not steal the terminal's keys", async () => {
    // The worst of the batch: `topLayer` listed the sidebar, so the overlay
    // branch swallowed every key before the live-pane branch — after
    // `ctrl+b s`, typing into Claude went nowhere at all.
    const desk = makeDesk();
    try {
      openShell(desk);
      desk.handleKey(PREFIX);
      desk.handleKey("s");
      expect(desk.revealed().sidebar).toBe(true);

      const [main] = desk.liveSessions();
      desk.handleKey("printf SIDEBAR-OPEN-STILL-TYPES\r");
      await vi.waitFor(
        () =>
          expect(main!.session.renderScreen().join("\n")).toContain(
            "SIDEBAR-OPEN-STILL-TYPES"
          ),
        { timeout: 8000 }
      );
    } finally {
      desk.dispose();
    }
  }, 20_000);

  it("every non-reserved key still reaches the child with the sidebar open", async () => {
    const { routeKey } = await import("../src/shell/keys.js");
    const base = {
      reviewOpen: false,
      reviewApprovable: true,
      reviewResolving: false,
      memoryOpen: false,
      memoryBusy: false,
      helpOpen: false,
      navOpen: false,
      spawnMenuOpen: false,
      crewOpen: false,
      sidebarOpen: true,
      inboxFocused: false,
      inboxHasRows: false,
      livePane: true,
      governedOpen: false,
      corpseOnScreen: false,
      prefixArmed: false,
      composerOpen: false,
      composerBusy: false,
    };
    for (const key of ["q", "j", "/", "\t", `${ESC}[A`]) {
      expect(routeKey(key, base), `${JSON.stringify(key)} must reach the child`).toEqual({
        kind: "to-child",
        data: key,
      });
    }
  });

  it("`x` discards a restored corpse — it was advertised and inert", () => {
    const snapshot = emptyBrainSnapshot();
    const desk = new Desk({
      client: {} as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 40, rows: 8 }),
      terminalRows: () => 40,
      cwd: () => "/repo",
      frozen: [
        {
          id: "shell-1",
          kind: "shell",
          ordinal: 1,
          label: "Terminal",
          text: "OLD-SCREEN",
          cols: 80,
          rows: 24,
        },
      ],
      onChange: () => {},
      onQuit: () => {},
    });
    expect(desk.centreKind()).toBe("frozen");
    // The pane's own face advertises "x discard this tab".
    expect(plain(desk.shell.render(120))).toContain("x discard this tab");
    desk.handleKey("x");
    expect(desk.centreKind()).not.toBe("frozen");
  });

  it("a FAILED decision keeps the evidence on screen", async () => {
    const snapshot: BrainSnapshot = {
      ...emptyBrainSnapshot(),
      approvals: [
        {
          id: "ap-1",
          kind: "command",
          status: "pending",
          summary: "s",
          createdAt: "2026-01-01",
          evidence: {
            action: "Run a command",
            scope: "the workspace",
            impactIfApproved: "runs",
            details: {},
            payloadDigest: "d",
          },
        },
      ] as never,
    };
    const desk = new Desk({
      client: {
        resolveApproval: vi.fn(async () => {
          throw new Error("409 already approved");
        }),
      } as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 40, rows: 8 }),
      terminalRows: () => 40,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
    desk.handleKey(PREFIX);
    desk.handleKey("i");
    desk.handleKey("\r");
    expect(desk.centreKind()).toBe("review");
    desk.handleKey("a");
    await vi.waitFor(() =>
      expect(plain(desk.shell.render(120))).toContain("could not")
    );
    // The gate is STILL up: closing it would force a reopen to retry a
    // still-pending approval.
    expect(desk.centreKind()).toBe("review");
    expect(desk.reviewState()?.resolving).toBe(false);
  });
});

describe("pre-merge review findings, pinned", () => {
  it("the sidebar YIELDS on a narrow terminal instead of breaking the frame", () => {
    // 26 (rail) + 1 (divider) + 20 (centre floor) = 47. Below that, the old
    // code emitted 47 columns into a 40-column terminal and the divider and
    // the whole centre pane vanished at the right margin.
    const desk = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("s");
    desk.render();
    for (const width of [30, 40, 46, 47, 120]) {
      const widest = Math.max(
        ...desk.shell.render(width).map((line) => plain([line]).length)
      );
      expect(widest, `width ${width} overflowed`).toBeLessThanOrEqual(width);
    }
  });

  it("a split whose parent is gone is REFUSED, not orphaned", () => {
    // ctrl+b | (picker opens carrying the split target) → ctrl+b w (closes the
    // tab, because the prefix is checked before the overlay) → Enter. That
    // used to create a live pty parented to a dead id — invisible, unkillable
    // until quit, and possibly a vendor CLI burning tokens.
    const desk = makeDesk();
    try {
      openShell(desk);
      desk.handleKey(PREFIX);
      desk.handleKey("|");
      desk.handleKey(PREFIX);
      desk.handleKey("w");
      for (let i = 0; i < 8; i += 1) desk.handleKey("j");
      desk.handleKey("\r");
      // Whatever exists must be REACHABLE: a top-level tab, never a session
      // parented to a dead id. (Closing the last tab now replaces the split
      // picker with a fresh one, so Enter legitimately opens a tab — the
      // orphan is impossible by two independent mechanisms.)
      const live = desk.liveSessions();
      for (const session of live) {
        expect(
          session.parentId,
          "a session parented to a dead tab is unreachable"
        ).toBeUndefined();
      }
      expect(desk.shell.paneCount(), "and it is on screen").toBeGreaterThan(0);
    } finally {
      desk.dispose();
    }
  });

  it("closing the LAST tab offers the picker instead of a blank desk", () => {
    const desk = makeDesk();
    try {
      openShell(desk);
      desk.handleKey(PREFIX);
      desk.handleKey("w");
      expect(desk.centreKind(), "an empty desk must offer the next thing").toBe(
        "spawn-menu"
      );
    } finally {
      desk.dispose();
    }
  });
});

describe("the second review round, pinned", () => {
  it("the spawn picker's DECISION path reads live readiness, not boot state", async () => {
    // The first fix rebuilt only the RENDERED component: the row visibly said
    // "codex — not installed" and Enter spawned it anyway. Display and
    // decision must read the same object.
    const { emptyBrainSnapshot } = await import("../src/lib/brain-store.js");
    const snapshot = { ...emptyBrainSnapshot() } as BrainSnapshot;
    const desk = new Desk({
      client: {} as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 40, rows: 8 }),
      terminalRows: () => 40,
      terminalColumns: () => 120,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
    try {
      desk.bootstrap(); // built while readiness is still null
      // Readiness arrives and says codex is missing.
      snapshot.readiness = [
        { vendor: "codex", installed: false, authenticated: false } as never,
      ];
      desk.render();
      const codex = NAV_INDEX_OF_CODEX;
      for (let i = 0; i < codex; i += 1) desk.handleKey("j");
      desk.handleKey("\r");
      expect(desk.liveSessions().length, "a missing CLI must not spawn").toBe(0);
      expect(plain(desk.shell.render(140))).toContain("✗");
    } finally {
      desk.dispose();
    }
  });

  it("ctrl+b s REFUSES on a terminal too narrow to hold the rail", () => {
    // The width guard correctly declined to DRAW it; flipping the flag anyway
    // made the chord silently do nothing while the footer advertised it.
    const snapshot = emptyBrainSnapshot();
    const desk = new Desk({
      client: {} as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 20, rows: 6 }),
      terminalRows: () => 20,
      terminalColumns: () => 40,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
    desk.handleKey(PREFIX);
    desk.handleKey("s");
    expect(desk.revealed().sidebar, "not silently 'open' with nothing drawn").toBe(
      false
    );
    expect(plain(desk.shell.render(40))).toContain("too narrow");
  });
});

const NAV_INDEX_OF_CODEX = 1;
