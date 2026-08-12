import { describe, expect, it } from "vitest";
import {
  acknowledgeRestoredHumanTerminal,
  mergeRestoredHumanTerminalTabs,
  restoredHumanTerminalTabs,
  type RestoredHumanTerminalTab,
} from "../src/renderer/lib/human-terminal-restore.js";
import type { HumanTerminalSnapshotEntry } from "../src/lib/human-terminal-snapshot.js";

// ROADMAP T1 step 3/4 — the frozen-until-ack gate, tested as a pure reducer
// so it needs no React/Electron: build the restored list, merge it into
// whatever the renderer already has, then confirm acknowledging one tab
// never leaks into another.

function entry(
  overrides: Partial<HumanTerminalSnapshotEntry> = {}
): HumanTerminalSnapshotEntry {
  return {
    sessionId: "terminal-chat:chat-1:shell.1",
    chatId: "chat-1",
    kind: "shell",
    ordinal: 1,
    label: "Shell",
    text: "captured scrollback\n",
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

describe("restoredHumanTerminalTabs", () => {
  it("builds a frozen tab for every entry", () => {
    const tabs = restoredHumanTerminalTabs([entry()]);
    expect(tabs).toEqual([
      {
        id: "terminal-chat:chat-1:shell.1",
        chatId: "chat-1",
        kind: "shell",
        ordinal: 1,
        label: "Shell",
        frozenScrollback: "captured scrollback\n",
      },
    ]);
  });

  it("returns an empty list for an empty snapshot", () => {
    expect(restoredHumanTerminalTabs([])).toEqual([]);
  });
});

describe("mergeRestoredHumanTerminalTabs", () => {
  it("appends restored tabs after the current list", () => {
    const current = [{ id: "a" }];
    const restored = [{ id: "b" }, { id: "c" }];
    expect(mergeRestoredHumanTerminalTabs(current, restored)).toEqual([
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ]);
  });

  it("never duplicates a tab id already present in the current list", () => {
    const current = [{ id: "a" }, { id: "b" }];
    const restored = [{ id: "b" }, { id: "c" }];
    expect(mergeRestoredHumanTerminalTabs(current, restored)).toEqual([
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ]);
  });

  it("is a no-op copy when there is nothing restored", () => {
    const current = [{ id: "a" }];
    expect(mergeRestoredHumanTerminalTabs(current, [])).toEqual(current);
  });
});

describe("acknowledgeRestoredHumanTerminal", () => {
  const tabs: RestoredHumanTerminalTab[] = [
    {
      id: "a",
      chatId: "chat-1",
      kind: "shell",
      ordinal: 1,
      label: "Shell",
      frozenScrollback: "a's scrollback",
    },
    {
      id: "b",
      chatId: "chat-1",
      kind: "codex",
      ordinal: 1,
      label: "Codex",
      frozenScrollback: "b's scrollback",
    },
  ];

  it("clears frozenScrollback on exactly the acknowledged tab", () => {
    const next = acknowledgeRestoredHumanTerminal(tabs, "a");
    expect(next[0]!.frozenScrollback).toBeUndefined();
    // Every other tab (here, "b") is byte-identical — acknowledging one tab
    // can never thaw another.
    expect(next[1]).toEqual(tabs[1]);
  });

  it("is a no-op for an id that is not frozen (already live, or unknown)", () => {
    const alreadyLive = [
      { id: "a", chatId: "chat-1", kind: "shell", ordinal: 1, label: "Shell" },
    ];
    expect(acknowledgeRestoredHumanTerminal(alreadyLive, "a")).toEqual(
      alreadyLive
    );
    expect(acknowledgeRestoredHumanTerminal(tabs, "unknown-id")).toEqual(
      tabs
    );
  });
});
