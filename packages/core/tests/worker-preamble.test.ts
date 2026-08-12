import { describe, expect, it } from "vitest";
import {
  FULL_AUTO_WORKER_BLOCK,
  IMPLEMENTER_PEER_BLOCK,
  REVIEWER_PEER_BLOCK,
  WORKER_PREAMBLE,
  withWorkerPreamble,
} from "../src/worker-preamble.js";
import { withMemorySlice } from "../src/memory-slice.js";

describe("worker preamble", () => {
  it("prepends the discipline block ahead of the brief", () => {
    const composed = withWorkerPreamble("Fix the login bug.");
    expect(composed.startsWith(WORKER_PREAMBLE)).toBe(true);
    expect(composed.endsWith("Fix the login bug.")).toBe(true);
  });

  it("carries the code-graph-first order and the typed final-report shape", () => {
    // Graph-first exploration and the preflight chain reach every worker.
    expect(WORKER_PREAMBLE).toMatch(/CODE GRAPH FIRST/);
    expect(WORKER_PREAMBLE).toMatch(
      /code_query.*code_context.*preflight_edit/s
    );
    expect(WORKER_PREAMBLE).toMatch(/change an uncovered file fail/s);
    // The final message feeds the typed handoff packet: the labeled sections
    // must be present so the runner's extractor has something to bind to.
    for (const section of [
      "GOAL:",
      "CHANGED:",
      "CHECKS:",
      "CHANGED FILES:",
      "UNCERTAINTIES:",
      "NEXT ACTION:",
      "MEMORY PROPOSALS:",
    ]) {
      expect(WORKER_PREAMBLE).toContain(section);
    }
    // Authority stays bounded: no self-granted commit/push/merge/deploy.
    expect(WORKER_PREAMBLE).toMatch(
      /never: commit, push, merge, deploy, install dependencies, or run migrations/
    );
  });

  it("mandates code_query as the worker's FIRST action on any code task", () => {
    expect(WORKER_PREAMBLE).toMatch(/FIRST action on any code task is code_query/);
    expect(WORKER_PREAMBLE).toMatch(/before you read, grep, or spelunk any file/);
  });

  it("wraps the memory slice so the wire order is preamble → slice → brief", () => {
    const notes = [
      { kind: "decision", text: "TTL lives in config", confirmed: true, stale: false },
    ];
    const composed = withWorkerPreamble(withMemorySlice("Do the work.", notes));
    const preambleAt = composed.indexOf("MUON worker discipline");
    const sliceAt = composed.indexOf("Shared memory");
    const briefAt = composed.indexOf("Do the work.");
    expect(preambleAt).toBeGreaterThanOrEqual(0);
    expect(sliceAt).toBeGreaterThan(preambleAt);
    expect(briefAt).toBeGreaterThan(sliceAt);
  });

  describe("full-auto safety block (conditional)", () => {
    it("OFF is byte-identical to today (no opts)", () => {
      expect(withWorkerPreamble("Do X.")).toBe(`${WORKER_PREAMBLE}\n\n${"Do X."}`);
      expect(withWorkerPreamble("Do X.")).not.toContain("FULL-AUTO MODE ACTIVE");
    });

    it("ON prepends the full-auto safety block when flagged", () => {
      const c = withWorkerPreamble("Do X.", { fullAuto: true });
      expect(c).toContain(FULL_AUTO_WORKER_BLOCK);
      expect(c.indexOf("FULL-AUTO MODE ACTIVE")).toBeGreaterThanOrEqual(0);
      expect(c.endsWith("Do X.")).toBe(true); // brief still last on the wire
    });

    it("block reinforces conservative-on-irreversible + no-prompt-injection + no-egress", () => {
      expect(FULL_AUTO_WORKER_BLOCK).toMatch(/rm -rf|force push|irreversible/i);
      expect(FULL_AUTO_WORKER_BLOCK).toMatch(/prompt injection|embedded/i);
      expect(FULL_AUTO_WORKER_BLOCK).toMatch(/egress|leaves the machine|secret/i);
    });
  });

  describe("TODO 5.1: reviewer → implementer peer channel", () => {
    it("no role keeps the preamble byte-identical to today", () => {
      expect(withWorkerPreamble("Do X.")).toBe(`${WORKER_PREAMBLE}\n\n${"Do X."}`);
      expect(withWorkerPreamble("Do X.")).not.toContain("REVIEWER → IMPLEMENTER");
      expect(withWorkerPreamble("Do X.")).not.toContain("IMPLEMENTER ← REVIEWER");
    });

    it("reviewer role fuses the review_verdict obligation", () => {
      const c = withWorkerPreamble("Review the diff.", { role: "reviewer" });
      expect(c).toContain(REVIEWER_PEER_BLOCK);
      expect(c).toMatch(/peer_message/);
      expect(c).toMatch(/review_verdict/);
      expect(c).toMatch(/implementer/);
      expect(c).toMatch(/typed handoff is ALWAYS required/);
      expect(c).toMatch(/does NOT prove a living recipient/);
      expect(c).not.toContain(IMPLEMENTER_PEER_BLOCK);
      expect(c.endsWith("Review the diff.")).toBe(true);
    });

    it("implementer role fuses the peer_inbox obligation without a done-gate", () => {
      const c = withWorkerPreamble("Fix the bug.", { role: "implementer" });
      expect(c).toContain(IMPLEMENTER_PEER_BLOCK);
      expect(c).toMatch(/peer_inbox/);
      expect(c).toMatch(/review_verdict/);
      expect(c).toMatch(/from_role/);
      expect(c).toMatch(/ACKNOWLEDGE/);
      expect(c).toMatch(/not a done-gate/);
      expect(c).not.toMatch(/Do not claim done while/);
      expect(c).toMatch(/Before your first edit/);
      expect(c).not.toContain(REVIEWER_PEER_BLOCK);
    });

    it("role block sits after full-auto when both are set", () => {
      const c = withWorkerPreamble("Review.", {
        fullAuto: true,
        role: "reviewer",
      });
      const fullAutoAt = c.indexOf("FULL-AUTO MODE ACTIVE");
      const peerAt = c.indexOf("REVIEWER → IMPLEMENTER");
      expect(fullAutoAt).toBeGreaterThanOrEqual(0);
      expect(peerAt).toBeGreaterThan(fullAutoAt);
    });
  });
});

describe("feature #7 — environment drift is informed, never enforced", () => {
  it("adds NO block when the environment is consistent", () => {
    // A preamble that says "everything is fine" on every dispatch trains
    // agents to skip the block on the one dispatch where it matters.
    const plain = withWorkerPreamble("do the thing");
    expect(withWorkerPreamble("do the thing", { environmentDrift: [] })).toBe(
      plain
    );
    expect(
      withWorkerPreamble("do the thing", { environmentDrift: undefined })
    ).toBe(plain);
  });

  it("names the observed drift when there is some", () => {
    const brief = withWorkerPreamble("do the thing", {
      environmentDrift: [
        "node_modules looks installed by pnpm, but this repo resolves to npm",
      ],
    });
    expect(brief).toContain("WORKSPACE ENVIRONMENT DRIFT");
    expect(brief).toContain("installed by pnpm");
  });

  it("tells the agent NOT to fix it — an unasked install caused this", () => {
    const brief = withWorkerPreamble("do the thing", {
      environmentDrift: ["dependencies are not installed"],
    });
    expect(brief).toMatch(/not a task and not a blocker/i);
    expect(brief).toMatch(/Do NOT "fix" it/);
    expect(brief).toMatch(/unasked install/i);
  });

  it("keeps the brief last, after the drift block", () => {
    const brief = withWorkerPreamble("MY BRIEF HERE", {
      environmentDrift: ["something drifted"],
    });
    expect(brief.indexOf("WORKSPACE ENVIRONMENT DRIFT")).toBeLessThan(
      brief.indexOf("MY BRIEF HERE")
    );
  });
});

describe("feature #5 — blocked asks the crew before the human", () => {
  it("tells a blocked worker to ask, then wait BOUNDED, then escalate", () => {
    const brief = withWorkerPreamble("do the thing");
    expect(brief).toMatch(/ASK YOUR CREW BEFORE YOU ESCALATE/);
    expect(brief).toContain("peer_wait");
    // The clamp is what makes waiting safe to recommend at all.
    expect(brief).toMatch(/clamps that wait to your OWN remaining budget/);
  });

  it("keeps the escalation honest about what was tried", () => {
    // The point of the feature: the human's item says the CREW could not
    // resolve it, which is a cheaper decision than "an agent is stuck".
    const brief = withWorkerPreamble("do the thing");
    expect(brief).toMatch(/who you asked and how long you waited/);
    expect(brief).toMatch(/crew could not resolve this/);
  });

  it("still refuses to let a peer answer stand in for a human gate", () => {
    const brief = withWorkerPreamble("do the thing");
    expect(brief).toMatch(/NEVER wait on a peer to satisfy a human gate/);
    expect(brief).toMatch(/crew agreement is not approval/);
  });

  it("no longer forbids waiting outright, but still forbids UNBOUNDED waiting", () => {
    // The old rule ("never stall waiting for a peer") was right when no
    // bounded wait existed. peer_wait is clamped, so the rule narrowed rather
    // than disappeared.
    const brief = withWorkerPreamble("do the thing");
    expect(brief).toMatch(/never stall on an UNBOUNDED wait/);
  });
});

describe("feature #10 — a missing tool is named, not silently worked around", () => {
  it("adds NO block when the session holds everything its harness asked for", () => {
    // Same rule as the drift block: reassurance on every dispatch is how a
    // block becomes invisible on the dispatch that matters.
    const plain = withWorkerPreamble("do the thing");
    expect(withWorkerPreamble("do the thing", { toolGap: "" })).toBe(plain);
    expect(withWorkerPreamble("do the thing", { toolGap: "   " })).toBe(plain);
    expect(withWorkerPreamble("do the thing", { toolGap: undefined })).toBe(
      plain
    );
  });

  it("names the tool the brief assumes and the session lacks", () => {
    const brief = withWorkerPreamble("review this", {
      toolGap: "this job's harness asks for code_query, which this session does not hold",
    });
    expect(brief).toContain("TOOL GAP");
    expect(brief).toContain("code_query");
  });

  it("forbids reporting a weaker method as if it were the missing one", () => {
    // The field-notes failure: "always use the code graph" was unenforceable
    // for the agents whose job is judgment, and the degrade into grep was
    // indistinguishable from ordinary work.
    const brief = withWorkerPreamble("review this", {
      toolGap: "this job's harness asks for code_query, which this session does not hold",
    });
    expect(brief).toMatch(/Grepping is not querying the graph/);
    expect(brief).toMatch(/which conclusions are unverified/);
  });

  it("does not tell the agent to stop — it informs, like the drift block", () => {
    const brief = withWorkerPreamble("review this", {
      toolGap: "this job's harness asks for review_diff, which this session does not hold",
    });
    expect(brief).toMatch(/Do the work you CAN do/);
    expect(brief).not.toMatch(/abort|refuse the job|do not proceed/i);
  });

  it("keeps the brief last, after the tool-gap block", () => {
    const brief = withWorkerPreamble("MY BRIEF HERE", {
      toolGap: "this job's harness asks for code_query, which this session does not hold",
    });
    expect(brief.indexOf("TOOL GAP")).toBeLessThan(brief.indexOf("MY BRIEF HERE"));
  });

  it("composes with a drift block rather than replacing it", () => {
    const brief = withWorkerPreamble("MY BRIEF HERE", {
      environmentDrift: ["dependencies are not installed"],
      toolGap: "this job's harness asks for code_query, which this session does not hold",
    });
    expect(brief).toContain("WORKSPACE ENVIRONMENT DRIFT");
    expect(brief).toContain("TOOL GAP");
    expect(brief.indexOf("TOOL GAP")).toBeLessThan(brief.indexOf("MY BRIEF HERE"));
  });
});
