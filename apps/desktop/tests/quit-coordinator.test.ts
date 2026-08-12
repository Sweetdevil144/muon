import { describe, expect, it, vi } from "vitest";
import { createQuitCoordinator } from "../src/lib/quit-coordinator.js";

describe("createQuitCoordinator", () => {
  it("always drains the runner before stopping the brain and permits the second quit pass", async () => {
    const order: string[] = [];
    let finishDrain: () => void = () => undefined;
    const drain = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    const quit = vi.fn();
    const handler = createQuitCoordinator({
      stopMonitor: () => order.push("monitor"),
      onBegin: () => order.push("begin"),
      drainRunner: async () => {
        order.push("runner:start");
        await drain;
        order.push("runner:done");
      },
      stopBrain: () => order.push("brain"),
      quit,
    });
    const first = { preventDefault: vi.fn() };

    handler(first);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(order).toEqual(["monitor", "begin", "runner:start"]);

    finishDrain();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    expect(order).toEqual([
      "monitor",
      "begin",
      "runner:start",
      "runner:done",
      "brain",
    ]);
    const second = { preventDefault: vi.fn() };
    handler(second);
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it("does not start a second drain while quit is already pending", () => {
    const drainRunner = vi.fn(async () => new Promise<void>(() => undefined));
    const handler = createQuitCoordinator({
      stopMonitor: () => undefined,
      drainRunner,
      stopBrain: () => undefined,
      quit: () => undefined,
    });

    handler({ preventDefault: () => undefined });
    handler({ preventDefault: () => undefined });

    expect(drainRunner).toHaveBeenCalledOnce();
  });
});
