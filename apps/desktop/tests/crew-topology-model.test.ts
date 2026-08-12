import { describe, expect, it } from "vitest";
import type { DispatchJobRecord } from "@muon/client";
import {
  buildCrewTopology,
  edgePath,
  layoutCrewTopology,
  selectMissionRootId,
  vendorLabel,
} from "../src/renderer/lib/crew-topology-model.js";
import type {
  AgentRoleIpc,
  CoordinationResponse,
  CrewRolesResponse,
} from "../src/shared/ipc.js";

// The topology MODEL is the whole contract of the new panel: MUON hub → vendor
// lanes → subagents by real lineage, with roles/coordination as pure additions.
// Its most load-bearing property is DEGRADATION — the chart must be complete
// from local dispatch state alone when the newer brain routes are absent.

const NOW = Date.parse("2026-07-25T12:00:00.000Z");

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

/** Root + two vendor lanes, one of which delegated a grandchild. */
function missionJobs(): DispatchJobRecord[] {
  return [
    job({
      id: "root-1",
      vendor: "claude-code",
      capabilityMode: "orchestrator",
      parentJobId: null,
      rootJobId: "root-1",
      delegationDepth: 0,
      brief: "Ship the pre-edit gate",
    }),
    job({
      id: "lane-claude",
      vendor: "claude-code",
      parentJobId: "root-1",
      rootJobId: "root-1",
      delegationDepth: 1,
      brief: "Implement the gate",
    }),
    job({
      id: "lane-codex",
      vendor: "codex",
      parentJobId: "root-1",
      rootJobId: "root-1",
      delegationDepth: 1,
      brief: "Review the diff",
    }),
    job({
      id: "sub-claude",
      vendor: "claude-code",
      parentJobId: "lane-claude",
      rootJobId: "root-1",
      delegationDepth: 2,
      brief: "Write the tests",
    }),
  ];
}

function base(overrides: Partial<Parameters<typeof buildCrewTopology>[0]> = {}) {
  return buildCrewTopology({
    chatId: "chat-1",
    jobs: missionJobs(),
    orchestratorVendor: "claude-code",
    fleetVendors: [],
    roles: null,
    coordination: null,
    now: NOW,
    ...overrides,
  });
}

describe("buildCrewTopology — shape", () => {
  it("puts MUON at the center with one node per vendor lane and subagents beneath their lane", () => {
    const topology = base();
    expect(topology.hub.kind).toBe("hub");
    expect(topology.hub.label).toBe("MUON");
    expect(topology.hub.role).toBe("orchestrator");
    // The hub is the orchestrator's OWN job, so clicking it is meaningful.
    expect(topology.hub.jobId).toBe("root-1");

    expect(topology.lanes.map((lane) => lane.vendor)).toEqual([
      "claude-code",
      "codex",
    ]);
    const claude = topology.lanes.find((lane) => lane.vendor === "claude-code")!;
    expect(claude.jobId).toBe("lane-claude");
    expect(claude.children.map((child) => child.id)).toEqual(["sub-claude"]);
    expect(claude.children[0]!.kind).toBe("subagent");
    expect(claude.children[0]!.depth).toBe(2);

    const codex = topology.lanes.find((lane) => lane.vendor === "codex")!;
    expect(codex.children).toHaveLength(0);
  });

  it("emits dispatch edges hub→lane and delegation edges lane→subagent", () => {
    const edges = base().edges;
    expect(
      edges.filter((edge) => edge.kind === "dispatch").map((edge) => edge.to)
    ).toEqual(["lane-claude", "lane-codex"]);
    const delegation = edges.filter((edge) => edge.kind === "delegation");
    expect(delegation).toHaveLength(1);
    expect(delegation[0]).toMatchObject({ from: "lane-claude", to: "sub-claude" });
  });

  // A second job MUON dispatched onto a lane that is already occupied is still
  // MUON's dispatch. Hanging it under the lane head as a "delegation" would
  // claim an act no agent performed.
  it("keeps a hub→job dispatch edge for a same-vendor sibling MUON dispatched itself", () => {
    const jobs = [
      ...missionJobs(),
      job({
        id: "lane-codex-2",
        vendor: "codex",
        parentJobId: "root-1",
        rootJobId: "root-1",
        delegationDepth: 1,
        createdAt: "2026-07-25T11:58:30.000Z",
        brief: "Second review pass",
      }),
    ];
    const edges = base({ jobs }).edges;
    expect(
      edges
        .filter((edge) => edge.kind === "dispatch")
        .map((edge) => edge.to)
        .sort()
    ).toEqual(["lane-claude", "lane-codex", "lane-codex-2"]);
    // The only delegation on this mission remains the real one.
    expect(
      edges.filter((edge) => edge.kind === "delegation").map((edge) => edge.to)
    ).toEqual(["sub-claude"]);
  });

  // The legend promises "MUON → lane · dispatch". A seat nobody dispatched into
  // gets its own, quieter line rather than borrowing that claim.
  it("attaches an undispatched seat with a `seat` edge, never a dispatch edge", () => {
    const edges = base({ fleetVendors: ["cursor"] }).edges;
    const seat = edges.filter((edge) => edge.kind === "seat");
    expect(seat).toHaveLength(1);
    expect(seat[0]).toMatchObject({ from: "root-1", to: "lane:cursor" });
    expect(
      edges.some((edge) => edge.kind === "dispatch" && edge.to === "lane:cursor")
    ).toBe(false);
  });

  it("gives every node a stable display codename, never a raw job id", () => {
    const topology = base();
    for (const node of topology.nodes) {
      expect(node.label).not.toBe(node.jobId);
      expect(node.label.length).toBeGreaterThan(0);
    }
  });

  it("shows a seated-but-undispatched vendor as an idle, NON-clickable lane (no fake liveness)", () => {
    const topology = base({ fleetVendors: ["cursor", "opencode", "claude-code"] });
    const cursor = topology.lanes.find((lane) => lane.vendor === "cursor")!;
    expect(cursor.jobId).toBeNull();
    expect(cursor.status).toBe("idle");
    expect(topology.lanes.some((lane) => lane.vendor === "opencode")).toBe(true);
    // The orchestrator's own vendor is the HUB, never duplicated as a seat —
    // and its real dispatched lane is still present exactly once.
    expect(
      topology.lanes.filter((lane) => lane.vendor === "claude-code")
    ).toHaveLength(1);
  });

  it("a lane reports the most actionable state under it (a stalled child cannot hide behind a calm parent)", () => {
    const jobs = missionJobs().map((candidate) =>
      candidate.id === "sub-claude"
        ? job({ ...candidate, status: "failed", exitCode: 1 })
        : candidate
    );
    const claude = base({ jobs }).lanes.find(
      (lane) => lane.vendor === "claude-code"
    )!;
    expect(claude.liveness).toBe("needs-attention");
    expect(claude.attention).toBe(true);
    // The dot and the sentence beside it are ONE claim.
    expect(claude.stateText).toBe("Needs attention");
  });
});

describe("buildCrewTopology — degradation (the new routes are absent)", () => {
  it("renders the whole chart from local dispatch state when BOTH reads are unavailable", () => {
    const topology = base({
      roles: { status: "unavailable", reason: "route not in this build" },
      coordination: { status: "unavailable", reason: "route not in this build" },
    });
    expect(topology.lanes).toHaveLength(2);
    expect(topology.edges.length).toBeGreaterThan(0);
    expect(topology.roleBindings).toEqual([]);
    expect(topology.conflicts).toEqual([]);
    expect(topology.messages).toEqual([]);
    // …and it SAYS so rather than pretending: one quiet note per missing read.
    expect(topology.notices).toHaveLength(2);
    expect(topology.notices.every((notice) => notice.tone === "info")).toBe(true);
  });

  it("still renders a lone MUON hub when the mission has no dispatches at all", () => {
    const topology = base({ jobs: [] });
    expect(topology.hub.label).toBe("MUON");
    expect(topology.hub.jobId).toBeNull();
    expect(topology.lanes).toEqual([]);
    expect(topology.nodes).toHaveLength(1);
    // A hub with no dispatch is not clickable — never a dead end.
    expect(layoutCrewTopology(topology).positions.size).toBe(1);
  });
});

describe("buildCrewTopology — roles", () => {
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
          reason: "Read-only second opinion.",
          assignedBy: "human",
          blocked: false,
        },
      ],
      unfilled: ["qa"],
    },
    lanes: [
      { vendor: "cursor", displayName: "Cursor Agent", health: "degraded", role: "scout" },
    ],
  };

  it("badges each lane with its assigned role and carries the plan into the rail", () => {
    const topology = base({ roles, fleetVendors: ["cursor"] });
    expect(
      topology.lanes.find((lane) => lane.vendor === "claude-code")!.role
    ).toBe("implementer");
    expect(topology.lanes.find((lane) => lane.vendor === "codex")!.role).toBe(
      "reviewer"
    );
    // An idle seat still shows the role the plan gave it.
    expect(topology.lanes.find((lane) => lane.vendor === "cursor")!.role).toBe(
      "scout"
    );
    expect(topology.roleBindings).toHaveLength(2);
    expect(topology.unfilledRoles).toEqual(["qa"]);
    // The lane's adapter-probed identity and health ride onto the idle seat.
    const cursor = topology.lanes.find((lane) => lane.vendor === "cursor")!;
    expect(cursor.label).toBe("Cursor Agent");
    expect(cursor.laneHealth).toBe("degraded");
    expect(topology.rolePlanStatus).toBe("assigned");
  });

  // The route previews the crew MUON would bind for a chat nobody has dispatched
  // in yet. The model carries that status beside the bindings, because a badge
  // reading "Implementer · Claude" is a different claim in each case and the
  // rail has to be able to say which.
  it("carries a PROPOSED plan's status through to the rail", () => {
    const topology = base({
      roles: { ...roles, planStatus: "proposed" },
      fleetVendors: ["cursor"],
    });
    expect(topology.rolePlanStatus).toBe("proposed");
    // The badges themselves are unchanged — the preview IS the shape of the
    // crew, so the chart is right; only the claim about it differs.
    expect(topology.roleBindings).toHaveLength(2);
    expect(
      topology.lanes.find((lane) => lane.vendor === "claude-code")!.role
    ).toBe("implementer");
  });

  it("claims nothing about a plan it could not read", () => {
    const topology = base({
      roles: { status: "unavailable", reason: "route not in this build" },
    });
    // No readable plan ⇒ `none`, never a default that implies a commitment.
    expect(topology.rolePlanStatus).toBe("none");
    expect(topology.roleBindings).toEqual([]);
  });
});

// F6. REACHABLE ON DEFAULT CONFIG: one vendor installed, so the crew plan binds
// claude-code to `orchestrator` AND to a worker role. The hub already IS the
// orchestrator seat; a second card claiming that role is the chart asserting a
// coordinator MUON never seated.
describe("buildCrewTopology — one vendor holding both seats", () => {
  const soloVendorRoles = (
    bindings: Array<{ role: AgentRoleIpc; fit: number }>
  ): CrewRolesResponse => ({
    status: "ok",
    planStatus: "assigned",
    plan: {
      version: 1,
      chatId: "chat-1",
      bindings: bindings.map((binding) => ({
        vendor: "claude-code",
        role: binding.role,
        fit: binding.fit,
        reason: "Only lane installed.",
        assignedBy: "muon" as const,
        blocked: false,
      })),
      unfilled: [],
    },
    lanes: [{ vendor: "claude-code", displayName: "Claude Code", health: "healthy" }],
  });

  /** Just the orchestrator turn — nothing dispatched onto the worker seat yet. */
  const soloJobs = () => [
    job({
      id: "root-1",
      vendor: "claude-code",
      capabilityMode: "orchestrator",
      parentJobId: null,
      rootJobId: "root-1",
      delegationDepth: 0,
      status: "running",
    }),
  ];

  it("renders ONE orchestrator card and gives the worker seat its worker role", () => {
    const topology = base({
      jobs: soloJobs(),
      fleetVendors: ["claude-code"],
      // ROLE_PRIORITY puts `orchestrator` first, so it is the FIRST binding.
      roles: soloVendorRoles([
        { role: "orchestrator", fit: 0.96 },
        { role: "docs", fit: 0.93 },
      ]),
    });

    expect(
      topology.nodes.filter((node) => node.role === "orchestrator")
    ).toHaveLength(1);
    expect(topology.hub.kind).toBe("hub");

    const seat = topology.lanes.find((lane) => lane.vendor === "claude-code")!;
    expect(seat).toBeTruthy();
    expect(seat.role).toBe("docs");
    expect(seat.jobId).toBeNull();
    expect(seat.stateText).toBe("no dispatch yet");
  });

  it("renders NO second seat when the vendor's only binding is orchestrator", () => {
    const topology = base({
      jobs: soloJobs(),
      fleetVendors: ["claude-code"],
      roles: soloVendorRoles([{ role: "orchestrator", fit: 0.96 }]),
    });
    // The hub already represents that seat; a duplicate would be a lie.
    expect(topology.lanes).toHaveLength(0);
    expect(topology.nodes).toHaveLength(1);
  });

  it("gives a DISPATCHED same-vendor worker its worker role, never the hub's", () => {
    const topology = base({
      jobs: [
        ...soloJobs(),
        job({
          id: "lane-docs",
          vendor: "claude-code",
          parentJobId: "root-1",
          rootJobId: "root-1",
          delegationDepth: 1,
        }),
      ],
      fleetVendors: ["claude-code"],
      roles: soloVendorRoles([
        { role: "orchestrator", fit: 0.96 },
        { role: "docs", fit: 0.93 },
      ]),
    });
    expect(
      topology.nodes.filter((node) => node.role === "orchestrator")
    ).toHaveLength(1);
    expect(topology.lanes.find((lane) => lane.vendor === "claude-code")!.role).toBe(
      "docs"
    );
  });
});

describe("buildCrewTopology — coordination", () => {
  const coordination = (
    overrides: Partial<
      Extract<CoordinationResponse, { status: "ok" }>
    > = {}
  ): CoordinationResponse => ({
    status: "ok",
    messagesOmitted: false,
    messages: [],
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
          unreadMessages: 1,
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
      openConflicts: [],
      messageCount: 0,
    },
    ...overrides,
  });

  it("draws a peer edge ONLY from a real job↔job envelope, with its count", () => {
    const topology = base({
      coordination: coordination({
        messages: [
          {
            id: "m1",
            fromJobId: "lane-claude",
            fromRole: "implementer",
            fromVendor: "claude-code",
            toJobId: "lane-codex",
            kind: "review_request",
            subject: "diff ready",
            body: "please look at src/gate.ts",
            createdAt: "2026-07-25T11:59:00.000Z",
          },
          {
            id: "m2",
            fromJobId: "lane-codex",
            fromRole: "reviewer",
            fromVendor: "codex",
            toJobId: "lane-claude",
            kind: "review_verdict",
            subject: "looks fine",
            body: "no blocking issues",
            createdAt: "2026-07-25T11:59:30.000Z",
          },
        ],
        snapshot: { ...coordination().snapshot!, messageCount: 2 },
      }),
    });
    const a2a = topology.edges.filter((edge) => edge.kind === "a2a");
    expect(a2a).toHaveLength(1);
    // One undirected edge carrying BOTH envelopes.
    expect(a2a[0]!.count).toBe(2);
    // Newest first, so the rail reads as a feed.
    expect(topology.messages.map((message) => message.id)).toEqual(["m2", "m1"]);
  });

  it("never invents an edge for a role/crew fan-out or for a bare messageCount", () => {
    const fanout = base({
      coordination: coordination({
        messages: [
          {
            id: "m3",
            fromJobId: "lane-claude",
            fromRole: "implementer",
            fromVendor: "claude-code",
            // role/crew addressing — no single peer to draw to.
            toJobId: null,
            kind: "constraint",
            subject: "keep the gate fail-closed",
            body: "do not widen the grant",
            createdAt: "2026-07-25T11:59:00.000Z",
          },
        ],
      }),
    });
    expect(fanout.edges.some((edge) => edge.kind === "a2a")).toBe(false);
    expect(fanout.messages).toHaveLength(1);

    const countsOnly = base({
      coordination: coordination({
        messagesOmitted: true,
        snapshot: { ...coordination().snapshot!, messageCount: 9 },
      }),
    });
    expect(countsOnly.edges.some((edge) => edge.kind === "a2a")).toBe(false);
    expect(countsOnly.totalMessageCount).toBe(9);
    expect(countsOnly.messagesOmitted).toBe(true);
  });

  it("marks every node named by an open file-claim conflict and groups conflicts by path", () => {
    const topology = base({
      coordination: coordination({
        snapshot: {
          ...coordination().snapshot!,
          openConflicts: [
            {
              path: "src/gate.ts",
              heldByJobId: "lane-claude",
              heldByRole: "implementer",
              heldByVendor: "claude-code",
              heldByName: "Nova",
              expiresAt: "2026-07-25T12:20:00.000Z",
            },
            {
              path: "src/gate.ts",
              heldByJobId: "lane-codex",
              heldByRole: "reviewer",
              heldByVendor: "codex",
              expiresAt: "2026-07-25T12:25:00.000Z",
            },
          ],
        },
      }),
    });
    expect(topology.conflicts).toHaveLength(1);
    expect(topology.conflicts[0]!.path).toBe("src/gate.ts");
    expect(topology.conflicts[0]!.holders).toHaveLength(2);
    for (const vendor of ["claude-code", "codex"]) {
      expect(
        topology.lanes.find((lane) => lane.vendor === vendor)!.conflictPaths
      ).toEqual(["src/gate.ts"]);
    }
  });

  it("carries the coordination-reported role and claim counts onto the node", () => {
    const claude = base({ coordination: coordination() }).lanes.find(
      (lane) => lane.vendor === "claude-code"
    )!;
    expect(claude.role).toBe("implementer");
    expect(claude.roleSource).toBe("coordination");
    expect(claude.claimedPaths).toBe(3);
    expect(claude.unreadMessages).toBe(1);
  });
});

describe("selectMissionRootId", () => {
  it("names the SAME mission the chart draws, so coordination cannot be fetched for another turn", () => {
    const topology = base();
    expect(selectMissionRootId(missionJobs())).toBe(topology.hub.jobId);
    expect(selectMissionRootId(missionJobs())).toBe("root-1");
  });

  it("prefers the newest ACTIVE root over a newer terminal one", () => {
    const jobs = [
      ...missionJobs(),
      job({
        id: "root-2",
        vendor: "claude-code",
        capabilityMode: "orchestrator",
        parentJobId: null,
        rootJobId: "root-2",
        delegationDepth: 0,
        status: "done",
        createdAt: "2026-07-25T11:59:00.000Z",
      }),
    ];
    expect(selectMissionRootId(jobs)).toBe("root-1");
  });

  it("is null for a chat that has dispatched nothing (no doomed coordination fetch)", () => {
    expect(selectMissionRootId([])).toBeNull();
  });
});

describe("layoutCrewTopology", () => {
  it("is pure, deterministic, and places every node inside the reported stage", () => {
    const topology = base({ fleetVendors: ["cursor", "opencode"] });
    const first = layoutCrewTopology(topology);
    const second = layoutCrewTopology(topology);
    expect([...second.positions.entries()]).toEqual([
      ...first.positions.entries(),
    ]);
    expect(first.positions.size).toBe(topology.nodes.length);
    for (const point of first.positions.values()) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(first.width);
      expect(point.y).toBeLessThanOrEqual(first.height);
    }
  });

  it("emits a finite quadratic path for every edge", () => {
    const path = edgePath({ x: 10, y: 20 }, { x: 110, y: 220 });
    expect(path).toMatch(/^M 10 20 Q -?[\d.]+ -?[\d.]+ 110 220$/);
    expect(path).not.toContain("NaN");
  });
});

describe("vendorLabel", () => {
  it("names every lane MUON drives, including the local one", () => {
    expect(vendorLabel("claude-code")).toBe("Claude");
    expect(vendorLabel("codex")).toBe("Codex");
    expect(vendorLabel("cursor")).toBe("Cursor");
    expect(vendorLabel("opencode")).toBe("OpenCode");
    // Unknown vendors pass through verbatim rather than rendering blank.
    expect(vendorLabel("future-vendor")).toBe("future-vendor");
  });
});
