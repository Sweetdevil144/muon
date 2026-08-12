import { beforeEach, describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "@muon/client";
import {
  startManagedSession,
  type SessionLedger,
} from "@muon/core";
import type {
  LaneSessionDriver,
  SessionHandlers,
} from "@muon/adapters";
import type { LaneEvent, StandingApproverGrant } from "@muon/protocol";
import { createStandingApproverLeaseHolder } from "../../apps/desktop/src/lib/standing-approver.js";

// ── END-TO-END: does the standing-approver signal actually reach the gate? ────
//
// Every other test in this change covers ONE hop. This one runs the whole
// pipeline with the real implementation at each end, because the bug being
// fixed was never a broken function — it was a fact that existed in the desktop
// main process and reached nobody:
//
//   desktop lease holder  (apps/desktop/src/lib/standing-approver.ts)
//     → operator MuonApiClient.renewStandingApproverLease()
//       → PUT  /api/approvals/standing-approver/lease   (real Fastify app)
//         → renewStandingApproverLease()                (real store)
//           → GET /api/approvals/standing-approver/lease
//             → agent MuonApiClient.getStandingApprover()   (what the runner calls)
//               → startManagedSession's coordinator gate    (real @muon/core)
//
// Only the session LEDGER and the vendor DRIVER are fakes — the approval-filing
// half of the path is pre-existing and unchanged by this work. What is asserted
// here is that the authority signal survives all five hops and flips the gate,
// and that releasing the lease flips it back on the very next call.

const OPERATOR = "operator-token-pipeline-1";
const AGENT = "agent-token-pipeline-1";

const settingRows = new Map<string, { key: string; value: string }>();

const prismaMock = vi.hoisted(() => ({
  operatorSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  delegationGrant: { findFirst: vi.fn() },
  dispatchJob: { findUnique: vi.fn() },
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/preedit.js", () => ({ preEditContext: vi.fn() }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
  getEmbedder: () => undefined,
}));
vi.mock("../src/lib/codegraph.js", () => ({
  selectCodeGraphProvider: async () => null,
}));
vi.mock("../src/lib/activity.js", () => ({ readActivity: () => async () => [] }));
vi.mock("../src/lib/duplicate-work.js", () => ({
  readDuplicateWork: () => async () => [],
}));

/** Today's fast-deny sentence, asserted byte-for-byte at the far end. */
const FAST_DENY =
  "MUON denied: coordinator tool 'Bash' is not pre-authorized and no operator watches the coordinator's approval inbox. Grant it via the harness (preauthorizedTools) so this exact tool is admitted without asking.";

function fakeLedger() {
  const filed: unknown[] = [];
  const ledger: SessionLedger = {
    createSession: async () => ({ id: "session-pipeline" }),
    updateSession: async () => ({}),
    requestApproval: async (input) => {
      filed.push(input);
      return { id: `approval-${filed.length}` };
    },
    waitForApproval: async () => undefined,
    consumeApproval: async () => undefined,
  };
  return { ledger, filed };
}

function fakeDriver(
  run: (handlers: SessionHandlers) => Promise<{ exitCode: number; output: string }>
): LaneSessionDriver {
  return {
    laneKey: "fake-lane",
    capabilities: { canSend: true, canInterrupt: true, canResume: false },
    start: async (_input, handlers) => {
      const done = run(handlers);
      return {
        vendorSessionId: "vendor-pipeline",
        send: async () => undefined,
        interrupt: async () => undefined,
        wait: () => done,
      };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  settingRows.clear();
  prismaMock.operatorSetting.findUnique.mockImplementation(
    async (args: { where: { key: string } }) =>
      settingRows.get(args.where.key) ?? null
  );
  prismaMock.operatorSetting.upsert.mockImplementation(
    async (args: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }) => {
      const row = settingRows.has(args.where.key)
        ? { key: args.where.key, value: args.update.value }
        : { ...args.create };
      settingRows.set(args.where.key, row);
      return row;
    }
  );
  prismaMock.operatorSetting.deleteMany.mockImplementation(
    async (args: { where: { key: string } }) => ({
      count: settingRows.delete(args.where.key) ? 1 : 0,
    })
  );
  prismaMock.delegationGrant.findFirst.mockResolvedValue(null);
  prismaMock.dispatchJob.findUnique.mockResolvedValue(null);
});

describe("standing-approver pipeline (desktop → brain → runner → session gate)", () => {
  it("carries the grant across every hop, and revoking it re-arms the fast-deny on the very next call", async () => {
    process.env.MUON_OPERATOR_TOKEN = OPERATOR;
    process.env.MUON_AGENT_TOKEN = AGENT;
    delete process.env.MUON_API_TOKEN;
    vi.resetModules();
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    await app.ready();

    // The real HTTP client, driven over the real route table.
    const inject: typeof fetch = (async (url: string, init?: RequestInit) => {
      const res = await app.inject({
        method: (init?.method ?? "GET") as "GET",
        url: new URL(url).pathname,
        headers: init?.headers as Record<string, string>,
        ...(init?.body != null ? { payload: init.body as string } : {}),
      });
      return {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage ?? "",
        redirected: false,
        json: async () => res.json(),
      };
    }) as unknown as typeof fetch;

    const base = "http://127.0.0.1:4000";
    const operatorClient = new MuonApiClient(base, inject, OPERATOR);
    // The runner holds the SHARED AGENT bearer, never the operator one.
    const agentClient = new MuonApiClient(base, inject, AGENT);

    // HOP 1-2 — the desktop's own lease holder, renewing on its poll cycle.
    const lines: string[] = [];
    const lease = createStandingApproverLeaseHolder(
      {
        renewStandingApproverLease: () =>
          operatorClient.renewStandingApproverLease(),
        releaseStandingApproverLease: () =>
          operatorClient.releaseStandingApproverLease(),
      } as never,
      (line) => lines.push(line)
    );

    // HOP 3-4 — exactly what packages/runner/src/execute.ts's
    // `resolveStandingApprover` does: shared agent client, fail closed on throw.
    const resolveStandingApprover = async (): Promise<
      StandingApproverGrant | undefined
    > => {
      try {
        return await agentClient.getStandingApprover();
      } catch {
        return undefined;
      }
    };

    // HOP 5 — the real coordinator gate.
    const coordinatorBash = async () => {
      const { ledger, filed } = fakeLedger();
      let decision!: { behavior: string; message?: string };
      const driver = fakeDriver(async (handlers) => {
        decision = await handlers.onApprovalRequest({
          toolName: "Bash",
          input: { command: "ls" },
          taskId: "task-pipeline",
          laneKey: "fake-lane",
        });
        return { exitCode: 0, output: "" };
      });
      const session = await startManagedSession(
        ledger,
        {
          laneKey: "fake-lane",
          laneId: "lane-pipeline",
          taskId: "task-pipeline",
          brief: "coordinate",
          onEvent: (_event: LaneEvent) => undefined,
          noInteractiveApprover: true,
          resolveStandingApprover,
        },
        [driver]
      );
      await session.handle.wait();
      return { decision, filed };
    };

    // 1. Full Auto OFF (nothing ever published) → today's behaviour, exactly.
    const off = await coordinatorBash();
    expect(off.decision.behavior).toBe("deny");
    expect(off.decision.message).toBe(FAST_DENY);
    expect(off.filed).toEqual([]);

    // 2. Full Auto ON: the desktop publishes, and the signal reaches the gate.
    await lease.reconcile({ fullAuto: true, online: true });
    expect(lease.held()).toBe(true);
    const on = await coordinatorBash();
    expect(on.decision.behavior).toBe("allow");
    // It went through the INBOX — MUON asked, it did not silently self-allow.
    expect(on.filed).toHaveLength(1);
    expect(on.filed[0]).toMatchObject({
      kind: "command",
      evidence: { action: "Bash", scope: "Command: ls" },
    });

    // 3. Full Auto OFF again: revocation is one poll, not a restart.
    await lease.reconcile({ fullAuto: false, online: true });
    expect(lease.held()).toBe(false);
    const revoked = await coordinatorBash();
    expect(revoked.decision.message).toBe(FAST_DENY);
    expect(revoked.filed).toEqual([]);

    // 4. And the crash case: a lease published but never renewed lapses on its
    //    own, with no cooperation from the process that published it.
    await lease.reconcile({ fullAuto: true, online: true });
    expect((await coordinatorBash()).decision.behavior).toBe("allow");
    const { STANDING_APPROVER_LEASE_TTL_MS } = await import(
      "../src/lib/operator-settings.js"
    );
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + STANDING_APPROVER_LEASE_TTL_MS + 1_000);
    try {
      const stale = await coordinatorBash();
      expect(stale.decision.message).toBe(FAST_DENY);
      expect(stale.filed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }

    expect(lines).toEqual([]);
    await app.close();
  });

  it("a brain that cannot answer leaves the coordinator exactly as denied as today", async () => {
    // The whole pipeline's failure mode. Widening here would hand a coordinator
    // an ungated shell the moment control hiccuped.
    const dead = new MuonApiClient(
      "http://127.0.0.1:4000",
      (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
      AGENT
    );

    const { ledger, filed } = fakeLedger();
    let decision!: { behavior: string; message?: string };
    const driver = fakeDriver(async (handlers) => {
      decision = await handlers.onApprovalRequest({
        toolName: "Bash",
        input: { command: "ls" },
        taskId: "task-pipeline",
        laneKey: "fake-lane",
      });
      return { exitCode: 0, output: "" };
    });
    const session = await startManagedSession(
      ledger,
      {
        laneKey: "fake-lane",
        laneId: "lane-pipeline",
        taskId: "task-pipeline",
        brief: "coordinate",
        onEvent: (_event: LaneEvent) => undefined,
        noInteractiveApprover: true,
        resolveStandingApprover: async () => {
          try {
            return await dead.getStandingApprover();
          } catch {
            return undefined;
          }
        },
      },
      [driver]
    );
    await session.handle.wait();

    expect(decision.message).toBe(FAST_DENY);
    expect(filed).toEqual([]);
  });
});
