-- ADR-0091: the `ownership` memory kind's structured half. `owners` holds a
-- JSON string[] of principal strings — orientation ("whom to ask"), never
-- authority (0091 D2: naming an owner routes nothing, widens nothing).
-- NULL on every other kind and on prose-only ownership notes; the SURFACE
-- half of D1 is the note's existing module/symbol anchors, deliberately not
-- a new column.
ALTER TABLE "MemoryNote" ADD COLUMN "owners" JSONB;
