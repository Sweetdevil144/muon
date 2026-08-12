import { describe, expect, it } from "vitest";
import {
  buildMemoryDecision,
  evasionPayloads,
  memoryMarkerTag,
  memoryNoteMarkers,
  residualDanger,
  type MemoryNote,
} from "@muon/client";
import { MemoryPane, MEMORY_VIEWPORT_ROWS } from "../src/shell/memory-pane.js";
import { routeKey, type ShellScope } from "../src/shell/keys.js";

/**
 * Memory on the shell desk (matrix rows C4–C9, C10), and the governed
 * payloads its writes send.
 *
 * The payload tests are the important ones: the reject shape encodes TWO
 * separate production defects, and until now that knowledge lived only in
 * prose comments on three surfaces.
 */

const esc = String.fromCodePoint(0x1b);

function plain(lines: string[]): string {
  const csi = new RegExp(`${esc}\\[[0-9;]*m`, "g");
  return lines.join("\n").replace(csi, "");
}

function note(over: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "note-1",
    // A REAL kind: `MemoryKind` is decision|constraint|convention|attempt|
    // question. "fact" and "tool-call" do not exist — a fixture that invents
    // one lets a test pass on a shape production cannot produce.
    kind: "decision",
    text: "the brain is local-first",
    confirmed: false,
    status: "active",
    createdBy: "muon-orchestrator",
    createdAt: new Date().toISOString(),
    ...over,
  } as MemoryNote;
}

const PANE = {
  cursor: 0,
  showExpired: false,
  autoConfirmAgentMemory: false,
  busy: false,
  workspace: "/Users/x/repo",
  total: 1,
};

function scope(over: Partial<ShellScope> = {}): ShellScope {
  return {
    reviewOpen: false,
    reviewApprovable: true,
    reviewResolving: false,
    spawnMenuOpen: false,
    livePane: false,
    inboxFocused: false,
    inboxHasRows: false,
    governedOpen: false,
    corpseOnScreen: false,
    memoryOpen: false,
    memoryBusy: false,
    helpOpen: false,
    navOpen: false,
    crewOpen: false,
    sidebarOpen: false,
    prefixArmed: false,
    ...over,
  };
}

describe("the governed payloads carry what the gate needs", () => {
  it("REJECT sends BOTH halves — each one was a separate defect", () => {
    // `confirmed:false` makes it an ADJUDICATION (the ledger mints a
    // Confirmation only when `confirmed !== undefined`, and only then reads
    // `principal`); `status:"rejected"` durably RETIRES it. Neither field
    // affects the HTTP gate — `requireOperator` is unconditional on PATCH.
    expect(buildMemoryDecision("n1", "reject")).toEqual({
      noteId: "n1",
      confirmed: false,
      status: "rejected",
      principal: "human",
    });
  });

  it("CONFIRM stamps the human principal — only a human elevates a note", () => {
    expect(buildMemoryDecision("n1", "confirm")).toEqual({
      noteId: "n1",
      confirmed: true,
      principal: "human",
    });
  });

  it("pause/resume and pin/unpin are status/flag writes, not confirmations", () => {
    expect(buildMemoryDecision("n1", "pause")).toEqual({
      noteId: "n1",
      status: "paused",
    });
    expect(buildMemoryDecision("n1", "resume")).toEqual({
      noteId: "n1",
      status: "active",
    });
    // PIN CARRIES THE PRINCIPAL. The ledger's `pinned !== undefined` branch
    // enforces it — a non-human principal throws "Only a human operator may
    // pin or unpin memory". My first version omitted it and justified the
    // omission with a false claim that only the confirm branch reads it.
    expect(buildMemoryDecision("n1", "pin")).toEqual({
      noteId: "n1",
      pinned: true,
      principal: "human",
    });
    expect(buildMemoryDecision("n1", "unpin")).toEqual({
      noteId: "n1",
      pinned: false,
      principal: "human",
    });
    // None of these may masquerade as a CONFIRMATION.
    for (const action of ["pause", "resume", "pin", "unpin"] as const) {
      expect(buildMemoryDecision("n1", action).confirmed).toBeUndefined();
    }
    // pause/resume genuinely need no principal: neither branch reads it.
    expect(buildMemoryDecision("n1", "pause").principal).toBeUndefined();
    expect(buildMemoryDecision("n1", "resume").principal).toBeUndefined();
  });
});

describe("the markers mean the same thing on every desk", () => {
  it("a crew-visible note is SETTLED under a permissive posture, homework under strict", () => {
    // P0-3, the drift that made one note read two ways: the posture decides.
    const agentNote = note({ createdBy: "muon-orchestrator", confirmed: false });
    expect(memoryNoteMarkers(agentNote, true).needsReview).toBe(false);
    expect(memoryNoteMarkers(agentNote, false).needsReview).toBe(true);
  });

  it("`·review` is a DEBT marker: a vouched note never carries it", () => {
    // P0-2 — it must mean NOBODY vouched, not merely that no human did.
    const vouched = note({ confirmed: false, createdBy: "muon-orchestrator" });
    expect(memoryMarkerTag(vouched, true)).toContain("·muon");
    expect(memoryMarkerTag(vouched, true)).not.toContain("·review");
  });

  it("a confirmed note reads ✓ under either posture", () => {
    const confirmed = note({ confirmed: true });
    expect(memoryMarkerTag(confirmed, true)).toContain("·✓");
    expect(memoryMarkerTag(confirmed, false)).toContain("·✓");
  });

  it("expiry is REPORTED, never derived locally", () => {
    expect(memoryNoteMarkers(note({ expired: true }), true).expired).toBe(true);
    expect(memoryNoteMarkers(note({ expired: false }), true).expired).toBe(false);
  });
});

describe("the pane tells the truth about what a key would do", () => {
  const state = { ...PANE, notes: [note()] } as never;

  it("the keybar reflects the SELECTED note's state, not a fixed label", () => {
    const paused = plain(
      new MemoryPane({ ...state, notes: [note({ status: "paused" })] }).render(100)
    );
    expect(paused).toContain("p resume");
    const active = plain(new MemoryPane(state).render(100));
    expect(active).toContain("p pause");

    const pinned = plain(
      new MemoryPane({ ...state, notes: [note({ pinned: true })] }).render(100)
    );
    expect(pinned).toContain("P unpin");
    expect(pinned).toContain("cannot be forgotten");
  });

  it("an empty result says WHICH question was asked", () => {
    const hidden = plain(new MemoryPane({ ...state, notes: [] }).render(100));
    expect(hidden).toContain("press e to include expired");
    const shown = plain(
      new MemoryPane({ ...state, notes: [], showExpired: true }).render(100)
    );
    expect(shown).toContain("including expired");
  });

  it("an expired note explains that it is hidden, not deleted", () => {
    const out = plain(
      new MemoryPane({ ...state, notes: [note({ expired: true })] }).render(100)
    );
    expect(out).toContain("EXPIRED");
    expect(out).toContain("never deleted");
  });

  it("replays the corpus through note text", () => {
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      const out = plain(
        new MemoryPane({ ...state, notes: [note({ text: payload.text })] }).render(100)
      );
      expect(residualDanger(out, ["\n"]), payload.id).toEqual([]);
    }
  });
});

describe("memory routing: a governed write is never one stray key away", () => {
  it("the memory scope OWNS the keyboard while open", () => {
    const open = scope({ memoryOpen: true, corpseOnScreen: true });
    // `q` would quit and Enter would attach in the cockpit; neither may fire
    // behind a human who is looking at a brain-write surface.
    expect(routeKey("q", open)).toEqual({ kind: "none" });
    expect(routeKey("\r", open)).toEqual({ kind: "none" });
  });

  it("c and x route to confirm and reject", () => {
    const open = scope({ memoryOpen: true });
    expect(routeKey("c", open)).toEqual({
      kind: "memory-act",
      action: "confirm",
    });
    expect(routeKey("x", open)).toEqual({
      kind: "memory-act",
      action: "reject",
    });
  });

  it("the memory scope OWNS its keys — Tab does not cycle out of a write surface", () => {
    expect(routeKey("\t", scope({ memoryOpen: true }))).toEqual({ kind: "none" });
  });

  it("a write in flight blocks another — no double-send", () => {
    const busy = scope({ memoryOpen: true, memoryBusy: true });
    expect(routeKey("c", busy)).toEqual({ kind: "none" });
    expect(routeKey("x", busy)).toEqual({ kind: "none" });
    // esc still escapes — a human is never trapped in a scope.
    expect(routeKey(esc, busy)).toEqual({ kind: "pop-layer" });
  });

  it("memory opens on the PREFIX, and a bare `m` is always the child's", () => {
    // The key model changed: a bare letter cannot be a desk command once a
    // vendor CLI owns the pane. `ctrl+b m` opens memory from anywhere.
    expect(routeKey("m", scope({ prefixArmed: true }))).toEqual({
      kind: "open-memory",
    });
    expect(routeKey("m", scope({ livePane: true }))).toEqual({
      kind: "to-child",
      data: "m",
    });
  });
});

describe("what a review found clipped, hidden, or unreachable", () => {
  it("the affordances survive COMPOSITION — they are above the list, not below", async () => {
    // Composed last, the keybar was dropped by the shell's row budget while
    // `c` and `x` stayed armed and live with nothing on screen saying so.
    const { Shell } = await import("../src/shell/shell.js");
    const many = Array.from({ length: 40 }, (_, i) =>
      note({ id: `n${i}`, text: `note number ${i}` })
    );
    const shell = new Shell({
      sidebar: {
        spaces: [{ key: "w", name: "muon" }],
        agents: [],
        cursor: 0,
        scopes: {
          paletteOpen: false,
          formOpen: false,
          reviewOpen: false,
          memoryOpen: true,
        },
      },
      tabs: { tabs: [{ id: "chat", title: "chat" }], activeId: "chat" },
      rows: 24,
    });
    shell.setCentre(
      new MemoryPane({ ...PANE, notes: many, total: 40 } as never)
    );
    const composed = plain(shell.render(120));
    expect(composed, "the keybar must be reachable").toContain("c confirm");
    expect(composed, "the partition must be stated").toContain("workspace:");
  });

  it("the cursor stays ON SCREEN — it is the binding target for c and x", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      note({ id: `n${i}`, text: `note-${i}` })
    );
    const out = plain(
      new MemoryPane({ ...PANE, notes: many, cursor: 55, total: 60 } as never).render(120)
    );
    // The selected row's own text must be in the frame, not merely somewhere
    // in a list that scrolled past it.
    expect(out).toContain("note-55");
    expect(out).toContain("above");
  });

  it("the viewport is bounded — a 500-note library does not render 500 rows", () => {
    const many = Array.from({ length: 500 }, (_, i) => note({ id: `n${i}` }));
    const lines = new MemoryPane({
      ...PANE,
      notes: many,
      total: 500,
    } as never).render(120);
    expect(lines.length).toBeLessThan(MEMORY_VIEWPORT_ROWS + 12);
  });

  it("an UNSCOPED view says so — ADR-0026 §9, a partition is always stated", () => {
    const out = plain(
      new MemoryPane({
        ...PANE,
        notes: [note()],
        workspace: undefined,
      } as never).render(120)
    );
    expect(out).toContain("unscoped view");
  });

  it("a truncated page says how many it is showing OF how many", () => {
    const out = plain(
      new MemoryPane({
        ...PANE,
        notes: [note()],
        total: 87,
      } as never).render(120)
    );
    expect(out).toContain("of 87");
  });

  it("a PAUSED note is reachable and reads as paused", () => {
    // The library read asks for `status:"all"`; the old search route returned
    // active notes only, so `p` could never resolve to resume and the marker
    // was dead code.
    const out = plain(
      new MemoryPane({
        ...PANE,
        notes: [note({ status: "paused" })],
      } as never).render(120)
    );
    expect(out).toContain("paused");
    expect(out).toContain("p resume");
  });
});
