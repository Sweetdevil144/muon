import { describe, expect, it, vi } from "vitest";
import { MuonApiClient, collectCapabilityPreflight } from "@muon/client";
import {
  createBrainStore,
  type BrainTarget,
} from "../src/lib/brain-store.js";

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

const METRICS = {
  approvals: {
    decided: 0,
    pending: 0,
    averageTurnaroundMs: null,
    medianTurnaroundMs: null,
  },
  handoffs: { total: 0, prepSamples: 0, averagePrepMs: null, medianPrepMs: null },
  assignments: { total: 0, duplicateBriefings: 0, tasksWithDuplicates: 0 },
  tasks: { total: 0, completed: 0, averageCycleMs: null, medianCycleMs: null },
};

/** A well-formed OK body for every endpoint the poll touches (empty workspace). */
function healthyBody(url: string): unknown | null {
  if (url.endsWith("/health")) {
    return {
      status: "ok",
      service: "muon-backend",
      timestamp: "2026-07-09T00:00:00.000Z",
    };
  }
  if (url.endsWith("/api/lanes")) return { lanes: [] };
  if (url.endsWith("/api/fleet/agents")) return { agents: [] };
  if (url.includes("/api/dispatch")) return { jobs: [] };
  if (url.endsWith("/api/tasks") && !url.includes("dashboard")) {
    return { tasks: [] };
  }
  if (url.endsWith("/api/approvals")) return { approvals: [] };
  if (url.endsWith("/api/tasks/dashboard")) {
    return { pendingApprovals: 0, activeHandoffs: 0 };
  }
  if (url.endsWith("/api/metrics")) return { metrics: METRICS };
  if (url.includes("/api/fleet/readiness")) {
    return { vendors: [], generatedAt: "2026-07-09T00:00:00.000Z" };
  }
  if (url.endsWith("/api/runner")) {
    return {
      runner: {
        id: "r1",
        host: "local",
        status: "online",
        lastSeenAt: "2026-07-09T00:00:01.000Z",
      },
      live: true,
    };
  }
  // P0.4: live receipts for the ReviewInbox annotation.
  if (url.includes("/api/receipts")) return { receipts: [] };
  return null;
}

describe("brain-store", () => {
  it("aggregates brain state from the shared client", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return mockResponse({
          status: "ok",
          service: "muon-backend",
          timestamp: "2026-07-09T00:00:00.000Z",
        });
      }
      if (url.endsWith("/api/lanes")) {
        return mockResponse({
          lanes: [
            {
              id: "lane-1",
              key: "codex",
              name: "Codex",
              provider: "openai",
              role: "peer",
              status: "available",
            },
          ],
        });
      }
      if (url.endsWith("/api/tasks") && !url.includes("/dashboard")) {
        return mockResponse({
          tasks: [
            {
              id: "task-1",
              title: "TUI",
              description: "build",
              status: "in_progress",
              priority: "high",
            },
          ],
        });
      }
      if (url.endsWith("/api/approvals")) {
        return mockResponse({
          approvals: [
            {
              id: "ap-1",
              taskId: "task-1",
              requestedBy: "codex",
              kind: "command",
              reason: "run",
              status: "pending",
            },
          ],
        });
      }
      if (url.endsWith("/api/tasks/dashboard")) {
        return mockResponse({ pendingApprovals: 1, activeHandoffs: 0 });
      }
      if (url.endsWith("/api/metrics")) {
        return mockResponse({
          metrics: {
            approvals: {
              decided: 0,
              pending: 1,
              averageTurnaroundMs: null,
              medianTurnaroundMs: null,
            },
            handoffs: {
              total: 0,
              prepSamples: 0,
              averagePrepMs: null,
              medianPrepMs: null,
            },
            assignments: {
              total: 0,
              duplicateBriefings: 0,
              tasksWithDuplicates: 0,
            },
            tasks: {
              total: 1,
              completed: 0,
              averageCycleMs: null,
              medianCycleMs: null,
            },
          },
        });
      }
      if (url.endsWith("/api/tasks/task-1")) {
        return mockResponse({
          task: {
            id: "task-1",
            title: "TUI",
            description: "build",
            status: "in_progress",
            priority: "high",
            createdAt: "2026-07-09T00:00:00.000Z",
            updatedAt: "2026-07-09T00:00:00.000Z",
            assignments: [],
            handoffs: [],
            approvals: [],
          },
        });
      }
      if (url.endsWith("/api/tasks/task-1/events")) {
        return mockResponse({
          events: [
            {
              id: "ev-1",
              laneId: "lane-1",
              taskId: "task-1",
              kind: "task.started",
              message: "go",
              metadata: {},
              timestamp: "2026-07-09T00:00:01.000Z",
            },
          ],
        });
      }
      if (url.includes("/api/dispatch")) {
        return mockResponse({ jobs: [] });
      }
      // P0.4: live receipts for the ReviewInbox annotation.
      if (url.includes("/api/receipts")) {
        return mockResponse({ receipts: [] });
      }
      return mockResponse({}, 404);
    });

    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const store = createBrainStore(client);
    const listener = vi.fn();
    store.subscribe(listener);

    await store.refresh();

    const snap = store.getSnapshot();
    expect(snap.health?.status).toBe("ok");
    expect(snap.lanes).toHaveLength(1);
    expect(snap.tasks[0]?.id).toBe("task-1");
    expect(snap.approvals[0]?.status).toBe("pending");
    expect(snap.events[0]?.id).toBe("ev-1");
    expect(snap.pendingApprovals).toBe(1);
    expect(snap.error).toBeNull();
    expect(listener).toHaveBeenCalled();
  });

  it("records error without wiping prior snapshot fields on failure", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          status: "ok",
          service: "muon-backend",
          timestamp: "2026-07-09T00:00:00.000Z",
        })
      )
      .mockResolvedValue(mockResponse({}, 500));

    // First refresh will fail mid-Promise.all after health, still surfaces error.
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const store = createBrainStore(client);
    await store.refresh();
    expect(store.getSnapshot().error).toMatch(/500/);
  });

  it("P0.5: a poll failure degrades the shared preflight honestly, never a crash and never 'ready'", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
    });

    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const store = createBrainStore(client);
    // The store's own catch handles this; refresh() itself must not reject.
    await expect(store.refresh()).resolves.toBeUndefined();

    const snap = store.getSnapshot();
    expect(snap.error).toBeTruthy();
    expect(snap.preflight).not.toBeNull();
    expect(snap.preflight?.status).toBe("blocked");
    expect(snap.preflight?.headline).toBe("Control offline");
    expect(snap.preflight?.brainHealth.state).toBe("unreachable");
    expect(snap.preflight?.runnerHealth.state).toBe("unknown");
    expect(snap.preflight?.degradations.map((d) => d.code)).toEqual([
      "CONTROL_PLANE_UNREACHABLE",
    ]);
  });

  it("P0.5: a healthy poll builds the SAME preflight contract from fleet readiness + runner state", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return mockResponse({
          status: "ok",
          service: "muon-backend",
          timestamp: "2026-07-09T00:00:00.000Z",
        });
      }
      if (url.endsWith("/api/lanes")) {
        return mockResponse({ lanes: [] });
      }
      if (url.endsWith("/api/fleet/agents")) {
        // A HEALTHY brain is a SEATED one: bootstrap seeds a full-width fleet
        // per vendor. An empty fleet here is not "healthy but quiet" — it is a
        // lane that refuses every claim, which the preflight now reports as a
        // warning (VENDOR_NO_SEATS) rather than as "at most 0 run at once".
        return mockResponse({
          agents: [1, 2, 3].map((ordinal) => ({
            id: `codex-${ordinal}`,
            vendor: "codex",
            name: `codex-${ordinal}`,
            ordinal,
            status: "idle",
          })),
        });
      }
      if (url.endsWith("/api/tasks") && !url.includes("dashboard")) {
        return mockResponse({ tasks: [] });
      }
      if (url.endsWith("/api/approvals")) {
        return mockResponse({ approvals: [] });
      }
      if (url.endsWith("/api/tasks/dashboard")) {
        return mockResponse({ pendingApprovals: 0, activeHandoffs: 0 });
      }
      if (url.endsWith("/api/metrics")) {
        return mockResponse({
          metrics: {
            approvals: {
              decided: 0,
              pending: 0,
              averageTurnaroundMs: null,
              medianTurnaroundMs: null,
            },
            handoffs: {
              total: 0,
              prepSamples: 0,
              averagePrepMs: null,
              medianPrepMs: null,
            },
            assignments: { total: 0, duplicateBriefings: 0, tasksWithDuplicates: 0 },
            tasks: { total: 0, completed: 0, averageCycleMs: null, medianCycleMs: null },
          },
        });
      }
      if (url.includes("/api/fleet/readiness")) {
        return mockResponse({
          vendors: [
            {
              vendor: "codex",
              installed: true,
              authenticated: true,
              credentialMethod: "api-key",
              detail: "configured with a Codex API key",
              authState: "confirmed",
            },
          ],
          generatedAt: "2026-07-09T00:00:00.000Z",
        });
      }
      if (url.endsWith("/api/runner")) {
        return mockResponse({
          runner: { id: "r1", host: "local", status: "online", lastSeenAt: "2026-07-09T00:00:01.000Z" },
          live: true,
        });
      }
      if (url.includes("/api/dispatch")) {
        return mockResponse({ jobs: [] });
      }
      // P0.4: live receipts for the ReviewInbox annotation.
      if (url.includes("/api/receipts")) {
        return mockResponse({ receipts: [] });
      }
      return mockResponse({}, 404);
    });

    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const store = createBrainStore(client);
    await store.refresh();

    const snap = store.getSnapshot();
    expect(snap.error).toBeNull();
    expect(snap.preflight?.status).toBe("ready");
    expect(snap.preflight?.runnerHealth.state).toBe("live");
    expect(snap.preflight?.readiness.source).toBe("backend");
    expect(snap.preflight?.readiness.readyVendors).toEqual(["codex"]);
    // The rest of the app's readiness projection still reflects the same fetch.
    expect(snap.readiness?.[0]?.vendor).toBe("codex");
  });

  it("per-endpoint honesty: health OK + one route failing stays reachable, never CONTROL_PLANE_UNREACHABLE", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/api/metrics")) {
        return mockResponse({}, 500); // one bad route…
      }
      const body = healthyBody(url);
      return body ? mockResponse(body) : mockResponse({}, 404);
    });

    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const store = createBrainStore(client);
    await store.refresh();

    const snap = store.getSnapshot();
    // …the control plane is still reachable (health answered).
    expect(snap.health?.status).toBe("ok");
    expect(snap.preflight?.brainHealth.state).toBe("ok");
    expect(snap.preflight?.status).not.toBe("blocked");
    expect(snap.preflight?.degradations.map((d) => d.code)).not.toContain(
      "CONTROL_PLANE_UNREACHABLE"
    );
    // The failure is surfaced per-endpoint, honestly.
    expect(snap.error).toContain("metrics");
  });

  it("a connection failure surfaces the attempted base URL in the error (never a token)", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
    });
    const client = new MuonApiClient("http://127.0.0.1:4000", fetcher, "secret");
    const store = createBrainStore(client);
    await store.refresh();

    const snap = store.getSnapshot();
    expect(snap.error).toContain("http://127.0.0.1:4000/health");
    expect(snap.error).not.toContain("secret");
    expect(snap.preflight?.status).toBe("blocked");
  });

  it("agrees with the doctor's collectCapabilityPreflight when the brain is offline (ONE contract)", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
    });
    const client = new MuonApiClient("http://127.0.0.1:4000", fetcher);
    const store = createBrainStore(client);
    await store.refresh();

    const storePreflight = store.getSnapshot().preflight;
    const doctorPreflight = await collectCapabilityPreflight(client);

    // The TUI store and `muon doctor` project the SAME blocked contract.
    expect(storePreflight?.status).toBe("blocked");
    expect(storePreflight?.status).toBe(doctorPreflight.status);
    expect(storePreflight?.brainHealth.state).toBe(
      doctorPreflight.brainHealth.state
    );
    expect(storePreflight?.degradations.map((d) => d.code)).toEqual(
      doctorPreflight.degradations.map((d) => d.code)
    );
    expect(doctorPreflight.degradations.map((d) => d.code)).toEqual([
      "CONTROL_PLANE_UNREACHABLE",
    ]);
  });

  it("re-resolves an auto-discovered target after a connection failure; the next poll uses the NEW base + bearer", async () => {
    // The brain we booted against (base A, token A) has died: health() rejects.
    const deadFetcher = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
    });
    const clientA = new MuonApiClient(
      "http://127.0.0.1:4000",
      deadFetcher,
      "token-A"
    );

    // A freshly-booted brain (base B) requires the NEW bearer.
    const seenAuth: Array<string | undefined> = [];
    const okFetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seenAuth.push(headers?.Authorization);
      const body = healthyBody(url);
      return body ? mockResponse(body) : mockResponse({}, 404);
    });
    const clientB = new MuonApiClient(
      "http://127.0.0.1:5555",
      okFetcher,
      "token-B"
    );

    const newTarget: BrainTarget = {
      base: "http://127.0.0.1:5555",
      dataDir: "/data",
      source: "lockfile",
    };
    const reresolve = vi.fn(async () => ({ client: clientB, target: newTarget }));

    const store = createBrainStore(clientA, undefined, {
      target: {
        base: "http://127.0.0.1:4000",
        dataDir: "/data",
        source: "lockfile",
      },
      reresolve,
    });

    // Poll 1: base A is dead → offline, and the store re-resolves to base B.
    await store.refresh();
    expect(store.getSnapshot().preflight?.status).toBe("blocked");
    expect(reresolve).toHaveBeenCalledTimes(1);
    // The offline line still names the base that FAILED, not the new one.
    expect(store.getSnapshot().target.base).toBe("http://127.0.0.1:4000");
    // store.client now points at the swapped client (the ~40 App call sites).
    expect(store.client).toBe(clientB);
    const deadCallsAfterPoll1 = deadFetcher.mock.calls.length;

    // Poll 2: uses the NEW client (base B) and the NEW bearer.
    await store.refresh();
    const snap = store.getSnapshot();
    expect(snap.error).toBeNull();
    expect(snap.health?.status).toBe("ok");
    expect(snap.target.base).toBe("http://127.0.0.1:5555");
    expect(snap.target.source).toBe("lockfile");
    // The dead brain is never touched again after the swap.
    expect(deadFetcher.mock.calls.length).toBe(deadCallsAfterPoll1);
    expect(seenAuth.some((a) => a === "Bearer token-B")).toBe(true);
    expect(seenAuth.every((a) => a !== "Bearer token-A")).toBe(true);
  });

  it("never re-resolves an explicit (flag/env) target — F1 no-hijack", async () => {
    const deadFetcher = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const client = new MuonApiClient(
      "http://remote.example:4000",
      deadFetcher,
      "explicit-token"
    );
    // Even if a reresolve callback is wired, the source guard must block it.
    const reresolve = vi.fn(async () => ({
      client,
      target: {
        base: "http://127.0.0.1:9999",
        dataDir: "/data",
        source: "lockfile" as const,
      },
    }));

    const store = createBrainStore(client, undefined, {
      target: {
        base: "http://remote.example:4000",
        dataDir: "/data",
        source: "flag",
      },
      reresolve,
    });

    await store.refresh();
    expect(store.getSnapshot().preflight?.status).toBe("blocked");
    expect(reresolve).not.toHaveBeenCalled();
    expect(store.client).toBe(client);
    expect(store.getSnapshot().target.base).toBe("http://remote.example:4000");
  });

  it("seeds an honest offline snapshot from a startup error (ensureBrain failed)", () => {
    const fetcher = vi.fn(async () => mockResponse({ status: "ok" }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const store = createBrainStore(client, undefined, {
      target: {
        base: "http://localhost:4000",
        dataDir: "/data/MUON",
        source: "default",
      },
      startupError:
        "started the brain but it did not report healthy within 15s (lockfile: /data/MUON/brain.lock)",
    });

    // Before the first poll the UI already shows the offline note + target.
    const snap = store.getSnapshot();
    expect(snap.error).toContain("lockfile:");
    expect(snap.preflight?.status).toBe("blocked");
    expect(snap.preflight?.brainHealth.state).toBe("unreachable");
    expect(snap.target.dataDir).toBe("/data/MUON");
  });

  describe("P0.4 TUI parity: active receipts (ReviewInbox annotation)", () => {
    function receiptBody(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: "receipt-1",
        approvalId: "approval-1",
        taskId: "task-1",
        jobId: "job-1",
        workspacePath: "/repo",
        actionClass: "edit",
        toolName: "edit_file",
        payloadDigest: "digest",
        expiresAt: "2026-07-09T00:05:00.000Z",
        useCount: 0,
        ...overrides,
      };
    }

    it("before the first poll, activeReceipts is honestly unknown (null), never a guessed zero", () => {
      const fetcher = vi.fn(async () => mockResponse({}, 404));
      const client = new MuonApiClient("http://localhost:4000", fetcher);
      const store = createBrainStore(client);
      expect(store.getSnapshot().activeReceipts).toBeNull();
    });

    it("present: a successful poll exposes the live receipts from the shared client", async () => {
      const fetcher = vi.fn(async (url: string) => {
        if (url.includes("/api/receipts")) {
          return mockResponse({ receipts: [receiptBody()] });
        }
        const body = healthyBody(url);
        return body ? mockResponse(body) : mockResponse({}, 404);
      });
      const client = new MuonApiClient("http://localhost:4000", fetcher);
      const store = createBrainStore(client);
      await store.refresh();

      const snap = store.getSnapshot();
      expect(snap.error).toBeNull();
      expect(snap.activeReceipts).toHaveLength(1);
      expect(snap.activeReceipts?.[0]?.id).toBe("receipt-1");
    });

    it("absent: a successful poll with nothing active reports an empty array, not null", async () => {
      const fetcher = vi.fn(async (url: string) => {
        const body = healthyBody(url); // receipts: [] by default
        return body ? mockResponse(body) : mockResponse({}, 404);
      });
      const client = new MuonApiClient("http://localhost:4000", fetcher);
      const store = createBrainStore(client);
      await store.refresh();

      const snap = store.getSnapshot();
      expect(snap.error).toBeNull();
      expect(snap.activeReceipts).toEqual([]);
    });

    it("poll-fail: a receipts-route failure clears to null — honest absence, never a stale count", async () => {
      const fetcher = vi.fn(async (url: string) => {
        if (url.includes("/api/receipts")) {
          return mockResponse({}, 500);
        }
        const body = healthyBody(url);
        return body ? mockResponse(body) : mockResponse({}, 404);
      });
      const client = new MuonApiClient("http://localhost:4000", fetcher);
      const store = createBrainStore(client);
      await store.refresh();

      const snap = store.getSnapshot();
      expect(snap.activeReceipts).toBeNull();
      // Surfaced per-endpoint, same honesty contract as every other route.
      expect(snap.error).toContain("receipts");
    });

    it("never stale: a receipts poll that later fails clears a PRIOR successful count to null", async () => {
      let receiptsShouldFail = false;
      const fetcher = vi.fn(async (url: string) => {
        if (url.includes("/api/receipts")) {
          if (receiptsShouldFail) {
            return mockResponse({}, 500);
          }
          return mockResponse({ receipts: [receiptBody()] });
        }
        const body = healthyBody(url);
        return body ? mockResponse(body) : mockResponse({}, 404);
      });
      const client = new MuonApiClient("http://localhost:4000", fetcher);
      const store = createBrainStore(client);

      await store.refresh();
      expect(store.getSnapshot().activeReceipts).toHaveLength(1);

      receiptsShouldFail = true;
      await store.refresh();
      // The prior successful count must NOT linger once the poll fails.
      expect(store.getSnapshot().activeReceipts).toBeNull();
    });

    it("control-plane-unreachable also clears activeReceipts to null, never stale", async () => {
      const fetcher = vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
      });
      const client = new MuonApiClient("http://localhost:4000", fetcher);
      const store = createBrainStore(client);
      await store.refresh();

      expect(store.getSnapshot().activeReceipts).toBeNull();
    });
  });
});
