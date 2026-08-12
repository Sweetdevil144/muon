import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createParentLossHandler,
  watchRunnerParent,
} from "../src/lib/runner-parent-guard.js";

describe("watchRunnerParent", () => {
  it("fires exactly once when the inherited parent pipe closes", () => {
    const pipe = new PassThrough();
    const onParentGone = vi.fn();
    const stop = watchRunnerParent({
      createPipe: () => pipe,
      onParentGone,
    });

    pipe.end();
    pipe.emit("close");

    expect(onParentGone).toHaveBeenCalledOnce();
    stop();
  });

  it("degrades silently when fd 3 was not inherited", () => {
    const pipe = new PassThrough();
    const onParentGone = vi.fn();
    const stop = watchRunnerParent({
      createPipe: () => pipe,
      onParentGone,
    });

    pipe.emit("error", new Error("EBADF"));

    expect(onParentGone).not.toHaveBeenCalled();
    stop();
  });
});

describe("createParentLossHandler", () => {
  it("starts graceful drain once and escalates to the detached process group", () => {
    let force: () => void = () => undefined;
    const killPtyChildren = vi.fn();
    const signalTree = vi.fn();
    const forceTree = vi.fn();
    const scheduleForce = vi.fn((callback: () => void, ms: number) => {
      expect(ms).toBe(10_000);
      force = callback;
    });
    const onParentGone = createParentLossHandler({
      runtime: { killPtyChildren, signalTree, forceTree, scheduleForce },
    });

    onParentGone();
    onParentGone();

    expect(scheduleForce).toHaveBeenCalledOnce();
    expect(signalTree).toHaveBeenCalledOnce();
    force();
    expect(forceTree).toHaveBeenCalledOnce();
  });

  it("F2: reaps pty children BEFORE the group drain, and again at force", () => {
    // node-pty setsids, so these children are outside the group both
    // `signalTree` and `forceTree` sweep. If they were reaped after the force
    // — or not at all — an Electron crash would leave a danger-full-access
    // vendor child alive, still editing the worktree.
    const order: string[] = [];
    let force: () => void = () => undefined;
    const onParentGone = createParentLossHandler({
      runtime: {
        killPtyChildren: () => order.push("pty"),
        signalTree: () => order.push("signalTree"),
        forceTree: () => order.push("forceTree"),
        scheduleForce: (callback) => {
          force = callback;
        },
      },
    });

    onParentGone();
    expect(order).toEqual(["pty", "signalTree"]);

    force();
    // The force path re-reaps: a child spawned during the drain window must
    // not survive the SIGKILL that ends this process.
    expect(order).toEqual(["pty", "signalTree", "pty", "forceTree"]);
  });
});
