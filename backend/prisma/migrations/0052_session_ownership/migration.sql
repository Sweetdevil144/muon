-- ADR-0030: session ownership for the governed-to-native round trip.
ALTER TABLE "LaneSession" ADD COLUMN "owner" TEXT NOT NULL DEFAULT 'muon';
ALTER TABLE "LaneSession" ADD COLUMN "ownerChangedAt" DATETIME;
