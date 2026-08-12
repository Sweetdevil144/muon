import { describe, expect, it } from "vitest";
import { buildRefusal } from "@muon/protocol/refusal";
import {
  failWithRefusal,
  refusalMcpError,
  withAgentUi,
} from "../src/agent-ui.js";

// ADR-0033 — what an AGENT receives when MUON refuses it.
//
// Two properties matter here and both are security-bearing: the envelope must
// not disclose more than the rule publishes to agents, and the next action must
// remain evidence rather than becoming an instruction the agent may act on
// without its own gate.

function partitionRefusal() {
  return buildRefusal({
    rule: "partition.mismatch",
    summary: "That note is outside this workspace partition.",
    surface: "memory_search",
    evidence: [
      { label: "callerPartition", value: "/repo-a" },
      { label: "targetPartition", value: "/repo-b" },
    ],
    nextAction: {
      kind: "none",
      because: "partitions do not merge",
    },
  });
}

describe("refusalMcpError", () => {
  it("carries the rule so an agent can branch without parsing prose", () => {
    const result = refusalMcpError("memory_search", partitionRefusal());
    const refusal = (result.structuredContent as Record<string, any>).refusal;
    expect(refusal.rule).toBe("partition.mismatch");
    expect(result.isError).toBe(true);
  });

  it("projects to the AGENT audience — no operator-only evidence escapes", () => {
    const result = refusalMcpError("memory_search", partitionRefusal());
    const serialized = JSON.stringify(result.structuredContent);
    // The whole leak this rule exists to prevent: naming the other side tells
    // the agent another workspace exists.
    expect(serialized).not.toContain("/repo-a");
    expect(serialized).not.toContain("/repo-b");
    expect(
      (result.structuredContent as Record<string, any>).refusal.evidence
    ).toEqual([]);
  });

  it("also keeps the operator-only evidence out of the text content", () => {
    // Both channels matter: an agent reads `content[0].text`, not only the
    // structured block.
    const result = refusalMcpError("memory_search", partitionRefusal());
    expect(result.content[0]!.text).not.toContain("/repo-b");
  });

  it("keeps the trust envelope, and says nextAction is not authority", () => {
    const result = refusalMcpError("memory_search", partitionRefusal());
    const muon = (result.structuredContent as Record<string, any>)._muon;
    expect(muon.trust.payloadInstructionTrust).toBe("none");
    expect(muon.trust.treatPayloadAs).toBe("data");
    expect(muon.outcome).toBe("refused");
    expect(muon.trust.rule).toMatch(/not authority/i);
  });

  it("passes through the evidence a rule DOES publish to agents", () => {
    const result = refusalMcpError(
      "dispatch",
      buildRefusal({
        rule: "delegation.children",
        summary: "This parent is at its child cap.",
        surface: "dispatch",
        evidence: [
          { label: "children", value: 3 },
          { label: "cap", value: 3 },
          { label: "parentJobId", value: "job-parent" },
        ],
        nextAction: { kind: "retry", after: "a child finishes" },
      })
    );
    const refusal = (result.structuredContent as Record<string, any>).refusal;
    expect(refusal.evidence).toEqual([
      { label: "children", value: 3 },
      { label: "cap", value: 3 },
    ]);
    // parentJobId is operator-only — an agent learning sibling job ids is a
    // disclosure it has no need for.
    expect(JSON.stringify(refusal)).not.toContain("job-parent");
    expect(refusal.nextAction).toEqual({
      kind: "retry",
      after: "a child finishes",
    });
  });

  it("omits nextAction entirely when the site supplied none", () => {
    const result = refusalMcpError(
      "memory_add",
      buildRefusal({
        rule: "mcp.server_denied",
        summary: "Denied.",
        surface: "mcp",
      })
    );
    const refusal = (result.structuredContent as Record<string, any>).refusal;
    expect("nextAction" in refusal).toBe(false);
  });
});

// ADR-0033 — a refusal on the RICH envelope, which is what an agent gets when
// a governed tool (not the transport) refuses it.
describe("failWithRefusal", () => {
  it("derives nextActions from the typed action, not the generic retry line", async () => {
    // The generic "correct the reported input and retry" actively misleads
    // when the boundary is permanent — this is the case that motivated it.
    const [tool] = withAgentUi(
      [
        {
          name: "dispatch",
          description: "t",
          inputSchema: {},
          handler: async () =>
            failWithRefusal(
              buildRefusal({
                rule: "role.ceiling",
                summary: "Cursor cannot hold implementer.",
                surface: "dispatch role admission",
                evidence: [
                  { label: "vendor", value: "cursor" },
                  { label: "requestedRole", value: "implementer" },
                  { label: "allowedRoles", value: "reviewer, qa" },
                ],
                nextAction: {
                  kind: "none",
                  because: "a read-only lane cannot be given write authority",
                },
              }),
              "could not enqueue dispatch"
            ),
        },
      ],
      {
        principal: "orchestrator",
        taskScoped: true,
        laneScoped: true,
        chatScoped: true,
      }
    );
    const result = await tool!.handler({});
    const muon = (result.structuredContent as Record<string, any>)._muon;
    expect(muon.nextActions).toHaveLength(1);
    expect(muon.nextActions[0]).toMatch(/no way forward/i);
    expect(muon.nextActions[0]).not.toMatch(/retry this tool/i);
    expect(muon.refusal.rule).toBe("role.ceiling");
  });

  it("keeps the full authority context a successful call gets", async () => {
    // The reduced dataOnlyMcpError envelope drops authority/evidence; a
    // governed refusal should not tell the agent LESS about its own scope.
    const [tool] = withAgentUi(
      [
        {
          name: "dispatch",
          description: "t",
          inputSchema: {},
          handler: async () =>
            failWithRefusal(
              buildRefusal({
                rule: "budget.exhausted",
                summary: "Out of pool.",
                surface: "dispatch",
                evidence: [{ label: "remainingMs", value: 0 }],
                nextAction: { kind: "retry", after: "a sibling frees budget" },
              })
            ),
        },
      ],
      {
        principal: "orchestrator",
        taskScoped: true,
        laneScoped: false,
        chatScoped: true,
      }
    );
    const result = await tool!.handler({});
    const muon = (result.structuredContent as Record<string, any>)._muon;
    expect(muon.authority.principal).toBe("orchestrator");
    expect(muon.trust.payloadInstructionTrust).toBe("none");
    expect(muon.refusal.evidence).toEqual([{ label: "remainingMs", value: 0 }]);
    expect(result.isError).toBe(true);
  });

  it("projects at the helper, so a forwarded refusal cannot be widened", async () => {
    const result = failWithRefusal(
      buildRefusal({
        rule: "partition.mismatch",
        summary: "outside this workspace",
        surface: "memory",
        evidence: [{ label: "targetPartition", value: "/other-repo" }],
      })
    );
    expect(JSON.stringify(result)).not.toContain("/other-repo");
  });
});
