import { describe, expect, it } from "vitest";
import {
  gcParkedTerminalsAtBoot,
  PARKED_TERMINAL_MAX_AGE_MS,
  ParkedTerminalStore,
} from "../src/renderer/lib/parked-terminal-store.js";

/**
 * ROADMAP T4 — the PARKED-RUNTIME LRU's in-memory replay store. Pure and
 * DOM-free, so every eviction/GC edge is exercised without an XTerm, React,
 * or Electron in the loop.
 */
describe("ParkedTerminalStore", () => {
  it("park() records a snapshot retrievable by take()", () => {
    const store = new ParkedTerminalStore();
    store.park("s1", { serialized: "boot\n", cols: 80, rows: 24 });
    expect(store.has("s1")).toBe(true);
    const taken = store.take("s1");
    expect(taken).toMatchObject({ serialized: "boot\n", pending: "", cols: 80, rows: 24 });
  });

  it("take() is a ONE-SHOT read — the entry is gone afterward", () => {
    const store = new ParkedTerminalStore();
    store.park("s1", { serialized: "x", cols: 80, rows: 24 });
    expect(store.take("s1")).not.toBeNull();
    expect(store.take("s1")).toBeNull();
    expect(store.has("s1")).toBe(false);
  });

  it("take() on an unknown session returns null rather than throwing", () => {
    const store = new ParkedTerminalStore();
    expect(store.take("never-parked")).toBeNull();
  });

  it("appendPending accumulates bytes for a parked session, in order", () => {
    const store = new ParkedTerminalStore();
    store.park("s1", { serialized: "boot\n", cols: 80, rows: 24 });
    store.appendPending("s1", "line one\n");
    store.appendPending("s1", "line two\n");
    expect(store.take("s1")?.pending).toBe("line one\nline two\n");
  });

  it("appendPending on a session that was never parked is a harmless no-op", () => {
    const store = new ParkedTerminalStore();
    expect(() => store.appendPending("ghost", "data")).not.toThrow();
    expect(store.has("ghost")).toBe(false);
  });

  it("caps pending bytes, keeping only the MOST RECENT bytes past the bound", () => {
    const store = new ParkedTerminalStore({ maxPendingChars: 10 });
    store.park("s1", { serialized: "", cols: 80, rows: 24 });
    store.appendPending("s1", "0123456789"); // exactly at the cap
    store.appendPending("s1", "ABC"); // pushes it over
    // The tail is preserved (most recent output matters most for replay),
    // not the head.
    expect(store.take("s1")?.pending).toBe("3456789ABC");
  });

  it("evicts the OLDEST entry once the entry cap is exceeded", () => {
    const store = new ParkedTerminalStore({ maxEntries: 2 });
    store.park("s1", { serialized: "1", cols: 80, rows: 24 });
    store.park("s2", { serialized: "2", cols: 80, rows: 24 });
    store.park("s3", { serialized: "3", cols: 80, rows: 24 }); // evicts s1
    expect(store.has("s1")).toBe(false);
    expect(store.has("s2")).toBe(true);
    expect(store.has("s3")).toBe(true);
    expect(store.size()).toBe(2);
  });

  it("re-parking an id refreshes its LRU position instead of duplicating it", () => {
    const store = new ParkedTerminalStore({ maxEntries: 2 });
    store.park("s1", { serialized: "1", cols: 80, rows: 24 });
    store.park("s2", { serialized: "2", cols: 80, rows: 24 });
    store.park("s1", { serialized: "1b", cols: 80, rows: 24 }); // s1 is now MRU
    store.park("s3", { serialized: "3", cols: 80, rows: 24 }); // evicts s2, not s1
    expect(store.has("s1")).toBe(true);
    expect(store.has("s2")).toBe(false);
    expect(store.take("s1")?.serialized).toBe("1b");
  });

  it("gcStale drops entries older than the given age and reports how many", () => {
    let now = 1_000_000;
    const store = new ParkedTerminalStore({ now: () => now });
    store.park("old", { serialized: "1", cols: 80, rows: 24 });
    now += 10_000;
    store.park("fresh", { serialized: "2", cols: 80, rows: 24 });
    now += 5_000;
    const dropped = store.gcStale(8_000); // "old" is 15s stale, "fresh" is 5s
    expect(dropped).toBe(1);
    expect(store.has("old")).toBe(false);
    expect(store.has("fresh")).toBe(true);
  });

  it("gcParkedTerminalsAtBoot uses the documented age bound", () => {
    let now = 0;
    const store = new ParkedTerminalStore({ now: () => now });
    store.park("ancient", { serialized: "1", cols: 80, rows: 24 });
    now += PARKED_TERMINAL_MAX_AGE_MS + 1;
    const dropped = gcParkedTerminalsAtBoot(store);
    expect(dropped).toBe(1);
    expect(store.size()).toBe(0);
  });
});
