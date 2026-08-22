-- ADR-0063: the note's machine-readable impact claim — a blast-radius
-- assertion the grounding verb re-runs `impact` against (ADR-0058 D2 check 3,
-- made runnable). JSON in the @muon/protocol shape, validated at ingest;
-- NULL = no claim, and the third check stays honestly not-checkable.
ALTER TABLE "MemoryNote" ADD COLUMN "impactClaim" TEXT;
