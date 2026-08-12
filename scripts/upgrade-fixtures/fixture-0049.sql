-- Upgrade-safety fixture, valid at migration 0049_memory_access_log.
--
-- These rows simulate a REAL install's ledger as an older build left it:
-- a mission chat, a task bound to it, a filed approval, and a memory note.
-- scripts/upgrade-safety.sh applies migrations 0001..0049 to an empty SQLite
-- file, inserts these rows, then boots the CURRENT backend so ensureSchema
-- applies every later migration — the exact code path a user's upgrade runs.
-- Every id below must remain reachable afterwards; a migration that drops,
-- renames, or orphans one of them is the one class of bug a user cannot
-- recover from and cannot roll back.
--
-- If a later migration legitimately breaks this fixture's INSERTs, re-pin:
-- update PINNED_MIGRATION in upgrade-safety.sh, regenerate this file against
-- the new pin, and say so in the commit message — silently deleting rows here
-- deletes the proof.

INSERT INTO "Lane" ("id","key","name","provider","role","status","updatedAt") VALUES
  ('lane-upgrade-1','upgrade-fixture-lane','Upgrade Fixture Lane','claude','builder','available','2026-08-01T00:00:00.000Z');

INSERT INTO "OrchestratorChat" ("id","title","workspacePath","status","updatedAt") VALUES
  ('chat-upgrade-1','Upgrade-safety fixture mission','/tmp/upgrade-fixture-project','active','2026-08-01T00:00:00.000Z');

INSERT INTO "Task" ("id","title","description","status","priority","workspacePath","chatId","updatedAt") VALUES
  ('task-upgrade-1','Upgrade-safety fixture task','Seeded at migration 0049 to prove an upgrade preserves ledger records.','in_progress','high','/tmp/upgrade-fixture-project','chat-upgrade-1','2026-08-01T00:00:00.000Z');

INSERT INTO "ApprovalRequest" ("id","taskId","requestedBy","kind","reason","status","updatedAt") VALUES
  ('approval-upgrade-1','task-upgrade-1','codex','command','Upgrade-safety fixture gate; the RECORD must survive, whatever its status.','pending','2026-08-01T00:00:00.000Z');

INSERT INTO "MemoryNote" ("id","kind","text","textHash","createdBy","modules","topics","symbols","workspacePath","updatedAt") VALUES
  ('mem-upgrade-1','constraint','Upgrade-safety fixture note: this text must survive every future migration.','upgrade-fixture-texthash-1','human','["src/fixture.ts"]','["upgrade-safety"]','[]','/tmp/upgrade-fixture-project','2026-08-01T00:00:00.000Z');
