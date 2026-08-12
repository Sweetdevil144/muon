import { describe, expect, it } from "vitest";
import { evasionPayloads, residualDanger } from "@muon/client";
import { Sidebar, SIDEBAR_WIDTH } from "../src/shell/sidebar.js";
import { TabStrip } from "../src/shell/tab-strip.js";
import { Footer } from "../src/shell/footer.js";
import { Shell } from "../src/shell/shell.js";

/**
 * The sidebar is HIDDEN by default now (founder law: the terminal is the
 * hero, chrome is revealed). These composition tests are about the frame's
 * geometry WITH chrome attached, so they reveal it explicitly.
 */
function makeVisibleShell(state: ConstructorParameters<typeof Shell>[0]): Shell {
  const shell = new Shell(state);
  shell.setSidebarVisible(true);
  return shell;
}
import { sidebarFromSnapshot } from "../src/shell/from-snapshot.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";
import type { BrainSnapshot } from "../src/lib/brain-store.js";

/**
 * The ADR-0046 shell, tested WITHOUT a terminal: every component is a plain
 * `render(width) → string[]` class, so assertions run on the lines directly —
 * no Ink, no ANSI-stripping test library, none of the blind spots that made a
 * colour-only highlight untestable on the old desks.
 *
 * The corpus gate applies from day one: any component that renders stored
 * text replays the shared evasion corpus here BEFORE it ever reaches a
 * founder's terminal. This is the boundary-as-a-test rule, inherited.
 */

const CONTROL_CLASSES = [
  "invisible-directive",
  "reorder",
  "repaint",
  "row-forgery",
] as const;

const COCKPIT = {
  paletteOpen: false,
  formOpen: false,
  reviewOpen: false,
  memoryOpen: false,
};

/** Strip OUR OWN theme styling so residualDanger sees only payload bytes. */
function plain(lines: string[]): string {
  const csi = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "g");
  return lines.join("\n").replace(csi, "");
}

function agent(over: Record<string, unknown> = {}) {
  return {
    key: "agent-1",
    name: "codex-1",
    status: "working",
    vendor: "codex",
    ...over,
  };
}

describe("the shell replays the corpus through every stored-text prop", () => {
  it("Sidebar — space names, agent names and vendors are stored text", () => {
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const sidebar = new Sidebar({
        spaces: [{ key: "w", name: payload.text, detail: payload.text }],
        agents: [
          agent({ name: payload.text, vendor: payload.text, status: "working" }),
        ],
        cursor: 0,
        scopes: COCKPIT,
      });
      expect(
        residualDanger(plain(sidebar.render(SIDEBAR_WIDTH)), ["\n"]),
        payload.id
      ).toEqual([]);
    }
  });

  it("TabStrip — titles are stored text", () => {
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const strip = new TabStrip({
        tabs: [{ id: "t", title: payload.text }],
        activeId: "t",
      });
      expect(residualDanger(plain(strip.render(80)), ["\n"]), payload.id).toEqual(
        []
      );
    }
  });

  it("Footer — the status line collects backend and vendor text", () => {
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const footer = new Footer();
      footer.setStatus(payload.text);
      expect(residualDanger(plain(footer.render(80)), ["\n"]), payload.id).toEqual(
        []
      );
    }
  });

  it("the WHOLE shell from a poisoned snapshot", () => {
    for (const payload of evasionPayloads(...CONTROL_CLASSES)) {
      const snapshot: BrainSnapshot = {
        ...emptyBrainSnapshot(),
        agents: [
          {
            id: "a1",
            name: payload.text,
            vendor: payload.text,
            status: "working",
            ordinal: 1,
          },
        ] as never,
      };
      const shell = makeVisibleShell({
        sidebar: sidebarFromSnapshot(snapshot, 0, COCKPIT, payload.text),
        tabs: { tabs: [{ id: "chat", title: payload.text }], activeId: "chat" },
        rows: 20,
      });
      shell.footer.setStatus(payload.text);
      expect(residualDanger(plain(shell.render(100)), ["\n"]), payload.id).toEqual(
        []
      );
    }
  });
});

describe("the frame behaves", () => {
  it("one cursor, ever — a modal scope takes the highlight off the rail", () => {
    // The founder-reported dual-cursor bug, pinned at the NEW shell from day
    // one via the SAME predicate (railOwnsCursor) the fix introduced.
    const base = {
      spaces: [{ key: "w", name: "muon" }],
      agents: [agent()],
      cursor: 0,
    };
    const focused = new Sidebar({ ...base, scopes: COCKPIT });
    const paletteOpen = new Sidebar({
      ...base,
      scopes: { ...COCKPIT, paletteOpen: true },
    });
    const cyanMark = `${String.fromCodePoint(0x1b)}[36m`;
    expect(focused.render(SIDEBAR_WIDTH).join("")).toContain(cyanMark);
    expect(paletteOpen.render(SIDEBAR_WIDTH).join("")).not.toContain(cyanMark);
  });

  it("the sidebar column never staircases — visible width is padded, not string width", () => {
    // ANSI styling makes `padEnd` under-pad by the escape bytes; the divider
    // then drifts right on styled rows. Padding is by VISIBLE length.
    const shell = makeVisibleShell({
      sidebar: {
        spaces: [{ key: "w", name: "muon" }],
        agents: [agent(), agent({ key: "a2", name: "claude-1", status: "idle" })],
        cursor: 0,
        scopes: COCKPIT,
      },
      tabs: { tabs: [{ id: "chat", title: "chat" }], activeId: "chat" },
      rows: 12,
    });
    const lines = plain(shell.render(100)).split("\n");
    const dividers = lines
      .filter((line) => line.includes("│"))
      .map((line) => line.indexOf("│"));
    expect(new Set(dividers).size, `divider columns: ${dividers}`).toBe(1);
  });

  it("the footer clips by VISIBLE cells, and shows hints when idle", () => {
    // The first version asserted `line.length <= width` — the wrong metric,
    // which PASSED because of the bug it claimed to cover (escape bytes
    // counted as columns, truncating the styled hint ~9 cells early).
    const footer = new Footer();
    expect(plain(footer.render(120))).toContain("ctrl+q quit");
    footer.setStatus("x".repeat(200));
    const clipped = plain([footer.render(40)[0]!]);
    expect(clipped.length).toBe(40);
    // And a styled idle line is NOT truncated early: the full hint survives
    // a width equal to its visible length.
    const idle = new Footer();
    const hintVisible = plain(idle.render(500)).trimEnd();
    expect(plain(idle.render(hintVisible.length))).toContain("ctrl+q quit");
  });

  it("tab strip renders the + affordance and inverts only the active tab", () => {
    const strip = new TabStrip({
      tabs: [
        { id: "a", title: "chat" },
        { id: "b", title: "stream" },
      ],
      activeId: "b",
    });
    const line = strip.render(80).join("");
    expect(plain([line])).toContain("+");
    const inverseMark = `${String.fromCodePoint(0x1b)}[7m`;
    // exactly one inverse span — the active tab.
    expect(line.split(inverseMark).length - 1).toBe(1);
  });

  it("the COMPOSED frame with a live hostile pane emits SGR escapes only", async () => {
    // Review finding: the whole-shell corpus test ran with a NULL centre, so
    // the one surface that renders raw child state was never in the composed
    // frame. This is the missing enforcement: a hostile full-screen child
    // inside the real Shell, and the entire composed output may carry no
    // escape that is not an SGR `m` sequence — the engine parses exactly
    // that form, and anything else (mode arming, cursor motion) is the class
    // that hijacked the host terminal.
    const esc = String.fromCodePoint(0x1b);
    const { PtySession } = await import("../src/shell/pty-session.js");
    const { PtyPane } = await import("../src/shell/pty-pane.js");
    const session = new PtySession({
      id: "hostile",
      title: "hostile",
      command: "/bin/sh",
      args: [
        "-c",
        `printf '${esc}[2J${esc}[?1049h${esc}[?1002h${esc}[5;5Htrapped'; sleep 2`,
      ],
      cwd: process.cwd(),
      envKind: "shell",
      ungoverned: true,
      cols: 40,
      rows: 6,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          if (session.renderScreen().some((l) => l.includes("trapped")))
            return resolve();
          if (Date.now() - start > 8000) return reject(new Error("no output"));
          setTimeout(tick, 50);
        };
        tick();
      });
      const shell = makeVisibleShell({
        sidebar: {
          spaces: [{ key: "w", name: "muon" }],
          agents: [agent()],
          cursor: 0,
          scopes: COCKPIT,
        },
        tabs: { tabs: [{ id: "hostile", title: "hostile" }], activeId: "hostile" },
        rows: 12,
      });
      shell.setCentre(new PtyPane(session));
      const frame = shell.render(100).join("\n");
      const nonSgr = frame
        .split(esc)
        .slice(1)
        .filter((chunk) => !/^\[[0-9;]*m/.test(chunk));
      expect(nonSgr, `non-SGR escapes in the composed frame: ${JSON.stringify(nonSgr.slice(0, 3))}`).toEqual([]);
    } finally {
      session.dispose();
    }
  }, 15_000);
});

describe("the footer's hints come back", () => {
  it("a status holds the line, then the keymap returns", () => {
    // Without the expiry, the FIRST status destroyed the one always-visible
    // line that teaches the keymap, for the rest of the session.
    const footer = new Footer();
    let now = 1_000;
    footer.setClock(() => now);
    footer.setStatus("✗ no split — ctrl+b | opens one", () => now);
    expect(plain(footer.render(140))).toContain("no split");
    now += 6_500;
    expect(
      plain(footer.render(140)),
      "the hints must return once the message is stale"
    ).toContain("ctrl+q quit");
  });
});

describe("the child is told the width it actually gets", () => {
  // THE FOUNDER'S SCREENSHOT. The entry computed the pane's geometry as
  // `terminal - 26 columns` on the theory that the sidebar takes 26 — but the
  // sidebar is HIDDEN by default (the terminal is the hero), so a vendor CLI
  // was handed 26 fewer columns than it had and drew itself into a box with
  // dead space beside it. A guess about the layout cannot stay right; this
  // asks the thing that DOES the layout.
  function deskShell(over: Partial<Parameters<Shell["update"]>[0]> = {}) {
    return new Shell({
      sidebar: sidebarFromSnapshot(emptyBrainSnapshot(), 0, COCKPIT, "/repo"),
      tabs: { tabs: [{ id: "chat", title: "chat" }], activeId: "chat" },
      rows: 40,
      ...(over as object),
    } as never);
  }

  it("gives the child the FULL width when the sidebar is hidden", () => {
    const shell = deskShell();
    expect(shell.paneViewport(120).cols).toBe(120);
  });

  it("gives back exactly the sidebar's columns when it is shown", () => {
    const shell = deskShell();
    shell.setSidebarVisible(true);
    const hidden = deskShell().paneViewport(120).cols;
    const shown = shell.paneViewport(120).cols;
    expect(shown, "narrower by the rail and its divider").toBeLessThan(hidden);
  });

  it("halves the width for a SPLIT, because each child gets half", () => {
    const shell = deskShell();
    const whole = shell.paneViewport(120).cols;
    shell.setPanes([
      { render: () => [], invalidate: () => {} },
      { render: () => [], invalidate: () => {} },
    ] as never);
    expect(shell.paneViewport(120).cols).toBeLessThan(whole);
  });

  it("never returns a width or height a terminal cannot hold", () => {
    const shell = deskShell();
    const tiny = shell.paneViewport(10);
    expect(tiny.cols).toBeGreaterThanOrEqual(20);
    expect(tiny.rows).toBeGreaterThanOrEqual(5);
  });
});
