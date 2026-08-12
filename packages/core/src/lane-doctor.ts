import { createDefaultAdapters } from "@muon/adapters";
import type { LaneAdapter, LaneCapabilities, LaneHealth } from "@muon/protocol";

export type LaneIdentity = {
  id: string;
  key: string;
  name: string;
  role: string;
  status: string;
};

export type LaneDoctorRecord = {
  lane: LaneIdentity;
  adapterId?: string;
  adapterFound: boolean;
  health?: LaneHealth;
  capabilities?: LaneCapabilities;
};

export type LaneDoctorReport = {
  generatedAt: string;
  summary: {
    totalLanes: number;
    adaptersFound: number;
    healthyAdapters: number;
    unavailableAdapters: number;
  };
  records: LaneDoctorRecord[];
};

export async function runLaneDoctor(
  lanes: LaneIdentity[],
  adapters: LaneAdapter[] = createDefaultAdapters()
): Promise<LaneDoctorReport> {
  const records = await Promise.all(
    lanes.map(async (lane) => {
      const adapter = adapters.find((entry) => entry.id === lane.key);
      if (!adapter) {
        return {
          lane,
          adapterFound: false,
        } satisfies LaneDoctorRecord;
      }

      const [health, capabilities] = await Promise.all([
        adapter.health(),
        adapter.capabilities(),
      ]);

      return {
        lane,
        adapterId: adapter.id,
        adapterFound: true,
        health,
        capabilities,
      } satisfies LaneDoctorRecord;
    })
  );

  const summary = records.reduce(
    (acc, record) => {
      if (record.adapterFound) {
        acc.adaptersFound += 1;
      }
      if (record.health?.status === "healthy") {
        acc.healthyAdapters += 1;
      }
      if (record.health?.status === "unavailable") {
        acc.unavailableAdapters += 1;
      }
      return acc;
    },
    {
      totalLanes: lanes.length,
      adaptersFound: 0,
      healthyAdapters: 0,
      unavailableAdapters: 0,
    }
  );

  return {
    generatedAt: new Date().toISOString(),
    summary,
    records,
  };
}
