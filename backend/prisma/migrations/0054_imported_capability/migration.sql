-- ADR-0038 slice 2 (D7/D8): a human's per-lane enable of ONE imported MCP
-- server, with the fingerprint their approval is bound to.
CREATE TABLE "ImportedCapability" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "laneId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "itemKind" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "enabledDigest" TEXT NOT NULL,
    "shape" JSONB NOT NULL,
    "secretsRefused" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'enabled',
    "driftDigest" TEXT,
    "driftReason" TEXT,
    "disabledAt" DATETIME,
    "enabledBy" TEXT NOT NULL,
    "enabledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- KEYED BY NAME, not by (vendor, name).
--
-- The store could model one row per vendor; the RUNTIME cannot. An MCP server
-- map is keyed by NAME, so a lane holds exactly one server called `linear`
-- however many vendors offer one — and a key that admitted two made the
-- enable-time collision check raceable and left the runtime to break the tie
-- by row order. A second lane that wants the same server needs its OWN enable,
-- with its own diff (ADR-0038 D6/D8).
CREATE UNIQUE INDEX "ImportedCapability_laneId_itemKind_itemName_key"
    ON "ImportedCapability"("laneId", "itemKind", "itemName");

CREATE INDEX "ImportedCapability_laneId_state_idx"
    ON "ImportedCapability"("laneId", "state");
