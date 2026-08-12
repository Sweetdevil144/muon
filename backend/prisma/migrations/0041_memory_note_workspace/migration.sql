-- ADR-0026 §11 step 1: a memory note belongs to exactly ONE workspace.
--
-- `MemoryNote` was the only durable retrievable entity with no workspace column
-- (Task, WorkflowRun, OrchestratorChat, DispatchJob, WorkspacePolicyProfile,
-- ApprovalReceipt and MemoryImport all carry one), and it is the one whose
-- anchors are workspace-RELATIVE paths — so `recallMemory({module:"src/index.ts"})`
-- could not tell repo A's `src/index.ts` from repo B's.
--
-- This migration is step 1 of 5 and changes NO read behaviour: nothing reads the
-- column yet. It does NOT make the column NOT NULL, does NOT delete or retire a
-- note, does NOT rewrite `scope`, and does NOT touch `Confirmation`.
-- Retire-never-delete holds throughout.
--
-- ── The one non-additive step, guarded first (§7) ────────────────────────────
--
-- A pack is per-(origin workspace, RECEIVING workspace): re-importing the same
-- pack into a second workspace must produce a second set of local proposals, so
-- `(originWorkspace, recordHash)` has to widen. ADR-0026 §11 calls that the one
-- non-additive step and says to refuse it automatically on a populated table.
--
-- THAT REFUSAL IS DELIBERATELY NOT IMPLEMENTED, and the ADR's caution is
-- superseded by the reason stated at step 5 below: because `receivingWorkspace`
-- lands `NOT NULL DEFAULT ''`, every pre-existing row widens to
-- `(originWorkspace, '', recordHash)`, which is EXACTLY as restrictive as
-- today's `(originWorkspace, recordHash)`. No existing pair can collide under
-- the new key, and no previously-distinct pair can fuse. The widening is
-- therefore safe on a populated table, so there is nothing for an operator to
-- adjudicate.
--
-- A guard was written first, as a CHECK constraint that aborts on a non-empty
-- table. It was removed because `ensureSchema` runs the whole migration in ONE
-- transaction: the abort took the *additive* column down with it, so an install
-- that had ever imported a pack could not boot at all. Refusing a safe act, at
-- the cost of bricking startup, is worse than doing it. Recorded here rather
-- than silently, because it departs from a written ADR step.

-- 1. The partition column: nullable TEXT, no default, the additive
--    `0037_memory_note_ttl` shape. NULL means "unassigned", which §8 defines as
--    visible to operator-tier reads only (never to an agent, never to a pack
--    export) — so the residue fails CLOSED for every automated consumer.
ALTER TABLE "MemoryNote" ADD COLUMN "workspacePath" TEXT;

-- 2. The partition index, plus the composite every agent read will use: the
--    workspace fence and the chat fence are ANDed in the same candidate query,
--    so `(workspacePath, chatId)` is the access path, not two separate probes.
CREATE INDEX "MemoryNote_workspacePath_idx" ON "MemoryNote"("workspacePath");
CREATE INDEX "MemoryNote_workspacePath_chatId_idx" ON "MemoryNote"("workspacePath", "chatId");

-- 3. The backfill (§8), DOUBLY-WITNESSED and agreement-only.
--
--    Witness A (primary): `MemoryNote.taskId → Task.workspacePath`.
--    Witness B (corroborating): `MemoryNote.chatId → OrchestratorChat.workspacePath`.
--
--    A row is written when both witnesses agree, or when exactly one resolves.
--    A row where the two DISAGREE is left NULL on purpose: a disagreement is a
--    fact about the brain, and silently preferring one witness would resolve it
--    by fiat. The residue is then adjudicated by the operator-only, dry-run-by-
--    default `POST /api/memory/backfill-workspace` (§11), which reports exactly
--    the three counts this statement produces: written / no witness / disagreed.
--
--    The subqueries are repeated per clause rather than lifted into a CTE for
--    the same reason `0028_task_chat_scope` and `0032_one_active_root_per_chat`
--    repeat theirs: the embedded migrator executes statements individually.
--
--    `WHERE "workspacePath" IS NULL` makes the statement idempotent, so a re-run
--    can only ever fill a gap and can never overwrite an assigned partition.
UPDATE "MemoryNote"
SET "workspacePath" = COALESCE(
      (SELECT "Task"."workspacePath" FROM "Task"
        WHERE "Task"."id" = "MemoryNote"."taskId"
          AND "Task"."workspacePath" IS NOT NULL),
      (SELECT "OrchestratorChat"."workspacePath" FROM "OrchestratorChat"
        WHERE "OrchestratorChat"."id" = "MemoryNote"."chatId"
          AND "OrchestratorChat"."workspacePath" IS NOT NULL)
    )
WHERE "MemoryNote"."workspacePath" IS NULL
  AND COALESCE(
      (SELECT "Task"."workspacePath" FROM "Task"
        WHERE "Task"."id" = "MemoryNote"."taskId"
          AND "Task"."workspacePath" IS NOT NULL),
      (SELECT "OrchestratorChat"."workspacePath" FROM "OrchestratorChat"
        WHERE "OrchestratorChat"."id" = "MemoryNote"."chatId"
          AND "OrchestratorChat"."workspacePath" IS NOT NULL)
    ) IS NOT NULL
  AND (
    (SELECT "Task"."workspacePath" FROM "Task"
      WHERE "Task"."id" = "MemoryNote"."taskId"
        AND "Task"."workspacePath" IS NOT NULL) IS NULL
    OR (SELECT "OrchestratorChat"."workspacePath" FROM "OrchestratorChat"
      WHERE "OrchestratorChat"."id" = "MemoryNote"."chatId"
        AND "OrchestratorChat"."workspacePath" IS NOT NULL) IS NULL
    OR (SELECT "Task"."workspacePath" FROM "Task"
      WHERE "Task"."id" = "MemoryNote"."taskId"
        AND "Task"."workspacePath" IS NOT NULL)
      = (SELECT "OrchestratorChat"."workspacePath" FROM "OrchestratorChat"
        WHERE "OrchestratorChat"."id" = "MemoryNote"."chatId"
          AND "OrchestratorChat"."workspacePath" IS NOT NULL)
  );

-- 4. The `kind:"workspace"` anchor row for every backfilled note, so the ingest
--    candidate lookup is partitioned from the FIRST write after this migration
--    rather than from the first write that happens to re-anchor an old note.
--    `MemoryAnchor.id` is a Prisma-side cuid with no DB default, so raw SQL has
--    to mint one: a DERIVED id (`0041-ws-<noteId>`) plus `INSERT OR IGNORE`
--    against `MemoryAnchor_noteId_kind_value_key` makes the statement idempotent
--    on both keys.
INSERT OR IGNORE INTO "MemoryAnchor" ("id", "noteId", "kind", "value")
SELECT '0041-ws-' || "MemoryNote"."id", "MemoryNote"."id", 'workspace', "MemoryNote"."workspacePath"
FROM "MemoryNote"
WHERE "MemoryNote"."workspacePath" IS NOT NULL;

-- 5. `MemoryImport`'s unique key widens to include the receiving workspace (§7).
--    Safe on a populated table for the reason given at the top of this file, and
--    that reason is exactly the `DEFAULT ''` below.
--
--    `receivingWorkspace` lands NOT NULL DEFAULT '' rather than nullable ON
--    PURPOSE. In SQLite every NULL is distinct inside a UNIQUE index, so a
--    nullable column would silently DISABLE the idempotence key that
--    `importMemoryPack` relies on (it claims the row first and treats P2002 as
--    "already imported"). With '' the widened key is byte-for-byte today's
--    semantics until step 5 of the rollout stamps a real receiving workspace.
ALTER TABLE "MemoryImport" ADD COLUMN "receivingWorkspace" TEXT NOT NULL DEFAULT '';
DROP INDEX "MemoryImport_originWorkspace_recordHash_key";
CREATE UNIQUE INDEX "MemoryImport_originWorkspace_receivingWorkspace_recordHash_key"
    ON "MemoryImport"("originWorkspace", "receivingWorkspace", "recordHash");
