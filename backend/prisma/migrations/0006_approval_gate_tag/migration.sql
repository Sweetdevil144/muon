-- ADR-0010 Part B (route-level gate enforcement / F3-F4): bind a human gate to
-- the EXACT action+payload it authorizes via a structured column, so a route can
-- validate + single-use-consume it in ONE atomic `updateMany` with no LIKE
-- ambiguity. Additive + nullable, no backfill: only NEW `kind=="gate"` approvals
-- set it; every existing/other-kind approval keeps NULL. Postgres-compatible.
ALTER TABLE "ApprovalRequest" ADD COLUMN "gateTag" TEXT;
