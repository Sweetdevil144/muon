import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OBSERVATORY_SCHEMA_VERSION,
  coarseGateRefusal,
  coarseMcpClient,
  coarseMcpTool,
  createObservatory,
  readObservatoryConsent,
} from "../src/observatory.js";

/**
 * The 2026-08-23 observatory additions (grant Track A step 2; ADR-0095).
 *
 * What is pinned is the SHAPE DISCIPLINE, exactly as ADR-0031 demands:
 * every new field is a closed enum or a number, unknown inputs coerce to a
 * closed member (never ride through as prose), the schema version bumped
 * so a parser can trust what it reads, and the shared consent reader
 * fails toward OFF — an absent or torn settings file records nothing.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "muon-observatory-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the 2026-08-23 vocabulary additions", () => {
  it("records identity.gate_passed / gate_refused / mcp.tool_call as shape-bounded rows under schema v2", () => {
    const dir = tempDir();
    const observatory = createObservatory({
      dataDir: dir,
      appVersion: "0.6.1",
      enabled: () => true,
    });
    observatory.record({
      name: "identity.gate_passed",
      surface: "cli",
      trigger: "command",
    });
    observatory.record({
      name: "identity.gate_refused",
      surface: "mcp",
      reason: "unregistered",
      trigger: "tool_call",
    });
    observatory.record({
      name: "mcp.tool_call",
      tool: "memory_search",
      durationMs: 42,
      error: "none",
      client: "claude-code",
    });
    const rows = readFileSync(observatory.spoolPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.schema).toBe(2);
    }
    expect(rows[0]).toMatchObject({
      name: "identity.gate_passed",
      surface: "cli",
      trigger: "command",
    });
    expect(rows[1]).toMatchObject({
      name: "identity.gate_refused",
      surface: "mcp",
      reason: "unregistered",
      trigger: "tool_call",
    });
    expect(rows[2]).toMatchObject({
      name: "mcp.tool_call",
      tool: "memory_search",
      durationMs: 42,
      error: "none",
      client: "claude-code",
    });
    // The 0052 rule: registration is not telemetry. No identity coordinate
    // of any kind rides a gate event — not the token, not the login, not
    // the id, not a digest of it (a small-integer id space makes any
    // unsalted digest reversible, so the digest IS the id).
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        expect(["token", "login", "ghId", "ghLogin", "digest", "id"]).not.toContain(
          key
        );
      }
    }
  });

  it("schema version is bumped to 2 for the vocabulary change", () => {
    expect(OBSERVATORY_SCHEMA_VERSION).toBe(2);
  });
});

describe("closed-set coercers (prose can never ride an enum field)", () => {
  it("coarseGateRefusal collapses arbitrary reasons to the closed set", () => {
    expect(coarseGateRefusal("unregistered")).toBe("unregistered");
    expect(coarseGateRefusal("expired")).toBe("expired");
    expect(coarseGateRefusal("network")).toBe("network");
    expect(coarseGateRefusal("ECONNREFUSED 10.1.2.3 by admin@corp")).toBe(
      "unknown"
    );
    expect(coarseGateRefusal(undefined)).toBe("unknown");
  });

  it("coarseMcpTool admits only the governed tool inventory; everything else is 'other'", () => {
    expect(coarseMcpTool("memory_search")).toBe("memory_search");
    expect(coarseMcpTool("preflight_edit")).toBe("preflight_edit");
    // A hostile or future name never rides through as free text.
    expect(coarseMcpTool("memory_search'; DROP TABLE--")).toBe("other");
    expect(coarseMcpTool("")).toBe("other");
  });

  it("coarseMcpClient admits the four vendors; everything else is 'other'", () => {
    expect(coarseMcpClient("claude-code")).toBe("claude-code");
    expect(coarseMcpClient("codex")).toBe("codex");
    expect(coarseMcpClient("cursor")).toBe("cursor");
    expect(coarseMcpClient("opencode")).toBe("opencode");
    expect(coarseMcpClient("Some IDE v1.2 (build 99)")).toBe("other");
    expect(coarseMcpClient(undefined)).toBe("other");
  });
});

describe("readObservatoryConsent (the ONE machine-wide consent read, ADR-0050 profile)", () => {
  it("absent settings file fails toward OFF with no device id", () => {
    const consent = readObservatoryConsent(tempDir());
    expect(consent).toEqual({ enabled: false, deviceId: null });
  });

  it("reads telemetryEnabled + telemetryDeviceId from the shared settings.json", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        telemetryEnabled: true,
        telemetryDeviceId: "d3adbeef-1234",
      })
    );
    expect(readObservatoryConsent(dir)).toEqual({
      enabled: true,
      deviceId: "d3adbeef-1234",
    });
  });

  it("a torn or hostile settings file fails toward OFF, never a throw", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), "{not json");
    expect(readObservatoryConsent(dir)).toEqual({
      enabled: false,
      deviceId: null,
    });
    const dir2 = tempDir();
    writeFileSync(
      join(dir2, "settings.json"),
      JSON.stringify({ telemetryEnabled: "yes", telemetryDeviceId: 42 })
    );
    // Non-boolean consent is NOT consent; non-string id is no id.
    expect(readObservatoryConsent(dir2)).toEqual({
      enabled: false,
      deviceId: null,
    });
  });
});

describe("surface glue (CLI + muon-mcp construct through ONE helper)", () => {
  it("gateRefusalReasonForState maps 0052 states honestly — never overclaiming expiry", async () => {
    const { gateRefusalReasonForState } = await import("../src/observatory.js");
    // Both closed states mean "no registered identity stands here"; the state
    // machine cannot distinguish never-signed-in from expired, so the coarse
    // reason must not pretend to.
    expect(gateRefusalReasonForState("locked")).toBe("unregistered");
    expect(gateRefusalReasonForState("locked-unregistered")).toBe("unregistered");
    expect(gateRefusalReasonForState("open")).toBe("unknown");
    expect(gateRefusalReasonForState("unarmed")).toBe("unknown");
  });

  it("coarseMcpClient recognizes vendor tokens inside real clientInfo strings", () => {
    expect(coarseMcpClient("Claude Code")).toBe("claude-code");
    expect(coarseMcpClient("cursor-agent 1.2")).toBe("cursor");
    expect(coarseMcpClient("codex-cli")).toBe("codex");
    expect(coarseMcpClient("OpenCode v3")).toBe("opencode");
  });

  it("createSurfaceObservatory wires consent, spool, and uploader from the ONE profile", async () => {
    const { createSurfaceObservatory } = await import("../src/observatory.js");
    const dir = tempDir();
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ telemetryEnabled: true, telemetryDeviceId: "dev-9" })
    );
    const sent: string[] = [];
    const surface = createSurfaceObservatory({
      dataDir: dir,
      appVersion: "0.6.1",
      fetcher: (async (_url: unknown, init?: { body?: string }) => {
        sent.push(String(init?.body ?? ""));
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });
    surface.observatory.record({
      name: "identity.gate_passed",
      surface: "cli",
      trigger: "command",
    });
    await surface.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"identity.gate_passed"');
    expect(sent[0]).toContain('"dev-9"');
  });

  it("createSurfaceObservatory with no consent spools nothing and sends nothing", async () => {
    const { createSurfaceObservatory } = await import("../src/observatory.js");
    const dir = tempDir();
    const fetcher = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const surface = createSurfaceObservatory({
      dataDir: dir,
      appVersion: "0.6.1",
      fetcher,
    });
    surface.observatory.record({
      name: "identity.gate_passed",
      surface: "cli",
      trigger: "command",
    });
    await surface.flush();
    const { existsSync } = await import("node:fs");
    expect(existsSync(surface.observatory.spoolPath)).toBe(false);
  });
});

describe("the review's fix-pass pins (2026-08-23)", () => {
  it("coarseMcpToolError collapses arbitrary strings to the closed set (F10)", async () => {
    const { coarseMcpToolError } = await import("../src/observatory.js");
    expect(coarseMcpToolError("none")).toBe("none");
    expect(coarseMcpToolError("refused")).toBe("refused");
    expect(coarseMcpToolError("timeout")).toBe("timeout");
    expect(coarseMcpToolError("ECONNRESET at /Users/x/secret")).toBe("unknown");
    expect(coarseMcpToolError(undefined)).toBe("unknown");
  });

  it("a malformed device id fails toward NO id — it becomes the wire distinct_id (F9)", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        telemetryEnabled: true,
        telemetryDeviceId: "x".repeat(65),
      })
    );
    expect(readObservatoryConsent(dir)).toEqual({ enabled: true, deviceId: null });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        telemetryEnabled: true,
        telemetryDeviceId: "id with spaces/and/paths",
      })
    );
    expect(readObservatoryConsent(dir).deviceId).toBeNull();
  });

  it("a consent-epoch change discards buffered rows — pre-revocation rows never ship under a new consent (F2)", async () => {
    const { createSurfaceObservatory } = await import("../src/observatory.js");
    const dir = tempDir();
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ telemetryEnabled: true, telemetryDeviceId: "epoch-A" })
    );
    const sent: string[] = [];
    const surface = createSurfaceObservatory({
      dataDir: dir,
      appVersion: "0.6.1",
      fetcher: (async (_url: unknown, init?: { body?: string }) => {
        sent.push(String(init?.body ?? ""));
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });
    surface.observatory.record({
      name: "identity.gate_passed",
      surface: "mcp",
      trigger: "session",
    });
    // Revoke + re-grant while the row sits in the buffer. The consent cache
    // is keyed on settings.json's mtime, so the very next flush observes the
    // new epoch (a short sleep only guards same-millisecond mtime ties).
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ telemetryEnabled: true, telemetryDeviceId: "epoch-B" })
    );
    await surface.flush();
    surface.stop();
    expect(sent).toEqual([]);
  });

  it("summarizeObservatory counts the v2 events — the audit view never under-reports (F3)", async () => {
    const { summarizeObservatory } = await import("../src/observatory.js");
    const dir = tempDir();
    const observatory = createObservatory({
      dataDir: dir,
      appVersion: "0.6.1",
      enabled: () => true,
    });
    observatory.record({ name: "identity.gate_passed", surface: "cli", trigger: "command" });
    observatory.record({
      name: "identity.gate_refused",
      surface: "desktop",
      reason: "unregistered",
      trigger: "launch",
    });
    observatory.record({
      name: "mcp.tool_call",
      tool: "memory_search",
      durationMs: 5,
      error: "none",
      client: "other",
    });
    const summary = summarizeObservatory(dir);
    expect(summary.gatePassed).toBe(1);
    expect(summary.gateRefused).toBe(1);
    expect(summary.mcpToolCalls).toBe(1);
  });
});
