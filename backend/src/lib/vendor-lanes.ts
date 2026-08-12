import { fakeVendorEnabled } from "@muon/adapters";
import { vendorsWhere, type VendorId } from "@muon/protocol";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

/**
 * "Which lanes exist?" — asked of the REGISTRY, at the read.
 *
 * MUON had two answers to that question: the ADR-0022 vendor registry (derived)
 * and the `Lane`/`Agent` rows bootstrap seeds (persisted). Seeding only ever
 * ADDS, so a vendor removed from the registry kept its rows and kept showing up
 * wherever a surface enumerated lanes from the database instead of the registry —
 * the crew topology drew a fifth node beside its own "4 lanes" header.
 *
 * The fix is to make the persisted side stop being an ANSWER. Every "available
 * lane / available seat" read below filters against the registry projection, so
 * the registry is the only thing that can say a lane exists. That is what makes
 * it idempotent (a pure function of the registry, recomputed per read), and what
 * makes it impossible to drift: no boot has to have run, and no flag has to be
 * correct, for an unregistered vendor to be absent.
 *
 * RETIRE, NEVER DELETE. Nothing here removes a row. Dispatch jobs, tasks,
 * assignments, approvals, stream chunks and memory notes reference lanes and
 * fleet seats by id, and every one of those reads is a KEYED lookup (`findUnique`
 * by id, `include: { lane: true }`, `seatNames()`), so history keeps resolving
 * exactly as before — a job that ran on the removed lane still renders its lane
 * name in the Timeline. `retireUnregisteredLanes` below only stamps a status.
 */

/**
 * Lane keys MUON still names. A lane row is what makes a vendor resolvable at
 * execution, so the predicate is VISIBILITY (all four managed lanes have one,
 * including the scout-only `opencode`), not a narrower authority column.
 *
 * Positive predicate, registry order — never `VENDOR_IDS.filter((id) => !gone)`.
 * The `fake` seam is admitted by the SAME second condition `claimableVendors()`
 * uses: a LIVE `MUON_FAKE_VENDOR` read, so the seam cannot be frozen at module
 * load and production never sees it.
 */
export function availableLaneKeys(): readonly VendorId[] {
  const seamOpen = fakeVendorEnabled();
  return vendorsWhere(
    (entry) =>
      entry.visibility === "public" ||
      (entry.visibility === "dev-test" && seamOpen)
  );
}

/** `where` fragment for the "lanes that exist" reads. Positive `in`, never a `not`. */
export function availableLaneWhere(): Prisma.LaneWhereInput {
  return { key: { in: [...availableLaneKeys()] } };
}

/**
 * The lane lifecycle marker. `Lane.status` already defaults to "available" and
 * nothing else in the tree writes it, so retirement needs no migration and no
 * new column — the state the schema always had a slot for is finally used.
 */
export const RETIRED_LANE_STATUS = "retired";

/**
 * Boot reconciliation: stamp every persisted lane the registry no longer names.
 *
 * ADVISORY, NOT AUTHORITATIVE. No read gates on this status — the reads above
 * derive from the registry — so a row this never reached (an install that has not
 * rebooted, a row inserted by an older build) is still absent from every
 * available-lane surface. What the stamp buys is honesty at rest: the operator
 * who opens the database, or runs `muon lane list`, sees WHY there are five rows
 * and four lanes instead of a row that still claims to be available.
 *
 * Idempotent, and disjoint from the seeding path that runs beside it:
 * `ensureDefaultLanes` asserts `available` for exactly the REGISTERED keys, this
 * asserts `retired` for exactly the rest, and the second boot matches zero rows.
 * Re-registering a vendor un-retires its lane on the next boot, so the whole
 * mechanism is reversible.
 *
 * The complement (`notIn`) is safe in this direction only: it derives the
 * FORBIDDEN set, so an unknown or newly-added row lands on the retired side, not
 * the available one. The AVAILABLE set is always the positive `in` above.
 */
export async function retireUnregisteredLanes(): Promise<number> {
  const { count } = await prisma.lane.updateMany({
    where: {
      key: { notIn: [...availableLaneKeys()] },
      status: { not: RETIRED_LANE_STATUS },
    },
    data: { status: RETIRED_LANE_STATUS },
  });
  return count;
}
