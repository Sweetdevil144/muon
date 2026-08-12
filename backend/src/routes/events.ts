import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  laneEventKindSchema,
  preflightEditEvidenceSchema,
} from "@muon/protocol";
import {
  requireAgentTaskAccess,
  requireOperator,
  visibleTaskIdsForCapability,
} from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import {
  auditActorFromRequest,
  buildEventAuditStamp,
  ensureEventPrincipals,
  eventAuditData,
} from "../lib/event-audit.js";
import { mirrorToGraph } from "../lib/graph.js";
import { markModulesStale } from "../lib/memory-ledger.js";

const createEventSchema = z.object({
  // Bound to a MACHINE-IDENTIFIER shape (KG-7 side-channel). `laneId` flows into
  // the live-activity coordinate that the pre-edit hero surfaces to an AGENT's
  // MCP output; rejecting free-form text (spaces/newlines/quotes/brackets/
  // backticks) at ingestion stops a prompt-injection payload from ever riding out
  // as a "coordinate". Legit lane ids (vendor keys, `claude-code-0`, lane keys)
  // all match; this closes the KG-7 review's laneId finding at the boundary.
  laneId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9:._-]+$/, "laneId must be a machine identifier"),
  taskId: z.string().min(1),
  kind: laneEventKindSchema,
  message: z.string().min(1).max(2_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.iso.datetime().optional(),
  // TODO 5.15 — optional correlation id from the caller. Never trusted as
  // authority; the acting principal is derived from auth, not the body.
  requestId: z.string().min(1).max(128).optional(),
});

export async function registerEventRoutes(app: FastifyInstance) {
  app.get("/", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        // WHY A KIND FILTER EXISTS AT ALL, since a reviewer will ask.
        //
        // This route's default window is the ONLY place any consumer in the tree
        // reads `memory.graph_mirror_failed` — the signal that says the graph
        // projection has stopped tracking the ledger. `reportMirrorFailure`
        // coalesces to at most one row per 30 s per label, and justifies that on
        // "the operator surfaces that already read the event log show that memory
        // is degraded". D14's `recordGateRead` then began writing one row per
        // PRE-EDIT GATE READ, which on a busy mission flushes a coalesced alarm out
        // of a fifty-row time-ordered window before anyone polls it.
        //
        // So a surface can now NAME the signal — `?kind=memory.graph_mirror_failed`
        // — instead of hoping it wins a race against a higher-volume producer. It
        // is deliberately a plain string rather than `laneEventKindSchema`: the two
        // kinds that matter here (`memory.gate_read`, `memory.graph_mirror_failed`)
        // are MUON's own audit rows, written straight to `Event` and never through
        // the POST below, so they are not members of that enum and never will be.
        // Unknown kinds simply match nothing.
        //
        // NOT A NEW VISIBILITY. The filter only ever NARROWS: the agent-tier
        // `visibleTaskIds` clause below is ANDed with it and unchanged, and both
        // audit kinds carry the sentinel `taskId: "memory"`, which is no real task
        // and therefore in no capability's visible set.
        kind: z.string().min(1).max(200).optional(),
      })
      .parse(request.query);
    const visibleTaskIds = request.agentJobCapability
      ? await visibleTaskIdsForCapability(request.agentJobCapability)
      : undefined;
    const events = await prisma.event.findMany({
      where: {
        ...(visibleTaskIds ? { taskId: { in: visibleTaskIds } } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
      },
      orderBy: { timestamp: "desc" },
      take: query.limit,
    });
    return { events };
  });

  // F5 — the exportable audit trail. OPERATOR-ONLY: this is the full
  // principal-stamped record across every task, exactly what an agent-tier
  // caller must never page through. JSONL (one event per line) so the export
  // is greppable and diffable; filters only ever narrow. The Event table has
  // no update or delete route anywhere in the tree — export is a read over an
  // append-only record, and stays that way.
  app.get("/audit/export", async (request, reply) => {
    requireOperator(app, request);
    const query = z
      .object({
        taskId: z.string().min(1).max(200).optional(),
        kind: z.string().min(1).max(200).optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(10_000).default(2_000),
      })
      .parse(request.query);
    const events = await prisma.event.findMany({
      where: {
        ...(query.taskId ? { taskId: query.taskId } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.since || query.until
          ? {
              timestamp: {
                ...(query.since ? { gte: query.since } : {}),
                ...(query.until ? { lte: query.until } : {}),
              },
            }
          : {}),
      },
      orderBy: { timestamp: "asc" },
      take: query.limit,
    });
    reply.header("content-type", "application/jsonl; charset=utf-8");
    return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  });

  // Append-only: events can be created and read, never updated or deleted.
  app.post("/", async (request, reply) => {
    const payload = createEventSchema.parse(request.body);
    const capability = request.agentJobCapability;
    if (capability) {
      await requireAgentTaskAccess(app, request, payload.taskId);
      if (payload.taskId !== capability.taskId) {
        throw app.httpErrors.forbidden(
          "A job may append activity only to its exact task."
        );
      }
    }
    const laneId = capability?.vendor ?? payload.laneId;
    const stringArray = (value: unknown): string[] =>
      Array.isArray(value) && value.every((v) => typeof v === "string")
        ? (value as string[])
        : [];
    const safeCoordinate = (value: string): boolean =>
      value.length <= 1024 && !/[\r\n]/.test(value);
    const symbols = stringArray(
      (payload.metadata as { symbols?: unknown }).symbols
    )
      .filter(safeCoordinate)
      .slice(0, 512);
    const intentModules = stringArray(
      (payload.metadata as { intentModules?: unknown }).intentModules
    )
      .filter(safeCoordinate)
      .slice(0, 128);
    const parsedPreflight = preflightEditEvidenceSchema.safeParse(
      (payload.metadata as { preflightEdit?: unknown }).preflightEdit
    );
    const preflightEdit =
      capability &&
      parsedPreflight.success &&
      parsedPreflight.data.jobId === capability.jobId &&
      safeCoordinate(parsedPreflight.data.target) &&
      safeCoordinate(parsedPreflight.data.filePath) &&
      parsedPreflight.data.coveredFiles.every(safeCoordinate)
        ? parsedPreflight.data
        : undefined;
    // A job bearer may submit only the fixed event class plus bounded
    // coordinates/proof evidence. Arbitrary model prose and metadata never enter
    // the activity ledger; the trusted runner/operator path is unchanged.
    const message = capability
      ? `job activity: ${payload.kind}`
      : payload.message;
    const metadata = capability
      ? {
          ...(symbols.length > 0 ? { symbols } : {}),
          ...(intentModules.length > 0 ? { intentModules } : {}),
          ...(preflightEdit ? { preflightEdit } : {}),
        }
      : payload.metadata;

    // TODO 5.15: stamp principal from AUTH, never from a body-asserted human.
    // An agent job becomes `agent:<vendor>`; an operator becomes human-kind.
    // Principal upsert is AFTER the create and fire-and-forget: Event is
    // append-only and must not refuse a write when Principal hiccups.
    const actor = auditActorFromRequest(request);
    const stamp = buildEventAuditStamp({
      actor,
      requestId: payload.requestId ?? null,
    });

    const event = await prisma.event.create({
      data: {
        laneId,
        taskId: payload.taskId,
        kind: payload.kind,
        message,
        metadata: metadata as Prisma.InputJsonValue,
        ...eventAuditData(stamp),
        ...(payload.timestamp
          ? { timestamp: new Date(payload.timestamp) }
          : {}),
      },
    });
    void ensureEventPrincipals(stamp, actor);

    // A vendor job may declare coordinate-only edit intent, but only the
    // trusted runner/operator can mark durable memory stale after observing
    // actual changed files. This prevents a model from poisoning unrelated
    // modules by calling the loopback route directly.
    const modules = capability
      ? []
      : stringArray(
          (metadata as { modules?: unknown }).modules
        )
          .filter((value) => value.length <= 1024 && !/[\r\n]/.test(value))
          .slice(0, 128);
    // Edit intent participates in collision discovery but never in staleness or
    // TOUCHED edges: only runner-observed `modules` may claim code actually changed.
    const activityModules = Array.from(
      new Set([
        ...modules,
        ...stringArray(
          (metadata as { intentModules?: unknown }).intentModules
        )
          .filter(safeCoordinate)
          .slice(0, 128),
      ])
    );
    // KG-8 (ADR-0014): the declared symbol anchors (`<module>#<name>`) a task is
    // touching, projected into ACTED_ON. Additive to the shape the events route
    // already consumes; symbols are a READ of intent (they do NOT mark modules
    // stale, only `metadata.modules` does).
    // Persist staleness to the LEDGER first (source of truth, KG-2 / F3) so a
    // graph wipe can't lose which notes went suspect; the graph mirror follows
    // best-effort. Never fail the append-only event write on a staleness hiccup.
    //
    // OBSERVABLE, because the failure is not recoverable. `staleSince` is
    // SET-ONCE, so a swallowed write means the LEDGER never learns these modules
    // went suspect — while `graph.touchModules` below still runs and the mirror
    // does. `applyMemoryExpiry` therefore ORs the two witnesses rather than
    // letting either clear the other (see `resolveStale`); this line is what tells
    // an operator that the pair has diverged at all. COORDINATES ONLY: how many
    // modules and the error, never a module path and never note text.
    if (modules.length > 0) {
      // The event's own task is exempt: its notes describe this very change.
      await markModulesStale(modules, event.timestamp, event.taskId).catch((error: unknown) => {
        console.error(
          `[memory] staleness ledger write failed for ${modules.length} module(s); ` +
            `the graph mirror stays the only witness for this event: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      });
    }

    // KG-8 (ADR-0014): resolve the TRUSTED, bounded `DispatchJob` claim-state for
    // this task, the {jobId, vendor} coordinates the recent-activity projection
    // carries. Sourced from the ledger's claim-state (NEVER free-form metadata, so
    // an agent can't poison a "vendor"/"jobId" coordinate) and coordinate columns
    // ONLY (id/vendor, never `brief`). Best-effort: absent → "".
    let vendor = "";
    let jobId = "";
    if (symbols.length > 0 || activityModules.length > 0) {
      const job = await prisma.dispatchJob
        .findFirst({
          where: { taskId: event.taskId },
          orderBy: { createdAt: "desc" },
          select: { id: true, vendor: true },
        })
        .catch(() => null);
      if (job) {
        vendor = job.vendor;
        jobId = job.id;
      }
    }

    mirrorToGraph(async (graph) => {
      await graph.recordEvent({
        laneId: event.laneId,
        taskId: event.taskId,
        kind: event.kind,
        timestamp: event.timestamp.toISOString(),
      });
      if (modules.length > 0) {
        // TOUCHED edges feed staleness + module-familiarity routing.
        await graph.touchModules(
          modules,
          event.timestamp.toISOString(),
          event.taskId
        );
      }
      // KG-8: project the rebuildable recent-activity edges (ACTED_ON per symbol,
      // ACTED_ON_MODULE per module), coordinates only. Mirrors `touchModules` in the
      // SAME best-effort path; wipe-survivably replayed by `projectLedgerToGraph`.
      if (symbols.length > 0 || activityModules.length > 0) {
        await graph.recordActivity({
          taskId: event.taskId,
          laneId: event.laneId,
          vendor,
          jobId,
          at: event.timestamp.toISOString(),
          symbols,
          modules: activityModules,
        });
      }
    });

    reply.code(201);
    return { event };
  });
}
