import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enableRequestSchema } from "@muon/protocol";
import { confirmingPrincipal, requireOperator } from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import { requireActiveRunnerLease } from "../lib/runner-lease.js";
import { discoverCompatibilityInventory } from "../lib/compatibility-discovery.js";
import {
  attestLaneImports,
  CompatibilityEnableError,
  disableImportedItem,
  enableImportedItem,
  listLaneImports,
} from "../lib/compatibility-enable.js";

/**
 * ADR-0038 D1 slice 1 — the inventory, and only the inventory.
 *
 * There is one route, it is a GET, and it takes NO INPUT: no path, no vendor,
 * no scope, no query. That is the security property, not an unfinished
 * signature. The handler reaches the filesystem, so any parameter that could
 * steer it is an arbitrary-file-read oracle; the files it reads come from
 * `INSTALLABLE_VENDORS` + `vendorConfigPath` (the same table
 * `muon mcp install/status` writes and reads through) and from nowhere else.
 * A `?vendor=` filter would be safe against a fixed lookup and is still absent
 * — filtering four rows is the caller's job, and an input this route does not
 * accept is one nobody has to re-audit later.
 *
 * ── TIER: OPERATOR, deliberately narrower than ADR-0038 permits ─────────────
 *
 * ADR-0038 D1 says "an agent may read the inventory; an agent may never
 * enable." That PERMITS an agent-tier read; it does not oblige this slice to
 * build one, and this slice does not:
 *
 *  - The enumerator reads files inside the human's home directory that MUON
 *    does not own and that routinely hold OTHER servers' bearer tokens. The
 *    response carries no values by construction (`discoverMcpServers` takes
 *    env/header NAMES only and redacts url/args), but it is still a complete
 *    census of the human's third-party tooling — server names, the absolute
 *    commands they launch, the hosts they reach, the names of the credentials
 *    they need. For an MCP-only agent with no filesystem of its own, that is
 *    reconnaissance MUON would be the sole supplier of.
 *  - Widening operator → agent later is one deleted line and is additive.
 *    Narrowing after an agent surface exists is a breaking change. ADR-0038's
 *    own open question 2 makes the same call about lanes: the narrower answer
 *    ships sooner and is trivially safe.
 *  - `agentJobRouteAllowed` is a deny-first matrix, so a per-job vendor
 *    capability is refused already; this route is deliberately absent from it.
 *    `requireOperator` closes the other half — the runner's SHARED agent bearer,
 *    which that matrix does not gate.
 *
 * ── SLICE 2: ENABLE (added 2026-08-09, ADR-0038 D7/D8) ─────────────────────
 *
 * The founder answered the two open questions, so the authority half exists
 * now. Its tiering is NOT uniform, and the split is the design:
 *
 *  - `enable` and `disable` are OPERATOR. D8 clause 2 is "human enable only",
 *    and these are the only two verbs that change what a lane may reach.
 *  - `attest` is deliberately NOT operator, and this is the one place that
 *    looks like a hole and is not. The runner's own client is AGENT-tier (it
 *    is the token injected into dispatched sub-agents), so an operator-only
 *    attestation would mean an agent-dispatched lane never receives its
 *    imported servers at all — D8 would be decided and dead. What keeps it
 *    narrow is the OTHER half of the tier: `agentJobRouteAllowed` is a
 *    deny-first matrix and this route is absent from it, so a per-job
 *    capability bearer — a dispatched sub-agent's own MCP token — is refused.
 *    The runner may attest; the thing the runner spawns may not.
 *    It is also the safest verb of the three: it can only NARROW (it disables
 *    on drift and never enables), it takes no shape from the caller, and what
 *    it returns is the set a human already approved for that one lane.
 *  - the lane listing is OPERATOR: it is a human's review surface, and unlike
 *    `attest` nothing in the run path needs it.
 */
export async function registerCompatibilityRoutes(app: FastifyInstance) {
  app.get("/mcp", async (request) => {
    requireOperator(app, request);
    // Recomputed per call: nothing is persisted, so an inventory can never go
    // stale against the config it describes, and there is no stored row for a
    // later slice to quietly attach an "enabled" column to.
    return discoverCompatibilityInventory();
  });

  const laneParams = z.object({ laneKey: z.string().min(1).max(128) });

  app.get("/mcp/lanes/:laneKey", async (request) => {
    requireOperator(app, request);
    const { laneKey } = laneParams.parse(request.params);
    return guard(app, () => listLaneImports(laneKey));
  });

  app.post("/mcp/lanes/:laneKey/enable", async (request) => {
    // ADR-0038 D1: "an agent may read the inventory; an agent may never
    // enable." This line is that sentence.
    requireOperator(app, request);
    const { laneKey } = laneParams.parse(request.params);
    const body = enableRequestSchema.parse(request.body);
    // WHAT THIS RECORD ACTUALLY PROVES, stated exactly.
    //
    // `requireOperator` above authenticates that AN OPERATOR did this — that
    // part is real and is the authority gate. The NAME stored in `enabledBy`
    // is taken from the body and only shape-checked (`confirmingPrincipal`
    // rejects a non-human principal, not a wrong one), because a shared
    // operator token carries no per-human identity to derive it from.
    //
    // This comment used to claim the approver was "authenticated, never
    // body-asserted", which a review showed the code never did. The row is
    // trustworthy as "an operator enabled this"; it is NOT proof of WHICH
    // human, and nothing downstream may treat it as such until MUON has
    // per-human operator identity.
    const principal = confirmingPrincipal(
      (request.body as { principal?: string } | undefined)?.principal
    );
    return guard(app, () =>
      enableImportedItem({ laneKey, ...body, principal })
    );
  });

  app.post("/mcp/lanes/:laneKey/disable", async (request) => {
    requireOperator(app, request);
    const { laneKey } = laneParams.parse(request.params);
    const body = enableRequestSchema.parse(request.body);
    return guard(app, () => disableImportedItem({ laneKey, ...body }));
  });

  app.post("/mcp/lanes/:laneKey/attest", async (request) => {
    // NO requireOperator — see the tier note above. The deny-first job matrix
    // still refuses a dispatched sub-agent's per-job bearer.
    const { laneKey } = laneParams.parse(request.params);
    const body = z
      .object({
        jobId: z.string().min(1).max(128).optional(),
        host: z.string().trim().min(1).max(200).optional(),
        leaseToken: z.string().min(32).max(512).optional(),
      })
      .parse(request.body ?? {});

    if (request.tier !== "operator") {
      // BOUND TO THE JOB THIS CALLER IS ACTUALLY EXECUTING — proven, not named.
      //
      // Two adversarial passes on this. The first found that the runner's
      // SHARED agent bearer could attest ANY lane it asked for: two boundary
      // crossings at once, since it enumerates another lane's approved MCP
      // launch configurations (server names, the commands they run, the hosts
      // they reach) and, because attestation DISABLES on drift, can knock that
      // lane's imports out as a side effect.
      //
      // Naming a live job in the lane was not enough — the second pass pointed
      // out that ANY holder of the shared token can name any live job. So the
      // caller proves it is the LEASE-HOLDING runner for that job, which is
      // the same two-part proof `delegation-token` requires: the lease says
      // WHICH PROCESS, and the job's own `runnerLeaseHash` says WHICH WORK.
      // Neither half is sufficient alone.
      if (!body.jobId || !body.host || !body.leaseToken) {
        throw app.httpErrors.forbidden(
          "Attesting a lane's imported servers requires operator authority, or the lease-holding runner of a live job in that same lane. Send jobId, host and leaseToken."
        );
      }
      const leaseHash = await requireActiveRunnerLease(
        app,
        prisma,
        body.host,
        body.leaseToken
      );
      const job = await prisma.dispatchJob.findUnique({
        where: { id: body.jobId },
        select: { vendor: true, status: true, runnerLeaseHash: true },
      });
      if (
        !job ||
        job.vendor !== laneKey ||
        job.status !== "running" ||
        job.runnerLeaseHash !== leaseHash
      ) {
        throw app.httpErrors.forbidden(
          "Only the lease-holding runner of a running job in this lane may attest its imported servers."
        );
      }
    }
    return guard(app, () => attestLaneImports(laneKey));
  });
}

/**
 * Turn this module's typed refusals into HTTP without losing the sentence.
 *
 * ADR-0033: a refusal explains itself. A 500 with a stack would tell a human
 * that MUON broke when what actually happened is that MUON declined, and the
 * two need different reactions.
 */
async function guard<T>(app: FastifyInstance, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CompatibilityEnableError) {
      // Carry the status the LIBRARY chose. An earlier version collapsed
      // everything that was not a 404 into 400, which turned a genuine
      // CONFLICT — "this lane already holds a server by that name" — into
      // "your request was malformed". A caller cannot tell from a 400 that
      // retrying after disabling the other one would work.
      switch (error.statusCode) {
        case 404:
          throw app.httpErrors.notFound(error.message);
        case 409:
          throw app.httpErrors.conflict(error.message);
        case 403:
          throw app.httpErrors.forbidden(error.message);
        default:
          throw app.httpErrors.badRequest(error.message);
      }
    }
    throw error;
  }
}
