import { describe, expect, it } from "vitest";
import {
  PtyHost,
  type PtyExitEvent,
  type PtyFrame,
} from "../src/pty/pty-host.js";
import {
  FakePtyDriver,
  type PtyExit,
  type PtySpawnOptions,
} from "../src/pty/pty-driver.js";

function harness(options?: ConstructorParameters<typeof PtyHost>[1]) {
  let driver: FakePtyDriver | undefined;
  const factory = (opts: PtySpawnOptions) => {
    driver = new FakePtyDriver(opts);
    return driver;
  };
  const host = new PtyHost(factory, options);
  return {
    host,
    driver: () => {
      if (!driver) throw new Error("no driver spawned yet");
      return driver;
    },
  };
}

function collector() {
  const frames: PtyFrame[] = [];
  const exits: PtyExitEvent[] = [];
  return {
    frames,
    exits,
    consumer: {
      onData: (frame: PtyFrame) => frames.push(frame),
      onExit: (event: PtyExitEvent) => exits.push(event),
    },
  };
}

const spawn: PtySpawnOptions = { file: "claude", args: ["--repl"], cwd: "/ws" };

describe("PtyHost (Wave 4 slice 5.0)", () => {
  it("round-trips input, output, and resize through the driver", () => {
    const { host, driver } = harness();
    host.open("s1", spawn);
    const sink = collector();
    host.attach("s1", sink.consumer);

    host.write("s1", "ls\r");
    expect(driver().writes).toEqual(["ls\r"]);

    driver().emit("file-a\nfile-b\n");
    expect(sink.frames).toEqual([{ seq: 1, data: "file-a\nfile-b\n" }]);

    host.resize("s1", 120, 40);
    expect(driver().resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("delivers exit to the attached consumer", () => {
    const { host, driver } = harness();
    host.open("s1", spawn);
    const sink = collector();
    host.attach("s1", sink.consumer);

    driver().finish(0);
    expect(sink.exits).toMatchObject([{ exitCode: 0, signal: undefined }]);
  });

  it("replays scrollback to a reconnecting consumer, then streams live (session survives a UI reload)", () => {
    const { host, driver } = harness();
    host.open("s1", spawn);

    // Output arrives while attached, then the renderer 'reloads' (detach).
    const first = collector();
    host.attach("s1", first.consumer);
    driver().emit("boot\n");
    host.detach("s1");
    driver().emit("still-running\n"); // no consumer — retained in scrollback

    // A fresh consumer re-attaches and must re-materialize the whole session.
    const reconnected = collector();
    host.attach("s1", reconnected.consumer);
    expect(reconnected.frames.map((f) => f.data)).toEqual([
      "boot\n",
      "still-running\n",
    ]);

    // …and then keeps streaming live.
    driver().emit("more\n");
    expect(reconnected.frames.at(-1)).toEqual({ seq: 3, data: "more\n" });
  });

  it("re-materializes an already-exited session on reconnect", () => {
    const { host, driver } = harness();
    host.open("s1", spawn);
    driver().emit("done\n");
    driver().finish(0);

    const reconnected = collector();
    host.attach("s1", reconnected.consumer);
    expect(reconnected.frames.map((f) => f.data)).toEqual(["done\n"]);
    expect(reconnected.exits).toMatchObject([
      { exitCode: 0, signal: undefined },
    ]);
  });

  it("pauses the driver on backpressure and resumes when acks drain it", () => {
    const { host, driver } = harness({ highWaterMark: 10, lowWaterMark: 4 });
    host.open("s1", spawn);
    const sink = collector();
    host.attach("s1", sink.consumer);

    driver().emit("123456"); // 6 unacked
    expect(driver().paused).toBe(false);
    driver().emit("7890AB"); // 12 unacked > 10 → pause
    expect(driver().paused).toBe(true);

    // Ack the first frame (6 bytes) → 6 unacked, still > low(4) → stays paused.
    host.ack("s1", 1);
    expect(driver().paused).toBe(true);
    // Ack the second frame → 0 unacked ≤ low → resume.
    host.ack("s1", 2);
    expect(driver().paused).toBe(false);
  });

  it("applies backpressure even when detached (a slow/absent UI blocks the child, never buffers unbounded)", () => {
    const { host, driver } = harness({ highWaterMark: 8, lowWaterMark: 2 });
    host.open("s1", spawn);
    // No consumer attached at all.
    driver().emit("123456789"); // 9 > 8 → pause the child
    expect(driver().paused).toBe(true);
  });

  it("bounds the scrollback ring by total bytes", () => {
    const { host, driver } = harness({ scrollbackBytes: 10 });
    host.open("s1", spawn);
    driver().emit("aaaaa"); // 5
    driver().emit("bbbbb"); // 10
    driver().emit("ccccc"); // 15 → trims oldest to stay ≤ 10

    const reconnected = collector();
    host.attach("s1", reconnected.consumer);
    const replayed = reconnected.frames.map((f) => f.data).join("");
    expect(replayed).not.toContain("aaaaa"); // oldest dropped
    expect(replayed).toContain("ccccc"); // newest kept
  });

  it("counts scrollback and backpressure in real UTF-8 BYTES, not UTF-16 code units", () => {
    // "世" is 1 UTF-16 unit but 3 UTF-8 bytes — terminal TUIs are full of such
    // glyphs. Under the old String#length accounting a CJK/emoji flood would slip
    // past the byte caps. highWater 8: three "世" = 9 bytes > 8 → must pause;
    // String#length would see 3 and never pause.
    const { host, driver } = harness({
      highWaterMark: 8,
      lowWaterMark: 2,
      scrollbackBytes: 8,
    });
    host.open("s1", spawn);
    const sink = collector();
    host.attach("s1", sink.consumer);

    driver().emit("世世世"); // 9 bytes
    expect(driver().paused).toBe(true); // byte-counted backpressure fired

    // And the scrollback ring trimmed by bytes: a fresh consumer must not replay
    // more than the byte budget's worth (the single 9-byte frame is the only one,
    // kept because the ring always retains at least the newest frame).
    const reconnected = collector();
    host.attach("s1", reconnected.consumer);
    const replayedBytes = reconnected.frames
      .map((f) => Buffer.byteLength(f.data, "utf8"))
      .reduce((a, b) => a + b, 0);
    // One more multibyte frame → the oldest is dropped to respect the byte cap.
    host.ack("s1", 1); // drain so it isn't paused for the next emit
    driver().emit("界"); // 3 bytes
    const after = collector();
    host.attach("s1", after.consumer);
    const afterBytes = after.frames
      .map((f) => Buffer.byteLength(f.data, "utf8"))
      .reduce((a, b) => a + b, 0);
    expect(replayedBytes).toBe(9);
    expect(afterBytes).toBeLessThanOrEqual(8); // trimmed by BYTES, newest kept
    expect(after.frames.at(-1)?.data).toBe("界");
  });

  it("clamps an out-of-range ack (no spin, no pinned backpressure — DoS guard)", () => {
    const { host, driver } = harness({ highWaterMark: 4, lowWaterMark: 1 });
    host.open("s1", spawn);
    host.attach("s1", collector().consumer);
    driver().emit("12345"); // seq 1, 5 bytes > 4 → pause
    expect(driver().paused).toBe(true);

    // A hostile renderer acks a wildly out-of-range seq: must drain only what was
    // actually sent (seq 1), resume, and NOT pin ackedSeq to the bogus value.
    host.ack("s1", 20_000_000);
    expect(driver().paused).toBe(false);

    // A later real frame + ack still works → ackedSeq was clamped, not pinned.
    driver().emit("67890"); // seq 2 → pause
    expect(driver().paused).toBe(true);
    host.ack("s1", 2);
    expect(driver().paused).toBe(false);
  });

  it("ignores a non-integer ack", () => {
    const { host, driver } = harness();
    host.open("s1", spawn);
    host.attach("s1", collector().consumer);
    driver().emit("x");
    expect(() => host.ack("s1", Number.NaN)).not.toThrow();
    expect(() => host.ack("s1", 1.5)).not.toThrow();
  });

  it("detach is IDENTITY-scoped: a stale consumer never nulls the reconnected one", () => {
    const { host, driver } = harness();
    host.open("s1", spawn);
    const first = collector();
    host.attach("s1", first.consumer);
    // Reconnect: a new consumer replaces the first.
    const second = collector();
    host.attach("s1", second.consumer);
    // The OLD port's close fires LATE — detaching the FIRST consumer must not
    // null the second (the reconnect race).
    host.detach("s1", first.consumer);
    driver().emit("live\n");
    expect(second.frames.at(-1)?.data).toBe("live\n");
  });

  it("reaps a session on detach once it has exited (no registry/scrollback leak)", () => {
    const { host, driver } = harness();
    host.open("s1", spawn);
    const sink = collector();
    host.attach("s1", sink.consumer);
    driver().finish(0);
    expect(host.has("s1")).toBe(true); // retained for a possible reconnect
    host.detach("s1", sink.consumer); // UI gone AND exited → reap
    expect(host.has("s1")).toBe(false);
  });

  it("kills and de-registers a session on close (never orphaned)", () => {
    const { host, driver } = harness();
    host.open("s1", spawn);
    expect(host.has("s1")).toBe(true);
    host.close("s1", "SIGTERM");
    expect(driver().killed).toBe("SIGTERM");
    expect(host.has("s1")).toBe(false);
  });

  it("rejects a duplicate session id", () => {
    const { host } = harness();
    host.open("s1", spawn);
    expect(() => host.open("s1", spawn)).toThrow(/already exists/);
  });

  /**
   * ROADMAP T1 — the read-only export a desktop quit snapshots BEFORE it
   * kills every pty (`apps/desktop/src/lib/terminal-host.ts`'s
   * `snapshotHumanSessions`). Pinned here as a pure read: it must join the
   * FULL retained scrollback (not just the newest frame) and report the
   * session's current geometry, and it must never attach/detach a consumer
   * or otherwise mutate the session it reads.
   */
  it("exportScrollback joins the retained scrollback and reports current geometry", () => {
    const { host, driver } = harness();
    host.open("s1", spawn);
    driver().emit("first\n");
    driver().emit("second\n");
    host.resize("s1", 120, 40);

    expect(host.exportScrollback("s1")).toEqual({
      text: "first\nsecond\n",
      cols: 120,
      rows: 40,
    });
    // A read, not a mutation: nothing about the session changed.
    expect(host.has("s1")).toBe(true);
  });

  it("exportScrollback answers null for an unknown session id", () => {
    const { host } = harness();
    expect(host.exportScrollback("no-such-session")).toBeNull();
  });
});

/**
 * T1 — THE SESSION COUNT IS BOUNDED, and this host is where it has to hold.
 *
 * A session is a child process plus a scrollback ring. This class runs inside
 * Electron main for MUON's human terminals (ADR-0023 §5), driven by session
 * ids an untrusted renderer names, so an unbounded registry is an unbounded
 * process count in the operator's own process. The desktop door refuses first
 * with a sentence a human can read; this is the backstop that holds for every
 * other caller and for any future path that reaches `open` directly.
 *
 * MUTATION CHECK: deleting the `this.sessions.size >= this.maxSessions` guard
 * fails "refuses past the bound"; changing the constructor's validation to a
 * bare `?? DEFAULT_MAX_SESSIONS` fails "a nonsense bound falls back".
 */
describe("PtyHost session bound", () => {
  const factory = (options: PtySpawnOptions) => new FakePtyDriver(options);

  it("refuses past the bound, and creates no driver for the refused open", () => {
    let spawned = 0;
    const host = new PtyHost((options) => {
      spawned += 1;
      return new FakePtyDriver(options);
    }, { maxSessions: 3 });
    for (const id of ["s1", "s2", "s3"]) {
      host.open(id, spawn);
    }
    expect(() => host.open("s4", spawn)).toThrow(/session limit reached/);
    // The refusal happens BEFORE the factory: a refused open must never leave
    // a child the registry does not know about.
    expect(spawned).toBe(3);
    expect(host.list()).toHaveLength(3);
  });

  it("frees a slot on close, so the bound is on LIVE sessions", () => {
    const host = new PtyHost(factory, { maxSessions: 2 });
    host.open("s1", spawn);
    host.open("s2", spawn);
    expect(() => host.open("s3", spawn)).toThrow(/session limit reached/);
    host.close("s1");
    expect(() => host.open("s3", spawn)).not.toThrow();
    expect(host.list().sort()).toEqual(["s2", "s3"]);
  });

  it("bounds a caller that states nothing at all", () => {
    // A DEFAULT, not an opt-in: this is the whole point. 64 is the documented
    // default; opening one past it must refuse.
    const host = new PtyHost(factory);
    for (let index = 0; index < 64; index += 1) {
      host.open(`s${index}`, spawn);
    }
    expect(() => host.open("one-too-many", spawn)).toThrow(
      /session limit reached/
    );
  });

  it("falls back to the default for a nonsense bound, never to 'no bound'", () => {
    for (const nonsense of [0, -1, 1.5, Number.NaN]) {
      const host = new PtyHost(factory, { maxSessions: nonsense });
      // 0 / negative / fractional must not mean "refuse everything" or
      // "unbounded" — the first open succeeds, and the default still applies.
      expect(() => host.open("s1", spawn)).not.toThrow();
      expect(host.list()).toEqual(["s1"]);
    }
  });
});

/**
 * WHEN a child died is a fact about the child, not about who was watching.
 *
 * The desktop classifies "this never became a session, it failed to launch"
 * from the exit, and it used to date the exit from the moment a consumer
 * received the frame — which, for a pane the human had switched away from, is
 * whenever they come back. A `cursor-agent` that died 300ms after launch then
 * read as a minute-long session: the tab auto-closed over the evidence and the
 * launch-failure guard was never armed at all.
 */
describe("PtyHost exit stamping", () => {
  it("measures the lifetime from the spawn to the OS exit, however late it is observed", () => {
    let now = 1_000;
    const { host, driver } = harness({ now: () => now });
    host.open("s1", spawn);

    // The pane unmounts immediately (no consumer), the child dies 300ms in.
    now = 1_300;
    driver().finish(1);

    // The human comes back a minute later.
    now = 61_000;
    const late = collector();
    host.attach("s1", late.consumer);
    expect(late.exits).toEqual([
      { exitCode: 1, signal: undefined, exitedAt: 1_300, lifetimeMs: 300 },
    ]);
  });

  it("reports the exit ONCE, at the exit, whether or not anyone is attached", () => {
    let now = 0;
    const seen: Array<{ sessionId: string; exit: PtyExitEvent }> = [];
    const { host, driver } = harness({
      now: () => now,
      onSessionExit: (sessionId, exit) => seen.push({ sessionId, exit }),
    });
    host.open("s1", spawn);
    now = 250;
    driver().finish(0); // nothing attached — the founder's tab-switch case

    expect(seen).toHaveLength(1);
    expect(seen[0]?.sessionId).toBe("s1");
    expect(seen[0]?.exit.lifetimeMs).toBe(250);

    // A replay to a later consumer is NOT a second death.
    now = 90_000;
    host.attach("s1", collector().consumer);
    expect(seen).toHaveLength(1);
  });

  it("never re-stamps when a driver reports the exit twice", () => {
    let now = 0;
    const seen: PtyExitEvent[] = [];
    const { host, driver } = harness({
      now: () => now,
      onSessionExit: (_sessionId, exit) => seen.push(exit),
    });
    host.open("s1", spawn);
    now = 100;
    driver().finish(0);
    now = 50_000;
    driver().finish(0);
    expect(seen.map((exit) => exit.lifetimeMs)).toEqual([100]);
  });

  it("does NOT reap a session that exited with nobody attached", () => {
    // Deliberate, and the counterpart to the `detach` reap above: the exit and
    // the scrollback that explains it are the only evidence a human who
    // stepped away has, and dropping the record here would let the next open
    // of this id spawn a second process under the first one's identity. The
    // registry entry is released by the human's next move — the desktop host
    // reaps it when it refuses the remount, and `close` reaps it outright.
    const { host, driver } = harness();
    host.open("s1", spawn);
    driver().emit("claude: command not found\n");
    driver().finish(127);
    expect(host.has("s1")).toBe(true);

    const late = collector();
    host.attach("s1", late.consumer);
    expect(late.frames.map((frame) => frame.data)).toEqual([
      "claude: command not found\n",
    ]);
    host.close("s1");
    expect(host.has("s1")).toBe(false);
  });

  it("never mints a negative lifetime from a clock that stepped backwards", () => {
    let now = 5_000;
    const { host, driver } = harness({ now: () => now });
    host.open("s1", spawn);
    now = 1_000; // NTP correction mid-session
    driver().finish(1);
    const sink = collector();
    host.attach("s1", sink.consumer);
    expect(sink.exits[0]?.lifetimeMs).toBe(0);
  });
});
