// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewThreadDigest } from "../src/shared/ipc.js";
import {
  lookedAgoLabel,
  summarizeReviewDigest,
} from "../src/renderer/lib/review-digest.js";
import { ReviewDigestStrip } from "../src/renderer/review-digest.js";

/**
 * H1 — the bound review thread.
 *
 * The acceptance claims, each as its own test:
 *   * the strip shows a DELTA with the degraded count called out;
 *   * OPENING NEVER ADVANCES the cursor — which is the whole mechanism by which
 *     closing without deciding leaves the thread bound;
 *   * exactly one gesture on this strip advances it ("Mark reviewed"), and it
 *     re-reads afterwards;
 *   * an unreadable digest reads as an outage, never as "nothing changed";
 *   * a typed_degraded packet cannot look like an empty inbox;
 *   * the acknowledge stamps the digest it RENDERED FROM (`digestAt`), not the
 *     click, so the render→click window is never consumed unseen.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function digest(overrides: Partial<ReviewThreadDigest> = {}): ReviewThreadDigest {
  return {
    target: { targetKind: "task", targetId: "task-1" },
    lastLookedAt: "2026-08-17T08:00:00.000Z",
    digestAt: "2026-08-17T08:05:00.000Z",
    handoffs: [
      {
        id: "handoff-1",
        taskId: "task-1",
        status: "delivered",
        createdAt: "2026-08-17T08:02:00.000Z",
        degraded: true,
        standing: true,
      },
      {
        id: "handoff-2",
        taskId: "task-1",
        status: "delivered",
        createdAt: "2026-08-17T08:03:00.000Z",
        degraded: false,
        standing: false,
      },
    ],
    approvals: [
      {
        id: "approval-merge",
        taskId: "task-1",
        kind: "merge",
        status: "pending",
        gateTag: null,
        createdAt: "2026-08-17T08:04:00.000Z",
        decidedAt: null,
        reviewDigest: null,
      },
    ],
    openQuestionIds: ["q-1"],
    truncated: false,
    ...overrides,
  } as ReviewThreadDigest;
}

describe("H1 — summarizing the bound review thread", () => {
  it("counts the delta and calls the degraded packets out by number", () => {
    const summary = summarizeReviewDigest(
      digest(),
      Date.parse("2026-08-17T08:05:00.000Z")
    );
    expect(summary.empty).toBe(false);
    expect(summary.packets).toBe(2);
    expect(summary.degradedPackets).toBe(1);
    expect(summary.gateChanges).toBe(1);
    expect(summary.openQuestions).toBe(1);
    expect(summary.headline).toMatch(/Since you last looked \(5m ago\)/);
    expect(summary.headline).toMatch(/2 packets/);
    expect(summary.headline).toMatch(/1 gate change/);
    expect(summary.headline).toMatch(/1 degraded packet/);
    expect(summary.headline).toMatch(/1 open question/);
  });

  it("separates the DELTA from what is still blocking", () => {
    // The cursor can only clear "new". A degraded packet, an undecided gate and
    // an unanswered question survive it — so Mark reviewed can never fake a
    // clear desk, and the headline says which half is which.
    const summary = summarizeReviewDigest(
      digest({
        handoffs: [
          {
            id: "handoff-old-degraded",
            taskId: "task-1",
            status: "delivered",
            createdAt: "2026-08-17T07:00:00.000Z",
            degraded: true,
            standing: true,
            newSinceLook: false,
          },
        ],
        approvals: [
          {
            id: "approval-old-pending",
            taskId: "task-1",
            kind: "merge",
            status: "pending",
            gateTag: null,
            createdAt: "2026-08-17T07:00:00.000Z",
            decidedAt: null,
            reviewDigest: null,
            newSinceLook: false,
          },
        ],
        openQuestionIds: [],
      } as Partial<ReviewThreadDigest>),
      Date.parse("2026-08-17T08:05:00.000Z")
    );
    expect(summary.newPackets).toBe(0);
    expect(summary.newGates).toBe(0);
    expect(summary.stillBlocking).toBe(2);
    expect(summary.empty).toBe(false);
    // Honest on both halves: nothing NEW, but the desk is not clear.
    expect(summary.headline).toMatch(/Nothing new since you last looked/);
    expect(summary.headline).toMatch(/Still blocking: 1 degraded packet, 1 pending gate/);
  });

  it("an older backend without newSinceLook still reads as a delta", () => {
    // Absence must not silently reclassify every row as a standing blocker.
    const summary = summarizeReviewDigest(digest());
    expect(summary.newPackets).toBe(2);
    expect(summary.newGates).toBe(1);
    expect(summary.headline).toMatch(/Since you last looked/);
  });

  it("an unreadable packet flag is neither degraded nor clean — it is named", () => {
    // `degraded: null` = the route could not read the flag. Folding it into
    // either count would be a claim nobody made.
    const summary = summarizeReviewDigest(
      digest({
        handoffs: [
          {
            id: "handoff-legacy",
            taskId: "task-1",
            status: "delivered",
            createdAt: "2026-08-17T08:02:00.000Z",
            degraded: null,
            standing: true,
          },
        ],
      })
    );
    expect(summary.degradedPackets).toBe(0);
    expect(summary.unknownPackets).toBe(1);
    expect(summary.headline).toMatch(/1 unverifiable/);
  });

  it("an unverifiable CURRENT packet is a standing blocker, and the count says so", () => {
    // The strip used to count these as blocking while the route's cursor
    // retired them, so "Mark reviewed cannot clear a blocker" was false for
    // exactly the rows nobody could vouch for. Route and strip now agree.
    const summary = summarizeReviewDigest(
      digest({
        handoffs: [
          {
            id: "handoff-legacy",
            taskId: "task-1",
            status: "delivered",
            createdAt: "2026-08-17T07:00:00.000Z",
            degraded: null,
            standing: true,
            newSinceLook: false,
          },
        ],
        approvals: [],
        openQuestionIds: [],
      } as Partial<ReviewThreadDigest>)
    );
    expect(summary.standingPackets).toBe(1);
    expect(summary.stillBlocking).toBe(1);
    expect(summary.headline).toMatch(/Still blocking: 1 unverifiable packet/);
  });

  it("a SUPERSEDED degraded packet is history, not an invented blocker", () => {
    // Both rows ride the delta; only the task's CURRENT wrap can stand, and it
    // is clean. Counting the old degraded row as blocking would promise a
    // blocker the repair already cleared.
    const summary = summarizeReviewDigest(
      digest({
        handoffs: [
          {
            id: "handoff-clean-now",
            taskId: "task-1",
            status: "delivered",
            createdAt: "2026-08-17T08:03:00.000Z",
            degraded: false,
            standing: false,
          },
          {
            id: "handoff-was-degraded",
            taskId: "task-1",
            status: "delivered",
            createdAt: "2026-08-17T08:02:00.000Z",
            degraded: true,
            standing: false,
          },
        ],
        approvals: [],
        openQuestionIds: [],
      } as Partial<ReviewThreadDigest>)
    );
    expect(summary.degradedPackets).toBe(1);
    expect(summary.standingPackets).toBe(0);
    expect(summary.stillBlocking).toBe(0);
    expect(summary.headline).not.toMatch(/Still blocking/);
  });

  it("a backend older than `standing` falls back to the SAME rule", () => {
    // Absence must not invent a clear desk: anything that did not declare
    // itself clean is still held.
    const summary = summarizeReviewDigest(
      digest({
        handoffs: [
          {
            id: "handoff-no-field",
            taskId: "task-1",
            status: "delivered",
            createdAt: "2026-08-17T07:00:00.000Z",
            degraded: null,
            newSinceLook: false,
          },
        ],
        approvals: [],
        openQuestionIds: [],
      } as Partial<ReviewThreadDigest>)
    );
    expect(summary.standingPackets).toBe(1);
    expect(summary.stillBlocking).toBe(1);
  });

  it("an empty delta says so, and never pretends a cursor exists", () => {
    const summary = summarizeReviewDigest(
      digest({ handoffs: [], approvals: [], openQuestionIds: [] })
    );
    expect(summary.empty).toBe(true);
    expect(summary.headline).toBe(
      "Nothing new since you last looked, and nothing blocking."
    );
  });

  it("a never-stamped cursor reads as never, not as 'just now'", () => {
    expect(lookedAgoLabel(null)).toBe("never");
    const summary = summarizeReviewDigest(digest({ lastLookedAt: null }));
    expect(summary.neverLooked).toBe(true);
    expect(summary.headline).toMatch(/\(never\)/);
  });

  it("ids are the evidence and travel through unchanged", () => {
    const summary = summarizeReviewDigest(digest());
    expect(summary.packetIds).toEqual(["handoff-1", "handoff-2"]);
    expect(summary.gateIds).toEqual(["approval-merge"]);
    expect(summary.questionIds).toEqual(["q-1"]);
  });
});

describe("H1 — the digest strip in the review dock", () => {
  const target = { targetKind: "task", targetId: "task-1" } as const;

  it("renders the delta with the degraded count and the ids", async () => {
    const read = vi.fn(async () => digest());
    render(
      React.createElement(ReviewDigestStrip, { target, read, advance: vi.fn() })
    );

    await screen.findByText(/Since you last looked/);
    const strip = document.querySelector(".review-digest-strip");
    expect(strip?.textContent).toMatch(/2 packets/);
    expect(strip?.textContent).toMatch(/Still blocking: 1 degraded packet/);
    expect(strip?.textContent).toContain("handoff-1");
    expect(strip?.textContent).toContain("approval-merge");
    expect(strip?.textContent).toContain("q-1");
  });

  it("OPENING NEVER ADVANCES: mounting fires no advance call", async () => {
    const read = vi.fn(async () => digest());
    const advance = vi.fn(async () => ({ lastLookedAt: "now" }));
    render(React.createElement(ReviewDigestStrip, { target, read, advance }));

    await screen.findByText(/Since you last looked/);
    expect(read).toHaveBeenCalledTimes(1);
    // The whole point of H1: a look is not a decision.
    expect(advance).not.toHaveBeenCalled();
  });

  it("closing and reopening shows the SAME digest — the thread stays bound", async () => {
    const read = vi.fn(async () => digest());
    const advance = vi.fn(async () => ({ lastLookedAt: "now" }));
    const first = render(
      React.createElement(ReviewDigestStrip, { target, read, advance })
    );
    await screen.findByText(/Since you last looked/);
    first.unmount();

    render(React.createElement(ReviewDigestStrip, { target, read, advance }));
    await screen.findByText(/Still blocking: 1 degraded packet/);
    // Two reads, zero advances: nothing consumed the delta.
    expect(read).toHaveBeenCalledTimes(2);
    expect(advance).not.toHaveBeenCalled();
  });

  it("Mark reviewed advances the cursor and re-reads", async () => {
    // The delta before the acknowledge; nothing left after it.
    let consumed = false;
    const read = vi.fn(async () =>
      consumed
        ? digest({ handoffs: [], approvals: [], openQuestionIds: [] })
        : digest()
    );
    const advance = vi.fn(async () => {
      consumed = true;
      return { lastLookedAt: "2026-08-17T09:00:00.000Z" };
    });
    const onAdvanced = vi.fn();
    render(
      React.createElement(ReviewDigestStrip, {
        target,
        read,
        advance,
        onAdvanced,
      })
    );

    const mark = await screen.findByRole("button", { name: "Mark reviewed" });
    fireEvent.click(mark);
    await waitFor(() =>
      expect(advance).toHaveBeenCalledWith({
        targetKind: "task",
        targetId: "task-1",
        // The digest ON SCREEN, not the moment of the click. Everything filed
        // after this instant survives the acknowledge.
        digestAt: "2026-08-17T08:05:00.000Z",
      })
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(onAdvanced).toHaveBeenCalled();
    // The delta the operator just consumed is gone on the re-read.
    await screen.findByText(/Nothing new since you last looked/);
  });

  it("acknowledges the digest it RENDERED FROM, even after a newer one exists", async () => {
    // Two reads, two different server stamps. The strip must echo the one it is
    // currently showing — echoing "now" is the bug this closes.
    let stamp = "2026-08-17T08:05:00.000Z";
    const read = vi.fn(async () => digest({ digestAt: stamp }));
    const advance = vi.fn(async () => ({
      lastLookedAt: "2026-08-17T09:00:00.000Z",
    }));
    const view = render(
      React.createElement(ReviewDigestStrip, {
        target,
        read,
        advance,
        refreshKey: 0,
      })
    );
    await screen.findByText(/Since you last looked/);
    stamp = "2026-08-17T08:09:00.000Z";
    view.rerender(
      React.createElement(ReviewDigestStrip, {
        target,
        read,
        advance,
        refreshKey: 1,
      })
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() =>
      expect(advance).toHaveBeenCalledWith(
        expect.objectContaining({ digestAt: "2026-08-17T08:09:00.000Z" })
      )
    );
  });

  it("a backend that sends no digestAt still advances, with no invented stamp", async () => {
    const advance = vi.fn(async () => ({ lastLookedAt: "now" }));
    render(
      React.createElement(ReviewDigestStrip, {
        target,
        read: vi.fn(async () => {
          const { digestAt: _dropped, ...older } = digest();
          return older as ReviewThreadDigest;
        }),
        advance,
      })
    );
    fireEvent.click(await screen.findByRole("button", { name: "Mark reviewed" }));
    await waitFor(() =>
      expect(advance).toHaveBeenCalledWith({
        targetKind: "task",
        targetId: "task-1",
      })
    );
  });

  it("the acknowledge is honest about what it does — and does not do", async () => {
    render(
      React.createElement(ReviewDigestStrip, {
        target,
        read: vi.fn(async () => digest()),
        advance: vi.fn(),
      })
    );
    await screen.findByRole("button", { name: "Mark reviewed" });
    const copy = document.querySelector(".review-digest-strip")?.textContent;
    expect(copy).toMatch(/decides nothing, approves nothing/i);
    // The clearing acts, stated exactly as the route implements them — the copy
    // used to say "until repaired" without naming what a repair IS, and said
    // nothing about a finished task (which does NOT clear one).
    expect(copy).toMatch(/later packet on that task reads clean/i);
    expect(copy).toMatch(/could not read at all/i);
    expect(copy).toMatch(/Finishing the task is not one of those acts/i);
  });

  it("re-reads when the parent says the cursor moved elsewhere", async () => {
    const read = vi.fn(async () => digest());
    const view = render(
      React.createElement(ReviewDigestStrip, {
        target,
        read,
        advance: vi.fn(),
        refreshKey: 0,
      })
    );
    await screen.findByText(/Since you last looked/);
    view.rerender(
      React.createElement(ReviewDigestStrip, {
        target,
        read,
        advance: vi.fn(),
        refreshKey: 1,
      })
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("switching missions never shows the previous thread's delta under the new name", async () => {
    // The MissionCapState trap, in a different panel: a slow read for mission B
    // must not leave mission A's counts on screen claiming to describe B.
    let release: (() => void) | null = null;
    const read = vi.fn(async (input: { targetId: string }) => {
      if (input.targetId === "task-1") return digest();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return digest({ handoffs: [], approvals: [], openQuestionIds: [] });
    });
    const view = render(
      React.createElement(ReviewDigestStrip, { target, read, advance: vi.fn() })
    );
    await screen.findByText(/Still blocking: 1 degraded packet/);

    view.rerender(
      React.createElement(ReviewDigestStrip, {
        target: { targetKind: "task", targetId: "task-2" } as const,
        read,
        advance: vi.fn(),
      })
    );
    // The old delta is GONE the instant the thread changed, not when the new
    // read lands.
    await waitFor(() =>
      expect(screen.queryByText(/Since you last looked \(.*2 packets/)).toBeNull()
    );
    expect(screen.getByText(/Reading what changed/)).toBeTruthy();
    release?.();
    await screen.findByText(/Nothing new since you last looked/);
  });

  it("an unreadable digest is an OUTAGE, never a silent 'nothing changed'", async () => {
    render(
      React.createElement(ReviewDigestStrip, {
        target,
        read: vi.fn(async () => {
          throw new Error("brain unreachable at http://127.0.0.1:4000");
        }),
        advance: vi.fn(),
      })
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/brain unreachable/);
    expect(alert.textContent).toMatch(/not an all-clear/i);
    expect(screen.queryByText(/Nothing new since you last looked/)).toBeNull();
    // Not a dead end: the outage is retryable from where it is reported.
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("Retry re-reads after an outage and never advances the cursor", async () => {
    let down = true;
    const read = vi.fn(async () => {
      if (down) throw new Error("brain unreachable");
      return digest();
    });
    const advance = vi.fn();
    render(React.createElement(ReviewDigestStrip, { target, read, advance }));

    await screen.findByRole("alert");
    down = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/Still blocking: 1 degraded packet/);
    expect(advance).not.toHaveBeenCalled();
  });

  it("a failed Mark reviewed says so and leaves the delta on screen", async () => {
    render(
      React.createElement(ReviewDigestStrip, {
        target,
        read: vi.fn(async () => digest()),
        advance: vi.fn(async () => {
          throw new Error("advance refused: operator tier required");
        }),
      })
    );
    fireEvent.click(await screen.findByRole("button", { name: "Mark reviewed" }));
    expect(await screen.findByText(/operator tier required/)).toBeTruthy();
    // The delta is still on screen — a failed stamp hides nothing.
    expect(
      document.querySelector(".review-digest-headline")?.textContent
    ).toMatch(/2 packets/);
  });

  it("a build without the read leg says so rather than showing an empty delta", () => {
    render(React.createElement(ReviewDigestStrip, { target, read: undefined }));
    const strip = document.querySelector(".review-digest-strip");
    expect(strip?.textContent).toMatch(/cannot read the bound review thread/i);
    expect(strip?.textContent).not.toMatch(/Nothing new/);
  });

  it("no bound mission: an explained empty state, not a blank strip", () => {
    render(
      React.createElement(ReviewDigestStrip, {
        target: null,
        read: vi.fn(),
      })
    );
    expect(
      document.querySelector(".review-digest-strip")?.textContent
    ).toMatch(/No mission is bound to this dock yet/i);
  });

  it("an empty delta on a stamped cursor offers no pointless acknowledge", async () => {
    render(
      React.createElement(ReviewDigestStrip, {
        target,
        read: vi.fn(async () =>
          digest({ handoffs: [], approvals: [], openQuestionIds: [] })
        ),
        advance: vi.fn(),
      })
    );
    await screen.findByText(/Nothing new since you last looked/);
    expect(screen.queryByRole("button", { name: "Mark reviewed" })).toBeNull();
  });
});
