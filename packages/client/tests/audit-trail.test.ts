import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/api-client.js";
import { buildAuditTrail } from "../src/audit-trail.js";
import type { RecordedEvent } from "../src/types.js";

const events: RecordedEvent[] = [
  {
    id: "event-1",
    laneId: "codex",
    taskId: "task-1",
    kind: "task.started",
    message: "Running the parser repair",
    metadata: {},
    timestamp: "2026-07-16T10:00:00.000Z",
  },
  {
    id: "event-2",
    laneId: "claude-code-1",
    taskId: "task-1",
    kind: "approval.requested",
    message: "Need permission to run the exact command",
    metadata: {},
    timestamp: "2026-07-16T10:01:00.000Z",
  },
];

describe("human-readable audit trail", () => {
  it("labels ledger payload text as bounded data, never instruction authority", () => {
    const trail = buildAuditTrail(events);

    expect(trail[0]).toMatchObject({
      actor: "Codex",
      headline: "Started work",
      detail: "Running the parser repair",
      payloadTrust: "data-only",
    });
    expect(trail[1]).toMatchObject({
      actor: "Claude Code 1",
      headline: "Requested a human decision",
      payloadTrust: "data-only",
    });
  });

  it("labels policy/receipt auto-allows so no non-human allow is invisible", () => {
    const trail = buildAuditTrail([
      {
        id: "event-3",
        laneId: "claude-code-1",
        taskId: "task-1",
        kind: "approval.auto",
        message: "policy allowed read: reads never change the workspace",
        metadata: { source: "policy", actionClass: "read" },
        timestamp: "2026-07-16T10:02:00.000Z",
      },
    ]);

    expect(trail[0]).toMatchObject({
      headline: "Auto-approved a policy-bound action",
      tone: "neutral",
      detail: "policy allowed read: reads never change the workspace",
      payloadTrust: "data-only",
    });
  });

  it("reads only the requested recent ledger bound", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ events }),
    })) as unknown as typeof fetch;
    const client = new MuonApiClient("http://127.0.0.1:4000", fetcher);

    await expect(client.listRecentEvents(25)).resolves.toHaveLength(2);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/events?limit=25",
      expect.any(Object)
    );
  });
});
