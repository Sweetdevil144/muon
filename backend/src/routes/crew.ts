import { createDefaultAdapters } from "@muon/adapters";
import { assignRoles, type LaneCandidate } from "@muon/core";
import {
  AGENT_ROLES,
  agentRoleSchema,
  crewRolePlanSchema,
  CREW_COST_ACCOUNTING,
  vendorCost,
  vendorCostOrdinalView,
  type AgentRole,
  type CrewRolePlan,
} from "@muon/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  requireAgentJobCapability,
  requireAgentOrchestratorCapability,
} from "../lib/auth.js";
import { prisma } from "../lib/db.js";

// ── Crew role assignment (VISION §2) ─────────────────────────────────────────
//
// MUON — not the vendor — decides what each participating lane is FOR. Three
// properties make that safe to expose over HTTP:
//
//  1. A ROLE ONLY NARROWS. `narrowProfileForRole` is monotone and the runner
//     re-asserts it at launch, so binding a role can never hand an agent
//     something its lane profile did not already have. That is precisely why
//     the super-orchestrator (which holds an AGENT credential, never the
//     operator's) may compute a plan: choosing WHO does what is coordination,
//     not authority.
//  2. SCOPE IS AUTHENTICATED. A job bearer never names its own chat: the
//     partition comes from the bearer, and a `chatId` for a different chat is a
//     403, never a silent re-scope. Only the exact ORCHESTRATOR capability may
//     write a plan; a worker bearer may read its chat's plan and nothing else.
//  3. HUMAN PINS OUTRANK THE CREW. A binding the human pinned survives an agent
//     recompute — it is re-applied as a pin and keeps `assignedBy: "human"`.
//     Only the operator may change or clear one, and an agent's own pin is
//     always recorded as `muon` so it can never forge human provenance.
//
// `assignRoles()` itself is pure and deterministic: same lanes + pins, same
// plan, diffable in review, with no model call between intent and crew shape.
//
// Because it is pure, the READ can run it too. A chat with no bindings answers
// with the plan MUON WOULD assign, flagged `planStatus: "proposed"` — visible
// before anyone acts, and never mistakable for a commitment. The GET stays
// side-effect free: only POST writes a CrewRoleBinding.

/**
 * Live lane candidates for the assignment engine, built from the REGISTERED
 * adapters (the same registry dispatch routes through), never from a
 * caller-supplied list. Health and capabilities are the adapter's own answers;
 * `supportedRoles` is the adapter's declared ceiling (always present — the field
 * is required) and `roleAffinity` its opinion, absent when it has none.
 */
type LaneCandidateProvider = () => Promise<LaneCandidate[]>;

/**
 * `adapter.health()` shells out to `which` per candidate binary, so the probe is
 * memoized briefly: the crew view is pollable and the embedded backend shares
 * its event loop with runner heartbeats. Short enough that a vendor installed
 * mid-session shows up without a restart.
 */
const LANE_PROBE_TTL_MS = 15_000;
let laneProbeCache: { at: number; lanes: LaneCandidate[] } | undefined;

async function probeLaneCandidates(): Promise<LaneCandidate[]> {
  const now = Date.now();
  if (laneProbeCache && now - laneProbeCache.at < LANE_PROBE_TTL_MS) {
    return laneProbeCache.lanes;
  }
  const lanes = await Promise.all(
    createDefaultAdapters().map(async (adapter) => {
      const [health, capabilities] = await Promise.all([
        adapter.health(),
        adapter.capabilities(),
      ]);
      return {
        vendor: adapter.id,
        displayName: adapter.displayName,
        capabilities,
        health: health.status,
        // The ceiling is REQUIRED on both sides now, so it is passed
        // unconditionally: a conditional spread would reintroduce the "field
        // absent → unconstrained" state the engine no longer has.
        supportedRoles: adapter.supportedRoles,
        ...(adapter.roleAffinity ? { roleAffinity: adapter.roleAffinity } : {}),
        // WAVE F (ADR-0022 §1.2(h)) — the cost term stops being inert.
        //
        // ADR-0020 §3 claimed a cost term steered cheap reconnaissance to the
        // local lane. It never did: nothing set this field, so every lane took
        // `role-assignment`'s `?? 0.5` and the term was a CONSTANT that could
        // not reorder anything. Supplying it is the first change to `assignRoles`
        // output since ADR-0020, so it is pinned by an exhaustive before/after
        // fixture (`crew-cost-fixture.test.ts`): over every subset of the
        // registered lanes × every health combination, NO production assignment
        // moves — only the reported `fit` values do.
        //
        // Unconditional, like the ceiling above: `vendorCost` returns the same
        // neutral 0.5 the engine already defaulted to for an id the registry does
        // not name, so a conditional spread would say the same thing less
        // clearly.
        cost: vendorCost(adapter.id),
      } satisfies LaneCandidate;
    })
  );
  laneProbeCache = { at: now, lanes };
  return lanes;
}

let laneCandidateProvider: LaneCandidateProvider = probeLaneCandidates;

/** Test seam: override (or reset with null) the live lane probe. */
export function setCrewLaneProvider(provider: LaneCandidateProvider | null): void {
  laneProbeCache = undefined;
  laneCandidateProvider = provider ?? probeLaneCandidates;
}

const chatIdSchema = z.string().trim().min(1).max(128);

/**
 * WHAT THE PLAN ON THE WIRE *IS*. `plan` alone cannot say this, and overloading
 * it would let one surface render a preview as a commitment:
 *
 *  - `assigned` — CrewRoleBinding rows exist. A decision was made and stored,
 *    dispatch narrows against it, and only a POST can change it.
 *  - `proposed` — nothing is stored. This is what `assignRoles()` WOULD bind if
 *    the crew were assigned right now, computed on the read from the same live
 *    lanes a POST would use. Nothing was written; the next dispatch may bind
 *    something else if the lane set moved.
 *  - `none` — no plan at all, because no lane could hold a single role (usually:
 *    no vendor CLI is installed). MUON does not fabricate a crew out of nothing.
 *
 * `plan === null` ⇔ `planStatus === "none"` is enforced below, so no reader has
 * to defend against "proposed, but empty".
 */
const CREW_PLAN_STATUSES = ["assigned", "proposed", "none"] as const;
type CrewPlanStatus = (typeof CREW_PLAN_STATUSES)[number];
const crewPlanStatusSchema = z.enum(CREW_PLAN_STATUSES);

const crewLaneViewSchema = z.object({
  vendor: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120),
  health: z.string().min(1).max(32),
  /** Relative cost ordinal (0…1), not dollars — see `costAccounting`. */
  cost: z.number().min(0).max(1),
  costOrdinal: z.number().min(0).max(1),
});

const costAccountingPlaceholderSchema = z.object({
  metered: z.literal(false),
  notice: z.literal(CREW_COST_ACCOUNTING.notice),
});

/**
 * The read response is validated on the way OUT, like the plan already was. The
 * pairing check is the point: a bug that emitted `planStatus: "assigned"` with a
 * null plan (or "proposed" with nothing to propose) would be a lie about whether
 * MUON has committed to a crew, so it fails here as a 500 rather than reaching a
 * surface that would render it as a commitment.
 */
function checkPlanPairing(
  value: { plan: CrewRolePlan | null; planStatus: CrewPlanStatus },
  ctx: z.RefinementCtx
): void {
  if ((value.plan === null) !== (value.planStatus === "none")) {
    ctx.addIssue({
      code: "custom",
      path: ["planStatus"],
      message: `planStatus '${value.planStatus}' contradicts ${
        value.plan === null ? "a null plan" : "a present plan"
      }`,
    });
  }
}

const crewPlanReadSchema = z
  .object({
    plan: crewRolePlanSchema.nullable(),
    planStatus: crewPlanStatusSchema,
  })
  .superRefine(checkPlanPairing);

const crewOperatorReadSchema = z
  .object({
    plan: crewRolePlanSchema.nullable(),
    planStatus: crewPlanStatusSchema,
    costAccounting: costAccountingPlaceholderSchema,
    lanes: z.array(crewLaneViewSchema),
  })
  .superRefine(checkPlanPairing);

const planBodySchema = z
  .object({
    chatId: chatIdSchema,
    roles: z.array(agentRoleSchema).max(AGENT_ROLES.length).optional(),
    // role → vendor. A pin is the human outranking the engine; a pin to a lane
    // that cannot hold the role is recorded BLOCKED, never silently granted.
    // `partialRecord` (not `record`) because a pin set is a SUBSET of the role
    // taxonomy — an unknown role key is still rejected.
    pinned: z
      .partialRecord(agentRoleSchema, z.string().trim().min(1).max(64))
      .optional(),
  })
  .strict();

type BindingRow = {
  vendor: string;
  role: string;
  fit: number;
  reason: string;
  assignedBy: string;
  blocked: boolean;
  blockedReason: string | null;
};

/**
 * Rebuild the stored plan.
 *
 * `unfilled` is DERIVED from the bindings, not stored: which roles a given
 * assignment RUN asked for is not recorded, so a read-back cannot replay the
 * run's own list. It reports the honest read-time property instead — every
 * canonical role this chat has no ACTIVE lane for, meaning no binding at all or
 * only a BLOCKED one. That is the same "who actually holds this role" predicate
 * `vendorForRole()` dispatches on, so the crew view's "unfilled" affordance and
 * "nobody can be dispatched as this" cannot drift apart. Hard-coding `[]` here
 * made that affordance dead code against the live route.
 *
 * It can therefore be WIDER than the `unfilled` a POST returns (a run that asked
 * for three roles still leaves the rest of the taxonomy unheld) — which is the
 * truth the reader needs: the plan is what the chat has, not what one run wanted.
 */
function storedPlan(chatId: string, rows: BindingRow[]): CrewRolePlan | null {
  if (rows.length === 0) {
    return null;
  }
  const filled = new Set(
    rows.filter((row) => !row.blocked).map((row) => row.role)
  );
  return crewRolePlanSchema.parse({
    version: 1,
    chatId,
    bindings: rows.map((row) => ({
      vendor: row.vendor,
      role: row.role,
      fit: row.fit,
      reason: row.reason,
      assignedBy: row.assignedBy,
      blocked: row.blocked,
      ...(row.blockedReason ? { blockedReason: row.blockedReason } : {}),
    })),
    unfilled: AGENT_ROLES.filter((role) => !filled.has(role)),
  });
}

/**
 * The chat's HUMAN-pinned bindings, role → vendor. These are the decisions an
 * agent recompute must carry forward untouched.
 */
async function readHumanPins(
  chatId: string
): Promise<Partial<Record<AgentRole, string>>> {
  const rows = await prisma.crewRoleBinding.findMany({
    where: { chatId, assignedBy: "human" },
    select: { role: true, vendor: true },
  });
  const pins: Partial<Record<AgentRole, string>> = {};
  for (const row of rows) {
    const role = agentRoleSchema.safeParse(row.role);
    if (role.success) {
      pins[role.data] = row.vendor;
    }
  }
  return pins;
}

async function readPlan(chatId: string): Promise<CrewRolePlan | null> {
  const rows = await prisma.crewRoleBinding.findMany({
    where: { chatId },
    orderBy: [{ createdAt: "asc" }, { role: "asc" }],
    select: {
      vendor: true,
      role: true,
      fit: true,
      reason: true,
      assignedBy: true,
      blocked: true,
      blockedReason: true,
    },
  });
  return storedPlan(chatId, rows);
}

/**
 * The plan MUON WOULD bind for this chat, from the live lanes — the headline
 * capability made visible before an agent has acted, instead of an empty crew
 * view that reads as broken.
 *
 * A READ MUST NEVER WRITE. This is computed and returned; nothing is persisted,
 * so the only thing that can create a CrewRoleBinding row is still POST /roles.
 * That is also why it takes NO pins: pins live in binding rows, and a chat with
 * no rows has none — so the preview is exactly `assignRoles(lanes)`, which is
 * pure. Same crew, same preview, every time.
 *
 * Empty means EMPTY: no lanes, or lanes that can hold nothing, yields `null`
 * rather than an invented crew — the same rule `storedPlan` applies to zero
 * rows, so "no plan" has one meaning on this route.
 */
function proposedPlan(
  chatId: string,
  lanes: readonly LaneCandidate[]
): CrewRolePlan | null {
  if (lanes.length === 0) {
    return null;
  }
  const plan = assignRoles({ chatId, lanes });
  return plan.bindings.length > 0 ? plan : null;
}

/**
 * The chat partition this request may READ. The operator names a chat; a job
 * bearer IS a chat, and a mismatched `?chatId=` is refused rather than honored
 * or ignored.
 */
function crewReadScope(
  app: FastifyInstance,
  request: FastifyRequest,
  claimedChatId: string | undefined
): { chatId: string; operator: boolean } {
  if (request.tier === "operator") {
    if (!claimedChatId) {
      throw app.httpErrors.badRequest(
        "A crew role plan is per chat; pass ?chatId=<id>."
      );
    }
    return { chatId: claimedChatId, operator: true };
  }
  // Tier B attached observer: the shared AGENT bearer has no exact-job
  // capability, so it must name the chat explicitly. This is READ only. The
  // write route below still requires operator or an active orchestrator job.
  // A job-bound vendor process never reaches this branch and remains confined
  // to the chat derived from its bearer.
  if (!request.agentJobCapability) {
    if (!claimedChatId) {
      throw app.httpErrors.badRequest(
        "An attached observer must pass ?chatId=<id> for crew roles."
      );
    }
    return { chatId: claimedChatId, operator: false };
  }
  const capability = requireAgentJobCapability(app, request);
  if (!capability.chatId) {
    throw app.httpErrors.forbidden(
      "Crew roles require a chat-bound job capability."
    );
  }
  if (claimedChatId && claimedChatId !== capability.chatId) {
    throw app.httpErrors.forbidden(
      "The requested chat is outside this job capability."
    );
  }
  return { chatId: capability.chatId, operator: false };
}

/**
 * The chat partition this request may WRITE. Operator, or the exact ACTIVE
 * ORCHESTRATOR capability for that chat — the same authority the orchestrator
 * already needs to create a task or dispatch a job. Every other agent
 * credential (a worker's job bearer, the runner's shared bearer) is refused.
 */
function crewWriteScope(
  app: FastifyInstance,
  request: FastifyRequest,
  claimedChatId: string
): { chatId: string; operator: boolean } {
  if (request.tier === "operator") {
    return { chatId: claimedChatId, operator: true };
  }
  const capability = requireAgentOrchestratorCapability(app, request);
  if (capability.chatId !== claimedChatId) {
    throw app.httpErrors.forbidden(
      "The orchestrator capability may only bind roles for its own chat."
    );
  }
  return { chatId: capability.chatId, operator: false };
}

export async function registerCrewRoutes(app: FastifyInstance) {
  // The crew view: the chat's current plan plus the live lanes it was (or would
  // be) computed from. A job bearer gets ONLY the plan — another lane's install
  // and health posture is operator diagnostics, not peer coordination data.
  //
  // A chat with no bindings answers with the plan MUON WOULD assign, marked
  // `proposed`. Before this, a fresh chat read as "no roles at all", which made
  // the product's headline claim invisible until an agent happened to call
  // `assign_roles` — the emptiness looked like a defect rather than a state.
  // The preview is a READ: it is computed, returned, and never stored, so the
  // set of writers to CrewRoleBinding is unchanged (POST only).
  //
  // BOTH TIERS get it. A worker asking "who holds what" gets the same answer as
  // the operator, minus the lane inventory — a proposed plan names vendors, the
  // same class of fact an assigned one already named it, and never their health
  // or cost.
  app.get("/roles", async (request) => {
    const query = z
      .object({ chatId: chatIdSchema.optional() })
      .parse(request.query ?? {});
    const scope = crewReadScope(app, request, query.chatId);
    const stored = await readPlan(scope.chatId);

    // The operator always gets the lane inventory; an agent only makes the
    // probe pay for itself when there is a preview to compute. (The probe is
    // memoized for LANE_PROBE_TTL_MS, so a polling crew view is not shelling
    // out to `which` per request either way.)
    const lanes =
      scope.operator || stored === null ? await laneCandidateProvider() : [];
    const plan = stored ?? proposedPlan(scope.chatId, lanes);
    const planStatus: CrewPlanStatus = stored
      ? "assigned"
      : plan
        ? "proposed"
        : "none";

    if (!scope.operator) {
      return crewPlanReadSchema.parse({ plan, planStatus });
    }
    return crewOperatorReadSchema.parse({
      plan,
      planStatus,
      costAccounting: CREW_COST_ACCOUNTING,
      lanes: lanes.map((lane) => {
        const costView = vendorCostOrdinalView(lane.vendor);
        return {
          vendor: lane.vendor,
          displayName: lane.displayName,
          health: lane.health,
          cost: costView.ordinal,
          costOrdinal: costView.ordinal,
        };
      }),
    });
  });

  // Compute + persist. Operator, or the chat's ACTIVE ORCHESTRATOR capability —
  // the coordinator has to be able to shape its own crew, and a role binding
  // only ever narrows, so this grants nothing the lane profile did not have.
  app.post("/roles", async (request) => {
    const payload = planBodySchema.parse(request.body);
    const scope = crewWriteScope(app, request, payload.chatId);
    const chat = await prisma.orchestratorChat.findUnique({
      where: { id: scope.chatId },
      select: { id: true },
    });
    if (!chat) {
      throw app.httpErrors.notFound("The requested chat does not exist.");
    }

    // Human pins are sticky. An AGENT recompute re-applies every existing
    // human-pinned binding as a pin (spread LAST so a caller-supplied pin for
    // the same role cannot displace it), and only the operator may change or
    // clear one — an operator recompute uses exactly what the human sent.
    const humanPins = scope.operator
      ? {}
      : await readHumanPins(scope.chatId);
    const pinned: Partial<Record<AgentRole, string>> = {
      ...(payload.pinned as Partial<Record<AgentRole, string>> | undefined),
      ...humanPins,
    };

    // A pin only survives if its ROLE survives: narrowing `roles` would
    // otherwise delete a human-pinned binding without ever naming it. So an
    // agent's requested role set is unioned with the human-pinned roles (a
    // no-op for the operator, who owns those pins).
    const roles = payload.roles
      ? [...new Set([...payload.roles, ...(Object.keys(humanPins) as AgentRole[])])]
      : undefined;

    const lanes = await laneCandidateProvider();
    const computed = assignRoles({
      chatId: scope.chatId,
      lanes,
      ...(roles ? { roles } : {}),
      ...(Object.keys(pinned).length > 0 ? { pinned } : {}),
    });

    // PROVENANCE IS AUTHENTICATED, like every other principal in MUON: the
    // engine stamps any pin as "human", so an agent's own pin is re-stamped
    // "muon" here. Otherwise a coordinator could mint a binding that reads as a
    // human decision and that no later agent recompute is allowed to move.
    const plan = crewRolePlanSchema.parse({
      ...computed,
      bindings: computed.bindings.map((binding) =>
        scope.operator || humanPins[binding.role] === binding.vendor
          ? binding
          : { ...binding, assignedBy: "muon" }
      ),
    });

    // Replace-in-one-transaction: a plan is coherent as a whole, so a partial
    // apply (new bindings alongside stale ones) must not be observable, and the
    // @@unique([chatId, role]) can never be raced into a half state.
    await prisma.$transaction([
      prisma.crewRoleBinding.deleteMany({ where: { chatId: scope.chatId } }),
      ...plan.bindings.map((binding) =>
        prisma.crewRoleBinding.create({
          data: {
            chatId: scope.chatId,
            vendor: binding.vendor,
            role: binding.role,
            fit: binding.fit,
            reason: binding.reason,
            assignedBy: binding.assignedBy,
            blocked: binding.blocked,
            ...(binding.blockedReason
              ? { blockedReason: binding.blockedReason }
              : {}),
          },
        })
      ),
    ]);

    // A POST is the ONLY thing that commits a crew, so its answer is always
    // `assigned` — stated on the wire so a surface rendering a plan never has to
    // infer which kind it is holding.
    return crewPlanReadSchema.parse({ plan, planStatus: "assigned" });
  });
}
