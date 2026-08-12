import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { prisma as prismaClient } from "./db.js";

/**
 * THE RUNNER'S LAUNCH LEASE — one check, used by every route that needs it.
 *
 * Extracted from `routes/dispatch.ts` on 2026-08-09, where it had been
 * module-private, when a second route needed it. A copied lease check is the
 * drift class this repo has paid for repeatedly: the two would agree today and
 * disagree the first time either grew a condition.
 *
 * What it proves: the CALLER is the runner process that currently holds the
 * launch lease for `host`, and is alive. Pair it with a per-job check —
 * `job.runnerLeaseHash === <the hash this returns>` — to prove the caller is
 * the runner executing THAT job. Neither half is sufficient alone: the lease
 * says which process, the job's stamp says which work.
 */

/**
 * How recently a runner must have been seen to count as holding its lease.
 *
 * ONE definition. It was written out in `routes/dispatch.ts` and again in
 * `lib/workflow-planner.ts`, which is two places for a liveness window to
 * drift — and a window that disagrees with itself means one surface calls a
 * runner alive while another calls it dead.
 */
export const RUNNER_LIVE_WINDOW_MS = 15_000;

export function hashRunnerLease(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function requireActiveRunnerLease(
  app: FastifyInstance,
  tx: Pick<typeof prismaClient, "runner">,
  host: string,
  leaseToken: string,
  options: { requireFresh?: boolean } = {}
): Promise<string> {
  const leaseHash = hashRunnerLease(leaseToken);
  const runner = await tx.runner.findFirst({
    where: {
      host,
      leaseHash,
      ...(options.requireFresh === false
        ? {}
        : {
            lastSeenAt: {
              gte: new Date(Date.now() - RUNNER_LIVE_WINDOW_MS),
            },
          }),
    },
  });
  if (!runner) {
    throw app.httpErrors.conflict(
      `Runner host '${host}' does not hold the active launch lease.`
    );
  }
  return leaseHash;
}
