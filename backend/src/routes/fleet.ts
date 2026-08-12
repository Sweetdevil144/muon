import {
  anyVendorReady,
  fakeVendorEnabled,
  getVendorReadinessCached,
  type VendorReadiness,
} from "@muon/adapters";
import {
  agentRoleSchema,
  coordinatorVendorIds,
  DELEGATION_MAX_CHILDREN,
  FLEET_MAX_AGENTS_PER_VENDOR,
  fleetGateTag,
  fleetVendorIds,
  isReadOnlyRole,
  vendorsWhere,
  type VendorId,
} from "@muon/protocol";
import type { Agent, Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requestAuditColumns } from "../lib/event-audit.js";
import {
  assertVendorMayHoldRole,
  vendorRoleCeiling,
} from "../lib/dispatch-role.js";
import { redeemGateAtRoute } from "../lib/gate.js";

/**
 * The 0–3 worker fleet, projected from the registry's `fleetSizeable` column
 * (ADR-0022 C2). Pure registry data with no env read, so evaluating it once at
 * module load is safe — the DEV/TEST seam is NOT in here (it is admitted per
 * call by `claimableVendors()`, which reads `MUON_FAKE_VENDOR` live).
 */
export const FLEET_VENDORS: readonly VendorId[] = fleetVendorIds();
/**
 * The resize ceiling, projected from the registry (ADR-0022 discipline) rather
 * than spelled again here: the preflight publishes it and the orchestrator tool
 * bounds its echoed agent list by it, and three copies of a `3` is how one of
 * them ends up smaller than the fleet it is describing.
 */
export const FLEET_MAX_PER_VENDOR = FLEET_MAX_AGENTS_PER_VENDOR;

/**
 * Worker seats MUON SEEDS per vendor (bootstrap), as opposed to the ceiling an
 * operator may resize to above.
 *
 * It is `DELEGATION_MAX_CHILDREN` because that is how wide one parent may fan a
 * mission out: with fewer seats than that, a same-vendor fan-out does not run in
 * parallel, it QUEUES — measured, on the founder's own run, as two claude-code
 * implementers running back to back (the second started 117 ms after the first
 * ended) because exactly one dispatchable claude-code seat existed. Derived from
 * the delegation cap rather than spelled `3` so raising the fan-out cap cannot
 * silently leave the fleet unable to honour it (drift-locked in tests).
 */
export const FLEET_SEATS_PER_VENDOR = DELEGATION_MAX_CHILDREN;

// FD-6: the dedicated non-fleet coordinator lane the super-orchestrator claims,
// seated ABOVE the worker fleet at reserved ordinal 0. An orchestrator chat turn
// claims ONLY this lane (dispatch claim txn), so it never consumes a worker slot;
// workers only ever claim ordinal >= 1. Every fleet count/resize/claim below
// excludes it, so a resize — even to 0 — can neither create, delete, nor count the
// coordinator, and it never surfaces in the operator's fleet view.
export const COORDINATOR_ORDINAL = 0;
/**
 * Managed vendors that may seat the super-orchestrator (reserved ordinal 0),
 * projected from the registry's `authority.coordinatorSeat` column (ADR-0022
 * C3). Cursor and OpenCode stay out of the seat because they say `false` there,
 * not because this file remembers to omit them.
 *
 * Seat CAPACITY only (G4). The refusal that actually keeps a lane out of the
 * seat is the role ceiling — `assertVendorMayHoldRole(app, vendor,
 * "orchestrator")` — which this list never substitutes for.
 */
export const COORDINATOR_VENDORS: readonly VendorId[] = coordinatorVendorIds();
/**
 * Deliberately the whole vendor namespace and not `(typeof
 * COORDINATOR_VENDORS)[number]`: the boundary is the VALUE above (a registry
 * projection), never this alias, and a type that narrowed to today's two
 * members would have to be widened by hand the day a third vendor earns a seat.
 */
export type CoordinatorVendor = VendorId;

export function coordinatorName(vendor: CoordinatorVendor): string {
  return `${vendor}-coordinator`;
}

// Worker lanes are every non-coordinator instance (ordinal >= 1). Reused as the
// exclusion filter for counts, resize, and worker claims.
const WORKER_ORDINAL = { gte: 1 } as const;

/**
 * The readiness prober (P2). Default = the real vendor-CLI probe (the embedded
 * backend is LOCAL, so it can spawn the CLIs), short-cached to avoid spawning
 * on every dispatch/runner tick. Injectable so route tests never spawn a real
 * CLI. A token is never read, stored, or returned by the probe.
 */
type ReadinessProber = (opts?: { refresh?: boolean }) => Promise<VendorReadiness[]>;
let readinessProber: ReadinessProber = (opts) =>
  getVendorReadinessCached({ refresh: opts?.refresh });

/** Test seam: override (or reset with null) the readiness prober. */
export function setReadinessProber(prober: ReadinessProber | null): void {
  readinessProber =
    prober ?? ((opts) => getVendorReadinessCached({ refresh: opts?.refresh }));
}

// Built by reduction over FLEET_VENDORS, so the resize body admits exactly the
// fleet-sizeable lanes and a new one needs no edit here. Same bound per vendor.
const fleetCountsSchema = z.object(
  Object.fromEntries(
    FLEET_VENDORS.map((vendor) => [
      vendor,
      z.number().int().min(0).max(FLEET_MAX_PER_VENDOR).optional(),
    ])
  ) as Record<VendorId, z.ZodOptional<z.ZodNumber>>
);

// PUT /api/fleet body = the counts + an OPTIONAL gate (ADR-0010 Part B). The
// gate id is kept OUT of `counts` (separate key) so it never leaks into the
// canonical gate tag, the fleet.updated event, or a vendor loop. Operator-tier
// surfaces (CLI/TUI/desktop) and the no-token dev mode omit it and are unchanged.
const fleetUpdateBodySchema = fleetCountsSchema.extend({
  gateApprovalId: z.string().min(1).optional(),
});

/**
 * Vendors an agent may be claimed for. The DEV/TEST `fake` vendor is claimable
 * ONLY when MUON_FAKE_VENDOR=1 (and a `fake` fleet agent is seeded, see
 * bootstrap). The 0–3 semaphore, retry, and 409 semantics are otherwise
 * identical to the real vendors, the full-loop E2E drives the SAME claim path.
 */
function claimableVendors(): readonly VendorId[] {
  const seamOpen = fakeVendorEnabled();
  return vendorsWhere(
    (entry) =>
      entry.authority.fleetSizeable &&
      (entry.visibility === "public" ||
        (entry.visibility === "dev-test" && seamOpen))
  );
}

const claimSchema = z.object({
  vendor: z.string().min(1),
  taskId: z.string().min(1).optional(),
  // The crew role the claimed seat will run as. OPTIONAL for the lanes whose
  // whole role range is dispatchable; REQUIRED for a lane that is only managed
  // for part of it (cursor), because "claim me a cursor seat" without naming the
  // work is exactly the widening this route used to refuse outright.
  role: agentRoleSchema.optional(),
});

const updateAgentSchema = z
  .object({
    status: z.enum(["idle", "working", "offline"]).optional(),
    currentTaskId: z.string().min(1).nullable().optional(),
    sessionId: z.string().min(1).nullable().optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one field must be provided.",
  });

function isPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function fleetSnapshot() {
  // Exclude the coordinator (ordinal 0): it sits above the fleet and is never a
  // worker slot, so it counts toward no vendor total and never appears here.
  //
  // Seats are scoped to `claimableVendors()` for the same reason `counts` below
  // iterates FLEET_VENDORS: this is the "which seats exist" answer, and it has to
  // come from the registry. Seeding only ever adds, so a vendor dropped from the
  // registry kept its agent rows and `agents` kept reporting them while `counts`
  // did not — five nodes under a header that said four lanes, in every surface
  // that derives its seat list from this array (desktop crew topology, the
  // sidebar's lane rows and busy/idle tallies). The rows are KEPT: `seatNames()`
  // still resolves a finished job's crew codename by seat id.
  const agents = await prisma.agent.findMany({
    where: { ordinal: WORKER_ORDINAL, vendor: { in: [...claimableVendors()] } },
    orderBy: [{ vendor: "asc" }, { ordinal: "asc" }],
  });
  const counts: Record<string, number> = {};
  for (const vendor of FLEET_VENDORS) {
    counts[vendor] = agents.filter((agent) => agent.vendor === vendor).length;
  }
  return { counts, agents };
}

export async function registerFleetRoutes(app: FastifyInstance) {
  app.get("/", async (request) => {
    const fleet = await fleetSnapshot();
    // Redaction keys on the TIER, not on a job capability: an ATTACHED MCP
    // session (muon mcp install / observer / loopback HTTP) presents the
    // shared agent token with NO job capability, and keying on the capability
    // gave exactly that untrusted caller class the unredacted view — another
    // mission's task/job/session identifiers — while governed jobs were
    // stripped. Only the operator (human) surfaces see cross-mission ids.
    if (request.tier === "operator") {
      return fleet;
    }
    return {
      counts: fleet.counts,
      // Capacity and busy/idle posture help the orchestrator size work. Another
      // chat's task/session identifiers do not, and reusable fleet seats are
      // never peer identity or authority.
      agents: fleet.agents.map((agent) => ({
        ...agent,
        currentTaskId: null,
        currentJobId: null,
        sessionId: null,
      })),
    };
  });

  // Credential-aware readiness (P2 onboarding). Per vendor: installed plus
  // positive native-login or trusted provider evidence, never a credential
  // value.
  // The wizard/panel consume this; dispatch gates on it. `?refresh=1` bypasses
  // the short cache (call it right after a login). Degrades gracefully: a probe
  // that can't run reports authenticated:false with a fixHint, never a 500.
  app.get("/readiness", async (request) => {
    const query = z
      .object({ refresh: z.union([z.literal("1"), z.literal("true")]).optional() })
      .parse(request.query ?? {});
    const probedVendors = await readinessProber({
      refresh: query.refresh !== undefined,
    });
    // Tier-keyed, not capability-keyed: the attached MCP sessions (no job
    // capability) are precisely the untrusted vendor processes this PII strip
    // exists for — `logged in as <email>` must not enter a model context.
    const vendors = request.tier !== "operator"
      ? probedVendors.map((entry) => ({
          ...entry,
          // Login probes may include the connected account identity. It is
          // useful operator provenance but unnecessary PII for an untrusted
          // vendor process. Non-operator callers receive only the state.
          detail: !entry.installed
            ? "CLI not installed"
            : entry.authenticated
              ? "ready"
              : entry.authState === "provider-unconfigured"
                ? "provider credential unavailable"
                : entry.authState === "unknown"
                  ? "authentication could not be verified"
                  : "not authenticated",
          fixHint: undefined,
        }))
      : probedVendors;
    // WHICH ready lanes actually unlock a first dispatch. This used to be
    // spelled `entry.vendor !== "cursor"` — the right ANSWER for the wrong
    // REASON, and the last surviving copy of a hardcode the adapters
    // (`anyVendorReady`) and the client (`buildOnboardingState`) each already
    // replaced with the derived form. Same verdict today for all four managed
    // lanes; derived so a lane whose role ceiling changes cannot silently fall
    // on the wrong side of the line the way Cursor once did.
    const anyReady = anyVendorReady(vendors);
    return {
      vendors,
      anyReady,
      generatedAt: new Date().toISOString(),
      // Soft-warn signal for the UI/CLI when nothing is connected yet.
      ...(anyReady
        ? {}
        : {
            warning:
              "No vendor is ready, configure or sign in to at least one installed agent before dispatching.",
          }),
    };
  });

  // The human sets the fleet size (0–3 per vendor). Scale-up creates idle
  // instances; scale-down retires idle instances only, a working agent is
  // never killed by a resize.
  app.put("/", async (request) => {
    const { gateApprovalId, ...counts } = fleetUpdateBodySchema.parse(
      request.body
    );

    // Tier-conditional route gate (ADR-0010 Part B / closes F3). The operator
    // tier IS the govern authority, the human's own CLI/TUI/desktop (and the
    // no-token dev/test mode, which defaults to operator) apply directly. An
    // agent-tier caller (the orchestrator) MUST present a redeemed, tag-bound,
    // operator-approved, SINGLE-USE gate for these EXACT counts, or is rejected
    // BEFORE any write, so a bare agent-tier HTTP call can no longer bypass the
    // human gate that used to live only in the MCP tool layer. The atomic
    // redeem both validates and consumes, closing replay + payload swap.
    // Fail-closed (review F-4): the consume precedes the write, so a later
    // conflict spends the gate (re-approval needed), security > a wasted gate.
    if (request.tier !== "operator") {
      const redeemed =
        gateApprovalId !== undefined &&
        (await redeemGateAtRoute(prisma, gateApprovalId, fleetGateTag(counts)));
      if (!redeemed) {
        throw app.httpErrors.forbidden(
          "A fleet resize from the agent tier requires an operator-approved, single-use gate bound to these exact counts. File a gate (kind=gate) and retry with its gateApprovalId once the human approves; a used, mismatched, or non-gate approval is rejected."
        );
      }
    }

    const warnings: string[] = [];

    for (const vendor of FLEET_VENDORS) {
      const target = counts[vendor];
      if (target === undefined) {
        continue;
      }
      // Worker instances only (ordinal >= 1). The coordinator is invisible to a
      // resize, so it is never in `existing`, never fills an ordinal, and — even
      // for a resize-to-0 — is never selected into the delete set below.
      const existing = await prisma.agent.findMany({
        where: { vendor, ordinal: WORKER_ORDINAL },
        orderBy: { ordinal: "asc" },
      });

      // Scale-down leaves gaps (working agents survive a resize), so new
      // instances must fill the smallest UNUSED ordinals, `length + 1` would
      // collide with @@unique([vendor, ordinal]) after a gap.
      const takenOrdinals = new Set(existing.map((agent) => agent.ordinal));
      const newOrdinals: number[] = [];
      let candidate = 1;
      for (let i = existing.length; i < target; i += 1) {
        while (takenOrdinals.has(candidate)) {
          candidate += 1;
        }
        takenOrdinals.add(candidate);
        newOrdinals.push(candidate);
      }

      const excess = existing.slice(target);
      const idleIds = excess
        .filter((agent) => agent.status !== "working")
        .map((agent) => agent.id);

      try {
        // One transaction per vendor: a P2002 or partial failure can't
        // half-apply a resize (some creates without the delete, or vice versa).
        const removed =
          newOrdinals.length === 0 && idleIds.length === 0
            ? 0
            : await prisma.$transaction(async (tx) => {
                for (const ordinal of newOrdinals) {
                  await tx.agent.create({
                    data: { vendor, ordinal, name: `${vendor}-${ordinal}` },
                  });
                }
                if (idleIds.length === 0) {
                  return 0;
                }
                // Status guard: an agent claimed between the read above and
                // this delete is 'working' now and must survive the resize.
                const deleted = await tx.agent.deleteMany({
                  where: { id: { in: idleIds }, status: "idle" },
                });
                return deleted.count;
              });

        const kept = excess.length - removed;
        if (kept > 0) {
          warnings.push(
            `${vendor}: ${kept} working agent(s) kept until they finish, resize again later`
          );
        }
      } catch (error) {
        // Ordinal gaps are filled above, so P2002 here means a concurrent
        // resize raced us, surface a 409 instead of an opaque 500 (the
        // global handler only maps P2025/P2003).
        if (isPrismaErrorCode(error, "P2002")) {
          throw app.httpErrors.conflict(
            `${vendor}: concurrent fleet resize detected (agent name/ordinal already exists), retry`
          );
        }
        throw error;
      }
    }

    await prisma.event.create({
      data: {
        ...(await requestAuditColumns(request)),
        laneId: "muon",
        taskId: "fleet",
        kind: "fleet.updated",
        message: `fleet resized: ${Object.entries(counts)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${value}`)
          .join(" ")}`,
        metadata: counts as Prisma.InputJsonValue,
      },
    });

    return { ...(await fleetSnapshot()), warnings };
  });

  app.get("/agents", async () => {
    const { agents } = await fleetSnapshot();
    return { agents };
  });

  // Atomic claim: the per-vendor semaphore. 409 when every instance is busy
  // (or the vendor's fleet is set to zero), callers wait or resize.
  //
  // findFirst only nominates a candidate; the status-guarded updateMany is
  // the real atomic claim (under READ COMMITTED, findFirst + unguarded update
  // hands the SAME agent to two concurrent claimers). count === 0 means
  // another claimer won that row, retry with the next idle candidate.
  const MAX_CLAIM_ATTEMPTS = 5;
  app.post("/agents/claim", async (request, reply) => {
    const payload = claimSchema.parse(request.body);
    const claimable = claimableVendors();
    if (!claimable.some((id) => id === payload.vendor)) {
      throw app.httpErrors.badRequest(
        `Unknown vendor '${payload.vendor}'. Expected one of: ${claimable.join(", ")}.`
      );
    }
    // ROLE-AWARE ADMISSION (was: a blanket cursor refusal). A seat is claimed
    // for a piece of work, so the boundary belongs on the role: a lane may only
    // be claimed for a role the registry declares for it, and a partially-managed
    // lane must name that role rather than defaulting into the wider slice.
    const ceiling = vendorRoleCeiling(payload.vendor);
    if (payload.role) {
      assertVendorMayHoldRole(app, payload.vendor, payload.role);
    } else if (ceiling.length === 0) {
      // Reachable only for a vendor that is claimable but declares no role at
      // all. `[].every()` is `true`, so without this branch the refusal below
      // would fire with a message about read-only roles it does not hold.
      throw app.httpErrors.badRequest(
        `Vendor '${payload.vendor}' holds no crew role in MUON, so no seat can be claimed for it.`
      );
    } else if (ceiling.every(isReadOnlyRole)) {
      throw app.httpErrors.badRequest(
        `Vendor '${payload.vendor}' is managed for read-only crew roles only, so a claim must name the role it is for (role: reviewer | qa | architect | scout).`
      );
    }

    let agent: Agent | null = null;
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      // Worker claim: ordinal >= 1 only, so a generic claim can never burn the
      // coordinator lane out from under the super-orchestrator.
      const idle = await prisma.agent.findFirst({
        where: { vendor: payload.vendor, status: "idle", ordinal: WORKER_ORDINAL },
        orderBy: { ordinal: "asc" },
      });
      if (!idle) {
        break;
      }
      const claimed = await prisma.agent.updateMany({
        where: { id: idle.id, status: "idle" },
        data: {
          status: "working",
          currentTaskId: payload.taskId ?? null,
        },
      });
      if (claimed.count === 1) {
        agent = await prisma.agent.findUnique({ where: { id: idle.id } });
        break;
      }
    }

    if (!agent) {
      const total = await prisma.agent.count({
        where: { vendor: payload.vendor },
      });
      throw app.httpErrors.conflict(
        total === 0
          ? `Fleet has zero '${payload.vendor}' agents, muon fleet set --${payload.vendor} 1..3`
          : `All ${total} '${payload.vendor}' agent(s) are working, wait or resize the fleet`
      );
    }

    reply.code(201);
    return { agent };
  });

  app.patch("/agents/:agentId", async (request) => {
    const params = z
      .object({ agentId: z.string().min(1) })
      .parse(request.params);
    const payload = updateAgentSchema.parse(request.body);

    const data = {
      ...(payload.status ? { status: payload.status } : {}),
      ...(payload.currentTaskId !== undefined
        ? { currentTaskId: payload.currentTaskId }
        : {}),
      ...(payload.sessionId !== undefined
        ? { sessionId: payload.sessionId }
        : {}),
      // Releasing an unleased/direct agent clears its task pointer.
      ...(payload.status === "idle"
        ? { currentTaskId: null, currentJobId: null, sessionId: null }
        : {}),
    };

    const mutatesOwnership =
      payload.status !== undefined || payload.currentTaskId !== undefined;
    if (mutatesOwnership) {
      // A persistent-dispatch claim is released only by the lease-fenced
      // terminal transaction in dispatch.ts. This guarded write prevents the
      // generic fleet endpoint from clearing currentJobId underneath a live
      // vendor process.
      const updated = await prisma.agent.updateMany({
        where: { id: params.agentId, currentJobId: null },
        data,
      });
      if (updated.count !== 1) {
        const existing = await prisma.agent.findUnique({
          where: { id: params.agentId },
        });
        if (!existing) {
          throw app.httpErrors.notFound(
            "The requested fleet agent does not exist."
          );
        }
        if (existing.currentJobId) {
          throw app.httpErrors.conflict(
            "This agent belongs to a dispatch job and can only be released by that job's active runner lease."
          );
        }
        throw app.httpErrors.conflict(
          "The fleet agent changed before the update could commit."
        );
      }
      const agent = await prisma.agent.findUnique({
        where: { id: params.agentId },
      });
      return { agent };
    }

    // Session metadata may be attached by the active dispatch without changing
    // ownership. The terminal transaction remains the only release path.
    const agent = await prisma.agent.update({
      where: { id: params.agentId },
      data,
    });

    return { agent };
  });
}
