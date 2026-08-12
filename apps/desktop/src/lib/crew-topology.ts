import type {
  AgentRoleIpc,
  ClaimConflictIpc,
  CoordinationParticipantIpc,
  CoordinationResponse,
  CoordinationSnapshotIpc,
  CrewPlanStatusIpc,
  CrewCostAccountingIpc,
  CrewRoleLaneIpc,
  CrewRolePlanIpc,
  CrewRolesResponse,
  LaneHealthIpc,
  PeerMessageIpc,
  PeerMessageKindIpc,
  RoleBindingIpc,
} from "../shared/ipc.js";
import { AGENT_ROLES_IPC } from "../shared/ipc.js";

/**
 * Crew topology data loaders (main process).
 *
 * These two routes (`/api/crew/roles`, `/api/a2a/coordination`) are NEWER than
 * the desktop surface that renders them, so this module is written FEATURE-
 * DETECTING and FAIL-SOFT end to end:
 *
 *  - It never throws. A 404 (route absent), a 401/403, a timeout, a refused
 *    socket, a non-JSON body, or a body whose shape we do not recognize all
 *    resolve to `{ status: "unavailable", reason }`. The topology panel then
 *    renders from the desktop's OWN dispatch-job state, which always exists.
 *  - It never trusts the payload. Every field is re-validated here (main is
 *    trusted, the brain response is data): unknown roles are dropped, arrays
 *    are capped, and every agent-authored string is length-clamped BEFORE it
 *    crosses IPC. The caps mirror packages/protocol/src/a2a.ts.
 *  - It carries no token to the renderer — only the projected shapes.
 *
 * WHY NOT `@muon/client`'s loadCrewRoles / loadCoordinationSnapshot /
 * listPeerMessages? Those are the STRICT readers, and strictness is right for
 * an agent surface: they throw on any schema deviation and carry no request
 * timeout. This surface needs the opposite posture — a bounded request, a 404
 * read as "feature absent", and per-ROW tolerance so one malformed binding
 * costs one badge instead of the whole plan. The role vocabulary mirrored in
 * shared/ipc.ts is drift-guarded against the protocol's own enum by
 * tests/crew-topology-loader.test.ts.
 */

const REQUEST_TIMEOUT_MS = 6_000;

// Mirrors packages/protocol/src/a2a.ts caps. Restated (not imported) because
// @muon/protocol is deliberately not a desktop dependency — see shared/ipc.ts.
const MAX_PEER_SUBJECT_CHARS = 120;
const MAX_PEER_BODY_CHARS = 2_000;
const MAX_BINDINGS = 32;
const MAX_LANES = 32;
const MAX_PARTICIPANTS = 32;
const MAX_CONFLICTS = 64;
const MAX_MESSAGES = 25;
const MAX_VENDOR_CHARS = 64;
const MAX_NAME_CHARS = 64;
const MAX_REASON_CHARS = 400;
const MAX_PATH_CHARS = 260;
const MAX_ID_CHARS = 128;
const MAX_STATUS_CHARS = 32;

const PEER_MESSAGE_KINDS: readonly PeerMessageKindIpc[] = [
  "question",
  "answer",
  "review_request",
  "review_verdict",
  "constraint",
  "status",
  "blocked",
];

export type CrewTopologyFetcher = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type CrewTopologyRequest = {
  apiBase: string;
  apiToken?: string;
  chatId: string;
  missionId?: string;
  fetcher?: CrewTopologyFetcher;
  timeoutMs?: number;
};

/* ── primitive coercion ─────────────────────────────────────────────────── */

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function unitInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function role(value: unknown): AgentRoleIpc | null {
  return typeof value === "string" &&
    (AGENT_ROLES_IPC as readonly string[]).includes(value)
    ? (value as AgentRoleIpc)
    : null;
}

/**
 * A vendor id is a lane KEY, not free text — the renderer resolves a glyph and
 * a label from it. So it gets the same treatment as `role`: a SHAPE check, not
 * just a length clamp. Anything with whitespace, a path separator, markup, or a
 * leading underscore is not a vendor id and is dropped, which drops the one row
 * that carried it rather than rendering an unattributable badge.
 *
 * The renderer never indexes a plain object with one of these (vendor-icon.tsx
 * uses `Object.hasOwn`); rejecting the JS prototype names here is the second
 * layer, not the only one.
 */
const VENDOR_ID = /^[a-z0-9][a-z0-9._:-]*$/;

/** `constructor`, `toString`, `valueOf`, `__proto__`, … — a JS object property
 * name, never a vendor. Checked on both the raw and the folded form. */
function namesAnObjectProperty(value: string): boolean {
  return value in Object.prototype;
}

function vendorId(value: unknown): string | null {
  const raw = text(value, MAX_VENDOR_CHARS);
  if (!raw) return null;
  // Vendor ids are canonically lowercase (`claude-code`, `codex`, `opencode`), so
  // fold case here rather than letting `Codex` miss its own glyph downstream.
  const id = raw.toLowerCase();
  if (!VENDOR_ID.test(id)) return null;
  return namesAnObjectProperty(raw) || namesAnObjectProperty(id) ? null : id;
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

/* ── transport ──────────────────────────────────────────────────────────── */

type Outcome<T> =
  | { ok: true; body: unknown }
  /**
   * `retryable` marks the failures that can pass on their own (refused socket,
   * timeout, 5xx/429). An absent route, a missing fetcher, or a bad address
   * answer the same way every time, so they are NOT retryable — see
   * UnavailableIpc in shared/ipc.ts.
   */
  | { ok: false; reason: string; retryable: boolean };

async function readJson(
  request: CrewTopologyRequest,
  path: string,
  absentReason: string
): Promise<Outcome<unknown>> {
  const base = request.apiBase?.replace(/\/+$/, "");
  if (!base) {
    return {
      ok: false,
      reason: "No brain address is configured.",
      retryable: false,
    };
  }
  const fetcher = request.fetcher ?? (globalThis.fetch as CrewTopologyFetcher);
  if (typeof fetcher !== "function") {
    return { ok: false, reason: absentReason, retryable: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    request.timeoutMs ?? REQUEST_TIMEOUT_MS
  );
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (request.apiToken) {
      headers.authorization = `Bearer ${request.apiToken}`;
    }
    const response = await fetcher(`${base}${path}`, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 501) {
      // The canonical "this brain build predates the route" answer. Quiet, not
      // an error: the panel degrades to local dispatch state. Never retried —
      // an absent route stays absent for the life of this brain process.
      return { ok: false, reason: absentReason, retryable: false };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: `The brain answered ${response.status} for this read.`,
        // 5xx/429/408 are the statuses a second attempt can clear. A 401/403 is
        // a standing answer about who we are, not a blip.
        retryable:
          response.status >= 500 ||
          response.status === 429 ||
          response.status === 408,
      };
    }
    return { ok: true, body: await response.json() };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "the request did not complete";
    return {
      ok: false,
      // A refused socket, a DNS blip, or our own abort — the brain may simply
      // still be coming up, so this is the case one bounded retry exists for.
      reason: `Could not reach the brain: ${message.slice(0, 160)}`,
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ── /api/crew/roles ────────────────────────────────────────────────────── */

function projectBinding(raw: unknown): RoleBindingIpc | null {
  const row = record(raw);
  if (!row) return null;
  const vendor = vendorId(row.vendor);
  const bound = role(row.role);
  // A binding with no recognizable vendor or role names nothing renderable.
  if (!vendor || !bound) return null;
  const blockedReason = text(row.blockedReason, MAX_REASON_CHARS);
  return {
    vendor,
    role: bound,
    fit: unitInterval(row.fit),
    reason: text(row.reason, MAX_REASON_CHARS) ?? "No reason was recorded.",
    assignedBy: row.assignedBy === "human" ? "human" : "muon",
    blocked: row.blocked === true,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

function projectPlan(raw: unknown, chatId: string): CrewRolePlanIpc | null {
  const row = record(raw);
  if (!row) return null;
  const bindings = list(row.bindings, MAX_BINDINGS)
    .map(projectBinding)
    .filter((binding): binding is RoleBindingIpc => binding !== null);
  const unfilled = list(row.unfilled, AGENT_ROLES_IPC.length)
    .map(role)
    .filter((value): value is AgentRoleIpc => value !== null);
  if (bindings.length === 0 && unfilled.length === 0) {
    return null;
  }
  return {
    version: 1,
    chatId: text(row.chatId, MAX_ID_CHARS) ?? chatId,
    bindings,
    unfilled,
  };
}

/**
 * How sure are we that this plan is a COMMITMENT?
 *
 * Under-claiming is the only safe failure here — labelling a preview "assigned"
 * tells the operator MUON has decided something it has not. So:
 *   - a recognized status is taken at its word;
 *   - an ABSENT status means an older brain, which could only ever answer with a
 *     stored plan ⇒ `assigned` (or `none` with no plan);
 *   - an UNRECOGNIZED status means a NEWER brain saying something this build
 *     does not understand ⇒ `proposed`, the weaker claim, never `assigned`.
 */
function planStatus(
  raw: unknown,
  plan: CrewRolePlanIpc | null
): CrewPlanStatusIpc {
  if (!plan) return "none";
  if (raw === undefined || raw === null) return "assigned";
  return raw === "assigned" || raw === "proposed" ? raw : "proposed";
}

const LANE_HEALTH: readonly LaneHealthIpc[] = [
  "healthy",
  "degraded",
  "unavailable",
];

function projectLane(raw: unknown): CrewRoleLaneIpc | null {
  const row = record(raw);
  if (!row) return null;
  const vendor = vendorId(row.vendor);
  if (!vendor) return null;
  const bound = role(row.role);
  const displayName = text(row.displayName, MAX_NAME_CHARS);
  const health =
    typeof row.health === "string" &&
    (LANE_HEALTH as readonly string[]).includes(row.health)
      ? (row.health as LaneHealthIpc)
      : null;
  const costOrdinal =
    typeof row.costOrdinal === "number" && Number.isFinite(row.costOrdinal)
      ? row.costOrdinal
      : typeof row.cost === "number" && Number.isFinite(row.cost)
        ? row.cost
        : null;
  return {
    vendor,
    ...(bound ? { role: bound } : {}),
    ...(displayName ? { displayName } : {}),
    ...(health ? { health } : {}),
    ...(costOrdinal !== null ? { cost: costOrdinal, costOrdinal } : {}),
  };
}

function projectCostAccounting(raw: unknown): CrewCostAccountingIpc | undefined {
  const row = record(raw);
  if (!row || row.metered !== false) return undefined;
  const notice = text(row.notice, 120);
  return notice ? { metered: false as const, notice } : undefined;
}

export async function loadCrewRoles(
  request: CrewTopologyRequest
): Promise<CrewRolesResponse> {
  const chatId = request.chatId?.trim();
  if (!chatId) {
    return { status: "unavailable", reason: "No chat is selected." };
  }
  const outcome = await readJson(
    request,
    `/api/crew/roles?chatId=${encodeURIComponent(chatId)}`,
    "Role assignment is not available in this brain build."
  );
  if (!outcome.ok) {
    return {
      status: "unavailable",
      reason: outcome.reason,
      retryable: outcome.retryable,
    };
  }
  const body = record(outcome.body);
  if (!body) {
    return {
      status: "unavailable",
      reason: "The role plan came back in an unexpected shape.",
    };
  }
  const lanes = list(body.lanes, MAX_LANES)
    .map(projectLane)
    .filter((lane): lane is CrewRoleLaneIpc => lane !== null);
  const plan = projectPlan(body.plan, chatId);
  const costAccounting = projectCostAccounting(body.costAccounting);
  return {
    status: "ok",
    plan,
    planStatus: planStatus(body.planStatus, plan),
    lanes,
    ...(costAccounting ? { costAccounting } : {}),
  };
}

/* ── /api/a2a/coordination ──────────────────────────────────────────────── */

function projectParticipant(raw: unknown): CoordinationParticipantIpc | null {
  const row = record(raw);
  if (!row) return null;
  const jobId = text(row.jobId, MAX_ID_CHARS);
  const vendor = vendorId(row.vendor);
  const bound = role(row.role);
  if (!jobId || !vendor || !bound) return null;
  const name = text(row.name, MAX_NAME_CHARS);
  return {
    jobId,
    vendor,
    role: bound,
    ...(name ? { name } : {}),
    status: text(row.status, MAX_STATUS_CHARS) ?? "unknown",
    claimedPaths: count(row.claimedPaths),
    unreadMessages: count(row.unreadMessages),
  };
}

function projectConflict(raw: unknown): ClaimConflictIpc | null {
  const row = record(raw);
  if (!row) return null;
  const path = text(row.path, MAX_PATH_CHARS);
  const heldByJobId = text(row.heldByJobId, MAX_ID_CHARS);
  const heldByVendor = vendorId(row.heldByVendor);
  const heldByRole = role(row.heldByRole);
  // A conflict we cannot attribute to a path AND a holder is not renderable —
  // showing "someone conflicts on something" would be worse than showing
  // nothing, so it is dropped rather than half-rendered.
  if (!path || !heldByJobId || !heldByVendor || !heldByRole) return null;
  const heldByName = text(row.heldByName, MAX_NAME_CHARS);
  return {
    path,
    heldByJobId,
    heldByRole,
    heldByVendor,
    ...(heldByName ? { heldByName } : {}),
    expiresAt: text(row.expiresAt, 40) ?? "",
  };
}

function projectMessage(raw: unknown): PeerMessageIpc | null {
  const row = record(raw);
  if (!row) return null;
  const id = text(row.id, MAX_ID_CHARS);
  const fromJobId = text(row.fromJobId, MAX_ID_CHARS);
  const fromVendor = vendorId(row.fromVendor);
  const fromRole = role(row.fromRole);
  const subject = text(row.subject, MAX_PEER_SUBJECT_CHARS);
  const body = text(row.body, MAX_PEER_BODY_CHARS);
  if (!id || !fromJobId || !fromVendor || !fromRole || !subject || !body) {
    return null;
  }
  const to = record(row.to);
  const toJobId =
    to && to.kind === "job" ? text(to.jobId, MAX_ID_CHARS) : null;
  const fromName = text(row.fromName, MAX_NAME_CHARS);
  const kind =
    typeof row.kind === "string" &&
    (PEER_MESSAGE_KINDS as readonly string[]).includes(row.kind)
      ? (row.kind as PeerMessageKindIpc)
      : "status";
  return {
    id,
    fromJobId,
    fromRole,
    fromVendor,
    ...(fromName ? { fromName } : {}),
    toJobId,
    kind,
    subject,
    body,
    createdAt: text(row.createdAt, 40) ?? "",
  };
}

function projectSnapshot(
  raw: unknown,
  chatId: string
): CoordinationSnapshotIpc | null {
  const row = record(raw);
  if (!row) return null;
  return {
    version: 1,
    chatId: text(row.chatId, MAX_ID_CHARS) ?? chatId,
    missionId: text(row.missionId, MAX_ID_CHARS) ?? "",
    participants: list(row.participants, MAX_PARTICIPANTS)
      .map(projectParticipant)
      .filter((p): p is CoordinationParticipantIpc => p !== null),
    openConflicts: list(row.openConflicts, MAX_CONFLICTS)
      .map(projectConflict)
      .filter((c): c is ClaimConflictIpc => c !== null),
    messageCount: count(row.messageCount),
  };
}

export async function loadCoordination(
  request: CrewTopologyRequest
): Promise<CoordinationResponse> {
  const chatId = request.chatId?.trim();
  if (!chatId) {
    return { status: "unavailable", reason: "No chat is selected." };
  }
  const missionId = request.missionId?.trim();
  if (!missionId) {
    // `GET /coordination` requires BOTH coordinates. Asking without a mission
    // would 400; saying so plainly here is the honest answer for a chat that
    // has not dispatched anything yet.
    return {
      status: "unavailable",
      reason: "No mission has been dispatched in this chat yet.",
    };
  }
  const scope = `chatId=${encodeURIComponent(chatId)}&missionId=${encodeURIComponent(missionId)}`;
  const outcome = await readJson(
    request,
    `/api/a2a/coordination?${scope}`,
    "Agent-to-agent coordination is not available in this brain build."
  );
  if (!outcome.ok) {
    return {
      status: "unavailable",
      reason: outcome.reason,
      retryable: outcome.retryable,
    };
  }
  const body = record(outcome.body);
  if (!body) {
    return {
      status: "unavailable",
      reason: "The coordination snapshot came back in an unexpected shape.",
    };
  }
  const snapshot = projectSnapshot(body.snapshot, chatId);

  // The transcript is a SEPARATE operator-tier read — the snapshot is
  // coordinates-only by contract and never carries agent text. Its failure is
  // NOT the snapshot's failure: the chart and the conflict list still render,
  // and the rail simply says the message text could not be read.
  const transcript = await readJson(
    request,
    `/api/a2a/messages?${scope}&limit=${MAX_MESSAGES}`,
    "Peer message text is not available in this brain build."
  );
  const transcriptBody = transcript.ok ? record(transcript.body) : null;
  const messages = list(transcriptBody?.messages, MAX_MESSAGES)
    .map(projectMessage)
    .filter((message): message is PeerMessageIpc => message !== null);

  return {
    status: "ok",
    snapshot,
    messages,
    // Derived from the RENDERABLE outcome, not from the transport: a 200 whose
    // body we could not read, an envelope every row of which failed validation,
    // and a dead transcript route all land here identically. Anything else lets
    // the rail badge "12 coordination messages" directly above "no peer
    // messages on this mission yet".
    messagesOmitted: messages.length === 0 && (snapshot?.messageCount ?? 0) > 0,
  };
}
