import { beforeEach, describe, expect, it } from "vitest";
import { JobTerminalStore } from "../src/lib/job-terminal-store.js";

function frames(from: number, count: number, data = "x") {
  return Array.from({ length: count }, (_, index) => ({
    seq: from + index,
    data,
  }));
}

describe("JobTerminalStore", () => {
  let store: JobTerminalStore;
  beforeEach(() => {
    store = new JobTerminalStore();
  });

  it("returns null for a job it holds no console for", () => {
    expect(store.read("nope", 0, 100)).toBeNull();
  });

  it("serves frames after a cursor, oldest first", () => {
    store.append("job-1", "pty:job:job-1", [
      { seq: 1, data: "a" },
      { seq: 2, data: "b" },
      { seq: 3, data: "c" },
    ]);
    const read = store.read("job-1", 1, 100);
    expect(read?.frames.map((f) => f.data)).toEqual(["b", "c"]);
    expect(read?.lastSeq).toBe(3);
    expect(read?.firstSeq).toBe(1);
  });

  it("honours the read limit without losing the cursor", () => {
    store.append("job-1", "pty:job:job-1", frames(1, 10));
    const page = store.read("job-1", 0, 4);
    expect(page?.frames).toHaveLength(4);
    expect(page?.frames.at(-1)?.seq).toBe(4);
    expect(page?.lastSeq).toBe(10);
  });

  it("ignores a replayed seq so a runner retry never duplicates output", () => {
    store.append("job-1", "pty:job:job-1", [{ seq: 1, data: "a" }]);
    store.append("job-1", "pty:job:job-1", [
      { seq: 1, data: "a" },
      { seq: 2, data: "b" },
    ]);
    expect(store.read("job-1", 0, 100)?.frames.map((f) => f.data)).toEqual([
      "a",
      "b",
    ]);
  });

  it("resets the ring when a DIFFERENT session publishes for the same job", () => {
    store.append("job-1", "pty:job:job-1", [{ seq: 1, data: "old attempt" }]);
    store.append("job-1", "pty:job:job-1-b", [{ seq: 1, data: "new attempt" }]);
    const read = store.read("job-1", 0, 100);
    expect(read?.sessionId).toBe("pty:job:job-1-b");
    expect(read?.frames.map((f) => f.data)).toEqual(["new attempt"]);
  });

  it("bounds a session by bytes, dropping the oldest and reporting firstSeq", () => {
    // 5,000 frames of 100 bytes = ~500 KiB, twice the 256 KiB cap.
    store.append("job-1", "pty:job:job-1", frames(1, 5_000, "y".repeat(100)));
    const read = store.read("job-1", 0, 10_000);
    expect(read?.lastSeq).toBe(5_000);
    // The oldest bytes are gone, and `firstSeq` is how a viewer learns that
    // rather than seeing a silently discontinuous terminal.
    expect(read!.firstSeq).toBeGreaterThan(1);
    const retained = read!.frames.reduce(
      (total, frame) => total + Buffer.byteLength(frame.data, "utf8"),
      0
    );
    expect(retained).toBeLessThanOrEqual(256 * 1024 + 100);
  });

  it("bounds a session by frame count even when every frame is tiny", () => {
    store.append("job-1", "pty:job:job-1", frames(1, 6_000, "z"));
    const read = store.read("job-1", 0, 10_000);
    expect(read!.frames.length).toBeLessThanOrEqual(4_000);
    expect(read?.lastSeq).toBe(6_000);
  });

  it("evicts the least-recently-written job past the session cap", () => {
    for (let index = 0; index < 70; index += 1) {
      store.append(`job-${index}`, `pty:job:job-${index}`, [
        { seq: 1, data: "x" },
      ]);
    }
    expect(store.size).toBeLessThanOrEqual(64);
    expect(store.read("job-0", 0, 10)).toBeNull();
    expect(store.read("job-69", 0, 10)).not.toBeNull();
  });

  it("carries the runner's cumulative drop count, monotonically", () => {
    store.append("job-1", "pty:job:job-1", [{ seq: 1, data: "a" }], 0);
    expect(store.read("job-1", 0, 10)?.dropped).toBe(0);
    store.append("job-1", "pty:job:job-1", [{ seq: 2, data: "b" }], 7);
    expect(store.read("job-1", 0, 10)?.dropped).toBe(7);
    // A retried publish must not walk the count backwards.
    store.append("job-1", "pty:job:job-1", [{ seq: 3, data: "c" }], 2);
    expect(store.read("job-1", 0, 10)?.dropped).toBe(7);
    // A new execution starts its own count.
    store.append("job-1", "pty:job:job-1-b", [{ seq: 1, data: "d" }], 0);
    expect(store.read("job-1", 0, 10)?.dropped).toBe(0);
  });

  it("clear() forgets one job's console", () => {
    store.append("job-1", "pty:job:job-1", [{ seq: 1, data: "a" }]);
    store.clear("job-1");
    expect(store.read("job-1", 0, 10)).toBeNull();
  });

  it("offers no method that could send anything toward a job", () => {
    const surface = Object.getOwnPropertyNames(
      Object.getPrototypeOf(store)
    );
    for (const forbidden of ["write", "send", "input"]) {
      expect(surface).not.toContain(forbidden);
    }
  });
});
