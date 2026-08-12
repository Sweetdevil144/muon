import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { SandboxLauncher } from "@muon/adapters";
import {
  RunnerSupervisor,
  type RunnerCoords,
  type RunnerEntry,
} from "../src/lib/runner-supervisor.js";

const logDir = mkdtempSync(path.join(tmpdir(), "muon-desktop-runner-"));
afterAll(() => rmSync(logDir, { recursive: true, force: true }));

type SpawnCall = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  detached?: boolean;
  stdio?: unknown;
};

type FakeChild = EventEmitter & {
  unref: () => void;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  killed: boolean;
  pid: number | undefined;
  stdio: Array<{ unref?: () => void; destroy?: () => void } | null>;
  emitExit: (code?: number | null) => void;
};

let nextPid = 1000;

/** A ChildProcess-ish stub with deterministic intentional/unexpected exits. */
function fakeChild(exitOnKill = true): FakeChild {
  const emitter = new EventEmitter() as FakeChild;
  emitter.unref = () => undefined;
  emitter.killed = false;
  emitter.pid = ++nextPid;
  emitter.stdio = [
    null,
    null,
    null,
    { unref: vi.fn(), destroy: vi.fn() },
  ];
  emitter.emitExit = (code = 0) => {
    emitter.emit("exit", code, null);
  };
  emitter.kill = () => {
    emitter.killed = true;
    if (exitOnKill) {
      queueMicrotask(() => emitter.emitExit(0));
    }
    return true;
  };
  return emitter;
}

type Waiter = { ms: number; resolve: () => void };

function makeSupervisor(
  launcher: SandboxLauncher,
  calls: SpawnCall[],
  options: {
    entry?: RunnerEntry;
    probeLive?: (
      coords: RunnerCoords,
      host: string,
      pid: number
    ) => Promise<boolean>;
    delay?: (ms: number) => Promise<void>;
    pollDelay?: (ms: number) => Promise<void>;
    restartDelay?: (ms: number) => Promise<void>;
    terminationDelay?: (ms: number) => Promise<void>;
    watchdogDelay?: (ms: number) => Promise<void>;
    now?: () => number;
    random?: () => number;
    startupTimeoutMs?: number;
    startupPollMs?: number;
    maxRestartAttempts?: number;
    restartBaseMs?: number;
    restartCapMs?: number;
    watchdogIntervalMs?: number;
    watchdogMissLimit?: number;
    childFactory?: () => FakeChild;
    resolveEntry?: () => RunnerEntry | undefined;
    signalProcessGroup?: (
      pid: number,
      signal: NodeJS.Signals
    ) => boolean;
    authorizeLease?: (
      coords: RunnerCoords,
      host: string,
      leaseToken: string
    ) => Promise<void>;
  } = {}
) {
  const children: FakeChild[] = [];
  const spawn = ((
    command: string,
    args: string[],
    spawnOptions: {
      env?: NodeJS.ProcessEnv;
      detached?: boolean;
      stdio?: unknown;
    }
  ) => {
    calls.push({
      command,
      args,
      env: spawnOptions.env ?? {},
      detached: spawnOptions.detached,
      stdio: spawnOptions.stdio,
    });
    const child = options.childFactory?.() ?? fakeChild();
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  const supervisor = new RunnerSupervisor({
    dataDir: "/muon/data",
    host: "desktop-testhost",
    logDir,
    execPath: "/path/to/electron",
    resolveEntry:
      options.resolveEntry ??
      (() =>
        options.entry ?? {
          path: "/repo/apps/desktop/dist/runner-entry.js",
          kind: "desktop",
        }),
    spawn,
    launcher,
    probeLive: options.probeLive ?? (async () => true),
    delay: options.delay,
    pollDelay: options.pollDelay,
    restartDelay: options.restartDelay,
    terminationDelay: options.terminationDelay,
    watchdogDelay:
      options.watchdogDelay ?? (() => new Promise<void>(() => undefined)),
    now: options.now,
    random: options.random,
    startupTimeoutMs: options.startupTimeoutMs,
    startupPollMs: options.startupPollMs,
    maxRestartAttempts: options.maxRestartAttempts,
    restartBaseMs: options.restartBaseMs,
    restartCapMs: options.restartCapMs,
    watchdogIntervalMs: options.watchdogIntervalMs,
    watchdogMissLimit: options.watchdogMissLimit,
    // Default to a no-op that reports "no group signalled" so termination falls
    // through to child.kill(), the only thing that drives fakeChild's exit. The
    // real seam is process.kill(-pid): with fabricated pids it usually throws
    // ESRCH (→ false → child.kill) but occasionally hits a live process group,
    // returns true, and strands terminate on its real 6s timer past the test
    // deadline — and fires a real SIGTERM/SIGKILL at an unrelated group.
    signalProcessGroup: options.signalProcessGroup ?? (() => false),
    authorizeLease: options.authorizeLease ?? (async () => undefined),
    onLog: () => undefined,
  });
  return { supervisor, children };
}

const seatbeltStub: SandboxLauncher = {
  isAvailable: () => true,
  wrap: (command, args) => ({
    command: "sandbox-exec",
    args: ["-p", "(profile)", command, ...args],
    sandboxed: true,
  }),
};

const noopStub: SandboxLauncher = {
  isAvailable: () => false,
  wrap: (command, args) => ({ command, args, sandboxed: false }),
};

const coords = (
  apiBase = "http://127.0.0.1:5678"
): RunnerCoords => ({
  apiBase,
  agentToken: "AGENT-TOK",
  operatorToken: "OPERATOR-TOK",
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushUntil(
  predicate: () => boolean,
  maxFlushes = 100
): Promise<void> {
  for (let attempt = 0; attempt < maxFlushes; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("condition did not settle within the microtask budget");
}

describe("RunnerSupervisor, packaged, heartbeat-gated, self-healing", () => {
  it("spawns the dedicated runner through Seatbelt and reports live only after its heartbeat", async () => {
    const calls: SpawnCall[] = [];
    const probeLive = vi.fn(async () => true);
    const { supervisor, children } = makeSupervisor(seatbeltStub, calls, {
      probeLive,
    });

    const result = await supervisor.start(coords());

    expect(result).toMatchObject({
      started: true,
      live: true,
      sandboxed: true,
    });
    expect(probeLive).toHaveBeenCalledWith(
      coords(),
      "desktop-testhost",
      expect.any(Number)
    );
    expect(supervisor.getStatus()).toMatchObject({
      phase: "live",
      host: "desktop-testhost",
      sandboxed: true,
      restartAttempt: 0,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe("sandbox-exec");
    expect(call.args).toContain("/path/to/electron");
    expect(call.args).toContain("/repo/apps/desktop/dist/runner-entry.js");
    expect(call.args).not.toContain("runner");
    expect(call.detached).toBe(true);
    expect(call.stdio).toEqual([
      "ignore",
      "pipe",
      "pipe",
      "pipe",
    ]);
    expect(children[0]!.stdio[3]!.unref).toHaveBeenCalledOnce();
  });

  it("keeps the legacy CLI fallback argv contract", async () => {
    const calls: SpawnCall[] = [];
    const { supervisor } = makeSupervisor(seatbeltStub, calls, {
      entry: { path: "/repo/apps/cli/dist/index.js", kind: "legacy-cli" },
    });

    await supervisor.start(coords());

    expect(calls[0]!.args).toEqual(
      expect.arrayContaining([
        "/repo/apps/cli/dist/index.js",
        "runner",
        "--host",
        "desktop-testhost",
        "--api-base",
        "http://127.0.0.1:5678",
      ])
    );
  });

  it("passes the agent token, host, base, and ELECTRON_RUN_AS_NODE without operator authority", async () => {
    const calls: SpawnCall[] = [];
    const authorizeLease = vi.fn(async () => undefined);
    const previous = {
      api: process.env.MUON_API_TOKEN,
      operator: process.env.MUON_OPERATOR_TOKEN,
      autoContinue: process.env.MUON_AUTO_CONTINUE,
    };
    process.env.MUON_API_TOKEN = "OPERATOR-API";
    process.env.MUON_OPERATOR_TOKEN = "OPERATOR-GOVERN";
    process.env.MUON_AUTO_CONTINUE = "0";
    try {
      const { supervisor } = makeSupervisor(seatbeltStub, calls, {
        authorizeLease,
      });
      await supervisor.start(coords());
      const env = calls[0]!.env;
      expect(authorizeLease).toHaveBeenCalledWith(
        coords(),
        "desktop-testhost",
        expect.stringMatching(/^[a-f0-9]{64}$/)
      );
      expect(env.MUON_AGENT_TOKEN).toBe("AGENT-TOK");
      expect(env.MUON_API_BASE).toBe("http://127.0.0.1:5678");
      expect(env.MUON_RUNNER_HOST).toBe("desktop-testhost");
      expect(env.MUON_AUTO_CONTINUE).toBe("0");
      expect(env.MUON_RUNNER_LEASE_TOKEN).toBe(
        authorizeLease.mock.calls[0]![2]
      );
      expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(env.MUON_SANDBOX_ACTIVE).toBe("1");
      // The runner must resolve the SAME profile as the brain child, or
      // managedWorktreesRoot splits between tree creation and validation.
      expect(env.MUON_DATA_DIR).toBe("/muon/data");
      expect(env.MUON_API_TOKEN).toBeUndefined();
      expect(env.MUON_OPERATOR_TOKEN).toBeUndefined();
    } finally {
      if (previous.api === undefined) delete process.env.MUON_API_TOKEN;
      else process.env.MUON_API_TOKEN = previous.api;
      if (previous.operator === undefined) delete process.env.MUON_OPERATOR_TOKEN;
      else process.env.MUON_OPERATOR_TOKEN = previous.operator;
      if (previous.autoContinue === undefined) {
        delete process.env.MUON_AUTO_CONTINUE;
      } else {
        process.env.MUON_AUTO_CONTINUE = previous.autoContinue;
      }
    }
  });

  it("fails closed in strict sandbox mode without spawning or retrying", async () => {
    const calls: SpawnCall[] = [];
    const previous = process.env.MUON_REQUIRE_SANDBOX;
    process.env.MUON_REQUIRE_SANDBOX = "1";
    try {
      const { supervisor } = makeSupervisor(noopStub, calls);
      const result = await supervisor.start(coords());
      expect(result).toMatchObject({
        started: false,
        live: false,
        sandboxed: false,
      });
      expect(supervisor.getStatus().phase).toBe("degraded");
      expect(calls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.MUON_REQUIRE_SANDBOX;
      else process.env.MUON_REQUIRE_SANDBOX = previous;
    }
  });

  it("preserves the default unsandboxed degrade path, still agent-token-only", async () => {
    const calls: SpawnCall[] = [];
    const previous = process.env.MUON_REQUIRE_SANDBOX;
    delete process.env.MUON_REQUIRE_SANDBOX;
    try {
      const { supervisor } = makeSupervisor(noopStub, calls);
      const result = await supervisor.start(coords());
      expect(result).toMatchObject({
        started: true,
        live: true,
        sandboxed: false,
      });
      expect(calls[0]!.command).toBe("/path/to/electron");
      expect(calls[0]!.env.MUON_AGENT_TOKEN).toBe("AGENT-TOK");
      expect(calls[0]!.env.MUON_API_TOKEN).toBeUndefined();
      expect(calls[0]!.env.MUON_SANDBOX_ACTIVE).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.MUON_REQUIRE_SANDBOX = previous;
    }
  });

  it("is idempotent while a confirmed child is alive", async () => {
    const calls: SpawnCall[] = [];
    const { supervisor } = makeSupervisor(seatbeltStub, calls);
    await supervisor.start(coords());
    const second = await supervisor.start(coords());
    expect(second).toMatchObject({ started: false, live: true });
    expect(calls).toHaveLength(1);
    expect(supervisor.isRunning()).toBe(true);
  });

  it("never confirms a spawned child that has no positive PID", async () => {
    const calls: SpawnCall[] = [];
    const probeLive = vi.fn(async () => true);
    const { supervisor } = makeSupervisor(seatbeltStub, calls, {
      probeLive,
      maxRestartAttempts: 0,
      childFactory: () => {
        const child = fakeChild();
        child.pid = undefined;
        return child;
      },
    });

    const result = await supervisor.start(coords());

    expect(result).toMatchObject({ started: false, live: false });
    expect(result.note).toMatch(/pid/i);
    expect(probeLive).not.toHaveBeenCalled();
  });

  it("enters backoff and restarts once after an unexpected live exit", async () => {
    const calls: SpawnCall[] = [];
    const waiters: Waiter[] = [];
    const signalProcessGroup = vi.fn(() => true);
    const delay = (ms: number) =>
      new Promise<void>((resolve) => waiters.push({ ms, resolve }));
    const { supervisor, children } = makeSupervisor(seatbeltStub, calls, {
      restartDelay: delay,
      random: () => 0,
      signalProcessGroup,
    });
    await supervisor.start(coords());
    const crashedPid = children[0]!.pid!;

    children[0]!.emitExit(17);
    await flush();

    expect(signalProcessGroup).toHaveBeenCalledWith(crashedPid, "SIGKILL");
    expect(supervisor.getStatus()).toMatchObject({
      phase: "backoff",
      restartAttempt: 1,
    });
    expect(waiters[0]!.ms).toBe(1000);
    expect(calls).toHaveLength(1);

    waiters[0]!.resolve();
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(supervisor.getStatus()).toMatchObject({
      phase: "live",
      restartAttempt: 0,
    });
  });

  it("does not resurrect after an intentional stop", async () => {
    const calls: SpawnCall[] = [];
    const restartDelay = vi.fn(async () => undefined);
    const { supervisor } = makeSupervisor(seatbeltStub, calls, {
      restartDelay,
    });
    await supervisor.start(coords());

    await supervisor.stop(20);
    await flush();

    expect(supervisor.getStatus().phase).toBe("stopped");
    expect(calls).toHaveLength(1);
    expect(restartDelay).not.toHaveBeenCalled();
  });

  it("restarts on new coordinates without a stale extra child", async () => {
    const calls: SpawnCall[] = [];
    const { supervisor } = makeSupervisor(seatbeltStub, calls);
    await supervisor.start(coords());

    await supervisor.restart(coords("http://127.0.0.1:6789"));
    await flush();

    expect(calls).toHaveLength(2);
    expect(calls[1]!.env.MUON_API_BASE).toBe("http://127.0.0.1:6789");
    expect(supervisor.getStatus().phase).toBe("live");
  });

  it("authorizes a fresh, distinct lease for every runner generation", async () => {
    const calls: SpawnCall[] = [];
    const authorizeLease = vi.fn(async () => undefined);
    const { supervisor } = makeSupervisor(seatbeltStub, calls, {
      authorizeLease,
    });
    await supervisor.start(coords());
    await supervisor.restart(coords("http://127.0.0.1:6789"));

    expect(authorizeLease).toHaveBeenCalledTimes(2);
    const first = authorizeLease.mock.calls[0]![2];
    const second = authorizeLease.mock.calls[1]![2];
    expect(first).not.toBe(second);
    expect(calls[0]!.env.MUON_RUNNER_LEASE_TOKEN).toBe(first);
    expect(calls[1]!.env.MUON_RUNNER_LEASE_TOKEN).toBe(second);
  });

  it("serializes overlapping restarts so the newest coordinates win", async () => {
    const calls: SpawnCall[] = [];
    const { supervisor, children } = makeSupervisor(seatbeltStub, calls, {
      childFactory: () => fakeChild(false),
    });
    await supervisor.start(coords());

    const first = supervisor.restart(coords("http://127.0.0.1:6789"));
    await flush();
    const second = supervisor.restart(coords("http://127.0.0.1:7890"));
    children[0]!.emitExit();
    await Promise.all([first, second]);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.env.MUON_API_BASE).toBe("http://127.0.0.1:7890");
  });

  it("a stop intent cancels an outstanding restart before it can spawn", async () => {
    const calls: SpawnCall[] = [];
    const { supervisor, children } = makeSupervisor(seatbeltStub, calls, {
      childFactory: () => fakeChild(false),
    });
    await supervisor.start(coords());

    const restarting = supervisor.restart(coords("http://127.0.0.1:6789"));
    await flush();
    const stopping = supervisor.stop();
    children[0]!.emitExit();
    await Promise.all([restarting, stopping]);

    expect(calls).toHaveLength(1);
    expect(supervisor.getStatus().phase).toBe("stopped");
  });

  it("signals the detached runner process group so vendor children drain too", async () => {
    const calls: SpawnCall[] = [];
    const signalProcessGroup = vi.fn(() => true);
    const { supervisor, children } = makeSupervisor(seatbeltStub, calls, {
      childFactory: () => fakeChild(false),
      signalProcessGroup,
    });
    await supervisor.start(coords());
    const pid = children[0]!.pid!;

    const stopping = supervisor.stop();
    await flush();
    // Intentional shutdown sends exactly one SIGTERM. Closing fd3 first would
    // independently trigger the parent-loss SIGTERM and force-abort the drain.
    expect(children[0]!.stdio[3]!.destroy).not.toHaveBeenCalled();
    expect(signalProcessGroup).toHaveBeenCalledWith(pid, "SIGTERM");
    children[0]!.emitExit();
    await stopping;
  });

  it("bounds runners that repeatedly heartbeat and then crash immediately", async () => {
    const calls: SpawnCall[] = [];
    const { supervisor, children } = makeSupervisor(seatbeltStub, calls, {
      restartDelay: async () => undefined,
      random: () => 0,
      maxRestartAttempts: 2,
    });
    await supervisor.start(coords());

    for (let crash = 0; crash < 3; crash += 1) {
      children[crash]!.emitExit(17);
      for (let tick = 0; tick < 8; tick += 1) await flush();
    }

    expect(calls).toHaveLength(3);
    expect(supervisor.getStatus()).toMatchObject({
      phase: "degraded",
      restartAttempt: 2,
    });
    expect(supervisor.getStatus().note).toMatch(/restart limit/i);
  });

  it("uses exponential bounded retries and degrades after repeated pre-heartbeat failures", async () => {
    const calls: SpawnCall[] = [];
    const waits: number[] = [];
    const { supervisor } = makeSupervisor(seatbeltStub, calls, {
      probeLive: async () => false,
      restartDelay: async (ms) => {
        waits.push(ms);
      },
      terminationDelay: async () => undefined,
      now: () => 10_000,
      startupTimeoutMs: 0,
      random: () => 0,
      maxRestartAttempts: 3,
    });

    await supervisor.start(coords());
    await flushUntil(() => supervisor.getStatus().phase === "degraded");

    expect(waits.filter((ms) => ms >= 1000)).toEqual([1000, 2000, 4000]);
    expect(calls).toHaveLength(4);
    expect(supervisor.getStatus()).toMatchObject({
      phase: "degraded",
      restartAttempt: 3,
    });
  });

  it("never spawns a replacement when a timed-out child cannot be confirmed dead", async () => {
    const calls: SpawnCall[] = [];
    const { supervisor } = makeSupervisor(seatbeltStub, calls, {
      probeLive: async () => false,
      delay: async () => undefined,
      now: () => 10_000,
      startupTimeoutMs: 0,
      random: () => 0,
      maxRestartAttempts: 3,
      childFactory: () => fakeChild(false),
      terminationDelay: async () => undefined,
    });

    const result = await supervisor.start(coords());
    for (let i = 0; i < 6; i += 1) await flush();

    expect(result.live).toBe(false);
    expect(calls).toHaveLength(1);
    expect(supervisor.getStatus()).toMatchObject({
      phase: "degraded",
      restartAttempt: 0,
    });
    expect(supervisor.getStatus().note).toMatch(/could not confirm.*terminated/i);
  });

  it("cancels a pending backoff restart when stop is requested", async () => {
    const calls: SpawnCall[] = [];
    const waiters: Waiter[] = [];
    const { supervisor, children } = makeSupervisor(seatbeltStub, calls, {
      restartDelay: (ms) =>
        new Promise<void>((resolve) => waiters.push({ ms, resolve })),
    });
    await supervisor.start(coords());
    children[0]!.emitExit(17);
    await flush();
    expect(supervisor.getStatus().phase).toBe("backoff");

    await supervisor.stop();
    waiters[0]!.resolve();
    await flush();

    expect(calls).toHaveLength(1);
    expect(supervisor.getStatus().phase).toBe("stopped");
  });

  it("restarts a live-but-stale child after bounded watchdog misses", async () => {
    const calls: SpawnCall[] = [];
    const watchdogWaiters: Waiter[] = [];
    const restartWaiters: Waiter[] = [];
    let probes = 0;
    const { supervisor } = makeSupervisor(seatbeltStub, calls, {
      probeLive: async () => {
        probes += 1;
        return probes === 1 || probes >= 4;
      },
      watchdogDelay: (ms) =>
        new Promise<void>((resolve) =>
          watchdogWaiters.push({ ms, resolve })
        ),
      restartDelay: (ms) =>
        new Promise<void>((resolve) =>
          restartWaiters.push({ ms, resolve })
        ),
      terminationDelay: async () => undefined,
      watchdogIntervalMs: 5000,
      watchdogMissLimit: 2,
    });
    await supervisor.start(coords());

    watchdogWaiters[0]!.resolve();
    await flush();
    watchdogWaiters[1]!.resolve();
    await flush();

    expect(supervisor.getStatus()).toMatchObject({
      phase: "backoff",
      restartAttempt: 1,
    });
    expect(restartWaiters).toHaveLength(1);

    restartWaiters[0]!.resolve();
    await vi.waitFor(() =>
      expect(supervisor.getStatus().phase).toBe("live")
    );
    expect(calls).toHaveLength(2);
  });

  it("does not kill healthy vendor work merely because the brain is temporarily unreachable", async () => {
    const calls: SpawnCall[] = [];
    const watchdogWaiters: Waiter[] = [];
    let probes = 0;
    const { supervisor } = makeSupervisor(seatbeltStub, calls, {
      probeLive: async () => {
        probes += 1;
        if (probes === 1) return true;
        throw new Error("ECONNREFUSED");
      },
      watchdogDelay: (ms) =>
        new Promise<void>((resolve) =>
          watchdogWaiters.push({ ms, resolve })
        ),
      watchdogIntervalMs: 5000,
      watchdogMissLimit: 2,
    });
    await supervisor.start(coords());

    watchdogWaiters[0]!.resolve();
    await flush();
    watchdogWaiters[1]!.resolve();
    await flush();

    expect(calls).toHaveLength(1);
    expect(supervisor.isRunning()).toBe(true);
    expect(supervisor.getStatus().phase).toBe("live");
  });

  it("does not treat a child error event as confirmed process exit", async () => {
    const calls: SpawnCall[] = [];
    const restartDelay = vi.fn(async () => undefined);
    const { supervisor, children } = makeSupervisor(seatbeltStub, calls, {
      restartDelay,
    });
    await supervisor.start(coords());

    children[0]!.emit("error", new Error("kill EPERM"));
    await flush();

    expect(supervisor.isRunning()).toBe(true);
    expect(supervisor.getStatus().phase).toBe("live");
    expect(calls).toHaveLength(1);
    expect(restartDelay).not.toHaveBeenCalled();
  });

  it("contains launch-transaction exceptions inside bounded recovery", async () => {
    const calls: SpawnCall[] = [];
    const { supervisor } = makeSupervisor(seatbeltStub, calls, {
      resolveEntry: () => {
        throw new Error("resolver exploded");
      },
      maxRestartAttempts: 0,
    });

    await expect(supervisor.start(coords())).resolves.toMatchObject({
      started: false,
      live: false,
    });
    expect(supervisor.getStatus()).toMatchObject({
      phase: "degraded",
      restartAttempt: 0,
    });
    expect(supervisor.getStatus().note).toMatch(/resolver exploded/);
  });

  it("never lets jitter exceed the configured restart cap", async () => {
    const calls: SpawnCall[] = [];
    const waits: number[] = [];
    const { supervisor } = makeSupervisor(seatbeltStub, calls, {
      probeLive: async () => false,
      restartDelay: async (ms) => {
        waits.push(ms);
      },
      terminationDelay: async () => undefined,
      now: () => 10_000,
      startupTimeoutMs: 0,
      maxRestartAttempts: 1,
      restartBaseMs: 30_000,
      restartCapMs: 30_000,
      random: () => 1,
    });

    await supervisor.start(coords());
    await flush();

    expect(waits[0]).toBe(30_000);
  });
});
