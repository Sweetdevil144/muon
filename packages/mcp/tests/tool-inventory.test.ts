import { describe, expect, it } from "vitest";
import type { MuonApiClient } from "@muon/client";
import {
  MUON_ATTACHED_COORDINATOR_TOOL_NAMES,
  MUON_CONTEXT_TOOL_NAMES,
  MUON_CONTROL_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES,
  MUON_DELEGATE_CAPABILITY_TOOL_NAMES,
  MUON_DELEGATE_TOOL_NAMES,
  MUON_ORCHESTRATOR_TOOL_NAMES,
  MUON_OBSERVER_TOOL_NAMES,
} from "../../protocol/src/index.js";
import {
  createAttachedCoordinatorToolDefinitions,
  createDelegateModeToolDefinitions,
  createDelegateToolDefinitions,
  createOrchestratorToolDefinitions,
  createObserverToolDefinitions,
  createToolDefinitions,
} from "../src/index.js";

function inertClient(): MuonApiClient {
  return {} as MuonApiClient;
}

describe("runtime MCP tool inventory", () => {
  it("matches the protocol inventory exactly in both modes", () => {
    const client = inertClient();
    const contextNames = createToolDefinitions(client, {}).map(
      (tool) => tool.name
    );
    const controlNames = createOrchestratorToolDefinitions(client, {
      apiBase: "http://127.0.0.1:4000",
    }).map((tool) => tool.name);
    const delegateNames = createDelegateToolDefinitions(client, {
      parentJobId: "job-parent",
      delegationToken: "parent-job-token",
      workspacePath: "/repo",
    }).map((tool) => tool.name);
    const observerNames = createObserverToolDefinitions(client, {
      apiBase: "http://127.0.0.1:4000",
      apiToken: "agent-token",
      chatId: "chat-a",
    }).map((tool) => tool.name);

    // Every worker session carries the A2A coordination tier alongside the
    // context tier — peers can only coordinate if the tools reach the workers,
    // not just the coordinator.
    expect(contextNames).toEqual([
      ...MUON_CONTEXT_TOOL_NAMES,
      ...MUON_COORDINATION_TOOL_NAMES,
    ]);
    expect(controlNames).toEqual(MUON_CONTROL_TOOL_NAMES);
    expect(delegateNames).toEqual(MUON_DELEGATE_TOOL_NAMES);
    expect(observerNames).toEqual(MUON_OBSERVER_TOOL_NAMES);
    expect([...contextNames, ...controlNames]).toEqual(
      MUON_ORCHESTRATOR_TOOL_NAMES
    );
  });

  it("ADR-0028 Tier C: the attached coordinator's runtime tool set is exactly the unique MUON_ATTACHED_COORDINATOR_TOOL_NAMES set", () => {
    const client = inertClient();
    const baseTools = createToolDefinitions(client, {
      jobId: "attached-root-job",
      chatId: "attached-chat",
      apiBase: "http://127.0.0.1:4000",
      apiToken: "capability-token",
    });
    const tools = createAttachedCoordinatorToolDefinitions(client, baseTools, {
      jobId: "attached-root-job",
      delegationToken: "capability-token",
      chatId: "attached-chat",
      chatTaskId: "attached-chat-task",
      workspacePath: "/repo",
      apiBase: "http://127.0.0.1:4000",
      apiToken: "capability-token",
    });
    const names = tools.map((tool) => tool.name);

    // Every registered tool name is UNIQUE — an MCP server cannot register
    // `crew_roles` twice, so the runtime set collapses the protocol
    // membership list's deliberate duplicate (it lives in both the base
    // coordination tier and the observer tier) down to one definition: the
    // observer's chat-scoped read, which is what
    // `createObserverModeToolDefinitions` overrides it with.
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names)).toEqual(
      new Set(MUON_ATTACHED_COORDINATOR_TOOL_NAMES)
    );

    // Every one of the seven positively-granted control tools is present,
    // and none of the three explicitly excluded ones ever appear.
    for (const name of [
      "create_task",
      "dispatch",
      "steer",
      "interrupt",
      "ship",
      "assign_roles",
      "propose_workflow",
    ]) {
      expect(names).toContain(name);
    }
    for (const name of ["set_fleet", "raise_budget", "apply_workflow"]) {
      expect(names).not.toContain(name);
    }
  });

  it("keeps leaf delegates on the exact context+coordination inventory", () => {
    const client = inertClient();
    const context = createToolDefinitions(client, {});
    const leaf = createDelegateModeToolDefinitions(client, context, {
      parentJobId: "job-leaf",
      canDelegate: false,
      workspacePath: "/repo",
    });

    expect(leaf.map((tool) => tool.name)).toEqual([
      ...MUON_CONTEXT_TOOL_NAMES,
      ...MUON_COORDINATION_TOOL_NAMES,
    ]);
    // …which is exactly the delegate capability grant minus `delegate` itself.
    expect(leaf.map((tool) => tool.name)).toEqual(
      MUON_DELEGATE_CAPABILITY_TOOL_NAMES.filter(
        (name) =>
          !MUON_DELEGATE_TOOL_NAMES.includes(
            name as (typeof MUON_DELEGATE_TOOL_NAMES)[number]
          )
      )
    );
  });
});
