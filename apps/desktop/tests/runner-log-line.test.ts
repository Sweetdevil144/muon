import { describe, expect, it } from "vitest";
import { createRunnerLineFormatter } from "../src/lib/runner-log-line.js";

function fixedClock(start = Date.UTC(2026, 6, 25, 12, 0, 0)) {
  let tick = 0;
  return () => new Date(start + tick++ * 1000);
}

describe("runner log line formatter", () => {
  it("stamps every line with an ISO timestamp and keeps the original text", () => {
    const format = createRunnerLineFormatter(fixedClock());
    expect(format("[runner] host=desktop-mac tier=agent sandbox=on")).toBe(
      "2026-07-25T12:00:00.000Z [runner] host=desktop-mac tier=agent sandbox=on"
    );
  });

  it("tags a job's lines with its short id and vendor learned from the start line", () => {
    const format = createRunnerLineFormatter(fixedClock());
    const start = format(
      "[runner] ▶ claude-code · session · job e83cde1d-b46d-4924-a803-999d895a452c · task cms0bjq06000j9koh64jjzsr7"
    );
    expect(start).toContain("job=e83cde1d vendor=claude-code");
    expect(start).toContain(
      "▶ claude-code · session · job e83cde1d-b46d-4924-a803-999d895a452c"
    );

    // An interior line carries only the short id — the vendor is remembered.
    expect(format("[runner]   e83cde1d: interrupt requested, aborting execution")).toBe(
      "2026-07-25T12:00:01.000Z [runner] job=e83cde1d vendor=claude-code ·   e83cde1d: interrupt requested, aborting execution"
    );
    expect(format("[runner] ■ job e83cde1d → done")).toContain(
      "job=e83cde1d vendor=claude-code · ■ job e83cde1d → done"
    );
  });

  it("still identifies the job when the runner never saw it start (reclaim)", () => {
    const format = createRunnerLineFormatter(fixedClock());
    expect(format("[runner] ✗ job 3b09571a not dispatched, vendor unavailable")).toContain(
      "job=3b09571a vendor=unknown ·"
    );
  });

  it("forgets a job once it goes terminal so the map stays bounded", () => {
    const format = createRunnerLineFormatter(fixedClock());
    format("[runner] ▶ codex · session · job cf5af6fa-564f-4e6f-85fd-713cc73d7c92 · task t1");
    format("[runner] ■ job cf5af6fa → interrupted");
    // A later, unrelated line mentioning that id no longer resolves a vendor
    // from the map (it falls back to the shape rule, vendor unknown).
    expect(format("[runner] claim for cf5af6fa failed (attempt 1)")).toContain(
      "job=cf5af6fa vendor=unknown"
    );
  });

  it("leaves non-job lines untagged and preserves blank separator lines", () => {
    const format = createRunnerLineFormatter(fixedClock());
    const output = format("\n[runner] draining, Ctrl-C again to force quit");
    expect(output.split("\n")[0]).toBe("");
    expect(output.split("\n")[1]).toBe(
      "2026-07-25T12:00:00.000Z [runner] draining, Ctrl-C again to force quit"
    );
    expect(output).not.toContain("job=");
  });

  it("never doubles the [runner] prefix", () => {
    const format = createRunnerLineFormatter(fixedClock());
    const line = format("[runner] offline");
    expect(line.match(/\[runner\]/g)).toHaveLength(1);
  });
});
