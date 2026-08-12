import { describe, expect, it } from "vitest";
import {
  buildRefusal,
  describeAction,
  disclosedEvidence,
  isDeliberatelyWithheld,
  projectRefusal,
  REFUSAL_RULES,
  refusalTitle,
  renderRefusalLine,
  type Refusal,
  type RefusalAudience,
  type RefusalRule,
} from "../src/refusal.js";

// ADR-0033. The security-bearing assertions here are the disclosure ones: an
// explanation is a disclosure, and a refusal that leaks is worse than a terse
// one. Everything else is ergonomics.

const ALL_RULES = Object.keys(REFUSAL_RULES) as RefusalRule[];
const AUDIENCES: RefusalAudience[] = ["agent", "operator"];

function refusalWith(
  rule: RefusalRule,
  evidence: { label: string; value: string | number | boolean }[]
): Refusal {
  return buildRefusal({
    rule,
    summary: "refused",
    surface: "test",
    evidence,
  });
}

describe("ADR-0033 D2 — disclosure is a positive allowlist", () => {
  it("drops any fact the rule did not publish to that audience", () => {
    // The whole point: an enforcement site can attach whatever it has; only
    // what the rule PUBLISHES reaches the caller.
    const refusal = refusalWith("partition.mismatch", [
      { label: "callerPartition", value: "/repo-a" },
      { label: "targetPartition", value: "/repo-b" },
    ]);
    expect(disclosedEvidence(refusal, "agent")).toEqual([]);
    expect(disclosedEvidence(refusal, "operator")).toHaveLength(2);
  });

  it("never tells an agent which job a capability was bound to", () => {
    // Naming the bound job discloses the existence of work the agent is not
    // part of — the leak this rule's empty agent allowlist prevents.
    const refusal = refusalWith("capability.job_mismatch", [
      { label: "boundJobId", value: "job-secret" },
      { label: "requestedJobId", value: "job-mine" },
    ]);
    const rendered = renderRefusalLine(refusal, "agent");
    expect(rendered).not.toContain("job-secret");
    expect(rendered).not.toContain("job-mine");
    expect(disclosedEvidence(refusal, "agent")).toEqual([]);
  });

  it("gives the operator the blind file list but the agent only counts", () => {
    const refusal = refusalWith("ship.review_blind", [
      { label: "changedFiles", value: 4 },
      { label: "blindFiles", value: 2 },
      { label: "firstBlindFile", value: "src/secret/path.ts" },
    ]);
    const agentLabels = disclosedEvidence(refusal, "agent").map((f) => f.label);
    expect(agentLabels).toContain("blindFiles");
    expect(agentLabels).not.toContain("firstBlindFile");
    expect(renderRefusalLine(refusal, "agent")).not.toContain("src/secret");
    expect(
      disclosedEvidence(refusal, "operator").map((f) => f.label)
    ).toContain("firstBlindFile");
  });

  it("refuses credential-shaped labels centrally, even if a rule listed them", () => {
    // Backstop: the per-rule allowlist is the primary control, but a mistake
    // there must not be sufficient to leak token material.
    const refusal = refusalWith("capability.tier", [
      { label: "heldTier", value: "agent" },
      { label: "requiredTier", value: "operator" },
    ]);
    // Sanity: the legitimate facts do pass.
    expect(disclosedEvidence(refusal, "agent")).toHaveLength(2);

    const sneaky = refusalWith("capability.tier", [
      { label: "capabilityToken", value: "tok_live_123" },
    ]);
    expect(disclosedEvidence(sneaky, "agent")).toEqual([]);
    expect(renderRefusalLine(sneaky, "operator")).not.toContain("tok_live_123");
  });

  it("discloses nothing an enforcement site did not actually attach", () => {
    const refusal = refusalWith("budget.exhausted", [
      { label: "remainingMs", value: 0 },
    ]);
    expect(disclosedEvidence(refusal, "operator").map((f) => f.label)).toEqual([
      "remainingMs",
    ]);
  });

  it("orders facts by the allowlist, not by attachment order", () => {
    // So the most important fact is first regardless of how the site built it.
    const refusal = refusalWith("delegation.children", [
      { label: "cap", value: 3 },
      { label: "children", value: 4 },
    ]);
    expect(disclosedEvidence(refusal, "agent").map((f) => f.label)).toEqual([
      "children",
      "cap",
    ]);
  });
});

describe("ADR-0033 — the rule table is total and sane", () => {
  it("gives every rule a title and both audiences", () => {
    for (const rule of ALL_RULES) {
      expect(refusalTitle(rule), rule).toBeTruthy();
      for (const audience of AUDIENCES) {
        expect(
          Array.isArray(REFUSAL_RULES[rule].disclose[audience]),
          `${rule}/${audience}`
        ).toBe(true);
      }
    }
  });

  it("never lets an agent see more than an operator", () => {
    // An agent seeing a fact the operator does not would be an inversion of
    // the trust model, and is always a bug.
    for (const rule of ALL_RULES) {
      const { agent, operator } = REFUSAL_RULES[rule].disclose;
      for (const label of agent) {
        expect(operator, `${rule}: agent sees ${label}, operator does not`).toContain(
          label
        );
      }
    }
  });

  it("never publishes a credential-shaped label to any audience", () => {
    for (const rule of ALL_RULES) {
      for (const audience of AUDIENCES) {
        for (const label of REFUSAL_RULES[rule].disclose[audience]) {
          expect(
            /token|bearer|secret|credential|password|apikey/i.test(label),
            `${rule}/${audience} publishes ${label}`
          ).toBe(false);
        }
      }
    }
  });

  it("names rules as <domain>.<rule> so surfaces can group without parsing prose", () => {
    for (const rule of ALL_RULES) {
      expect(rule, rule).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });
});

describe("next actions are honest", () => {
  it("supports a permanent boundary with no way forward", () => {
    const action = {
      kind: "none",
      because: "this lane can never hold implementer",
    } as const;
    expect(describeAction(action)).toContain("no way forward");
  });

  it("renders each action kind", () => {
    expect(
      describeAction({ kind: "operator", action: "re-index the workspace" })
    ).toContain("an operator must");
    expect(
      describeAction({
        kind: "command",
        command: "muon doctor",
        action: "check readiness",
      })
    ).toContain("muon doctor");
    expect(describeAction({ kind: "retry", after: "the index refreshes" })).toContain(
      "retry"
    );
  });

  it("omits the arrow entirely when there is no next action", () => {
    const refusal = refusalWith("mcp.server_denied", [
      { label: "server", value: "sketchy-mcp" },
    ]);
    expect(renderRefusalLine(refusal, "agent")).not.toContain("→");
  });
});

describe("projection over the wire", () => {
  it("carries the audience-safe evidence and nothing else", () => {
    const refusal = buildRefusal({
      rule: "partition.mismatch",
      summary: "outside this workspace",
      surface: "memory.search",
      evidence: [
        { label: "callerPartition", value: "/a" },
        { label: "targetPartition", value: "/b" },
      ],
      nextAction: { kind: "none", because: "partitions do not merge" },
    });
    const forAgent = projectRefusal(refusal, "agent");
    expect(forAgent.evidence).toEqual([]);
    expect(forAgent.rule).toBe("partition.mismatch");
    expect(forAgent.summary).toBe("outside this workspace");
    expect(forAgent.nextAction).toEqual(refusal.nextAction);
    expect(JSON.stringify(forAgent)).not.toContain("/b");
  });
});

describe("ADR-0033 — a deliberate collapse is marked, not undone", () => {
  it("forces `withheld` for rules whose terseness is the security property", () => {
    // MUON answers two different partition causes with one identical message
    // on purpose: telling them apart is how an agent maps which repositories
    // exist. A site cannot mark this `full` by mistake.
    const refusal = buildRefusal({
      rule: "partition.mismatch",
      summary: "outside this workspace",
      surface: "memory.search",
      disclosure: "full",
    });
    expect(refusal.disclosure).toBe("withheld");
    expect(isDeliberatelyWithheld("partition.mismatch")).toBe(true);
    expect(isDeliberatelyWithheld("capability.job_mismatch")).toBe(true);
  });

  it("defaults ordinary rules to full disclosure", () => {
    expect(
      buildRefusal({
        rule: "budget.exhausted",
        summary: "out of budget",
        surface: "dispatch",
      }).disclosure
    ).toBe("full");
    expect(isDeliberatelyWithheld("budget.exhausted")).toBe(false);
  });

  it("tells the agent the terseness is deliberate", () => {
    // So a future reader does not 'improve' a collapsed refusal — the
    // regression that would look like polish.
    const refusal = buildRefusal({
      rule: "partition.mismatch",
      summary: "outside this workspace",
      surface: "memory.search",
    });
    expect(renderRefusalLine(refusal, "agent")).toMatch(/deliberately withheld/);
  });

  it("does not clutter the operator's line with the marker", () => {
    // The operator can see the evidence, so there is nothing being withheld
    // from them to explain.
    const refusal = buildRefusal({
      rule: "partition.mismatch",
      summary: "outside this workspace",
      surface: "memory.search",
      evidence: [{ label: "callerPartition", value: "/a" }],
    });
    expect(renderRefusalLine(refusal, "operator")).not.toMatch(/withheld/);
  });
});
