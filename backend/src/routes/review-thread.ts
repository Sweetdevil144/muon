import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  deriveBlockingQuestions,
  QUESTION_ANSWERED_EVENT_KIND,
  QUESTION_BLOCKED_EVENT_KIND,
  QUESTION_WITHDRAWN_EVENT_KIND,
  type QuestionSpineEvent,
} from "@muon/protocol";
import { requireOperator } from "../lib/auth.js";
import { prisma } from "../lib/db.js";

/**
 * H1 (2026-08 cycle) — the BOUND review thread.
 *
 * Opening a review used to be archaeology: every surface showed the full
 * dump, and "what changed since I last looked" lived nowhere but the
 * operator's memory (the desktop's seen-set was a React ref that died on
 * reload). This route makes the thread durable and BOUNDED:
 *
 *  - `GET /:targetKind/:targetId` returns a DIGEST in two halves under one
 *    list: the since-cursor DELTA (facts that appeared or changed since this
 *    principal last looked) plus the STANDING BLOCKERS the cursor may never
 *    hide — each task's CURRENT packet while nothing readable on that task
 *    vouches for it, every still-pending gate, every open blocking question. Rows
 *    carry `standing` and `newSinceLook` so a surface can render "new" apart
 *    from "still blocking". Coordinates and ids only, straight off the
 *    ledger; the digest never restates agent prose as evidence.
 *  - `POST /:targetKind/:targetId/advance` stamps the cursor at the moment
 *    the caller's digest was READ — the `digestAt` the GET handed back — not
 *    at the moment the button was pressed, or everything filed in the
 *    render→click window is consumed unseen. It is the surfaces' job to call
 *    it on a DECISION (or an explicit "mark read"), never on open — which is
 *    exactly what keeps a closed-without-deciding thread bound: the next open
 *    resumes the same digest.
 *
 * Authority: operator tier only, both verbs. The cursor is display state; it
 * grants nothing, and the digest is a narrower over reads the operator
 * already holds. `principal` is a column from day one (multi-principal is
 * cheap where it costs nothing) but this single-operator build always writes
 * the operator principal.
 */

const QUESTION_EVENT_KINDS = [
  QUESTION_BLOCKED_EVENT_KIND,
  QUESTION_ANSWERED_EVENT_KIND,
  QUESTION_WITHDRAWN_EVENT_KIND,
];

const TARGET_KINDS = ["task", "chat"] as const;

const paramsSchema = z.object({
  targetKind: z.enum(TARGET_KINDS),
  targetId: z.string().min(1).max(200),
});

/**
 * The advance body. `digestAt` is the GET's own `digestAt`, echoed back
 * unchanged — "this is the digest I was looking at when I pressed it".
 * Optional so a surface built before this field still advances (stamping NOW,
 * the old behaviour) instead of failing.
 */
const advanceBodySchema = z.object({
  digestAt: z.string().min(1).optional(),
});

const OPERATOR_PRINCIPAL_ID = "operator";
const DIGEST_ROW_BOUND = 50;

/**
 * How far back the digest looks for a task's newest DECLARED verdict when its
 * current wrap declared nothing at all. Bounded like every other read here, and
 * bounded in the safe direction: a task whose declaration falls outside this
 * window keeps its blocker (and `truncated` says the window was hit), so a cap
 * can make this surface louder, never quieter.
 */
const PRIOR_DECLARATION_SCAN_BOUND = 200;

/** The epoch cursor for a principal that never looked. */
const NEVER = new Date(0);

/**
 * What a wrap packet DECLARED about its own evidence, read structurally — never
 * a paraphrase of packet prose. FOUR facts, because two of them used to be one:
 *
 *  - `degraded`   — the packet SAYS its evidence is missing (`degraded.flag`).
 *  - `clean`      — the packet says it is not degraded.
 *  - `unreadable` — the packet CARRIES a `degraded` shape MUON cannot read
 *                   (`degraded: null`, a non-boolean flag). It tried to declare
 *                   and its declaration is unreadable.
 *  - `absent`     — there is no `degraded` object at all: a prose-only wrap, or
 *                   a legacy row with no packet JSON. NOTHING was declared,
 *                   which is a different fact from "the declaration is
 *                   unreadable" — and treating them as one is what let a
 *                   prose-only wrap re-block a task forever.
 *
 * Only the first two are ever reported as a verdict; the other two report
 * UNKNOWN. "Cannot tell" must never render as "fine", and a legacy packet must
 * never be branded a failure it never declared.
 */
type PacketDeclaration = "degraded" | "clean" | "unreadable" | "absent";

function declarationOf(packetJson: unknown): PacketDeclaration {
  if (
    typeof packetJson !== "object" ||
    packetJson === null ||
    Array.isArray(packetJson)
  ) {
    // Not a packet body at all (a legacy null row, a scalar, an array): it
    // declared nothing, rather than declaring something unreadable.
    return "absent";
  }
  const degradedShape = (packetJson as { degraded?: unknown }).degraded;
  if (degradedShape === undefined) return "absent";
  const flag =
    typeof degradedShape === "object" && degradedShape !== null
      ? (degradedShape as { flag?: unknown }).flag
      : undefined;
  return typeof flag === "boolean"
    ? flag
      ? "degraded"
      : "clean"
    : "unreadable";
}

/**
 * The wire value: true = declared degraded, false = declared clean, null = the
 * flag could not be read at all (unreadable shape, prose-only wrap, legacy
 * row) — UNVERIFIABLE, a third state that must never render as either of the
 * first two. Unchanged by the declaration split above, deliberately: what a
 * surface may CLAIM about a packet did not change, only what the cursor may
 * hold forever.
 */
function degradedOf(packetJson: unknown): boolean | null {
  const declaration = declarationOf(packetJson);
  if (declaration === "degraded") return true;
  if (declaration === "clean") return false;
  return null;
}

async function taskIdsForTarget(
  targetKind: (typeof TARGET_KINDS)[number],
  targetId: string
): Promise<{ ids: string[]; truncated: boolean }> {
  if (targetKind === "task") {
    return { ids: [targetId], truncated: false };
  }
  // Newest tasks first — a bounded scan must keep the rows the digest is
  // FOR (recent work), and it must SAY when it dropped any: a chat past the
  // bound silently omitting whole tasks while claiming completeness is the
  // lie-by-omission this surface exists to end.
  const tasks = await prisma.task.findMany({
    where: { chatId: targetId },
    select: { id: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return {
    ids: tasks.map((task) => task.id),
    truncated: tasks.length >= 200,
  };
}

export function registerReviewThreadRoutes(app: FastifyInstance) {
  app.get("/:targetKind/:targetId", async (request) => {
    requireOperator(app, request);
    const params = paramsSchema.parse(request.params);
    // Stamped BEFORE the reads, and handed back as `digestAt` so the advance
    // verb can stamp the cursor at the moment this digest was taken. Taking it
    // early is the safe rounding: a fact filed while these queries run is
    // shown again on the next open rather than consumed by a look that could
    // not have included it.
    const digestAt = new Date();
    const cursor = await prisma.reviewLookCursor.findUnique({
      where: {
        principal_targetKind_targetId: {
          principal: OPERATOR_PRINCIPAL_ID,
          targetKind: params.targetKind,
          targetId: params.targetId,
        },
      },
    });
    const since = cursor?.lastLookedAt ?? NEVER;
    const target = await taskIdsForTarget(params.targetKind, params.targetId);
    const taskIds = target.ids;
    if (taskIds.length === 0) {
      return {
        target: params,
        lastLookedAt: cursor?.lastLookedAt?.toISOString() ?? null,
        digestAt: digestAt.toISOString(),
        handoffs: [],
        approvals: [],
        openQuestionIds: [],
        truncated: false,
      };
    }

    const [deltaHandoffRows, recentHandoffRows, approvalRows, questionRows] =
      await Promise.all([
      prisma.handoff.findMany({
        where: { taskId: { in: taskIds }, createdAt: { gt: since } },
        orderBy: { createdAt: "desc" },
        take: DIGEST_ROW_BOUND,
        select: {
          id: true,
          taskId: true,
          status: true,
          createdAt: true,
          packetJson: true,
        },
      }),
      // STANDING half (founder-approved H1 correction): the cursor windows
      // only the INFORMATIONAL delta. A blocking fact — a task whose CURRENT
      // wrap does not vouch for itself — must never drop out of the digest
      // because the operator pressed "Mark reviewed"; marking a look is not a
      // repair. The degraded flag lives inside packetJson,
      // which SQL cannot filter, so the newest packet PER TASK is fetched
      // (`distinct` — a flat newest-50 scan across up to 200 tasks silently
      // missed whole tasks, desktop-track finding) and classified in JS.
      prisma.handoff.findMany({
        where: { taskId: { in: taskIds } },
        orderBy: { createdAt: "desc" },
        distinct: ["taskId"],
        take: 200,
        select: {
          id: true,
          taskId: true,
          status: true,
          createdAt: true,
          packetJson: true,
        },
      }),
      // An approval joins the digest when it APPEARED since the cursor, was
      // DECIDED since it (a decision on an old gate is new information), or
      // is STILL PENDING — an undecided gate is a standing fact the cursor
      // must never hide; "Mark reviewed" is not a decision.
      prisma.approvalRequest.findMany({
        where: {
          taskId: { in: taskIds },
          OR: [
            { createdAt: { gt: since } },
            { decidedAt: { gt: since } },
            { status: "pending" },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: DIGEST_ROW_BOUND,
        select: {
          id: true,
          taskId: true,
          kind: true,
          status: true,
          gateTag: true,
          createdAt: true,
          decidedAt: true,
          reviewCertification: true,
        },
      }),
      prisma.event.findMany({
        where: {
          kind: { in: QUESTION_EVENT_KINDS },
          taskId: { in: taskIds },
        },
        // The NEWEST window, then restored to fold order. Keeping the oldest
        // window meant a question asked after event 2048 was invisible and
        // one answered after it read as still open — the wrong rows to drop
        // in a "what changed since you looked" surface. Folding a suffix can
        // still under-report a question whose ask fell out of the window;
        // `truncated` says so.
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        take: 2048,
      }).then((rows) => rows.reverse()),
    ]);

    const byTask = new Map<string, QuestionSpineEvent[]>();
    for (const row of questionRows) {
      if (!row.taskId) continue;
      const spine = byTask.get(row.taskId) ?? [];
      spine.push({
        kind: row.kind,
        taskId: row.taskId,
        timestamp: row.timestamp.toISOString(),
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        principalKind: row.principalKind ?? null,
      });
      byTask.set(row.taskId, spine);
    }
    const openQuestionIds = [...byTask.values()]
      .flatMap((spine) =>
        deriveBlockingQuestions(spine).filter(
          (question) => question.status === "open"
        )
      )
      .map((question) => question.id);

    // A task whose CURRENT wrap declared NOTHING needs one more bounded read
    // before the cursor can be told what to hold: the newest wrap on that task
    // that actually declared something. Only those tasks are scanned, so the
    // ordinary path pays for no extra query at all. SQL cannot filter inside
    // packetJson, so this is a flat newest-N scan folded per task in JS — and a
    // task the window misses keeps its blocker, which is the safe direction.
    const undeclaredTaskIds = recentHandoffRows
      .filter((row) => declarationOf(row.packetJson) === "absent")
      .map((row) => row.taskId);
    const priorRows =
      undeclaredTaskIds.length === 0
        ? []
        : await prisma.handoff.findMany({
            where: { taskId: { in: undeclaredTaskIds } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: PRIOR_DECLARATION_SCAN_BOUND,
            select: { taskId: true, packetJson: true },
          });
    const priorDeclaration = new Map<string, PacketDeclaration>();
    for (const row of priorRows) {
      if (priorDeclaration.has(row.taskId)) continue;
      const declaration = declarationOf(row.packetJson);
      // Walk PAST every wrap that declared nothing (the current one included):
      // what settles this task is its newest actual DECLARATION. An unreadable
      // declaration in between is not superseded by later prose — only a
      // readable clean packet supersedes it.
      if (declaration === "absent") continue;
      priorDeclaration.set(row.taskId, declaration);
    }

    // The digest's handoff half = the since-window delta UNION each task's
    // CURRENT (newest) packet whenever nothing readable on that task vouches
    // for it. The union is what keeps "Mark reviewed" honest: the cursor clears
    // the informational delta and cannot clear a standing blocker.
    //
    // THREE facts, not two, because the older `degraded !== false` test held a
    // packet that declared nothing and a packet whose declaration is unreadable
    // identically — and only one of those has a clearing act:
    //
    //  * DECLARED DEGRADED → standing. The packet itself says its evidence is
    //    missing.
    //  * DECLARATION UNREADABLE → standing, identically (`degraded: null`, a
    //    non-boolean flag). Letting it ride the delta once was the older,
    //    narrower rule, and it was a lie by two surfaces at once: the cursor
    //    retired the row while the strip still counted it as blocking. "Cannot
    //    tell" is not "fine", and an operator's look is not the missing
    //    evidence.
    //  * DECLARED NOTHING (a prose-only wrap, a legacy row) → standing only
    //    while that task has no readable CLEAN declaration to stand on. Held
    //    unconditionally, this was a blocker with NO act that could ever clear
    //    it: a prose-only wrap filed after a task already read clean re-blocked
    //    that task permanently, and a repair could not help because the newest
    //    packet was not the one being doubted. A blocker nothing can clear is
    //    noise, and noise is what makes an operator stop reading the strip.
    //
    // THE CLEARING ACTS, and there are exactly two: a LATER packet on the same
    // task whose flag reads clean supersedes a degraded or unreadable one (the
    // `distinct` above always holds the newest per task, so a repair packet
    // does this by existing); and for a wrap that declared nothing, that task's
    // newest EARLIER declaration reading clean is what settles it. Task status
    // is deliberately NOT one — a `done` task's unrepaired packet still stands,
    // because finishing is not evidencing. A done task's CLEAN wrap is history
    // exactly like anyone else's: it rides the delta and retires with it.
    const isStanding = (row: {
      taskId: string;
      packetJson: unknown;
    }): boolean => {
      const declaration = declarationOf(row.packetJson);
      if (declaration === "clean") return false;
      if (declaration === "absent") {
        return priorDeclaration.get(row.taskId) !== "clean";
      }
      return true;
    };
    const standingIds = new Set(
      recentHandoffRows.filter(isStanding).map((row) => row.id)
    );
    const handoffById = new Map<string, (typeof recentHandoffRows)[number]>();
    for (const row of [
      ...deltaHandoffRows,
      ...recentHandoffRows.filter((row) => standingIds.has(row.id)),
    ]) {
      if (!handoffById.has(row.id)) handoffById.set(row.id, row);
    }
    const handoffRows = [...handoffById.values()].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime()
    );

    return {
      target: params,
      lastLookedAt: cursor?.lastLookedAt?.toISOString() ?? null,
      digestAt: digestAt.toISOString(),
      handoffs: handoffRows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        // true = declared degraded, false = declared clean, null = the flag
        // could not be read at all (legacy/prose-only row) — UNVERIFIABLE, a
        // third state that must never render as either of the first two.
        degraded: degradedOf(row.packetJson),
        // True = this row rides the digest cursor-independently: it is the
        // task's current packet and nothing readable on that task vouches for
        // it. The ONE classification, computed here, so no surface has to
        // re-derive it and drift (the strip did, and counted rows the cursor
        // retired).
        standing: standingIds.has(row.id),
        // Orthogonal to `standing`: a row can be both (a degraded wrap filed
        // since the last look) or neither is impossible — a row with neither
        // would not be in this list at all. False + standing = the blocker the
        // operator has already seen and still has to act on.
        newSinceLook: row.createdAt > since,
      })),
      approvals: approvalRows.map((row) => {
        const certification = row.reviewCertification as {
          artifactDigest?: unknown;
        } | null;
        return {
          id: row.id,
          taskId: row.taskId,
          kind: row.kind,
          status: row.status,
          gateTag: row.gateTag,
          createdAt: row.createdAt.toISOString(),
          decidedAt: row.decidedAt?.toISOString() ?? null,
          reviewDigest:
            typeof certification?.artifactDigest === "string"
              ? certification.artifactDigest
              : null,
          // False = still pending from before the cursor: a standing gate
          // riding the digest as a blocker, not as news.
          newSinceLook:
            row.createdAt > since ||
            (row.decidedAt != null && row.decidedAt > since),
        };
      }),
      openQuestionIds,
      truncated:
        target.truncated ||
        deltaHandoffRows.length >= DIGEST_ROW_BOUND ||
        recentHandoffRows.length >= 200 ||
        priorRows.length >= PRIOR_DECLARATION_SCAN_BOUND ||
        approvalRows.length >= DIGEST_ROW_BOUND ||
        questionRows.length >= 2048,
    };
  });

  app.post("/:targetKind/:targetId/advance", async (request) => {
    requireOperator(app, request);
    const params = paramsSchema.parse(request.params);
    const body = advanceBodySchema.parse(request.body ?? {});
    const now = new Date();
    // The cursor stamps the READ, not the CLICK. Stamping `now` consumed the
    // whole render→click window: a packet filed while the operator was
    // reading the strip was marked seen by an acknowledge of a digest that
    // never contained it. So the caller echoes the `digestAt` it rendered
    // from and that is what lands.
    let stampedAt = now;
    if (body.digestAt !== undefined) {
      const rendered = new Date(body.digestAt);
      if (Number.isNaN(rendered.getTime())) {
        throw app.httpErrors.badRequest(
          "digestAt must be the ISO timestamp this thread's GET returned; a cursor stamped from an unreadable time would consume a window nobody can prove was seen."
        );
      }
      // Never FORWARD of the server's own clock: a skewed client or a forged
      // body must not retire facts the operator could not have seen.
      stampedAt = rendered < now ? rendered : now;
    }
    // …and never BACKWARD of where the cursor already is. A stale strip
    // acknowledging an old digest must not un-consume a delta some later act
    // (a merge decision) legitimately consumed. Standing blockers are
    // cursor-independent, so this can hide nothing that still blocks.
    const existing = await prisma.reviewLookCursor.findUnique({
      where: {
        principal_targetKind_targetId: {
          principal: OPERATOR_PRINCIPAL_ID,
          targetKind: params.targetKind,
          targetId: params.targetId,
        },
      },
      select: { lastLookedAt: true },
    });
    if (existing && existing.lastLookedAt > stampedAt) {
      stampedAt = existing.lastLookedAt;
    }
    const cursor = await prisma.reviewLookCursor.upsert({
      where: {
        principal_targetKind_targetId: {
          principal: OPERATOR_PRINCIPAL_ID,
          targetKind: params.targetKind,
          targetId: params.targetId,
        },
      },
      create: {
        principal: OPERATOR_PRINCIPAL_ID,
        targetKind: params.targetKind,
        targetId: params.targetId,
        lastLookedAt: stampedAt,
      },
      update: { lastLookedAt: stampedAt },
    });
    return {
      target: params,
      lastLookedAt: cursor.lastLookedAt.toISOString(),
    };
  });
}
