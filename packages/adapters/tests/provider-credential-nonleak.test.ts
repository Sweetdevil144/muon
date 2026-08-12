import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaneEvent } from "@muon/protocol";
import {
  buildProviderAwareLaneEnvironment,
  probeVendorReadiness,
  resolveVendorCredentialEvidence,
  runLaneCommand,
  sandboxedRunnerEnv,
} from "../src/index.js";

const SENTINELS = {
  azure: "audit-azure-value-4f64f426",
  acme: "audit-acme-value-a762b231",
  claude: "audit-claude-value-1bb3a158",
  cursor: "audit-cursor-value-42a76fea",
  operator: "audit-operator-value-0aa9ff49",
  lease: "audit-lease-value-c7c1524d",
} as const;

function expectNoCredentialValue(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of Object.values(SENTINELS)) {
    expect(serialized).not.toContain(sentinel);
  }
}

describe("provider credential non-leak boundary", () => {
  it("keeps values out of evidence/readiness/events/argv while isolating child environments", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "muon-credential-audit-"));
    const previous = new Map<string, string | undefined>();
    const setProcessEnv = (key: string, value: string) => {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    };

    try {
      writeFileSync(
        join(codexHome, "config.toml"),
        [
          'model_provider = "azure"',
          "",
          "[model_providers.azure]",
          'env_key = "AZURE_OPENAI_API_KEY"',
        ].join("\n")
      );
      const parent = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CODEX_HOME: codexHome,
        AZURE_OPENAI_API_KEY: SENTINELS.azure,
        ACME_AUTH_TOKEN: SENTINELS.acme,
        ANTHROPIC_API_KEY: SENTINELS.claude,
        CURSOR_API_KEY: SENTINELS.cursor,
        MUON_OPERATOR_TOKEN: SENTINELS.operator,
        MUON_RUNNER_LEASE_TOKEN: SENTINELS.lease,
      };

      const evidence = resolveVendorCredentialEvidence("codex", {
        env: parent,
      });
      expect(evidence).toMatchObject({
        ready: true,
        method: "custom-provider",
        environmentKeys: ["AZURE_OPENAI_API_KEY"],
      });
      expectNoCredentialValue(evidence);

      const readiness = await probeVendorReadiness("codex", {
        hasCommand: () => true,
        exec: () => ({
          status: 1,
          stdout: "Not logged in",
          stderr: "",
        }),
        resolveCredentials: () => evidence,
      });
      expect(readiness).toMatchObject({
        authenticated: true,
        credentialMethod: "custom-provider",
      });
      expectNoCredentialValue(readiness);

      const runner = sandboxedRunnerEnv({
        apiBase: "http://127.0.0.1:4000",
        agentToken: "agent-token",
        leaseToken: "lease-token",
        sandboxed: true,
        parentEnv: parent,
      });
      expect(runner.AZURE_OPENAI_API_KEY).toBe(SENTINELS.azure);
      expect(runner).not.toHaveProperty("ACME_AUTH_TOKEN");
      expect(runner.ANTHROPIC_API_KEY).toBe(SENTINELS.claude);
      expect(runner.CURSOR_API_KEY).toBe(SENTINELS.cursor);
      expect(runner).not.toHaveProperty("MUON_OPERATOR_TOKEN");
      expect(runner.MUON_RUNNER_LEASE_TOKEN).toBe("lease-token");

      const runnerCodex = buildProviderAwareLaneEnvironment("codex", runner);
      expect(runnerCodex.AZURE_OPENAI_API_KEY).toBe(SENTINELS.azure);
      expect(runnerCodex).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(runnerCodex).not.toHaveProperty("CURSOR_API_KEY");
      expect(runnerCodex).not.toHaveProperty("MUON_OPERATOR_TOKEN");
      expectNoCredentialValue({
        evidence,
        readiness,
        runnerKeys: Object.keys(runner),
        childKeys: Object.keys(runnerCodex),
      });

      const codex = buildProviderAwareLaneEnvironment("codex", parent);
      expect(codex.AZURE_OPENAI_API_KEY).toBe(SENTINELS.azure);
      expect(codex).not.toHaveProperty("ACME_AUTH_TOKEN");
      expect(codex).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(codex).not.toHaveProperty("CURSOR_API_KEY");
      expect(codex).not.toHaveProperty("MUON_OPERATOR_TOKEN");
      expect(codex).not.toHaveProperty("MUON_RUNNER_LEASE_TOKEN");

      const claude = buildProviderAwareLaneEnvironment("claude-code", parent);
      expect(claude.ANTHROPIC_API_KEY).toBe(SENTINELS.claude);
      expect(claude).not.toHaveProperty("AZURE_OPENAI_API_KEY");
      expect(claude).not.toHaveProperty("CURSOR_API_KEY");

      const cursor = buildProviderAwareLaneEnvironment("cursor", parent);
      expect(cursor.CURSOR_API_KEY).toBe(SENTINELS.cursor);
      expect(cursor).not.toHaveProperty("AZURE_OPENAI_API_KEY");
      expect(cursor).not.toHaveProperty("ANTHROPIC_API_KEY");

      writeFileSync(
        join(codexHome, "config.toml"),
        [
          'model_provider = "acme"',
          "",
          "[model_providers.acme]",
          'env_key = "ACME_AUTH_TOKEN"',
        ].join("\n")
      );
      const acme = buildProviderAwareLaneEnvironment("codex", parent);
      expect(acme.ACME_AUTH_TOKEN).toBe(SENTINELS.acme);
      expect(acme).not.toHaveProperty("AZURE_OPENAI_API_KEY");
      const acmeRunner = sandboxedRunnerEnv({
        apiBase: "http://127.0.0.1:4000",
        sandboxed: true,
        parentEnv: parent,
      });
      expect(acmeRunner.ACME_AUTH_TOKEN).toBe(SENTINELS.acme);
      expect(acmeRunner).not.toHaveProperty("AZURE_OPENAI_API_KEY");

      setProcessEnv("CODEX_HOME", codexHome);
      setProcessEnv("ACME_AUTH_TOKEN", SENTINELS.acme);
      setProcessEnv("AZURE_OPENAI_API_KEY", SENTINELS.azure);
      setProcessEnv("ANTHROPIC_API_KEY", SENTINELS.claude);
      setProcessEnv("CURSOR_API_KEY", SENTINELS.cursor);
      setProcessEnv("MUON_OPERATOR_TOKEN", SENTINELS.operator);
      setProcessEnv("MUON_RUNNER_LEASE_TOKEN", SENTINELS.lease);

      const events: LaneEvent[] = [];
      const result = await runLaneCommand({
        laneId: "codex",
        taskId: "credential-audit",
        command: process.execPath,
        args: [
          "-e",
          "process.stderr.write('fixed audit failure'); process.exit(3)",
        ],
        onEvent: (event) => events.push(event),
      });

      expect(result.exitCode).toBe(3);
      expect(result.errorOutput).toBe("fixed audit failure");
      expectNoCredentialValue(result);
      expectNoCredentialValue(events);
      const started = events.find((event) => event.kind === "task.started");
      expect(started?.metadata.args).toEqual([
        "-e",
        "process.stderr.write('fixed audit failure'); process.exit(3)",
      ]);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
