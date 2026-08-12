import { z } from "zod";
import {
  agentRoleSchema,
  crewRolePlanSchema,
  CREW_COST_ACCOUNTING,
  AGENT_ROLES,
  type AgentRole,
  type CrewRolePlan,
} from "@muon/protocol";

// ROLE ASSIGNMENT — the client half of "MUON, not the vendor, decides what each
// agent is FOR" (see `packages/protocol/src/agent-role.ts`).
//
// A plan is a NARROWING instrument: `narrowProfileForRole` only ever removes
// tools, tightens the sandbox, and lowers the permission mode. Nothing on this
// wire can widen a lane, so the read side is safe to show anywhere and the write
// side is scoped to ONE chat — never a global one.
//
// Two read paths on purpose:
// - operator (`loadCrewRoles`) names the chat and also gets the lane inventory
//   the planner chose from, because a human needs to see the alternatives;
// - agent (`loadCrewRolePlan`) names nothing. The exact-job bearer decides which
//   chat's plan comes back, so a worker cannot read another chat's crew.
//
// The write path (`assignCrewRoles`) takes an operator token OR an agent
// principal holding the orchestrator capability — the super-orchestrator only
// ever holds the AGENT token, so an operator-only route would make role
// assignment uncallable by its one real caller. An agent caller is confined
// server-side to its own chat; naming another chat is a 403, not a widening.

/**
 * IS THIS PLAN A DECISION, OR A PREVIEW?
 *
 *  - `assigned` — bindings are stored for this chat. Dispatch narrows against
 *    them and only `assignCrewRoles` (POST) can change them.
 *  - `proposed` — nothing is stored yet; the route computed what MUON WOULD bind
 *    from the live lanes. Deterministic, but not a commitment: no binding row
 *    exists, and nothing was written to produce it.
 *  - `none` — no plan at all (`plan` is null), because no lane could hold a
 *    single role. MUON does not invent a crew.
 *
 * Carried BESIDE `plan` rather than folded into it, so no surface can render a
 * preview as a commitment by forgetting to look.
 */
export const CREW_PLAN_STATUSES = ["assigned", "proposed", "none"] as const;
export const crewPlanStatusSchema = z.enum(CREW_PLAN_STATUSES);
export type CrewPlanStatus = z.infer<typeof crewPlanStatusSchema>;

/**
 * `planStatus` is ADDITIVE: a brain that predates it could only ever answer with
 * a STORED plan, so an absent field means `assigned` when a plan came back and
 * `none` when it did not. Consumers therefore always get a concrete status and
 * never have to special-case an older backend.
 */
function withPlanStatus<T extends { plan: CrewRolePlan | null }>(
  value: T & { planStatus?: CrewPlanStatus }
): Omit<T, "planStatus"> & { planStatus: CrewPlanStatus } {
  return {
    ...value,
    planStatus: value.planStatus ?? (value.plan ? "assigned" : "none"),
  };
}

/** One lane the planner could draw on, as the operator route reports it. */
export const crewLaneSchema = z.object({
  vendor: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120),
  health: z.string().min(1).max(32),
  /** Relative cost ordinal (0…1), not dollars — see `costAccounting`. */
  cost: z.number().min(0).max(1).optional(),
  costOrdinal: z.number().min(0).max(1).optional(),
});
export type CrewLane = z.infer<typeof crewLaneSchema>;

const costAccountingPlaceholderSchema = z.object({
  metered: z.literal(false),
  notice: z.literal(CREW_COST_ACCOUNTING.notice),
});
export type CostAccountingPlaceholder = z.infer<
  typeof costAccountingPlaceholderSchema
>;

/** A human/orchestrator override: "this role runs on this vendor". */
export const rolePinSchema = z
  .object({
    role: agentRoleSchema,
    vendor: z.string().trim().min(1).max(64),
  })
  .strict();
export type RolePin = z.infer<typeof rolePinSchema>;

const roleRequestSchema = z
  .object({
    roles: z.array(agentRoleSchema).max(AGENT_ROLES.length).optional(),
    pinned: z.array(rolePinSchema).max(AGENT_ROLES.length).optional(),
  })
  .strict();

/**
 * Pins travel as an ergonomic `{role, vendor}` list through every surface (the
 * `--pin role=vendor` flag, the `assign_roles` tool) and land on the wire as the
 * route's role → vendor map. A role appearing twice is REFUSED rather than
 * collapsed, so a caller never silently loses one of two conflicting pins.
 */
function pinnedRecord(pins: readonly RolePin[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const pin of pins) {
    if (record[pin.role] !== undefined && record[pin.role] !== pin.vendor) {
      throw new Error(
        `conflicting pins for role '${pin.role}': '${record[pin.role]}' and '${pin.vendor}'`
      );
    }
    record[pin.role] = pin.vendor;
  }
  return record;
}

const crewRolesReadSchema = z
  .object({
    plan: crewRolePlanSchema.nullable(),
    planStatus: crewPlanStatusSchema.optional(),
    costAccounting: costAccountingPlaceholderSchema.optional(),
    lanes: z.array(crewLaneSchema).max(32).default([]),
  })
  .transform(withPlanStatus);
export type CrewRolesView = z.infer<typeof crewRolesReadSchema>;

const crewRolePlanReadSchema = z
  .object({
    plan: crewRolePlanSchema.nullable(),
    planStatus: crewPlanStatusSchema.optional(),
  })
  .transform(withPlanStatus);
/** The agent-tier read: one plan, and whether it is a decision or a preview. */
export type CrewRolePlanView = z.infer<typeof crewRolePlanReadSchema>;

const crewRolePlanWriteSchema = z.object({ plan: crewRolePlanSchema });

type CrewRolesRequest = {
  /** Control-plane base, e.g. `http://127.0.0.1:4000`. */
  apiBase: string;
  /**
   * Operator token for the human surfaces, or the exact-job bearer for the
   * agent read and for an orchestrator-capable agent's assignment.
   */
  apiToken?: string;
  fetcher?: typeof fetch;
};

async function crewJson<T extends z.ZodTypeAny>(
  input: CrewRolesRequest,
  path: string,
  schema: T,
  post?: unknown
): Promise<z.infer<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.apiToken) headers.authorization = `Bearer ${input.apiToken}`;
  if (post !== undefined) headers["content-type"] = "application/json";
  const response = await (input.fetcher ?? fetch)(
    `${input.apiBase.replace(/\/$/, "")}${path}`,
    post === undefined
      ? { headers }
      : { method: "POST", headers, body: JSON.stringify(post) }
  );
  if (!response.ok) {
    // Surface the route's reason (unknown chat, foreign chat, no capability),
    // not a bare status — every one of those needs a different fix.
    const text = (await response.text()).trim();
    let detail = text.slice(0, 500);
    try {
      const body = JSON.parse(text) as { message?: unknown };
      if (typeof body.message === "string" && body.message) {
        detail = body.message.slice(0, 500);
      }
    } catch {
      // non-JSON error body
    }
    throw new Error(
      `Crew roles request failed (${response.status})${
        detail ? `: ${detail}` : ""
      }`
    );
  }
  return schema.parse(await response.json());
}

/**
 * OPERATOR read: one chat's plan plus the lanes it was drawn from.
 *
 * `planStatus` says whether that plan is stored (`assigned`) or the preview the
 * route computed from the live lanes (`proposed`). A caller that renders the
 * plan MUST render the distinction — a preview is not a commitment.
 */
export async function loadCrewRoles(
  input: CrewRolesRequest & { chatId: string }
): Promise<CrewRolesView> {
  const params = new URLSearchParams({ chatId: input.chatId });
  return crewJson(
    input,
    `/api/crew/roles?${params.toString()}`,
    crewRolesReadSchema
  );
}

/**
 * AGENT read: "who holds which role on MY mission". No chat is named — the
 * exact-job bearer selects the partition, so this cannot reach another crew.
 *
 * Returns the STATUS alongside the plan, not just the plan: a worker that treats
 * a `proposed` crew as settled would coordinate with peers nobody has committed
 * to dispatching. Same answer the operator gets, minus the lane inventory.
 */
export async function loadCrewRolePlan(
  input: CrewRolesRequest & { chatId?: string }
): Promise<CrewRolePlanView> {
  const query = input.chatId
    ? `?${new URLSearchParams({ chatId: input.chatId }).toString()}`
    : "";
  return crewJson(input, `/api/crew/roles${query}`, crewRolePlanReadSchema);
}

/**
 * Assign (or re-assign) roles for ONE chat. Callable by an operator or by an
 * agent holding the orchestrator capability; an agent caller is confined to its
 * own chat server-side.
 *
 * `pinned` selects WHICH lane holds a role and can never grant that lane more
 * than the role's own ceiling. Bindings the HUMAN pinned (`assignedBy: "human"`)
 * survive an agent-initiated reassignment — a coordinator re-planning the crew
 * never silently overrides the operator's choice.
 */
export async function assignCrewRoles(
  input: CrewRolesRequest & {
    chatId: string;
    roles?: AgentRole[];
    pinned?: RolePin[];
  }
): Promise<CrewRolePlan> {
  const request = roleRequestSchema.parse({
    ...(input.roles === undefined ? {} : { roles: input.roles }),
    ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
  });
  const result = await crewJson(input, "/api/crew/roles", crewRolePlanWriteSchema, {
    chatId: input.chatId,
    ...(request.roles === undefined ? {} : { roles: request.roles }),
    ...(request.pinned === undefined
      ? {}
      : { pinned: pinnedRecord(request.pinned) }),
  });
  return result.plan;
}

/** Parse a `--pin role=vendor` argument. Throws with the accepted roles. */
export function parseRolePin(value: string): RolePin {
  const separator = value.indexOf("=");
  if (separator < 1) {
    throw new Error(
      `--pin must be <role>=<vendor> (roles: ${AGENT_ROLES.join("|")}), got '${value}'`
    );
  }
  const parsed = rolePinSchema.safeParse({
    role: value.slice(0, separator).trim(),
    vendor: value.slice(separator + 1),
  });
  if (!parsed.success) {
    throw new Error(
      `--pin must be <role>=<vendor> (roles: ${AGENT_ROLES.join("|")}), got '${value}'`
    );
  }
  return parsed.data;
}
