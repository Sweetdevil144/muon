import { createHash, timingSafeEqual } from "node:crypto";
import {
  ATTACHED_COORDINATOR_CAPABILITY_MODE,
  ATTACHED_COORDINATOR_BOOTSTRAP_TTL_MS,
  ATTACHED_COORDINATOR_LEASE_HORIZON_MS,
} from "@muon/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "./db.js";

// ── P3-A: capability + principal separation ──────────────────────────────────
//
// The loopback API is a TWO-TIER credential model. Every /api/* request is
// classified by WHICH token it presents, and the authenticated principal is
// derived from the tier, NEVER from a free-form request body. This is what
// closes the audit's #1 blocker: the token injected into dispatched sub-agents
// used to be the very token that gates them, so any code holding it was "the
// human". Now a sub-agent holds only the AGENT token and cannot self-approve,
// self-confirm, forge a human principal, or write harness commands.
//
//   • operator tier, the local human / govern authority (approve, confirm,
//     harness command writes). Advertised to LOCAL HUMAN surfaces via the 0600
//     lockfile `token`.
//   • agent tier, reads + agent-writes, NEVER govern. Injected into DISPATCHED
//     SUB-AGENTS and the orchestrator (lockfile `agentToken`).
//
// See docs/adr/0008-embedded-brain-sqlite.md and docs/adr/0009-*.md.

export type AuthTier = "operator" | "agent";

export type AgentJobCapability = {
  jobId: string;
  taskId: string;
  vendor: string;
  chatId?: string;
  parentJobId?: string;
  rootJobId?: string;
  capabilityMode?: string;
  workspacePath?: string;
};

// The authenticated principal per tier, derived from AUTH (not the body). The
// operator is the local human. The trusted runner may still use the shared
// agent principal for control-plane bookkeeping, while every vendor/MCP
// process authenticates with an expiring exact-job capability and derives a
// job principal below.
export const OPERATOR_PRINCIPAL = "human";
export const AGENT_PRINCIPAL = "agent:muon";

declare module "fastify" {
  interface FastifyRequest {
    // Set by the auth hook (app.ts) before any /api/* handler runs. In
    // token-configured mode an unknown/missing token is rejected (401) before
    // this is read; in open dev/test mode it defaults to "operator".
    tier: AuthTier;
    // Present only when the request authenticated with a runner-issued,
    // expiring capability for one exact running job. The shared agent bearer
    // used by the trusted runner deliberately has no job scope.
    agentJobCapability?: AgentJobCapability;
  }
}

export type AuthTokens = {
  /** Operator (human / govern) token. */
  operator?: string;
  /** Agent-tier token. */
  agent?: string;
};

type TokenSource = {
  MUON_OPERATOR_TOKEN?: string;
  MUON_AGENT_TOKEN?: string;
  MUON_API_TOKEN?: string;
};

/**
 * Resolve the two-tier credentials from the environment. Prefers the explicit
 * MUON_OPERATOR_TOKEN / MUON_AGENT_TOKEN pair (embedded boot mints both). The
 * legacy single MUON_API_TOKEN, when that is all that is set, is honored as the
 * OPERATOR token for back-compat (a legacy caller keeps full authority; there
 * is simply no agent tier), it is NEVER treated as an agent credential, so a
 * legacy config can never accidentally hand govern rights to the agent tier.
 */
export function resolveAuthTokens(source: TokenSource): AuthTokens {
  const operator = source.MUON_OPERATOR_TOKEN || source.MUON_API_TOKEN || undefined;
  const agent = source.MUON_AGENT_TOKEN || undefined;
  if (operator && agent && tokenEquals(operator, agent)) {
    throw new Error(
      "MUON_OPERATOR_TOKEN and MUON_AGENT_TOKEN must be distinct; refusing to collapse govern and agent authority."
    );
  }
  return { operator, agent };
}

/**
 * Constant-time bearer compare (fixes L1: the old `===` compare leaked timing).
 * A length mismatch short-circuits false, `timingSafeEqual` throws on unequal
 * lengths, and the length of a random 256-bit token is not itself a secret.
 */
export function tokenEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Extract the bearer token from an Authorization header ("" when absent). */
export function bearerToken(header: string | undefined): string {
  const value = header ?? "";
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
}

/**
 * Classify a presented bearer token into a tier: operator → "operator", agent →
 * "agent", anything else → null (the caller fails closed with 401). The operator
 * An ambiguous equal pair fails closed even if a caller bypassed the normal
 * boot-time resolver. Constant-time compares throughout.
 */
export function classifyToken(presented: string, tokens: AuthTokens): AuthTier | null {
  if (
    tokens.operator &&
    tokens.agent &&
    tokenEquals(tokens.operator, tokens.agent)
  ) {
    return null;
  }
  if (tokens.operator && tokenEquals(presented, tokens.operator)) {
    return "operator";
  }
  if (tokens.agent && tokenEquals(presented, tokens.agent)) {
    return "agent";
  }
  return null;
}

function capabilityTokenMatches(tokenHash: string, token: string): boolean {
  const expected = Buffer.from(tokenHash, "hex");
  const actual = createHash("sha256").update(token).digest();
  return (
    expected.length === actual.length &&
    expected.length > 0 &&
    timingSafeEqual(expected, actual)
  );
}

/**
 * Resolve a runner-issued per-job bearer. Only its hash is persisted, and it
 * remains usable only while the exact job is running, un-interrupted, and the
 * grant is unexpired. This gives vendor/MCP requests an authenticated task/chat
 * scope without exposing the runner's shared agent bearer to the vendor.
 */
/**
 * The furthest future an attached seat's grant may claim (ADR-0028 §3 + ADR-0049).
 *
 * TWO CEILINGS, whichever is higher:
 *
 *  - `now + LEASE_HORIZON` — the steady-state guard. A renewal is always
 *    `now + 120s`, so a connected seat lives entirely under this one.
 *  - `issuedAt + BOOTSTRAP_TTL` — the mint's window (ADR-0049), anchored to
 *    ISSUE rather than to now. That anchor is the point: the allowance decays
 *    on its own, and nothing the holder does can extend it, so a wider mint
 *    cannot become a wider steady state.
 *
 * A corrupted or forged far-future `expiresAt` fails both, which is the
 * property the original guard exists for.
 *
 * THIS IS THE THIRD PLACE the horizon is enforced — the capability file's own
 * read and its renewal are the other two. Widening the mint without widening
 * here 401'd every request made with the grant MUON had just issued, and the
 * seat still passed a handshake, so it looked attached and could do nothing.
 */
function attachedCoordinatorGrantCeiling(issuedAt: Date, nowMs: number): number {
  return Math.max(
    nowMs + ATTACHED_COORDINATOR_LEASE_HORIZON_MS,
    issuedAt.getTime() + ATTACHED_COORDINATOR_BOOTSTRAP_TTL_MS
  );
}

export async function resolveActiveAgentJobCapability(
  presented: string
): Promise<AgentJobCapability | null> {
  if (presented.length < 32 || presented.length > 512) {
    return null;
  }
  const tokenHash = createHash("sha256").update(presented).digest("hex");
  const grant = await prisma.delegationGrant.findFirst({
    where: { tokenHash },
  });
  if (
    !grant ||
    grant.expiresAt.getTime() <= Date.now() ||
    !capabilityTokenMatches(grant.tokenHash, presented)
  ) {
    return null;
  }
  const job = await prisma.dispatchJob.findUnique({
    where: { id: grant.jobId },
    select: {
      id: true,
      taskId: true,
      vendor: true,
      chatId: true,
      parentJobId: true,
      rootJobId: true,
      capabilityMode: true,
      workspacePath: true,
      status: true,
      interruptRequested: true,
    },
  });
  if (
    !job ||
    job.status !== "running" ||
    job.interruptRequested ||
    // ADR-0028: the attached coordinator's grant is a SHORT, heartbeat-
    // renewed lease, INDEPENDENT of its long `delegationDeadline` (children
    // inherit that as their own execution wall — it must never gate THIS
    // capability, or every delegated child would collapse to the lease TTL).
    // The lapsed-grant check above already applies to every capability mode;
    // this ADDS the independent horizon so a corrupted far-future
    // `expiresAt` is never trusted as an irrevocable grant (ADR-0028 §3).
    (job.capabilityMode === ATTACHED_COORDINATOR_CAPABILITY_MODE &&
      grant.expiresAt.getTime() >
        attachedCoordinatorGrantCeiling(grant.issuedAt, Date.now()))
  ) {
    return null;
  }
  return {
    jobId: job.id,
    taskId: job.taskId,
    vendor: job.vendor,
    ...(job.chatId ? { chatId: job.chatId } : {}),
    ...(job.parentJobId ? { parentJobId: job.parentJobId } : {}),
    ...(job.rootJobId ? { rootJobId: job.rootJobId } : {}),
    ...(job.capabilityMode ? { capabilityMode: job.capabilityMode } : {}),
    ...(job.workspacePath ? { workspacePath: job.workspacePath } : {}),
  };
}

export function requireAgentJobCapability(
  app: FastifyInstance,
  request: FastifyRequest
): AgentJobCapability {
  if (request.tier !== "agent" || !request.agentJobCapability) {
    throw app.httpErrors.forbidden(
      "This agent action requires the exact active job capability."
    );
  }
  return request.agentJobCapability;
}

/** One authenticated memory partition for every job. Chat jobs share their
 * chat; non-chat jobs are task-local instead of falling back to an all-chat
 * operator view. */
export function agentMemoryPartition(
  capability: AgentJobCapability
): string {
  return capability.chatId ?? `task:${capability.taskId}`;
}

export function agentJobPrincipal(
  capability: AgentJobCapability
): string {
  return `agent:job:${capability.jobId}`;
}

/** Both coordinator tiers share a chat scope; only their route/tool sets differ. */
export function isChatCoordinatorCapability(
  capability: AgentJobCapability
): boolean {
  return (
    (capability.capabilityMode === "orchestrator" ||
      capability.capabilityMode === ATTACHED_COORDINATOR_CAPABILITY_MODE) &&
    Boolean(capability.chatId)
  );
}

export function requireAgentOrchestratorCapability(
  app: FastifyInstance,
  request: FastifyRequest
): AgentJobCapability {
  const capability = requireAgentJobCapability(app, request);
  if (!isChatCoordinatorCapability(capability)) {
    throw app.httpErrors.forbidden(
      "This action requires the active orchestrator capability for the owning chat."
    );
  }
  return capability;
}

/**
 * All task ids visible to a job capability. Workers and restricted delegates
 * see only their exact task. The root orchestrator may see tasks durably bound
 * to its chat. The chat shadow task is retained as a narrowly-scoped legacy
 * fallback; arbitrary dispatch-job linkage never widens task authority because
 * one historical task may have been reused by jobs from multiple chats.
 */
export async function visibleTaskIdsForCapability(
  capability: AgentJobCapability
): Promise<string[]> {
  if (!isChatCoordinatorCapability(capability)) {
    return [capability.taskId];
  }
  const [tasks, chat] = await Promise.all([
    prisma.task.findMany({
      where: { chatId: capability.chatId },
      select: { id: true },
    }),
    prisma.orchestratorChat.findUnique({
      where: { id: capability.chatId },
      select: { taskId: true },
    }),
  ]);
  return [
    ...new Set([
      capability.taskId,
      ...tasks.map((task) => task.id),
      ...(chat?.taskId ? [chat.taskId] : []),
    ]),
  ];
}

export async function requireAgentTaskAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  taskId: string
): Promise<void> {
  const capability = request.agentJobCapability;
  if (!capability) {
    return;
  }
  if (capability.taskId === taskId) {
    return;
  }
  if (!isChatCoordinatorCapability(capability)) {
    throw app.httpErrors.forbidden(
      "The active job capability cannot access another task."
    );
  }
  const [task, chat] = await Promise.all([
    prisma.task.findUnique({
      where: { id: taskId },
      select: { chatId: true },
    }),
    prisma.orchestratorChat.findUnique({
      where: { id: capability.chatId },
      select: { taskId: true },
    }),
  ]);
  if (!task) {
    throw app.httpErrors.notFound("The requested task does not exist.");
  }
  if (
    task.chatId !== capability.chatId &&
    chat?.taskId !== taskId
  ) {
    throw app.httpErrors.forbidden(
      "The active orchestrator capability cannot access a task outside its chat."
    );
  }
}

/**
 * Review-lane read: may this caller read a task's WORKTREE DIFF?
 *
 * Deliberately WIDER than {@link requireAgentTaskAccess} and deliberately
 * nothing else: a worker sees only its exact task everywhere — briefs,
 * packets, events, approvals are that task's AUTHORITY surface — but a
 * sibling's uncommitted diff is the CODE the mission is jointly producing in
 * one shared repository, and the review role exists precisely to read it
 * (mission 420c8bf4: two reviewers, two vendors, zero ways to see the
 * implementer's diff). Same-chat is the fence; a task outside the caller's
 * mission stays invisible. This helper guards ONLY the diff read — it must
 * never be reused for a surface that carries instructions or authority.
 */
export async function requireAgentTaskDiffAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  taskId: string
): Promise<void> {
  const capability = request.agentJobCapability;
  if (!capability) {
    // Tighter than the metadata routes' convention on purpose: capability-less
    // callers there include the shared agent bearer (runner bookkeeping), and
    // this payload is SOURCE CODE, not task metadata. The operator reads
    // freely; the shared agent principal holds no mission to fence by and is
    // refused — only exact-job capabilities cross into a sibling's diff.
    if (request.tier === "operator") {
      return;
    }
    throw app.httpErrors.forbidden(
      "Reading a task's diff requires the operator tier or an exact-job capability."
    );
  }
  if (capability.taskId === taskId) {
    return;
  }
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { chatId: true },
  });
  if (!task) {
    throw app.httpErrors.notFound("The requested task does not exist.");
  }
  if (!capability.chatId || task.chatId !== capability.chatId) {
    throw app.httpErrors.forbidden(
      "The active job capability cannot read a diff outside its mission."
    );
  }
}

export async function requireAgentJobAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  jobId: string
): Promise<void> {
  const capability = request.agentJobCapability;
  if (!capability || capability.jobId === jobId) {
    return;
  }
  const target = await prisma.dispatchJob.findUnique({
    where: { id: jobId },
    select: { chatId: true },
  });
  if (!target) {
    throw app.httpErrors.notFound(
      "The requested dispatch job does not exist."
    );
  }
  if (
    !isChatCoordinatorCapability(capability) ||
    target.chatId !== capability.chatId
  ) {
    throw app.httpErrors.forbidden(
      "The active job capability cannot access this dispatch job."
    );
  }
}

/**
 * A job bearer is not a generic agent credential. This deny-by-default route
 * matrix is the outer choke point; individual content routes still enforce
 * exact task/chat/job ownership. The shared agent bearer remains available to
 * the trusted runner and never enters vendor environments.
 */
export function agentJobRouteAllowed(request: FastifyRequest): boolean {
  const capability = request.agentJobCapability;
  if (!capability) {
    return true;
  }
  const method = request.method.toUpperCase();
  const pathname = request.url.split("?", 1)[0] ?? "";
  const is = (verb: string, pattern: RegExp) =>
    method === verb && pattern.test(pathname);

  // A2A peer coordination is COMMON, not orchestrator-only: the workers are the
  // peers. Every route below re-derives chat/mission/job/role from THIS
  // capability and filters on it, so admitting them here widens no scope, and
  // the operator-only A2A reads (GET /messages, GET /coordination) are
  // deliberately absent from this matrix.
  const common =
    is("GET", /^\/api\/auth\/session$/) ||
    /^\/api\/memory(?:\/|$)/.test(pathname) ||
    is("GET", /^\/api\/tasks(?:\/[^/]+)?$/) ||
    is("GET", /^\/api\/tasks\/[^/]+\/events$/) ||
    // Review lane: a sibling task's worktree DIFF (read-only code-under-review;
    // the route's own fence is same-mission via requireAgentTaskDiffAccess).
    is("GET", /^\/api\/tasks\/[^/]+\/worktree-diff$/) ||
    is("POST", /^\/api\/events$/) ||
    is("GET", /^\/api\/loops$/) ||
    is("GET", /^\/api\/fleet\/readiness$/) ||
    is("GET", /^\/api\/runner$/) ||
    is("POST", /^\/api\/a2a\/messages$/) ||
    // PUBLISH A FINDING: one note plus the message that announces it. Admitted
    // explicitly, because the deny-first matrix refused it until this line
    // existed — which is the behaviour working. It widens nothing a job cannot
    // already do: the handler re-derives identity from THIS capability, the
    // note is unconfirmed and workspace-scoped exactly as `POST /api/memory`
    // would leave it, and the announcement spends the same per-job message
    // budget `POST /messages` spends.
    is("POST", /^\/api\/a2a\/findings$/) ||
    is("GET", /^\/api\/a2a\/inbox$/) ||
    // ADR-0034. Read-only and coordinate-only: it returns a peer's lifecycle
    // state or an arrival count, never a message body. Admitted here
    // explicitly — the deny-first matrix refused it until this line existed,
    // which is the behaviour working, not an obstacle to route around.
    is("POST", /^\/api\/a2a\/wait$/) ||
    is("POST", /^\/api\/a2a\/claims$/) ||
    is("POST", /^\/api\/a2a\/claims\/release$/) ||
    // ADR-0043 blocking questions: ask, read own (the answer pull path), and
    // withdraw. Identity is re-derived from THIS capability in every handler
    // and results filter to the caller's own job, so admitting these widens
    // no scope. The operator halves (answer, task listing) are deliberately
    // absent from this matrix.
    is("POST", /^\/api\/questions$/) ||
    is("GET", /^\/api\/questions$/) ||
    is("POST", /^\/api\/questions\/[^/]+\/withdraw$/) ||
    is(
      "GET",
      /^\/api\/dispatch\/[^/]+\/context(?:\/frames\/[^/]+)?$/
    ) ||
    is("GET", /^\/api\/crew\/roles$/);
  if (common) {
    return true;
  }

  if (capability.capabilityMode === "delegate") {
    return (
      is("POST", /^\/api\/dispatch\/[^/]+\/delegate$/) ||
      is("GET", /^\/api\/dispatch\/[^/]+\/budget$/)
    );
  }

  if (capability.capabilityMode === ATTACHED_COORDINATOR_CAPABILITY_MODE) {
    return (
      is("POST", /^\/api\/tasks$/) ||
      is("GET", /^\/api\/approvals$/) ||
      is("POST", /^\/api\/approvals$/) ||
      is("GET", /^\/api\/dispatch(?:\/[^/]+)?$/) ||
      is("POST", /^\/api\/dispatch\/[^/]+\/delegate$/) ||
      is("GET", /^\/api\/dispatch\/[^/]+\/budget$/) ||
      is("POST", /^\/api\/dispatch\/[^/]+\/steer$/) ||
      is("POST", /^\/api\/dispatch\/[^/]+\/interrupt$/) ||
      is("POST", /^\/api\/dispatch\/attached\/[^/]+\/heartbeat$/) ||
      is("GET", /^\/api\/streams$/) ||
      is("GET", /^\/api\/fleet$/) ||
      is("GET", /^\/api\/lanes$/) ||
      is("POST", /^\/api\/crew\/roles$/) ||
      is("GET", /^\/api\/workflow-runs(?:\/[^/]+)?$/) ||
      is("POST", /^\/api\/workflow-runs$/)
    );
  }

  if (capability.capabilityMode !== "orchestrator") {
    return false;
  }

  return (
    is("POST", /^\/api\/tasks$/) ||
    is("GET", /^\/api\/approvals$/) ||
    is("POST", /^\/api\/approvals$/) ||
    is("GET", /^\/api\/dispatch(?:\/[^/]+)?$/) ||
    is("POST", /^\/api\/dispatch\/[^/]+\/delegate$/) ||
    is("GET", /^\/api\/dispatch\/[^/]+\/budget$/) ||
    is("PATCH", /^\/api\/dispatch\/[^/]+\/budget$/) ||
    is("POST", /^\/api\/dispatch\/[^/]+\/steer$/) ||
    is("POST", /^\/api\/dispatch\/[^/]+\/interrupt$/) ||
    is("GET", /^\/api\/streams$/) ||
    // The handler accepts only a complete provider-bound session tuple and
    // re-verifies exact root job/vendor/chat ownership.
    is("PATCH", /^\/api\/chats\/[^/]+$/) ||
    is("GET", /^\/api\/fleet$/) ||
    is("PUT", /^\/api\/fleet$/) ||
    is("GET", /^\/api\/lanes$/) ||
    // Crew role binding is coordination, not authority (a role only NARROWS a
    // lane profile), so the chat's own coordinator may recompute its plan for
    // ITS chat; the route re-derives the partition from this capability.
    is("POST", /^\/api\/crew\/roles$/) ||
    is("GET", /^\/api\/harnesses(?:\/[^/]+)?$/) ||
    is("GET", /^\/api\/workflow-runs(?:\/[^/]+)?$/) ||
    is("POST", /^\/api\/workflow-runs$/) ||
    is("PATCH", /^\/api\/workflow-runs\/[^/]+$/) ||
    is("POST", /^\/api\/workflow-runs\/[^/]+\/apply$/)
  );
}

/**
 * H3 fail-closed: a NON-loopback bind must present both tier credentials, or the
 * whole privileged API would be exposed unauthenticated on every interface.
 * Embedded (loopback) always mints both, so this only guards a misconfigured
 * hosted deploy. Throwing here refuses the bind.
 */
export function assertHostedTokensConfigured(tokens: AuthTokens): void {
  if (!tokens.operator || !tokens.agent) {
    throw new Error(
      "Refusing a non-loopback bind without both MUON_OPERATOR_TOKEN and MUON_AGENT_TOKEN (P3-A fail-closed). Configure both, or run the embedded loopback brain (file: DATABASE_URL)."
    );
  }
  if (tokenEquals(tokens.operator, tokens.agent)) {
    throw new Error(
      "MUON_OPERATOR_TOKEN and MUON_AGENT_TOKEN must be distinct; refusing to collapse govern and agent authority."
    );
  }
}

/**
 * Govern guard: require the operator (human) tier or throw 403. GOVERN routes
 * (approve/reject an approval, human confirm / proposal resolution, harness
 * command writes) call this, an agent-tier caller is rejected. Closes C1/H1.
 */
export function requireOperator(app: FastifyInstance, request: FastifyRequest): void {
  if (request.tier !== "operator") {
    throw app.httpErrors.forbidden(
      "This action requires operator (human) authority; the agent tier cannot govern."
    );
  }
}

/**
 * Human iff the KG-5 convention is bare "" / "human" or the "human:" prefix, a
 * faithful, dependency-free mirror of memory-ledger's parsePrincipal kind rule,
 * kept tiny so the auth boundary needn't import the (graph/prisma-heavy) ledger.
 */
export function isHumanPrincipal(raw: string | undefined): boolean {
  const s = (raw ?? "").trim().toLowerCase();
  return s === "" || s === "human" || s.startsWith("human:");
}

/**
 * Derive the AUTHORING principal (`createdBy`) from the authenticated tier, not
 * the request body (fixes H2). An operator keeps the body value (the human's own
 * machine may legitimately record "human:carol" or an agent's honest id). An
 * agent-tier caller that CLAIMS a human principal is DOWNGRADED to the generic
 * agent principal, so a sub-agent can never forge human provenance, while an
 * honest agent id ("codex", a lane key) is preserved for attribution.
 */
export function authoringPrincipal(tier: AuthTier, requested: string): string {
  if (tier === "operator") {
    return requested;
  }
  return isHumanPrincipal(requested) ? AGENT_PRINCIPAL : requested;
}

/**
 * Derive the CONFIRMING principal for a governance PATCH from auth. Only the
 * operator tier reaches here (agent-tier confirms are 403'd upstream), so the
 * confirmer is always human-kind: a human id the operator supplied is honored,
 * anything else is coerced to the generic human operator so the confirm actually
 * elevates (KG-6 requires a human-kind confirmer). Never body-asserted for the
 * agent tier, the human-kind principal is now authenticated, not declared.
 */
export function confirmingPrincipal(requested: string | undefined): string {
  return requested && isHumanPrincipal(requested) ? requested : OPERATOR_PRINCIPAL;
}
