-- ADR-0058: grounding stamps — evidence that a note's claims were checked
-- against the repository. Its own table (never Confirmation rows: "confirmed"
-- means human-confirmed everywhere).
CREATE TABLE "MemoryGrounding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "checks" TEXT NOT NULL,
    "groundedBy" TEXT NOT NULL,
    "proposalNoteId" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "MemoryGrounding_noteId_at_idx" ON "MemoryGrounding"("noteId", "at");
