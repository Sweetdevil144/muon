import { Command } from "commander";
import { describe, expect, it, vi, afterEach } from "vitest";
import { registerApproveCommands } from "../src/commands/approve.js";
import type { MuonApiClient } from "../src/lib/api-client.js";

function run(argv: string[], client: Partial<MuonApiClient>) {
  const program = new Command();
  program.exitOverride();
  registerApproveCommands(program, () => client as MuonApiClient);
  return program.parseAsync(["node", "muon", ...argv]);
}

const resolved = {
  id: "approval-1",
  taskId: "task-1",
  requestedBy: "codex",
  kind: "command",
  reason: "r",
  status: "approved",
};

describe("muon approve resolve --remember (P0.4 receipts)", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  it("mints a content-bound receipt on an approval", async () => {
    const resolveApproval = vi.fn().mockResolvedValue(resolved);
    await run(
      [
        "approve",
        "resolve",
        "--approval-id",
        "approval-1",
        "--status",
        "approved",
        "--remember",
        "60000",
      ],
      { resolveApproval } as unknown as Partial<MuonApiClient>
    );
    expect(resolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        status: "approved",
        receipt: { ttlMs: 60000 },
      })
    );
  });

  it("refuses --remember on a rejection up front (a rejection can't be remembered) — never silently swallowed", async () => {
    const resolveApproval = vi.fn();
    await run(
      [
        "approve",
        "resolve",
        "--approval-id",
        "approval-1",
        "--status",
        "rejected",
        "--remember",
        "60000",
      ],
      { resolveApproval } as unknown as Partial<MuonApiClient>
    );
    // Fail fast BEFORE any backend call, honest exit code — not a silent no-op.
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects an out-of-range ttl before calling the backend", async () => {
    const resolveApproval = vi.fn();
    await run(
      [
        "approve",
        "resolve",
        "--approval-id",
        "approval-1",
        "--status",
        "approved",
        "--remember",
        "10", // below the 60000ms floor
      ],
      { resolveApproval } as unknown as Partial<MuonApiClient>
    );
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("prints the exact merge review before manual attestation", async () => {
    const getApprovalReviewCertification = vi.fn().mockResolvedValue({
      status: "blocked",
      blockCode: "review-blind",
      reason: "REVIEW BLIND: inspect src/new.ts",
      changedFiles: ["src/new.ts"],
      blindFiles: ["src/new.ts"],
      artifactDigest: "a".repeat(64),
    });
    await run(
      [
        "approve",
        "review",
        "--approval-id",
        "approval-1",
        "--json",
      ],
      {
        getApprovalReviewCertification,
      } as unknown as Partial<MuonApiClient>
    );
    expect(getApprovalReviewCertification).toHaveBeenCalledWith("approval-1");
  });

  it("attests only the exact REVIEW BLIND digest returned by the server", async () => {
    const getApprovalReviewCertification = vi.fn().mockResolvedValue({
      status: "blocked",
      blockCode: "review-blind",
      reason: "REVIEW BLIND: inspect src/new.ts",
      changedFiles: ["src/new.ts"],
      blindFiles: ["src/new.ts"],
      artifactDigest: "b".repeat(64),
    });
    const resolveApproval = vi.fn().mockResolvedValue({
      ...resolved,
      kind: "merge",
    });
    await run(
      [
        "approve",
        "resolve",
        "--approval-id",
        "approval-1",
        "--status",
        "approved",
        "--attest-review-blind",
        "b".repeat(64),
      ],
      {
        getApprovalReviewCertification,
        resolveApproval,
      } as unknown as Partial<MuonApiClient>
    );
    expect(resolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        manualReview: {
          acknowledged: true,
          artifactDigest: "b".repeat(64),
          blindFiles: ["src/new.ts"],
        },
      })
    );
  });

  it("rejects a stale manual-review digest before resolving", async () => {
    const getApprovalReviewCertification = vi.fn().mockResolvedValue({
      status: "blocked",
      blockCode: "review-blind",
      reason: "REVIEW BLIND: inspect src/new.ts",
      changedFiles: ["src/new.ts"],
      blindFiles: ["src/new.ts"],
      artifactDigest: "c".repeat(64),
    });
    const resolveApproval = vi.fn();
    await run(
      [
        "approve",
        "resolve",
        "--approval-id",
        "approval-1",
        "--status",
        "approved",
        "--attest-review-blind",
        "d".repeat(64),
      ],
      {
        getApprovalReviewCertification,
        resolveApproval,
      } as unknown as Partial<MuonApiClient>
    );
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

// ── ADR-0056: the graded form ────────────────────────────────────────────────

describe("muon approve resolve --remember-scope (ADR-0056 grades)", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  it("sends the grade, never a TTL — the expiry is the server's to compute", async () => {
    for (const duration of ["once", "session", "always"] as const) {
      const resolveApproval = vi.fn().mockResolvedValue(resolved);
      await run(
        [
          "approve",
          "resolve",
          "--approval-id",
          "approval-1",
          "--status",
          "approved",
          "--remember-scope",
          duration,
        ],
        { resolveApproval } as unknown as Partial<MuonApiClient>
      );
      const payload = resolveApproval.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(payload.grant).toEqual({ duration });
      expect(payload).not.toHaveProperty("receipt");
    }
  });

  it("refuses an unknown grade rather than guessing one", async () => {
    const resolveApproval = vi.fn();
    await run(
      [
        "approve",
        "resolve",
        "--approval-id",
        "approval-1",
        "--status",
        "approved",
        "--remember-scope",
        "forever",
      ],
      { resolveApproval } as unknown as Partial<MuonApiClient>
    );
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(0);
  });

  it("refuses a grade on a rejection (a rejection can't be remembered)", async () => {
    const resolveApproval = vi.fn();
    await run(
      [
        "approve",
        "resolve",
        "--approval-id",
        "approval-1",
        "--status",
        "rejected",
        "--remember-scope",
        "always",
      ],
      { resolveApproval } as unknown as Partial<MuonApiClient>
    );
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("refuses --remember and --remember-scope together (one durable authority)", async () => {
    const resolveApproval = vi.fn();
    await run(
      [
        "approve",
        "resolve",
        "--approval-id",
        "approval-1",
        "--status",
        "approved",
        "--remember",
        "60000",
        "--remember-scope",
        "always",
      ],
      { resolveApproval } as unknown as Partial<MuonApiClient>
    );
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("announces a minted grant and names the verb that kills it", async () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
    const resolveApproval = vi.fn().mockResolvedValue({
      ...resolved,
      grant: {
        id: "grant-1",
        approvalId: "approval-1",
        taskId: "task-1",
        workspacePath: "/repo",
        actionClass: "test",
        toolName: "Bash",
        payloadDigest: "d".repeat(64),
        resolvedTarget: "npm test",
        policyFingerprint: "f".repeat(32),
        originJobId: "job-1",
        expiresAt: "2026-08-25T12:00:00.000Z",
        useCount: 0,
      },
    });
    await run(
      [
        "approve",
        "resolve",
        "--approval-id",
        "approval-1",
        "--status",
        "approved",
        "--remember-scope",
        "always",
        "--json",
      ],
      { resolveApproval } as unknown as Partial<MuonApiClient>
    );
    spy.mockRestore();
    const announced = writes.join("");
    expect(announced).toContain("npm test");
    expect(announced).toContain("chat task-1");
    expect(announced).toContain("2026-08-25T12:00:00.000Z");
    expect(announced).toContain("muon policy revoke --grant-id grant-1");
  });
});
