import type { MuonApiClient } from "@muon/client";
import { describe, expect, it, vi } from "vitest";
import {
  runRunnerHost,
  type RunnerHostRuntime,
} from "../src/host.js";

type Signal = "SIGINT" | "SIGTERM";

function makeRuntime(pid = 4242) {
  const handlers = new Map<Signal, Set<() => void>>([
    ["SIGINT", new Set()],
    ["SIGTERM", new Set()],
  ]);
  const forceExit = vi.fn();
  const runtime: RunnerHostRuntime = {
    pid,
    onSignal(signal, handler) {
      handlers.get(signal)?.add(handler);
    },
    offSignal(signal, handler) {
      handlers.get(signal)?.delete(handler);
    },
    forceExit,
  };

  return {
    runtime,
    forceExit,
    emit(signal: Signal) {
      for (const handler of handlers.get(signal) ?? []) {
        handler();
      }
    },
    listenerCount(signal: Signal) {
      return handlers.get(signal)?.size ?? 0;
    },
  };
}

const client = {} as MuonApiClient;

describe("runRunnerHost", () => {
  it.each([
    [true, "[runner] host=desktop-a tier=agent sandbox=on"],
    [false, "[runner] host=desktop-a tier=agent sandbox=off"],
  ])("emits an honest boot line when confined=%s", async (confined, expected) => {
    const output = vi.fn();

    await runRunnerHost({
      client,
      host: "desktop-a",
      apiBase: "http://127.0.0.1:4100",
      apiToken: "agent-token",
      confined,
      output,
      runtime: makeRuntime().runtime,
      runLoop: vi.fn(async () => undefined),
    });

    expect(output).toHaveBeenNthCalledWith(1, expected);
  });

  it("warns when a confined compatibility host has no agent token", async () => {
    const output = vi.fn();

    await runRunnerHost({
      client,
      host: "desktop-a",
      apiBase: "http://127.0.0.1:4100",
      confined: true,
      output,
      runtime: makeRuntime().runtime,
      runLoop: vi.fn(async () => undefined),
    });

    expect(output).toHaveBeenCalledWith(
      "[runner] WARN: no agent token (MUON_AGENT_TOKEN unset / pre-P3-A lockfile), sandboxed runner cannot authenticate; restart the brain to mint one"
    );
  });

  it("aborts and drains the loop on SIGTERM", async () => {
    const signals = makeRuntime();
    const output = vi.fn();
    const runLoop = vi.fn(
      async (
        _client: MuonApiClient,
        options: { signal?: AbortSignal }
      ) => {
        expect(options.signal?.aborted).toBe(false);
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        expect(options.signal?.aborted).toBe(true);
      }
    );

    const settled = runRunnerHost({
      client,
      host: "desktop-a",
      apiBase: "http://127.0.0.1:4100",
      apiToken: "agent-token",
      confined: true,
      output,
      runtime: signals.runtime,
      runLoop,
    });
    await vi.waitFor(() => expect(runLoop).toHaveBeenCalledOnce());

    signals.emit("SIGTERM");
    await settled;

    expect(output).toHaveBeenCalledWith(
      "\n[runner] draining, Ctrl-C again to force quit"
    );
    expect(signals.forceExit).not.toHaveBeenCalled();
  });

  it("F2: reaps pty children on the drain AND on the force path", async () => {
    // A node-pty child leads its own process group, so neither the runner's
    // own exit nor any group sweep reaches it. If the runner goes down without
    // reaping them, a danger-full-access vendor child keeps editing the
    // worktree with nothing observing it.
    const signals = makeRuntime();
    const terminatePtyChildren = vi.fn();
    let releaseLoop: () => void = () => undefined;
    const loopSettled = new Promise<void>((resolve) => {
      releaseLoop = resolve;
    });
    const runLoop = vi.fn(async () => loopSettled);

    const settled = runRunnerHost({
      client,
      host: "desktop-a",
      apiBase: "http://127.0.0.1:4100",
      apiToken: "agent-token",
      confined: true,
      output: vi.fn(),
      runtime: signals.runtime,
      runLoop,
      terminatePtyChildren,
    });
    await vi.waitFor(() => expect(runLoop).toHaveBeenCalledOnce());

    // Graceful drain: signalled at the START, so the vendor gets its SIGTERM
    // grace even if the drain itself is later interrupted.
    signals.emit("SIGTERM");
    expect(terminatePtyChildren).toHaveBeenCalledTimes(1);

    // Force quit: nothing else will run, so this is the last chance.
    signals.emit("SIGINT");
    expect(terminatePtyChildren).toHaveBeenCalledTimes(2);
    expect(signals.forceExit).toHaveBeenCalledWith(0);

    releaseLoop();
    await settled;
  });

  it("force-exits when a second signal arrives during drain", async () => {
    const signals = makeRuntime();
    let releaseLoop: () => void = () => undefined;
    const loopSettled = new Promise<void>((resolve) => {
      releaseLoop = resolve;
    });
    const runLoop = vi.fn(async () => loopSettled);

    const settled = runRunnerHost({
      client,
      host: "desktop-a",
      apiBase: "http://127.0.0.1:4100",
      apiToken: "agent-token",
      confined: true,
      output: vi.fn(),
      runtime: signals.runtime,
      runLoop,
    });
    await vi.waitFor(() => expect(runLoop).toHaveBeenCalledOnce());

    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    releaseLoop();
    await settled;

    expect(signals.forceExit).toHaveBeenCalledOnce();
    expect(signals.forceExit).toHaveBeenCalledWith(0);
  });

  it("removes both signal listeners after the loop settles", async () => {
    const signals = makeRuntime();

    await runRunnerHost({
      client,
      host: "desktop-a",
      apiBase: "http://127.0.0.1:4100",
      apiToken: "agent-token",
      confined: false,
      output: vi.fn(),
      runtime: signals.runtime,
      runLoop: vi.fn(async () => undefined),
    });

    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("passes the exact process coordinates and loop settings through", async () => {
    const signals = makeRuntime(9876);
    const output = vi.fn();
    const runLoop = vi.fn(async () => undefined);

    await runRunnerHost({
      client,
      host: "desktop-a",
      apiBase: "http://127.0.0.1:4100",
      apiToken: "agent-token",
      leaseToken: "lease-token",
      concurrency: 3,
      pollMs: 725,
      confined: true,
      output,
      runtime: signals.runtime,
      runLoop,
    });

    expect(runLoop).toHaveBeenCalledOnce();
    expect(runLoop).toHaveBeenCalledWith(client, {
      host: "desktop-a",
      pid: 9876,
      apiBase: "http://127.0.0.1:4100",
      apiToken: "agent-token",
      leaseToken: "lease-token",
      concurrency: 3,
      pollMs: 725,
      signal: expect.any(AbortSignal),
      onLog: expect.any(Function),
    });

    const loopOptions = runLoop.mock.calls[0]?.[1];
    loopOptions?.onLog?.("online");
    expect(output).toHaveBeenCalledWith("[runner] online");
  });
});
