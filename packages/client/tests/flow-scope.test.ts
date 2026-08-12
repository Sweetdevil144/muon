import { describe, expect, it } from "vitest";
import {
  buildFlowScope,
  parseSymbolUid,
  flowsForAnchorQuery,
  flowMembersQuery,
  type FlowScopeInput,
} from "../src/flow-scope.js";

describe("parseSymbolUid", () => {
  it("splits <Kind>:<file>:<symbol> keeping the path intact", () => {
    expect(
      parseSymbolUid("Function:apps/cli/src/commands/workflow.ts:registerWorkflowCommands")
    ).toEqual({
      file: "apps/cli/src/commands/workflow.ts",
      symbol: "registerWorkflowCommands",
    });
  });
  it("degrades a malformed uid to {file:'', symbol:whole}", () => {
    expect(parseSymbolUid("justAName")).toEqual({ file: "", symbol: "justAName" });
  });
});

const input = (over: Partial<FlowScopeInput> = {}): FlowScopeInput => ({
  anchorSymbol: "redeemGateAtRoute",
  anchorFile: "backend/src/routes/redeem.ts",
  flows: [
    { processId: "proc_9", label: "RegisterRedeem → Foo", entryPointId: "Function:backend/src/routes/redeem.ts:registerRedeem", stepCount: 5 },
    { processId: "proc_2", label: "Small → Bar", entryPointId: "Function:backend/src/x.ts:small", stepCount: 3 },
  ],
  memberRows: [
    { processId: "proc_9", symbol: "registerRedeem", file: "backend/src/routes/redeem.ts", step: 1 },
    { processId: "proc_9", symbol: "isHumanPrincipal", file: "backend/src/lib/principal.ts", step: 2 },
    { processId: "proc_9", symbol: "redeemGateAtRoute", file: "backend/src/routes/redeem.ts", step: 3 },
    { processId: "proc_2", symbol: "small", file: "backend/src/x.ts", step: 1 },
  ],
  ...over,
});

describe("buildFlowScope", () => {
  it("compiles flows to concrete file:symbol scope, richest flow first", () => {
    const scope = buildFlowScope(input());
    expect(scope.flowCount).toBe(2);
    expect(scope.flows[0]!.process).toBe("RegisterRedeem → Foo"); // 5 steps, first
    expect(scope.flows[0]!.entryPoint).toEqual({
      file: "backend/src/routes/redeem.ts",
      symbol: "registerRedeem",
    });
    // members step-ordered
    expect(scope.flows[0]!.members.map((m) => m.symbol)).toEqual([
      "registerRedeem",
      "isHumanPrincipal",
      "redeemGateAtRoute",
    ]);
    // ownedPaths union across shown flows
    expect(scope.ownedPaths).toEqual(
      expect.arrayContaining([
        "backend/src/routes/redeem.ts",
        "backend/src/lib/principal.ts",
        "backend/src/x.ts",
      ])
    );
    // concrete in-scope targets
    expect(scope.inScopeSymbols).toContain("backend/src/routes/redeem.ts::redeemGateAtRoute");
    expect(scope.inScopeSymbols).toContain("backend/src/lib/principal.ts::isHumanPrincipal");
  });

  it("warns that flow labels/ids are unstable (no step-number contracts)", () => {
    const scope = buildFlowScope(input());
    expect(scope.notes.join(" ")).toMatch(/unstable|re-resolve|never cite a step/i);
  });

  it("an anchor in no flow degrades to file/symbol scoping, never throws", () => {
    const scope = buildFlowScope(input({ flows: [], memberRows: [] }));
    expect(scope.flows).toEqual([]);
    expect(scope.ownedPaths).toEqual([]);
    expect(scope.notes.join(" ")).toMatch(/no indexed execution flow/i);
  });
});

describe("flow-scope queries", () => {
  it("builds the anchor + members reads", () => {
    expect(flowsForAnchorQuery("n.name = 'x'")).toContain("STEP_IN_PROCESS");
    expect(flowsForAnchorQuery("n.name = 'x'")).toContain("p.entryPointId AS entryPointId");
    expect(flowMembersQuery("'p1', 'p2'")).toContain("p.id IN ['p1', 'p2']");
    expect(flowMembersQuery("'p1'")).toContain("r.step AS step");
  });
});
