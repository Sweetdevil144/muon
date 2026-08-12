-- Fleet-scaled descendant pool (S3): the root's aggregate descendant wall-clock
-- budget, DECOUPLED from its own turn timeout (`maxWallMs`). Before this, the
-- pool WAS `maxWallMs`, so the first default child reserved the whole 30-min turn
-- and sibling workers 409'd; a v2 chat root now sizes the pool to the fleet
-- (DELEGATION_MAX_DESCENDANTS × DEFAULT_CHILD_WALL_MS = 80 min). Nullable +
-- additive: every legacy/v1 row and non-root job reads NULL and falls back to
-- `maxWallMs`, so in-flight roots keep delegating with their prior semantics.
ALTER TABLE "DispatchJob" ADD COLUMN "maxDescendantWallMs" INTEGER;
