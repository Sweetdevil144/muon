import { describe, expect, it, vi } from "vitest";
import {
  ACP_PROTOCOL_VERSION,
  ACP_RPC,
  ACP_TIER1_REFUSED,
  AcpSessionDriver,
  selectAcpPermissionOption,
} from "../src/acp-session-driver.js";
import type { RpcTransport } from "../src/codex-session-driver.js";
import type {
  ApprovalDecision,
  SessionHandlers,
} from "../src/session-driver.js";

// ── A hermetic in-process ACP agent, the codex fakeAppServer pattern ─────────
//
// The fake answers initialize/session-new/prompt, streams updates, and can be
// scripted to demand permissions, demand auth, or offer hostile permission
// vocabularies. No child process, no vendor, no tokens.

type FakeMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

type FakeAgentOptions = {
  sessionId?: string;
  /** Force session/new to fail with an auth-required error. */
  authRequired?: boolean;
  /** Permission options offered when a prompt triggers a permission ask. */
  permissionOptions?: { optionId: string; name: string; kind: string }[];
  /** Whether the first prompt asks for permission before completing. */
  askPermission?: boolean;
  /** Extra client-bound request issued before the prompt completes. */
  clientRequestMethod?: string;
  /** Hold the FIRST prompt open until this resolves (steer-mid-turn tests). */
  firstPromptGate?: Promise<void>;
};

function fakeAcpAgent(options: FakeAgentOptions = {}) {
  const sessionId = options.sessionId ?? "acp-session-1";
  const handlers: ((message: FakeMessage) => void)[] = [];
  const exitWaiters: ((code: number) => void)[] = [];
  const seen: FakeMessage[] = [];
  let exitCode: number | undefined;
  let nextAgentRequestId = 1000;
  const pendingAgentRequests = new Map<
    number | string,
    (message: FakeMessage) => void
  >();
  let cancelled = false;

  const deliver = (message: FakeMessage) => {
    for (const handler of handlers) handler(message);
  };
  const respondTo = (id: number | string, result: Record<string, unknown>) =>
    deliver({ id, result });
  const streamText = (text: string) =>
    deliver({
      method: ACP_RPC.sessionUpdate,
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    });
  const requestFromAgent = (
    method: string,
    params: Record<string, unknown>
  ): Promise<FakeMessage> => {
    nextAgentRequestId += 1;
    const id = nextAgentRequestId;
    return new Promise((resolve) => {
      pendingAgentRequests.set(id, resolve);
      deliver({ id, method, params });
    });
  };

  const transport: RpcTransport = {
    send: (message) => {
      seen.push(message as FakeMessage);
      const { id, method } = message as FakeMessage;
      // Replies to agent-initiated requests.
      if (method === undefined && id !== undefined) {
        const waiter = pendingAgentRequests.get(id);
        if (waiter) {
          pendingAgentRequests.delete(id);
          waiter(message as FakeMessage);
        }
        return;
      }
      if (method === ACP_RPC.initialize) {
        respondTo(id!, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false },
          authMethods: [],
        });
        return;
      }
      if (method === ACP_RPC.sessionNew) {
        if (options.authRequired) {
          deliver({
            id: id!,
            error: { code: -32000, message: "auth_required" },
          });
          return;
        }
        respondTo(id!, { sessionId });
        return;
      }
      if (method === ACP_RPC.sessionPrompt) {
        const isFirstPrompt = !seen
          .slice(0, -1)
          .some((m) => m.method === ACP_RPC.sessionPrompt);
        void (async () => {
          if (isFirstPrompt && options.firstPromptGate) {
            await options.firstPromptGate;
          }
          streamText("hello ");
          if (options.clientRequestMethod) {
            await requestFromAgent(options.clientRequestMethod, {
              sessionId,
              path: "/etc/passwd",
            });
          }
          if (options.askPermission) {
            const answer = await requestFromAgent(ACP_RPC.requestPermission, {
              sessionId,
              toolCall: { toolCallId: "call-1", title: "write_file" },
              options: options.permissionOptions ?? [
                { optionId: "opt-allow-once", name: "Allow", kind: "allow_once" },
                {
                  optionId: "opt-allow-always",
                  name: "Always allow",
                  kind: "allow_always",
                },
                {
                  optionId: "opt-reject-once",
                  name: "Reject",
                  kind: "reject_once",
                },
              ],
            });
            void answer;
          }
          streamText("world");
          respondTo(id!, {
            stopReason: cancelled ? "cancelled" : "end_turn",
          });
        })();
        return;
      }
      if (method === ACP_RPC.sessionCancel) {
        cancelled = true;
        return;
      }
    },
    onMessage: (handler) => {
      handlers.push(handler as (message: FakeMessage) => void);
    },
    close: async () => {
      if (exitCode === undefined) {
        exitCode = 0;
        for (const waiter of exitWaiters) waiter(0);
      }
    },
    waitForExit: () =>
      exitCode !== undefined
        ? Promise.resolve(exitCode)
        : new Promise<number>((resolve) => exitWaiters.push(resolve)),
  };

  return {
    transport,
    seen,
    sentMethods: () => seen.filter((m) => m.method).map((m) => m.method),
    permissionAnswer: () =>
      seen.find(
        (m) =>
          m.method === undefined &&
          m.id !== undefined &&
          typeof m.id === "number" &&
          m.id > 1000
      ),
  };
}

function driverFor(
  agent: ReturnType<typeof fakeAcpAgent>,
  laneKey = "opencode"
) {
  return new AcpSessionDriver({
    laneKey,
    command: "never-spawned",
    createTransport: () => agent.transport,
    rpcTimeoutMs: 2_000,
  });
}

function collectHandlers(
  onApproval: (input: unknown) => Promise<ApprovalDecision> = async () => ({
    behavior: "allow",
  })
): { handlers: SessionHandlers; events: string[]; vendorIds: string[] } {
  const events: string[] = [];
  const vendorIds: string[] = [];
  return {
    events,
    vendorIds,
    handlers: {
      onEvent: (event) => events.push(`${event.kind}: ${event.message}`),
      onApprovalRequest: async (request) => onApproval(request),
      onVendorSessionId: (id) => vendorIds.push(id),
    },
  };
}

describe("AcpSessionDriver — the ADR-0007 client path", () => {
  it("initialize → session/new → prompt; streams text; wait returns the output", async () => {
    const agent = fakeAcpAgent();
    const driver = driverFor(agent);
    const { handlers, vendorIds } = collectHandlers();

    const handle = await driver.start(
      { taskId: "t1", brief: "do the thing" },
      handlers
    );
    expect(handle.vendorSessionId).toBe("acp-session-1");
    expect(vendorIds).toEqual(["acp-session-1"]);
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("hello world");
    // Never advertises fs, never calls authenticate.
    expect(agent.sentMethods()).not.toContain(ACP_RPC.authenticate);
    const init = agent.seen.find((m) => m.method === ACP_RPC.initialize);
    expect(init?.params?.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
    });
  });

  it("bridges session/request_permission through MUON's inbox and selects allow_once — NEVER allow_always, even when offered", async () => {
    const agent = fakeAcpAgent({ askPermission: true });
    const driver = driverFor(agent);
    const approvals: unknown[] = [];
    const { handlers } = collectHandlers(async (request) => {
      approvals.push(request);
      return { behavior: "allow" };
    });

    const handle = await driver.start({ taskId: "t1", brief: "go" }, handlers);
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(approvals).toHaveLength(1);
    const answer = agent.permissionAnswer();
    expect(answer?.result).toEqual({
      outcome: { outcome: "selected", optionId: "opt-allow-once" },
    });
  });

  it("GUARDRAIL: an agent offering ONLY a standing grant gets a rejection, not allow_always", async () => {
    const agent = fakeAcpAgent({
      askPermission: true,
      permissionOptions: [
        { optionId: "opt-always", name: "Always", kind: "allow_always" },
        { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const driver = driverFor(agent);
    const { handlers, events } = collectHandlers(async () => ({
      behavior: "allow",
    }));

    const handle = await driver.start({ taskId: "t1", brief: "go" }, handlers);
    await handle.wait();
    const answer = agent.permissionAnswer();
    expect(answer?.result).toEqual({
      outcome: { outcome: "selected", optionId: "opt-reject" },
    });
    expect(events.join("\n")).toContain("STANDING grant");
  });

  it("a deny from the bridge selects reject_once; a bridge THROW also denies (fail closed)", async () => {
    for (const bridge of [
      async (): Promise<ApprovalDecision> => ({
        behavior: "deny",
        message: "not on my watch",
      }),
      async (): Promise<ApprovalDecision> => {
        throw new Error("inbox unreachable");
      },
    ]) {
      const agent = fakeAcpAgent({ askPermission: true });
      const driver = driverFor(agent);
      const { handlers } = collectHandlers(bridge);
      const handle = await driver.start(
        { taskId: "t1", brief: "go" },
        handlers
      );
      await handle.wait();
      const answer = agent.permissionAnswer();
      expect(answer?.result).toEqual({
        outcome: { outcome: "selected", optionId: "opt-reject-once" },
      });
    }
  });

  it("TODO 1.3: interrupt() sends session/cancel and wait reports 130", async () => {
    const agent = fakeAcpAgent({ askPermission: false });
    const driver = driverFor(agent);
    const { handlers } = collectHandlers();
    const handle = await driver.start({ taskId: "t1", brief: "go" }, handlers);
    await handle.interrupt();
    const result = await handle.wait();
    expect(result.exitCode).toBe(130);
    expect(agent.sentMethods()).toContain(ACP_RPC.sessionCancel);
  });

  it("ADR-0007: tier-1 lanes are refused at construction", () => {
    for (const laneKey of ACP_TIER1_REFUSED) {
      expect(
        () =>
          new AcpSessionDriver({
            laneKey,
            command: "never-spawned",
          })
      ).toThrow(/tier-1/);
    }
  });

  it("BYO-auth: auth_required fails the session honestly and never calls authenticate", async () => {
    const agent = fakeAcpAgent({ authRequired: true });
    const driver = driverFor(agent);
    const { handlers } = collectHandlers();
    await expect(
      driver.start({ taskId: "t1", brief: "go" }, handlers)
    ).rejects.toThrow(/never passes or stores vendor tokens/);
    expect(agent.sentMethods()).not.toContain(ACP_RPC.authenticate);
  });

  it("refuses agent-initiated fs requests with a JSON-RPC error (capability never advertised)", async () => {
    const agent = fakeAcpAgent({ clientRequestMethod: "fs/read_text_file" });
    const driver = driverFor(agent);
    const { handlers, events } = collectHandlers();
    const handle = await driver.start({ taskId: "t1", brief: "go" }, handlers);
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    const errorReply = agent.seen.find(
      (m) => m.method === undefined && m.error !== undefined
    );
    expect(errorReply?.error?.message).toContain("governed tools");
    expect(events.join("\n")).toContain("refused ACP client request");
  });

  it("send() steers MID-TURN with a second prompt; wait resolves after both drain (codex parity: a drained session is over)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = fakeAcpAgent({ firstPromptGate: gate });
    const driver = driverFor(agent);
    const { handlers } = collectHandlers();
    const handle = await driver.start(
      { taskId: "t1", brief: "first" },
      handlers
    );
    // The first turn is held open by the gate — exactly when the runner
    // steers a live session. The send must be accepted, not refused.
    await handle.send("second");
    release();
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    const prompts = agent.seen.filter(
      (m) => m.method === ACP_RPC.sessionPrompt
    );
    expect(prompts).toHaveLength(2);
    // Both turns streamed their chunks (interleaving order is the agent's).
    expect(result.output.match(/hello /g)).toHaveLength(2);
    expect(result.output.match(/world/g)).toHaveLength(2);

    // And AFTER the drain the session is over: a late send is refused loudly
    // rather than silently dropped (the codex-driver contract).
    await expect(handle.send("too late")).rejects.toThrow(/already ended/);
  });
});

describe("selectAcpPermissionOption — the pure guardrail rule", () => {
  const allowOnce = { optionId: "a1", name: "Allow", kind: "allow_once" };
  const allowAlways = { optionId: "aa", name: "Always", kind: "allow_always" };
  const rejectOnce = { optionId: "r1", name: "No", kind: "reject_once" };
  const rejectAlways = { optionId: "ra", name: "Never", kind: "reject_always" };

  it("allow picks allow_once; allow_always is structurally unreachable", () => {
    expect(
      selectAcpPermissionOption("allow", [allowAlways, allowOnce, rejectOnce])
    ).toEqual({ optionId: "a1", downgraded: false });
  });

  it("allow with only a standing grant downgrades to a rejection", () => {
    expect(selectAcpPermissionOption("allow", [allowAlways, rejectOnce])).toEqual(
      { optionId: "r1", downgraded: true }
    );
    expect(
      selectAcpPermissionOption("allow", [allowAlways, rejectAlways])
    ).toEqual({ optionId: "ra", downgraded: true });
    expect(selectAcpPermissionOption("allow", [allowAlways])).toBeNull();
  });

  it("deny prefers reject_once, then reject_always, then null (cancelled)", () => {
    expect(
      selectAcpPermissionOption("deny", [allowOnce, rejectAlways, rejectOnce])
    ).toEqual({ optionId: "r1", downgraded: false });
    expect(selectAcpPermissionOption("deny", [allowOnce, rejectAlways])).toEqual(
      { optionId: "ra", downgraded: false }
    );
    expect(selectAcpPermissionOption("deny", [allowOnce])).toBeNull();
  });
});

describe("registry data path", () => {
  it("no vendor declares acp today, so defaultSessionDrivers stays two drivers (proven in core tests); the kind exists as data", async () => {
    const { VENDOR_REGISTRY } = await import("@muon/protocol");
    const acpVendors = Object.values(VENDOR_REGISTRY).filter(
      (entry) => entry.session.driver === "acp"
    );
    expect(acpVendors).toEqual([]);
    // And any FUTURE acp declaration must carry its launch data; the driver's
    // tier-1 refusal plus this shape check are what make the flip safe.
    for (const entry of Object.values(VENDOR_REGISTRY)) {
      if (entry.session.driver === "acp") {
        expect(entry.session.acp?.command).toBeTruthy();
      }
    }
  });
});

describe("AcpSessionDriver capabilities", () => {
  it("declares send+interrupt (the coordinator seat's mechanical requirements) and no resume yet", () => {
    const driver = driverFor(fakeAcpAgent());
    expect(driver.capabilities).toEqual({
      canSend: true,
      canInterrupt: true,
      canResume: false,
    });
    expect(driver.forwardsVendorStderr).toBe(true);
  });

  it("is hermetic in tests: the vi module mock seam stays untouched", () => {
    // Guard against accidental global mock leakage from other suites.
    expect(vi.isMockFunction(AcpSessionDriver)).toBe(false);
  });
});
