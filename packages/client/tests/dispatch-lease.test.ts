import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/api-client.js";

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

const job = {
  id: "job-1",
  kind: "oneshot",
  vendor: "codex",
  taskId: "task-1",
  brief: "fix it",
  status: "running",
  agentId: "agent-1",
  host: "desktop-mac",
  runnerLeaseHash: "hash",
  dispatchedBy: "orchestrator",
  interruptRequested: false,
  steerMessages: [],
  createdAt: "2026-07-13T00:00:00.000Z",
};

const agent = {
  id: "agent-1",
  vendor: "codex",
  name: "codex-1",
  ordinal: 1,
  status: "working",
  currentTaskId: "task-1",
  currentJobId: "job-1",
  sessionId: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
};

describe("MuonApiClient lease-aware dispatch methods", () => {
  it("sends the exact lease coordinates for claim, terminal, reclaim, and heartbeat", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ job, agent }, 201))
      .mockResolvedValueOnce(response({ job: { ...job, status: "done" } }))
      .mockResolvedValueOnce(response({ reclaimed: 1, jobIds: ["job-old"] }))
      .mockResolvedValueOnce(response({ runner: { host: "desktop-mac" } }))
      .mockResolvedValueOnce(response({ messages: ["continue"] }))
      .mockResolvedValueOnce(response({ job }));
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "agent-token"
    );
    const leaseToken = `lease-${"l".repeat(58)}`;

    await client.claimDispatchJobAndAgentForLease({
      jobId: "job-1",
      host: "desktop-mac",
      leaseToken,
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:4000/api/dispatch/job-1/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ host: "desktop-mac", leaseToken }),
      })
    );

    await client.updateDispatchJobForLease({
      jobId: "job-1",
      host: "desktop-mac",
      leaseToken,
      status: "done",
      result: "ok",
      exitCode: 0,
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:4000/api/dispatch/job-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          host: "desktop-mac",
          leaseToken,
          status: "done",
          result: "ok",
          exitCode: 0,
        }),
      })
    );

    await client.reclaimDispatchJobs("desktop-mac", leaseToken);
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:4000/api/dispatch/reclaim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ host: "desktop-mac", leaseToken }),
      })
    );

    await client.runnerHeartbeat("desktop-mac", 42, leaseToken);
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:4000/api/runner/heartbeat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          host: "desktop-mac",
          pid: 42,
          leaseToken,
        }),
      })
    );

    await client.drainDispatchSteer("job-1", {
      host: "desktop-mac",
      leaseToken,
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:4000/api/dispatch/job-1/steer/drain",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ host: "desktop-mac", leaseToken }),
      })
    );

    await client.requeueDispatchSteer(
      "job-1",
      "continue",
      { host: "desktop-mac", leaseToken }
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      6,
      "http://127.0.0.1:4000/api/dispatch/job-1/steer/requeue",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          host: "desktop-mac",
          leaseToken,
          message: "continue",
        }),
      })
    );
  });

  it("posts the cwd the vendor actually ran in under the same lease", async () => {
    const worktree = "/repo/.muon/worktrees/task-1";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ executionPath: worktree }));
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "agent-token"
    );
    const leaseToken = `lease-${"l".repeat(58)}`;

    const recorded = await client.recordDispatchExecutionPathForLease({
      jobId: "job-1",
      executionPath: worktree,
      host: "desktop-mac",
      leaseToken,
    });

    expect(recorded.executionPath).toBe(worktree);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/dispatch/job-1/execution-path",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          executionPath: worktree,
          host: "desktop-mac",
          leaseToken,
        }),
      })
    );
  });

  it("reads a job with, and a pre-0039 job without, an execution path", async () => {
    const worktree = "/repo/.muon/worktrees/task-1";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ job: { ...job, executionPath: worktree } })
      )
      // Exactly the shape of a row written before the column existed: the key
      // is simply absent, and that must parse as "unknown", not fail.
      .mockResolvedValueOnce(response({ job }));
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "agent-token"
    );

    await expect(client.getDispatchJob("job-1")).resolves.toMatchObject({
      executionPath: worktree,
    });
    const legacy = await client.getDispatchJob("job-1");
    expect(legacy.executionPath ?? null).toBeNull();
  });

  it("writes and reads context evidence through encoded, lease-bound routes", async () => {
    const frame = {
      id: "frame-1",
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      jobId: "job/1",
      taskId: "task-1",
      laneId: "lane-codex",
      missionId: "job/1",
      turnSeq: 1,
      source: "dispatch",
      completeness: "muon_supplied",
      content: "exact prompt",
      contentSha256: `sha256:${"a".repeat(64)}`,
      charCount: 12,
      tokenEstimate: 3,
      createdAt: "2026-08-01T00:00:00.000Z",
      exposures: [],
      delivery: null,
    };
    const condensation = {
      id: "condensation-1",
      jobId: "job/1",
      taskId: "task-1",
      origin: "vendor_reported",
      sourceResponseId: "codex:item:compact-1",
      createdAt: "2026-08-01T00:00:01.000Z",
      members: [],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ frame }, 201))
      .mockResolvedValueOnce(
        response({
          frame: {
            ...frame,
            delivery: {
              id: "delivery-1",
              frameId: frame.id,
              status: "delivered",
              createdAt: "2026-08-01T00:00:00.500Z",
            },
          },
        }, 201)
      )
      .mockResolvedValueOnce(response({ condensation }, 201))
      .mockResolvedValueOnce(
        response({
          frames: [frame],
          condensations: [condensation],
          condensationsTruncated: false,
        })
      )
      .mockResolvedValueOnce(response({ frame }));
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "agent-token"
    );
    const leaseToken = `lease-${"l".repeat(58)}`;

    await client.beginContextFrameForLease({
      jobId: "job/1",
      host: "desktop-mac",
      leaseToken,
      clientRequestId: frame.clientRequestId,
      source: "dispatch",
      content: frame.content,
      exposures: [],
    });
    await client.completeContextFrameForLease({
      jobId: "job/1",
      frameId: frame.id,
      host: "desktop-mac",
      leaseToken,
      status: "delivered",
    });
    await client.recordContextCondensationForLease({
      jobId: "job/1",
      host: "desktop-mac",
      leaseToken,
      origin: "vendor_reported",
      sourceResponseId: condensation.sourceResponseId,
      members: [],
    });
    await client.listJobContext("job/1", {
      afterTurn: 0,
      limit: 10,
      condensationLimit: 5,
      afterCondensation: "condensation-0",
    });

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "http://127.0.0.1:4000/api/dispatch/job%2F1/context/frames",
      "http://127.0.0.1:4000/api/dispatch/job%2F1/context/frames/frame-1/delivery",
      "http://127.0.0.1:4000/api/dispatch/job%2F1/context/condensations",
      "http://127.0.0.1:4000/api/dispatch/job%2F1/context?afterTurn=0&limit=10&condensationLimit=5&afterCondensation=condensation-0",
    ]);
  });
});
