import { describe, expect, it } from "vitest";
import { buildOnboardReport } from "../src/lib/onboard-report.js";
import type { VendorReadiness } from "@muon/client";

const notInstalled: VendorReadiness = {
  vendor: "cursor",
  installed: false,
  authenticated: false,
  detail: "Cursor CLI not found",
  fixHint: "install the Cursor agent CLI (`curl https://cursor.com/install -fsS | bash`), then `cursor-agent login`",
};

const installedNotAuth: VendorReadiness = {
  vendor: "codex",
  installed: true,
  authenticated: false,
  detail: "not logged in",
  fixHint: "log into Codex first: `codex login`",
};

const ready: VendorReadiness = {
  vendor: "claude-code",
  installed: true,
  authenticated: true,
  credentialMethod: "vendor-login",
  detail: "logged in as dev@example.com",
};

const customProviderReady: VendorReadiness = {
  vendor: "codex",
  installed: true,
  authenticated: true,
  credentialMethod: "custom-provider",
  detail: "configured with the active Codex provider",
};

const apiKeyReady: VendorReadiness = {
  vendor: "claude-code",
  installed: true,
  authenticated: true,
  credentialMethod: "api-key",
  detail: "configured with a Claude Code API key",
};

const cursorReady: VendorReadiness = {
  vendor: "cursor",
  installed: true,
  authenticated: true,
  credentialMethod: "vendor-login",
  detail: "logged in as dev@example.com",
};

const opencodeReady: VendorReadiness = {
  vendor: "opencode",
  installed: true,
  authenticated: true,
  credentialMethod: "vendor-login",
  detail: "logged in (2 stored credentials)",
};

describe("buildOnboardReport", () => {
  it("marks a connected role-scoped lane as role-scoped, never a bare 'ready'", () => {
    // Cross-surface parity: the desktop wizard, TUI panel and this report all
    // read the same shared step machine, so all three must say the same true
    // thing about a lane that cannot take the next `muon run`.
    const report = buildOnboardReport([cursorReady, opencodeReady]);
    const text = report.lines.join("\n");
    expect(text).toContain("ready \u00b7 role-scoped");
    expect(text).toContain("reviewer, qa, architect, scout");
    // OpenCode's whole ceiling is one role, so the report must print exactly
    // that — not a wider read-only slice borrowed from Cursor's row.
    expect(text).toContain("scout");
    expect(text).not.toContain("scout, qa, docs");
    // Neither lane can implement, so nothing here is dispatch-ready.
    expect(report.exitCode).toBe(1);
    expect(text).not.toContain("You're ready.");
  });

  it("leaves a full-role lane's status untouched", () => {
    const text = buildOnboardReport([ready]).lines.join("\n");
    expect(text).toContain("ready");
    expect(text).not.toContain("role-scoped");
  });

  it("exits 0 and points at `muon run` when ≥1 vendor is ready", () => {
    const report = buildOnboardReport([ready, installedNotAuth]);
    expect(report.exitCode).toBe(0);
    const text = report.lines.join("\n");
    expect(text).toContain("Claude Code");
    expect(text).toContain("ready");
    expect(text).toContain("muon run");
    // Still surfaces the fix for the vendor that isn't connected.
    expect(text).toContain("codex login");
  });

  it("exits 1 when nothing is ready, printing each per-vendor fix hint", () => {
    const report = buildOnboardReport([notInstalled, installedNotAuth]);
    expect(report.exitCode).toBe(1);
    const text = report.lines.join("\n");
    expect(text).toContain("not installed");
    expect(text).toContain("installed · setup needed");
    expect(text).toContain("cursor-agent login");
    expect(text).toContain("codex login");
    expect(text).toContain("re-check");
  });

  it("labels custom-provider and API-key readiness provenance", () => {
    const text = buildOnboardReport([
      customProviderReady,
      apiKeyReady,
    ]).lines.join("\n");
    expect(text).toContain("ready · custom provider");
    expect(text).toContain("ready · API key");
  });

  it("degrades to manual steps and exits 1 when readiness is unavailable", () => {
    const report = buildOnboardReport(null);
    expect(report.exitCode).toBe(1);
    const text = report.lines.join("\n");
    expect(text).toContain("unavailable");
    expect(text).toMatch(/codex login|cursor-agent login|claude/);
  });

  it("always prints the never-stores-token trust line", () => {
    for (const input of [[ready], [installedNotAuth], null] as const) {
      const text = buildOnboardReport(input).lines.join("\n");
      expect(text).toContain(
        "MUON never stores, logs, or displays vendor credentials"
      );
    }
  });

  it("never prints a token, only booleans + hints", () => {
    const text = buildOnboardReport([
      { ...ready, detail: "logged in as dev@example.com" },
    ]).lines.join("\n");
    expect(text).not.toMatch(/sk-|bearer|secret/i);
  });
});
