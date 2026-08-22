import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/api-client.js";
import { buildApprovalDecision } from "../src/approval-decision.js";

// ── ADR-0056 client surface ──────────────────────────────────────────────────
//
// Two properties, both cross-surface: the ONE decision builder every surface
// shares carries the grade (so a grant cannot become a per-surface dialect the
// way `decisionNotes` once did), and the wire calls are declared explicitly
// rather than relying on passthrough — a body-reconstruction refactor must not
// be able to silently drop an authority field.

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

const grantRow = {
  id: "grant-1",
  approvalId: "approval-1",
  taskId: "task-1",
  workspacePath: "/ws",
  actionClass: "test" as const,
  toolName: "Bash",
  payloadDigest: "a".repeat(64),
  resolvedTarget: "npm test",
  policyFingerprint: "f".repeat(32),
  originJobId: "job-1",
  expiresAt: "2026-08-25T12:00:00.000Z",
  revokedAt: null,
  useCount: 0,
  lastUsedAt: null,
  createdAt: "2026-08-18T12:00:00.000Z",
};

describe("buildApprovalDecision carries the grade", () => {
  it("sends the grade every surface chose, `once` included", () => {
    for (const duration of ["once", "session", "always"] as const) {
      expect(
        buildApprovalDecision({
          approvalId: "approval-1",
          status: "approved",
          surface: "MUON CLI",
          grantDuration: duration,
        }).grant
      ).toEqual({ duration });
    }
  });

  it("omits the field entirely when no surface asked", () => {
    expect(
      buildApprovalDecision({
        approvalId: "approval-1",
        status: "approved",
        surface: "MUON TUI",
      })
    ).not.toHaveProperty("grant");
  });

  it("refuses two durable authorities rather than silently picking one", () => {
    expect(() =>
      buildApprovalDecision({
        approvalId: "approval-1",
        status: "approved",
        surface: "MUON desktop",
        receiptTtlMs: 900_000,
        grantDuration: "always",
      })
    ).toThrow(/one durable authority/);
  });

  it("still attributes the surface — the grade never replaces the note", () => {
    const payload = buildApprovalDecision({
      approvalId: "approval-1",
      status: "approved",
      surface: "MUON CLI",
      notes: "checked the diff",
      grantDuration: "always",
    });
    expect(payload.decisionNotes).toBe("checked the diff (decided from MUON CLI)");
  });
});

describe("MuonApiClient grant surface", () => {
  it("resolveApproval sends the grade and returns the minted grant", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        approval: {
          id: "approval-1",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "session tool 'Bash'",
          status: "approved",
        },
        grant: grantRow,
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const result = await client.resolveApproval({
      approvalId: "approval-1",
      status: "approved",
      grant: { duration: "always" },
    });
    const body = JSON.parse((fetcher.mock.calls[0]![1] as { body: string }).body);
    expect(body.grant).toEqual({ duration: "always" });
    expect(body).not.toHaveProperty("receipt");
    expect(result.grant?.id).toBe("grant-1");
    expect(result.grant?.expiresAt).toBe(grantRow.expiresAt);
  });

  it("a backend that mints no grant still parses (the field is optional)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        approval: {
          id: "approval-1",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "session tool 'Bash'",
          status: "approved",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const result = await client.resolveApproval({
      approvalId: "approval-1",
      status: "approved",
      grant: { duration: "once" },
    });
    expect(result.grant).toBeUndefined();
    expect(result.status).toBe("approved");
  });

  it("redeemApprovalGrant posts every binding field and reports a miss as data", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse({ redeemed: false }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const result = await client.redeemApprovalGrant({
      taskId: "task-1",
      jobId: "job-2",
      sessionId: "session-2",
      workspacePath: "/ws",
      toolName: "Bash",
      payloadDigest: "a".repeat(64),
      resolvedTarget: "npm test",
    });
    expect(result).toEqual({ redeemed: false });
    const [url, init] = fetcher.mock.calls[0] as [string, { body: string }];
    expect(url).toContain("/api/grants/redeem");
    expect(JSON.parse(init.body)).toEqual({
      taskId: "task-1",
      jobId: "job-2",
      sessionId: "session-2",
      workspacePath: "/ws",
      toolName: "Bash",
      payloadDigest: "a".repeat(64),
      resolvedTarget: "npm test",
    });
  });

  it("listApprovalGrants filters by live, workspace and chat", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse({ grants: [grantRow] }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const grants = await client.listApprovalGrants({
      activeOnly: true,
      workspacePath: "/ws",
      taskId: "task-1",
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.policyFingerprint).toBe(grantRow.policyFingerprint);
    const url = fetcher.mock.calls[0]![0] as string;
    expect(url).toContain("activeOnly=true");
    expect(url).toContain("taskId=task-1");
  });

  it("revokeApprovalGrant POSTs the kill switch and returns the stamped row", async () => {
    const revoked = { ...grantRow, revokedAt: "2026-08-18T13:00:00.000Z" };
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse({ grant: revoked }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const grant = await client.revokeApprovalGrant("grant-1");
    expect(grant.revokedAt).toBe(revoked.revokedAt);
    const [url, init] = fetcher.mock.calls[0] as [string, { method: string }];
    expect(url).toContain("/api/grants/grant-1/revoke");
    expect(init.method).toBe("POST");
  });
});
