import { afterEach, describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { AGENT_ROLES } from "@muon/protocol";
import {
  createOrchestratorToolDefinitions,
  type OrchestratorScope,
} from "../src/orchestrator-tools.js";

// `assign_roles` is the WRITE side of role assignment and the only control-tier
// tool in the A2A/roles slice. It authenticates exactly like the other
// orchestrator control tools (the agent bearer + the tool's own chat scope);
// it is not an operator-only path, because the super-orchestrator only ever
// holds the agent token.

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SCOPE: OrchestratorScope = {
  jobId: "job-root",
  delegationToken: "root-job-token",
  chatId: "chat-1",
  chatTaskId: "task-shadow",
  apiBase: "http://localhost:4000",
  apiToken: "orchestrator-agent-bearer",
};

function tool(scope: OrchestratorScope = SCOPE) {
  const found = createOrchestratorToolDefinitions(
    {} as MuonApiClient,
    scope
  ).find((entry) => entry.name === "assign_roles");
  if (!found) throw new Error("assign_roles not found");
  return found;
}

function stubFetch(...responses: Response[]) {
  const fetcher = vi.fn(async () => responses.shift() ?? json({}));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    chatId: "chat-1",
    bindings: [
      {
        vendor: "claude-code",
        role: "implementer",
        fit: 0.91,
        reason: "supports worktrees and streams events",
        assignedBy: "muon",
        blocked: false,
      },
      {
        vendor: "codex",
        role: "reviewer",
        fit: 0.64,
        reason: "operator pinned an adversarial reviewer on another vendor",
        assignedBy: "human",
        blocked: false,
      },
    ],
    unfilled: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assign_roles", () => {
  it("takes no chat argument and posts the orchestrator's OWN chat", async () => {
    const fetcher = stubFetch(json({ plan: plan() }));
    const schema = tool().inputSchema as {
      properties: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["pin", "roles"]);
    expect(schema.additionalProperties).toBe(false);

    await tool().handler({ roles: ["implementer", "reviewer"] });

    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("http://localhost:4000/api/crew/roles");
    expect(init.method).toBe("POST");
    // Agent-tier auth, same as every other orchestrator control tool.
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer orchestrator-agent-bearer"
    );
    expect(JSON.parse(String(init.body))).toEqual({
      chatId: "chat-1",
      roles: ["implementer", "reviewer"],
    });
  });

  it("fails closed with no chat in scope rather than assigning globally", async () => {
    const fetcher = stubFetch();
    const result = await tool({ ...SCOPE, chatId: undefined }).handler({});
    expect(result.isError).toBe(true);
    expect(String(result.structuredContent?.error)).toMatch(/own chat/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards pins verbatim and rejects malformed ones before the request", async () => {
    const fetcher = stubFetch(json({ plan: plan() }));
    await tool().handler({ pin: [{ role: "reviewer", vendor: "codex" }] });
    const [, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      chatId: "chat-1",
      pinned: { reviewer: "codex" },
    });

    for (const args of [
      { roles: ["superuser"] },
      { pin: [{ role: "superuser", vendor: "codex" }] },
      { pin: [{ role: "reviewer" }] },
      { pin: [{ role: "reviewer", vendor: "  " }] },
      { roles: Array.from({ length: AGENT_ROLES.length + 1 }, () => "qa") },
    ]) {
      const result = await tool().handler(args);
      expect(result.isError).toBe(true);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports an operator pin as the human's choice, not the coordinator's", async () => {
    stubFetch(json({ plan: plan() }));
    const result = await tool().handler({});
    const payload = result.structuredContent as Record<string, unknown>;

    expect(payload.humanPinned).toEqual(["reviewer"]);
    expect(String(payload.note)).toMatch(/pinned by the operator/i);
    const bindings = payload.bindings as Record<string, unknown>[];
    expect(bindings[1]).toMatchObject({
      role: "reviewer",
      vendor: "codex",
      assignedBy: "human",
      // The role's own authority ceiling rides along, so the model can see the
      // narrowing rather than inferring it.
      authority: "read-only",
    });
    const muon = payload._muon as Record<string, unknown>;
    expect((muon.coordination as Record<string, unknown>).humanPinned).toBe(1);
    expect(muon.nextActions).toEqual(
      expect.arrayContaining([expect.stringMatching(/Operator-pinned/)])
    );
  });

  it("degrades explicitly when a role has no lane that can hold it", async () => {
    stubFetch(json({ plan: plan({ unfilled: ["qa", "docs"] }) }));
    const result = await tool().handler({});
    const muon = (result.structuredContent as Record<string, unknown>)
      ._muon as Record<string, unknown>;
    const degradation = muon.degradation as Record<string, unknown>;
    expect(degradation.active).toBe(true);
    expect(String(degradation.reason)).toMatch(/qa, docs/);
  });

  it("states the narrowing contract and the preserved human pin in its description", () => {
    const description = tool().description;
    expect(description).toMatch(/NARROWING/);
    expect(description).toMatch(/never the reverse/);
    expect(description).toMatch(/assignedBy 'human'/);
    expect(tool().contract?.sideEffects).toMatch(/never widens it/);
  });

  it("names itself the COMMIT, so a preview is never mistaken for this", async () => {
    // `crew_roles` reports an unbound chat's crew as `proposed`. This tool is
    // the only thing that turns one into a decision, and the coordinator has to
    // be able to tell the human which of the two it is looking at.
    expect(tool().description).toMatch(/COMMIT/);
    stubFetch(json({ plan: plan() }));
    const payload = (await tool().handler({}))
      .structuredContent as Record<string, unknown>;
    expect(payload.planStatus).toBe("assigned");
    expect(String(payload.note)).toMatch(/^ASSIGNED/);
    expect(String(payload.note)).toMatch(/replaces any proposed plan/);
  });

  it("surfaces a route refusal instead of claiming the crew was assigned", async () => {
    stubFetch(new Response("chat is not yours", { status: 403 }));
    const result = await tool().handler({});
    expect(result.isError).toBe(true);
    expect(String(result.structuredContent?.error)).toMatch(/403/);
  });
});
