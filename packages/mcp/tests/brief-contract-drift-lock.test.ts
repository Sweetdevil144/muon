import { describe, expect, it } from "vitest";
import type { MuonApiClient } from "@muon/client";
import {
  CHILD_BRIEF_HEADINGS,
  CREW_TASK_HEADINGS,
  briefHeadingList,
  briefHeadingMandate,
  missingBriefHeadings,
  taskHeadingList,
} from "@muon/protocol";
import {
  toMcpToolDefinition,
  type ToolDefinition,
} from "../src/agent-ui.js";
import { createDelegateToolDefinitions } from "../src/delegate-tools.js";
import { createToolDefinitions } from "../src/handlers.js";
import { createOrchestratorToolDefinitions } from "../src/orchestrator-tools.js";

/**
 * THE DRIFT-LOCK, MCP HALF.
 *
 * `packages/orchestrator/tests/brief-contract.test.ts` locks the rendered SYSTEM
 * PROMPT against `CHILD_BRIEF_HEADINGS`. It was not enough. An externally
 * launched coordinator — a human's own `claude` with `muon-mcp` registered —
 * never sees that prompt: the only contract it reads is the `dispatch` tool
 * description. That description was hand-written prose outside the lock, and it
 * drifted to ten of twelve headings (no COORDINATION, no FINAL REPORT), so a
 * session that followed it VERBATIM had every child refused by
 * `childBriefDeficiency`. Fourth instance of the failure mode
 * `brief-contract.ts` exists to end.
 *
 * These tests read the SHIPPED strings — what `tools/list` actually hands a
 * vendor session, agent-UI wrapper and all — so re-inlining the list as literal
 * text fails here rather than in a live mission. Two assertions, on purpose:
 *
 *   A. every artifact that RENDERS the mandate mandates exactly the twelve, in
 *      order (the same parse the prompt lock runs, deliberately);
 *   B. no shipped description NAMES a partial heading list, whether it renders
 *      one or not — which is the shape the fourth drift actually had.
 *
 * (B) runs over EVERY tool in all three modes, not just `dispatch`. Written that
 * way, it immediately found a fifth instance in `delegate`'s description ("copy
 * GOAL, SCOPE, CHECKS, and AUTHORITY" — three of twelve plus an alias), which is
 * the argument for scoping a lock to the surface rather than to the file that
 * broke last time.
 */

/**
 * EVERY tool an attached session can be handed, across all three modes: the base
 * context+coordination tier a hand-registered session already receives, the
 * orchestrator control tier, and the delegate tier a worker gets. Each factory
 * applies `withAgentUi` itself, so these carry the agent-UI contract already —
 * which is what makes `toMcpToolDefinition` below the SHIPPED string.
 *
 * The lock is over the whole surface on purpose. The fourth drift landed in the
 * one file nobody was watching, and "which file" is not a property worth relying
 * on; scoping the lock to the surface is what found the fifth.
 */
function everyTool(): ToolDefinition[] {
  // Definitions only; no handler runs, so an inert client is enough.
  const client = {} as MuonApiClient;
  return [
    ...createToolDefinitions(client, {}),
    ...createOrchestratorToolDefinitions(client, {
      apiBase: "http://127.0.0.1:4000",
      chatId: "chat-1",
      chatTaskId: "task-shadow",
      jobId: "job-root",
      delegationToken: "root-job-token",
    }),
    ...createDelegateToolDefinitions(client, {
      parentJobId: "job-parent",
      delegationToken: "parent-job-token",
      workspacePath: "/repo",
    }),
  ];
}

function tool(name: string): ToolDefinition {
  const found = everyTool().find((entry) => entry.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

/** The description a vendor session receives, wrapper prefix and suffix included. */
function shippedDescription(name: string): string {
  return toMcpToolDefinition(tool(name)).description;
}

/** Every `description` string anywhere in a tool's input schema. */
function schemaDescriptions(
  node: unknown,
  path: string
): Array<{ label: string; text: string }> {
  if (typeof node !== "object" || node === null) return [];
  const found: Array<{ label: string; text: string }> = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "description" && typeof value === "string") {
      found.push({ label: path, text: value });
      continue;
    }
    found.push(...schemaDescriptions(value, `${path}.${key}`));
  }
  return found;
}

/** Every string an attached session can read off one tool. */
function readableTexts(
  definition: ToolDefinition
): Array<{ label: string; text: string }> {
  return [
    {
      label: `${definition.name} description`,
      text: toMcpToolDefinition(definition).description,
    },
    ...schemaDescriptions(definition.inputSchema, definition.name),
  ];
}

/**
 * A text NAMES a heading when the canonical, all-caps heading word appears in
 * it, ordered by where it first appears. Word-bounded on purpose: `AGENT_ROLES`
 * and `ROLE_SPECS` are code identifiers, not the contract.
 */
const HEADING_PATTERNS = CHILD_BRIEF_HEADINGS.map((heading) => ({
  heading,
  pattern: new RegExp(`\\b${heading}\\b`),
}));

function headingsNamedBy(text: string): string[] {
  return HEADING_PATTERNS.flatMap(({ heading, pattern }) => {
    const at = text.search(pattern);
    return at < 0 ? [] : [{ heading, at }];
  })
    .sort((left, right) => left.at - right.at)
    .map((entry) => entry.heading);
}

/**
 * TWO or more heading names is a LIST, and a list must be the whole contract —
 * either every brief heading or exactly the published filed-task subset. A
 * strict, non-empty subset of the contract is the drift itself.
 *
 * The threshold is two rather than one because `vendorRoutingBrief()`
 * legitimately writes "Route by ROLE first" about the crew-role taxonomy
 * (`AGENT_ROLES`), a different thing that happens to share a word. One heading
 * word in prose is a reference; two is the contract restated, and restating it
 * instead of rendering it is what broke four missions.
 */
function namesCompleteContract(named: readonly string[]): boolean {
  if (named.length < 2) return true;
  const key = [...named].sort().join("|");
  return (
    key === [...CHILD_BRIEF_HEADINGS].sort().join("|") ||
    key === [...CREW_TASK_HEADINGS].sort().join("|")
  );
}

/**
 * The headings a RENDERED text mandates, parsed back out of it. This is the same
 * parse `packages/orchestrator/tests/brief-contract.test.ts` runs against the
 * rendered system prompt — one assertion class, both surfaces — which is why the
 * tool descriptions append the mandate with the same `. ` boundary the prompt
 * uses.
 */
function headingsMandatedBy(text: string, label: string): string[] {
  const mandate = briefHeadingMandate();
  const marker = mandate.slice(0, mandate.indexOf(briefHeadingList()));
  const at = text.indexOf(marker);
  if (at < 0) {
    throw new Error(
      `${label} no longer renders the brief-heading mandate; an attached coordinator is being told a different contract than MUON verifies.`
    );
  }
  const tail = text.slice(at + marker.length);
  return tail
    .slice(0, tail.indexOf(". "))
    .split(/:\s*/)
    .map((heading) => heading.trim())
    .filter(Boolean);
}

describe("brief-heading drift-lock (MCP tool descriptions ⟷ verifier)", () => {
  it("the `dispatch` description mandates EXACTLY the twelve the verifier counts, in order", () => {
    expect(
      headingsMandatedBy(shippedDescription("dispatch"), "dispatch.description")
    ).toEqual([...CHILD_BRIEF_HEADINGS]);
  });

  it("the `brief` argument mandates them too, and quotes a skeleton MUON accepts", () => {
    const brief = (
      tool("dispatch").inputSchema as {
        properties?: { brief?: { description?: string } };
      }
    ).properties?.brief?.description;
    expect(brief).toBeTruthy();
    expect(headingsMandatedBy(brief!, "dispatch.brief")).toEqual([
      ...CHILD_BRIEF_HEADINGS,
    ]);
    // The example the argument hands out is one the verifier passes. A remedy
    // MUON would itself reject costs the corrective round it was meant to save.
    expect(missingBriefHeadings(brief!)).toEqual([]);
  });

  it("`create_task` renders the filed-task subset, and names nothing else", () => {
    const description = shippedDescription("create_task");
    expect(description).toContain(taskHeadingList());
    expect(headingsNamedBy(description)).toEqual([...CREW_TASK_HEADINGS]);
  });

  it("`delegate` teaches the whole list too — the FIFTH instance was here", () => {
    // It said "copy GOAL, SCOPE, CHECKS, and AUTHORITY" — three of twelve plus
    // the `SCOPE` alias. `briefHeadingList()` and not the full mandate because a
    // GRANDCHILD's brief is not what `verifyCrewProof` counts; see the comment on
    // the description itself.
    const description = shippedDescription("delegate");
    expect(description).toContain(briefHeadingList());
    expect(headingsNamedBy(description)).toEqual([...CHILD_BRIEF_HEADINGS]);
  });

  it("no shipped description ANYWHERE on the MCP surface names a PARTIAL heading list", () => {
    for (const definition of everyTool()) {
      for (const { label, text } of readableTexts(definition)) {
        const named = headingsNamedBy(text);
        expect(
          namesCompleteContract(named),
          `${label} names a partial heading list (${named.join(", ")}); render it from the contract instead of restating it`
        ).toBe(true);
      }
    }
  });

  it("BITES: the exact prose that shipped the fourth drift is rejected", () => {
    // Verbatim from `orchestrator-tools.ts` at e142767^ — the description a live
    // coordinator followed to write ten of twelve headings.
    const drifted =
      "The brief is a one-shot contract, and its first two headings are the ones " +
      "MUON's dispatch contract VERIFIES — write them with these exact words: " +
      "`ROLE:` (verbatim from the filed task) and `OWNED SCOPE:` (the same paths " +
      "the filed task declares). A brief that opens with GOAL:/SCOPE: instead " +
      "declares no role and does not count. Then include GOAL, MODE, CONTEXT, " +
      "GRAPH DISCIPLINE (code_query FIRST — before any file read or grep; " +
      "code_context to confirm named symbols; atomic preflight_edit with exact " +
      "target + filePath before edits), DELIVERABLES, CHECKS, AUTHORITY, STOP " +
      "CONDITION.";
    const named = headingsNamedBy(drifted);
    expect(named).toHaveLength(CHILD_BRIEF_HEADINGS.length - 2);
    expect(named).not.toContain("COORDINATION");
    expect(named).not.toContain("FINAL REPORT");
    expect(namesCompleteContract(named)).toBe(false);
    // …and the shipped description, on the same predicate, passes.
    expect(
      namesCompleteContract(headingsNamedBy(shippedDescription("dispatch")))
    ).toBe(true);
  });

  it("BITES: dropping any ONE heading from the contract fails the predicate", () => {
    for (const omitted of CHILD_BRIEF_HEADINGS) {
      const partial = CHILD_BRIEF_HEADINGS.filter(
        (heading) => heading !== omitted
      );
      expect(namesCompleteContract(partial), omitted).toBe(false);
    }
  });
});
