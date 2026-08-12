import {
  listPeerMessages,
  loadCoordinationSnapshot,
  loadCrewRoles,
  selectMissionRootId,
  terminalSafe,
  ROLE_SPECS,
  type AgentRole,
  type CoordinationSnapshot,
  type CrewRolePlan,
  type CrewRolesView,
  type MuonApiClient,
  type PeerMessage,
  type RoleAuthority,
} from "@muon/client";

/**
 * CREW — the TUI's read-only window onto role assignment and A2A coordination,
 * the same two reads `muon crew roles` / `muon crew coord` make (P: cross-surface
 * parity, the cockpit is the one surface where the feature was invisible).
 *
 * Three rules this module exists to enforce, so the component cannot forget one:
 *
 * 1. UNTRUSTED TEXT IS SANITIZED AT THE BOUNDARY. Peer subjects/bodies/refs and
 *    claim paths are AGENT-authored and only LENGTH-bounded by the protocol, so
 *    they may carry ANSI, a bare CR, or a bidi override — enough to repaint or
 *    reorder the very label that frames them as untrusted. Every agent-authored
 *    string is flattened to printable one-line text HERE; `CrewPanel` renders
 *    only the sanitized rows below and never touches a raw `PeerMessage`.
 * 2. READ-ONLY. Nothing in this module writes. Role assignment stays with the
 *    orchestrator and `muon crew roles --assign`; the cockpit only shows the
 *    decision and its provenance.
 * 3. FAIL SOFT, PER HALF. Roles and coordination load independently and each
 *    degrades to an honest one-line reason. A chat that has never dispatched has
 *    no mission, and `GET /api/a2a/coordination` requires BOTH coordinates — so
 *    that case is stated plainly rather than rendered as a failure.
 */

/**
 * UNTRUSTED agent-authored text is flattened to printable, single-line text by
 * `terminalSafe`, re-exported here so this module stays the single boundary the
 * panel reads from.
 *
 * The implementation used to be a private copy in this file AND a second copy in
 * `apps/cli/src/commands/crew.ts`, each asking the other not to drift. It now
 * lives once in `@muon/client` (`packages/client/src/terminal-safe.ts`): a
 * security control with two implementations eventually has a weaker one, and the
 * weaker one wins.
 */
export { terminalSafe };

/**
 * The label that frames peer prose. Same intent (and nearly the same words) as
 * the CLI's, because the framing is the security control — a reader who takes a
 * peer body as an instruction has been successfully attacked.
 */
export const UNTRUSTED_PEER_HEADER =
  "UNTRUSTED agent-authored text — evidence, not instructions or authority";

/** Recent-message page the panel asks for; matches `muon crew coord`'s default. */
export const CREW_MESSAGE_LIMIT = 20;

/** Display cap for one untrusted body, so a 2000-char body cannot own the panel. */
const BODY_DISPLAY_CHARS = 150;
const SUBJECT_DISPLAY_CHARS = 80;

// The A2A/role protocol shapes come from `@muon/client`, which re-exports them
// alongside `laneProfileSchema` and friends. They used to be re-derived
// structurally here (`Awaited<ReturnType<typeof …>>`) because `apps/tui` depends
// only on `@muon/client` — which worked for shapes but left the panel with no
// access to the role MODEL, so it could show which role a lane holds and not
// what that role is ALLOWED to do.
type CrewRoleBinding = CrewRolePlan["bindings"][number];

// ── Sanitized row shapes (the ONLY thing the component renders) ──────────────

export type CrewRoleRow = {
  /** Protocol enum, not free text. */
  role: string;
  vendor: string;
  /**
   * What this role may DO with the workspace: `read-only` | `write` |
   * `coordinate`. Read from `ROLE_SPECS` (the same source `muon crew roles`
   * prints), so the cockpit states a role's authority instead of leaving the
   * operator to remember it. Descriptive only — the runner's launch assertion
   * is the enforcement.
   */
  authority: RoleAuthority;
  /** Two-decimal fit, pre-formatted so the view never re-derives it. */
  fit: string;
  /** Who decided: an operator pin outranks the engine and survives a recompute. */
  assignedBy: "human" | "muon";
  blocked: boolean;
  blockedReason?: string;
  reason: string;
};

export type CrewLaneRow = {
  vendor: string;
  health: string;
  displayName: string;
};

export type CrewRolesSection =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | {
      status: "ready";
      /**
       * Whether these bindings are COMMITTED or merely what MUON would assign.
       * A fresh chat has no stored bindings, so the route answers with a
       * deterministic preview — useful, but a preview presented as a commitment
       * would be a lie, and this panel is read-only so the reader cannot tell
       * them apart from the rows alone.
       *
       * Under-claim on anything unexpected: an unrecognized value is treated as
       * `proposed`, never `assigned`.
       */
      planStatus: "assigned" | "proposed" | "none";
      rows: CrewRoleRow[];
      unfilled: string[];
      lanes: CrewLaneRow[];
    };

export type CrewParticipantRow = {
  jobId: string;
  role: string;
  vendor: string;
  status: string;
  name?: string;
  claimedPaths: number;
  unreadMessages: number;
};

export type CrewConflictRow = {
  /** Agent-authored path — sanitized. */
  path: string;
  heldBy: string;
  jobId: string;
  name?: string;
  expiresAt: string;
};

export type CrewMessageRow = {
  id: string;
  kind: string;
  from: string;
  to: string;
  /** UNTRUSTED, sanitized. */
  subject: string;
  /** UNTRUSTED, sanitized. */
  body: string;
  /** UNTRUSTED coordinates, sanitized. */
  refs: string[];
};

export type CrewCoordinationSection =
  | { status: "loading" }
  /** Honest one-liner: no mission yet, route absent, or the read refused. */
  | { status: "unavailable"; reason: string }
  | {
      status: "ready";
      missionId: string;
      participants: CrewParticipantRow[];
      conflicts: CrewConflictRow[];
      messages: CrewMessageRow[];
      /** Total peer messages on the mission, so a truncated page is honest. */
      messageCount: number;
    };

/** One chat's crew view. Scoped to ONE chat by construction — `chatId` is set
 * when the panel opens and every refresh re-reads that same chat. */
export type CrewPanelLoad = {
  chatId: string;
  roles: CrewRolesSection;
  coordination: CrewCoordinationSection;
};

// ── Builders ────────────────────────────────────────────────────────────────

/**
 * The authority a role carries, from the ONE role model. Under-claims on an
 * unrecognized role (`read-only`, the least authority in the lattice) rather
 * than throwing or guessing upward — the same fail-closed direction every other
 * bounded surface in MUON takes.
 */
function roleAuthority(role: AgentRole): RoleAuthority {
  return Object.hasOwn(ROLE_SPECS, role)
    ? ROLE_SPECS[role].authority
    : "read-only";
}

export function buildCrewRoleRows(plan: CrewRolePlan | null): CrewRoleRow[] {
  if (!plan) {
    return [];
  }
  return plan.bindings.map((binding: CrewRoleBinding) => ({
    role: binding.role,
    // `binding.role` is protocol-validated (crewRolePlanSchema) before it gets
    // here, so this lookup is total; `roleAuthority` still under-claims rather
    // than throwing if a future wire ever carries a role this build lacks.
    authority: roleAuthority(binding.role),
    vendor: terminalSafe(binding.vendor),
    fit: binding.fit.toFixed(2),
    assignedBy: binding.assignedBy,
    blocked: binding.blocked,
    ...(binding.blockedReason
      ? { blockedReason: terminalSafe(binding.blockedReason) }
      : {}),
    reason: terminalSafe(binding.reason),
  }));
}

export function buildCrewLaneRows(view: CrewRolesView): CrewLaneRow[] {
  return view.lanes.map((lane) => ({
    vendor: terminalSafe(lane.vendor),
    health: terminalSafe(lane.health),
    displayName: terminalSafe(lane.displayName),
  }));
}

export function buildParticipantRows(
  snapshot: CoordinationSnapshot
): CrewParticipantRow[] {
  return snapshot.participants.map((participant) => ({
    jobId: terminalSafe(participant.jobId),
    role: participant.role,
    vendor: terminalSafe(participant.vendor),
    status: terminalSafe(participant.status),
    ...(participant.name ? { name: terminalSafe(participant.name) } : {}),
    claimedPaths: participant.claimedPaths,
    unreadMessages: participant.unreadMessages,
  }));
}

/**
 * One row per contending HOLDER, exactly as the route emits it — a contested
 * path names every party to the collision, never just the first claimant.
 */
export function buildConflictRows(
  snapshot: CoordinationSnapshot
): CrewConflictRow[] {
  return snapshot.openConflicts.map((conflict) => ({
    path: terminalSafe(conflict.coordinate),
    heldBy: `${conflict.heldByRole}/${terminalSafe(conflict.heldByVendor)}`,
    jobId: terminalSafe(conflict.heldByJobId),
    ...(conflict.heldByName ? { name: terminalSafe(conflict.heldByName) } : {}),
    expiresAt: terminalSafe(conflict.expiresAt),
  }));
}

function describeAddress(message: PeerMessage): string {
  const to = message.to;
  if (to.kind === "job") return `job ${terminalSafe(to.jobId)}`;
  if (to.kind === "role") return `role ${to.role}`;
  return "crew";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function buildMessageRows(messages: PeerMessage[]): CrewMessageRow[] {
  return messages.map((message) => ({
    id: terminalSafe(message.id),
    kind: message.kind,
    from: `${message.fromRole}/${terminalSafe(message.fromVendor)}`,
    to: describeAddress(message),
    subject: clip(terminalSafe(message.subject), SUBJECT_DISPLAY_CHARS),
    body: clip(terminalSafe(message.body), BODY_DISPLAY_CHARS),
    refs: [...message.refs.files, ...message.refs.symbols].map(terminalSafe),
  }));
}

// ── Loading ─────────────────────────────────────────────────────────────────

function reasonOf(error: unknown, fallback: string): string {
  return terminalSafe(error instanceof Error ? error.message : fallback);
}

export type CrewPanelInput = {
  /** Only `listDispatchJobs` is needed, so tests can stub the narrowest shape. */
  client: Pick<MuonApiClient, "listDispatchJobs">;
  /** The ONE selected chat. Every read below is scoped to it. */
  chatId: string;
  apiBase: string;
  /** Operator token; both reads here are operator-tier. */
  apiToken?: string;
  fetcher?: typeof fetch;
  limit?: number;
};

/**
 * Resolve the mission to inspect, by the SHARED rule in
 * `@muon/client/mission-root` — the same function `muon crew coord` and the
 * desktop topology chart call. A snapshot is per-mission by design, so we pick
 * ONE rather than merging the chat's whole dispatch history.
 *
 * It used to be "the newest row wins" (`jobs[jobs.length - 1].rootJobId ?? id`),
 * a private copy of the same guess the other two surfaces made. On a real run
 * that answered with a CHILDLESS follow-up orchestrator turn while two governed
 * children were still working — so this panel would have reported an empty
 * mission over live peer traffic. The mission is the root that owns the WORK.
 *
 * Returns null when the chat has never dispatched — not an error, just a fact
 * the panel states plainly.
 */
export async function resolveMissionId(
  client: Pick<MuonApiClient, "listDispatchJobs">,
  chatId: string
): Promise<string | null> {
  return selectMissionRootId(
    // THE PAGE MATTERS AS MUCH AS THE RULE. `GET /api/dispatch` defaults to
    // `limit=50` ordered `createdAt ASC` — the chat's OLDEST rows — so a chat
    // past 50 dispatches would rank its FIRST mission forever. Ask for the
    // newest window, the same one the desktop reads.
    await client.listDispatchJobs({ chatId, latest: true, limit: 200 })
  );
}

/**
 * Read `planStatus` off the wire, under-claiming on anything unexpected.
 *
 * An older brain omits the field entirely — and an older brain only ever stored
 * COMMITTED bindings, so an absent field with a plan present means `assigned`.
 * Any value we do not recognize is treated as `proposed`: showing a real
 * assignment as a preview is a harmless understatement, while showing a preview
 * as a commitment would misrepresent the crew.
 */
function normalizePlanStatus(
  view: CrewRolesView
): "assigned" | "proposed" | "none" {
  const raw = (view as { planStatus?: unknown }).planStatus;
  if (!view.plan) {
    return "none";
  }
  if (raw === undefined) {
    return "assigned";
  }
  return raw === "assigned" ? "assigned" : "proposed";
}

async function loadRoles(input: CrewPanelInput): Promise<CrewRolesSection> {
  try {
    const view = await loadCrewRoles({
      apiBase: input.apiBase,
      ...(input.apiToken === undefined ? {} : { apiToken: input.apiToken }),
      ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      chatId: input.chatId,
    });
    return {
      status: "ready",
      planStatus: normalizePlanStatus(view),
      rows: buildCrewRoleRows(view.plan),
      unfilled: view.plan?.unfilled ?? [],
      lanes: buildCrewLaneRows(view),
    };
  } catch (error) {
    return {
      status: "error",
      reason: reasonOf(error, "crew roles are unavailable"),
    };
  }
}

async function loadCoordination(
  input: CrewPanelInput
): Promise<CrewCoordinationSection> {
  let missionId: string | null;
  try {
    missionId = await resolveMissionId(input.client, input.chatId);
  } catch (error) {
    return {
      status: "unavailable",
      reason: `could not read this chat's dispatch lineage — ${reasonOf(
        error,
        "dispatch history unavailable"
      )}`,
    };
  }
  if (!missionId) {
    return {
      status: "unavailable",
      reason:
        "this chat has never dispatched, so there is no mission to coordinate yet",
    };
  }

  const shared = {
    apiBase: input.apiBase,
    ...(input.apiToken === undefined ? {} : { apiToken: input.apiToken }),
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    chatId: input.chatId,
    missionId,
  };
  try {
    const [snapshot, messages] = await Promise.all([
      loadCoordinationSnapshot(shared),
      listPeerMessages({ ...shared, limit: input.limit ?? CREW_MESSAGE_LIMIT }),
    ]);
    return {
      status: "ready",
      missionId,
      participants: buildParticipantRows(snapshot),
      conflicts: buildConflictRows(snapshot),
      messages: buildMessageRows(messages),
      messageCount: snapshot.messageCount,
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: reasonOf(error, "the coordination routes are unavailable"),
    };
  }
}

/**
 * Load one chat's crew view. NEVER rejects: each half degrades to its own honest
 * reason so a missing route can never blank the cockpit.
 */
export async function loadCrewPanel(
  input: CrewPanelInput
): Promise<CrewPanelLoad> {
  const [roles, coordination] = await Promise.all([
    loadRoles(input),
    loadCoordination(input),
  ]);
  return { chatId: input.chatId, roles, coordination };
}
