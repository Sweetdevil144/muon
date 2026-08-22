import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "@muon/client";
import { createToolDefinitions, type ToolDefinition } from "../src/handlers.js";

// H5 — pending gates and pending memory as MCP COORDINATES.
//
// The whole tool is a promise about what it does NOT do: it names ids so a
// human can act, and it never carries the text those ids point at, never
// decides anything, and never mentions a partition it does not own. Every
// assertion below pins one of those.

function reviewQueue(
  client: MuonApiClient,
  scope: Record<string, unknown> = { chatId: "chat-a", jobId: "job-1" }
): ToolDefinition {
  const tool = createToolDefinitions(client, scope).find(
    (entry) => entry.name === "review_queue"
  );
  if (!tool) throw new Error("review_queue is not registered");
  return tool;
}

/** A client whose reads are the only thing this tool can see. */
function fakeClient(overrides: Record<string, unknown>): MuonApiClient {
  return {
    listTasks: vi.fn(async () => []),
    listApprovals: vi.fn(async () => []),
    listPendingMemory: vi.fn(async () => ({
      notes: [],
      total: 0,
      totalExact: true,
      truncated: false,
    })),
    ...overrides,
  } as unknown as MuonApiClient;
}

async function body(tool: ToolDefinition): Promise<Record<string, any>> {
  const result = await tool.handler({});
  return JSON.parse(result.content[0]!.text as string);
}

const MINE = {
  id: "task-mine",
  title: "mine",
  description: "",
  status: "in_progress",
  priority: "medium",
  chatId: "chat-a",
};
const THEIRS = { ...MINE, id: "task-theirs", chatId: "chat-b" };

describe("review_queue names what waits on the human, as coordinates", () => {
  it("returns pending gate ids with kind, task, gateTag and age — and no reason prose", async () => {
    const client = fakeClient({
      listTasks: vi.fn(async () => [MINE]),
      listApprovals: vi.fn(async () => [
        {
          id: "approval-1",
          taskId: "task-mine",
          requestedBy: "muon-orchestrator",
          kind: "gate",
          // The failure this prevents: an approval's `reason` is AGENT-authored
          // prose. Surfacing it here would turn a coordinate read into an
          // untrusted-text channel on the base tier.
          reason: "[gate:set_fleet] SECRET-REASON-TEXT",
          status: "pending",
          gateTag: "[gate:set_fleet claude-code=2]",
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ]),
    });
    const result = await reviewQueue(client).handler({});
    const payload = JSON.parse(result.content[0]!.text as string);
    expect(payload.pendingApprovals).toHaveLength(1);
    expect(payload.pendingApprovals[0]).toMatchObject({
      id: "approval-1",
      kind: "gate",
      taskId: "task-mine",
      gateTag: "[gate:set_fleet claude-code=2]",
    });
    expect(payload.pendingApprovals[0].ageMs).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("SECRET-REASON-TEXT");
  });

  it("returns pending unconfirmed note ids with kind and age — and never note text", async () => {
    const client = fakeClient({
      listPendingMemory: vi.fn(async () => ({
        notes: [
          {
            id: "mem-abc",
            kind: "constraint" as const,
            createdAt: new Date(Date.now() - 5_000).toISOString(),
          },
        ],
        total: 1,
        totalExact: true,
        truncated: false,
      })),
    });
    const result = await reviewQueue(client).handler({});
    const payload = JSON.parse(result.content[0]!.text as string);
    expect(payload.pendingMemory).toEqual([
      { noteId: "mem-abc", kind: "constraint", ageMs: expect.any(Number) },
    ]);
    // Coordinate-only by construction: the client method this rides carries no
    // text field at all, so there is nothing here that could leak one.
    expect(JSON.stringify(payload.pendingMemory)).not.toContain("text");
  });

  it("silently omits another chat's gates — it never names the foreign partition", async () => {
    // ADR-0033 partition honesty: a refusal that says "approval X is in chat
    // chat-b" is an existence oracle. Absence is the answer.
    const client = fakeClient({
      listTasks: vi.fn(async () => [MINE, THEIRS]),
      listApprovals: vi.fn(async () => [
        {
          id: "approval-foreign",
          taskId: "task-theirs",
          requestedBy: "muon-orchestrator",
          kind: "merge",
          reason: "foreign",
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      ]),
    });
    const result = await reviewQueue(client).handler({});
    const serialized = JSON.stringify(result);
    expect(JSON.parse(result.content[0]!.text as string).pendingApprovals).toEqual(
      []
    );
    expect(serialized).not.toContain("approval-foreign");
    expect(serialized).not.toContain("task-theirs");
    expect(serialized).not.toContain("chat-b");
  });

  it("lists only PENDING gates, not ones the human already decided", async () => {
    const client = fakeClient({
      listTasks: vi.fn(async () => [MINE]),
      listApprovals: vi.fn(async () => [
        {
          id: "approval-done",
          taskId: "task-mine",
          requestedBy: "x",
          kind: "merge",
          reason: "r",
          status: "approved",
          createdAt: new Date().toISOString(),
        },
      ]),
    });
    expect((await body(reviewQueue(client))).pendingApprovals).toEqual([]);
  });

  it("has no confirm or reject verb, and names the surfaces that do", async () => {
    const client = fakeClient({});
    const tool = reviewQueue(client);
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    const payload = await body(tool);
    expect(payload.nextSurface).toMatch(/Desktop approvals inbox/);
    expect(payload.nextSurface).toMatch(/muon approve resolve/);
    expect(payload.nextSurface).toMatch(/muon memory confirm/);
    // Stated, not implied: the tier cannot decide, so the tool must not read
    // as if calling it again with an argument might.
    expect(payload.nextSurface).toMatch(/no MCP tier can make it/);
  });

  it("is declared read-only and idempotent in its contract", () => {
    expect(reviewQueue(fakeClient({})).contract).toMatchObject({
      authority: "read",
      readOnly: true,
      destructive: false,
      idempotent: true,
    });
  });
});

describe("review_queue keeps 'could not read' apart from 'nothing pending'", () => {
  it("degrades one half without erasing the other, and says which half failed", async () => {
    // The exact confusion H2/H5 exist to end: an unavailable queue rendering as
    // an empty one, which reads as ship-ready.
    const client = fakeClient({
      listTasks: vi.fn(async () => {
        throw new Error("brain unreachable");
      }),
      listPendingMemory: vi.fn(async () => ({
        notes: [
          { id: "mem-1", kind: "decision" as const, createdAt: new Date().toISOString() },
        ],
        total: 1,
        totalExact: true,
        truncated: false,
      })),
    });
    const result = await reviewQueue(client).handler({});
    const payload = JSON.parse(result.content[0]!.text as string);
    expect(result.isError).toBeFalsy();
    expect(payload.coverage).toEqual({ gates: "unavailable", memory: "read" });
    expect(payload.pendingMemory).toHaveLength(1);
    expect(payload._muon.degradation.active).toBe(true);
    expect(payload._muon.degradation.reason).toMatch(/pending gates unavailable/);
    expect(payload._muon.degradation.action).toMatch(
      /do not report an empty queue/i
    );
  });

  it("refuses rather than answering 'clear' when the session has no partition", async () => {
    // A base install has no chat: an empty list there would be a CLAIM about a
    // partition it cannot see, which is the failure mode this whole tool is
    // supposed to remove.
    const client = fakeClient({});
    const result = await reviewQueue(client, {}).handler({});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text as string);
    expect(payload.error).toMatch(/needs a chat partition and this session has none/i);
    expect(payload.error).toMatch(/muon mcp attach/);
    // It must not have gone to the network to discover that.
    expect(client.listApprovals).not.toHaveBeenCalled();
  });
});
