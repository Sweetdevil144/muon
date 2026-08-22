import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── A slow boot is not a failed boot ─────────────────────────────────────────
//
// Live-observed 2026-08-17: the supervisor's 15s spawn window elapsed while
// the brain was still running migrations + graph work; `start()` returned
// null, main launched TOKENLESS against its settings default, and every
// request 401'd forever — auth failure never triggers the lockfile rebase
// (only connection-refused does) — while the brain became healthy seconds
// later with both lockfile tokens verifying fine from outside. The fix: after
// the window, keep watching the SAME child and hand its coords to `onChange`
// (the applyBrainCoords path a restart already uses) the moment its lockfile
// passes the probe.

const spawnMock = vi.hoisted(() => vi.fn());
const readLockfileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});
vi.mock("@muon/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/client")>();
  return { ...actual, readLockfile: readLockfileMock };
});

import { BrainSupervisor } from "../src/lib/brain.js";

function fakeChild(): EventEmitter & {
  pid: number;
  kill: () => void;
  stdout: EventEmitter & { pipe: () => void };
  stderr: EventEmitter & { pipe: () => void };
} {
  const child = new EventEmitter() as ReturnType<typeof fakeChild>;
  child.pid = 4242;
  child.kill = vi.fn();
  const stream = () => {
    const s = new EventEmitter() as EventEmitter & { pipe: () => void };
    s.pipe = vi.fn();
    return s;
  };
  child.stdout = stream();
  child.stderr = stream();
  return child;
}

const LOCK = { pid: 4242, port: 10777, token: "op-tok", agentToken: "ag-tok" };

let fetchSpy: ReturnType<typeof vi.spyOn>;
let healthy = false;

/** The child `spawn` handed back on the nth call. */
function spawnedChild(nth: number): ReturnType<typeof fakeChild> {
  return spawnMock.mock.results[nth]?.value as ReturnType<typeof fakeChild>;
}

/** The env a spawn was given (3rd arg is the options object). */
function spawnEnv(nth: number): NodeJS.ProcessEnv {
  return (spawnMock.mock.calls[nth]?.[2] as { env: NodeJS.ProcessEnv }).env;
}

beforeEach(() => {
  vi.useFakeTimers();
  healthy = false;
  // A DISTINCT child per spawn: the supervisor's guards are all identity
  // comparisons against `this.child`, so a shared instance would make a
  // superseded watch look current.
  spawnMock.mockImplementation(() => fakeChild());
  // Phase 1 (the 15s window): no lockfile at all — the brain is mid-boot.
  readLockfileMock.mockReturnValue(null);
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      healthy
        ? ({ ok: true } as Response)
        : Promise.reject(new Error("ECONNREFUSED"))
    );
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("BrainSupervisor late readiness", () => {
  it("hands late coords to onChange after the 15s window instead of stranding main tokenless", async () => {
    const onChange = vi.fn();
    const supervisor = new BrainSupervisor({
      dataDir: "/tmp/muon-late-ready-test",
      onChange,
    });

    const startPromise = supervisor.start();
    // Burn the 15s spawn window (poll cadence is 250ms).
    await vi.advanceTimersByTimeAsync(15_500);
    const coords = await startPromise;
    expect(coords).toBeNull(); // the honest "not ready yet" answer stands

    // Phase 2: the brain finishes booting late — lockfile lands, health passes.
    readLockfileMock.mockReturnValue(LOCK);
    healthy = true;
    await vi.advanceTimersByTimeAsync(4_100); // late watcher polls every 2s

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      base: `http://127.0.0.1:${LOCK.port}`,
      token: "op-tok",
      agentToken: "ag-tok",
    });

    supervisor.stop();
  });

  it("the late watcher stands down on stop() without firing", async () => {
    const onChange = vi.fn();
    const onStatus = vi.fn();
    const supervisor = new BrainSupervisor({
      dataDir: "/tmp/muon-late-ready-test",
      onChange,
      onStatus,
    });
    const startPromise = supervisor.start();
    await vi.advanceTimersByTimeAsync(15_500);
    await startPromise;

    supervisor.stop();
    readLockfileMock.mockReturnValue(LOCK);
    healthy = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChange).not.toHaveBeenCalled();
    // And SILENTLY: the human asked to quit. "The brain never became ready"
    // would be a true sentence and a useless one on the way out.
    expect(onStatus).not.toHaveBeenCalled();
  });
});

// ── H3: the guard has to hold on BOTH sides of the probe ─────────────────────
//
// The tick checked `stopped || child changed` BEFORE awaiting a ≤1s /health
// probe and never after. Anything that happened inside that window — a quit, a
// child crash — still delivered onChange, and onChange is applyBrainCoords,
// which restarts the runner: it SIGTERMs every live vendor session. So the two
// interleavings below are not hypothetical races, they are session kills.

describe("a coordinate handover survives nothing that happens mid-probe", () => {
  /** Arm the late-readiness watch, then hold its /health probe open. */
  async function armWithPendingProbe(supervisor: BrainSupervisor): Promise<{
    release: () => void;
  }> {
    const startPromise = supervisor.start();
    await vi.advanceTimersByTimeAsync(15_500);
    expect(await startPromise).toBeNull();

    // A healthy lockfile is now on disk, so the next tick reaches the probe.
    readLockfileMock.mockReturnValue(LOCK);
    let release = (): void => undefined;
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve({ ok: true } as Response);
        })
    );
    await vi.advanceTimersByTimeAsync(2_100); // tick fires; probe hangs
    return { release: () => release() };
  }

  it("stop() inside the probe window means no handover", async () => {
    const onChange = vi.fn();
    const supervisor = new BrainSupervisor({
      dataDir: "/tmp/muon-late-ready-test",
      onChange,
    });
    const { release } = await armWithPendingProbe(supervisor);

    supervisor.stop();
    release();
    await vi.advanceTimersByTimeAsync(10);

    expect(onChange, "dead coords must never reach applyBrainCoords").not
      .toHaveBeenCalled();
  });

  it("a child that dies inside the probe window means no handover", async () => {
    const onChange = vi.fn();
    const supervisor = new BrainSupervisor({
      dataDir: "/tmp/muon-late-ready-test",
      onChange,
    });
    const { release } = await armWithPendingProbe(supervisor);

    // The lockfile still reads healthy — it outlives its process — so only the
    // post-await identity check can catch this.
    spawnedChild(0).emit("exit", 1, null);
    release();
    await vi.advanceTimersByTimeAsync(10);

    expect(onChange).not.toHaveBeenCalled();
    supervisor.stop();
  });
});

// ── H4: liveness, not a stopwatch ────────────────────────────────────────────

describe("the late watcher is bounded by the child, not by the clock", () => {
  it("keeps watching well past the old 10-minute bound while the child lives", async () => {
    const onChange = vi.fn();
    const supervisor = new BrainSupervisor({
      dataDir: "/tmp/muon-late-ready-test",
      onChange,
    });
    const startPromise = supervisor.start();
    await vi.advanceTimersByTimeAsync(15_500);
    await startPromise;

    // The former bound cleared the watch here, in silence, with no second
    // recovery path: the client's rebase runs only on a CONNECTION failure and
    // /health is unauthenticated, so the desktop stayed 401 for the whole run.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(onChange).not.toHaveBeenCalled();

    readLockfileMock.mockReturnValue(LOCK);
    healthy = true;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(onChange).toHaveBeenCalledTimes(1);

    supervisor.stop();
  });

  it("stands down — out loud, on both channels — when the child exits first", async () => {
    const logs: string[] = [];
    const onStatus = vi.fn();
    const supervisor = new BrainSupervisor({
      dataDir: "/tmp/muon-late-ready-test",
      onChange: vi.fn(),
      onStatus,
      onLog: (line) => logs.push(line),
    });
    const startPromise = supervisor.start();
    await vi.advanceTimersByTimeAsync(15_500);
    await startPromise;

    spawnedChild(0).emit("exit", 1, null);

    expect(onStatus).toHaveBeenCalledWith({
      state: "unavailable",
      detail: expect.stringContaining("exited before it became ready"),
    });
    expect(
      logs.some((line) => line.includes("exited before it became ready")),
      "a stand-down that logs nothing is how this went unnoticed"
    ).toBe(true);

    supervisor.stop();
  });
});

// ── A brain that is ALIVE but never HEALTHY has to say so ────────────────────
//
// `standDownLateReady` is reachable only from the child's `exit`, so a child that
// starts and never becomes healthy (a wedged migration, a lockfile naming another
// pid) polled every 2s forever with no log and no `onStatus`. The renderer showed
// the poll's own "fetch failed" — the same thing it shows for a brain that is
// never coming — so nothing on the machine distinguished "still booting" from
// "dead". The elapsed time is the whole distinction.

describe("a still-booting brain reports itself through onStatus", () => {
  it("says so periodically, with the elapsed time, and stops once it is ready", async () => {
    const logs: string[] = [];
    const onChange = vi.fn();
    const onStatus = vi.fn();
    const supervisor = new BrainSupervisor({
      dataDir: "/tmp/muon-late-ready-test",
      onChange,
      onStatus,
      onLog: (line) => logs.push(line),
    });
    const startPromise = supervisor.start();
    await vi.advanceTimersByTimeAsync(15_500);
    expect(await startPromise).toBeNull();
    // Nothing yet: the window closing is already logged, and the watch has not
    // ticked. No lockfile at all — the child is up and mid-boot.
    expect(onStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_100); // first watch tick
    expect(onStatus).toHaveBeenCalledTimes(1);
    const first = onStatus.mock.calls[0]?.[0] as {
      state: string;
      detail: string;
      elapsedMs: number;
    };
    expect(first.state).toBe("booting");
    expect(first.detail).toMatch(/still starting/i);
    // Measured from the SPAWN, so it already covers the 15s window a human just
    // spent looking at nothing.
    expect(first.elapsedMs).toBeGreaterThanOrEqual(15_000);
    expect(
      logs.some((line) => /still starting after \d+s/.test(line)),
      "the same fact belongs in brain.log, not only in the UI"
    ).toBe(true);

    // PACED, not per-tick: the watch polls every 2s and rebuilding the tray menu
    // thirty times a minute is not a status.
    await vi.advanceTimersByTimeAsync(2_100);
    expect(onStatus).toHaveBeenCalledTimes(1);

    // But a human waiting on a graph build is told again, with a bigger number.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onStatus.mock.calls.length).toBeGreaterThan(1);
    const later = onStatus.mock.calls.at(-1)?.[0] as { elapsedMs: number };
    expect(later.elapsedMs).toBeGreaterThan(first.elapsedMs);

    // And it STOPS being said the moment the brain is actually there.
    readLockfileMock.mockReturnValue(LOCK);
    healthy = true;
    const saidBefore = onStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStatus.mock.calls.length).toBe(saidBefore);

    supervisor.stop();
  });

  it("reports a lockfile that names somebody else's pid as booting, not as ready", async () => {
    const onChange = vi.fn();
    const onStatus = vi.fn();
    const supervisor = new BrainSupervisor({
      dataDir: "/tmp/muon-late-ready-test",
      onChange,
      onStatus,
    });
    const startPromise = supervisor.start();
    await vi.advanceTimersByTimeAsync(15_500);
    await startPromise;

    // A stale lockfile from an earlier brain, and /health answering on it: the
    // coordinates are NOT ours, so they must never be handed over — and the
    // silence around that was indistinguishable from a dead brain.
    readLockfileMock.mockReturnValue({ ...LOCK, pid: LOCK.pid + 1 });
    healthy = true;
    await vi.advanceTimersByTimeAsync(2_100);

    expect(onChange).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "booting" })
    );

    supervisor.stop();
  });
});

// ── A restart that throws must not exit the main process ─────────────────────
//
// `void this.maybeRestart()` was the one voided async call in this file with no
// `.catch()`. It awaits a full respawn and then fires `onChange` — which in main
// is `applyBrainCoords`, and that persists settings SYNCHRONOUSLY
// (`writeFileSync` + `chmodSync`). So a brain crash plus an unwritable
// settings.json (ENOSPC, a root-owned settings.json) was an unhandled rejection,
// and this app installs no `unhandledRejection` handler: main exits, taking the
// window and every runner-hosted vendor session with it.

describe("a crash restart cannot take the app down with it", () => {
  it("reports an onChange that throws instead of raising an unhandled rejection", async () => {
    const logs: string[] = [];
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const supervisor = new BrainSupervisor({
        dataDir: "/tmp/muon-late-ready-test",
        // Exactly what main does on this callback, at its failure: the settings
        // persist is synchronous, so it throws back into the restart path.
        onChange: () => {
          throw new Error("EROFS: read-only file system, open 'settings.json'");
        },
        onLog: (line) => logs.push(line),
      });
      const startPromise = supervisor.start();
      await vi.advanceTimersByTimeAsync(15_500);
      await startPromise;

      // The brain crashes; the supervisor backs off and respawns, and THIS child
      // comes up inside its window — so the restart hands coordinates over.
      spawnedChild(0).emit("exit", 1, null);
      readLockfileMock.mockReturnValue(LOCK);
      healthy = true;
      await vi.advanceTimersByTimeAsync(1_500); // 1s backoff + the first poll
      expect(spawnMock).toHaveBeenCalledTimes(2);

      expect(
        logs.some((line) => line.includes("brain restart failed")),
        "a failed handover has to be reported — but never by dying"
      ).toBe(true);
      expect(logs.join("\n")).toContain("read-only file system");
      expect(unhandled).not.toHaveBeenCalled();

      supervisor.stop();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

// ── H2: the graph-recovery request is a LATCH, and late readiness has to
//    release it ───────────────────────────────────────────────────────────────
//
// MUON_GRAPH_FORCE_RECOVER quarantines and rebuilds unconditionally, and that
// rebuild is itself what makes boot exceed the 15s window. Clearing the flag
// only on the IN-WINDOW success branch therefore re-armed it after every forced
// rebuild: a permanent per-launch quarantine loop.

describe("a late-ready brain releases the graph-recovery request", () => {
  it("does not re-force the rebuild on the next restart", async () => {
    const onChange = vi.fn();
    const supervisor = new BrainSupervisor({
      dataDir: "/tmp/muon-late-ready-test",
      onChange,
    });
    const startPromise = supervisor.start();
    await vi.advanceTimersByTimeAsync(15_500);
    await startPromise;

    // A SIGNAL exit is the native-fault signature: recovery is requested, and
    // the restart carries the flag.
    spawnedChild(0).emit("exit", null, "SIGSEGV");
    await vi.advanceTimersByTimeAsync(1_100); // restart backoff
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnEnv(1).MUON_GRAPH_FORCE_RECOVER).toBe("1");

    // The rebuild is exactly what pushes this boot past 15s — so it lands LATE.
    await vi.advanceTimersByTimeAsync(15_500);
    readLockfileMock.mockReturnValue(LOCK);
    healthy = true;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(onChange).toHaveBeenCalledTimes(1);

    // A later CLEAN exit must restart a normal brain. Before the fix the latch
    // was still set here and every launch re-quarantined the graph.
    healthy = false;
    readLockfileMock.mockReturnValue(null);
    spawnedChild(1).emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnEnv(2).MUON_GRAPH_FORCE_RECOVER).toBeUndefined();

    supervisor.stop();
  });
});
