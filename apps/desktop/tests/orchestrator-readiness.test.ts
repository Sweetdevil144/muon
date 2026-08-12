import { describe, expect, it, vi } from "vitest";
import type { VendorReadiness } from "@muon/client";
import {
  orchestratorReadinessError,
  orchestratorReadinessIssue,
  readyOrchestratorFallback,
  verifyOrchestratorReadiness,
} from "../src/lib/orchestrator-readiness.js";

const codexReady: VendorReadiness = {
  vendor: "codex",
  installed: true,
  authenticated: true,
  authState: "confirmed",
  credentialMethod: "custom-provider",
  detail: "Codex custom provider is ready",
};

const claudeReady: VendorReadiness = {
  vendor: "claude-code",
  installed: true,
  authenticated: true,
  authState: "confirmed",
  credentialMethod: "vendor-login",
  detail: "Claude Code is ready",
};

const codexAzureMissing: VendorReadiness = {
  vendor: "codex",
  installed: true,
  authenticated: false,
  authState: "provider-unconfigured",
  detail: "Missing environment variable: AZURE_OPENAI_API_KEY.",
  fixHint:
    "Add export AZURE_OPENAI_API_KEY='…' to ~/.zshenv, restart MUON, then re-check.",
};

describe("Mission orchestrator readiness", () => {
  it("blocks a definite selected-provider configuration failure with actionable detail", () => {
    const issue = orchestratorReadinessIssue(
      [codexAzureMissing, claudeReady],
      "codex"
    );

    expect(issue).toMatchObject({
      label: "Codex",
      blocking: true,
      detail: "Missing environment variable: AZURE_OPENAI_API_KEY.",
    });
    expect(orchestratorReadinessError(issue!)).toContain(
      "restart MUON, then re-check"
    );
    expect(readyOrchestratorFallback([codexAzureMissing, claudeReady], "codex"))
      .toBe("claude-code");
  });

  it("shows an unknown probe honestly without blocking Mission chat", () => {
    const issue = orchestratorReadinessIssue(
      [
        {
          vendor: "codex",
          installed: true,
          authenticated: false,
          authState: "unknown",
          detail: "Codex readiness probe timed out",
        },
      ],
      "codex"
    );

    expect(issue).toMatchObject({
      blocking: false,
      detail: "Codex readiness probe timed out",
    });
  });

  it("refreshes once before enforcing a cached block", async () => {
    const load = vi
      .fn<(refresh: boolean) => Promise<VendorReadiness[] | null>>()
      .mockResolvedValueOnce([codexAzureMissing])
      .mockResolvedValueOnce([codexReady]);

    await expect(verifyOrchestratorReadiness("codex", load)).resolves.toBeNull();
    expect(load).toHaveBeenNthCalledWith(1, false);
    expect(load).toHaveBeenNthCalledWith(2, true);
  });

  it("does not add a fresh vendor probe to a healthy turn", async () => {
    const load = vi
      .fn<(refresh: boolean) => Promise<VendorReadiness[] | null>>()
      .mockResolvedValue([codexReady]);

    await expect(verifyOrchestratorReadiness("codex", load)).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(false);
  });
});
