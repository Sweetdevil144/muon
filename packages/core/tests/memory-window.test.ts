import { describe, expect, it } from "vitest";
import {
  appendMemoryWindow,
  createMemoryWindowStore,
  hashMiningOutput,
  renderMemoryWindow,
  truncateWindowMessage,
  MEMORY_WINDOW_MESSAGES,
  MEMORY_WINDOW_MESSAGE_CHARS,
  type MemoryWindowMessage,
} from "../src/memory-window.js";

const human = (text: string): MemoryWindowMessage => ({ role: "human", text });
const agent = (text: string): MemoryWindowMessage => ({ role: "agent", text });

describe("truncateWindowMessage", () => {
  it("clips to mem0's 300-char limit, HEAD for a human ask, TAIL for an agent reply", () => {
    const long = `START${"x".repeat(400)}END`;
    const askedFirst = truncateWindowMessage(human(long));
    const saidLast = truncateWindowMessage(agent(long));

    expect(askedFirst.text).toHaveLength(MEMORY_WINDOW_MESSAGE_CHARS);
    expect(saidLast.text).toHaveLength(MEMORY_WINDOW_MESSAGE_CHARS);
    // The ask is at the front of a human turn; the conclusion is at the end of
    // an agent turn — the same head/tail split MUON uses for args vs results.
    expect(askedFirst.text.startsWith("START")).toBe(true);
    expect(askedFirst.text.endsWith("...")).toBe(true);
    expect(saidLast.text.startsWith("...")).toBe(true);
    expect(saidLast.text.endsWith("END")).toBe(true);
  });

  it("collapses whitespace and leaves a short message untouched", () => {
    expect(truncateWindowMessage(human("  keep\n\n  the   RRF ranker ")).text).toBe(
      "keep the RRF ranker"
    );
  });
});

describe("appendMemoryWindow", () => {
  it("keeps only the last N messages", () => {
    let window: MemoryWindowMessage[] = [];
    for (let index = 0; index < MEMORY_WINDOW_MESSAGES + 5; index += 1) {
      window = appendMemoryWindow(window, human(`turn ${index}`));
    }
    expect(window).toHaveLength(MEMORY_WINDOW_MESSAGES);
    expect(window[0]!.text).toBe("turn 5");
    expect(window.at(-1)!.text).toBe(`turn ${MEMORY_WINDOW_MESSAGES + 4}`);
  });

  it("ignores an empty or whitespace-only turn rather than spending a slot on it", () => {
    const window = appendMemoryWindow(
      appendMemoryWindow([], human("real ask")),
      agent("   \n  ")
    );
    expect(window).toEqual([{ role: "human", text: "real ask" }]);
  });

  it("does not mutate the window it was given", () => {
    const original: MemoryWindowMessage[] = [human("first")];
    appendMemoryWindow(original, agent("second"));
    expect(original).toHaveLength(1);
  });
});

describe("renderMemoryWindow", () => {
  it("labels each turn and returns '' for an empty window", () => {
    expect(renderMemoryWindow([])).toBe("");
    expect(renderMemoryWindow([human("why RRF?"), agent("because fusion")])).toBe(
      "Human: why RRF?\nAgent: because fusion"
    );
  });

  it("bounds the WHOLE window, keeping the turns nearest the extraction", () => {
    const window = Array.from({ length: MEMORY_WINDOW_MESSAGES }, (_, index) =>
      agent(`${index}-${"y".repeat(400)}`)
    );
    const rendered = renderMemoryWindow(window, 500);
    expect(rendered.length).toBeLessThanOrEqual(500);
    // Tail-kept: the last turn survives, the first does not.
    expect(rendered.endsWith("y")).toBe(true);
    expect(rendered.startsWith("...")).toBe(true);
  });
});

describe("createMemoryWindowStore", () => {
  it("accumulates a session's turns and hands back a copy, not the store's array", () => {
    const store = createMemoryWindowStore();
    store.append("chat-1", human("add RRF"));
    store.append("chat-1", agent("done, see memory-ranking.ts"));

    const read = store.read("chat-1");
    expect(read.map((message) => message.role)).toEqual(["human", "agent"]);
    read.push(human("tampered"));
    expect(store.read("chat-1")).toHaveLength(2);
  });

  it("partitions by session key — one chat never sees another chat's turns", () => {
    const store = createMemoryWindowStore();
    store.append("chat-a", human("secret for a"));
    store.append("chat-b", human("secret for b"));

    expect(store.read("chat-a")).toEqual([{ role: "human", text: "secret for a" }]);
    expect(store.read("chat-b")).toEqual([{ role: "human", text: "secret for b" }]);
    expect(store.read("chat-unknown")).toEqual([]);
  });

  it("bounds the number of live sessions, evicting the least recently touched", () => {
    const store = createMemoryWindowStore({ maxSessions: 2 });
    store.append("chat-1", human("one"));
    store.append("chat-2", human("two"));
    // Touching chat-1 makes chat-2 the least recent, so chat-3 evicts chat-2.
    store.append("chat-1", agent("one again"));
    store.append("chat-3", human("three"));

    expect(store.size()).toBe(2);
    expect(store.read("chat-1")).toHaveLength(2);
    expect(store.read("chat-2")).toEqual([]);
    expect(store.read("chat-3")).toHaveLength(1);
  });

  // F6: the window exists only to be fed to a vendor model, so when the operator
  // withdraws consent for that (the mining kill switch) whatever is buffered has
  // to go with it — otherwise flipping the switch back on later resurrects text
  // held for an errand that was cancelled.
  it("clear() forgets ONE session's buffered turns and leaves every other session alone", () => {
    const store = createMemoryWindowStore();
    store.append("chat-a", human("captured while mining was on"));
    store.append("chat-b", human("a different session"));

    store.clear("chat-a");

    expect(store.read("chat-a")).toEqual([]);
    expect(store.read("chat-b")).toEqual([
      { role: "human", text: "a different session" },
    ]);
    // The key is genuinely gone, not merely emptied, so it no longer occupies
    // one of the bounded session slots.
    expect(store.size()).toBe(1);
    // Clearing an unknown session is a no-op, never a throw.
    expect(() => store.clear("chat-never-seen")).not.toThrow();
  });

  it("hashMiningOutput collapses whitespace and case before hashing", () => {
    const a = hashMiningOutput("  Keep RRF\n\nranking ");
    const b = hashMiningOutput("keep rrf ranking");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("markMinedContent + hasMinedContent dedupe per session; clear drops both window and hashes", () => {
    const store = createMemoryWindowStore();
    const hash = hashMiningOutput("same output twice");

    expect(store.hasMinedContent("chat-1", hash)).toBe(false);
    store.markMinedContent("chat-1", hash);
    expect(store.hasMinedContent("chat-1", hash)).toBe(true);
    expect(store.hasMinedContent("chat-2", hash)).toBe(false);

    store.append("chat-1", human("buffered"));
    store.clear("chat-1");
    expect(store.read("chat-1")).toEqual([]);
    expect(store.hasMinedContent("chat-1", hash)).toBe(false);
  });
});
