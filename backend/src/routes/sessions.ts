import { execFile } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getVendorReadinessCached } from "@muon/adapters";
import { prisma } from "../lib/db.js";
import { requireOperator } from "../lib/auth.js";
import { requestAuditColumns } from "../lib/event-audit.js";

const createSessionSchema = z.object({
  laneId: z.string().min(1),
  taskId: z.string().min(1),
  // Checkpoint edge (P0.1 Slice A): the DispatchJob this session executes,
  // written at session create so job→session is a first-class, indexed join.
  jobId: z.string().min(1).optional(),
  vendorSessionId: z.string().min(1).optional(),
});

const updateSessionSchema = z
  .object({
    status: z.enum(["running", "waiting_approval", "interrupted", "ended", "failed"]).optional(),
    vendorSessionId: z.string().min(1).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one field must be provided.",
  });

export async function registerSessionRoutes(app: FastifyInstance) {
  app.get("/", async (request) => {
    const query = z
      .object({
        taskId: z.string().min(1).optional(),
        status: z.string().min(1).optional(),
      })
      .parse(request.query);

    const sessions = await prisma.laneSession.findMany({
      where: {
        ...(query.taskId ? { taskId: query.taskId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { startedAt: "desc" },
      include: { lane: true },
    });

    return { sessions };
  });

  app.post("/", async (request, reply) => {
    const payload = createSessionSchema.parse(request.body);

    const session = await prisma.laneSession.create({
      data: payload,
      include: { lane: true },
    });

    reply.code(201);
    return { session };
  });

  app.patch("/:sessionId", async (request) => {
    const params = z
      .object({ sessionId: z.string().min(1) })
      .parse(request.params);
    const payload = updateSessionSchema.parse(request.body);

    const session = await prisma.laneSession.update({
      where: { id: params.sessionId },
      data: {
        ...payload,
        ...(payload.status === "ended" || payload.status === "failed"
          ? { endedAt: new Date() }
          : {}),
      },
      include: { lane: true },
    });

    return { session };
  });

  // ── ADR-0030: the governed-to-native round trip ──────────────────────────
  // One owner at a time. Both verbs are OPERATOR-tier and audited; a
  // capability bearer can neither hand itself a session nor reclaim one.

  const dirtyFileCount = async (cwd: string): Promise<number | null> =>
    new Promise((resolve) => {
      execFile(
        "git",
        ["status", "--porcelain"],
        { cwd, timeout: 10_000 },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          resolve(stdout.split("\n").filter((line) => line.trim()).length);
        }
      );
    });

  app.post("/:sessionId/take-over", async (request) => {
    requireOperator(app, request);
    const params = z
      .object({ sessionId: z.string().min(1) })
      .parse(request.params);
    const existing = await prisma.laneSession.findUnique({
      where: { id: params.sessionId },
      include: { lane: true },
    });
    if (!existing) {
      throw app.httpErrors.notFound("The requested session does not exist.");
    }
    if (existing.status === "ended" || existing.status === "failed") {
      throw app.httpErrors.conflict(
        "This session already ended; there is nothing to take over. Use the vendor's own resume command directly."
      );
    }
    if (existing.owner === "human") {
      return { session: existing, alreadyOwned: true };
    }
    // Guarded claim (review: ownership races): only a session still
    // muon-owned flips. A concurrent transition loses cleanly instead of
    // being stomped.
    const claimed = await prisma.laneSession.updateMany({
      where: { id: params.sessionId, owner: "muon" },
      data: { owner: "human", ownerChangedAt: new Date() },
    });
    if (claimed.count !== 1) {
      const current = await prisma.laneSession.findUnique({
        where: { id: params.sessionId },
        include: { lane: true },
      });
      return { session: current ?? existing, alreadyOwned: true };
    }
    const session = (await prisma.laneSession.findUnique({
      where: { id: params.sessionId },
      include: { lane: true },
    }))!;
    try {
      await prisma.event.create({
        data: {
          ...(await requestAuditColumns(request, {
            payloadDiff: { owner: { from: "muon", to: "human" } },
          })),
          laneId: session.laneId,
          taskId: session.taskId,
          kind: "session.taken_over",
          message: "native take-over: automation suspended for this session",
          metadata: { sessionId: session.id, jobId: session.jobId },
        },
      });
    } catch (error) {
      console.error(
        `[audit] session.taken_over event failed for ${session.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    return { session, alreadyOwned: false };
  });

  app.post("/:sessionId/return", async (request) => {
    requireOperator(app, request);
    const params = z
      .object({ sessionId: z.string().min(1) })
      .parse(request.params);
    const existing = await prisma.laneSession.findUnique({
      where: { id: params.sessionId },
    });
    if (!existing) {
      throw app.httpErrors.notFound("The requested session does not exist.");
    }
    if (existing.owner !== "human") {
      return { session: existing, alreadyOwned: true, snapshot: null };
    }
    // Coordinates-only snapshot of what the human did natively: the dirty
    // FILE COUNT in the job's workspace — never paths, never contents.
    const job = existing.jobId
      ? await prisma.dispatchJob.findUnique({ where: { id: existing.jobId } })
      : null;
    const dirtyFiles = job?.workspacePath
      ? await dirtyFileCount(job.workspacePath)
      : null;
    // Re-attest before automation resumes: the same authenticated-probe
    // evidence a dispatch preflight trusts. A degraded probe must NOT wedge
    // ownership — the audit row records the degradation instead.
    let readinessDegraded = false;
    try {
      await getVendorReadinessCached({ refresh: true });
    } catch {
      readinessDegraded = true;
    }
    // Guarded release (greptile P1): the snapshot + readiness awaits above
    // take seconds. If the operator took the session over AGAIN in that
    // window (a NEWER human claim, i.e. a different ownerChangedAt), this
    // stale return must not silently resume automation over it.
    const released = await prisma.laneSession.updateMany({
      where: {
        id: params.sessionId,
        owner: "human",
        ownerChangedAt: existing.ownerChangedAt,
      },
      data: { owner: "muon", ownerChangedAt: new Date() },
    });
    if (released.count !== 1) {
      throw app.httpErrors.conflict(
        "Session ownership changed while this return was in flight (a newer take-over exists). Nothing was changed — re-check and return again if you mean it."
      );
    }
    const session = (await prisma.laneSession.findUnique({
      where: { id: params.sessionId },
      include: { lane: true },
    }))!;
    try {
      await prisma.event.create({
        data: {
          ...(await requestAuditColumns(request, {
            payloadDiff: {
              owner: { from: "human", to: "muon" },
              dirtyFiles,
              readinessDegraded,
            },
          })),
          laneId: session.laneId,
          taskId: session.taskId,
          kind: "session.returned",
          message: "native take-over returned: automation may act again",
          metadata: { sessionId: session.id, jobId: session.jobId },
        },
      });
    } catch (error) {
      console.error(
        `[audit] session.returned event failed for ${session.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    return {
      session,
      alreadyOwned: false,
      snapshot: { dirtyFiles, readinessDegraded },
    };
  });
}
