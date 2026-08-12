import {
  ROLE_SPECS,
  agentRoleSchema,
  harnessConfigSchema,
  isReadOnlyRole,
  vendorRoleCeiling,
  type AgentRole,
  type RoleAuthority,
} from "@muon/protocol";
import type { FastifyInstance } from "fastify";
import type { RefusalAudience } from "@muon/protocol";
import { refuseBadRequest } from "./refusal-http.js";
import type { prisma } from "./db.js";

// ── The crew role a dispatch RUNS AS (VISION §2) ─────────────────────────────
//
// `DispatchJob.role` is the coordinate every role-shaped surface reads: the
// runner narrows the composed profile to it, and A2A derives peer identity from
// it (a job with no role has no peer identity at all, by design). It is
// therefore resolved HERE, server-side, from authenticated coordinates — never
// taken on trust from a worker's own claim about what it is.
//
// Two properties keep that safe:
//  1. A ROLE ONLY NARROWS. `narrowProfileForRole` is monotone and the runner
//     re-asserts it at launch, so resolving a role can never hand a job
//     authority its lane profile did not already have.
//  2. THE CEILING IS THE REGISTRY'S. A vendor holds exactly the roles ADR-0022's
//     registry declares for it; the resolution below may pick among them but can
//     never reach past them, and a role outside the declared set is a 400 that
//     names what the vendor CAN hold rather than a silent downgrade. A vendor
//     the registry does not name holds NOTHING — the ceiling has no "unset".

/**
 * Role authority, ordered. A delegated child may sit at or below its parent's
 * tier and NEVER above it: the child's role drives `narrowProfileForRole` at
 * launch, so a read-only parent that could name a write role for its child
 * would be handing out write authority it does not itself hold. Delegation
 * narrows, exactly like every other MUON authority surface.
 */
const ROLE_AUTHORITY_RANK: Readonly<Record<RoleAuthority, number>> =
  Object.freeze({
    "read-only": 0,
    write: 1,
    coordinate: 2,
  });

function authorityRank(role: AgentRole): number {
  return ROLE_AUTHORITY_RANK[ROLE_SPECS[role].authority];
}

/**
 * The crew role a stored `DispatchJob.role` names, or undefined when the job
 * has none (pre-role rows, and jobs created outside the dispatch routes). An
 * unknown value is deliberately NOT defaulted — see
 * `assertDelegationWithinParent` for what "no role" means there.
 */
export function storedRole(
  value: string | null | undefined
): AgentRole | undefined {
  const parsed = agentRoleSchema.safeParse(value ?? undefined);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Harness key → the crew role that harness IS. A harness already encodes the
 * shape of the work (its overlay, checks, and worktree requirement), so it is
 * the best evidence available when nobody named a role explicitly.
 */
const HARNESS_ROLE_HINTS: Readonly<Record<string, AgentRole>> = Object.freeze({
  implement: "implementer",
  repair: "implementer",
  review: "reviewer",
  "security-audit": "reviewer",
  research: "scout",
  planner: "architect",
});

/** The role a harness key implies, or undefined for an unrecognized harness. */
export function harnessRoleHint(
  harnessKey: string | null | undefined
): AgentRole | undefined {
  return harnessKey ? HARNESS_ROLE_HINTS[harnessKey] : undefined;
}

/** A harness row as this module needs it: the key plus its stored config. */
export type HarnessRow = { key: string; config?: unknown } | null | undefined;

/**
 * Does this harness hand the agent write authority? Known muon-owned keys
 * answer from their hint role; anything else is judged by its stored config
 * (worktree requirement, sandbox, permission mode). FAIL-CLOSED: a config that
 * cannot be parsed is assumed to write, so an unreadable harness can never
 * launder a write step past a read-only role.
 */
export function harnessGrantsWrites(harness: HarnessRow): boolean {
  if (!harness) {
    return false;
  }
  const hint = HARNESS_ROLE_HINTS[harness.key];
  if (hint) {
    return !isReadOnlyRole(hint);
  }
  const parsed = harnessConfigSchema.safeParse(harness.config);
  if (!parsed.success) {
    return true;
  }
  const overlay = parsed.data.profileOverlay;
  return (
    parsed.data.requires.worktree ||
    overlay.sandbox === "workspace-write" ||
    overlay.sandbox === "full-access" ||
    overlay.permissionMode === "auto-edits" ||
    overlay.permissionMode === "full-auto"
  );
}

/**
 * The roles a vendor may hold, from THE registry (ADR-0022 §3.2). `[]` for a
 * vendor MUON does not name, and `[]` REFUSES.
 *
 * This used to read `createDefaultAdapters().find(…)?.supportedRoles`, so it
 * answered `undefined` both for an adapter that omitted the (then optional)
 * field AND for a vendor with no adapter at all — and `assertVendorMayHoldRole`
 * read that `undefined` as "every role, including orchestrator and implementer".
 * Sourcing it from the registry removes the third state entirely: the answer is
 * always a list, and an unknown vendor's list is empty.
 *
 * Re-exported rather than wrapped so `fleet.ts` and this module read the exact
 * same function. Note that it deliberately does NOT consult the `MUON_FAKE_VENDOR`
 * seam: a role ceiling is not an admission allowlist. `fake` is fenced out of
 * production by `allowedDispatchVendors()` / `claimableVendors()`, which do the
 * live env read — the seam stays two-condition and stays where it is.
 */
export { vendorRoleCeiling };

/**
 * Cursor is a MANAGED READ-ONLY lane: MUON runs `cursor-agent --print --mode
 * plan`, which never edits the workspace. It is dispatchable for review-class
 * work and refused for everything else — the boundary that used to be a blanket
 * "cursor is not dispatch-ready" now lives on the ROLE, where it is checkable.
 */
const CURSOR_ROLE_REFUSAL =
  "Cursor is a managed READ-ONLY lane in MUON: it may hold review-class roles only (reviewer, qa, architect, scout), never write-class work. Dispatch the write step to a lane that can hold it.";

/**
 * Fail-closed vendor/role admission. Throws a 400 that names the vendor, the
 * role, and what that vendor can actually hold.
 *
 * The admission is now a single positive test. It used to be
 * `if (!ceiling || ceiling.includes(role)) return;`, where the `!ceiling` arm
 * admitted EVERY role — the exact opposite default from `vendorDispatchRoles`,
 * which the readiness path reads and which has always refused an empty list.
 */
export function assertVendorMayHoldRole(
  app: FastifyInstance,
  vendor: string,
  role: AgentRole,
  // ADR-0033: the caller's audience. Defaults to `agent` because this is
  // reached from `dispatch`/`delegate` far more often than from an operator
  // surface, and the agent projection is the narrower of the two.
  audience: RefusalAudience = "agent"
): void {
  const ceiling = vendorRoleCeiling(vendor);
  if (ceiling.includes(role)) {
    return;
  }
  // A ceiling is a PERMANENT boundary, not a missing precondition: no retry and
  // no operator act makes Cursor a writer. Saying so beats inventing a next
  // step the caller would waste a turn on.
  const evidence = [
    { label: "vendor", value: vendor },
    { label: "requestedRole", value: role },
    { label: "allowedRoles", value: ceiling.join(", ") || "(none)" },
  ];
  if (vendor === "cursor") {
    refuseBadRequest(app, audience, {
      rule: "role.ceiling",
      summary: `${CURSOR_ROLE_REFUSAL} Requested role: '${role}'.`,
      surface: "dispatch role admission",
      evidence,
      nextAction: {
        kind: "none",
        because:
          "a read-only lane cannot be given write authority; dispatch the write step to a lane that holds it",
      },
    });
  }
  if (ceiling.length === 0) {
    refuseBadRequest(app, audience, {
      rule: "role.ceiling",
      summary: `Vendor '${vendor}' is not a lane MUON manages for crew work, so it cannot hold the role '${role}'.`,
      surface: "dispatch role admission",
      evidence,
      nextAction: {
        kind: "none",
        because: "this vendor holds no crew role at all",
      },
    });
  }
  refuseBadRequest(app, audience, {
    rule: "role.ceiling",
    summary: `Vendor '${vendor}' cannot hold the crew role '${role}'. It is declared for: ${ceiling.join(", ")}.`,
    surface: "dispatch role admission",
    evidence,
    nextAction: {
      kind: "none",
      because: `'${vendor}' is declared only for ${ceiling.join(", ")}`,
    },
  });
}

/**
 * Fail-closed role/harness admission. A read-only role running a write harness
 * is a contradiction, not a narrowing: the harness would ask for edits the role
 * denies, so the run could only fail late (or worse, quietly under-deliver).
 */
export function assertRoleMatchesHarness(
  app: FastifyInstance,
  role: AgentRole,
  harness: HarnessRow,
  audience: RefusalAudience = "agent"
): void {
  if (!harness || !isReadOnlyRole(role) || !harnessGrantsWrites(harness)) {
    return;
  }
  // Unlike a ceiling this IS satisfiable — either half can move — so the next
  // action is a real one.
  refuseBadRequest(app, audience, {
    rule: "role.profile_exceeds",
    summary: `Harness '${harness.key}' makes changes, which the read-only role '${role}' cannot do.`,
    surface: "dispatch harness admission",
    evidence: [
      { label: "role", value: role },
      { label: "field", value: "harness" },
      { label: "requested", value: harness.key },
      { label: "ceiling", value: "read-only" },
    ],
    nextAction: {
      kind: "retry",
      after:
        "re-dispatching under a write role (implementer/docs), or with a read-only harness (review, research, security-audit, planner)",
    },
  });
}

/**
 * Fail-closed DELEGATION ceiling: a child may never hold more authority than
 * the parent that spawned it, and a read-only parent may not hand its child a
 * harness that writes. A parent with NO stored role is unconstrained — that is
 * every pre-role job, and retroactively fencing them would break delegation
 * that works today (the runner's own launch assertion still bounds the child).
 */
export function assertDelegationWithinParent(
  app: FastifyInstance,
  input: {
    childRole: AgentRole;
    parentRole: string | null | undefined;
    harness: HarnessRow;
  }
): void {
  const parent = storedRole(input.parentRole);
  if (!parent) {
    return;
  }
  if (authorityRank(input.childRole) > authorityRank(parent)) {
    refuseBadRequest(app, "agent", {
      rule: "role.profile_exceeds",
      summary: `A delegated child cannot hold more authority than its parent: this job runs as '${parent}' (${ROLE_SPECS[parent].authority}) and cannot spawn a '${input.childRole}' (${ROLE_SPECS[input.childRole].authority}) child.`,
      surface: "delegation role admission",
      evidence: [
        { label: "role", value: parent },
        { label: "field", value: "childRole" },
        { label: "requested", value: input.childRole },
        { label: "ceiling", value: parent },
      ],
      nextAction: {
        kind: "retry",
        after: "delegating at or below your own authority",
      },
    });
  }
  if (isReadOnlyRole(parent) && harnessGrantsWrites(input.harness)) {
    refuseBadRequest(app, "agent", {
      rule: "role.profile_exceeds",
      summary: `A read-only '${parent}' job cannot hand a child the write harness '${input.harness?.key}'.`,
      surface: "delegation harness admission",
      evidence: [
        { label: "role", value: parent },
        { label: "field", value: "harness" },
        { label: "requested", value: String(input.harness?.key ?? "(none)") },
        { label: "ceiling", value: "read-only" },
      ],
      nextAction: {
        kind: "retry",
        after:
          "delegating with a read-only harness (review, research, security-audit, planner) or none",
      },
    });
  }
}

export type DispatchRoleInput = {
  /** The caller's explicit `role`, already schema-validated. */
  explicit?: AgentRole | undefined;
  vendor: string;
  chatId?: string | null | undefined;
  harnessKey?: string | null | undefined;
  /**
   * This job IS the chat's coordinator seat (a root orchestrator dispatch). Its
   * role comes from its capability mode, not from the crew plan.
   */
  coordinator?: boolean;
  /**
   * This job is a WORKER (every delegate child). A worker never coordinates, so
   * `orchestrator` is unreachable here — not even through a stale crew binding.
   */
  worker?: boolean;
  /**
   * The spawning parent's stored role, when this is a delegate. Resolution only
   * ever CHOOSES within it (a candidate above the parent's authority is not a
   * candidate, and the last-resort default falls back to the parent's own
   * role); an EXPLICIT or harness-implied role that exceeds it is refused
   * loudly by `assertDelegationWithinParent` rather than silently downgraded.
   */
  parentRole?: string | null | undefined;
};

/**
 * Resolve the crew role a dispatch runs as, in precedence order:
 *   1. the explicit `role` on the request;
 *   2. the coordinator seat (a root chat job IS the orchestrator);
 *   3. the chat's crew plan binding for this vendor (non-blocked; the binding
 *      that agrees with the harness wins, else the highest fit);
 *   4. the harness the job runs;
 *   5. `implementer` — the historical shape of an un-planned dispatch (or the
 *      delegating parent's own role, when `implementer` would exceed it).
 *
 * Resolution CHOOSES; it does not admit. The caller validates the result
 * against the vendor, the harness, and the delegating parent, so a stale or
 * hand-written binding is refused exactly like an explicit role would be.
 */
export async function resolveDispatchRole(
  db: Pick<typeof prisma, "crewRoleBinding">,
  input: DispatchRoleInput
): Promise<AgentRole> {
  if (input.explicit) {
    return input.explicit;
  }
  if (input.coordinator) {
    return "orchestrator";
  }
  const parent = storedRole(input.parentRole);
  const withinParent = (role: AgentRole): boolean =>
    !parent || authorityRank(role) <= authorityRank(parent);
  const fromHarness = harnessRoleHint(input.harnessKey);
  if (input.chatId) {
    const rows = await db.crewRoleBinding.findMany({
      where: { chatId: input.chatId, vendor: input.vendor, blocked: false },
      select: { role: true, fit: true },
    });
    const candidates = rows
      .map((row) => ({
        role: agentRoleSchema.safeParse(row.role),
        fit: row.fit,
      }))
      .flatMap((row) =>
        row.role.success ? [{ role: row.role.data, fit: row.fit }] : []
      )
      .filter((row) => !(input.worker && row.role === "orchestrator"))
      .filter((row) => withinParent(row.role));
    const agreeing = candidates.find((row) => row.role === fromHarness);
    const best = candidates.reduce<(typeof candidates)[number] | undefined>(
      (winner, row) => (winner && winner.fit >= row.fit ? winner : row),
      undefined
    );
    const bound = agreeing ?? best;
    if (bound) {
      return bound.role;
    }
  }
  if (fromHarness) {
    return fromHarness;
  }
  // Last resort. `implementer` is the historical shape of an un-planned
  // dispatch, but a read-only parent cannot spawn one, so its children default
  // to the parent's own role — a narrowing, never a widening.
  return parent && !withinParent("implementer") ? parent : "implementer";
}
