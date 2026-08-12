import type { DispatchJobRecord } from "@muon/client";
import { vendorShortLabel } from "@muon/client/vendors";
import {
  buildDispatchForest,
  type DispatchTreeNode,
} from "@muon/client/dispatch-view";
import {
  selectMissionRoot,
  selectMissionRootId,
} from "@muon/client/mission-root";
import {
  crewLivenessLabel,
  deriveCrewLiveness,
  type CrewLiveness,
} from "@muon/client/crew-liveness";
import { agentCodenames } from "../../lib/agent-codename.js";
import type {
  AgentRoleIpc,
  ClaimConflictIpc,
  CoordinationResponse,
  CrewPlanStatusIpc,
  CrewRoleLaneIpc,
  CrewRolesResponse,
  LaneHealthIpc,
  PeerMessageIpc,
  RoleBindingIpc,
} from "../../shared/ipc.js";

/**
 * The crew topology MODEL — pure, deterministic, React-free.
 *
 * It fuses three sources into ONE org chart:
 *   1. the desktop's own dispatch-job lineage (always present — this alone is
 *      enough to render the whole diagram, which is what makes the panel
 *      degrade cleanly when the newer brain routes are absent),
 *   2. the crew ROLE PLAN (`/api/crew/roles`) — what each lane is FOR,
 *   3. the A2A COORDINATION snapshot (`/api/a2a/coordination`) — peer traffic
 *      and open file-claim conflicts.
 *
 * Shape: MUON hub (the orchestrator seat) → one node per VENDOR LANE →
 * subagent nodes beneath their lane, by parentJobId/rootJobId lineage.
 */

export type TopologyNodeKind = "hub" | "lane" | "subagent";

export type TopologyNode = {
  /** Stable render key. A real jobId, or `lane:<vendor>` for an idle seat. */
  id: string;
  kind: TopologyNodeKind;
  vendor: string;
  /** Display-only crew codename (agent-codename.ts), or the vendor label. */
  label: string;
  role: AgentRoleIpc | null;
  /** Where the role came from — a plan binding, or the dispatch authority. */
  roleSource: "plan" | "coordination" | "authority" | null;
  status: string;
  liveness: CrewLiveness;
  /**
   * The ONE state line this node renders — the card, its accessible name, and
   * every test read it here so the pixels and the name can never disagree.
   *
   *  - a dispatched node reports its own liveness ("Working", "Done", …);
   *  - a seat with NO job in this mission reports "no dispatch yet", which is
   *    the only place that string may come from;
   *  - the HUB reports the MISSION: MUON's own turn can end while the children
   *    it dispatched keep running, and a bare "Done" over a live crew is the
   *    exact lie this panel exists to prevent.
   */
  stateText: string;
  attention: boolean;
  livenessReason: string | null;
  /**
   * The job this node activates on click. `null` for an idle seat with no
   * dispatch yet — such a node is NOT clickable (no fake liveness, matching
   * the crew-row rule the sidebar already follows).
   */
  jobId: string | null;
  brief: string | null;
  depth: number;
  /** Workspace paths this node is contending for (open `edit` claim clash). */
  conflictPaths: string[];
  claimedPaths: number | null;
  unreadMessages: number | null;
  /** Adapter-probed lane health from the roles route, when it is known. */
  laneHealth: LaneHealthIpc | null;
  children: TopologyNode[];
};

export type TopologyEdgeKind = "dispatch" | "delegation" | "seat" | "a2a";

export type TopologyEdge = {
  id: string;
  from: string;
  to: string;
  kind: TopologyEdgeKind;
  /** Peer-message count for an `a2a` edge. */
  count?: number;
};

export type TopologyNotice = {
  tone: "info" | "warn";
  text: string;
};

export type CrewTopology = {
  hub: TopologyNode;
  lanes: TopologyNode[];
  edges: TopologyEdge[];
  /** Open `edit`-vs-`edit` claim clashes, grouped by path. */
  conflicts: Array<{ path: string; holders: ClaimConflictIpc[] }>;
  roleBindings: RoleBindingIpc[];
  unfilledRoles: AgentRoleIpc[];
  /**
   * Whether `roleBindings` is a COMMITMENT (`assigned`) or the crew MUON would
   * bind if work were dispatched now (`proposed`). Carried on the model, not
   * just the response, so every consumer of `roleBindings` reaches the status in
   * the same place — a badge that says "Implementer · Claude" is a different
   * claim in each case, and the rail must be able to say which.
   */
  rolePlanStatus: CrewPlanStatusIpc;
  /** UNTRUSTED agent-authored envelopes, newest first. */
  messages: PeerMessageIpc[];
  totalMessageCount: number;
  /** True when a snapshot exists but carries coordinates only (no bodies). */
  messagesOmitted: boolean;
  notices: TopologyNotice[];
  /** Every node in render order — hub, lanes, then each lane's subagents. */
  nodes: TopologyNode[];
};

/**
 * Display label per topology node.
 *
 * WAVE D: the registry answers for every vendor. The one extra row is a
 * PROVIDER key rather than a vendor id — topology nodes can be built from either
 * side — and an id from neither namespace still renders as itself.
 */
export function vendorLabel(vendor: string): string {
  if (vendor === "openai") {
    return "OpenAI";
  }
  return vendorShortLabel(vendor);
}

export function roleLabel(role: AgentRoleIpc): string {
  return role === "qa" ? "QA" : role[0]!.toUpperCase() + role.slice(1);
}

/** Worst-first ordering — an aggregate lane reports its most actionable child. */
const LIVENESS_SEVERITY: Record<CrewLiveness, number> = {
  "needs-attention": 6,
  stalled: 5,
  "budget-low": 5,
  "waiting-approval": 4,
  progressing: 3,
  live: 3,
  launching: 2,
  queued: 1,
  done: 0,
};

function livenessOf(node: DispatchTreeNode, now: number) {
  return deriveCrewLiveness(
    {
      status: node.status,
      exitCode: node.exitCode,
      // Time the startup window from LAUNCH (matches the runner watchdog) —
      // identical to the crew tree in cockpit.tsx, so the two never disagree.
      createdAt: node.startedAt ?? node.createdAt,
      lastProgressAt: node.lastProgressAt,
      waitingApproval: node.waitingApproval,
      result: node.result,
    },
    now
  );
}

function flatten(node: DispatchTreeNode): DispatchTreeNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

function isActive(status: string): boolean {
  return status === "running" || status === "queued";
}

/** Deterministic: active first, then shallowest, then oldest, then by id. */
function primaryFirst(left: DispatchTreeNode, right: DispatchTreeNode): number {
  const activeDelta = Number(isActive(right.status)) - Number(isActive(left.status));
  if (activeDelta !== 0) return activeDelta;
  if (left.depth !== right.depth) return left.depth - right.depth;
  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) return created;
  return left.id.localeCompare(right.id);
}

/**
 * The mission this panel is watching, chosen by the SHARED rule in
 * `@muon/client/mission-root` — the same function `muon crew coord` and the Ink
 * cockpit call. Re-exported here because the A2A coordination route is addressed
 * by (chatId, missionId) and the fetch has to name the SAME mission the chart
 * draws; keeping one import site means the panel and the request can never be
 * pointed at different roots.
 *
 * The rule (and the real run that forced it) is documented once, at the shared
 * implementation. In one line: a chat holds many roots, and the mission is the
 * root that owns the WORK — not whichever root is newest.
 */
export { selectMissionRootId };

export type BuildTopologyInput = {
  chatId: string;
  /** Jobs ALREADY scoped to this chat (app.tsx's chatScope.jobs). */
  jobs: DispatchJobRecord[];
  /** The chat's orchestrator seat vendor — labels the MUON hub. */
  orchestratorVendor: string;
  /** Vendors seated in the fleet, so an idle lane still shows on the chart. */
  fleetVendors: readonly string[];
  roles: CrewRolesResponse | null;
  coordination: CoordinationResponse | null;
  now?: number;
};

export function buildCrewTopology(input: BuildTopologyInput): CrewTopology {
  const now = input.now ?? Date.now();
  const notices: TopologyNotice[] = [];

  const rolesOk = input.roles?.status === "ok" ? input.roles : null;
  const coordinationOk =
    input.coordination?.status === "ok" ? input.coordination : null;
  if (input.roles?.status === "unavailable") {
    notices.push({ tone: "info", text: `Roles unavailable — ${input.roles.reason}` });
  }
  if (input.coordination?.status === "unavailable") {
    notices.push({
      tone: "info",
      text: `Coordination unavailable — ${input.coordination.reason}`,
    });
  }

  const laneByVendor = new Map<string, CrewRoleLaneIpc>();
  for (const lane of rolesOk?.lanes ?? []) {
    laneByVendor.set(lane.vendor, lane);
  }
  /**
   * What a LANE is for, per vendor — and a lane is never the coordinator.
   *
   * `orchestrator` bindings are skipped outright. The hub IS that seat, and the
   * plan reaches this map with the role priority the assigner used, which puts
   * `orchestrator` FIRST. On the default single-vendor setup (only claude-code
   * installed, so it holds orchestrator AND a worker role) a first-binding-wins
   * map therefore badged the undispatched claude-code seat `Orchestrator` — a
   * second coordinator card, beside the hub, for a seat MUON never granted.
   * Taking the first NON-orchestrator binding gives that lane the role it is
   * really for; a vendor whose ONLY binding is orchestrator gets no lane at all
   * (see the seat filter below).
   */
  const worker = (role: AgentRoleIpc | undefined | null): boolean =>
    Boolean(role) && role !== "orchestrator";
  const roleByVendor = new Map<string, AgentRoleIpc>();
  for (const binding of rolesOk?.plan?.bindings ?? []) {
    if (worker(binding.role) && !roleByVendor.has(binding.vendor)) {
      roleByVendor.set(binding.vendor, binding.role);
    }
  }
  for (const lane of rolesOk?.lanes ?? []) {
    if (worker(lane.role) && !roleByVendor.has(lane.vendor)) {
      roleByVendor.set(lane.vendor, lane.role!);
    }
  }

  const snapshot = coordinationOk?.snapshot ?? null;
  const roleByJob = new Map<string, AgentRoleIpc>();
  const claimedByJob = new Map<string, number>();
  const unreadByJob = new Map<string, number>();
  for (const participant of snapshot?.participants ?? []) {
    roleByJob.set(participant.jobId, participant.role);
    claimedByJob.set(participant.jobId, participant.claimedPaths);
    unreadByJob.set(participant.jobId, participant.unreadMessages);
  }

  const conflictPathsByJob = new Map<string, string[]>();
  const conflictsByPath = new Map<string, ClaimConflictIpc[]>();
  for (const conflict of snapshot?.openConflicts ?? []) {
    const holders = conflictsByPath.get(conflict.path) ?? [];
    holders.push(conflict);
    conflictsByPath.set(conflict.path, holders);
    const paths = conflictPathsByJob.get(conflict.heldByJobId) ?? [];
    if (!paths.includes(conflict.path)) paths.push(conflict.path);
    conflictPathsByJob.set(conflict.heldByJobId, paths);
  }

  // ── lineage ───────────────────────────────────────────────────────────────
  const forest = buildDispatchForest(input.jobs);
  if (forest.degraded && forest.degradationReason) {
    notices.push({ tone: "warn", text: forest.degradationReason });
  }
  // The SAME mission the coordination read was addressed to (selectMissionRootId
  // resolves the id off this very choice). `now` is threaded in because the rule
  // ages out an abandoned queued claim: the panel and the request must judge
  // freshness against the same instant, or they could name different roots.
  const root = selectMissionRoot(input.jobs, { now })?.root ?? null;
  const descendants = root ? flatten(root).filter((node) => node.id !== root.id) : [];
  // Real parentage, kept so an edge can name the act that produced each job:
  // MUON dispatched it (parent = the mission root) or another agent delegated it.
  const parentJobById = new Map(
    descendants.map((node) => [node.id, node.parentJobId])
  );

  // Codenames for the whole crew at once so two colliding hashes disambiguate
  // exactly the way the tab strip and crew tree already do.
  const codenameSources = [
    ...(root ? [root.id] : []),
    ...descendants.map((node) => node.id),
  ];
  const codenames = agentCodenames(codenameSources);

  // ── lanes ─────────────────────────────────────────────────────────────────
  const byVendor = new Map<string, DispatchTreeNode[]>();
  for (const node of descendants) {
    const bucket = byVendor.get(node.vendor) ?? [];
    bucket.push(node);
    byVendor.set(node.vendor, bucket);
  }
  // Every vendor MUON knows about in this mission: dispatched lanes first (in a
  // stable vendor order), then seated-but-idle lanes from the fleet/role plan,
  // then any coordination participant we somehow have no job for.
  const seatVendors = new Set<string>([
    ...input.fleetVendors,
    ...(rolesOk?.lanes ?? []).map((lane) => lane.vendor),
    ...(rolesOk?.plan?.bindings ?? []).map((binding) => binding.vendor),
    ...(snapshot?.participants ?? []).map((participant) => participant.vendor),
  ]);
  // The orchestrator's OWN seat is the hub, so its vendor is not repeated as an
  // idle lane. But a WORKER lane that merely SHARES that vendor is a different
  // seat entirely — a claude-code docs worker under a claude-code orchestrator —
  // and dropping it by vendor id is what erased that lane from the chart
  // completely. Keep it whenever something names it as a worker: a plan
  // binding, a lane record, or a live coordination participant. (`worker` is the
  // same predicate that kept `orchestrator` out of the lane role map above — one
  // definition, so "is this a lane?" cannot be answered two different ways.)
  const orchestratorHoldsAWorkerSeat =
    (rolesOk?.plan?.bindings ?? []).some(
      (binding) =>
        binding.vendor === input.orchestratorVendor && worker(binding.role)
    ) ||
    (rolesOk?.lanes ?? []).some(
      (lane) => lane.vendor === input.orchestratorVendor && worker(lane.role)
    ) ||
    (snapshot?.participants ?? []).some(
      (participant) =>
        participant.vendor === input.orchestratorVendor &&
        worker(participant.role)
    );
  if (!orchestratorHoldsAWorkerSeat) {
    seatVendors.delete(input.orchestratorVendor);
  }
  const dispatchedVendors = [...byVendor.keys()].sort((a, b) =>
    a.localeCompare(b)
  );
  const idleVendors = [...seatVendors]
    .filter((vendor) => !byVendor.has(vendor))
    .sort((a, b) => a.localeCompare(b));

  const edges: TopologyEdge[] = [];
  const nodeById = new Map<string, TopologyNode>();

  const toNode = (
    node: DispatchTreeNode,
    kind: TopologyNodeKind
  ): TopologyNode => {
    const liveness = livenessOf(node, now);
    const planRole = roleByVendor.get(node.vendor) ?? null;
    const coordRole = roleByJob.get(node.id) ?? null;
    const role =
      coordRole ??
      planRole ??
      (node.authority === "orchestrator" ? ("orchestrator" as const) : null);
    return {
      id: node.id,
      kind,
      vendor: node.vendor,
      label: codenames.get(node.id) ?? vendorLabel(node.vendor),
      role,
      roleSource: coordRole
        ? "coordination"
        : planRole
          ? "plan"
          : role
            ? "authority"
            : null,
      status: node.status,
      liveness: liveness.state,
      stateText: crewLivenessLabel(liveness.state),
      attention: liveness.attention,
      livenessReason: liveness.attention ? (liveness.reason ?? null) : null,
      jobId: node.id,
      brief: node.brief || null,
      depth: node.depth,
      conflictPaths: conflictPathsByJob.get(node.id) ?? [],
      claimedPaths: claimedByJob.get(node.id) ?? null,
      unreadMessages: unreadByJob.get(node.id) ?? null,
      laneHealth: laneByVendor.get(node.vendor)?.health ?? null,
      children: [],
    };
  };

  const lanes: TopologyNode[] = [];
  for (const vendor of dispatchedVendors) {
    const group = [...byVendor.get(vendor)!].sort(primaryFirst);
    const [primary, ...rest] = group;
    const lane = toNode(primary!, "lane");
    lane.children = rest
      .sort((left, right) =>
        left.depth !== right.depth
          ? left.depth - right.depth
          : left.createdAt.localeCompare(right.createdAt)
      )
      .map((child) => toNode(child, "subagent"));
    // A lane speaks for its whole subtree: it reports the most actionable
    // state under it, so a stalled grandchild can never hide behind a calm
    // parent.
    for (const child of lane.children) {
      if (LIVENESS_SEVERITY[child.liveness] > LIVENESS_SEVERITY[lane.liveness]) {
        lane.liveness = child.liveness;
        lane.attention = lane.attention || child.attention;
      }
    }
    // …and its state LINE reports the state it just adopted. The dot and the
    // sentence beside it are one claim; they must never disagree.
    lane.stateText = crewLivenessLabel(lane.liveness);
    lanes.push(lane);
  }
  for (const vendor of idleVendors) {
    const lane = laneByVendor.get(vendor);
    lanes.push({
      id: `lane:${vendor}`,
      kind: "lane",
      vendor,
      label: lane?.displayName ?? vendorLabel(vendor),
      role: roleByVendor.get(vendor) ?? null,
      roleSource: roleByVendor.has(vendor) ? "plan" : null,
      status: "idle",
      liveness: "queued",
      // The ONLY place this string is produced: a seat with zero jobs in this
      // mission. A lane that was dispatched always reports its real liveness.
      stateText: "no dispatch yet",
      attention: false,
      livenessReason: null,
      // No dispatch yet ⇒ nothing to open. Never a clickable dead end.
      jobId: null,
      brief: null,
      depth: 1,
      conflictPaths: [],
      claimedPaths: null,
      unreadMessages: null,
      laneHealth: lane?.health ?? null,
      children: [],
    });
  }

  // ── hub ───────────────────────────────────────────────────────────────────
  const hub: TopologyNode = root
    ? { ...toNode(root, "hub"), label: "MUON", role: "orchestrator", roleSource: "authority" }
    : {
        id: "hub",
        kind: "hub",
        vendor: input.orchestratorVendor,
        label: "MUON",
        role: "orchestrator",
        roleSource: "authority",
        status: "idle",
        liveness: "queued",
        stateText: "no dispatch yet",
        attention: false,
        livenessReason: null,
        jobId: null,
        brief: null,
        depth: 0,
        conflictPaths: [],
        claimedPaths: null,
        unreadMessages: null,
        laneHealth: null,
        children: [],
      };
  hub.children = lanes;

  // MUON's own turn ended, but its crew has not — the hub reports the MISSION.
  const workingChildren = descendants.filter((node) =>
    isActive(node.status)
  ).length;
  if (workingChildren > 0) {
    const noun = workingChildren === 1 ? "child" : "children";
    hub.stateText =
      hub.liveness === "done"
        ? `waiting on ${workingChildren} ${noun}`
        : `${hub.stateText} · waiting on ${workingChildren} ${noun}`;
  }

  nodeById.set(hub.id, hub);
  for (const lane of lanes) {
    nodeById.set(lane.id, lane);
    for (const child of lane.children) {
      nodeById.set(child.id, child);
    }
  }
  // EVERY edge names the act that really happened. A job MUON dispatched itself
  // carries a hub→job DISPATCH edge even when another job of the same vendor is
  // already the lane head — attaching it under that lane would claim a
  // delegation no agent ever made. A `seat` edge is the honest line to a lane
  // nobody has dispatched into: it keeps the seat attached to the chart without
  // drawing a dispatch that did not occur.
  for (const lane of lanes) {
    for (const node of [lane, ...lane.children]) {
      const parentJobId = node.jobId
        ? (parentJobById.get(node.jobId) ?? null)
        : null;
      const delegatedBy =
        parentJobId && parentJobId !== root?.id && nodeById.has(parentJobId)
          ? parentJobId
          : null;
      if (delegatedBy) {
        edges.push({
          id: `g:${delegatedBy}->${node.id}`,
          from: delegatedBy,
          to: node.id,
          kind: "delegation",
        });
        continue;
      }
      edges.push({
        id: `${node.jobId ? "d" : "s"}:${hub.id}->${node.id}`,
        from: hub.id,
        to: node.id,
        kind: node.jobId ? "dispatch" : "seat",
      });
    }
  }

  // ── A2A edges ─────────────────────────────────────────────────────────────
  // Drawn ONLY from real envelopes with an exact job↔job address. A role/crew
  // fan-out has no single peer, and a bare `messageCount` names no pair at all,
  // so neither invents an edge — the rail reports those as counts instead.
  const pairCounts = new Map<string, number>();
  for (const message of coordinationOk?.messages ?? []) {
    if (!message.toJobId) continue;
    const from = nodeById.has(message.fromJobId) ? message.fromJobId : null;
    const to = nodeById.has(message.toJobId) ? message.toJobId : null;
    if (!from || !to || from === to) continue;
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of [...pairCounts.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const [from, to] = key.split("|") as [string, string];
    edges.push({ id: `a:${key}`, from, to, kind: "a2a", count });
  }

  const messages = [...(coordinationOk?.messages ?? [])].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  );
  const totalMessageCount = snapshot?.messageCount ?? messages.length;
  // The rail's empty state must never contradict its own header count. The
  // loader already derives this from the renderable outcome; restating the
  // invariant HERE is what makes the contradiction unrepresentable no matter
  // what the bridge said.
  const messagesOmitted = coordinationOk
    ? coordinationOk.messagesOmitted ||
      (messages.length === 0 && totalMessageCount > 0)
    : false;

  return {
    hub,
    lanes,
    edges,
    conflicts: [...conflictsByPath.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, holders]) => ({ path, holders })),
    roleBindings: rolesOk?.plan?.bindings ?? [],
    unfilledRoles: rolesOk?.plan?.unfilled ?? [],
    // No readable plan ⇒ no claim about one. A roles read that failed leaves
    // the chart running on local dispatch authority alone, which is `none`.
    rolePlanStatus: rolesOk?.planStatus ?? "none",
    messages,
    totalMessageCount,
    messagesOmitted,
    notices,
    nodes: [hub, ...lanes.flatMap((lane) => [lane, ...lane.children])],
  };
}

/* ── layout ──────────────────────────────────────────────────────────────── */

export type TopologyPoint = { x: number; y: number };

export type TopologyLayout = {
  width: number;
  height: number;
  positions: Map<string, TopologyPoint>;
};

const HUB_RADIUS = 0;
const LANE_RING = 232;
const SUBAGENT_RING_GAP = 168;
const NODE_HALF_W = 92;
const NODE_HALF_H = 34;
const PADDING = 28;

/**
 * Deterministic radial placement — MUON at the center, lanes on a ring, each
 * lane's subagents fanned on an outer arc centered on their lane's bearing.
 * Pure (no DOM measurement), so it renders identically in tests and in the app,
 * and the stage size it reports is what the panel scrolls inside.
 */
export function layoutCrewTopology(topology: CrewTopology): TopologyLayout {
  const positions = new Map<string, TopologyPoint>();
  const lanes = topology.lanes;
  const laneCount = lanes.length;
  const laneRing = Math.max(LANE_RING, laneCount * 46);

  const raw: Array<{ id: string; x: number; y: number }> = [
    { id: topology.hub.id, x: HUB_RADIUS, y: HUB_RADIUS },
  ];

  // 1 lane reads best to the right of the hub; 2 read best as a left/right
  // pair; 3+ fan evenly from the top, clockwise.
  const startAngle = laneCount === 1 ? 0 : laneCount === 2 ? 180 : -90;
  const step = laneCount > 0 ? 360 / laneCount : 0;

  lanes.forEach((lane, index) => {
    const angle = ((startAngle + index * step) * Math.PI) / 180;
    const lx = Math.cos(angle) * laneRing;
    const ly = Math.sin(angle) * laneRing;
    raw.push({ id: lane.id, x: lx, y: ly });

    const children = lane.children;
    if (children.length === 0) return;
    const spreadDeg = Math.min(38, (laneCount > 1 ? step : 90) * 0.62);
    const childRing = laneRing + SUBAGENT_RING_GAP;
    children.forEach((child, childIndex) => {
      // Fan the children across `spreadDeg` TOTAL, centered on the lane's own
      // bearing — so one child sits exactly outboard of its lane and N children
      // never overrun into the neighbouring lane's wedge.
      const offset =
        children.length === 1
          ? 0
          : (childIndex / (children.length - 1) - 0.5) * spreadDeg;
      const childAngle =
        (((startAngle + index * step) + offset) * Math.PI) / 180;
      raw.push({
        id: child.id,
        x: Math.cos(childAngle) * childRing,
        y: Math.sin(childAngle) * childRing,
      });
    });
  });

  const minX = Math.min(...raw.map((point) => point.x)) - NODE_HALF_W - PADDING;
  const maxX = Math.max(...raw.map((point) => point.x)) + NODE_HALF_W + PADDING;
  const minY = Math.min(...raw.map((point) => point.y)) - NODE_HALF_H - PADDING;
  const maxY = Math.max(...raw.map((point) => point.y)) + NODE_HALF_H + PADDING;

  for (const point of raw) {
    positions.set(point.id, {
      x: Math.round(point.x - minX),
      y: Math.round(point.y - minY),
    });
  }

  return {
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
    positions,
  };
}

/**
 * A gently bowed edge path. Straight lines through a dense hub read as a
 * starburst; a small perpendicular bow is the same visual idiom the knowledge
 * graph uses for its curved edges.
 */
export function edgePath(
  from: TopologyPoint,
  to: TopologyPoint,
  bow = 0.12
): string {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const controlX = midX - dy * bow;
  const controlY = midY + dx * bow;
  return `M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`;
}
