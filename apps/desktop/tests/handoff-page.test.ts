import { describe, expect, it } from "vitest";
import {
  HANDOFF_PAGE_LIMIT,
  projectHandoffPage,
  type HandoffRow,
} from "../src/lib/handoff-page.js";

/**
 * The bound is where the desk decides what a human is allowed to see of a
 * session's wrap. Both properties here are ones a slice inside an IPC handler
 * got wrong silently.
 */
function row(overrides: Partial<HandoffRow> = {}): HandoffRow {
  return {
    id: "h",
    packetTitle: "title",
    packetBody: "body",
    packetJson: null,
    status: "delivered",
    createdAt: "2026-08-11T00:00:00.000Z",
    fromLane: { key: "codex" },
    toLane: { key: "claude-code" },
    ...overrides,
  };
}

/** The route returns handoffs OLDEST-FIRST; fixtures follow it. */
function ascending(count: number): HandoffRow[] {
  return Array.from({ length: count }, (_unused, index) =>
    row({ id: `h-${index}`, packetTitle: `handoff ${index}` })
  );
}

describe("projectHandoffPage", () => {
  it("keeps the NEWEST rows when the bound bites, not the oldest", () => {
    const page = projectHandoffPage(ascending(25));
    expect(page.items).toHaveLength(HANDOFF_PAGE_LIMIT);
    // The wrap the human just watched is `handoff 24`. Keeping the first 20
    // hid it and then labelled it "older, not shown" — the exact inversion.
    expect(page.items[0]?.packetTitle).toBe("handoff 24");
    expect(page.items.map((item) => item.packetTitle)).not.toContain(
      "handoff 0"
    );
  });

  it("presents newest first, so the latest wrap leads", () => {
    const page = projectHandoffPage(ascending(3));
    expect(page.items.map((item) => item.packetTitle)).toEqual([
      "handoff 2",
      "handoff 1",
      "handoff 0",
    ]);
  });

  it("reports the omission on the ENVELOPE, not on a row", () => {
    const page = projectHandoffPage(ascending(25));
    expect(page.omitted).toBe(5);
    // Nothing may depend on which row landed last.
    for (const item of page.items) {
      expect(item).not.toHaveProperty("omitted");
    }
  });

  it("omits nothing when the task fits, and says so with a zero", () => {
    expect(projectHandoffPage(ascending(2)).omitted).toBe(0);
    expect(projectHandoffPage([]).items).toEqual([]);
  });

  it("classifies an unreadable packet rather than throwing or calling it absent", () => {
    const page = projectHandoffPage([row({ packetJson: { nope: true } })]);
    expect(page.items[0]?.contract).toBe("packet_parse_failed");
    expect(page.items[0]?.contract).not.toBe("prose_only");
  });

  it("keeps the check outcome vocabulary and caps changed files", () => {
    const page = projectHandoffPage([
      row({
        packetJson: {
          taskGoal: "cap the retries",
          whatChanged: "charge() caps at 30s",
          whatFailed: "nothing",
          nextLaneRequest: "review it",
          commandsRun: [],
          checksStatus: [],
          openQuestions: [],
          provenance: { lane: "codex", createdAt: "2026-08-11T00:00:00.000Z" },
          changedFiles: Array.from({ length: 23 }, (_u, i) => `src/${i}.ts`),
          checks: [{ name: "tests", outcome: "skipped" }],
          diffVerified: false,
          degraded: { flag: true, reasons: ["no diff evidence"] },
        },
      }),
    ]);
    const item = page.items[0];
    expect(item?.checks).toEqual([{ name: "tests", outcome: "skipped" }]);
    expect(item?.changedFiles).toHaveLength(20);
    expect(item?.changedFilesOmitted).toBe(3);
    expect(item?.contract).toBe("typed_degraded");
  });
});
