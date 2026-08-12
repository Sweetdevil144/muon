import { describe, expect, it } from "vitest";
import {
  dismissQueuedMessage,
  enqueueComposerMessage,
  takeNextQueuedMessage,
} from "../src/lib/composer-message-queue.js";
import {
  trayPresenceTitle,
  trayPresenceTooltip,
} from "../src/lib/tray-presence.js";

describe("composer message queue (TODO 7.13)", () => {
  it("enqueues trimmed text and ignores blanks", () => {
    const q1 = enqueueComposerMessage([], "  follow up  ", 1, "a");
    expect(q1).toEqual([
      { id: "a", text: "follow up", enqueuedAt: 1 },
    ]);
    expect(enqueueComposerMessage(q1, "   ", 2, "b")).toEqual(q1);
  });

  it("dismisses by id and takeNext pops FIFO head", () => {
    const queue = enqueueComposerMessage(
      enqueueComposerMessage([], "first", 1, "a"),
      "second",
      2,
      "b"
    );
    expect(dismissQueuedMessage(queue, "a").map((e) => e.id)).toEqual(["b"]);
    const { next, remaining } = takeNextQueuedMessage(queue);
    expect(next?.text).toBe("first");
    expect(remaining.map((e) => e.text)).toEqual(["second"]);
    expect(takeNextQueuedMessage([]).next).toBeNull();
  });
});

describe("tray presence (TODO 7.9)", () => {
  it("shows pending approval count when online", () => {
    expect(trayPresenceTitle({ online: true, pendingCount: 0 })).toBe("●");
    expect(trayPresenceTitle({ online: true, pendingCount: 3 })).toBe("● 3");
    expect(trayPresenceTitle({ online: false, pendingCount: 3 })).toBe("◌");
    expect(trayPresenceTooltip({ online: true, pendingCount: 2 })).toBe(
      "MUON, 2 pending approval(s)"
    );
  });
});
