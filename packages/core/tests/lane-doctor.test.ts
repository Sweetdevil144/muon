import { describe, expect, it } from "vitest";
import { runLaneDoctor } from "../src/lane-doctor.js";

describe("runLaneDoctor", () => {
  it("reports adapter mapping for backend lanes", async () => {
    const report = await runLaneDoctor([
      {
        id: "lane-1",
        key: "claude-code",
        name: "Claude Code",
        role: "peer",
        status: "available",
      },
      {
        id: "lane-2",
        key: "unknown-lane",
        name: "Unknown",
        role: "worker",
        status: "available",
      },
    ]);

    expect(report.summary.totalLanes).toBe(2);
    expect(report.summary.adaptersFound).toBe(1);
    expect(report.records[0]?.adapterFound).toBe(true);
    expect(report.records[1]?.adapterFound).toBe(false);
  });
});
