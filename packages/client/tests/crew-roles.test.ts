import { describe, expect, it, vi } from "vitest";
import type { CrewRolePlan } from "@muon/protocol";
import {
  assignCrewRoles,
  loadCrewRolePlan,
  loadCrewRoles,
  parseRolePin,
} from "../src/crew-roles.js";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const plan: CrewRolePlan = {
  version: 1,
  chatId: "chat-a",
  bindings: [
    {
      vendor: "claude-code",
      role: "implementer",
      fit: 0.92,
      reason: "supports worktrees and streams events",
      assignedBy: "muon",
      blocked: false,
    },
    {
      vendor: "codex",
      role: "reviewer",
      fit: 0.71,
      reason: "different vendor than the author, read-only narrowing applies",
      assignedBy: "human",
      blocked: false,
    },
  ],
  unfilled: ["qa"],
};

describe("crew roles client", () => {
  it("reads one chat's plan plus the lanes it was drawn from (operator)", async () => {
    const fetcher = vi.fn(async () =>
      json({
        plan,
        lanes: [
          { vendor: "claude-code", displayName: "Claude Code", health: "ready" },
          { vendor: "codex", displayName: "Codex", health: "ready", cost: 0.4 },
        ],
      })
    );

    const view = await loadCrewRoles({
      apiBase: "http://127.0.0.1:4000/",
      apiToken: "operator-token",
      chatId: "chat-a",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/crew/roles?chatId=chat-a",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer operator-token",
        }),
      })
    );
    expect(view.plan?.bindings).toHaveLength(2);
    expect(view.lanes[1]).toMatchObject({ vendor: "codex", cost: 0.4 });
  });

  it("degrades to a null plan when no roles have been assigned yet", async () => {
    const fetcher = vi.fn(async () =>
      json({ plan: null, planStatus: "none", lanes: [] })
    );
    const view = await loadCrewRoles({
      apiBase: "http://127.0.0.1:4000",
      chatId: "chat-a",
      fetcher,
    });
    expect(view.plan).toBeNull();
    expect(view.planStatus).toBe("none");
    expect(view.lanes).toEqual([]);
  });

  it("reads the agent-tier plan WITHOUT naming a chat", async () => {
    const fetcher = vi.fn(async () => json({ plan, planStatus: "assigned" }));
    const result = await loadCrewRolePlan({
      apiBase: "http://127.0.0.1:4000",
      apiToken: "job-bearer",
      fetcher,
    });
    const [url] = fetcher.mock.calls[0]! as [string, RequestInit];
    // The bearer selects the partition; a chatId here would be a scope the
    // caller named for itself.
    expect(url).toBe("http://127.0.0.1:4000/api/crew/roles");
    expect(url).not.toContain("chatId");
    expect(result.plan?.chatId).toBe("chat-a");
    expect(result.planStatus).toBe("assigned");
  });

  it("lets an attached observer name the chat explicitly", async () => {
    const fetcher = vi.fn(async () => json({ plan, planStatus: "assigned" }));
    await loadCrewRolePlan({
      apiBase: "http://127.0.0.1:4000",
      apiToken: "shared-agent-bearer",
      chatId: "chat-a",
      fetcher,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4000/api/crew/roles?chatId=chat-a"
    );
  });

  it("assigns roles for exactly one chat and sends pins as the route's role map", async () => {
    const fetcher = vi.fn(async () => json({ plan }));
    const assigned = await assignCrewRoles({
      apiBase: "http://127.0.0.1:4000",
      apiToken: "operator-token",
      chatId: "chat-a",
      roles: ["implementer", "reviewer"],
      pinned: [
        { role: "reviewer", vendor: "codex" },
        { role: "implementer", vendor: "claude-code" },
      ],
      fetcher,
    });

    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4000/api/crew/roles");
    expect(JSON.parse(String(init.body))).toEqual({
      chatId: "chat-a",
      roles: ["implementer", "reviewer"],
      pinned: { reviewer: "codex", implementer: "claude-code" },
    });
    expect(assigned.unfilled).toEqual(["qa"]);
  });

  it("refuses two conflicting pins for one role instead of silently dropping one", async () => {
    const fetcher = vi.fn(async () => json({ plan }));
    await expect(
      assignCrewRoles({
        apiBase: "http://127.0.0.1:4000",
        apiToken: "operator-token",
        chatId: "chat-a",
        pinned: [
          { role: "reviewer", vendor: "codex" },
          { role: "reviewer", vendor: "claude-code" },
        ],
        fetcher,
      })
    ).rejects.toThrow(/conflicting pins for role 'reviewer'/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses an unknown role locally rather than posting it", async () => {
    const fetcher = vi.fn(async () => json({ plan }));
    await expect(
      assignCrewRoles({
        apiBase: "http://127.0.0.1:4000",
        apiToken: "operator-token",
        chatId: "chat-a",
        roles: ["superuser" as never],
        fetcher,
      })
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces the route's refusal reason", async () => {
    const fetcher = vi.fn(async () =>
      new Response("chat is not yours", { status: 403 })
    );
    await expect(
      loadCrewRoles({
        apiBase: "http://127.0.0.1:4000",
        apiToken: "operator-token",
        chatId: "chat-b",
        fetcher,
      })
    ).rejects.toThrow(/403.*chat is not yours/);
  });
});

// A plan the route COMPUTED for an unbound chat is not a plan anyone committed
// to. The client's job is to carry that difference to every surface intact —
// and to answer honestly for a brain that predates the field.
describe("proposed vs assigned", () => {
  it("carries planStatus 'proposed' through the operator read", async () => {
    const fetcher = vi.fn(async () =>
      json({ plan, planStatus: "proposed", lanes: [] })
    );
    const view = await loadCrewRoles({
      apiBase: "http://127.0.0.1:4000",
      apiToken: "operator-token",
      chatId: "chat-a",
      fetcher,
    });
    expect(view.planStatus).toBe("proposed");
    // The plan itself is unchanged — only the claim about it differs.
    expect(view.plan?.bindings).toHaveLength(2);
  });

  it("carries planStatus 'proposed' through the agent read too", async () => {
    const fetcher = vi.fn(async () => json({ plan, planStatus: "proposed" }));
    const result = await loadCrewRolePlan({
      apiBase: "http://127.0.0.1:4000",
      apiToken: "job-bearer",
      fetcher,
    });
    expect(result.planStatus).toBe("proposed");
  });

  it("reads an older brain's plan as 'assigned' — it could only ever be stored", async () => {
    const fetcher = vi.fn(async () => json({ plan, lanes: [] }));
    const view = await loadCrewRoles({
      apiBase: "http://127.0.0.1:4000",
      apiToken: "operator-token",
      chatId: "chat-a",
      fetcher,
    });
    // A brain without the field never previewed, so a plan from one is a
    // decision. Defaulting the other way would understate every real crew.
    expect(view.planStatus).toBe("assigned");
  });

  it("reads an older brain's absent plan as 'none', never 'assigned'", async () => {
    const fetcher = vi.fn(async () => json({ plan: null, lanes: [] }));
    const view = await loadCrewRoles({
      apiBase: "http://127.0.0.1:4000",
      apiToken: "operator-token",
      chatId: "chat-a",
      fetcher,
    });
    expect(view.planStatus).toBe("none");
  });

  it("refuses a planStatus outside the vocabulary rather than passing it on", async () => {
    const fetcher = vi.fn(async () =>
      json({ plan, planStatus: "probably", lanes: [] })
    );
    // The strict readers exist for agent surfaces: an unrecognized claim about
    // whether a crew is committed is a schema deviation, not a value to guess at.
    await expect(
      loadCrewRoles({
        apiBase: "http://127.0.0.1:4000",
        apiToken: "operator-token",
        chatId: "chat-a",
        fetcher,
      })
    ).rejects.toThrow();
  });
});

describe("parseRolePin", () => {
  it("parses role=vendor", () => {
    expect(parseRolePin("reviewer=codex")).toEqual({
      role: "reviewer",
      vendor: "codex",
    });
  });

  it("rejects an unknown role, a missing vendor, and a missing separator", () => {
    for (const bad of ["superuser=codex", "reviewer=", "codex", "=codex"]) {
      expect(() => parseRolePin(bad)).toThrow(/--pin must be <role>=<vendor>/);
    }
  });
});
