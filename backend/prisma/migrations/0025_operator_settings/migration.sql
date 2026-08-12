-- #133 operator-tier server-side settings (key/value). Shape matches model
-- OperatorSetting in schema.prisma. HUMAN-owned posture flags read at request
-- time by privileged handlers; written ONLY via the operator-tier route
-- (requireOperator), never a request body or an agent-controlled env var. Purely
-- additive: a brand-new table, nothing existing changes and there is NO data
-- migration. Absent row = the handler's documented default (e.g.
-- autoConfirmAgentMemory defaults ON), so the crew-visible admission is on out of
-- the box with its per-chat blast radius hard-wired in code.
CREATE TABLE "OperatorSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
