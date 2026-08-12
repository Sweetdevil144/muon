import { describe, expect, it } from "vitest";
import { renderPlan, splitRequestIntoTasks } from "../src/lib/plan-builder.js";

describe("splitRequestIntoTasks", () => {
  it("splits bullet lists into tasks", () => {
    const tasks = splitRequestIntoTasks(
      "- fix the failing backend test\n- add memory browser to the TUI\n- update the docs"
    );
    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.title).toContain("fix the failing backend test");
  });

  it("splits 'then' chains", () => {
    const tasks = splitRequestIntoTasks(
      "refactor the api client then add retry logic to requests"
    );
    expect(tasks).toHaveLength(2);
  });

  it("keeps a single task for simple requests", () => {
    const tasks = splitRequestIntoTasks("ship the login page redesign");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.priority).toBe("medium");
  });

  it("derives priority from wording", () => {
    const [bug] = splitRequestIntoTasks("fix the broken deploy pipeline urgently");
    expect(bug!.priority).toBe("high");
    const [docs] = splitRequestIntoTasks("document the new memory endpoints");
    expect(docs!.priority).toBe("low");
  });
});

describe("renderPlan", () => {
  it("prints suggestions and makes the human checkpoint explicit", () => {
    const output = renderPlan([
      {
        planned: { title: "Fix tests", description: "Fix tests", priority: "high" },
        suggestions: [
          {
            laneId: "l1",
            laneKey: "codex",
            laneName: "Codex",
            score: 4,
            reason: "2/2 completed",
          },
        ],
      },
    ]);
    expect(output).toContain("Fix tests");
    expect(output).toContain("suggested lane: Codex");
    expect(output).toContain("--apply");
    expect(output).toContain("nothing is created yet");
  });
});
