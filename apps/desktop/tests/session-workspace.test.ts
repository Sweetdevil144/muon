// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUDGET_EXHAUSTED_MARKER } from "@muon/client";
import { SessionWorkspace } from "../src/renderer/session-workspace.js";

// The Terminal tab body wires a REAL XTerm view in production; in jsdom we swap
// it for a fake so the integration (tab appears → opens the byte channel) is
// testable without a canvas/DOM-measuring terminal.
vi.mock("../src/renderer/lib/xterm-view.js", () => ({
  createXtermView: () => ({
    write: vi.fn(),
    onInput: () => ({ dispose: vi.fn() }),
    onResize: () => ({ dispose: vi.fn() }),
    markExited: vi.fn(),
    dispose: vi.fn(),
  }),
}));

afterEach(cleanup);

const AGENT = {
  id: "agent-1",
  vendor: "codex",
  name: "codex-1",
  ordinal: 1,
  status: "working",
  currentTaskId: "task-1",
  currentJobId: "job-1",
} as const;

const JOB = {
  id: "job-1",
  kind: "session",
  vendor: "codex",
  taskId: "task-1",
  brief: "b",
  status: "running",
  dispatchedBy: "orchestrator",
  interruptRequested: false,
  steerMessages: [],
  capabilityMode: "delegate",
  parentJobId: "root-1",
  rootJobId: "root-1",
  delegationDepth: 1,
  maxDelegationDepth: 3,
  maxChildren: 3,
  maxTotalDescendants: 8,
  maxWallMs: 600_000,
  workspacePath: "/repo",
  createdAt: "2026-07-16T10:00:00.000Z",
} as const;

function stubMuon(overrides: Record<string, unknown> = {}) {
  Object.assign(window, {
    muon: {
      streams: vi.fn().mockResolvedValue([]),
      // The resume probe defaults to READY so affordance tests exercise the
      // full door; the dead-button suite overrides it to `unavailable`.
      jobResumeProbe: vi.fn().mockResolvedValue({
        status: "ready",
        vendor: "codex",
        sessionId: "019fa043-e5c2-7731-b2f3-11312f91d2d2",
      }),
      reviewDiff: vi.fn().mockResolvedValue({ status: "degraded", reason: "not under test" }),
      workspaceReview: vi.fn().mockResolvedValue({
        status: "unavailable",
        workspacePath: "/repo",
        files: [],
        stat: "",
        diffText: "",
        truncated: false,
        totalBytes: 0,
        maxBytes: 262_144,
      }),
      ...overrides,
    },
  });
}

/**
 * The worker Overview printed `MODEL: Vendor default`, a placeholder in the
 * slot where a model name belongs. It now prints what MUON dispatched with, or
 * what the vendor reports, or — when neither is known — who picks, which is
 * affirmative on the surface and fully explained on hover.
 */
describe("SessionWorkspace model row", () => {
  function renderWith(job: unknown, resolveVendorModel?: unknown) {
    stubMuon(resolveVendorModel ? { resolveVendorModel } : {});
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job,
        taskTitle: "t",
        events: [],
        readiness: [],
        onClose: vi.fn(),
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );
  }

  it("prints the model MUON dispatched with, when it named one", async () => {
    const resolveVendorModel = vi.fn();
    renderWith(
      { ...JOB, actionProfilePatch: { model: "gpt-5.6-terra" } },
      resolveVendorModel
    );
    expect(await screen.findByText("gpt-5.6-terra")).toBeTruthy();
    // No probe: the dispatch record already answered.
    expect(resolveVendorModel).not.toHaveBeenCalled();
  });

  it("asks the vendor when MUON named none, and prints what it reports", async () => {
    const resolveVendorModel = vi.fn().mockResolvedValue({
      vendor: "codex",
      model: "gpt-5.6-sol",
      state: "reported",
      probe: "codex doctor --json",
    });
    renderWith(JOB, resolveVendorModel);
    expect(
      await screen.findByText("gpt-5.6-sol · Codex default")
    ).toBeTruthy();
    expect(resolveVendorModel).toHaveBeenCalledWith("codex");
  });

  it("names who picks rather than printing 'Vendor default'", async () => {
    const resolveVendorModel = vi.fn().mockResolvedValue({
      vendor: "codex",
      model: null,
      state: "probe-failed",
      reason: "codex doctor --json failed: not installed",
    });
    renderWith(JOB, resolveVendorModel);
    expect(await screen.findByText("Codex picks")).toBeTruthy();
    expect(screen.queryByText("Vendor default")).toBeNull();
    // The failure is not swallowed — it is the hover explanation.
    expect(
      screen.getByTitle(/codex doctor --json failed: not installed/)
    ).toBeTruthy();
  });

  it("stays honest when the probe bridge is missing entirely", async () => {
    renderWith(JOB);
    expect(await screen.findByText("Codex picks")).toBeTruthy();
    expect(screen.queryByText("Vendor default")).toBeNull();
  });
});

describe("SessionWorkspace terminal preview (Wave 4 slice 5.0.3)", () => {
  it("hides the live Terminal tab by default (feature-guarded off)", () => {
    stubMuon();
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job: JOB,
        taskTitle: "t",
        events: [],
        readiness: [],
        onClose: vi.fn(),
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );
    expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
  });

  /**
   * U1 — the defect this suite now pins.
   *
   * Opening a dispatched worker's Terminal used to mount the same component the
   * standalone "+ Terminal" tab uses, keyed on the agent's VENDOR — so a click
   * launched a second, fresh, interactive vendor CLI in the job's worktree. The
   * human saw a stranger's session; MUON ran a process nobody asked for.
   */
  it("renders the JOB's recorded stream and spawns NOTHING when the Terminal tab is opened", async () => {
    const open = vi
      .fn()
      .mockResolvedValue({ post: vi.fn(), onFrame: vi.fn(), close: vi.fn() });
    stubMuon({
      terminal: { open },
      streams: vi.fn().mockResolvedValue([
        {
          seq: 1,
          kind: "output",
          content: "cloning the GitNexus web frontend",
          taskId: "task-1",
          laneId: "lane-1",
          timestamp: "2026-07-26T10:00:00.000Z",
        },
      ]),
    });
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job: JOB,
        taskTitle: "t",
        events: [],
        readiness: [],
        terminalPreview: true,
        onClose: vi.fn(),
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );

    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));

    // The job's own stream — the same content read_stream returns.
    expect(
      await screen.findByText(/cloning the GitNexus web frontend/)
    ).toBeTruthy();
    // …and the mode is stated, never implied.
    expect(
      screen.getByText(/Live activity — this agent is working/)
    ).toBeTruthy();
    // The load-bearing assertion: no vendor process was started.
    expect(open).not.toHaveBeenCalled();
  });

  /**
   * Finding 6 — this pane was just repurposed from "read afterward" to "watch
   * the agent work live", polling every SESSION_POLL_ACTIVE_MS (700ms) while
   * the job runs. It used to force `scrollTop = scrollHeight` on every poll
   * with no guard, yanking a human who scrolled up to read earlier activity
   * back to the bottom ~1.4x/sec. It must now follow chat.tsx's
   * stickToBottomRef idiom: once the human has scrolled away from the
   * bottom, a newly arrived chunk must not move their scroll position.
   */
  it("does not yank the activity feed back to bottom when a new chunk arrives after the human scrolled up", async () => {
    let call = 0;
    const chunk = (seq: number, content: string) => ({
      seq,
      kind: "output" as const,
      content,
      taskId: "task-1",
      laneId: "lane-1",
      timestamp: "2026-07-26T10:00:00.000Z",
    });
    stubMuon({
      streams: vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) return [chunk(1, "first chunk of activity")];
        if (call === 2) return [chunk(2, "second chunk of activity")];
        return [];
      }),
    });
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job: JOB, // status: "running" — the active poll cadence applies.
        taskTitle: "t",
        events: [],
        readiness: [],
        terminalPreview: true,
        onClose: vi.fn(),
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    await screen.findByText(/first chunk of activity/);

    const feed = document.querySelector(".job-feed") as HTMLElement;
    expect(feed).not.toBeNull();
    // jsdom never computes real layout, so scrollHeight/clientHeight/scrollTop
    // are stubbed directly — the same values a human's "scrolled up" position
    // would produce: scrollHeight - scrollTop - clientHeight (700) far exceeds
    // the near-bottom threshold (80px, see isNearBottom).
    Object.defineProperty(feed, "scrollHeight", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(feed, "clientHeight", {
      value: 200,
      configurable: true,
    });
    let scrollTop = 100;
    Object.defineProperty(feed, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
      configurable: true,
    });
    fireEvent.scroll(feed);

    await screen.findByText(/second chunk of activity/, undefined, {
      timeout: 3000,
    });
    // The guard held: the poll's new chunk did not reset scroll position.
    expect(feed.scrollTop).toBe(100);
  });

  it("starts a fresh vendor session ONLY from an explicit, labelled click", async () => {
    const open = vi
      .fn()
      .mockResolvedValue({ post: vi.fn(), onFrame: vi.fn(), close: vi.fn() });
    stubMuon({ terminal: { open } });
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job: JOB,
        taskTitle: "t",
        events: [],
        readiness: [],
        terminalPreview: true,
        onClose: vi.fn(),
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );

    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(open).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Start a new Codex session in this worktree/,
      })
    );
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith("terminal-job-1", {
        file: "codex",
        cwd: ".",
      })
    );
    // The new session announces that it is NOT the dispatched agent.
    expect(screen.getByText(/shares none of its history/)).toBeTruthy();
  });

  it("promotes 'open the real session' to the TOP as the primary action once the job finished", async () => {
    const open = vi
      .fn()
      .mockResolvedValue({ post: vi.fn(), onFrame: vi.fn(), close: vi.fn() });
    stubMuon({ terminal: { open } });
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job: {
          ...JOB,
          status: "done",
          vendorSessionId: "019fa043-e5c2-7731-b2f3-11312f91d2d2",
        },
        taskTitle: "t",
        events: [],
        readiness: [],
        terminalPreview: true,
        onClose: vi.fn(),
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));

    // The primary affordance names the job's OWN session. It appears only
    // after trusted main's resume probe verified the door would open (the
    // stub answers `ready`), so the lookup is async by design.
    const heading = await screen.findByText(
      /Open this job's real Codex session/
    );
    const cta = screen.getByRole("button", { name: "Open Codex session" });
    // …and sits ABOVE the governed console body, not buried in the foot.
    const badge = await screen.findByText("Nothing recorded");
    expect(
      heading.compareDocumentPosition(badge) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // Clicking it resumes the DISPATCHED session (the `.resume` coordinate +
    // the `<vendor>:resume` kind — the host re-derives everything else).
    fireEvent.click(cta);
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith("terminal-job-1.resume", {
        file: "codex:resume",
        cwd: ".",
      })
    );
    // The resumed pane says whose keyboard this is.
    expect(
      screen.getByText(/typing here continues the session as you/i)
    ).toBeTruthy();
  });

  it("never offers an input affordance that could bypass the approval gate", () => {
    stubMuon({ terminal: { open: vi.fn() } });
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job: JOB,
        taskTitle: "t",
        events: [],
        readiness: [],
        terminalPreview: true,
        onClose: vi.fn(),
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    const input = screen.getByLabelText(
      "Send input to this agent"
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(
      screen.getByText(/would bypass the approval gate/)
    ).toBeTruthy();
  });

  it("explains an empty stream instead of rendering a blank terminal", async () => {
    stubMuon({ terminal: { open: vi.fn() } });
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job: { ...JOB, status: "done" },
        taskTitle: "t",
        events: [],
        readiness: [],
        terminalPreview: true,
        onClose: vi.fn(),
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(
      await screen.findByText(/This job recorded no output/)
    ).toBeTruthy();
  });

  it("surfaces a stream read failure on the Terminal body, never a blank panel", async () => {
    stubMuon({
      terminal: { open: vi.fn() },
      streams: vi.fn().mockRejectedValue(new Error("brain unreachable")),
    });
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job: JOB,
        taskTitle: "t",
        events: [],
        readiness: [],
        terminalPreview: true,
        onClose: vi.fn(),
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/brain unreachable/)).toBeTruthy();
  });

  /**
   * F2 — THE PROBE MUST NOT LATCH ITS FIRST ANSWER FOR THE WHOLE RUN.
   *
   * The effect keys on (jobId, vendorSessionId, jobStatus) and none of those
   * changes again while a job runs, so a single miss was the pane's answer
   * until the human switched workspace tabs and back. The miss is the COMMON
   * case, not the exotic one: the probe fires about a second after the id is
   * stamped, and a `codex exec` rollout was measured appearing 3 seconds into a
   * 30-second run.
   */
  describe("the takeover probe re-asks a NOT-YET, boundedly", () => {
    const RUNNING = {
      ...JOB,
      status: "running",
      vendorSessionId: "019fa043-e5c2-7731-b2f3-11312f91d2d2",
    };
    const NOT_YET = {
      status: "unavailable",
      pending: true,
      reason: "Codex has not saved this job's session to its store yet.",
    };

    function renderRunning(jobResumeProbe: unknown) {
      stubMuon({ jobResumeProbe, terminal: { open: vi.fn() } });
      render(
        React.createElement(SessionWorkspace, {
          agent: AGENT,
          job: RUNNING,
          taskTitle: "t",
          events: [],
          readiness: [],
          terminalPreview: true,
          onClose: vi.fn(),
        } as unknown as Parameters<typeof SessionWorkspace>[0])
      );
      fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    }

    it("re-asks until the vendor saves the session, then stops", async () => {
      vi.useFakeTimers();
      try {
        const probe = vi
          .fn()
          .mockResolvedValueOnce(NOT_YET)
          .mockResolvedValueOnce(NOT_YET)
          .mockResolvedValue({
            status: "ready",
            vendor: "codex",
            sessionId: RUNNING.vendorSessionId,
            mode: "fork",
          });
        renderRunning(probe);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(probe).toHaveBeenCalledTimes(1);
        // …and the wording is a wait, not a verdict.
        expect(screen.getByText(/can't be opened yet/)).toBeTruthy();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(4_100);
        });
        expect(probe).toHaveBeenCalledTimes(3);
        // The door the founder could not reach for the whole run.
        expect(
          screen.getByRole("button", { name: "Fork into Codex" })
        ).toBeTruthy();

        // A `ready` answer ends the re-asking; this is not a standing poll.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(probe).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops after a bounded number of tries, and the human can still re-check", async () => {
      vi.useFakeTimers();
      try {
        const probe = vi.fn().mockResolvedValue(NOT_YET);
        renderRunning(probe);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(probe).toHaveBeenCalledTimes(1);

        // Far longer than the whole retry budget: it must NOT keep going.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10 * 60_000);
        });
        const settled = probe.mock.calls.length;
        expect(settled).toBe(21); // the first ask + 20 bounded retries
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10 * 60_000);
        });
        expect(probe).toHaveBeenCalledTimes(settled);

        // …and the human's explicit way past the budget still works.
        fireEvent.click(screen.getByRole("button", { name: "Check again" }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(probe).toHaveBeenCalledTimes(settled + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never re-asks a HARD refusal", async () => {
      vi.useFakeTimers();
      try {
        const probe = vi.fn().mockResolvedValue({
          status: "unavailable",
          reason: "this job belongs to a different mission.",
        });
        renderRunning(probe);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(probe).toHaveBeenCalledTimes(1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(probe).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/can't be reopened/)).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("SessionWorkspace", () => {
  it("keeps the full dispatch brief collapsed so detail navigation stays visible", () => {
    stubMuon();
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job: {
          ...JOB,
          brief: "A very long dispatch brief ".repeat(80),
        },
        taskTitle: "Bounded task",
        events: [],
        readiness: [],
        onClose: vi.fn(),
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );

    const brief = screen.getByText("Dispatch brief").closest("details");
    expect(brief?.hasAttribute("open")).toBe(false);
    expect(screen.getByRole("tab", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Timeline" })).toBeTruthy();
  });

  it("shows a complete session contract and detailed native command visibility", async () => {
    Object.assign(window, {
      muon: {
        streams: vi.fn().mockResolvedValue([]),
        reviewDiff: vi.fn().mockResolvedValue({ status: "degraded", reason: "not under test" }),
        workspaceReview: vi.fn().mockResolvedValue({
          status: "available",
          workspacePath: "/repo",
          branch: "codex/wave-2",
          stagedFiles: ["src/parser.ts"],
          unstagedFiles: [],
          files: ["src/parser.ts"],
          stat: "1 file changed, 8 insertions(+), 2 deletions(-)",
          fileStats: [
            { path: "src/parser.ts", additions: 8, deletions: 2, binary: false },
          ],
          diffText:
            "diff --git a/src/parser.ts b/src/parser.ts\n+export function parse() {}",
          truncated: false,
          totalBytes: 72,
          maxBytes: 262_144,
        }),
      },
    });

    render(
      React.createElement(SessionWorkspace, {
        agent: {
          id: "agent-1",
          vendor: "codex",
          name: "codex-1",
          ordinal: 1,
          status: "working",
          currentTaskId: "task-1",
          currentJobId: "job-1",
        },
        job: {
          id: "job-1",
          kind: "session",
          vendor: "codex",
          taskId: "task-1",
          brief: "Review the parser implementation",
          status: "running",
          dispatchedBy: "orchestrator",
          interruptRequested: false,
          steerMessages: [],
          capabilityMode: "delegate",
          parentJobId: "root-1",
          rootJobId: "root-1",
          delegationDepth: 1,
          maxDelegationDepth: 3,
          maxChildren: 3,
          maxTotalDescendants: 8,
          maxWallMs: 600_000,
          workspacePath: "/repo",
          createdAt: "2026-07-16T10:00:00.000Z",
        },
        taskTitle: "Parser review",
        events: [],
        readiness: [
          {
            vendor: "codex",
            installed: true,
            authenticated: true,
            credentialMethod: "vendor-login",
            detail: "Codex native login is ready",
          },
        ],
        onClose: vi.fn(),
      })
    );

    expect(screen.getByRole("heading", { name: "Parser review" })).toBeTruthy();
    expect(screen.getByText("Work only")).toBeTruthy();
    expect(screen.getByText("Depth 1 of 3")).toBeTruthy();
    expect(screen.getByText("/repo")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.getByText("Review working tree")).toBeTruthy();
    expect(screen.getAllByText(/runs through|approval/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/input|scope/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(await screen.findByText("src/parser.ts")).toBeTruthy();
    expect(
      screen.getByText("1 file changed, 8 insertions(+), 2 deletions(-)")
    ).toBeTruthy();
    expect(screen.getByText(/\+export function parse/)).toBeTruthy();
  });

  // ── S8: crew-click → live stream view ───────────────────────────────────
  it("opens directly on the Timeline section when initialSection is 'timeline', and streams the session on mount", async () => {
    const streams = vi.fn().mockResolvedValue([
      { seq: 1, kind: "assistant", content: "Investigating the flaky test now." },
    ]);
    Object.assign(window, {
      muon: {
        streams,
        reviewDiff: vi.fn().mockResolvedValue({ status: "degraded", reason: "not under test" }),
        workspaceReview: vi.fn().mockResolvedValue({
          status: "degraded",
          reason: "n/a",
          action: "n/a",
        }),
      },
    });

    render(
      React.createElement(SessionWorkspace, {
        agent: {
          id: "agent-1",
          vendor: "codex",
          name: "codex-1",
          ordinal: 1,
          status: "working",
          currentTaskId: "task-1",
          currentJobId: "job-1",
        },
        job: {
          id: "job-1",
          kind: "session",
          vendor: "codex",
          taskId: "task-1",
          brief: "Investigate the flaky test",
          status: "running",
          dispatchedBy: "orchestrator",
          interruptRequested: false,
          steerMessages: [],
          capabilityMode: "delegate",
          workspacePath: "/repo",
          createdAt: "2026-07-16T10:00:00.000Z",
        },
        taskTitle: "Flaky test triage",
        events: [],
        readiness: null,
        initialSection: "timeline",
        onClose: vi.fn(),
      })
    );

    // Renders selected on the live Timeline tab immediately, no extra click.
    expect(
      screen.getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")
    ).toBe("true");
    expect(streams).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "job-1" })
    );
    expect(
      await screen.findByText("Investigating the flaky test now.")
    ).toBeTruthy();
  });

  it("still defaults to Overview when initialSection is omitted (back-compat, unchanged behaviour)", () => {
    Object.assign(window, {
      muon: {
        streams: vi.fn().mockResolvedValue([]),
        reviewDiff: vi.fn().mockResolvedValue({ status: "degraded", reason: "not under test" }),
        workspaceReview: vi.fn().mockResolvedValue({
          status: "degraded",
          reason: "n/a",
          action: "n/a",
        }),
      },
    });

    render(
      React.createElement(SessionWorkspace, {
        agent: {
          id: "agent-1",
          vendor: "codex",
          name: "codex-1",
          ordinal: 1,
          status: "working",
          currentTaskId: "task-1",
          currentJobId: "job-1",
        },
        job: null,
        taskTitle: "Flaky test triage",
        events: [],
        readiness: null,
        onClose: vi.fn(),
      })
    );

    expect(
      screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")
    ).toBe("false");
  });
});

describe("SessionWorkspace inline governance gate (Wave 4.1)", () => {
  const PENDING_GATE = {
    id: "approval-9",
    taskId: "task-1",
    jobId: "job-1",
    requestedBy: "codex",
    kind: "command",
    reason: "Write the bounded parser fix",
    status: "pending",
    evidence: {
      action: "Edit",
      scope: "src/parser/bounded.ts",
      impactIfApproved: "Writes the bounded parser fix to disk.",
      riskLevel: "medium",
      // A digest is what makes an action REMEMBERABLE at all — no digest, no
      // receipt (the server's own rule).
      payloadDigest: "e".repeat(64),
      details: { path: "src/parser/bounded.ts" },
    },
  } as const;

  /** Network egress: always asks, can never be remembered. */
  const ALWAYS_ASK_GATE = {
    ...PENDING_GATE,
    evidence: {
      ...PENDING_GATE.evidence,
      action: "WebFetch",
      scope: "https://example.com",
      details: { url: "https://example.com" },
    },
  } as const;

  function renderTab(over: Record<string, unknown>) {
    stubMuon();
    const onReviewApproval = vi.fn();
    const onOpenBrain = vi.fn();
    const onResolveApproval = vi.fn();
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job: JOB,
        taskTitle: "t",
        events: [],
        readiness: [],
        onReviewApproval,
        onOpenBrain,
        // Production wiring: app.tsx hands the inline gate the SAME governed
        // resolve the dock rail uses.
        onResolveApproval,
        onClose: vi.fn(),
        ...over,
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );
    return { onReviewApproval, onOpenBrain, onResolveApproval };
  }

  const gateActions = () =>
    Array.from(
      screen
        .getByRole("region", { name: "Pending decision for this agent" })
        .querySelectorAll<HTMLButtonElement>("[data-approval-action]")
    );

  it("surfaces the fail-closed gate bound to THIS agent, co-located at the tab", () => {
    renderTab({ approvals: [PENDING_GATE] });
    const banner = screen.getByRole("region", {
      name: "Pending decision for this agent",
    });
    expect(banner.textContent).toContain("Needs your decision");
    expect(banner.textContent).toMatch(/paused until you decide/);
    // The governed projection (buildApprovalReview) rides through verbatim.
    expect(banner.textContent).toContain("Edit");
    expect(banner.textContent).toContain("src/parser/bounded.ts");
    // Fail-closed framing is explicit, not implied.
    expect(banner.textContent).toMatch(/Fail-closed/);
  });

  it("offers EXACTLY three actions and nothing else — no navigation competing with the decision", () => {
    const { onReviewApproval } = renderTab({ approvals: [PENDING_GATE] });
    const banner = screen.getByRole("region", {
      name: "Pending decision for this agent",
    });
    expect(
      Array.from(banner.querySelectorAll("button")).map((b) => b.textContent)
    ).toEqual(["Approve", "Approve, don’t ask again", "Reject"]);
    // The old hops are gone: nothing here navigates away from the decision.
    expect(screen.queryByRole("button", { name: /Review & decide/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Open full evidence/i })
    ).toBeNull();
    expect(onReviewApproval).not.toHaveBeenCalled();
  });

  it("each action makes its own governed call; 'don't ask again' rides the existing receipt consent", async () => {
    const { onResolveApproval } = renderTab({ approvals: [PENDING_GATE] });
    const [approve, remember, reject] = gateActions();

    fireEvent.click(approve!);
    await vi.waitFor(() =>
      expect(onResolveApproval).toHaveBeenLastCalledWith(
        "approval-9",
        "approved"
      )
    );

    await vi.waitFor(() =>
      expect(remember!.hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(remember!);
    await vi.waitFor(() =>
      expect(onResolveApproval).toHaveBeenLastCalledWith(
        "approval-9",
        "approved",
        900_000
      )
    );

    // Reject: one click, never disabled, never behind a confirm.
    await vi.waitFor(() => expect(reject!.hasAttribute("disabled")).toBe(false));
    fireEvent.click(reject!);
    await vi.waitFor(() =>
      expect(onResolveApproval).toHaveBeenLastCalledWith(
        "approval-9",
        "rejected"
      )
    );
  });

  it("says on screen exactly how far 'don't ask again' reaches", () => {
    renderTab({ approvals: [PENDING_GATE] });
    const banner = screen.getByRole("region", {
      name: "Pending decision for this agent",
    });
    expect(banner.textContent).toContain(
      "Auto-approves this exact action, in this run, for the next 15 minutes."
    );
    expect(gateActions()[1]!.getAttribute("title")).toContain(
      "in this run, for the next 15 minutes"
    );
  });

  it("keeps the row three-wide for an always-ask action, and says why it cannot be remembered", () => {
    renderTab({ approvals: [ALWAYS_ASK_GATE] });
    const [approve, remember, reject] = gateActions();
    expect(gateActions()).toHaveLength(3);
    expect(approve!.hasAttribute("disabled")).toBe(false);
    expect(remember!.hasAttribute("disabled")).toBe(true);
    expect(reject!.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByRole("region", { name: "Pending decision for this agent" })
        .textContent
    ).toContain("This one always asks");
  });

  it("a merge gate routes to the evidence dialog instead of an approve MUON must refuse", () => {
    const { onReviewApproval, onResolveApproval } = renderTab({
      approvals: [{ ...PENDING_GATE, kind: "merge", evidence: undefined }],
    });
    expect(
      screen
        .getByRole("region", { name: "Pending decision for this agent" })
        .querySelector("[data-approval-action]")
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Review & decide/i }));
    expect(onReviewApproval).toHaveBeenCalledWith("approval-9");
    expect(onResolveApproval).not.toHaveBeenCalled();
  });

  it("surfaces a refused decision in place and leaves the gate pending", async () => {
    const onResolveApproval = vi
      .fn()
      .mockRejectedValue(new Error("The selected chat changed before the decision."));
    renderTab({ approvals: [PENDING_GATE], onResolveApproval });
    fireEvent.click(gateActions()[0]!);
    await vi.waitFor(() =>
      expect(
        screen.getByText(/The selected chat changed before the decision\./)
      ).toBeTruthy()
    );
    expect(
      screen.getByRole("region", { name: "Pending decision for this agent" })
    ).toBeTruthy();
  });

  it("a calm tab stays calm — no pending gate → no banner", () => {
    renderTab({ approvals: [] });
    expect(
      screen.queryByRole("region", { name: "Pending decision for this agent" })
    ).toBeNull();
  });

  it("a decided approval is history, not a live gate", () => {
    renderTab({ approvals: [{ ...PENDING_GATE, status: "approved" }] });
    expect(
      screen.queryByRole("region", { name: "Pending decision for this agent" })
    ).toBeNull();
  });

  it("a gate for a DIFFERENT job on the same task does not hijack this tab", () => {
    renderTab({ approvals: [{ ...PENDING_GATE, jobId: "job-OTHER" }] });
    expect(
      screen.queryByRole("region", { name: "Pending decision for this agent" })
    ).toBeNull();
  });

  it("fail-closed: a missing review handler never HIDES the pending gate", () => {
    stubMuon();
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job: JOB,
        taskTitle: "t",
        events: [],
        readiness: [],
        approvals: [PENDING_GATE],
        // No onReviewApproval wired.
        onClose: vi.fn(),
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );
    const banner = screen.getByRole("region", {
      name: "Pending decision for this agent",
    });
    // The decision is still visible; only the in-place action degrades to a
    // pointer at the review panel — the gate is never silently swallowed.
    expect(banner.textContent).toContain("Edit");
    expect(
      screen.queryByRole("button", { name: /Review & decide/i })
    ).toBeNull();
    expect(banner.querySelector("[data-approval-action]")).toBeNull();
    expect(banner.textContent).toMatch(/Decide from the review panel/);
  });

  // P0-1 — the founder's screenshot: FULL AUTO on, and the tab simultaneously
  // read "NEEDS YOUR DECISION … this agent is paused … nothing runs on your
  // behalf". Full Auto was working; the renderer (2s poll) simply painted the
  // gate before the auto-approver (5s poll) resolved it. The card must tell the
  // truth in BOTH branches instead of racing.
  describe("under Full Auto standing consent", () => {
    it("never calls an about-to-be-granted gate a human pause", () => {
      renderTab({
        approvals: [PENDING_GATE],
        fullAuto: true,
        // F7: the calm label is opt-in per id — main's approver tick must have
        // POSITIVELY covered it. Absence from this list is a human gate.
        fullAutoCoveredApprovalIds: ["approval-9"],
        fullAutoUncoveredApprovalIds: [],
      });
      expect(
        screen.queryByRole("region", { name: "Pending decision for this agent" })
      ).toBeNull();
      // …and it is not hidden either — hiding would be the opposite lie.
      const banner = screen.getByRole("region", {
        name: "Approving automatically for this agent",
      });
      expect(banner.textContent).toMatch(/Approving for you/);
      expect(banner.textContent).toMatch(/Full Auto is on/);
      expect(banner.textContent).not.toMatch(/paused until you decide/);
      expect(banner.textContent).not.toMatch(/Nothing runs on your behalf/);
      // The governed projection still rides through verbatim: the operator can
      // still see exactly what was approved as them.
      expect(banner.textContent).toContain("Edit");
      expect(banner.textContent).toContain("src/parser/bounded.ts");
      // Nothing for the human to do, so no decide affordance pretending
      // otherwise — and no second consent click site for standing consent.
      expect(
        screen.queryByRole("button", { name: /Review & decide/i })
      ).toBeNull();
      expect(banner.querySelector("[data-approval-action]")).toBeNull();
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    });

    it("puts the FAIL-CLOSED gate back when standing consent could not grant it", () => {
      renderTab({
        approvals: [PENDING_GATE],
        fullAuto: true,
        // The brain refused this grant (or it never landed inside the grace
        // window) — e.g. a merge whose review certification is blocked.
        fullAutoUncoveredApprovalIds: ["approval-9"],
      });
      expect(
        screen.queryByRole("region", {
          name: "Approving automatically for this agent",
        })
      ).toBeNull();
      const banner = screen.getByRole("region", {
        name: "Pending decision for this agent",
      });
      expect(banner.textContent).toContain("Needs your decision");
      expect(banner.textContent).toMatch(/paused until you decide/);
      // …and it says WHY this one still needs a human despite Full Auto.
      expect(banner.textContent).toMatch(/Full Auto could not grant this one/);
      // …and the human gets the full three-action decision back.
      expect(gateActions()).toHaveLength(3);
    });

    it("is inert with Full Auto off — the gate reads exactly as it always has", () => {
      renderTab({ approvals: [PENDING_GATE], fullAuto: false });
      const banner = screen.getByRole("region", {
        name: "Pending decision for this agent",
      });
      expect(banner.textContent).toMatch(
        /Fail-closed — this agent stays paused until you decide\. Nothing runs on your behalf\./
      );
      expect(banner.textContent).not.toMatch(/Full Auto/);
      expect(
        screen.queryByRole("region", {
          name: "Approving automatically for this agent",
        })
      ).toBeNull();
    });
  });
});

/**
 * The machine classifier is for MACHINES. `[muon:budget-exhausted]` is the token
 * every consumer keys on to tell "MUON stopped this at its own deadline" from
 * "a human interrupted it" — and the operator was reading it verbatim in the
 * Changes tab while the crew rail beside it stripped the same tag. One stripper,
 * shared, living with the marker it strips.
 */
describe("SessionWorkspace terminal artifact", () => {
  const BUDGET_KILL_RESULT =
    `${BUDGET_EXHAUSTED_MARKER} MUON stopped codex: its own wall-clock budget ` +
    "of 600s ran out after 603s of work. No human interrupted this run.";

  function renderChangesFor(result: string) {
    stubMuon();
    render(
      React.createElement(SessionWorkspace, {
        agent: AGENT,
        job: { ...JOB, status: "failed", result },
        taskTitle: "t",
        events: [],
        readiness: [],
        onClose: vi.fn(),
      } as unknown as Parameters<typeof SessionWorkspace>[0])
    );
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
  }

  it("shows the budget-kill sentence without the machine marker", async () => {
    renderChangesFor(BUDGET_KILL_RESULT);
    const artifact = await screen.findByText(/MUON stopped codex/);
    expect(artifact.textContent).toContain(
      "wall-clock budget of 600s ran out after 603s"
    );
    expect(artifact.textContent).not.toContain(BUDGET_EXHAUSTED_MARKER);
    expect(artifact.textContent).not.toContain("muon:budget");
  });

  it("leaves an ordinary terminal artifact byte-identical", async () => {
    renderChangesFor("the tests did not pass: 2 failing in api.test.ts");
    expect(
      (await screen.findByText(/the tests did not pass/)).textContent
    ).toBe("the tests did not pass: 2 failing in api.test.ts");
  });
});
