import { describe, expect, it } from "vitest";
import {
  CODEX_RPC,
  CodexSessionDriver,
  type RpcTransport,
} from "@muon/adapters";
import { MUON_CONTEXT_TOOL_NAMES, type LaneEvent } from "@muon/protocol";
import {
  startManagedSession,
  type SessionLedger,
} from "../src/session-manager.js";

/**
 * REGRESSION FIXTURE: a governed codex child must not run ungated.
 *
 * End to end through the REAL CodexSessionDriver and the REAL managed-session
 * bridge, with only the vendor process faked: a gated action must file an
 * ApprovalRequest row a human can read, an approval must be consumed before
 * the vendor observes the allow, and a deny or a timed-out wait must stop the
 * action (fail closed). This is the exact chain that was silently absent when
 * governed codex children ran on `codex exec` — four minutes of
 * write-authority work, zero ApprovalRequest rows.
 */

type Message = Parameters<RpcTransport["send"]>[0];

/** Minimal fake of the codex app-server: handshake + preflight + turn ack. */
function fakeAppServer() {
  const received: Message[] = [];
  let deliver: (message: Message) => void = () => undefined;
  let resolveExit: (code: number) => void = () => undefined;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const transport: RpcTransport = {
    send: (message) => {
      received.push(message);
      if (message.method === CODEX_RPC.initialize) {
        deliver({ id: message.id, result: { userAgent: "codex-cli/0.145.0" } });
      }
      if (message.method === CODEX_RPC.threadStart) {
        deliver({ id: message.id, result: { thread: { id: "thread-g1" } } });
      }
      if (message.method === CODEX_RPC.accountRead) {
        deliver({
          id: message.id,
          result: { account: null, requiresOpenaiAuth: true },
        });
      }
      if (message.method === CODEX_RPC.configRead) {
        deliver({ id: message.id, result: { config: {}, origins: {} } });
      }
      if (message.method === CODEX_RPC.configRequirementsRead) {
        deliver({ id: message.id, result: { requirements: null } });
      }
      if (message.method === CODEX_RPC.pluginList) {
        deliver({
          id: message.id,
          result: {
            marketplaces: [],
            marketplaceLoadErrors: [],
            featuredPluginIds: [],
          },
        });
      }
      if (message.method === CODEX_RPC.mcpServerStatusList) {
        deliver({
          id: message.id,
          result: {
            data: [
              {
                name: "muon",
                serverInfo: null,
                tools: Object.fromEntries(
                  MUON_CONTEXT_TOOL_NAMES.map((name) => [
                    name,
                    { name, inputSchema: { type: "object" } },
                  ])
                ),
                resources: [],
                resourceTemplates: [],
                authStatus: "unsupported",
              },
            ],
            nextCursor: null,
          },
        });
      }
      if (message.method === CODEX_RPC.turnStart) {
        deliver({ id: message.id, result: {} });
      }
    },
    onMessage: (handler) => {
      deliver = handler;
    },
    close: async () => {
      resolveExit(0);
    },
    waitForExit: async () => exitPromise,
  };

  return {
    transport,
    received,
    emit: (message: Message) => deliver(message),
  };
}

function fakeLedger(overrides: Partial<SessionLedger> = {}): SessionLedger & {
  approvals: unknown[];
} {
  const approvals: unknown[] = [];
  return {
    approvals,
    createSession: async () => ({ id: "session-g1" }),
    updateSession: async () => ({}),
    requestApproval: async (input) => {
      approvals.push(input);
      return { id: "approval-g1" };
    },
    waitForApproval: async () => undefined,
    consumeApproval: async () => undefined,
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function startGovernedCodexSession(
  ledger: SessionLedger,
  options: { approvalTimeoutMs?: number } = {}
) {
  const server = fakeAppServer();
  const events: LaneEvent[] = [];
  const managed = await startManagedSession(
    ledger,
    {
      laneKey: "codex",
      laneId: "lane-codex",
      taskId: "task-g1",
      jobId: "job-g1",
      brief: "write-authority work",
      cwd: "/repo",
      ...(options.approvalTimeoutMs !== undefined
        ? { approvalTimeoutMs: options.approvalTimeoutMs }
        : {}),
      onEvent: (event) => events.push(event),
    },
    [new CodexSessionDriver(() => server.transport)]
  );
  return { server, events, managed };
}

describe("governed codex gate — end to end through the real driver and bridge", () => {
  it("a gated command files an ApprovalRequest a human can read, and the approve is consumed before codex sees the allow", async () => {
    const order: string[] = [];
    const ledger = fakeLedger({
      waitForApproval: async () => {
        order.push("waitForApproval");
      },
      consumeApproval: async () => {
        order.push("consumeApproval");
      },
    });
    const { server, managed } = await startGovernedCodexSession(ledger, {
      approvalTimeoutMs: 120_000,
    });

    server.emit({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-g1",
        itemId: "call_1",
        command: "/bin/zsh -lc 'rm -rf build'",
        cwd: "/repo",
        commandActions: [{ type: "unknown", command: "rm -rf build" }],
      },
    });
    await settle();

    // The row a human decides on: command kind, the job binding, and evidence
    // that names the ACTUAL command — not a JSON-RPC method.
    expect(ledger.approvals).toHaveLength(1);
    expect(ledger.approvals[0]).toMatchObject({
      taskId: "task-g1",
      jobId: "job-g1",
      kind: "command",
      requestedBy: "codex",
      evidence: expect.objectContaining({
        action: "Bash",
        scope: expect.stringContaining("rm -rf build"),
        riskLevel: "high",
      }),
    });
    // Consume-before-allow held on this vendor too.
    expect(order).toEqual(["waitForApproval", "consumeApproval"]);
    // Codex received the allow in its own vocabulary.
    const answer = server.received.find((m) => m.id === 7 && m.result);
    expect(answer?.result).toMatchObject({ decision: "accept" });

    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await managed.handle.wait();
  });

  it("a deny stops the action: codex is told decline, never accept", async () => {
    const ledger = fakeLedger({
      waitForApproval: async () => {
        throw new Error("operator rejected the command");
      },
    });
    const { server, managed } = await startGovernedCodexSession(ledger);

    server.emit({
      id: 8,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-g1",
        itemId: "call_2",
        command: "/bin/zsh -lc 'git push --force'",
        cwd: "/repo",
        commandActions: [{ type: "unknown", command: "git push --force" }],
      },
    });
    await settle();

    const answer = server.received.find((m) => m.id === 8 && m.result);
    expect(answer?.result).toMatchObject({ decision: "decline" });
    expect(
      server.received.some(
        (m) =>
          m.id === 8 &&
          (m.result as { decision?: string } | undefined)?.decision === "accept"
      )
    ).toBe(false);

    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await managed.handle.wait();
  });

  it("an unanswered gate DENIES on timeout — fail closed, with the configured bound on the wait", async () => {
    const waits: (number | undefined)[] = [];
    const ledger = fakeLedger({
      waitForApproval: async (_approvalId, timeoutMs) => {
        waits.push(timeoutMs);
        throw new Error("approval timed out");
      },
    });
    const { server, managed } = await startGovernedCodexSession(ledger, {
      approvalTimeoutMs: 45_000,
    });

    server.emit({
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-g1",
        itemId: "call_3",
        command: "/bin/zsh -lc 'touch anything'",
        cwd: "/repo",
        commandActions: [{ type: "unknown", command: "touch anything" }],
      },
    });
    await settle();

    expect(waits).toEqual([45_000]);
    const answer = server.received.find((m) => m.id === 9 && m.result);
    expect(answer?.result).toMatchObject({ decision: "decline" });

    server.emit({ method: CODEX_RPC.turnCompleted, params: {} });
    await managed.handle.wait();
  });
});
