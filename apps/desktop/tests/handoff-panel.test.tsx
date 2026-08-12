// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HandoffPanel } from "../src/renderer/handoff-panel.js";
import { classifyHandoffPacket } from "@muon/client/handoff-view";
import { readTaskHandoffPage } from "../src/lib/handoff-page.js";
import type { TaskHandoffPage, TaskHandoffView } from "../src/shared/ipc.js";

afterEach(cleanup);

/**
 * Parity item 3. The properties that matter are all about NOT overclaiming:
 * a failed read is not "no handoff", a packet that failed validation is not a
 * pass, and a check's outcome vocabulary survives (skipped ≠ passed).
 */
/** Open the disclosure — the panel is demand-driven, so nothing loads until then. */
function open() {
  // jsdom does not implement the summary-click → toggle behaviour, so drive
  // the element's own state and fire the event React listens for.
  const details = document.querySelector("details.handoff-panel");
  if (!details) throw new Error("handoff panel is not rendered");
  (details as HTMLDetailsElement).open = !(details as HTMLDetailsElement).open;
  fireEvent(details, new Event("toggle", { bubbles: false }));
}

function page(items: TaskHandoffView[], omitted = 0): TaskHandoffPage {
  return { items, omitted };
}

function view(overrides: Partial<TaskHandoffView> = {}): TaskHandoffView {
  return {
    id: "h-1",
    packetTitle: "Implemented the retry cap",
    packetBody: "Changed charge() to cap retries at 30s.",
    contract: "typed",
    status: "delivered",
    createdAt: "2026-08-11T00:00:00.000Z",
    fromLane: "codex",
    toLane: "claude-code",
    changedFiles: ["src/pay/charge.ts"],
    changedFilesOmitted: 0,
    checks: [{ name: "tests", outcome: "passed" }],
    degradedReasons: [],
    diffVerified: true,
    ...overrides,
  };
}

describe("HandoffPanel", () => {
  it("renders nothing without a task", () => {
    const { container } = render(
      <HandoffPanel taskId={null} load={vi.fn()} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("says 'not wrapped yet' for an empty list — not silence", async () => {
    render(<HandoffPanel taskId="task-1" load={vi.fn(async () => page([]))} />);
    open();
    expect(await screen.findByText(/has not wrapped/i)).toBeTruthy();
  });

  it("a FAILED read is reported, never rendered as 'no handoff'", async () => {
    render(
      <HandoffPanel
        taskId="task-1"
        load={vi.fn(async () => {
          throw new Error("brain unreachable");
        })}
      />
    );
    open();
    expect(await screen.findByText(/brain unreachable/)).toBeTruthy();
    expect(screen.queryByText(/has not wrapped/i)).toBeNull();
  });

  it("leads with MUON's contract, not the agent's title", async () => {
    render(
      <HandoffPanel
        taskId="task-1"
        load={vi.fn(async () => page([view({ contract: "packet_parse_failed" })]))}
      />
    );
    open();
    expect(
      await screen.findByText(/failed validation — treat its claims as unverified/i)
    ).toBeTruthy();
  });

  it("prose-only says absence is not a pass", async () => {
    render(
      <HandoffPanel
        taskId="task-1"
        load={vi.fn(async () => page([view({ contract: "prose_only" })]))}
      />
    );
    open();
    expect(await screen.findByText(/absence is not a pass/i)).toBeTruthy();
  });

  it("keeps the check OUTCOME vocabulary — skipped is not passed", async () => {
    render(
      <HandoffPanel
        taskId="task-1"
        load={vi.fn(async () =>
          page([view({ checks: [{ name: "tests", outcome: "skipped" }] })])
        )}
      />
    );
    open();
    expect(await screen.findByText(/tests: skipped/)).toBeTruthy();
  });

  it("agent text arrives as text, never as elements", async () => {
    render(
      <HandoffPanel
        taskId="task-1"
        load={vi.fn(async () =>
          page([view({ packetTitle: "<img src=x onerror=alert(1)>" })])
        )}
      />
    );
    open();
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img[src='x']")).toBeNull();
  });
});

describe("classifyHandoffPacket — one rule, two surfaces", () => {
  it("no packet is prose_only, and never a parse failure", () => {
    expect(classifyHandoffPacket(null).contract).toBe("prose_only");
    expect(classifyHandoffPacket(undefined).contract).toBe("prose_only");
  });

  it("garbage is packet_parse_failed, and never a throw", () => {
    expect(classifyHandoffPacket({ nope: true }).contract).toBe(
      "packet_parse_failed"
    );
    expect(classifyHandoffPacket("not an object").contract).toBe(
      "packet_parse_failed"
    );
    // The distinction that matters: a stored packet that cannot be read is
    // NOT the same fact as no packet at all.
    expect(classifyHandoffPacket({ nope: true }).contract).not.toBe(
      "prose_only"
    );
  });
});

describe("an older preload has no handoff surface at all", () => {
  it("renders NOTHING rather than claiming 'no handoff' — or crashing", () => {
    // Found by the app-level tests: their bridges stub only what they use, so
    // calling a missing `taskHandoffs` threw into the error boundary and
    // blanked the whole window. A bridge that cannot answer is not a read
    // that found nothing.
    const prior = (window as unknown as { muon?: unknown }).muon;
    (window as unknown as { muon: Record<string, unknown> }).muon = {};
    try {
      const { container } = render(<HandoffPanel taskId="task-1" />);
      expect(container.innerHTML).toBe("");
    } finally {
      (window as unknown as { muon?: unknown }).muon = prior;
    }
  });
});

describe("demand-driven, and current when it answers", () => {
  it("reads NOTHING until the panel is opened", () => {
    const load = vi.fn(async () => page([]));
    render(<HandoffPanel taskId="task-1" load={load} />);
    expect(load, "a closed panel costs no getTaskDetail").not.toHaveBeenCalled();
    open();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("re-reads on every open, so a session that wrapped meanwhile shows up", async () => {
    // The P1: a panel opened BEFORE the wrap used to claim "has not wrapped"
    // forever, because nothing re-read it.
    let wrapped = false;
    const load = vi.fn(async () => page(wrapped ? [view()] : []));
    render(<HandoffPanel taskId="task-1" load={load} />);
    open();
    expect(await screen.findByText(/has not wrapped/i)).toBeTruthy();
    open(); // close
    wrapped = true;
    open(); // reopen — fresh read
    expect(await screen.findByText("Implemented the retry cap")).toBeTruthy();
  });

  it("a slow answer for the PREVIOUS task cannot paint over the current one", async () => {
    // Handoff evidence for the wrong session is worse than none.
    const load = vi.fn(async (input: { taskId: string }) => {
      if (input.taskId === "task-slow") {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return page([view({ packetTitle: "STALE — task-slow" })]);
      }
      return page([view({ packetTitle: "current — task-fast" })]);
    });
    const { rerender } = render(
      <HandoffPanel taskId="task-slow" load={load} />
    );
    open();
    rerender(<HandoffPanel taskId="task-fast" load={load} />);
    expect(await screen.findByText("current — task-fast")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(screen.queryByText("STALE — task-slow")).toBeNull();
  });

  it("says what the bound dropped, rather than implying it showed everything", async () => {
    render(
      <HandoffPanel
        taskId="task-1"
        load={vi.fn(async () => page([view()], 7))}
      />
    );
    open();
    expect(await screen.findByText(/\+7 older handoffs not/)).toBeTruthy();
  });
});

describe("the read that wins is the LATEST one", () => {
  it("a reopen of the SAME task discards the earlier in-flight read", async () => {
    // Task id alone is not a request identity: close+reopen starts a second
    // read that the first could still satisfy, overwriting the fresher answer
    // while the panel promises "every open is a fresh read" (cubic P1).
    let call = 0;
    const load = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return page([view({ packetTitle: "FIRST read — superseded" })]);
      }
      return page([view({ packetTitle: "second read — current" })]);
    });
    render(<HandoffPanel taskId="task-1" load={load} />);
    open(); // read 1, slow
    open(); // close
    open(); // read 2, fast
    expect(await screen.findByText("second read — current")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(screen.queryByText("FIRST read — superseded")).toBeNull();
  });

  it("an answer that lands after the panel closed does not repopulate it", async () => {
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return page([view()]);
    });
    render(<HandoffPanel taskId="task-1" load={load} />);
    open();
    open(); // closed again while the read is still out
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(screen.queryByText("Implemented the retry cap")).toBeNull();
  });
});

describe("readTaskHandoffPage — what the IPC handler must not get wrong", () => {
  const page = { handoffs: [] as never[] };

  it("a FAILED read REJECTS — it never degrades into an empty page", async () => {
    // The panel's error branch is tested above and was unreachable: the
    // handler swallowed the rejection with `.catch(() => null)` and returned
    // the same value as "no handoff yet", so an unreachable brain rendered as
    // "this session has not wrapped".
    await expect(
      readTaskHandoffPage({
        read: () => Promise.reject(new Error("brain unreachable")),
        stillBound: () => true,
      })
    ).rejects.toThrow(/brain unreachable/);
  });

  it("REFUSES when the selection changed during the read", async () => {
    // Otherwise the renderer is handed the previous session's wrap packets
    // while displaying the newly selected one.
    await expect(
      readTaskHandoffPage({ read: async () => page, stillBound: () => false })
    ).rejects.toThrow(/selected chat changed/);
  });

  it("checks the binding AFTER the read resolves, not before it starts", async () => {
    // A boolean captured at call time would pass this while the real handler
    // still raced, so the check reads live state through a callback.
    let selected = "chat-a";
    const result = readTaskHandoffPage({
      read: async () => {
        selected = "chat-b";
        return page;
      },
      stillBound: () => selected === "chat-a",
    });
    await expect(result).rejects.toThrow(/selected chat changed/);
  });

  it("a resolved read with no task IS an absence — that one is not an error", async () => {
    await expect(
      readTaskHandoffPage({ read: async () => null, stillBound: () => true })
    ).resolves.toEqual({ items: [], omitted: 0 });
  });
});
