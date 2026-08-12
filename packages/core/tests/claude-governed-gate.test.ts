import { describe, expect, it } from "vitest";
import { ClaudeSessionDriver } from "@muon/adapters";
import type { LaneEvent } from "@muon/protocol";
import {
  startManagedSession,
  type SessionLedger,
} from "../src/session-manager.js";

/**
 * REGRESSION FIXTURE: a governed claude loop child's tool call must reach
 * MUON's gate.
 *
 * End to end through the REAL ClaudeSessionDriver and the REAL managed-session
 * bridge, with only the Agent SDK faked: an un-preauthorized tool call must
 * file an ApprovalRequest row a human (or Full Auto's standing consent) can
 * decide, the approve must be consumed before the vendor observes the allow,
 * and a deny or a timed-out wait must stop the action (fail closed).
 *
 * This is the exact chain that was absent when claude loop children ran on the
 * one-shot session channel, which installs no `canUseTool`: Claude's OWN
 * permission layer adjudicated every Edit/Bash with no MUON grant reachable
 * and denied the writes — a FULL AUTO mission's implementer failed every
 * attempt and filed ZERO approval rows, so standing consent had nothing to
 * grant. The mirror image of the ungated-codex defect; both are "MUON is not
 * the gate".
 */

type CanUseTool = (
  toolName: string,
  toolInput: unknown
) => Promise<{ behavior: string; message?: string; updatedInput?: unknown }>;

/**
 * Minimal fake of the Agent SDK: captures the driver's options (including
 * `canUseTool`), pumps the gated prompt like the real input reader, and
 * streams whatever the test emits.
 */
function fakeAgentSdk() {
  let capturedOptions: Record<string, unknown> | undefined;
  const queue: unknown[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  const wake = () => {
    notify?.();
    notify = null;
  };
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift();
        if (ended) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
    interrupt: async () => {
      ended = true;
      wake();
    },
  };
  const sdk = {
    query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
      capturedOptions = input.options;
      // Consume the gated prompt exactly as the SDK's input pump would, so the
      // brief release at the end of start() is observed and never dangles.
      void (async () => {
        for await (const _message of input.prompt as AsyncIterable<unknown>) {
          // consumed; the fake vendor does nothing with the brief
        }
      })().catch(() => undefined);
      return stream;
    },
  };
  return {
    sdk,
    emit: (message: unknown) => {
      queue.push(message);
      wake();
    },
    end: () => {
      ended = true;
      wake();
    },
    canUseTool: (): CanUseTool => {
      const callback = capturedOptions?.canUseTool;
      if (typeof callback !== "function") {
        throw new Error("the driver installed no canUseTool — the gate is gone");
      }
      return callback as CanUseTool;
    },
  };
}

function fakeLedger(overrides: Partial<SessionLedger> = {}): SessionLedger & {
  approvals: unknown[];
} {
  const approvals: unknown[] = [];
  return {
    approvals,
    createSession: async () => ({ id: "session-c1" }),
    updateSession: async () => ({}),
    requestApproval: async (input) => {
      approvals.push(input);
      return { id: "approval-c1" };
    },
    waitForApproval: async () => undefined,
    consumeApproval: async () => undefined,
    ...overrides,
  };
}

async function startGovernedClaudeSession(
  ledger: SessionLedger,
  options: { approvalTimeoutMs?: number } = {}
) {
  const vendor = fakeAgentSdk();
  const events: LaneEvent[] = [];
  const managed = await startManagedSession(
    ledger,
    {
      laneKey: "claude-code",
      laneId: "lane-claude",
      taskId: "task-c1",
      jobId: "job-c1",
      brief: "write-authority work",
      cwd: "/repo",
      ...(options.approvalTimeoutMs !== undefined
        ? { approvalTimeoutMs: options.approvalTimeoutMs }
        : {}),
      onEvent: (event) => events.push(event),
    },
    [new ClaudeSessionDriver(async () => vendor.sdk as never)]
  );
  return { vendor, events, managed };
}

async function endSession(
  vendor: ReturnType<typeof fakeAgentSdk>,
  managed: Awaited<ReturnType<typeof startGovernedClaudeSession>>["managed"]
) {
  vendor.emit({ type: "result", subtype: "success", result: "done" });
  vendor.end();
  await managed.handle.wait();
}

describe("governed claude gate — end to end through the real driver and bridge", () => {
  it("an Edit files an ApprovalRequest a human can read, and the approve is consumed before claude sees the allow", async () => {
    const order: string[] = [];
    const ledger = fakeLedger({
      waitForApproval: async () => {
        order.push("waitForApproval");
      },
      consumeApproval: async () => {
        order.push("consumeApproval");
      },
    });
    const { vendor, managed } = await startGovernedClaudeSession(ledger, {
      approvalTimeoutMs: 120_000,
    });

    const decision = await vendor.canUseTool()("Edit", {
      file_path: "apps/cli/tests/crew.test.ts",
      new_string: "it('covers the crew', () => {})",
    });

    // The row a human decides on: command kind, the job binding, and evidence
    // that names the ACTUAL file — never zero rows while the child fails.
    expect(ledger.approvals).toHaveLength(1);
    expect(ledger.approvals[0]).toMatchObject({
      taskId: "task-c1",
      jobId: "job-c1",
      kind: "command",
      requestedBy: "claude-code",
      evidence: expect.objectContaining({
        action: "Edit",
        scope: expect.stringContaining("apps/cli/tests/crew.test.ts"),
        riskLevel: "medium",
      }),
    });
    // Consume-before-allow held on this vendor too.
    expect(order).toEqual(["waitForApproval", "consumeApproval"]);
    // Claude received the allow in its own vocabulary.
    expect(decision).toMatchObject({ behavior: "allow" });

    await endSession(vendor, managed);
  });

  it("Full Auto's standing consent unblocks an Edit THROUGH the inbox: the grant answers a filed row, never bypasses it", async () => {
    // Scripted standing consent: the approval poller decides rows the moment
    // they are filed, exactly as the live Full Auto approver does. waitForApproval
    // resolves only for a row that was actually filed — a request that never
    // reached the ledger has nothing to be granted against.
    const decided = new Set<string>();
    const ledger = fakeLedger({
      requestApproval: async (input) => {
        const id = `approval-${decided.size + 1}`;
        (ledger.approvals as unknown[]).push(input);
        setTimeout(() => decided.add(id), 5);
        return { id };
      },
      waitForApproval: async (approvalId) => {
        while (!decided.has(approvalId)) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      },
    });
    const { vendor, managed } = await startGovernedClaudeSession(ledger, {
      approvalTimeoutMs: 120_000,
    });

    const edit = await vendor.canUseTool()("Edit", {
      file_path: "apps/cli/tests/crew.test.ts",
      new_string: "test body",
    });
    const bash = await vendor.canUseTool()("Bash", {
      command: "npm test --workspace apps/cli",
    });

    expect(edit).toMatchObject({ behavior: "allow" });
    expect(bash).toMatchObject({ behavior: "allow" });
    // Both grants flowed through filed rows — the founder's failure was ZERO
    // rows with every write denied by the vendor's own layer.
    expect(ledger.approvals).toHaveLength(2);

    await endSession(vendor, managed);
  });

  it("a deny stops the action: claude is told deny, never allow", async () => {
    const ledger = fakeLedger({
      waitForApproval: async () => {
        throw new Error("operator rejected the edit");
      },
    });
    const { vendor, managed } = await startGovernedClaudeSession(ledger);

    const decision = await vendor.canUseTool()("Edit", {
      file_path: "apps/cli/tests/crew.test.ts",
      new_string: "test body",
    });

    expect(decision).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("MUON denied"),
    });

    await endSession(vendor, managed);
  });

  it("an unanswered gate DENIES on timeout — fail closed, with the configured bound on the wait", async () => {
    const waits: (number | undefined)[] = [];
    const ledger = fakeLedger({
      waitForApproval: async (_approvalId, timeoutMs) => {
        waits.push(timeoutMs);
        throw new Error("approval timed out");
      },
    });
    const { vendor, managed } = await startGovernedClaudeSession(ledger, {
      approvalTimeoutMs: 45_000,
    });

    const decision = await vendor.canUseTool()("Bash", {
      command: "npm test",
    });

    expect(waits).toEqual([45_000]);
    expect(decision).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("MUON denied"),
    });

    await endSession(vendor, managed);
  });
});
