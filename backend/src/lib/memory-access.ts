import { randomUUID } from "node:crypto";
import {
  MEMORY_ACCESS_ANALYTICS_MAX_ROWS,
  MEMORY_ACCESS_HISTORY_PER_NOTE,
  MEMORY_ACCESS_TYPES,
  type MemoryAccessAnalytics,
  type MemoryAccessType,
} from "@muon/protocol";
import { prisma } from "./db.js";
import { isHumanPrincipal } from "./auth.js";

const SQLITE_BIND_SAFE_CHUNK = 400;

export type MemoryAccessContext = {
  principal: string;
  taskId?: string;
  jobId?: string;
  missionId?: string;
};

/**
 * Durably append one typed exposure per distinct note. Insert and per-note
 * pruning share one database transaction, so every successful call
 * leaves at most 128 newest rows per note. Callers record this BEFORE incrementing
 * the soft ranking counter so an unlogged use can never boost rank.
 */
export async function appendMemoryAccesses(
  noteIds: string[],
  accessType: MemoryAccessType,
  context: MemoryAccessContext,
  accessedAt = new Date()
): Promise<number> {
  const unique = [...new Set(noteIds)];
  if (unique.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    const notes = await tx.memoryNote.findMany({
      where: { id: { in: unique } },
      select: { id: true, workspacePath: true },
    });
    const workspaceByNote = new Map(
      notes.map((note) => [note.id, note.workspacePath] as const)
    );
    const existing = unique.filter((noteId) => workspaceByNote.has(noteId));
    if (existing.length === 0) return 0;
    const result = await tx.memoryAccess.createMany({
      data: existing.map((noteId) => ({
        id: randomUUID(),
        noteId,
        accessType,
        principal: context.principal,
        taskId: context.taskId ?? null,
        jobId: context.jobId ?? null,
        missionId: context.missionId ?? null,
        // The note is the authority for its partition; a caller claim can never
        // relabel the access into another workspace.
        workspacePath: workspaceByNote.get(noteId) ?? null,
        accessedAt,
      })),
    });
    for (const noteId of existing) {
      const overflow = await tx.memoryAccess.findMany({
        where: { noteId },
        orderBy: [{ accessedAt: "desc" }, { id: "desc" }],
        skip: MEMORY_ACCESS_HISTORY_PER_NOTE,
        select: { id: true },
      });
      if (overflow.length > 0) {
        await tx.memoryAccess.deleteMany({
          where: { id: { in: overflow.map((row) => row.id) } },
        });
      }
    }
    return result.count;
  });
}

export type MemoryAccessAnalyticsOptions = {
  workspacePath?: string;
  unscopedWorkspace?: boolean;
  limit?: number;
};

/**
 * Associate the earliest retained access of each (note,type) cohort with a
 * LATER human confirmation. Notes already human-confirmed at access are excluded.
 * This is intentionally descriptive evidence, never a causal score or rank arm.
 */
export async function getMemoryAccessAnalytics(
  options: MemoryAccessAnalyticsOptions = {}
): Promise<MemoryAccessAnalytics> {
  const limit = Math.max(
    1,
    Math.min(
      options.limit ?? MEMORY_ACCESS_ANALYTICS_MAX_ROWS,
      MEMORY_ACCESS_ANALYTICS_MAX_ROWS
    )
  );
  const where = options.unscopedWorkspace
    ? { workspacePath: null }
    : options.workspacePath
      ? { workspacePath: options.workspacePath }
      : {};
  const newest = await prisma.memoryAccess.findMany({
    where,
    orderBy: [{ accessedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const truncated = newest.length > limit;
  const rows = newest.slice(0, limit).reverse();
  if (rows.length === 0) return { ...emptyAnalytics(), truncated };

  const noteIds = [...new Set(rows.map((row) => row.noteId))];
  const confirmations: {
    noteId: string;
    principal: string;
    decision: string;
    at: Date;
  }[] = [];
  for (
    let offset = 0;
    offset < noteIds.length;
    offset += SQLITE_BIND_SAFE_CHUNK
  ) {
    confirmations.push(
      ...(await prisma.confirmation.findMany({
        where: {
          noteId: {
            in: noteIds.slice(offset, offset + SQLITE_BIND_SAFE_CHUNK),
          },
        },
        orderBy: [{ at: "asc" }, { id: "asc" }],
        select: { noteId: true, principal: true, decision: true, at: true },
      }))
    );
  }
  const humanByNote = new Map<
    string,
    { decision: string; at: Date }[]
  >();
  for (const decision of confirmations) {
    if (!isHumanPrincipal(decision.principal)) continue;
    if (decision.decision !== "confirm" && decision.decision !== "reject") {
      continue;
    }
    const list = humanByNote.get(decision.noteId) ?? [];
    list.push({ decision: decision.decision, at: decision.at });
    humanByNote.set(decision.noteId, list);
  }

  const earliest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!(MEMORY_ACCESS_TYPES as readonly string[]).includes(row.accessType)) {
      continue;
    }
    const key = `${row.accessType}\0${row.noteId}`;
    if (!earliest.has(key)) earliest.set(key, row);
  }

  const counts = new Map<MemoryAccessType, { exposed: number; confirmed: number }>();
  for (const row of earliest.values()) {
    const decisions = humanByNote.get(row.noteId) ?? [];
    let confirmedAtAccess = false;
    let laterConfirm = false;
    for (const decision of decisions) {
      if (decision.at.getTime() <= row.accessedAt.getTime()) {
        confirmedAtAccess = decision.decision === "confirm";
      } else if (decision.decision === "confirm") {
        laterConfirm = true;
      }
    }
    if (confirmedAtAccess) continue;
    const type = row.accessType as MemoryAccessType;
    const count = counts.get(type) ?? { exposed: 0, confirmed: 0 };
    count.exposed += 1;
    if (laterConfirm) count.confirmed += 1;
    counts.set(type, count);
  }

  return {
    rowsScanned: rows.length,
    distinctNotes: noteIds.length,
    retainedPerNote: MEMORY_ACCESS_HISTORY_PER_NOTE,
    truncated,
    firstAccessAt: rows[0]?.accessedAt.toISOString() ?? null,
    lastAccessAt: rows.at(-1)?.accessedAt.toISOString() ?? null,
    byType: MEMORY_ACCESS_TYPES.map((accessType) => {
      const count = counts.get(accessType) ?? { exposed: 0, confirmed: 0 };
      return {
        accessType,
        accessedUnconfirmedNotes: count.exposed,
        laterHumanConfirmedNotes: count.confirmed,
        confirmationRate:
          count.exposed === 0 ? null : count.confirmed / count.exposed,
      };
    }),
    interpretation: "association_not_causation",
  };
}

function emptyAnalytics(): MemoryAccessAnalytics {
  return {
    rowsScanned: 0,
    distinctNotes: 0,
    retainedPerNote: MEMORY_ACCESS_HISTORY_PER_NOTE,
    truncated: false,
    firstAccessAt: null,
    lastAccessAt: null,
    byType: MEMORY_ACCESS_TYPES.map((accessType) => ({
      accessType,
      accessedUnconfirmedNotes: 0,
      laterHumanConfirmedNotes: 0,
      confirmationRate: null,
    })),
    interpretation: "association_not_causation",
  };
}
