import { describe, expect, it } from "vitest";
import {
  appendLiveAssistant,
  appendLiveStatus,
} from "../src/lib/live-chat.js";

describe("appendLiveAssistant", () => {
  it("starts a new assistant bubble when the log is empty", () => {
    expect(appendLiveAssistant([], "Hello")).toEqual([
      { role: "assistant", text: "Hello" },
    ]);
  });

  it("appends tokens onto the last assistant bubble", () => {
    const once = appendLiveAssistant([], "I");
    const twice = appendLiveAssistant(once, "'ll");
    const thrice = appendLiveAssistant(twice, " reconcile");
    expect(thrice).toEqual([{ role: "assistant", text: "I'll reconcile" }]);
  });

  it("preserves the boundary between whole provider messages", () => {
    const first = appendLiveAssistant([], "First update.", "message");
    expect(appendLiveAssistant(first, "Next update.", "message")).toEqual([
      {
        role: "assistant",
        text: "First update.\n\nNext update.",
      },
    ]);
  });

  it("starts a fresh bubble after a status line", () => {
    const withStatus = appendLiveStatus(
      appendLiveAssistant([], "first"),
      "tool ran"
    );
    expect(appendLiveAssistant(withStatus, "second")).toEqual([
      { role: "assistant", text: "first" },
      { role: "status", text: "tool ran" },
      { role: "assistant", text: "second" },
    ]);
  });

  it("ignores empty deltas", () => {
    const base = appendLiveAssistant([], "hi");
    expect(appendLiveAssistant(base, "")).toBe(base);
  });
});

describe("appendLiveStatus", () => {
  it("always pushes a new status entry", () => {
    expect(appendLiveStatus([], "a")).toEqual([{ role: "status", text: "a" }]);
    expect(appendLiveStatus([{ role: "status", text: "a" }], "b")).toEqual([
      { role: "status", text: "a" },
      { role: "status", text: "b" },
    ]);
  });
});
