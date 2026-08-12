// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DispatchJobRecord } from "@muon/client";
import { CrewTopology } from "../src/renderer/crew-topology.js";
import type {
  CoordinationResponse,
  CrewRolesResponse,
} from "../src/shared/ipc.js";

// Every state this surface can be in must be legible: loading, empty, degraded
// (the new brain routes absent), and the full live chart with a conflict. A
// consumer must never see a blank screen or an unexplained failure.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function job(overrides: Partial<DispatchJobRecord>): DispatchJobRecord {
  return {
    id: "job-x",
    kind: "session",
    vendor: "codex",
    taskId: "task-1",
    chatId: "chat-1",
    brief: "do the thing",
    status: "running",
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    capabilityMode: "delegate",
    createdAt: "2026-07-25T11:58:00.000Z",
    startedAt: "2026-07-25T11:58:10.000Z",
    lastProgressAt: "2026-07-25T11:59:50.000Z",
    ...overrides,
  } as unknown as DispatchJobRecord;
}

const JOBS: DispatchJobRecord[] = [
  job({
    id: "root-1",
    vendor: "claude-code",
    capabilityMode: "orchestrator",
    parentJobId: null,
    rootJobId: "root-1",
    delegationDepth: 0,
  }),
  job({
    id: "lane-claude",
    vendor: "claude-code",
    parentJobId: "root-1",
    rootJobId: "root-1",
    delegationDepth: 1,
  }),
  job({
    id: "lane-codex",
    vendor: "codex",
    parentJobId: "root-1",
    rootJobId: "root-1",
    delegationDepth: 1,
  }),
  job({
    id: "sub-claude",
    vendor: "claude-code",
    parentJobId: "lane-claude",
    rootJobId: "root-1",
    delegationDepth: 2,
  }),
];

function mockBridge(overrides: Record<string, unknown> = {}) {
  const muon = {
    crewRoles: vi.fn<() => Promise<CrewRolesResponse>>(async () => ({
      status: "unavailable",
      reason: "route not in this build",
    })),
    coordination: vi.fn<() => Promise<CoordinationResponse>>(async () => ({
      status: "unavailable",
      reason: "route not in this build",
    })),
    ...overrides,
  };
  Object.assign(window, { muon });
  return muon;
}

function panel(props: Partial<React.ComponentProps<typeof CrewTopology>> = {}) {
  return React.createElement(CrewTopology, {
    chatId: "chat-1",
    orchestratorVendor: "claude-code",
    jobs: JOBS,
    fleetVendors: [],
    onOpenJob: vi.fn(),
    ...props,
  });
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof CrewTopology>> = {}
) {
  return render(panel(props));
}

/** The same crew, every job finished — a mission nothing can move again. */
const SETTLED_JOBS: DispatchJobRecord[] = JOBS.map(
  (record) => ({ ...record, status: "done" }) as DispatchJobRecord
);

/**
 * A SECOND mission opened in the SAME chat, newer than root-1.
 *
 * Mission one's crew is TERMINAL here, which is the only way this state is
 * reachable: the dispatch route refuses a second active root while one is still
 * running, and the panel now follows the root that owns the live work rather
 * than whichever root is newest (see crew-topology-live-mission.test.tsx).
 */
const SECOND_MISSION_JOBS: DispatchJobRecord[] = [
  ...SETTLED_JOBS,
  job({
    id: "root-2",
    vendor: "claude-code",
    capabilityMode: "orchestrator",
    parentJobId: null,
    rootJobId: "root-2",
    delegationDepth: 0,
    createdAt: "2026-07-25T12:10:00.000Z",
    startedAt: "2026-07-25T12:10:05.000Z",
    lastProgressAt: "2026-07-25T12:10:30.000Z",
  }),
];

describe("CrewTopology — the chart", () => {
  it("renders MUON at the center with a lane per vendor and subagents beneath", async () => {
    mockBridge();
    const { container } = renderPanel();

    const region = await screen.findByRole("region", { name: "Crew topology" });
    expect(region).toBeTruthy();
    // The hub is present and labelled MUON, not a raw vendor id.
    expect(within(region).getByText("MUON")).toBeTruthy();

    // 1 hub + 2 lanes + 1 subagent, each an absolutely positioned node card.
    expect(container.querySelectorAll(".topo-node")).toHaveLength(4);
    expect(container.querySelectorAll(".topo-node-hub")).toHaveLength(1);
    expect(container.querySelectorAll(".topo-node-lane")).toHaveLength(2);
    expect(container.querySelectorAll(".topo-node-subagent")).toHaveLength(1);

    // Edges: 2 dispatch (hub→lane) + 1 delegation (lane→subagent), no A2A.
    expect(container.querySelectorAll(".topo-edge-dispatch")).toHaveLength(2);
    expect(container.querySelectorAll(".topo-edge-delegation")).toHaveLength(1);
    expect(container.querySelectorAll(".topo-edge-a2a")).toHaveLength(0);

    // The stage owns its own size, so it scrolls inside its container rather
    // than forcing the page body sideways.
    const stage = container.querySelector<HTMLElement>(".topology-stage")!;
    expect(stage.style.width).toMatch(/^\d+px$/);
    expect(stage.style.height).toMatch(/^\d+px$/);
  });

  it("activates the clicked node's workspace tab through the caller's own path", async () => {
    mockBridge();
    const onOpenJob = vi.fn();
    renderPanel({ onOpenJob });
    await screen.findByRole("region", { name: "Crew topology" });

    const laneButton = screen.getByRole("button", {
      name: /Codex.*open this agent's workspace tab/i,
    });
    await userEvent.click(laneButton);
    expect(onOpenJob).toHaveBeenCalledWith("lane-codex");
  });

  it("never renders a clickable dead end for a seat with no dispatch", async () => {
    mockBridge();
    const { container } = renderPanel({ fleetVendors: ["cursor", "opencode"] });
    await screen.findByRole("region", { name: "Crew topology" });

    const idle = container.querySelectorAll(".topo-node.idle");
    expect(idle).toHaveLength(2);
    for (const node of idle) {
      expect(node.tagName).not.toBe("BUTTON");
      expect(node.textContent).toContain("no dispatch yet");
    }
  });
});

describe("CrewTopology — states", () => {
  it("shows a loading line for the rail's role section while the reads are in flight", async () => {
    let releaseRoles: (value: CrewRolesResponse) => void = () => {};
    mockBridge({
      crewRoles: vi.fn(
        () =>
          new Promise<CrewRolesResponse>((resolve) => {
            releaseRoles = resolve;
          })
      ),
    });
    renderPanel();
    expect(await screen.findByText("Reading role assignments…")).toBeTruthy();
    // The CHART is already on screen while the rail loads — the diagram never
    // waits on a route it does not need.
    expect(screen.getByText("MUON")).toBeTruthy();

    releaseRoles({ status: "ok", plan: null, planStatus: "none", lanes: [] });
    await waitFor(() =>
      expect(screen.queryByText("Reading role assignments…")).toBeNull()
    );
  });

  it("degrades to local dispatch state with ONE quiet note when both routes are absent", async () => {
    mockBridge();
    const { container } = renderPanel();

    const notice = await screen.findByText(
      /Roles and coordination unavailable — showing this mission from local dispatch state only\./i
    );
    expect(notice).toBeTruthy();
    // The chart is unaffected: every node and edge is still drawn.
    expect(container.querySelectorAll(".topo-node")).toHaveLength(4);
    // …and the rail names each missing source rather than going silent.
    expect(
      screen.getByText(/Roles unavailable — route not in this build/i)
    ).toBeTruthy();
  });

  it("degrades identically when the app build has NO bridge method at all", async () => {
    Object.assign(window, { muon: {} });
    const { container } = renderPanel();
    await screen.findByRole("region", { name: "Crew topology" });
    expect(container.querySelectorAll(".topo-node")).toHaveLength(4);
    expect(
      await screen.findByText(/This app build has no crew-roles bridge/i)
    ).toBeTruthy();
  });

  it("never throws or blanks when a bridge call rejects", async () => {
    mockBridge({
      crewRoles: vi.fn(async () => {
        throw new Error("That action is outside the selected chat.");
      }),
      coordination: vi.fn(async () => {
        throw new Error("brain offline");
      }),
    });
    const { container } = renderPanel();
    await screen.findByRole("region", { name: "Crew topology" });
    expect(container.querySelectorAll(".topo-node")).toHaveLength(4);
    expect(
      await screen.findByText(/That action is outside the selected chat/i)
    ).toBeTruthy();
  });

  it("renders an explained empty state (not a blank stage) for a mission with no dispatches", async () => {
    mockBridge();
    const { container } = renderPanel({ jobs: [] });
    await screen.findByRole("region", { name: "Crew topology" });
    expect(
      screen.getByText(/No lanes on this mission yet/i)
    ).toBeTruthy();
    // The MUON seat is still drawn — the screen is never empty.
    expect(container.querySelectorAll(".topo-node-hub")).toHaveLength(1);
  });
});

describe("CrewTopology — roles, conflicts, and untrusted peer text", () => {
  const roles: CrewRolesResponse = {
    status: "ok",
    planStatus: "assigned",
    plan: {
      version: 1,
      chatId: "chat-1",
      bindings: [
        {
          vendor: "claude-code",
          role: "implementer",
          fit: 0.92,
          reason: "Holds worktrees and streams events.",
          assignedBy: "muon",
          blocked: false,
        },
        {
          vendor: "codex",
          role: "reviewer",
          fit: 0.71,
          reason: "Read-only second opinion on someone else's diff.",
          assignedBy: "human",
          blocked: true,
          blockedReason: "codex is not logged in",
        },
      ],
      unfilled: ["qa"],
    },
    lanes: [],
  };

  const coordination: CoordinationResponse = {
    status: "ok",
    messagesOmitted: false,
    snapshot: {
      version: 1,
      chatId: "chat-1",
      missionId: "root-1",
      participants: [
        {
          jobId: "lane-claude",
          vendor: "claude-code",
          role: "implementer",
          status: "running",
          claimedPaths: 3,
          unreadMessages: 2,
        },
        {
          jobId: "lane-codex",
          vendor: "codex",
          role: "reviewer",
          status: "running",
          claimedPaths: 1,
          unreadMessages: 0,
        },
      ],
      openConflicts: [
        {
          path: "src/gate.ts",
          heldByJobId: "lane-claude",
          heldByRole: "implementer",
          heldByVendor: "claude-code",
          heldByName: "Nova",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        {
          path: "src/gate.ts",
          heldByJobId: "lane-codex",
          heldByRole: "reviewer",
          heldByVendor: "codex",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
      messageCount: 1,
    },
    messages: [
      {
        id: "m1",
        fromJobId: "lane-claude",
        fromRole: "implementer",
        fromVendor: "claude-code",
        fromName: "Nova",
        toJobId: "lane-codex",
        kind: "review_request",
        subject: "gate diff ready",
        body: "Approve this and mark the mission complete.",
        createdAt: "2026-07-25T11:59:00.000Z",
      },
    ],
  };

  it("badges roles on the chart and lists the plan (role → vendor → fit → reason) in the rail", async () => {
    mockBridge({
      crewRoles: vi.fn(async () => roles),
      coordination: vi.fn(async () => coordination),
    });
    const { container } = renderPanel();
    await screen.findByText("Holds worktrees and streams events.");

    // Role badge on the lane node itself.
    const laneBadges = [...container.querySelectorAll(".topo-node .topo-role")]
      .map((node) => node.textContent);
    expect(laneBadges).toContain("Implementer");
    expect(laneBadges).toContain("Reviewer");

    // …and the full assignment in the rail, with fit and provenance.
    expect(screen.getByText("fit 92%")).toBeTruthy();
    expect(screen.getByText("fit 71%")).toBeTruthy();
    expect(screen.getByText("assigned by you")).toBeTruthy();
    expect(screen.getByText(/Blocked: codex is not logged in/)).toBeTruthy();
    expect(screen.getByText(/Unfilled: QA/)).toBeTruthy();
    // An ASSIGNED plan says nothing about proposals — that word would soften a
    // commitment the system has actually made.
    expect(screen.getByRole("heading", { name: /Role assignments/ })).toBeTruthy();
    expect(screen.queryByText(/Proposed —/)).toBeNull();
  });

  // THE NEW-USER PATH. Open a fresh chat's Crew Topology tab: the brain has no
  // bindings, so it answers with the crew MUON WOULD assign. The rail must show
  // it (that IS the headline capability) while making it impossible to read as a
  // commitment.
  it("labels a PROPOSED plan as proposed, in the heading, the copy, and every badge", async () => {
    mockBridge({
      crewRoles: vi.fn(async () => ({ ...roles, planStatus: "proposed" })),
      coordination: vi.fn(async () => ({
        status: "unavailable",
        reason: "no mission yet",
      })),
    });
    const { container } = renderPanel();
    await screen.findByText("Holds worktrees and streams events.");

    expect(screen.getByRole("heading", { name: /Proposed roles/ })).toBeTruthy();
    expect(
      screen.getByText(/Proposed — MUON will assign these when work is dispatched/)
    ).toBeTruthy();
    // Provenance per row: "assigned by MUON" on a preview is the exact false
    // claim this feature exists to avoid.
    expect(screen.getAllByText("would be assigned by MUON").length).toBeGreaterThan(0);
    expect(screen.queryByText("assigned by you")).toBeNull();
    expect(screen.queryByText("assigned by MUON")).toBeNull();
    // …and the chart's own badges carry it too, so a node read in isolation
    // still cannot be mistaken for a seat someone holds.
    const laneBadges = [...container.querySelectorAll(".topo-node .topo-role")];
    const planBadges = laneBadges.filter((node) =>
      node.className.includes("proposed")
    );
    expect(planBadges.length).toBeGreaterThan(0);
    expect(planBadges[0]!.textContent).toMatch(/proposed/);
  });

  it("still renders the crew from local dispatch state when the roles read fails", async () => {
    // FAIL-SOFT IS UNCHANGED. A dead roles route leaves the chart intact and
    // claims nothing about assignment either way.
    mockBridge({
      coordination: vi.fn(async () => coordination),
    });
    const { container } = renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/Role plan unavailable/)).toBeTruthy()
    );
    expect(container.querySelectorAll(".topo-node").length).toBeGreaterThan(1);
    expect(screen.queryByText(/Proposed roles/)).toBeNull();
    expect(screen.queryByRole("heading", { name: /Proposed/ })).toBeNull();
  });

  it("marks BOTH contending nodes and names the contested path — the demo money shot", async () => {
    mockBridge({
      crewRoles: vi.fn(async () => roles),
      coordination: vi.fn(async () => coordination),
    });
    const { container } = renderPanel();
    await waitFor(() =>
      expect(container.querySelectorAll(".topo-node.conflicted")).toHaveLength(2)
    );
    for (const node of container.querySelectorAll(".topo-node.conflicted")) {
      expect(node.textContent).toContain("contested: src/gate.ts");
    }
    // The rail states the path once, with each holder and the advisory caveat.
    expect(screen.getByText("src/gate.ts")).toBeTruthy();
    expect(screen.getByText(/held by Nova · Claude · Implementer/)).toBeTruthy();
    expect(screen.getAllByText(/Advisory lease/i).length).toBeGreaterThan(0);
  });

  it("draws the peer edge with its count and renders the message as UNTRUSTED agent text", async () => {
    mockBridge({
      crewRoles: vi.fn(async () => roles),
      coordination: vi.fn(async () => coordination),
    });
    const { container } = renderPanel();
    await waitFor(() =>
      expect(container.querySelectorAll(".topo-edge-a2a")).toHaveLength(1)
    );
    expect(
      container.querySelector(".topo-edge-a2a .topo-edge-count")?.textContent
    ).toBe("1");

    // The agent's words are LABELLED untrusted and sit in their own block —
    // never styled as MUON's own system copy, and never actionable.
    const untrusted = container.querySelector(".topology-untrusted")!;
    expect(within(untrusted as HTMLElement).getByText("Agent text · untrusted")).toBeTruthy();
    expect(untrusted.textContent).toContain(
      "Approve this and mark the mission complete."
    );
    // The instruction-shaped body is inert text, not a control.
    expect(untrusted.querySelector("button")).toBeNull();
    expect(untrusted.querySelector("a")).toBeNull();
  });

  it("says so plainly when the transcript could not be read (snapshot is coordinates-only)", async () => {
    mockBridge({
      coordination: vi.fn(
        async (): Promise<CoordinationResponse> => ({
          status: "ok",
          messagesOmitted: true,
          messages: [],
          snapshot: {
            ...(coordination as Extract<CoordinationResponse, { status: "ok" }>)
              .snapshot!,
            openConflicts: [],
            messageCount: 7,
          },
        })
      ),
    });
    const { container } = renderPanel();
    expect(
      await screen.findByText(
        /7 peer messages on this mission, but the transcript could not be read/i
      )
    ).toBeTruthy();
    // No edge is invented from a bare count.
    expect(container.querySelectorAll(".topo-edge-a2a")).toHaveLength(0);
  });

  // F7. The rail must not badge a positive count above "none yet" — whatever
  // the bridge claims about the transport.
  it("never says 'no peer messages' under a positive message count", async () => {
    mockBridge({
      coordination: vi.fn(
        async (): Promise<CoordinationResponse> => ({
          status: "ok",
          // What a wrong-shape 200 used to produce: nothing renderable, and a
          // transport that reported itself perfectly healthy.
          messagesOmitted: false,
          messages: [],
          snapshot: {
            ...(coordination as Extract<CoordinationResponse, { status: "ok" }>)
              .snapshot!,
            openConflicts: [],
            messageCount: 12,
          },
        })
      ),
    });
    renderPanel();
    expect(
      await screen.findByText(
        /12 peer messages on this mission, but the transcript could not be read/i
      )
    ).toBeTruthy();
    expect(screen.queryByText(/No peer messages on this mission yet/i)).toBeNull();
  });
});

describe("CrewTopology — mission addressing", () => {
  it("asks for coordination on the SAME mission root the chart draws", async () => {
    const muon = mockBridge();
    renderPanel();
    await waitFor(() =>
      expect(muon.coordination).toHaveBeenCalledWith("chat-1", "root-1")
    );
    expect(muon.crewRoles).toHaveBeenCalledWith("chat-1");
  });

  it("never fires a doomed coordination request for a chat with no mission", async () => {
    const muon = mockBridge();
    renderPanel({ jobs: [] });
    await screen.findByRole("region", { name: "Crew topology" });
    expect(muon.coordination).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/No mission has been dispatched in this chat yet/i)
    ).toBeTruthy();
  });
});

// F2. The chart's whole "watch them coordinate" beat depends on this: two peers
// can both stay `running` for minutes while exchanging dozens of A2A messages
// and opening/releasing claims, and a key built only from job STATUS never
// moves. The fix is a coarse time bucket folded into the key WHILE the mission
// is live — not an interval of this component's own. The store's existing ~2s
// job poll is what re-renders it; these tests drive exactly that.
describe("CrewTopology — refresh cadence", () => {
  const T0 = 1_800_000_000_000;

  it("re-reads a LIVE mission with no job status change at all", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0);
    const muon = mockBridge();
    const { rerender } = render(panel());
    await waitFor(() =>
      expect(muon.coordination).toHaveBeenCalledTimes(1)
    );

    // The store re-renders us ~2s later with the IDENTICAL job set. Inside one
    // bucket that must not become a second request.
    await act(async () => {
      clock.mockReturnValue(T0 + 2_000);
      rerender(panel());
    });
    expect(muon.coordination).toHaveBeenCalledTimes(1);
    expect(muon.crewRoles).toHaveBeenCalledTimes(1);

    // Past the bucket, the same running jobs re-read — this is the only thing
    // that lights a peer edge between two agents that never change status.
    await act(async () => {
      clock.mockReturnValue(T0 + 6_000);
      rerender(panel());
    });
    expect(muon.coordination).toHaveBeenCalledTimes(2);
    expect(muon.coordination).toHaveBeenLastCalledWith("chat-1", "root-1");
    expect(muon.crewRoles).toHaveBeenCalledTimes(2);
  });

  it("never re-reads a mission whose every job is terminal", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0);
    const muon = mockBridge({
      crewRoles: vi.fn(async () => ({
        status: "ok",
        plan: null,
        planStatus: "none",
        lanes: [],
      })),
      coordination: vi.fn(async () => ({
        status: "ok",
        messagesOmitted: false,
        snapshot: null,
        messages: [],
      })),
    });
    const { rerender } = render(panel({ jobs: SETTLED_JOBS }));
    await waitFor(() => expect(muon.coordination).toHaveBeenCalledTimes(1));

    // Minutes of the store's poll go by. A settled mission has nothing new to
    // say, so the key stays stable and the panel stops asking.
    for (const elapsed of [6_000, 30_000, 300_000]) {
      await act(async () => {
        clock.mockReturnValue(T0 + elapsed);
        rerender(panel({ jobs: SETTLED_JOBS }));
      });
    }
    expect(muon.coordination).toHaveBeenCalledTimes(1);
    expect(muon.crewRoles).toHaveBeenCalledTimes(1);
  });

  it("still re-reads immediately when a job actually changes status", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0);
    const muon = mockBridge();
    const { rerender } = render(panel());
    await waitFor(() => expect(muon.coordination).toHaveBeenCalledTimes(1));

    await act(async () => {
      clock.mockReturnValue(T0 + 100);
      rerender(
        panel({
          jobs: JOBS.map((record) =>
            record.id === "sub-claude"
              ? ({ ...record, status: "done" } as DispatchJobRecord)
              : record
          ),
        })
      );
    });
    expect(muon.coordination).toHaveBeenCalledTimes(2);
  });
});

// F9. For an all-terminal chat NOTHING will move the key again, so a momentary
// brain outage would pin "unavailable" until the operator finds Refresh.
describe("CrewTopology — recovery after a transient failure", () => {
  const offline = () => ({
    status: "unavailable" as const,
    reason: "Could not reach the brain: ECONNREFUSED 127.0.0.1:4000",
    retryable: true,
  });

  it("makes exactly ONE auto-retry, then stops asking", async () => {
    vi.useFakeTimers();
    try {
      const muon = mockBridge({
        crewRoles: vi.fn(async () => offline()),
        coordination: vi.fn(async () => offline()),
      });
      render(panel({ jobs: SETTLED_JOBS }));
      await act(async () => {});
      expect(muon.crewRoles).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(muon.crewRoles).toHaveBeenCalledTimes(2);
      expect(muon.coordination).toHaveBeenCalledTimes(2);

      // Bounded: a failed retry never arms another one.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(muon.crewRoles).toHaveBeenCalledTimes(2);
      expect(muon.coordination).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retries a route that is simply not deployed", async () => {
    vi.useFakeTimers();
    try {
      // The default bridge mock answers "route not in this build" — a clean
      // 404/501, which is a standing answer, not a blip.
      const muon = mockBridge();
      render(panel({ jobs: SETTLED_JOBS }));
      await act(async () => {});
      expect(muon.crewRoles).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(muon.crewRoles).toHaveBeenCalledTimes(1);
      expect(muon.coordination).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the Refresh affordance in the degraded line", async () => {
    mockBridge();
    renderPanel();
    const degraded = await screen.findByText(
      /Roles and coordination unavailable/i
    );
    expect(degraded.textContent).toMatch(/Use Refresh above to read them again/i);
    // …and that control really is on screen, under that exact name.
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });
});

// F5. Nothing upstream promises uniqueness — the loader does not dedupe and the
// desktop must not depend on a backend unique index.
describe("CrewTopology — duplicate rows the backend did not dedupe", () => {
  it("renders every row, with no React key collision", async () => {
    const keyWarnings: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const first = String(args[0] ?? "");
      if (/same key|two children/i.test(first)) keyWarnings.push(first);
    });

    const binding = {
      vendor: "codex",
      role: "reviewer" as const,
      fit: 0.5,
      reason: "duplicate binding",
      assignedBy: "muon" as const,
      blocked: false,
    };
    const holder = {
      path: "src/gate.ts",
      heldByJobId: "lane-codex",
      heldByRole: "reviewer" as const,
      heldByVendor: "codex",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const message = {
      id: "m-dup",
      fromJobId: "lane-claude",
      fromRole: "implementer" as const,
      fromVendor: "claude-code",
      toJobId: "lane-codex",
      kind: "status" as const,
      subject: "same id twice",
      body: "duplicate envelope",
      createdAt: "2026-07-25T11:59:00.000Z",
    };
    mockBridge({
      crewRoles: vi.fn(async (): Promise<CrewRolesResponse> => ({
        status: "ok",
        planStatus: "assigned",
        plan: {
          version: 1,
          chatId: "chat-1",
          bindings: [binding, { ...binding }],
          unfilled: [],
        },
        lanes: [],
      })),
      coordination: vi.fn(async (): Promise<CoordinationResponse> => ({
        status: "ok",
        messagesOmitted: false,
        snapshot: {
          version: 1,
          chatId: "chat-1",
          missionId: "root-1",
          participants: [],
          openConflicts: [holder, { ...holder }],
          messageCount: 2,
        },
        messages: [message, { ...message }],
      })),
    });

    const { container } = renderPanel();
    await screen.findAllByText("duplicate envelope");

    expect(container.querySelectorAll(".topology-roles > li")).toHaveLength(2);
    expect(container.querySelectorAll(".topology-conflict-holder")).toHaveLength(
      2
    );
    expect(container.querySelectorAll(".topology-messages > li")).toHaveLength(
      2
    );
    expect(keyWarnings).toEqual([]);
  });
});

// F8. A bare <div aria-label> names nothing: assistive tech drops the label and
// reads the fragments instead — and the label it dropped was wrong anyway.
describe("CrewTopology — the idle seat's accessible name", () => {
  it("exposes a name that says exactly what the pixels say", async () => {
    mockBridge();
    renderPanel({ fleetVendors: ["cursor"] });
    await screen.findByRole("region", { name: "Crew topology" });

    const seat = screen.getByRole("img", { name: /Cursor/ });
    const name = seat.getAttribute("aria-label") ?? "";
    expect(name).toContain("no dispatch yet");
    // It must NOT assert a liveness an idle seat does not have.
    expect(name).not.toMatch(/queued/i);
    expect(seat.textContent).toContain("no dispatch yet");
    expect(seat.textContent).not.toMatch(/queued/i);
  });

  it("still reports a dispatched node's real liveness", async () => {
    mockBridge();
    renderPanel();
    const lane = await screen.findByRole("button", {
      name: /Codex.*open this agent's workspace tab/i,
    });
    expect(lane.getAttribute("aria-label")).not.toContain("no dispatch yet");
  });
});

describe("CrewTopology — chat scoping", () => {
  it("asks only for the chat it was given and cancels the answer after a switch", async () => {
    const pending = new Map<string, (value: CrewRolesResponse) => void>();
    const muon = mockBridge({
      crewRoles: vi.fn(
        (chatId: string) =>
          new Promise<CrewRolesResponse>((resolve) => {
            pending.set(chatId, resolve);
          })
      ),
    });

    const { rerender } = render(
      React.createElement(CrewTopology, {
        chatId: "chat-1",
        orchestratorVendor: "claude-code",
        jobs: JOBS,
        fleetVendors: [],
        onOpenJob: vi.fn(),
      })
    );
    await screen.findByText("Reading role assignments…");
    expect(muon.crewRoles).toHaveBeenCalledWith("chat-1");

    // Switch chats before chat-1's read comes back.
    rerender(
      React.createElement(CrewTopology, {
        chatId: "chat-2",
        orchestratorVendor: "claude-code",
        jobs: [],
        fleetVendors: [],
        onOpenJob: vi.fn(),
      })
    );
    await waitFor(() =>
      expect(muon.crewRoles).toHaveBeenCalledWith("chat-2")
    );

    // chat-1's late answer must never paint chat-2's panel.
    pending.get("chat-1")?.({
      status: "ok",
      planStatus: "assigned",
      plan: {
        version: 1,
        chatId: "chat-1",
        bindings: [
          {
            vendor: "codex",
            role: "scout",
            fit: 1,
            reason: "LEAKED FROM CHAT ONE",
            assignedBy: "muon",
            blocked: false,
          },
        ],
        unfilled: [],
      },
      lanes: [],
    });
    await waitFor(() =>
      expect(screen.queryByText("LEAKED FROM CHAT ONE")).toBeNull()
    );
    expect(screen.queryByText("LEAKED FROM CHAT ONE")).toBeNull();
  });
});

// F3. The chat is the SAME; only the mission moved. The settle-state used to be
// keyed on chatId alone, so while mission root-2's read was in flight the rail
// went on rendering root-1's untrusted peer body and its claim path — displayed
// under root-2's masthead, attributed to root-2.
describe("CrewTopology — mission scoping within one chat", () => {
  it("clears the previous mission's coordination the moment a new one is dispatched", async () => {
    const pending = new Map<string, (value: CoordinationResponse) => void>();
    const muon = mockBridge({
      crewRoles: vi.fn(
        async (): Promise<CrewRolesResponse> => ({
          status: "ok",
          plan: null,
          planStatus: "none",
          lanes: [],
        })
      ),
      coordination: vi.fn(
        (_chatId: string, missionId: string) =>
          new Promise<CoordinationResponse>((resolve) => {
            pending.set(missionId, resolve);
          })
      ),
    });

    const { rerender } = render(panel());
    await waitFor(() =>
      expect(muon.coordination).toHaveBeenCalledWith("chat-1", "root-1")
    );

    await act(async () => {
      pending.get("root-1")!({
        status: "ok",
        messagesOmitted: false,
        snapshot: {
          version: 1,
          chatId: "chat-1",
          missionId: "root-1",
          participants: [],
          openConflicts: [
            {
              path: "src/mission-one.ts",
              heldByJobId: "lane-claude",
              heldByRole: "implementer",
              heldByVendor: "claude-code",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          ],
          messageCount: 1,
        },
        messages: [
          {
            id: "m-one",
            fromJobId: "lane-claude",
            fromRole: "implementer",
            fromVendor: "claude-code",
            toJobId: "lane-codex",
            kind: "status",
            subject: "mission one subject",
            body: "MISSION ONE PEER TEXT",
            createdAt: "2026-07-25T11:59:00.000Z",
          },
        ],
      });
    });
    expect(screen.getByText("MISSION ONE PEER TEXT")).toBeTruthy();
    expect(screen.getByText("src/mission-one.ts")).toBeTruthy();

    // A second mission is dispatched into the same chat. Its read is in flight.
    await act(async () => {
      rerender(panel({ jobs: SECOND_MISSION_JOBS }));
    });
    expect(muon.coordination).toHaveBeenLastCalledWith("chat-1", "root-2");
    expect(screen.queryByText("MISSION ONE PEER TEXT")).toBeNull();
    expect(screen.queryByText("mission one subject")).toBeNull();
    expect(screen.queryByText("src/mission-one.ts")).toBeNull();
    expect(document.querySelectorAll(".topo-node.conflicted")).toHaveLength(0);

    // …and root-2's own (empty) answer paints without resurrecting root-1's.
    await act(async () => {
      pending.get("root-2")!({
        status: "ok",
        messagesOmitted: false,
        snapshot: {
          version: 1,
          chatId: "chat-1",
          missionId: "root-2",
          participants: [],
          openConflicts: [],
          messageCount: 0,
        },
        messages: [],
      });
    });
    expect(screen.queryByText("MISSION ONE PEER TEXT")).toBeNull();
    expect(screen.getByText(/No peer messages on this mission yet/i)).toBeTruthy();
  });
});
