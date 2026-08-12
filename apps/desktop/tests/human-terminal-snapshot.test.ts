import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHumanTerminalSnapshotEntries,
  captureHumanTerminalSnapshot,
  consumeHumanTerminalSnapshot,
  HUMAN_TERMINAL_SNAPSHOT_VERSION,
  humanTerminalSnapshotPath,
  MAX_SNAPSHOT_ENTRIES,
  MAX_SNAPSHOT_FILE_BYTES,
  MAX_SNAPSHOT_TEXT_CHARS,
  parseHumanTerminalSnapshot,
  serializeHumanTerminalSnapshot,
  type HumanTerminalSnapshotEntry,
} from "../src/lib/human-terminal-snapshot.js";
import type { HumanTerminalScrollbackSnapshot } from "../src/lib/terminal-host.js";

// ROADMAP T1 — detachable human terminal tabs, the cold-restore half. These
// tests pin the two contracts a quit/relaunch pair actually depends on: the
// disk format round-trips (build → serialize → parse) and it fails CLOSED on
// anything malformed, never throwing into startup.

function session(
  sessionId: string,
  text = "hello\n"
): HumanTerminalScrollbackSnapshot {
  return { sessionId, text, cols: 80, rows: 24 };
}

describe("buildHumanTerminalSnapshotEntries", () => {
  it("recovers chat/kind/ordinal/label from a vendor-tab session id", () => {
    const entries = buildHumanTerminalSnapshotEntries([
      session("terminal-chat:chat-1:claude-code.2", "$ echo hi\nhi\n"),
    ]);
    expect(entries).toEqual([
      {
        sessionId: "terminal-chat:chat-1:claude-code.2",
        chatId: "chat-1",
        kind: "claude-code",
        ordinal: 2,
        label: "Claude 2",
        text: "$ echo hi\nhi\n",
        cols: 80,
        rows: 24,
      },
    ]);
  });

  it("drops the legacy plain-shell id (no tab slot to restore into)", () => {
    // `terminal-chat:<chatId>` (no `:<kind>.<ordinal>` slot) is a real human
    // session `terminal-host.ts` still snapshots — it just has no
    // `HumanTerminalTab` shape to restore as, so it is captured-then-killed
    // like every other human session but never handed back as a tab.
    const entries = buildHumanTerminalSnapshotEntries([
      session("terminal-chat:chat-1"),
      session("terminal-chat:chat-1:shell.1"),
    ]);
    expect(entries.map((entry) => entry.sessionId)).toEqual([
      "terminal-chat:chat-1:shell.1",
    ]);
  });

  it("bounds the entry count even when the source hands back more", () => {
    const sessions = Array.from({ length: MAX_SNAPSHOT_ENTRIES + 5 }, (_, i) =>
      session(`terminal-chat:chat-1:shell.${i + 1}`)
    );
    const entries = buildHumanTerminalSnapshotEntries(sessions);
    expect(entries).toHaveLength(MAX_SNAPSHOT_ENTRIES);
  });

  it("bounds an individual entry's text to the tail of an overlong scrollback", () => {
    const long = "x".repeat(MAX_SNAPSHOT_TEXT_CHARS + 100);
    const entries = buildHumanTerminalSnapshotEntries([
      session("terminal-chat:chat-1:shell.1", long),
    ]);
    expect(entries[0]!.text).toHaveLength(MAX_SNAPSHOT_TEXT_CHARS);
    expect(entries[0]!.text).toBe(long.slice(-MAX_SNAPSHOT_TEXT_CHARS));
  });
});

describe("serialize / parse round-trip", () => {
  const oneEntry: HumanTerminalSnapshotEntry = {
    sessionId: "terminal-chat:chat-1:codex.1",
    chatId: "chat-1",
    kind: "codex",
    ordinal: 1,
    label: "Codex",
    text: "welcome to codex\n",
    cols: 120,
    rows: 40,
  };

  it("parses exactly what was serialized", () => {
    const file = {
      version: HUMAN_TERMINAL_SNAPSHOT_VERSION,
      capturedAt: 1_700_000_000_000,
      entries: [oneEntry],
    };
    const raw = serializeHumanTerminalSnapshot(file);
    expect(parseHumanTerminalSnapshot(raw)).toEqual(file);
  });

  it("fails closed on invalid JSON, wrong version, and a non-array entries field", () => {
    expect(parseHumanTerminalSnapshot("not json")).toBeNull();
    expect(
      parseHumanTerminalSnapshot(
        JSON.stringify({ version: 999, capturedAt: 0, entries: [] })
      )
    ).toBeNull();
    expect(
      parseHumanTerminalSnapshot(
        JSON.stringify({
          version: HUMAN_TERMINAL_SNAPSHOT_VERSION,
          capturedAt: 0,
          entries: "nope",
        })
      )
    ).toBeNull();
  });

  it("drops a malformed entry rather than refusing the whole file", () => {
    const raw = JSON.stringify({
      version: HUMAN_TERMINAL_SNAPSHOT_VERSION,
      capturedAt: 0,
      entries: [oneEntry, { sessionId: "terminal-chat:chat-1:shell.1" }],
    });
    const parsed = parseHumanTerminalSnapshot(raw);
    expect(parsed?.entries).toEqual([oneEntry]);
  });

  it("re-bounds an entry's text on the read side too (defense against a hand-edited file)", () => {
    const long = "y".repeat(MAX_SNAPSHOT_TEXT_CHARS + 50);
    const raw = JSON.stringify({
      version: HUMAN_TERMINAL_SNAPSHOT_VERSION,
      capturedAt: 0,
      entries: [{ ...oneEntry, text: long }],
    });
    const parsed = parseHumanTerminalSnapshot(raw);
    expect(parsed?.entries[0]!.text).toHaveLength(MAX_SNAPSHOT_TEXT_CHARS);
  });

  it("drops entries whose metadata disagrees with their stable session id", () => {
    for (const changed of [
      { chatId: "another-chat" },
      { kind: "claude-code" },
      { ordinal: 2 },
      { label: "Forged label" },
      { cols: 1001 },
      { rows: 0 },
    ]) {
      const parsed = parseHumanTerminalSnapshot(
        JSON.stringify({
          version: HUMAN_TERMINAL_SNAPSHOT_VERSION,
          capturedAt: 0,
          entries: [{ ...oneEntry, ...changed }],
        })
      );
      expect(parsed?.entries).toEqual([]);
    }
  });
});

describe("captureHumanTerminalSnapshot / consumeHumanTerminalSnapshot (disk)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "muon-human-terminal-snapshot-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a private (0600) file and consume reads it back once", () => {
    captureHumanTerminalSnapshot(dir, [
      session("terminal-chat:chat-1:shell.1", "captured at quit\n"),
    ]);
    const filePath = humanTerminalSnapshotPath(dir);
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);

    const entries = consumeHumanTerminalSnapshot(dir);
    expect(entries).toEqual([
      expect.objectContaining({
        sessionId: "terminal-chat:chat-1:shell.1",
        text: "captured at quit\n",
      }),
    ]);

    // ONE-SHOT: the file is gone, and a second consume finds nothing.
    expect(() => readFileSync(filePath)).toThrow();
    expect(consumeHumanTerminalSnapshot(dir)).toEqual([]);
  });

  it("writes nothing (and clears any stale prior snapshot) when there are zero live human tabs", () => {
    captureHumanTerminalSnapshot(dir, [
      session("terminal-chat:chat-1:shell.1"),
    ]);
    captureHumanTerminalSnapshot(dir, []); // the NEXT quit had nothing open
    expect(consumeHumanTerminalSnapshot(dir)).toEqual([]);
  });

  it("never restores a dispatch/job worktree terminal — non-chat ids are excluded end to end", () => {
    captureHumanTerminalSnapshot(dir, [
      session("terminal-job-42", "a job's own worktree session\n"),
      session("terminal-chat:chat-1:shell.1", "a human tab\n"),
    ]);
    const entries = consumeHumanTerminalSnapshot(dir);
    expect(entries.map((entry) => entry.sessionId)).toEqual([
      "terminal-chat:chat-1:shell.1",
    ]);
  });

  it("consume never throws on a missing or corrupt file", () => {
    expect(consumeHumanTerminalSnapshot(dir)).toEqual([]);
    const filePath = humanTerminalSnapshotPath(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, "{ not valid json", { mode: 0o600 });
    expect(() => consumeHumanTerminalSnapshot(dir)).not.toThrow();
    expect(consumeHumanTerminalSnapshot(dir)).toEqual([]);
  });

  it("refuses and deletes an oversized snapshot before reading it into memory", () => {
    const filePath = humanTerminalSnapshotPath(dir);
    writeFileSync(filePath, "{}", { mode: 0o600 });
    truncateSync(filePath, MAX_SNAPSHOT_FILE_BYTES + 1);
    expect(consumeHumanTerminalSnapshot(dir)).toEqual([]);
    expect(() => statSync(filePath)).toThrow();
  });
});
