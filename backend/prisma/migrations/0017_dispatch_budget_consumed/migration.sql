-- Budget release accounting: `delegationBudgetReservedMs` was increment-only,
-- so the first default child reserved the whole root pool and every sibling
-- 409'd. This column records a child's ACTUAL wall-clock spend; on the child's
-- first terminal transition the route decrements the reserved counter (guarded,
-- never negative) and increments this one. `remaining = maxWallMs − reserved −
-- consumed` returns unused budget to the pool without ever raising the cap.
-- Additive + non-null default so every legacy row reads 0.
ALTER TABLE "DispatchJob" ADD COLUMN "delegationBudgetConsumedMs" INTEGER NOT NULL DEFAULT 0;
