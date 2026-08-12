import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evasionPayloads, residualDanger } from "@muon/client";
import {
  buildEntries,
  captureSnapshot,
  consumeSnapshot,
  MAX_SNAPSHOT_ENTRIES,
  MAX_SNAPSHOT_LINES,
  MAX_SNAPSHOT_TEXT_CHARS,
  parseSnapshot,
  snapshotPath,
  type RestoreEntry,
} from "../src/shell/restore-snapshot.js";
import { FrozenPane } from "../src/shell/frozen-pane.js";

/**
 * ADR-0047 — cold restore. The bytes here are the most sensitive MUON
 * handles (whatever a human's shell printed), so every control in the ADR
 * gets a test that fails when it is removed.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-restore-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(over: Partial<RestoreEntry> = {}): RestoreEntry {
  return {
    id: "shell-1",
    kind: "shell",
    ordinal: 1,
    label: "Terminal",
    text: "last screen",
    cols: 80,
    rows: 24,
    ...over,
  };
}

describe("D1 — the file is written under the desktop's own terms", () => {
  it("is created 0600, and a pre-existing loose file is TIGHTENED", () => {
    // `mode` only applies on create, so a file that already exists would keep
    // its permissions without the explicit chmod. Plant a loose one first.
    const file = snapshotPath(dir);
    writeFileSync(file, "{}", { mode: 0o644 });
    captureSnapshot(dir, [entry()]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("bounds entries on the way OUT", () => {
    const many = Array.from({ length: MAX_SNAPSHOT_ENTRIES + 15 }, (_, i) => ({
      id: `shell-${i}`,
      kind: "shell",
      ordinal: i + 1,
      label: `Terminal ${i}`,
      screen: ["x"],
      cols: 80,
      rows: 24,
    }));
    expect(buildEntries(many).length).toBe(MAX_SNAPSHOT_ENTRIES);
  });

  it("bounds per-entry text on the way OUT", () => {
    const built = buildEntries([
      {
        id: "shell-1",
        kind: "shell",
        ordinal: 1,
        label: "Terminal",
        screen: ["y".repeat(MAX_SNAPSHOT_TEXT_CHARS * 2)],
        cols: 80,
        rows: 24,
      },
    ]);
    expect(built[0]!.text.length).toBe(MAX_SNAPSHOT_TEXT_CHARS);
  });

  it("re-bounds on the way IN — the write-side bound is not evidence", () => {
    // A hand-edited file never went through our write path.
    const parsed = parseSnapshot({
      version: 1,
      capturedAt: 0,
      entries: [{ ...entry(), text: "z".repeat(MAX_SNAPSHOT_TEXT_CHARS * 3) }],
    });
    expect(parsed!.entries[0]!.text.length).toBe(MAX_SNAPSHOT_TEXT_CHARS);
  });

  it("is ONE-SHOT: read once, then gone", () => {
    captureSnapshot(dir, [entry()]);
    expect(existsSync(snapshotPath(dir))).toBe(true);
    expect(consumeSnapshot(dir).length).toBe(1);
    expect(existsSync(snapshotPath(dir))).toBe(false);
    expect(consumeSnapshot(dir).length).toBe(0);
  });

  it("a corrupt file is discarded, not thrown — a launch must not block on it", () => {
    writeFileSync(snapshotPath(dir), "{not json at all", { mode: 0o600 });
    expect(() => consumeSnapshot(dir)).not.toThrow();
    expect(consumeSnapshot(dir)).toEqual([]);
    expect(existsSync(snapshotPath(dir))).toBe(false);
  });

  it("a wrong-version file restores nothing", () => {
    writeFileSync(
      snapshotPath(dir),
      JSON.stringify({ version: 99, capturedAt: 0, entries: [entry()] }),
      { mode: 0o600 }
    );
    expect(consumeSnapshot(dir)).toEqual([]);
  });

  it("malformed entries are dropped individually, good ones survive", () => {
    const parsed = parseSnapshot({
      version: 1,
      capturedAt: 0,
      entries: [{ id: 5 }, null, "nope", entry({ id: "keeper" })],
    });
    expect(parsed!.entries.map((e) => e.id)).toEqual(["keeper"]);
  });

  it("no sessions means no file left behind", () => {
    captureSnapshot(dir, [entry()]);
    captureSnapshot(dir, []);
    expect(existsSync(snapshotPath(dir))).toBe(false);
  });
});

describe("D2 — a corpse, not a session", () => {
  it("the frozen pane cannot receive keystrokes", () => {
    const pane = new FrozenPane(entry());
    expect(
      (pane as unknown as Record<string, unknown>).handleInput
    ).toBeUndefined();
  });

  it("it says the session ENDED and that nothing is running", () => {
    const csi = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "g");
    const out = new FrozenPane(entry()).render(100).join("\n").replace(csi, "");
    expect(out).toContain("ENDED");
    expect(out).toContain("nothing is running");
    expect(out).toContain("last screen");
  });
});

describe("D3 — restored text is agent-authored, and survives a restart", () => {
  it("replays the corpus through a snapshot round-trip to the frozen pane", () => {
    const csi = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "g");
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      // Through the REAL path: written to disk, read back, rendered.
      captureSnapshot(dir, [entry({ label: payload.text, text: payload.text })]);
      const restored = consumeSnapshot(dir);
      expect(restored.length, payload.id).toBe(1);
      const out = new FrozenPane(restored[0]!)
        .render(100)
        .join("\n")
        .replace(csi, "");
      expect(residualDanger(out, ["\n"]), payload.id).toEqual([]);
    }
  });
});

describe("the review's findings, pinned so they cannot return", () => {
  it("a within-bounds file of newlines cannot blow the render stack", () => {
    // 256 KiB of newlines is ~262,000 lines. `push(...array)` put every one on
    // the CALL STACK, inside the render tick, which is uncaught: the desk died
    // and left the terminal in the alt screen. Anything running as this user
    // can write that file.
    const hostile = "\n".repeat(200_000);
    captureSnapshot(dir, [entry({ text: hostile })]);
    const restored = consumeSnapshot(dir);
    expect(restored.length).toBe(1);
    expect(restored[0]!.text.split("\n").length).toBeLessThanOrEqual(
      MAX_SNAPSHOT_LINES
    );
    expect(() => new FrozenPane(restored[0]!).render(100)).not.toThrow();
  });

  it("the instructions survive COMPOSITION on a short terminal", async () => {
    // Composed below the body, the only line saying what to do was clipped by
    // the shell's row budget on any terminal shorter than the captured screen.
    const { Shell } = await import("../src/shell/shell.js");
    const tall = Array.from({ length: 60 }, (_, i) => `row-${i}`).join("\n");
    const shell = new Shell({
      sidebar: {
        spaces: [{ key: "w", name: "muon" }],
        agents: [],
        cursor: 0,
        scopes: {
          paletteOpen: false,
          formOpen: false,
          reviewOpen: false,
          memoryOpen: false,
        },
      },
      tabs: { tabs: [{ id: "chat", title: "chat" }], activeId: "chat" },
      rows: 30,
    });
    shell.setCentre(new FrozenPane(entry({ text: tall })));
    const csi = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "g");
    const composed = shell.render(100).join("\n").replace(csi, "");
    expect(composed).toContain("ENDED");
    expect(composed, "the only instructions must be visible").toContain(
      "start a new session here"
    );
  });

  it("a DIRECTORY at the snapshot path does not wedge cold restore", () => {
    rmSync(snapshotPath(dir), { force: true });
    mkdirSync(snapshotPath(dir), { recursive: true });
    expect(() => consumeSnapshot(dir)).not.toThrow();
    expect(consumeSnapshot(dir)).toEqual([]);
  });
});

describe("a restored screen renders as a SCREEN, not as colour codes", () => {
  it("keeps SGR so the session looks like itself", () => {
    // The founder's screenshot: `terminalSafeBlock` stripped the ESC byte and
    // left `[38;5;141m` as VISIBLE TEXT, so a restored Claude session was a
    // wall of escape parameters. Colour is the point of restoring a screen.
    const esc = String.fromCodePoint(0x1b);
    const captured = `${esc}[38;5;141mClaude Code${esc}[0m v2.1.226`;
    // STRIP REAL SGR BEFORE ASSERTING. `[38;5;141m` also appears INSIDE a
    // legitimate escape sequence, so a raw substring check matches the very
    // thing it is meant to allow — the same trap that once made a badge test
    // pass on an escape code.
    const csi = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;:]*m`, "g");
    const out = new FrozenPane(entry({ text: captured }))
      .render(120)
      .join("\n");
    expect(out, "the ESC-form colour code IS kept").toContain(
      `${String.fromCodePoint(0x1b)}[38;5;141m`
    );
    expect(
      out.replace(csi, ""),
      "but nothing survives as VISIBLE text"
    ).not.toContain("[38;5;141m");
    expect(out, "and the text itself survives").toContain("Claude Code");
    expect(out).toContain("v2.1.226");
  });

  it("drops every NON-SGR sequence WHOLE — nothing left behind as text", () => {
    const esc = String.fromCodePoint(0x1b);
    const bel = String.fromCodePoint(7);
    const hostile = `${esc}[?1049h${esc}[2J${esc}[5;5Hmoved${esc}]0;title${bel}ok`;
    const out = new FrozenPane(entry({ text: hostile })).render(120).join("\n");
    for (const leak of ["1049", "[2J", "5;5H", "0;title"]) {
      expect(out, `${leak} must not survive as text`).not.toContain(leak);
    }
    expect(out).toContain("moved");
    expect(out).toContain("ok");
  });

  it("still refuses the corpus after a real round-trip", () => {
    const csi = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "g");
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      captureSnapshot(dir, [entry({ label: payload.text, text: payload.text })]);
      const restored = consumeSnapshot(dir);
      const out = new FrozenPane(restored[0]!)
        .render(120)
        .join("\n")
        .replace(csi, "");
      expect(residualDanger(out, ["\n"]), payload.id).toEqual([]);
    }
  });
});
