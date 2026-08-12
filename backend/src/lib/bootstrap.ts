import type { Prisma } from "@prisma/client";
import { FAKE_VENDOR_KEY, fakeVendorEnabled } from "@muon/adapters";
import { DEFAULT_HARNESSES } from "@muon/core";
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from "@muon/protocol";
import { prisma } from "./db.js";
import {
  COORDINATOR_ORDINAL,
  COORDINATOR_VENDORS,
  FLEET_SEATS_PER_VENDOR,
  FLEET_VENDORS,
  coordinatorName,
} from "../routes/fleet.js";

const defaultLanes = [
  {
    key: "claude-code",
    name: "Claude Code",
    provider: "anthropic",
    role: "peer",
  },
  {
    key: "codex",
    name: "Codex",
    provider: "openai",
    role: "peer",
  },
  {
    key: "cursor",
    name: "Cursor",
    provider: "cursor",
    role: "worker",
  },
  {
    // Managed read-only reconnaissance. A lane row is what makes the vendor
    // resolvable at execution, so the scout-only slice is unreachable without
    // it.
    key: "opencode",
    name: "OpenCode",
    provider: "opencode",
    role: "worker",
  },
] as const;

export async function ensureDefaultLanes() {
  // DEV/TEST seam (P7): register the `fake` lane so executeJob can resolve it,
  // but ONLY when the seam is enabled, production never seeds it.
  const lanes = fakeVendorEnabled()
    ? [
        ...defaultLanes,
        {
          key: FAKE_VENDOR_KEY,
          name: "Fake Vendor (dev/test)",
          provider: "muon-fake",
          role: "worker",
        } as const,
      ]
    : defaultLanes;
  await Promise.all(
    lanes.map((lane) =>
      prisma.lane.upsert({
        where: { key: lane.key },
        update: {
          name: lane.name,
          provider: lane.provider,
          role: lane.role,
          // Re-assert availability so seeding and `retireUnregisteredLanes` are
          // one coherent pair over disjoint key sets instead of two writers that
          // could fight: this one owns the REGISTERED keys, the reconciler owns
          // the rest. It also makes retirement reversible — re-registering a
          // vendor un-retires its lane on the next boot. Nothing else in the tree
          // writes `Lane.status`, so there is no operator state to clobber.
          status: "available",
        },
        create: {
          key: lane.key,
          name: lane.name,
          provider: lane.provider,
          role: lane.role,
        },
      })
    )
  );
}

// Seed harness library (VISION §6.3). The rows themselves live in
// @muon/core (DEFAULT_HARNESSES) so the seeded config and the tests that
// reason about it cannot drift apart; this function only persists them.
export async function ensureDefaultHarnesses() {
  await Promise.all(
    DEFAULT_HARNESSES.map((harness) =>
      prisma.harness.upsert({
        where: { key: harness.key },
        // Re-sync the muon-owned default config on every boot so a seed change
        // (e.g. research becoming edit-free) reaches an EXISTING install — not
        // just fresh DBs. These keys are muon-owned by definition; there is no
        // user harness-editing surface to clobber.
        update: {
          name: harness.name,
          config: harness.config as Prisma.InputJsonValue,
        },
        create: {
          key: harness.key,
          name: harness.name,
          config: harness.config as Prisma.InputJsonValue,
          createdBy: "muon",
        },
      })
    )
  );
}

// The ONE v1 template (research brief appendix): every gate is objectively
// checkable and it exercises workflow + harness + loop in a single run.
const bugfixDefinition: WorkflowDefinition = workflowDefinitionSchema.parse({
  steps: [
    {
      stepKey: "reproduce",
      title: "Reproduce with a failing test",
      briefTemplate:
        "Reproduce the reported bug with a minimal failing automated test. Do not fix the bug yet.\n\nBug report: {{request}}",
      role: "suggest",
      harnessKey: "implement",
      handoffTo: "fix",
    },
    {
      stepKey: "fix",
      title: "Fix until checks pass",
      briefTemplate:
        "Make the failing test pass without breaking other checks.\n\nBug report: {{request}}",
      role: "suggest",
      harnessKey: "repair",
      loop: { kind: "check_repair", maxIterations: 3, onExhaust: "escalate" },
      handoffTo: "second-opinion",
    },
    {
      stepKey: "second-opinion",
      title: "Independent second opinion",
      briefTemplate:
        "Review the fix for this bug. Respond with VERDICT: APPROVE or VERDICT: CONCERNS followed by your reasons.\n\nBug report: {{request}}",
      role: "suggest",
      harnessKey: "review",
      gate: "gate",
    },
    {
      stepKey: "ship",
      title: "Ship review",
      briefTemplate:
        "Human gate: run ship checks and approve the merge for: {{request}}",
      role: "human",
      gate: "merge",
    },
  ],
});

// FD-6: dedicated non-fleet coordinator lanes (reserved ordinal 0 per vendor)
// the super-orchestrator claims, so an orchestrator chat turn never burns a
// worker slot. One seat per managed orchestrator vendor (claude-code, codex).
// Create-only (idempotent); EXCLUDED from every fleet count/resize.
export async function ensureCoordinatorAgent() {
  for (const vendor of COORDINATOR_VENDORS) {
    const name = coordinatorName(vendor);
    await prisma.agent.upsert({
      where: { name },
      update: {},
      create: {
        vendor,
        ordinal: COORDINATOR_ORDINAL,
        name,
      },
    });
  }
}

/**
 * BOOTSTRAP WATERMARK — the per-vendor worker-seat floor this database has
 * already been seeded to. Stored rather than recomputed because "top the fleet
 * up to N seats" and "the operator's own 0–3 sizing is never overridden" are
 * otherwise the same write: an operator who resizes claude-code down to 1 — or
 * all the way to 0 — must not find three seats back after the next boot. With
 * the watermark, raising `FLEET_SEATS_PER_VENDOR` tops an EXISTING install up
 * exactly once and every later boot is a no-op, at ANY size the human chose.
 *
 * It shares the OperatorSetting table with the #133 posture flags but is NOT one
 * of them: nothing outside bootstrap reads or writes it, and it records what
 * MUON has done rather than what the human wants.
 */
const FLEET_SEAT_BASELINE_KEY = "fleetSeatBaseline";

/**
 * The floor already applied, or `null` when the watermark cannot be trusted —
 * the settings read threw, or the stored value is not a count.
 *
 * TRI-STATE on purpose, and both unknown-directions matter. An unreadable
 * watermark is not evidence of anything: it must neither top a SEATED vendor up
 * past a size the operator may have chosen (the widening direction) NOR let this
 * boot record a floor it never verified (the "already done" direction).
 * Returning the TARGET for both — as this used to — collapsed the second: one
 * transient `findUnique` hiccup wrote `fleetSeatBaseline = 3` over a database
 * still holding one seat per vendor, and no later boot ever topped it up.
 *
 * The ONE case an unknown watermark still seeds is a vendor with NO seats at
 * all; `ensureDefaultFleet` states why, and withholds the watermark for it.
 *
 * An ABSENT row is a genuine, readable answer (0 = never seeded), not an
 * unknown.
 */
async function readFleetSeatBaseline(): Promise<number | null> {
  try {
    const row = await prisma.operatorSetting.findUnique({
      where: { key: FLEET_SEAT_BASELINE_KEY },
    });
    if (!row) {
      return 0;
    }
    const parsed = Number.parseInt(row.value, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

// Default fleet: FLEET_SEATS_PER_VENDOR worker instances per vendor so a
// same-vendor fan-out actually runs in parallel out of the box, plus the
// coordinator lane above the fleet. Create-only and top-up-only: an existing row
// is never renumbered, renamed, deleted, or re-pointed, so a seat that is live
// mid-dispatch survives untouched, and a lane MUON no longer registers (the
// retired `ollama`) is never visited at all.
export async function ensureDefaultFleet() {
  await ensureCoordinatorAgent();
  const target = FLEET_SEATS_PER_VENDOR;
  const seededTo = await readFleetSeatBaseline();
  // Whether this pass may honestly claim every vendor reached `target`. A pass
  // that SKIPPED a top-up on an unknown watermark did not reach it, and must
  // leave the watermark alone so a later boot retries (see the write below).
  let reachedFloor = true;
  const vendors: string[] = [...FLEET_VENDORS];
  // DEV/TEST seam (P7): seed the `fake` fleet agents so the runner can claim
  // them through the real 0–3 semaphore, only when the seam is enabled.
  if (fakeVendorEnabled()) {
    vendors.push(FAKE_VENDOR_KEY);
  }
  for (const vendor of vendors) {
    // WORKER instances only (ordinal >= 1): the coordinator (claude-code
    // ordinal 0) must never suppress seeding claude-code-1, nor be counted as
    // one of the seats a fan-out can use.
    const existing = await prisma.agent.findMany({
      where: { vendor, ordinal: { gte: 1 } },
      select: { ordinal: true },
      orderBy: { ordinal: "asc" },
    });
    // Once the watermark proves this database reached the floor, the vendor's
    // size is the OPERATOR'S — including a deliberate 0. Top-up is the one-time
    // migration for an install seeded under the old one-seat default, never a
    // recurring override of a resize; restoring a vendor the human emptied is
    // the same override, and the contract above says their 0–3 sizing wins.
    if (seededTo !== null && seededTo >= target) {
      continue;
    }
    // Watermark unknown. Refuse to widen a vendor that already holds seats (it
    // may be a resize), but still seed one with NONE: without the watermark MUON
    // cannot tell a first run from a deliberate 0, and a fleetless first boot —
    // nothing dispatchable at all — is the worse of the two failures. Either
    // way this pass has not verified the floor, so it records none.
    if (seededTo === null) {
      reachedFloor = false;
      if (existing.length > 0) {
        continue;
      }
    }
    // Fill the smallest UNUSED ordinals, exactly as the resize route does: a
    // scale-down leaves gaps (a working agent survives a resize), and a blind
    // `length + 1` would collide with @@unique([vendor, ordinal]).
    const taken = new Set(existing.map((agent) => agent.ordinal));
    for (let ordinal = 1; taken.size < target; ordinal += 1) {
      if (taken.has(ordinal)) {
        continue;
      }
      taken.add(ordinal);
      await prisma.agent.create({
        data: { vendor, ordinal, name: `${vendor}-${ordinal}` },
      });
    }
  }
  // AFTER the seeds, and ONLY when the pass actually reached the floor for
  // every vendor: a boot that dies mid-seed — or one that skipped a top-up
  // because it could not read the watermark — retries the whole pass on the
  // next boot (the creates above are already idempotent against what landed)
  // rather than recording a floor it never reached. Recording one it never
  // reached is the durable version of this bug: it silently ends same-vendor
  // parallelism forever, and nothing ever surfaces it.
  if (!reachedFloor) {
    return;
  }
  await prisma.operatorSetting.upsert({
    where: { key: FLEET_SEAT_BASELINE_KEY },
    create: { key: FLEET_SEAT_BASELINE_KEY, value: String(target) },
    update: { value: String(target) },
  });
}

/**
 * Settle LoopRun rows a dead runner left "running". A loop's terminal write
 * rides its runner; a crash/kill between iterations leaves the row live
 * forever, and the desktop's Commitments screen then shows a phantom
 * "iteration N/M · Pause" for a loop nothing is executing (a founder found
 * one from two days prior). At BOOT nothing can legitimately still be
 * running: this process IS the brain coming up, so every runner lease
 * predating it is gone. Two shapes:
 *  - dispatch-bound rows (post-0051): orphaned iff their owning job is no
 *    longer running/pending — the job's own recovery is the witness;
 *  - unbound legacy rows: orphaned unconditionally at boot, same reasoning.
 * Settles to "aborted" with an honest stopReason; never touches a row whose
 * job the dispatch spine is about to resume (running/pending survive it).
 */
export async function settleOrphanedLoopRuns(): Promise<number> {
  const running = await prisma.loopRun.findMany({
    where: { status: "running" },
    select: { id: true, dispatchJobId: true },
  });
  if (running.length === 0) return 0;
  const jobIds = running
    .map((row) => row.dispatchJobId)
    .filter((id): id is string => Boolean(id));
  const liveJobs = new Set(
    (
      await prisma.dispatchJob.findMany({
        where: { id: { in: jobIds }, status: { in: ["queued", "running"] } },
        select: { id: true },
      })
    ).map((job) => job.id)
  );
  const orphaned = running
    .filter((row) => !row.dispatchJobId || !liveJobs.has(row.dispatchJobId))
    .map((row) => row.id);
  if (orphaned.length === 0) return 0;
  await prisma.loopRun.updateMany({
    where: { id: { in: orphaned }, status: "running" },
    data: {
      status: "aborted",
      stopReason:
        "settled at boot: the owning run ended without settling this loop",
      endedAt: new Date(),
    },
  });
  return orphaned.length;
}

export async function ensureDefaultWorkflowTemplates() {
  await prisma.workflowTemplate.upsert({
    where: { key: "bugfix" },
    update: {},
    create: {
      key: "bugfix",
      name: "Bugfix",
      definition: bugfixDefinition as Prisma.InputJsonValue,
      createdBy: "muon",
    },
  });
}
