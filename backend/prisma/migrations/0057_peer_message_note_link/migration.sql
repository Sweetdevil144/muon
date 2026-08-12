-- 0057 — a peer message may announce ONE finding.
--
-- Nullable and additive: every existing message is talk, not a finding, and
-- stays exactly as it is. The link is validated server-side against the
-- SENDER's visibility, so it can never point a peer at a note that peer may
-- not read; the column only records the answer.
ALTER TABLE "PeerMessage" ADD COLUMN "memoryNoteId" TEXT;
CREATE INDEX "PeerMessage_memoryNoteId_idx" ON "PeerMessage"("memoryNoteId");
