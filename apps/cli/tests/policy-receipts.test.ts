import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/lib/api-client.js";
import { registerPolicyCommand } from "../src/commands/policy.js";

// `muon policy receipts` — the human-visible ledger of live, content-bound,
// expiring receipts. Read-only; a receipt is only ever minted by an explicit
// operator opt-in on one approval decision.

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

const receipt = {
  id: "receipt-1",
  approvalId: "approval-1",
  taskId: "task-1",
  jobId: "job-1",
  sessionId: "session-1",
  workspacePath: "/repo",
  actionClass: "edit",
  toolName: "Edit",
  payloadDigest: "d".repeat(64),
  manifestFingerprint: null,
  expiresAt: "2026-07-17T01:00:00.000Z",
  revokedAt: null,
  useCount: 3,
  lastUsedAt: "2026-07-17T00:30:00.000Z",
  createdAt: "2026-07-17T00:00:00.000Z",
};

async function runReceipts(
  args: string[],
  createClient: () => MuonApiClient
): Promise<{ out: string; err: string; exitCode: number }> {
  const program = new Command();
  program.exitOverride();
  registerPolicyCommand(program, createClient);
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "muon", "policy", "receipts", ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
  return { out: out.join(""), err: err.join(""), exitCode };
}

afterEach(() => {
  process.exitCode = 0;
});

describe("muon policy receipts", () => {
  it("lists live receipts with their exact binding evidence", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse({ receipts: [receipt] }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const { out, exitCode } = await runReceipts([], () => client);

    expect(exitCode).toBe(0);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/receipts?activeOnly=true"),
      expect.anything()
    );
    expect(out).toContain("receipt-1");
    expect(out).toContain("Edit");
    expect(out).toContain("edit");
    expect(out).toContain("d".repeat(12));
    expect(out).not.toContain("d".repeat(64));
    expect(out).toContain("/repo");
    expect(out).toContain("2026-07-17T01:00:00.000Z");
    expect(out).toContain("3");
  });

  it("filters by workspace and emits JSON with --json", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse({ receipts: [receipt] }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const { out, exitCode } = await runReceipts(
      ["--workspace", "/repo", "--json"],
      () => client
    );

    expect(exitCode).toBe(0);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("workspacePath=%2Frepo"),
      expect.anything()
    );
    const parsed = JSON.parse(out);
    expect(parsed.receipts).toHaveLength(1);
    expect(parsed.receipts[0].id).toBe("receipt-1");
  });

  it("says so plainly when no receipts are live", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse({ receipts: [] }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const { out, exitCode } = await runReceipts([], () => client);

    expect(exitCode).toBe(0);
    expect(out).toMatch(/no live receipts/i);
  });

  it("reports a reachability failure without a stack trace", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const { err, exitCode } = await runReceipts([], () => client);

    expect(exitCode).toBe(1);
    expect(err).toContain("fetch failed");
  });
});
