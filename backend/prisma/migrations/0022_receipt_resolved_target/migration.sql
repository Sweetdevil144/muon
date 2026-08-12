-- SEC-1 fix: bind receipt enforcement to the OPERATOR-VISIBLE resolved target
-- (the edit/read file path or the test command line the human saw on the card),
-- not only the agent-authored payload digest. An approval whose visible evidence
-- disagrees with its digest now mints a receipt that can never redeem — the
-- target binding and the digest binding become mutually unsatisfiable, so the
-- hidden action always re-gates. Additive nullable column; existing rows keep
-- NULL and a NULL-target redeem still matches a NULL-target receipt.
ALTER TABLE "ApprovalReceipt" ADD COLUMN "resolvedTarget" TEXT;
