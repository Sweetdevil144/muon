// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DispatchJobRecord } from "@muon/client";
import { CrewTopology } from "../src/renderer/crew-topology.js";
import {
  buildCrewTopology,
  selectMissionRootId,
} from "../src/renderer/lib/crew-topology-model.js";
import type {
  CoordinationResponse,
  CrewRolesResponse,
} from "../src/shared/ipc.js";

/**
 * THE REAL RUN, frozen as a fixture.
 *
 * A founder ran "Add a --version flag to the CLI" and opened Topology while the
 * crew was still working. What the brain actually held (verbatim from the
 * dispatch rows of that mission):
 *
 *   cdeeca56  claude-code  orchestrator  done      depth 0   ← the mission root
 *     81070509  codex        delegate    running   depth 1   implementer
 *     74d002b7  claude-code  delegate    running   depth 1   docs
 *   705bb486  claude-code  orchestrator  done      depth 0   ← a LATER, childless
 *                                                              turn in the SAME chat
 *
 * …plus two peer envelopes on mission `cdeeca56` (one role fan-out, one exact
 * job↔job answer), a cursor lane bound to `reviewer` that was never dispatched,
 * and an opencode lane that was seated and idle.
 *
 * What the panel showed instead: "no dispatch yet" on every lane, NO node at all
 * for the claude-code worker, zero dispatch edges, "No peer messages on this
 * mission yet", and a MUON hub reading a flat "Done" while two children worked.
 *
 * Every assertion below is one of those symptoms.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CHAT_ID = "chat-cli-version";
const MISSION_ROOT = "job-cdeeca56";
/** The follow-up orchestrator turn that had no crew of its own. */
const LATER_ROOT = "job-705bb486";
const CODEX_CHILD = "job-81070509";
const DOCS_CHILD = "job-74d002b7";

/** Mid-mission: both children have produced output in the last few seconds. */
const NOW = Date.parse("2026-07-26T12:06:10.000Z");

function job(overrides: Partial<DispatchJobRecord>): DispatchJobRecord {
  return {
    id: "job-x",
    kind: "session",
    vendor: "codex",
    taskId: "task-1",
    chatId: CHAT_ID,
    brief: "do the thing",
    status: "running",
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    capabilityMode: "delegate",
    createdAt: "2026-07-26T12:00:00.000Z",
    startedAt: "2026-07-26T12:00:05.000Z",
    lastProgressAt: "2026-07-26T12:05:00.000Z",
    ...overrides,
  } as unknown as DispatchJobRecord;
}

/** The four dispatch rows of the real run, in the order they were created. */
function liveMissionJobs(): DispatchJobRecord[] {
  return [
    job({
      id: MISSION_ROOT,
      vendor: "claude-code",
      capabilityMode: "orchestrator",
      parentJobId: null,
      rootJobId: null,
      delegationDepth: 0,
      status: "done",
      exitCode: 0,
      taskId: "cms26com4000d9km4yfmgcj68",
      brief: "Add a --version flag to the CLI",
      createdAt: "2026-07-26T12:00:00.000Z",
      startedAt: "2026-07-26T12:00:04.000Z",
      lastProgressAt: "2026-07-26T12:03:30.000Z",
    }),
    job({
      id: CODEX_CHILD,
      vendor: "codex",
      parentJobId: MISSION_ROOT,
      rootJobId: MISSION_ROOT,
      delegationDepth: 1,
      status: "running",
      role: "implementer",
      taskId: "cms26hxpq000j9km4ei8tg0vm",
      brief: "Implement the --version flag",
      createdAt: "2026-07-26T12:03:08.000Z",
      startedAt: "2026-07-26T12:03:10.000Z",
      lastProgressAt: "2026-07-26T12:06:00.000Z",
    }),
    job({
      id: DOCS_CHILD,
      // THE SAME VENDOR AS THE ORCHESTRATOR — the lane that vanished.
      vendor: "claude-code",
      parentJobId: MISSION_ROOT,
      rootJobId: MISSION_ROOT,
      delegationDepth: 1,
      status: "running",
      role: "docs",
      taskId: "cms26i8je000k9km46tc44v00",
      brief: "Document the --version flag",
      createdAt: "2026-07-26T12:03:20.000Z",
      startedAt: "2026-07-26T12:03:22.000Z",
      lastProgressAt: "2026-07-26T12:06:05.000Z",
    }),
    job({
      id: LATER_ROOT,
      vendor: "claude-code",
      capabilityMode: "orchestrator",
      parentJobId: null,
      rootJobId: null,
      delegationDepth: 0,
      status: "done",
      exitCode: 0,
      taskId: "cms26com4000d9km4yfmgcj68",
      brief: "Add a --version flag to the CLI",
      createdAt: "2026-07-26T12:03:44.000Z",
      startedAt: "2026-07-26T12:03:45.000Z",
      lastProgressAt: "2026-07-26T12:03:50.000Z",
    }),
  ];
}

/** Every lane the fleet had seated when the founder looked. */
const FLEET_VENDORS = ["claude-code", "codex", "cursor", "opencode"];

const ROLES: CrewRolesResponse = {
  status: "ok",
  planStatus: "assigned",
  plan: {
    version: 1,
    chatId: CHAT_ID,
    bindings: [
      {
        vendor: "codex",
        role: "implementer",
        fit: 0.94,
        reason: "Pinned by you: Codex holds implementer.",
        assignedBy: "muon",
        blocked: false,
      },
      {
        vendor: "cursor",
        role: "reviewer",
        fit: 0.78,
        reason: "Pinned by you: Cursor holds reviewer.",
        assignedBy: "muon",
        blocked: false,
      },
      {
        vendor: "claude-code",
        role: "docs",
        fit: 0.93,
        reason: "Pinned by you: Claude Code holds docs.",
        assignedBy: "muon",
        blocked: false,
      },
    ],
    unfilled: [],
  },
  lanes: [
    { vendor: "claude-code", displayName: "Claude Code", health: "healthy", role: "docs" },
    { vendor: "codex", displayName: "Codex", health: "healthy", role: "implementer" },
    { vendor: "cursor", displayName: "Cursor", health: "healthy", role: "reviewer" },
    { vendor: "opencode", displayName: "OpenCode", health: "healthy" },
  ],
};

/** What `/api/a2a/coordination` really answers for mission `cdeeca56`. */
const COORDINATION: CoordinationResponse = {
  status: "ok",
  messagesOmitted: false,
  snapshot: {
    version: 1,
    chatId: CHAT_ID,
    missionId: MISSION_ROOT,
    participants: [
      {
        jobId: CODEX_CHILD,
        vendor: "codex",
        role: "implementer",
        status: "running",
        claimedPaths: 1,
        unreadMessages: 1,
      },
      {
        jobId: DOCS_CHILD,
        vendor: "claude-code",
        role: "docs",
        status: "running",
        claimedPaths: 0,
        unreadMessages: 0,
      },
    ],
    openConflicts: [],
    messageCount: 2,
  },
  messages: [
    {
      id: "cms26kw6",
      fromJobId: CODEX_CHILD,
      fromRole: "implementer",
      fromVendor: "codex",
      // Role fan-out: addressed to whoever holds `docs`, not to one job.
      toJobId: null,
      kind: "question",
      subject: "CLI version/package cross-check",
      body: "I'm asking the docs peer for a bounded read-only cross-check.",
      createdAt: "2026-07-26T12:04:36.000Z",
    },
    {
      id: "cms26mxl",
      fromJobId: DOCS_CHILD,
      fromRole: "docs",
      fromVendor: "claude-code",
      // Exact job↔job address — the one envelope a peer edge may be drawn from.
      toJobId: CODEX_CHILD,
      kind: "answer",
      subject: "Re: CLI version/package cross-check",
      body: "package.json version and the --version output agree.",
      createdAt: "2026-07-26T12:05:55.000Z",
    },
  ],
};

/** The brain answers per MISSION: the later, childless turn holds nothing. */
const EMPTY_COORDINATION: CoordinationResponse = {
  status: "ok",
  messagesOmitted: false,
  snapshot: {
    version: 1,
    chatId: CHAT_ID,
    missionId: LATER_ROOT,
    participants: [],
    openConflicts: [],
    messageCount: 0,
  },
  messages: [],
};

function topologyOf(
  overrides: Partial<Parameters<typeof buildCrewTopology>[0]> = {}
) {
  return buildCrewTopology({
    chatId: CHAT_ID,
    jobs: liveMissionJobs(),
    orchestratorVendor: "claude-code",
    fleetVendors: FLEET_VENDORS,
    roles: ROLES,
    coordination: COORDINATION,
    now: NOW,
    ...overrides,
  });
}

describe("the real run — mission selection", () => {
  // ROOT CAUSE #1. The chat had TWO orchestrator roots; the newer one had no
  // crew. Ranking roots by their own status and recency alone handed the whole
  // panel to the empty turn, which is why every lane read "no dispatch yet" and
  // why the coordination read was addressed to a mission with no peer traffic.
  it("watches the root that OWNS the live crew, not the newest childless turn", () => {
    expect(selectMissionRootId(liveMissionJobs())).toBe(MISSION_ROOT);
    expect(topologyOf().hub.jobId).toBe(MISSION_ROOT);
  });

  it("still follows a new turn once it is the one doing the work", () => {
    // The crew finished; the follow-up turn is now the live one.
    const jobs = liveMissionJobs().map((record) =>
      record.id === LATER_ROOT
        ? ({ ...record, status: "running" } as DispatchJobRecord)
        : ({ ...record, status: "done" } as DispatchJobRecord)
    );
    expect(selectMissionRootId(jobs)).toBe(LATER_ROOT);
  });

  it("keeps a settled mission's crew on screen rather than an empty later turn", () => {
    // Everything terminal: the honest chart is the one that HAS a crew.
    const jobs = liveMissionJobs().map(
      (record) => ({ ...record, status: "done" }) as DispatchJobRecord
    );
    expect(selectMissionRootId(jobs)).toBe(MISSION_ROOT);
  });
});

describe("the real run — lanes, edges, and peer traffic", () => {
  // REQUIREMENT 1
  it("renders every dispatched lane with its true state and a dispatch edge per job", () => {
    const topology = topologyOf();
    const codex = topology.lanes.find((lane) => lane.vendor === "codex")!;
    const docs = topology.lanes.find((lane) => lane.vendor === "claude-code")!;

    expect(codex.jobId).toBe(CODEX_CHILD);
    expect(codex.status).toBe("running");
    expect(codex.liveness).toBe("progressing");
    expect(codex.stateText).toBe("Working");
    expect(docs.jobId).toBe(DOCS_CHILD);
    expect(docs.status).toBe("running");
    expect(docs.stateText).toBe("Working");

    const dispatch = topology.edges.filter((edge) => edge.kind === "dispatch");
    expect(dispatch.map((edge) => edge.to).sort()).toEqual(
      [CODEX_CHILD, DOCS_CHILD].sort()
    );
    // Every dispatch edge leaves the hub — MUON dispatched both children.
    expect(dispatch.every((edge) => edge.from === MISSION_ROOT)).toBe(true);
    // Nothing was delegated by a worker, so nothing may claim it was.
    expect(topology.edges.some((edge) => edge.kind === "delegation")).toBe(false);
  });

  // REQUIREMENT 2
  it("gives the claude-code WORKER its own node under a claude-code orchestrator", () => {
    const topology = topologyOf();
    const claudeLanes = topology.lanes.filter(
      (lane) => lane.vendor === "claude-code"
    );
    expect(claudeLanes).toHaveLength(1);
    expect(claudeLanes[0]!.jobId).toBe(DOCS_CHILD);
    expect(claudeLanes[0]!.role).toBe("docs");
    // …and it is NOT the hub. Same vendor, two distinct seats.
    expect(topology.hub.jobId).toBe(MISSION_ROOT);
    expect(topology.hub.role).toBe("orchestrator");
    expect(topology.nodes.filter((node) => node.vendor === "claude-code")).toHaveLength(2);
  });

  it("keeps a same-vendor worker SEAT visible before it is ever dispatched", () => {
    // The plan binds claude-code to `docs`. Until MUON dispatches it, that seat
    // must still be on the chart — the orchestrator's own lane record must not
    // shadow a worker lane that happens to share its vendor.
    const topology = topologyOf({
      jobs: liveMissionJobs().filter((record) => record.id !== DOCS_CHILD),
    });
    const docsSeat = topology.lanes.find((lane) => lane.vendor === "claude-code")!;
    expect(docsSeat).toBeTruthy();
    expect(docsSeat.jobId).toBeNull();
    expect(docsSeat.role).toBe("docs");
    expect(docsSeat.stateText).toBe("no dispatch yet");
  });

  // REQUIREMENT 3
  it("surfaces the mission's peer messages and draws the job↔job edge", () => {
    const topology = topologyOf();
    expect(topology.messages.map((message) => message.id)).toEqual([
      "cms26mxl",
      "cms26kw6",
    ]);
    expect(topology.totalMessageCount).toBe(2);
    expect(topology.messagesOmitted).toBe(false);

    const a2a = topology.edges.filter((edge) => edge.kind === "a2a");
    expect(a2a).toHaveLength(1);
    expect(a2a[0]!.count).toBe(1);
    expect([a2a[0]!.from, a2a[0]!.to].sort()).toEqual(
      [CODEX_CHILD, DOCS_CHILD].sort()
    );
  });

  // REQUIREMENT 4
  it("never reads a bare 'Done' on MUON while its children are still working", () => {
    const hub = topologyOf().hub;
    expect(hub.liveness).toBe("done");
    expect(hub.stateText).toBe("waiting on 2 children");
    expect(hub.stateText).not.toBe("Done");
  });

  it("says plain 'Done' once the crew has actually finished", () => {
    const jobs = liveMissionJobs().map(
      (record) => ({ ...record, status: "done" }) as DispatchJobRecord
    );
    expect(topologyOf({ jobs }).hub.stateText).toBe("Done");
  });

  it("counts a queued child too — a mission is not over while work is pending", () => {
    const jobs = liveMissionJobs().map((record) =>
      record.id === CODEX_CHILD
        ? ({ ...record, status: "queued", startedAt: null, lastProgressAt: null } as DispatchJobRecord)
        : record
    );
    expect(topologyOf({ jobs }).hub.stateText).toBe("waiting on 2 children");
  });

  // REQUIREMENT 5
  it("says 'no dispatch yet' ONLY for a lane with zero jobs in this mission", () => {
    const topology = topologyOf();
    const dispatchedVendors = new Set(
      liveMissionJobs()
        .filter((record) => record.parentJobId === MISSION_ROOT)
        .map((record) => record.vendor)
    );
    for (const lane of topology.lanes) {
      if (lane.stateText === "no dispatch yet") {
        expect(lane.jobId).toBeNull();
        expect(dispatchedVendors.has(lane.vendor)).toBe(false);
      } else {
        expect(lane.jobId).not.toBeNull();
      }
    }
    // The cursor reviewer was queued in the plan and never dispatched; opencode
    // was merely seated. Both are honest "no dispatch yet" seats.
    expect(
      topology.lanes
        .filter((lane) => lane.stateText === "no dispatch yet")
        .map((lane) => lane.vendor)
        .sort()
    ).toEqual(["cursor", "opencode"]);
    expect(topology.lanes.find((lane) => lane.vendor === "cursor")!.role).toBe(
      "reviewer"
    );
  });
});

/* ── render smoke: the same run, on screen ───────────────────────────────── */

function mockBridge() {
  const muon = {
    crewRoles: vi.fn(async (): Promise<CrewRolesResponse> => ROLES),
    coordination: vi.fn(
      async (_chatId: string, missionId: string): Promise<CoordinationResponse> =>
        // Addressed by mission, exactly like the brain: ask for the childless
        // turn and you get nothing back.
        missionId === MISSION_ROOT ? COORDINATION : EMPTY_COORDINATION
    ),
  };
  Object.assign(window, { muon });
  return muon;
}

describe("the real run — on screen", () => {
  it("draws the live mission: 2 working lanes, 2 idle seats, dispatch + peer edges", async () => {
    // The component reads its own clock; pin it to the moment the founder was
    // looking, so liveness is the one the crew streams showed.
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const muon = mockBridge();
    const { container } = render(
      React.createElement(CrewTopology, {
        chatId: CHAT_ID,
        orchestratorVendor: "claude-code",
        jobs: liveMissionJobs(),
        fleetVendors: FLEET_VENDORS,
        onOpenJob: vi.fn(),
      })
    );

    const region = await screen.findByRole("region", { name: "Crew topology" });
    // The coordination read names the mission that actually has the crew.
    await waitFor(() =>
      expect(muon.coordination).toHaveBeenCalledWith(CHAT_ID, MISSION_ROOT)
    );

    // 1 hub + 4 lanes (codex + claude-code dispatched, cursor + opencode idle).
    await waitFor(() =>
      expect(container.querySelectorAll(".topo-node")).toHaveLength(5)
    );
    expect(container.querySelectorAll(".topo-node-lane")).toHaveLength(4);
    expect(container.querySelectorAll(".topo-edge-dispatch")).toHaveLength(2);
    await waitFor(() =>
      expect(container.querySelectorAll(".topo-edge-a2a")).toHaveLength(1)
    );

    // The two dispatched lanes are clickable and report real liveness…
    expect(
      screen.getByRole("button", { name: /Codex · Implementer · Working/ })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Claude · Docs · Working/ })
    ).toBeTruthy();
    // …the two undispatched seats are not, and say why.
    const idle = container.querySelectorAll(".topo-node.idle");
    expect(idle).toHaveLength(2);
    for (const seat of idle) {
      expect(seat.tagName).not.toBe("BUTTON");
      expect(seat.textContent).toContain("no dispatch yet");
    }

    // MUON tells the truth about the mission, not just about its own job.
    const hub = container.querySelector<HTMLElement>(".topo-node-hub")!;
    expect(hub.textContent).toContain("waiting on 2 children");
    expect(within(region).getByText("MUON")).toBeTruthy();

    // The peer transcript is there, labelled untrusted.
    expect(
      screen.getByText("I'm asking the docs peer for a bounded read-only cross-check.")
    ).toBeTruthy();
    expect(
      screen.queryByText(/No peer messages on this mission yet/i)
    ).toBeNull();
    expect(container.querySelectorAll(".topology-messages > li")).toHaveLength(2);
  });
});
