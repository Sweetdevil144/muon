import { describe, expect, it } from "vitest";
import { assessMcpDrift, explainAuthority } from "../src/mcp-drift.js";
import type { McpStatusReport, McpVendorStatus } from "../src/mcp-status.js";

// F8 (ADR-0019 R2 slice). The inspector is a PURE projection of the status
// report — no new probes — so these tests pin the verdict ladder and the
// authority sentences the desktop panel and `muon mcp status` both render.

function vendor(overrides: Partial<McpVendorStatus>): McpVendorStatus {
  return {
    vendor: "claude-code",
    label: "Claude Code",
    installable: true,
    coordinatorSeat: true,
    cli: "claude",
    cliInstalled: true,
    cliPath: "/usr/local/bin/claude",
    scope: "user",
    scopes: ["user"],
    configPath: "/home/u/.claude.json",
    writer: "vendor-cli",
    verifiedAt: "2026-08-07T00:00:00.000Z",
    installed: true,
    command: "/apps/muon-mcp",
    commandResolves: true,
    mode: null,
    chatId: null,
    reasons: [],
    notes: [],
    ...overrides,
  } as McpVendorStatus;
}

function report(overrides: Partial<McpStatusReport>): McpStatusReport {
  return {
    brainRunning: true,
    dataDir: "/data",
    port: 4000,
    pid: 1,
    apiBase: "http://127.0.0.1:4000",
    baseSource: "lockfile",
    tokenSource: "lockfile.agentToken",
    tier: "agent",
    mode: null,
    toolCount: 25,
    resolvedCommand: "/apps/muon-mcp",
    resolvedCommandSource: "PATH",
    vendors: [],
    wouldGetTierC: false,
    tierCReason: "not attached",
    checks: [],
    ...overrides,
  } as McpStatusReport;
}

describe("assessMcpDrift verdict ladder", () => {
  it("in-sync when registered, resolving, and matching today's install target", () => {
    const drift = assessMcpDrift(report({ vendors: [vendor({})] }));
    expect(drift.vendors[0]!.verdict).toBe("in-sync");
    expect(drift.vendors[0]!.findings).toEqual([]);
  });

  it("broken outranks drift: an unresolvable command is a silent in-CLI failure", () => {
    const drift = assessMcpDrift(
      report({
        vendors: [vendor({ command: "/gone/muon-mcp", commandResolves: false })],
      })
    );
    expect(drift.vendors[0]!.verdict).toBe("broken");
    const finding = drift.vendors[0]!.findings[0]!;
    expect(finding.severity).toBe("error");
    expect(finding.fix).toBe("muon mcp install claude-code");
  });

  it("drifted when the recorded command differs from what install would record NOW", () => {
    const drift = assessMcpDrift(
      report({
        resolvedCommand: "/new/location/muon-mcp",
        vendors: [vendor({ command: "/apps/muon-mcp", commandResolves: true })],
      })
    );
    expect(drift.vendors[0]!.verdict).toBe("drifted");
    expect(drift.vendors[0]!.findings[0]!.detail).toContain("/new/location/muon-mcp");
  });

  it("not-registered and vendor-missing are distinct states with distinct advice", () => {
    const drift = assessMcpDrift(
      report({
        vendors: [
          vendor({ installed: false }),
          vendor({ vendor: "codex", label: "Codex", cli: "codex", cliInstalled: false, cliPath: null, installed: false }),
        ],
      })
    );
    expect(drift.vendors[0]!.verdict).toBe("not-registered");
    expect(drift.vendors[0]!.findings[0]!.fix).toBeTruthy();
    expect(drift.vendors[1]!.verdict).toBe("vendor-missing");
    expect(drift.vendors[1]!.findings[0]!.fix).toBeUndefined();
  });

  it("carries the report's own non-ok reasons through, never hiding a warning", () => {
    const drift = assessMcpDrift(
      report({
        vendors: [
          vendor({
            reasons: [
              { id: "scope-mismatch" as never, level: "fail", detail: "wrong scope" },
            ],
          }),
        ],
      })
    );
    expect(drift.vendors[0]!.verdict).toBe("in-sync");
    expect(drift.vendors[0]!.findings).toEqual([
      { code: "vendor-reason", severity: "error", detail: "wrong scope" },
    ]);
  });
});

describe("explainAuthority", () => {
  it("tier none: zero tools, never operator", () => {
    expect(explainAuthority(report({ tier: "none" }))).toContain("ZERO muon tools");
  });

  it("agent tier: deny-first is stated as absence, not refusal", () => {
    const sentence = explainAuthority(report({}));
    expect(sentence).toContain("ABSENT");
    expect(sentence).toContain("ADR-0028");
  });

  it("tier C names the operator attach as the reason", () => {
    const sentence = explainAuthority(
      report({ wouldGetTierC: true, tierCReason: "attached via desktop.", toolCount: 32 })
    );
    expect(sentence).toContain("Tier C");
    expect(sentence).toContain("attached via desktop.");
  });
});
