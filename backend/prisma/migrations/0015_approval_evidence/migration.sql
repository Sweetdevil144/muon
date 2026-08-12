-- Evidence-rich human review for session tools and other non-route approvals.
-- Optional for legacy rows; new command approvals fail closed without it.
ALTER TABLE "ApprovalRequest" ADD COLUMN "evidence" JSONB;
