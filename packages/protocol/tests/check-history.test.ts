import { describe, expect, it } from "vitest";
import {
  annotateChecks,
  boundHistory,
  CHECK_HISTORY_WINDOW,
  classifyFlakiness,
  describeFlakiness,
  MIN_RUNS_FOR_FLAKINESS,
  orderForReport,
  type CheckRun,
  type CheckRunOutcome,
} from "../src/check-history.js";
import type { HandoffCheck } from "../src/handoff.js";

// ADR-0037. "known-flaky" is the most abusable label in a test report — it
// hands an agent a way to ship broken work while sounding rigorous. Every
// assertion below is about keeping that impossible.

function run(outcome: CheckRunOutcome, n = 0): CheckRun {
  return {
    name: "npm test",
    workspacePath: "/repo",
    outcome,
    at: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  };
}

function check(over: Partial<HandoffCheck> = {}): HandoffCheck {
  return { name: "npm test", outcome: "failed", summary: "", ...over };
}

describe("ADR-0037 D1 — flakiness never changes an outcome", () => {
  it("a failed check stays failed no matter how flaky its history", () => {
    const annotated = annotateChecks(
      [check({ outcome: "failed" })],
      () => [run("failed", 1), run("passed", 2), run("passed", 3), run("passed", 4)]
    );
    expect(annotated[0]!.outcome).toBe("failed");
    expect(annotated[0]!.flakiness.kind).toBe("flaky");
  });

  it("copies every other check field through untouched", () => {
    const original = check({
      outcome: "failed",
      command: "npm test",
      exitCode: 1,
      summary: "2 failing",
    });
    const [annotated] = annotateChecks([original], () => []);
    expect(annotated).toMatchObject(original);
  });

  it("exports no function that maps a history onto an outcome", async () => {
    // Structural: if such a function existed, someone would eventually call it.
    const module = await import("../src/check-history.js");
    const suspicious = Object.keys(module).filter((name) =>
      /toOutcome|asOutcome|downgrade|suppress|ignore|resolveOutcome/i.test(name)
    );
    expect(suspicious).toEqual([]);
  });
});

describe("ADR-0037 D2 — the classification refuses to guess", () => {
  it("says insufficient-evidence below the minimum, never stable", () => {
    // A check seen twice has demonstrated nothing; the safe reading of thin
    // evidence is no claim, not a clean bill of health.
    for (let count = 0; count < MIN_RUNS_FOR_FLAKINESS; count += 1) {
      const runs = Array.from({ length: count }, (_, i) => run("passed", i));
      const verdict = classifyFlakiness(runs);
      expect(verdict.kind, `${count} runs`).toBe("insufficient-evidence");
    }
  });

  it("calls 9-of-9 failures CONSISTENTLY-FAILING, not flaky", () => {
    // The misclassification this feature would otherwise enable at scale: a
    // broken check reported as "known-flaky" and waved through.
    const runs = Array.from({ length: 9 }, (_, i) => run("failed", i));
    const verdict = classifyFlakiness(runs);
    expect(verdict.kind).toBe("consistently-failing");
    expect(verdict.failures).toBe(9);
    expect(describeFlakiness(verdict)).not.toMatch(/flaky/i);
  });

  it("calls an all-green history stable", () => {
    const runs = Array.from({ length: 5 }, (_, i) => run("passed", i));
    expect(classifyFlakiness(runs).kind).toBe("stable");
  });

  it("calls a mixed history flaky, with the real counts", () => {
    const runs = [
      ...Array.from({ length: 8 }, (_, i) => run("passed", i)),
      run("failed", 9),
    ];
    const verdict = classifyFlakiness(runs);
    expect(verdict.kind).toBe("flaky");
    expect(verdict.runs).toBe(9);
    expect(verdict.failures).toBe(1);
    // The field notes' exact sentence, now a fact MUON holds.
    expect(describeFlakiness(verdict)).toBe(
      "known-flaky: failed 1 of 9 recorded runs"
    );
  });
});

describe("what counts as a run", () => {
  it("ignores skipped runs entirely", () => {
    // Counting them would let a mostly-skipped check drift toward "stable"
    // without ever proving anything.
    const runs = [
      run("skipped", 1),
      run("skipped", 2),
      run("skipped", 3),
      run("passed", 4),
    ];
    const verdict = classifyFlakiness(runs);
    expect(verdict.runs).toBe(1);
    expect(verdict.kind).toBe("insufficient-evidence");
  });

  it("counts a harness error as a failure, not as neutral", () => {
    // A check that cannot run is a check that is not passing; treating it as
    // neutral is how a broken harness looks healthy.
    const runs = [run("error", 1), run("passed", 2), run("passed", 3)];
    const verdict = classifyFlakiness(runs);
    expect(verdict.failures).toBe(1);
    expect(verdict.kind).toBe("flaky");
  });

  it("treats passed-but-uncovering as a run that did not fail", () => {
    // It is green-but-meaningless for COVERAGE reasons, which is a different
    // axis from flakiness; conflating them would double-punish it.
    const runs = Array.from({ length: 4 }, (_, i) =>
      run("passed-but-uncovering", i)
    );
    expect(classifyFlakiness(runs).kind).toBe("stable");
    expect(classifyFlakiness(runs).failures).toBe(0);
  });
});

describe("ADR-0037 D4 — lossless", () => {
  it("annotates every check and drops none", () => {
    const checks = [
      check({ name: "a", outcome: "passed" }),
      check({ name: "b", outcome: "failed" }),
      check({ name: "c", outcome: "skipped" }),
    ];
    expect(annotateChecks(checks, () => []).length).toBe(checks.length);
  });

  it("orders a known-flaky failure lower but keeps it in the report", () => {
    const flakyHistory = [
      run("failed", 1),
      run("passed", 2),
      run("passed", 3),
      run("passed", 4),
    ];
    const annotated = annotateChecks(
      [
        check({ name: "flaky-one", outcome: "failed" }),
        check({ name: "unexplained", outcome: "failed" }),
      ],
      (name) => (name === "flaky-one" ? flakyHistory : [])
    );
    const ordered = orderForReport(annotated);
    // The unexplained failure wants a person first...
    expect(ordered[0]!.name).toBe("unexplained");
    // ...but the flaky one is still there, still failed.
    expect(ordered.map((c) => c.name)).toContain("flaky-one");
    expect(ordered).toHaveLength(2);
    expect(ordered.every((c) => c.outcome === "failed")).toBe(true);
  });

  it("puts a consistently-failing check at the very top", () => {
    const annotated = annotateChecks(
      [
        check({ name: "passing", outcome: "passed" }),
        check({ name: "broken", outcome: "failed" }),
      ],
      (name) =>
        name === "broken"
          ? Array.from({ length: 5 }, (_, i) => run("failed", i))
          : []
    );
    expect(orderForReport(annotated)[0]!.name).toBe("broken");
  });

  it("is stable within a rank, so a report does not reshuffle run to run", () => {
    const annotated = annotateChecks(
      [
        check({ name: "one", outcome: "passed" }),
        check({ name: "two", outcome: "passed" }),
        check({ name: "three", outcome: "passed" }),
      ],
      () => []
    );
    expect(orderForReport(annotated).map((c) => c.name)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });
});

describe("ADR-0037 D3/D5 — the note claims nothing, the window is bounded", () => {
  it("never suggests ignoring or retrying a check", () => {
    // "so you can ignore it" is exactly the conclusion an agent must not draw.
    for (const runs of [
      [],
      [run("passed", 1), run("passed", 2), run("passed", 3)],
      [run("failed", 1), run("passed", 2), run("passed", 3)],
      [run("failed", 1), run("failed", 2), run("failed", 3)],
    ]) {
      const note = describeFlakiness(classifyFlakiness(runs));
      expect(note).not.toMatch(/ignore|safe to|retry|re-run|proceed|dismiss/i);
    }
  });

  it("only considers the recent window", () => {
    // A check that was flaky before a fix is not evidence about today.
    const old = Array.from({ length: CHECK_HISTORY_WINDOW }, (_, i) =>
      run("failed", i)
    );
    const recent = Array.from({ length: CHECK_HISTORY_WINDOW }, (_, i) =>
      run("passed", CHECK_HISTORY_WINDOW + i)
    );
    expect(classifyFlakiness([...old, ...recent]).kind).toBe("stable");
  });

  it("bounds a stored history to the window, keeping the newest", () => {
    const runs = Array.from({ length: CHECK_HISTORY_WINDOW + 10 }, (_, i) =>
      run("passed", i)
    );
    const bounded = boundHistory(runs);
    expect(bounded).toHaveLength(CHECK_HISTORY_WINDOW);
    expect(bounded[bounded.length - 1]).toEqual(runs[runs.length - 1]);
  });
});

describe("evidence that was not fully read cannot yield a clean bill", () => {
  it("does not let skipped runs evict real failures from the window", () => {
    // The defect the adversarial review found: the window was applied BEFORE
    // the skipped filter, so 17 skips pushed 10 real failures out and the
    // verdict came back "stable: 3 of 3 passed" — the exact drift the
    // countsAsRun docstring says it prevents.
    const runs = [
      ...Array.from({ length: 10 }, (_, i) => run("failed", i)),
      ...Array.from({ length: 10 }, (_, i) => run("passed", 10 + i)),
      ...Array.from({ length: 17 }, (_, i) => run("skipped", 20 + i)),
      ...Array.from({ length: 3 }, (_, i) => run("passed", 40 + i)),
    ];
    const verdict = classifyFlakiness(runs);
    expect(verdict.kind).toBe("flaky");
    expect(verdict.failures).toBeGreaterThan(0);
  });

  it("boundHistory drops skipped runs so they cannot fill the stored window", () => {
    const runs = [
      ...Array.from({ length: 5 }, (_, i) => run("failed", i)),
      ...Array.from({ length: CHECK_HISTORY_WINDOW }, (_, i) =>
        run("skipped", 10 + i)
      ),
    ];
    const bounded = boundHistory(runs);
    expect(bounded).toHaveLength(5);
    expect(bounded.every((r) => r.outcome === "failed")).toBe(true);
  });

  it("refuses `stable` when the caller could not see far enough back", () => {
    // Three recent passes are not a clean bill if older runs were never read.
    const runs = Array.from({ length: 3 }, (_, i) => run("passed", i));
    expect(classifyFlakiness(runs, CHECK_HISTORY_WINDOW, false).kind).toBe(
      "stable"
    );
    expect(classifyFlakiness(runs, CHECK_HISTORY_WINDOW, true).kind).toBe(
      "insufficient-evidence"
    );
  });

  it("refuses `consistently-failing` on a truncated scan, but still says flaky", () => {
    // A failure it DID see is real; "it has failed every time" is not a claim
    // truncated evidence supports.
    const runs = Array.from({ length: 4 }, (_, i) => run("failed", i));
    expect(classifyFlakiness(runs, CHECK_HISTORY_WINDOW, false).kind).toBe(
      "consistently-failing"
    );
    expect(classifyFlakiness(runs, CHECK_HISTORY_WINDOW, true).kind).toBe(
      "flaky"
    );
  });
});
