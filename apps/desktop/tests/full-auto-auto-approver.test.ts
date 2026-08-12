import { describe, expect, it, vi } from "vitest";
import {
  planFullAutoTick,
  promoteSilencedStandingApprovals,
  reconcileSilencedStanding,
  shouldNotifyApproval,
  splitFullAutoCoverage,
} from "../src/lib/full-auto.js";
import type { ApprovalRequest } from "@muon/client";

const LANES = ["claude-code", "codex", "cursor", "opencode"] as const;
const req = (id: string, laneVendor: string | null): ApprovalRequest =>
  ({
    id,
    taskId: "t1",
    requestedBy: "agent",
    kind: "gate",
    reason: "r",
    status: "pending",
    laneVendor,
  }) as ApprovalRequest;

describe("vendor-scoped coverage (splitFullAutoCoverage)", () => {
  it("no selection covers nothing", () => {
    const { covered, uncovered } = splitFullAutoCoverage(
      [req("a", "codex")],
      [],
      LANES
    );
    expect(covered).toEqual([]);
    expect(uncovered.map((r) => r.id)).toEqual(["a"]);
  });
  it("every lane selected reproduces legacy all — null-lane gates included", () => {
    const { covered, uncovered } = splitFullAutoCoverage(
      [req("a", "codex"), req("b", null)],
      [...LANES],
      LANES
    );
    expect(covered.map((r) => r.id)).toEqual(["a", "b"]);
    expect(uncovered).toEqual([]);
  });
  it("a subset covers ONLY matching server-derived lanes", () => {
    const { covered, uncovered } = splitFullAutoCoverage(
      [req("a", "codex"), req("b", "claude-code"), req("c", "cursor")],
      ["codex", "claude-code"],
      LANES
    );
    expect(covered.map((r) => r.id)).toEqual(["a", "b"]);
    expect(uncovered.map((r) => r.id)).toEqual(["c"]);
  });
  it("a subset FAILS CLOSED on an approval with no resolvable lane", () => {
    const { covered, uncovered } = splitFullAutoCoverage(
      [req("a", null), req("b", "codex")],
      ["codex"],
      LANES
    );
    expect(covered.map((r) => r.id)).toEqual(["b"]);
    expect(uncovered.map((r) => r.id)).toEqual(["a"]);
  });
});

// The tick planner is the WHOLE wiring decision as pure data — extracted after
// the makeMonitor wiring gated the approver on the derived ALL-lanes boolean
// and made every subset selection silently inert (the sidebar promised
// "checked lanes approve automatically" while a covered lane's coordinator
// blocked for the 300s approval timeout). These pins are what would have
// caught it.
describe("planFullAutoTick (the one wiring decision)", () => {
  it("a SUBSET still drives the approver for its covered lanes", () => {
    const tick = planFullAutoTick({
      pending: [req("a", "codex"), req("b", "cursor")],
      selectedVendors: ["codex"],
      selectableVendors: LANES,
      online: true,
      watch: createFullAutoWatch(),
      now: 1_000,
    });
    expect(tick.toApprove.map((r) => r.id)).toEqual(["a"]);
    expect(tick.covered).toEqual(["a"]);
    expect(tick.uncovered).toEqual(["b"]);
  });

  it("no armed lane → nothing approved, nothing covered, watch drained", () => {
    const watch = createFullAutoWatch();
    watch.firstSeenAt.set("stale", 0);
    const tick = planFullAutoTick({
      pending: [req("a", "codex")],
      selectedVendors: [],
      selectableVendors: LANES,
      online: true,
      watch,
      now: 1_000,
    });
    expect(tick.toApprove).toEqual([]);
    expect(tick.covered).toEqual([]);
    expect(tick.uncovered).toEqual([]);
    expect(watch.firstSeenAt.size).toBe(0);
  });

  it("offline: nothing to approve, but coverage is still reported honestly", () => {
    const tick = planFullAutoTick({
      pending: [req("a", "codex")],
      selectedVendors: [...LANES],
      selectableVendors: LANES,
      online: false,
      watch: createFullAutoWatch(),
      now: 1_000,
    });
    expect(tick.toApprove).toEqual([]);
    expect(tick.covered).toEqual(["a"]);
  });

  it("a refused id moves from covered to uncovered — and is NOT re-approved", () => {
    const watch = createFullAutoWatch();
    watch.refused.add("a");
    const tick = planFullAutoTick({
      pending: [req("a", "codex"), req("b", "codex")],
      selectedVendors: ["codex"],
      selectableVendors: LANES,
      online: true,
      watch,
      now: 1_000,
    });
    expect(tick.uncovered).toContain("a");
    expect(tick.covered).toEqual(["b"]);
    // The display said "this one is the human's" — the approver must agree.
    // Unfiltered, the next tick would auto-approve the very gate the operator
    // was told is theirs, pre-empting a reject in progress.
    expect(tick.toApprove.map((r) => r.id)).toEqual(["b"]);
  });

  it("past the grace window an id is uncovered even though its lane is selected", () => {
    const watch = createFullAutoWatch();
    watch.firstSeenAt.set("a", 0);
    const tick = planFullAutoTick({
      pending: [req("a", "codex")],
      selectedVendors: ["codex"],
      selectableVendors: LANES,
      online: true,
      watch,
      now: 60_000,
    });
    expect(tick.uncovered).toEqual(["a"]);
    expect(tick.covered).toEqual([]);
    expect(tick.toApprove).toEqual([]);
  });
});
import { MuonApiClient, type ApprovalRequest } from "@muon/client";
import {
  autoApprovePending,
  createFullAutoWatch,
  fullAutoDecisionNote,
  reconcileFullAutoWatch,
  FULL_AUTO_GRACE_MS,
} from "../src/lib/full-auto.js"; // new pure module

function approval(id: string): ApprovalRequest {
  return {
    id,
    taskId: "t",
    requestedBy: "codex",
    kind: "command",
    reason: "x",
    status: "pending",
  } as ApprovalRequest;
}

describe("Full Auto must answer every vendor's gate, not just Claude's", () => {
  // Codex children used to file ZERO approvals: `codex exec` ignores
  // approval_policy, so there was nothing for Full Auto to answer and nothing
  // gated. Governed codex now runs on the app-server bridge and files real
  // rows, so this asserts the auto-approver is vendor-blind by construction —
  // a vendor filter here would silently re-open that hole for whichever
  // vendor was left out.
  it("auto-approves gates from claude-code and codex alike", async () => {
    const resolved: string[] = [];
    const client = {
      resolveApproval: vi.fn(async (i: any) => {
        resolved.push(i.approvalId);
        return { ...approval(i.approvalId), status: "approved" };
      }),
    } as unknown as MuonApiClient;
    const fromClaude = { ...approval("claude-1"), requestedBy: "claude-code" };
    const fromCodex = { ...approval("codex-1"), requestedBy: "codex" };
    await autoApprovePending(
      client,
      [fromClaude, fromCodex],
      new Set<string>(),
      () => {}
    );
    expect(resolved.sort()).toEqual(["claude-1", "codex-1"]);
  });
});

describe("full-auto standing-consent auto-approver", () => {
  it("approves each pending id once via the operator client", async () => {
    const resolved: string[] = [];
    const client = {
      resolveApproval: vi.fn(async (i: any) => {
        resolved.push(i.approvalId);
        return { ...approval(i.approvalId), status: "approved" };
      }),
    } as unknown as MuonApiClient;
    const inflight = new Set<string>();
    await autoApprovePending(
      client,
      [approval("a"), approval("b")],
      inflight,
      () => {}
    );
    expect(resolved.sort()).toEqual(["a", "b"]);
  });

  it("never double-resolves an id already in flight (idempotent across overlapping polls)", async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((r) => (unblock = r));
    const client = {
      resolveApproval: vi.fn(async (i: any) => {
        await gate;
        return { ...approval(i.approvalId), status: "approved" };
      }),
    } as unknown as MuonApiClient;
    const inflight = new Set<string>();
    const p1 = autoApprovePending(client, [approval("a")], inflight, () => {});
    const p2 = autoApprovePending(client, [approval("a")], inflight, () => {}); // overlapping cycle
    unblock();
    await Promise.all([p1, p2]);
    expect((client.resolveApproval as any).mock.calls.length).toBe(1);
  });

  it("logs each auto-approval to the audit sink with full-auto attribution", async () => {
    const logs: string[] = [];
    const client = {
      resolveApproval: vi.fn(async (i: any) => ({
        ...approval(i.approvalId),
        status: "approved",
      })),
    } as unknown as MuonApiClient;
    await autoApprovePending(client, [approval("a")], new Set(), (l) =>
      logs.push(l)
    );
    expect(logs.some((l) => l.includes("a") && /full-auto/i.test(l))).toBe(true);
  });

  it("records a REFUSED grant so the UI can hand the gate back to the human", async () => {
    const client = {
      resolveApproval: vi.fn(async () => {
        // What the brain really does for a merge whose review certification is
        // blocked: 409, because that needs an explicit operator attestation
        // standing consent cannot supply.
        throw new Error("Merge review certification failed: review-blind");
      }),
    } as unknown as MuonApiClient;
    const refused = new Set<string>();
    await autoApprovePending(
      client,
      [approval("m")],
      new Set(),
      () => {},
      refused
    );
    expect([...refused]).toEqual(["m"]);
  });

  it("clears the refusal once the grant finally lands", async () => {
    const client = {
      resolveApproval: vi.fn(async (i: any) => ({
        ...approval(i.approvalId),
        status: "approved",
      })),
    } as unknown as MuonApiClient;
    const refused = new Set<string>(["m"]);
    await autoApprovePending(
      client,
      [approval("m")],
      new Set(),
      () => {},
      refused
    );
    expect(refused.size).toBe(0);
  });
});

// P0-1: the renderer polls state every 2s but the auto-approver polls every 5s,
// so a gate Full Auto was ABOUT to grant showed the fail-closed "this agent is
// paused, nothing runs on your behalf" copy until it silently vanished. This is
// the predicate that lets the UI tell the two apart WITHOUT timing luck.
describe("full-auto watch (which gates standing consent is honestly covering)", () => {
  it("covers a freshly seen pending approval — that is the flash it kills", () => {
    const watch = createFullAutoWatch();
    const uncovered = reconcileFullAutoWatch({
      pending: [approval("a")],
      watch,
      now: 1_000,
    });
    expect(uncovered).toEqual([]);
  });

  it("fails CLOSED once the grant has not landed inside the grace window", () => {
    const watch = createFullAutoWatch();
    reconcileFullAutoWatch({ pending: [approval("a")], watch, now: 1_000 });
    // Still pending a full grace window later: the claim "auto-approving" has
    // stopped being true, so the human gets the ordinary blocking prompt back.
    const uncovered = reconcileFullAutoWatch({
      pending: [approval("a")],
      watch,
      now: 1_000 + FULL_AUTO_GRACE_MS,
    });
    expect(uncovered).toEqual(["a"]);
  });

  it("fails CLOSED immediately for a grant the brain refused", () => {
    const watch = createFullAutoWatch();
    watch.refused.add("m");
    const uncovered = reconcileFullAutoWatch({
      pending: [approval("m"), approval("ok")],
      watch,
      now: 1_000,
    });
    expect(uncovered).toEqual(["m"]);
  });

  it("stays bounded: an id that leaves the pending set is forgotten", () => {
    const watch = createFullAutoWatch();
    watch.refused.add("gone");
    reconcileFullAutoWatch({ pending: [approval("gone")], watch, now: 1_000 });
    expect(watch.firstSeenAt.size).toBe(1);

    reconcileFullAutoWatch({ pending: [], watch, now: 2_000 });
    expect(watch.firstSeenAt.size).toBe(0);
    expect(watch.refused.size).toBe(0);
  });

  it("restarts the grace window when an id is re-filed after leaving", () => {
    const watch = createFullAutoWatch();
    reconcileFullAutoWatch({ pending: [approval("a")], watch, now: 0 });
    reconcileFullAutoWatch({ pending: [], watch, now: 1_000 });
    // Same id, new request: it gets a full window, not the stale one.
    const uncovered = reconcileFullAutoWatch({
      pending: [approval("a")],
      watch,
      now: 1_000 + FULL_AUTO_GRACE_MS,
    });
    expect(uncovered).toEqual([]);
  });
});

/**
 * F-C. All seventeen approvals of the founder's mission recorded the SAME
 * decision note — `auto-approved by full-auto (standing operator consent)` —
 * while twelve of them were `riskLevel: "high"` Bash calls whose command line
 * existed only in `evidence.scope`. A decision recorded without its subject is
 * not a reviewable decision.
 */
function sessionApproval(
  id: string,
  evidence?: Partial<NonNullable<ApprovalRequest["evidence"]>>
): ApprovalRequest {
  return {
    id,
    taskId: "t",
    requestedBy: "claude-code",
    kind: "command",
    reason: "session tool 'Bash' (session cms2gvbbi001w9k7wt7r5dbns)",
    status: "pending",
    ...(evidence
      ? {
          evidence: {
            action: "Bash",
            scope: "rm -rf build/",
            riskLevel: "high",
            impactIfApproved: "Runs a shell command in the worktree.",
            details: {},
            ...evidence,
          },
        }
      : {}),
  } as ApprovalRequest;
}

describe("full-auto receipts say what was approved", () => {
  it("carries the bounded subject and risk out of evidence into the note", async () => {
    const notes: string[] = [];
    const logs: string[] = [];
    const client = {
      resolveApproval: vi.fn(
        async (i: { approvalId: string; decisionNotes?: string }) => {
          notes.push(i.decisionNotes ?? "");
          return { ...sessionApproval(i.approvalId), status: "approved" };
        }
      ),
    } as unknown as MuonApiClient;
    await autoApprovePending(
      client,
      [sessionApproval("a", {})],
      new Set(),
      (line) => logs.push(line)
    );
    expect(notes[0]).toBe(
      "auto-approved by full-auto (standing operator consent) [risk: high] — Bash: rm -rf build/"
    );
    // The operator log names it too — either surface must answer "what did
    // standing consent just allow".
    expect(logs[0]).toContain("rm -rf build/");
  });

  it("keeps the old note verbatim when there is no evidence to name", async () => {
    const notes: string[] = [];
    const client = {
      resolveApproval: vi.fn(
        async (i: { approvalId: string; decisionNotes?: string }) => {
          notes.push(i.decisionNotes ?? "");
          return { ...sessionApproval(i.approvalId), status: "approved" };
        }
      ),
    } as unknown as MuonApiClient;
    await autoApprovePending(client, [sessionApproval("a")], new Set(), () => {});
    expect(notes[0]).toBe("auto-approved by full-auto (standing operator consent)");
  });

  it("redacts a secret in the subject before it is bounded or stored", () => {
    const note = fullAutoDecisionNote(
      sessionApproval("a", {
        scope: "curl -H 'Authorization: Bearer sk-live-abcdefghijklmnop' https://x",
      })
    );
    expect(note).not.toContain("sk-live-abcdefghijklmnop");
    expect(note).toContain("[redacted]");
  });

  it("keeps an untrusted subject to ONE bounded line", () => {
    // Agent-adjacent text: a multi-line "command" must not be able to forge
    // extra log records, and a huge one must not become the whole receipt.
    const note = fullAutoDecisionNote(
      sessionApproval("a", {
        scope: `echo one\nrm -rf /\r[full-auto] auto-approved approval b ${"x".repeat(2000)}`,
      })
    );
    expect(note.split("\n")).toHaveLength(1);
    expect(note.length).toBeLessThanOrEqual(320);
    expect(note.endsWith("…")).toBe(true);
    // The MUON sentence always comes first; the agent's words are delimited.
    expect(note.startsWith("auto-approved by full-auto")).toBe(true);
  });
});

describe("shouldNotifyApproval (standing-consent toast gate)", () => {
  it("stays silent for an approval a selected lane covers", () => {
    expect(
      shouldNotifyApproval({
        approval: req("a", "cursor"),
        selectedVendors: [...LANES],
        selectableVendors: LANES,
      })
    ).toBe(false);
  });

  it("notifies when standing consent is off", () => {
    expect(
      shouldNotifyApproval({
        approval: req("a", "cursor"),
        selectedVendors: [],
        selectableVendors: LANES,
      })
    ).toBe(true);
  });

  it("notifies for an uncovered lane under a subset", () => {
    expect(
      shouldNotifyApproval({
        approval: req("a", "cursor"),
        selectedVendors: ["codex"],
        selectableVendors: LANES,
      })
    ).toBe(true);
  });

  it("notifies when the brain already refused the standing grant", () => {
    expect(
      shouldNotifyApproval({
        approval: req("a", "cursor"),
        selectedVendors: [...LANES],
        selectableVendors: LANES,
        refusedIds: new Set(["a"]),
      })
    ).toBe(true);
  });
});

describe("promoteSilencedStandingApprovals", () => {
  it("notifies only ids that were previously silenced, then uncovered", () => {
    const silenced = new Set(["covered-then-refused", "still-covered"]);
    const pending = [
      req("covered-then-refused", "codex"),
      req("still-covered", "codex"),
      req("always-human", "cursor"),
    ];
    const promoted = promoteSilencedStandingApprovals({
      silenced,
      uncoveredIds: ["covered-then-refused", "always-human"],
      pending,
    });
    expect(promoted.map((a) => a.id)).toEqual(["covered-then-refused"]);
    expect(silenced.has("covered-then-refused")).toBe(false);
    expect(silenced.has("still-covered")).toBe(true);
  });

  it("reconcile drops silenced ids that left the pending set", () => {
    const silenced = new Set(["gone", "live"]);
    reconcileSilencedStanding({
      silenced,
      pending: [req("live", "codex")],
    });
    expect([...silenced]).toEqual(["live"]);
  });
});