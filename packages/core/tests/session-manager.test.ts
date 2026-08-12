import { describe, expect, it, vi } from "vitest";
import type {
  LaneSessionDriver,
  SessionHandle,
  SessionHandlers,
} from "@muon/adapters";
import { policyProfileSchema, type LaneEvent, type PolicyProfile } from "@muon/protocol";
import {
  classifyShellCommandRisk,
  startManagedSession,
  type SessionLedger,
  type StartManagedSessionInput,
} from "../src/session-manager.js";

function fakeLedger(overrides: Partial<SessionLedger> = {}): SessionLedger & {
  calls: Record<string, unknown[][]>;
  order: string[];
} {
  const calls: Record<string, unknown[][]> = {
    createSession: [],
    updateSession: [],
    requestApproval: [],
    waitForApproval: [],
    consumeApproval: [],
  };
  const order: string[] = [];
  return {
    calls,
    order,
    createSession: async (...args) => {
      calls.createSession!.push(args);
      order.push("createSession");
      return { id: "session-1" };
    },
    updateSession: async (...args) => {
      calls.updateSession!.push(args);
      order.push("updateSession");
      return {};
    },
    requestApproval: async (...args) => {
      calls.requestApproval!.push(args);
      order.push("requestApproval");
      return { id: "approval-1" };
    },
    waitForApproval: async (...args) => {
      calls.waitForApproval!.push(args);
      order.push("waitForApproval");
    },
    consumeApproval: async (...args) => {
      calls.consumeApproval!.push(args);
      order.push("consumeApproval");
    },
    ...overrides,
  };
}

function fakeDriver(
  run: (handlers: SessionHandlers) => Promise<{ exitCode: number; output: string }>
): LaneSessionDriver {
  return {
    laneKey: "fake-lane",
    capabilities: { canSend: true, canInterrupt: true, canResume: false },
    start: async (_input, handlers) => {
      const done = run(handlers);
      const handle: SessionHandle = {
        vendorSessionId: "vendor-42",
        send: async () => undefined,
        interrupt: async () => undefined,
        wait: () => done,
      };
      return handle;
    },
  };
}

const baseInput = {
  laneKey: "fake-lane",
  laneId: "lane-db-1",
  taskId: "task-1",
  brief: "do the work",
  onEvent: (_event: LaneEvent) => undefined,
};

describe("startManagedSession", () => {
  it("records the session, vendor id, and end status in the ledger", async () => {
    const ledger = fakeLedger();
    const driver = fakeDriver(async () => ({ exitCode: 0, output: "done" }));

    const session = await startManagedSession(ledger, baseInput, [driver]);
    const result = await session.handle.wait();

    expect(result.exitCode).toBe(0);
    expect(ledger.calls.createSession![0]![0]).toMatchObject({
      laneId: "lane-db-1",
      taskId: "task-1",
    });
    const updates = ledger.calls.updateSession!.map(
      (args) => args[0] as Record<string, unknown>
    );
    expect(updates.some((u) => u.vendorSessionId === "vendor-42")).toBe(true);
    expect(updates[updates.length - 1]).toMatchObject({ status: "ended" });
  });

  it("bridges tool requests into approvals and allows when approved", async () => {
    const ledger = fakeLedger();
    const decisions: string[] = [];
    const driver = fakeDriver(async (handlers) => {
      const decision = await handlers.onApprovalRequest({
        toolName: "Bash",
        input: { command: "npm test" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      decisions.push(decision.behavior);
      return { exitCode: 0, output: "" };
    });

    const session = await startManagedSession(ledger, baseInput, [driver]);
    await session.handle.wait();

    expect(decisions).toEqual(["allow"]);
    expect(ledger.calls.requestApproval![0]![0]).toMatchObject({
      taskId: "task-1",
      kind: "command",
      evidence: {
        action: "Bash",
        scope: "Command: npm test",
        riskLevel: "high",
        impactIfApproved:
          "Runs a shell command in the selected workspace and may read, modify, or delete files.",
        details: {
          command: "npm test",
          sessionId: "session-1",
        },
      },
    });
    expect(
      (
        ledger.calls.requestApproval![0]![0] as {
          evidence: { payloadDigest: string };
        }
      ).evidence.payloadDigest
    ).toMatch(/^[a-f0-9]{64}$/);
    const statuses = ledger.calls.updateSession!.map(
      (args) => (args[0] as Record<string, unknown>).status
    );
    expect(statuses).toContain("waiting_approval");
  });

  it("redacts credential-shaped tool input before approval evidence is stored", async () => {
    const ledger = fakeLedger();
    const driver = fakeDriver(async (handlers) => {
      await handlers.onApprovalRequest({
        toolName: "Bash",
        input: { command: "curl -H 'Authorization: Bearer sk-secretvalue1234567890'" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      return { exitCode: 0, output: "" };
    });

    const session = await startManagedSession(ledger, baseInput, [driver]);
    await session.handle.wait();

    const request = ledger.calls.requestApproval![0]![0] as {
      evidence: { scope: string; details: Record<string, string> };
    };
    expect(request.evidence.scope).not.toContain("sk-secretvalue");
    expect(request.evidence.details.command).toContain("[redacted]");
  });

  it("an unclassifiable tool is riskLevel UNKNOWN, never dressed as low (round-3 #7)", async () => {
    const ledger = fakeLedger();
    const driver = fakeDriver(async (handlers) => {
      // Matches none of the shell/write/read name classes — MUON knows
      // nothing about what this tool does.
      await handlers.onApprovalRequest({
        toolName: "mcp__payments__transfer",
        input: { amount: 12 },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      return { exitCode: 0, output: "" };
    });

    const session = await startManagedSession(ledger, baseInput, [driver]);
    await session.handle.wait();

    expect(ledger.calls.requestApproval![0]![0]).toMatchObject({
      evidence: {
        riskLevel: "unknown",
        impactIfApproved:
          "MUON could not classify this tool. Treat it as able to do anything the session's authority allows.",
      },
    });
  });

  it("a NETWORKED tool never rides the read class into low (WebSearch → unknown)", async () => {
    // /search/ matches "websearch", but WebSearch is egress — a plausible
    // exfiltration channel — not a workspace read (review finding #5).
    const ledger = fakeLedger();
    const driver = fakeDriver(async (handlers) => {
      await handlers.onApprovalRequest({
        toolName: "WebSearch",
        input: { query: "public info" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      await handlers.onApprovalRequest({
        toolName: "WebFetch",
        input: { url: "https://example.com" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      return { exitCode: 0, output: "" };
    });

    const session = await startManagedSession(ledger, baseInput, [driver]);
    await session.handle.wait();

    expect(ledger.calls.requestApproval![0]![0]).toMatchObject({
      evidence: { riskLevel: "unknown" },
    });
    expect(ledger.calls.requestApproval![1]![0]).toMatchObject({
      evidence: { riskLevel: "unknown" },
    });
  });

  it("the whole mcp__ namespace is unknown — a remote 'search' is not a workspace read", async () => {
    // mcp__github__search_repositories matched /search/ → low; and
    // mcp__supabase__execute_sql matched /exec/ → a shell sentence about a
    // workspace it never touches. Neither name says anything about THIS
    // workspace, so neither gets a computed class (round 6 #7).
    const ledger = fakeLedger();
    const driver = fakeDriver(async (handlers) => {
      await handlers.onApprovalRequest({
        toolName: "mcp__github__search_repositories",
        input: { query: "leaked-secret" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      await handlers.onApprovalRequest({
        toolName: "mcp__supabase__execute_sql",
        input: { sql: "select 1" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      return { exitCode: 0, output: "" };
    });

    const session = await startManagedSession(ledger, baseInput, [driver]);
    await session.handle.wait();

    for (const index of [0, 1]) {
      expect(ledger.calls.requestApproval![index]![0]).toMatchObject({
        evidence: {
          riskLevel: "unknown",
          impactIfApproved:
            "MUON could not classify this tool. Treat it as able to do anything the session's authority allows.",
        },
      });
    }
  });

  it("a read-class tool stays low — unknown is for the unclassifiable only", async () => {
    const ledger = fakeLedger();
    const driver = fakeDriver(async (handlers) => {
      await handlers.onApprovalRequest({
        toolName: "Grep",
        input: { pattern: "x" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      return { exitCode: 0, output: "" };
    });

    const session = await startManagedSession(ledger, baseInput, [driver]);
    await session.handle.wait();

    expect(ledger.calls.requestApproval![0]![0]).toMatchObject({
      evidence: { riskLevel: "low" },
    });
  });

  it("fails closed: denies the tool when approval is rejected or times out", async () => {
    const ledger = fakeLedger({
      waitForApproval: async () => {
        throw new Error("approval rejected");
      },
    });
    const decisions: { behavior: string; message?: string }[] = [];
    const driver = fakeDriver(async (handlers) => {
      const decision = await handlers.onApprovalRequest({
        toolName: "Bash",
        input: { command: "rm -rf /" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      decisions.push(decision);
      return { exitCode: 1, output: "" };
    });

    const session = await startManagedSession(ledger, baseInput, [driver]);
    const result = await session.handle.wait();

    expect(decisions[0]!.behavior).toBe("deny");
    expect(decisions[0]!.message).toContain("MUON denied");
    expect(result.exitCode).toBe(1);
  });

  it("orchestrator fast-deny: an un-preauthorized coordinator tool denies FAST without filing or waiting", async () => {
    // FIX B defense-in-depth: a coordinator session has no operator watching its
    // approval inbox and cannot self-approve, so filing + blocking on
    // waitForApproval could ONLY 300s-hang then fail closed. With the
    // orchestrator-only flag set, an un-granted tool denies IMMEDIATELY.
    const ledger = fakeLedger();
    const decisions: { behavior: string; message?: string }[] = [];
    const driver = fakeDriver(async (handlers) => {
      const decision = await handlers.onApprovalRequest({
        toolName: "Bash",
        input: { command: "npm test" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      decisions.push(decision);
      return { exitCode: 0, output: "" };
    });

    const session = await startManagedSession(
      ledger,
      { ...baseInput, noInteractiveApprover: true },
      [driver]
    );
    await session.handle.wait();

    // Denied FAST: no approval row filed, nothing waited on, nothing consumed,
    // and no status flap to waiting_approval — so it can never block on an
    // operator-less inbox. The message is actionable (names the tool + the grant
    // path), so the vendor can react instead of retrying into a hang.
    expect(decisions[0]!.behavior).toBe("deny");
    expect(decisions[0]!.message).toContain("MUON denied");
    expect(decisions[0]!.message).toContain("Bash");
    expect(decisions[0]!.message).toMatch(/harness|pre-authorized/i);
    expect(ledger.calls.requestApproval).toEqual([]);
    expect(ledger.calls.waitForApproval).toEqual([]);
    expect(ledger.calls.consumeApproval).toEqual([]);
    const statuses = ledger.calls.updateSession!.map(
      (args) => (args[0] as Record<string, unknown>).status
    );
    expect(statuses).not.toContain("waiting_approval");
  });

  it("WORKER path unchanged: without the orchestrator flag the SAME tool files an approval and BLOCKS on the human gate (300s)", async () => {
    // The exact human-in-the-loop path the fast-deny must NOT weaken: a worker/
    // delegate session (no noInteractiveApprover) files an approval and blocks on
    // waitForApproval — the very call the 300s fail-closed timeout guards.
    const ledger = fakeLedger();
    const decisions: string[] = [];
    const driver = fakeDriver(async (handlers) => {
      const decision = await handlers.onApprovalRequest({
        toolName: "Bash",
        input: { command: "npm test" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      decisions.push(decision.behavior);
      return { exitCode: 0, output: "" };
    });

    const session = await startManagedSession(ledger, baseInput, [driver]);
    await session.handle.wait();

    expect(decisions).toEqual(["allow"]);
    expect(ledger.calls.requestApproval.length).toBe(1);
    expect(ledger.calls.waitForApproval.length).toBe(1);
    const statuses = ledger.calls.updateSession!.map(
      (args) => (args[0] as Record<string, unknown>).status
    );
    expect(statuses).toContain("waiting_approval");
  });

  // ── Full Auto: the standing-approver lease ────────────────────────────────
  //
  // The live bug: with "FULL AUTO — SAFETY GATES OFF" on screen and every gate
  // deliberately switched off, the coordinator's `Bash` was still denied — the
  // fast-deny's premise ("no operator watches this inbox") had become false and
  // nothing downstream could learn it. These lock BOTH directions: the grant
  // works, and everything that is not a live, well-formed grant still denies
  // with today's exact message.

  /** Today's fast-deny sentence, asserted byte-for-byte. */
  const FAST_DENY =
    "MUON denied: coordinator tool 'Bash' is not pre-authorized and no operator watches the coordinator's approval inbox. Grant it via the harness (preauthorizedTools) so this exact tool is admitted without asking.";

  const liveGrant = (ms = 30_000) =>
    ({
      active: true,
      expiresAt: new Date(Date.now() + ms).toISOString(),
    }) as const;

  /** One coordinator `Bash` call through the seam; returns what it decided. */
  async function coordinatorBash(
    ledger: ReturnType<typeof fakeLedger>,
    resolveStandingApprover?: StartManagedSessionInput["resolveStandingApprover"],
    calls = 1
  ) {
    const decisions: { behavior: string; message?: string }[] = [];
    const driver = fakeDriver(async (handlers) => {
      for (let i = 0; i < calls; i += 1) {
        decisions.push(
          await handlers.onApprovalRequest({
            toolName: "Bash",
            input: { command: "ls" },
            taskId: "task-1",
            laneKey: "fake-lane",
          })
        );
      }
      return { exitCode: 0, output: "" };
    });
    const session = await startManagedSession(
      ledger,
      { ...baseInput, noInteractiveApprover: true, resolveStandingApprover },
      [driver]
    );
    await session.handle.wait();
    return decisions;
  }

  it("FULL AUTO ON: a live standing-approver lease sends the coordinator's Bash through the NORMAL approval path", async () => {
    // The fix. An operator-tier decider really is watching, so MUON asks instead
    // of refusing to ask: file → wait → consume → allow, with the decision
    // recorded exactly like a worker's. Nothing is auto-allowed inside the seam.
    const ledger = fakeLedger();

    const decisions = await coordinatorBash(ledger, async () => liveGrant());

    expect(decisions[0]!.behavior).toBe("allow");
    expect(ledger.calls.requestApproval!.length).toBe(1);
    expect(ledger.calls.waitForApproval!.length).toBe(1);
    expect(ledger.calls.consumeApproval!.length).toBe(1);
    expect(ledger.calls.requestApproval![0]![0]).toMatchObject({
      kind: "command",
      evidence: { action: "Bash", scope: "Command: ls" },
    });
    const statuses = ledger.calls.updateSession!.map(
      (args) => (args[0] as Record<string, unknown>).status
    );
    expect(statuses).toContain("waiting_approval");
  });

  it("FULL AUTO OFF: an inactive grant still returns today's exact fast-deny, filing and waiting on nothing", async () => {
    const ledger = fakeLedger();

    const decisions = await coordinatorBash(ledger, async () => ({
      active: false,
    }));

    expect(decisions[0]!.behavior).toBe("deny");
    expect(decisions[0]!.message).toBe(FAST_DENY);
    expect(ledger.calls.requestApproval).toEqual([]);
    expect(ledger.calls.waitForApproval).toEqual([]);
    expect(ledger.calls.consumeApproval).toEqual([]);
  });

  it("STALE lease fails closed: an expired grant is not a watcher, so the fast-deny fires", async () => {
    // The crash case. A desktop that published `active:true` and then died must
    // NOT leave the coordinator ungated: the lease carries its own expiry, and
    // once it passes the grant is worth exactly nothing.
    const ledger = fakeLedger();

    const decisions = await coordinatorBash(ledger, async () => ({
      active: true,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    }));

    expect(decisions[0]!.message).toBe(FAST_DENY);
    expect(ledger.calls.requestApproval).toEqual([]);
  });

  it("fails closed on every OTHER way a grant can be untrustworthy (absent, malformed, impossible horizon, thrown)", async () => {
    const cases: Array<StartManagedSessionInput["resolveStandingApprover"]> = [
      // No resolver at all — a caller that never wired Full Auto up.
      undefined,
      // Resolved, but the approver is not there.
      async () => undefined,
      // An unparseable instant.
      async () => ({ active: true, expiresAt: "not-a-date" }),
      // A hand-edited row far past any TTL the issuer could mint: believing it
      // would buy a grant nothing could ever revoke.
      async () => liveGrant(365 * 24 * 60 * 60 * 1_000),
      // Control offline / refused the credential.
      async () => {
        throw new Error("control offline");
      },
    ];

    for (const resolveStandingApprover of cases) {
      const ledger = fakeLedger();
      const decisions = await coordinatorBash(ledger, resolveStandingApprover);
      expect(decisions[0]!.message).toBe(FAST_DENY);
      expect(ledger.calls.requestApproval).toEqual([]);
    }
  });

  it("REVOKED MID-SESSION: the lease is re-read per call, so the next tool call after Full Auto goes off denies", async () => {
    // Why the grant is a resolver and not a snapshot: standing consent can be
    // withdrawn while the vendor is still talking, and a value captured at
    // session start would keep a revoked posture alive for the whole run.
    const ledger = fakeLedger();
    let watching = true;

    const decisions = await coordinatorBash(
      ledger,
      async () => (watching ? ((watching = false), liveGrant()) : { active: false }),
      2
    );

    expect(decisions[0]!.behavior).toBe("allow");
    expect(decisions[1]!.behavior).toBe("deny");
    expect(decisions[1]!.message).toBe(FAST_DENY);
    // Exactly ONE call was ever filed: the second never reached the inbox.
    expect(ledger.calls.requestApproval!.length).toBe(1);
  });

  it("the grant is not blanket coverage: a standing approver that REFUSES this call still denies it", async () => {
    // Keeps the UI's honesty claim true. The lease only buys the right to ASK;
    // the decision is still made downstream, and a request standing consent does
    // not actually cover comes back as the real gate's refusal (surfaced to the
    // human by reconcileFullAutoWatch), never as an implied blanket approval.
    const ledger = fakeLedger({
      waitForApproval: async () => {
        throw new Error("Approval 'approval-1' was rejected (not covered).");
      },
    });

    const decisions = await coordinatorBash(ledger, async () => liveGrant());

    expect(decisions[0]!.behavior).toBe("deny");
    expect(decisions[0]!.message).toContain("was rejected");
    // It reached the inbox — the human saw it — and it was never auto-allowed.
    expect(ledger.calls.requestApproval!.length).toBe(1);
    expect(ledger.calls.consumeApproval).toEqual([]);
  });

  it("WORKER path untouched: a session without the coordinator flag never consults the lease", async () => {
    const ledger = fakeLedger();
    const resolveStandingApprover = vi.fn(async () => ({ active: false }) as const);
    const driver = fakeDriver(async (handlers) => {
      await handlers.onApprovalRequest({
        toolName: "Bash",
        input: { command: "npm test" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      return { exitCode: 0, output: "" };
    });

    const session = await startManagedSession(
      ledger,
      { ...baseInput, resolveStandingApprover },
      [driver]
    );
    await session.handle.wait();

    // A worker's human-in-the-loop gate does not depend on standing consent in
    // either direction: it files and blocks exactly as before.
    expect(resolveStandingApprover).not.toHaveBeenCalled();
    expect(ledger.calls.requestApproval!.length).toBe(1);
  });

  it("persists the vendor session id at first knowledge, before wait() resolves", async () => {
    const ledger = fakeLedger();
    let fire!: () => void;
    let finish!: () => void;
    const done = new Promise<{ exitCode: number; output: string }>(
      (resolve) => {
        finish = () => resolve({ exitCode: 0, output: "" });
      }
    );
    const driver: LaneSessionDriver = {
      laneKey: "fake-lane",
      capabilities: { canSend: true, canInterrupt: true, canResume: false },
      start: async (_input, handlers) => {
        // Simulates the vendor announcing its session id MID-STREAM (a kill
        // right after this must not lose the resume handle).
        fire = () => handlers.onVendorSessionId?.("vendor-early");
        return {
          vendorSessionId: undefined,
          send: async () => undefined,
          interrupt: async () => undefined,
          wait: () => done,
        };
      },
    };

    const session = await startManagedSession(ledger, baseInput, [driver]);
    fire();
    // The persist is fired asynchronously; give it a tick — but the session is
    // still RUNNING (wait has not resolved), which is the whole point.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ledger.calls.updateSession).toContainEqual([
      { sessionId: "session-1", vendorSessionId: "vendor-early" },
    ]);

    finish();
    await session.handle.wait();
  });

  it("threads jobId into the session record and the session gate", async () => {
    const ledger = fakeLedger();
    const driver = fakeDriver(async (handlers) => {
      await handlers.onApprovalRequest({
        toolName: "Bash",
        input: { command: "npm test" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      return { exitCode: 0, output: "" };
    });

    const session = await startManagedSession(
      ledger,
      { ...baseInput, jobId: "job-7" },
      [driver]
    );
    await session.handle.wait();

    expect(ledger.calls.createSession![0]![0]).toMatchObject({
      laneId: "lane-db-1",
      taskId: "task-1",
      jobId: "job-7",
    });
    expect(ledger.calls.requestApproval![0]![0]).toMatchObject({
      jobId: "job-7",
    });
  });

  it("consume-before-allow: stamps delivery after approve and before the vendor gets allow", async () => {
    const ledger = fakeLedger();
    const decisions: string[] = [];
    const driver = fakeDriver(async (handlers) => {
      const decision = await handlers.onApprovalRequest({
        toolName: "Bash",
        input: { command: "npm test" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      decisions.push(decision.behavior);
      return { exitCode: 0, output: "" };
    });

    const session = await startManagedSession(ledger, baseInput, [driver]);
    await session.handle.wait();

    expect(decisions).toEqual(["allow"]);
    expect(ledger.calls.consumeApproval).toEqual([["approval-1"]]);
    // Durable meaning: consumedAt != null ⇔ the allow reached the vendor. So
    // the stamp lands strictly after the human decision and strictly before
    // the vendor observes allow.
    expect(ledger.order.indexOf("consumeApproval")).toBeGreaterThan(
      ledger.order.indexOf("waitForApproval")
    );
  });

  it("fails closed: denies the tool when the consumption stamp cannot land", async () => {
    const ledger = fakeLedger({
      consumeApproval: async () => {
        throw new Error("consume conflict");
      },
    });
    const decisions: { behavior: string; message?: string }[] = [];
    const driver = fakeDriver(async (handlers) => {
      const decision = await handlers.onApprovalRequest({
        toolName: "Bash",
        input: { command: "npm test" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      decisions.push(decision);
      return { exitCode: 1, output: "" };
    });

    const session = await startManagedSession(ledger, baseInput, [driver]);
    await session.handle.wait();

    expect(decisions[0]!.behavior).toBe("deny");
    expect(decisions[0]!.message).toContain("MUON denied");
  });

  it("never consumes when the approval wait itself fails (approved-but-undelivered stays provable)", async () => {
    const ledger = fakeLedger({
      waitForApproval: async () => {
        throw new Error("session torn down before decision delivery");
      },
    });
    const decisions: string[] = [];
    const driver = fakeDriver(async (handlers) => {
      const decision = await handlers.onApprovalRequest({
        toolName: "Bash",
        input: { command: "npm test" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      decisions.push(decision.behavior);
      return { exitCode: 1, output: "" };
    });

    const session = await startManagedSession(ledger, baseInput, [driver]);
    await session.handle.wait();

    expect(decisions).toEqual(["deny"]);
    expect(ledger.calls.consumeApproval).toEqual([]);
  });

  it("throws an actionable error for lanes without a session driver", async () => {
    const ledger = fakeLedger();
    await expect(
      startManagedSession(ledger, { ...baseInput, laneKey: "cursor" }, [])
    ).rejects.toThrow(/no interactive session driver/);
  });

  it("does not launch the vendor driver when authority is lost during ledger setup", async () => {
    const controller = new AbortController();
    const ledger = fakeLedger({
      createSession: async () => {
        controller.abort();
        return { id: "session-aborted" };
      },
    });
    const start = vi.fn();
    const driver: LaneSessionDriver = {
      laneKey: "fake-lane",
      capabilities: { canSend: true, canInterrupt: true, canResume: false },
      start,
    };

    await expect(
      startManagedSession(
        ledger,
        { ...baseInput, signal: controller.signal },
        [driver]
      )
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(start).not.toHaveBeenCalled();
    expect(ledger.calls.updateSession).toContainEqual([
      { sessionId: "session-aborted", status: "interrupted" },
    ]);
  });
});

// ── P0.4 slice 2: policy simulation + content-bound receipts at the ONE seam ──
//
// Every case below pins one direction of the fail-closed contract:
//   • a policy/receipt auto-allow is always visible (an `approval.auto` event)
//     and never files an approval row or flaps session status;
//   • a policy deny adds friction with a simulation reason, never silently;
//   • anything unclassifiable, mismatched, erroring, or unconfigured falls
//     through to TODAY'S gate path byte-identically (the suite above pins the
//     missing-profile baseline UNCHANGED).

function makeProfile(overrides: Record<string, unknown> = {}): PolicyProfile {
  return policyProfileSchema.parse({
    version: 1,
    label: "seam-test",
    postures: {
      read: "allow",
      test: "allow",
      edit: "gate",
      network: "gate",
      merge: "gate",
      ship: "gate",
    },
    editInRadius: "allow",
    taskRadius: ["src"],
    ...overrides,
  });
}

function requestTool(
  toolName: string,
  input: unknown
): (handlers: SessionHandlers) => Promise<{ exitCode: number; output: string }> {
  return async (handlers) => {
    const decision = await handlers.onApprovalRequest({
      toolName,
      input,
      taskId: "task-1",
      laneKey: "fake-lane",
    });
    return {
      exitCode: 0,
      output: JSON.stringify(decision),
    };
  };
}

async function runSeam(options: {
  profile?: PolicyProfile;
  policy?: boolean;
  workspacePath?: string;
  jobId?: string;
  executionCwd?: string;
  checkCommands?: string[];
  toolName: string;
  toolInput: unknown;
  ledgerOverrides?: Partial<SessionLedger>;
  breakProfile?: boolean;
}) {
  const events: LaneEvent[] = [];
  const ledger = fakeLedger(options.ledgerOverrides ?? {});
  const driver = fakeDriver(requestTool(options.toolName, options.toolInput));
  const profile = options.profile ?? makeProfile();
  const session = await startManagedSession(
    ledger,
    {
      ...baseInput,
      jobId: options.jobId,
      workspacePath: options.workspacePath,
      // CODE-C: the seam now reads the top-level checkCommands (present with or
      // without a policy profile), mirroring the runner. Passed through here so
      // a no-profile scenario can still classify Bash as `test`.
      checkCommands: options.checkCommands,
      policy:
        options.policy === false
          ? undefined
          : {
              profile: options.breakProfile
                ? ({
                    ...profile,
                    taskRadius: null as unknown as string[],
                  } as PolicyProfile)
                : profile,
              executionCwd: options.executionCwd ?? "/ws",
              checkCommands: options.checkCommands ?? ["npm test"],
            },
      onEvent: (event) => events.push(event),
    },
    [driver]
  );
  const result = await session.handle.wait();
  const decision = JSON.parse(result.output) as {
    behavior: string;
    message?: string;
  };
  const statuses = ledger.calls.updateSession!.map(
    (args) => (args[0] as Record<string, unknown>).status
  );
  return { events, ledger, decision, statuses };
}

describe("startManagedSession policy seam (P0.4)", () => {
  it("policy allow (read): no approval row, no status flap, one visible approval.auto event", async () => {
    const { events, ledger, decision, statuses } = await runSeam({
      toolName: "Read",
      toolInput: { file_path: "src/a.ts" },
      workspacePath: "/ws",
      jobId: "job-1",
    });

    expect(decision.behavior).toBe("allow");
    expect(ledger.calls.requestApproval).toEqual([]);
    expect(ledger.calls.consumeApproval).toEqual([]);
    expect(statuses).not.toContain("waiting_approval");
    const auto = events.find((event) => event.kind === "approval.auto");
    expect(auto).toBeDefined();
    expect(auto!.metadata).toMatchObject({
      source: "policy",
      actionClass: "read",
    });
    expect(auto!.metadata.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("policy deny: denies with the simulation reason, files no approval row, emits task.blocked", async () => {
    const { events, ledger, decision } = await runSeam({
      profile: makeProfile({
        postures: {
          read: "allow",
          test: "allow",
          edit: "gate",
          network: "deny",
          merge: "gate",
          ship: "gate",
        },
      }),
      toolName: "WebFetch",
      toolInput: { url: "https://example.com" },
      workspacePath: "/ws",
      jobId: "job-1",
    });

    expect(decision.behavior).toBe("deny");
    expect(decision.message).toContain("reaching outside the workspace");
    expect(ledger.calls.requestApproval).toEqual([]);
    const blocked = events.find((event) => event.kind === "task.blocked");
    expect(blocked).toBeDefined();
    expect(blocked!.message).toContain("MUON policy denied");
  });

  it("policy gate: today's ledger sequence plus the explain-line on the evidence", async () => {
    const { ledger, decision } = await runSeam({
      toolName: "Edit",
      toolInput: { file_path: "/etc/hosts", new_string: "x" },
      workspacePath: "/ws",
      jobId: "job-1",
    });

    expect(decision.behavior).toBe("allow"); // via the human approval path
    expect(ledger.order.indexOf("requestApproval")).toBeGreaterThan(-1);
    const waitingIndex = ledger.calls.updateSession!.findIndex(
      (args) =>
        (args[0] as Record<string, unknown>).status === "waiting_approval"
    );
    expect(waitingIndex).toBeGreaterThan(-1);
    expect(ledger.order.indexOf("waitForApproval")).toBeGreaterThan(
      ledger.order.indexOf("requestApproval")
    );
    expect(ledger.order.indexOf("consumeApproval")).toBeGreaterThan(
      ledger.order.indexOf("waitForApproval")
    );
    const evidence = (
      ledger.calls.requestApproval![0]![0] as {
        evidence: { details: Record<string, string> };
      }
    ).evidence;
    expect(evidence.details.policy).toContain("outside the task radius");
  });

  it("edit inside the absolutized task radius auto-allows", async () => {
    const { ledger, decision, events } = await runSeam({
      toolName: "Edit",
      toolInput: { file_path: "src/inner.ts", new_string: "x" },
      executionCwd: "/ws",
      workspacePath: "/ws",
      jobId: "job-1",
    });

    expect(decision.behavior).toBe("allow");
    expect(ledger.calls.requestApproval).toEqual([]);
    expect(
      events.some(
        (event) =>
          event.kind === "approval.auto" &&
          event.metadata.actionClass === "edit"
      )
    ).toBe(true);
  });

  it("Bash byte-equal to a configured check auto-allows as test", async () => {
    const { ledger, decision, events } = await runSeam({
      toolName: "Bash",
      toolInput: { command: "npm test" },
      checkCommands: ["npm test"],
      workspacePath: "/ws",
      jobId: "job-1",
    });

    expect(decision.behavior).toBe("allow");
    expect(ledger.calls.requestApproval).toEqual([]);
    expect(
      events.some(
        (event) =>
          event.kind === "approval.auto" &&
          event.metadata.actionClass === "test"
      )
    ).toBe(true);
  });

  it("Bash not matching any check gates even under a permissive profile", async () => {
    const { ledger, decision } = await runSeam({
      toolName: "Bash",
      toolInput: { command: "npm run something-else" },
      checkCommands: ["npm test"],
      workspacePath: "/ws",
      jobId: "job-1",
    });

    expect(decision.behavior).toBe("allow"); // via the human approval path
    expect(ledger.calls.requestApproval.length).toBe(1);
  });

  it("git push never auto-allows under ANY profile (unclassifiable ⇒ gate)", async () => {
    const { ledger, events } = await runSeam({
      profile: makeProfile({
        postures: {
          read: "allow",
          test: "allow",
          edit: "allow",
          network: "gate",
          merge: "gate",
          ship: "gate",
        },
        taskRadius: ["/"],
      }),
      toolName: "Bash",
      toolInput: { command: "git push --force origin main" },
      workspacePath: "/ws",
      jobId: "job-1",
    });

    expect(ledger.calls.requestApproval.length).toBe(1);
    expect(events.some((event) => event.kind === "approval.auto")).toBe(false);
  });

  it("receipt hit: allow with a visible approval.auto(source: receipt), no approval row", async () => {
    const redeemReceipt = vi.fn(async () => ({
      receiptId: "rcpt-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const { events, ledger, decision, statuses } = await runSeam({
      policy: false,
      workspacePath: "/ws",
      jobId: "job-1",
      toolName: "Read",
      toolInput: { file_path: "src/a.ts" },
      ledgerOverrides: { redeemReceipt },
    });

    expect(decision.behavior).toBe("allow");
    expect(ledger.calls.requestApproval).toEqual([]);
    expect(statuses).not.toContain("waiting_approval");
    expect(redeemReceipt).toHaveBeenCalledTimes(1);
    expect(redeemReceipt.mock.calls[0]![0]).toMatchObject({
      taskId: "task-1",
      jobId: "job-1",
      sessionId: "session-1",
      workspacePath: "/ws",
      toolName: "Read",
    });
    expect(
      (redeemReceipt.mock.calls[0]![0] as { payloadDigest: string })
        .payloadDigest
    ).toMatch(/^[a-f0-9]{64}$/);
    const auto = events.find((event) => event.kind === "approval.auto");
    expect(auto).toBeDefined();
    expect(auto!.metadata).toMatchObject({
      source: "receipt",
      receiptId: "rcpt-1",
    });
  });

  it("receipt miss gates exactly as today", async () => {
    const redeemReceipt = vi.fn(async () => null);
    const { ledger, decision } = await runSeam({
      policy: false,
      workspacePath: "/ws",
      jobId: "job-1",
      toolName: "Read",
      toolInput: { file_path: "src/a.ts" },
      ledgerOverrides: { redeemReceipt },
    });

    expect(decision.behavior).toBe("allow"); // via the human approval path
    expect(redeemReceipt).toHaveBeenCalledTimes(1);
    expect(ledger.calls.requestApproval.length).toBe(1);
    expect(ledger.order.indexOf("consumeApproval")).toBeGreaterThan(
      ledger.order.indexOf("waitForApproval")
    );
  });

  it("receipt transport failure gates (never denies, never allows)", async () => {
    const redeemReceipt = vi.fn(async () => {
      throw new Error("brain unreachable");
    });
    const { ledger, decision, events } = await runSeam({
      policy: false,
      workspacePath: "/ws",
      jobId: "job-1",
      toolName: "Read",
      toolInput: { file_path: "src/a.ts" },
      ledgerOverrides: { redeemReceipt },
    });

    expect(decision.behavior).toBe("allow"); // via the human approval path
    expect(ledger.calls.requestApproval.length).toBe(1);
    expect(events.some((event) => event.kind === "approval.auto")).toBe(false);
  });

  it("changed content presents a different digest to the receipt store", async () => {
    const redeemReceipt = vi.fn(async () => null);
    const events: LaneEvent[] = [];
    const ledger = fakeLedger({ redeemReceipt });
    const driver = fakeDriver(async (handlers) => {
      await handlers.onApprovalRequest({
        toolName: "Write",
        input: { file_path: "src/a.ts", content: "first version" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      await handlers.onApprovalRequest({
        toolName: "Write",
        input: { file_path: "src/a.ts", content: "second version" },
        taskId: "task-1",
        laneKey: "fake-lane",
      });
      return { exitCode: 0, output: "" };
    });

    const session = await startManagedSession(
      ledger,
      {
        ...baseInput,
        jobId: "job-1",
        workspacePath: "/ws",
        onEvent: (event) => events.push(event),
      },
      [driver]
    );
    await session.handle.wait();

    expect(redeemReceipt).toHaveBeenCalledTimes(2);
    const first = (redeemReceipt.mock.calls[0]![0] as { payloadDigest: string })
      .payloadDigest;
    const second = (
      redeemReceipt.mock.calls[1]![0] as { payloadDigest: string }
    ).payloadDigest;
    expect(first).not.toBe(second);
    // Both missed ⇒ both gated.
    expect(ledger.calls.requestApproval.length).toBe(2);
  });

  it("no workspacePath ⇒ receipts are never consulted", async () => {
    const redeemReceipt = vi.fn(async () => ({
      receiptId: "rcpt-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const { ledger } = await runSeam({
      policy: false,
      workspacePath: undefined,
      jobId: "job-1",
      toolName: "Read",
      toolInput: { file_path: "src/a.ts" },
      ledgerOverrides: { redeemReceipt },
    });

    expect(redeemReceipt).not.toHaveBeenCalled();
    expect(ledger.calls.requestApproval.length).toBe(1);
  });

  it("CODE-C: a test-class receipt redeems with NO policy profile (checkCommands hoisted)", async () => {
    // The default config has no WorkspacePolicyProfile row, so `policy` is
    // undefined. Before the CODE-C fix the seam classified checks with
    // `input.policy?.checkCommands` (undefined) → Bash `npm test` fell to
    // `null` → the receipt path was skipped → the receipt could NEVER redeem,
    // leaving the P0.4 fatigue fix inert by default. With checkCommands hoisted
    // to the top level the byte-equal Bash classifies as `test` and the receipt
    // is consulted.
    const redeemReceipt = vi.fn(async () => ({
      receiptId: "rcpt-test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const { events, ledger, decision } = await runSeam({
      policy: false,
      workspacePath: "/ws",
      jobId: "job-1",
      checkCommands: ["npm test"],
      toolName: "Bash",
      toolInput: { command: "npm test" },
      ledgerOverrides: { redeemReceipt },
    });

    expect(decision.behavior).toBe("allow");
    expect(ledger.calls.requestApproval).toEqual([]);
    expect(redeemReceipt).toHaveBeenCalledTimes(1);
    // SEC-1 wiring: the seam sends the operator-visible target (the command
    // line) alongside the digest so the server can bind on it.
    expect(redeemReceipt.mock.calls[0]![0]).toMatchObject({
      toolName: "Bash",
      resolvedTarget: "npm test",
    });
    expect(
      events.some(
        (event) =>
          event.kind === "approval.auto" && event.metadata.source === "receipt"
      )
    ).toBe(true);
  });

  it("CODE-C: Bash NOT byte-equal to a hoisted check still gates with no profile", async () => {
    // The hoist does not widen auto-allow: a non-matching Bash stays `null` and
    // gates exactly as today even though checkCommands are present.
    const redeemReceipt = vi.fn(async () => ({
      receiptId: "rcpt-test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const { ledger, decision } = await runSeam({
      policy: false,
      workspacePath: "/ws",
      jobId: "job-1",
      checkCommands: ["npm test"],
      toolName: "Bash",
      toolInput: { command: "npm run something-else" },
      ledgerOverrides: { redeemReceipt },
    });

    expect(redeemReceipt).not.toHaveBeenCalled();
    expect(decision.behavior).toBe("allow"); // via the human approval path
    expect(ledger.calls.requestApproval.length).toBe(1);
  });

  it("SEC-1: an edit receipt redemption sends the operator-visible path target", async () => {
    const redeemReceipt = vi.fn(async () => null);
    await runSeam({
      policy: false,
      workspacePath: "/ws",
      jobId: "job-1",
      toolName: "Edit",
      toolInput: { file_path: "src/a.ts", new_string: "x" },
      ledgerOverrides: { redeemReceipt },
    });
    expect(redeemReceipt).toHaveBeenCalledTimes(1);
    expect(redeemReceipt.mock.calls[0]![0]).toMatchObject({
      toolName: "Edit",
      resolvedTarget: "src/a.ts",
    });
  });

  it("a broken profile at simulation time degrades to the gate, never to deny", async () => {
    const { ledger, decision, events } = await runSeam({
      breakProfile: true,
      toolName: "Read",
      toolInput: { file_path: "src/a.ts" },
      workspacePath: "/ws",
      jobId: "job-1",
    });

    expect(decision.behavior).toBe("allow"); // via the human approval path
    expect(ledger.calls.requestApproval.length).toBe(1);
    expect(events.some((event) => event.kind === "approval.auto")).toBe(false);
  });
});

describe("startManagedSession vendor stderr observation", () => {
  /**
   * A driver that reports whether it forwards the vendor's own stderr, and
   * replays whatever the caller supplied through `onDiagnostic`.
   */
  function stderrDriver(forwardsVendorStderr?: boolean): LaneSessionDriver & {
    seen: (string | undefined)[];
  } {
    const seen: (string | undefined)[] = [];
    return {
      seen,
      laneKey: "fake-lane",
      capabilities: { canSend: true, canInterrupt: true, canResume: false },
      ...(forwardsVendorStderr === undefined ? {} : { forwardsVendorStderr }),
      start: async (_input, handlers) => {
        seen.push(handlers.onDiagnostic ? "attached" : undefined);
        handlers.onDiagnostic?.("ERROR: You hit your spend cap.");
        return {
          send: async () => undefined,
          interrupt: async () => undefined,
          wait: async () => ({ exitCode: 0, output: "ok" }),
        };
      },
    };
  }

  it("forwards the sink to the driver and announces attachment BEFORE the launch", async () => {
    const driver = stderrDriver(true);
    const chunks: string[] = [];
    const order: string[] = [];
    const ledger = fakeLedger();
    const attachedBeforeSession = { value: false };

    await startManagedSession(
      ledger,
      {
        laneKey: "fake-lane",
        laneId: "lane-1",
        taskId: "task-1",
        brief: "go",
        onEvent: () => undefined,
        onDiagnostic: (chunk) => {
          order.push("diagnostic");
          chunks.push(chunk);
        },
        onVendorStderrAttached: () => {
          order.push("attached");
          attachedBeforeSession.value = ledger.calls.createSession!.length === 0;
        },
      },
      [driver]
    );

    expect(chunks.join("")).toContain("You hit your spend cap");
    // Announced at driver SELECTION, before the ledger write and before the
    // vendor can hang: the watchdog may fire long before this call resolves.
    expect(order[0]).toBe("attached");
    expect(attachedBeforeSession.value).toBe(true);
  });

  it("stays SILENT about attachment for a driver that does not declare stderr forwarding", async () => {
    // The honesty invariant: a caller may only claim "the vendor produced
    // nothing on stderr" when something was actually listening.
    const driver = stderrDriver(undefined);
    const onVendorStderrAttached = vi.fn();

    await startManagedSession(
      fakeLedger(),
      {
        laneKey: "fake-lane",
        laneId: "lane-1",
        taskId: "task-1",
        brief: "go",
        onEvent: () => undefined,
        onDiagnostic: () => undefined,
        onVendorStderrAttached,
      },
      [driver]
    );

    expect(onVendorStderrAttached).not.toHaveBeenCalled();
  });

  it("never announces attachment when the caller supplied no sink", async () => {
    const driver = stderrDriver(true);
    const onVendorStderrAttached = vi.fn();

    await startManagedSession(
      fakeLedger(),
      {
        laneKey: "fake-lane",
        laneId: "lane-1",
        taskId: "task-1",
        brief: "go",
        onEvent: () => undefined,
        onVendorStderrAttached,
      },
      [driver]
    );

    expect(onVendorStderrAttached).not.toHaveBeenCalled();
    expect(driver.seen).toEqual([undefined]);
  });
});

// Risk used to be TOOL-shaped: every Bash was [risk: high], `git status`
// included — a label that is always the same trains its reader to ignore it.
// LOW is a positive grammar (ADR-0022); everything unrecognized stays HIGH.
describe("classifyShellCommandRisk (action-shaped shell risk)", () => {
  it("recognizes plainly read-only commands as low", () => {
    for (const command of [
      "ls -la",
      "git status",
      "git log --oneline -5",
      "git diff HEAD~1",
      "grep -rn TODO src",
      "cat package.json | jq .name",
      "FOO=bar ls",
      "echo hello && pwd",
    ]) {
      expect(classifyShellCommandRisk(command), command).toBe("low");
    }
  });

  it("keeps anything with a write path, execution, or unknown head HIGH", () => {
    for (const command of [
      "rm -rf build",
      "npm test",
      "echo hi > file.txt", // redirection writes
      "ls $(rm -rf /)", // command substitution
      "cat `whoami`", // backticks
      "git branch -D main", // git verb outside the read-only set
      "git push", // ditto
      "sort -o out.txt in.txt", // sort writes via -o, so sort is not listed
      "sed -i '' s/a/b/ file", // sed -i writes
      "find . -delete",
      "./ls", // path-invoked binary is NOT the allowlisted one
      "ls; rm -rf /", // one dangerous segment poisons the line
      "", // an empty command proves nothing
    ]) {
      expect(classifyShellCommandRisk(command), command).toBe("high");
    }
  });

  it("over-splitting on quoted separators only ever promotes to HIGH", () => {
    // The `;` lives inside quotes — the shell runs ONE grep. The naive
    // splitter sees a second segment headed `rm`, so it says HIGH: a false
    // positive in the fail-closed direction, never a false LOW.
    expect(classifyShellCommandRisk('grep "a; rm -rf /" file')).toBe("high");
  });
});
