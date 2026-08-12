-- #126 per-chat memory partitioning. ONE additive, nullable column + its index;
-- nothing existing changes and there is NO data migration. A pre-existing note
-- keeps chatId = NULL (legacy / non-chat / team-synced), which a chat-scoped
-- AGENT read (chatId = <chat>) never matches — so ordinary project memory is
-- chat-private, and NULL/global memory surfaces only via the explicit
-- `scope:"global"` opt-in. Operator-tier reads stay global (no chatId filter).
-- Purely additive: the filter can only REMOVE rows from a read, never admit one,
-- so the confirmed-only hero gate stays fail-closed. See ADR-0009 §Chat scope.
ALTER TABLE "MemoryNote" ADD COLUMN "chatId" TEXT;
CREATE INDEX "MemoryNote_chatId_idx" ON "MemoryNote"("chatId");
