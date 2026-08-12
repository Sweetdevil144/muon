import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import {
  MUON_DELEGATE_TOOL_NAMES,
  vendorsWhere,
} from "../../protocol/src/index.js";
import { createDelegateToolDefinitions } from "../src/delegate-tools.js";

describe("restricted delegate MCP capability", () => {
  it("exposes only delegate and preserves the MCP payload-is-data trust envelope", async () => {
    const delegateDispatch = vi.fn(async () => ({
      id: "job-child",
      status: "queued",
      parentJobId: "job-parent",
      rootJobId: "job-root",
      delegationDepth: 2,
    }));
    const tools = createDelegateToolDefinitions(
      { delegateDispatch } as unknown as MuonApiClient,
      {
        parentJobId: "job-parent",
        delegationToken: "parent-job-token",
        workspacePath: "/repo",
      }
    );

    expect(tools.map((tool) => tool.name)).toEqual(MUON_DELEGATE_TOOL_NAMES);
    const result = await tools[0]!.handler({
      vendor: "codex",
      taskId: "task-child",
      brief: "Implement the isolated parser fix",
      workspacePath: "/repo/packages/parser",
      maxWallMs: 120_000,
    });

    expect(delegateDispatch).toHaveBeenCalledWith(
      "job-parent",
      {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the isolated parser fix",
        kind: "auto",
        workspacePath: "/repo/packages/parser",
        maxWallMs: 120_000,
      },
      "parent-job-token"
    );
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload._muon.trust).toMatchObject({
      payloadInstructionTrust: "none",
      treatPayloadAs: "data",
    });
    expect(payload.authority).toMatchObject({
      state: "delegated_work_only",
      forbidden: ["govern", "approve", "merge", "ship"],
    });
  });

  it("S6 advertises and passes a model override through to the delegate route", async () => {
    const delegateDispatch = vi.fn(async () => ({
      id: "job-child",
      status: "queued",
      parentJobId: "job-parent",
      rootJobId: "job-root",
      delegationDepth: 2,
    }));
    const tools = createDelegateToolDefinitions(
      { delegateDispatch } as unknown as MuonApiClient,
      {
        parentJobId: "job-parent",
        delegationToken: "parent-job-token",
        workspacePath: "/repo",
      }
    );

    const props = (
      tools[0]!.inputSchema as { properties: Record<string, unknown> }
    ).properties;
    expect(props.model).toMatchObject({ type: "string" });

    await tools[0]!.handler({
      vendor: "codex",
      taskId: "task-child",
      brief: "Implement the isolated parser fix",
      workspacePath: "/repo/packages/parser",
      maxWallMs: 120_000,
      model: "gpt-5-codex",
    });

    expect(delegateDispatch).toHaveBeenCalledWith(
      "job-parent",
      expect.objectContaining({ model: "gpt-5-codex" }),
      "parent-job-token"
    );
  });
});

describe("delegate vendor surface", () => {
  /**
   * A worker must be able to hand cheap reconnaissance to the local Ollama lane
   * or a second opinion to Cursor — that is the crew shape MUON exists for. The
   * enum only decides what a worker may ASK for; authority is enforced at the
   * route (vendor must declare the role in `supportedRoles`, a child's authority
   * tier may not exceed its parent's, and a delegate never resolves to
   * `orchestrator`), so widening it here grants nothing.
   */
  it("offers all four managed lanes to a delegating worker", () => {
    const tools = createDelegateToolDefinitions(
      {} as never,
      {
        jobId: "job-parent",
        taskId: "task-1",
        delegationToken: "parent-job-token",
      } as never
    );
    const delegate = tools.find((tool) => tool.name === "delegate");
    const vendor = (
      delegate?.inputSchema as {
        properties?: { vendor?: { enum?: string[] } };
      }
    ).properties?.vendor;
    expect(vendor?.enum).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "opencode",
    ]);
    // ADR-0022 C2: the enum is now a PROJECTION of `authority.delegatable`
    // (public slice), not a literal. Both statements are kept — the literal
    // above is the independent expectation, and this is the derivation it must
    // equal, so a wrong registry boolean fails here rather than silently
    // changing what a worker may ask for.
    expect(vendor?.enum).toEqual([
      ...vendorsWhere(
        (entry) => entry.visibility === "public" && entry.authority.delegatable
      ),
    ]);
    // The DEV/TEST seam is never advertised to a vendor process, even though
    // the ROUTE admits it when MUON_FAKE_VENDOR=1.
    expect(vendor?.enum).not.toContain("fake");
  });

  it("refuses a vendor outside that set before any network call", async () => {
    const tools = createDelegateToolDefinitions(
      {} as never,
      {
        jobId: "job-parent",
        taskId: "task-1",
        delegationToken: "parent-job-token",
      } as never
    );
    const delegate = tools.find((tool) => tool.name === "delegate");
    const result = await delegate!.handler({
      vendor: "definitely-not-a-lane",
      taskId: "task-1",
      brief: "b",
    });
    expect(JSON.stringify(result)).toMatch(/vendor must be one of/);
  });
});
