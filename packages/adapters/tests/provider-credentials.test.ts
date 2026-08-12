import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveVendorCredentialEvidence } from "../src/provider-credentials.js";

const AZURE_CONFIG = `
model_provider = "azure"

[model_providers.azure]
name = "Azure"
base_url = "https://example.openai.azure.com/openai"
env_key = "AZURE_OPENAI_API_KEY"
`;

function configReader(
  expectedPath: string,
  content: string | undefined
): (path: string) => string | undefined {
  return (path) => (path === expectedPath ? content : undefined);
}

describe("resolveVendorCredentialEvidence", () => {
  it("recognizes the active Codex Azure env_key without exposing its value", () => {
    const secret = "azure-secret-value";
    const result = resolveVendorCredentialEvidence("codex", {
      env: {
        CODEX_HOME: "/trusted/codex",
        AZURE_OPENAI_API_KEY: secret,
      },
      readConfig: configReader(
        "/trusted/codex/config.toml",
        AZURE_CONFIG
      ),
    });

    expect(result).toEqual({
      ready: true,
      method: "custom-provider",
      detail: "configured with the active Codex provider",
      environmentKeys: ["AZURE_OPENAI_API_KEY"],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("supports an arbitrary safe credential-shaped Codex env_key", () => {
    const config = `
model_provider = "acme"
[model_providers."acme"]
env_key = "ACME_AUTH_TOKEN"
`;
    expect(
      resolveVendorCredentialEvidence("codex", {
        env: {
          CODEX_HOME: "/trusted/codex",
          ACME_AUTH_TOKEN: "acme-secret",
        },
        readConfig: configReader("/trusted/codex/config.toml", config),
      })
    ).toEqual({
      ready: true,
      method: "custom-provider",
      detail: "configured with the active Codex provider",
      environmentKeys: ["ACME_AUTH_TOKEN"],
    });
  });

  it("reports a missing active-provider credential without inventing readiness", () => {
    const result = resolveVendorCredentialEvidence("codex", {
      env: { CODEX_HOME: "/trusted/codex" },
      readConfig: configReader(
        "/trusted/codex/config.toml",
        AZURE_CONFIG
      ),
    });

    expect(result).toEqual({
      ready: false,
      method: "custom-provider",
      detail: "the active Codex provider credential is not configured",
      environmentKeys: ["AZURE_OPENAI_API_KEY"],
    });
  });

  it("uses OPENAI_API_KEY only when Codex has no config file", () => {
    expect(
      resolveVendorCredentialEvidence("codex", {
        env: { OPENAI_API_KEY: "openai-secret" },
        homeDir: "/users/dev",
        readConfig: () => undefined,
      })
    ).toEqual({
      ready: true,
      method: "api-key",
      detail: "configured with a Codex API key",
      environmentKeys: ["OPENAI_API_KEY"],
    });
  });

  it("uses OPENAI_API_KEY for the explicit built-in openai provider", () => {
    expect(
      resolveVendorCredentialEvidence("codex", {
        env: {
          CODEX_HOME: "/trusted/codex",
          OPENAI_API_KEY: "openai-secret",
        },
        readConfig: configReader(
          "/trusted/codex/config.toml",
          'model_provider = "openai"\n'
        ),
      })
    ).toMatchObject({
      ready: true,
      method: "api-key",
      environmentKeys: ["OPENAI_API_KEY"],
    });
  });

  it.each([
    {
      name: "unquoted active provider",
      config: "model_provider = azure\n",
    },
    {
      name: "duplicate active provider",
      config:
        'model_provider = "azure"\nmodel_provider = "openai"\n',
    },
    {
      name: "missing selected provider table",
      config: 'model_provider = "azure"\n',
    },
    {
      name: "duplicate selected env_key",
      config:
        'model_provider = "azure"\n[model_providers.azure]\nenv_key = "AZURE_OPENAI_API_KEY"\nenv_key = "OTHER_API_KEY"\n',
    },
  ])("degrades ambiguous Codex config: $name", ({ config }) => {
    expect(
      resolveVendorCredentialEvidence("codex", {
        env: {
          CODEX_HOME: "/trusted/codex",
          OPENAI_API_KEY: "must-not-fallback",
          AZURE_OPENAI_API_KEY: "must-not-leak",
          OTHER_API_KEY: "must-not-leak",
        },
        readConfig: configReader("/trusted/codex/config.toml", config),
      })
    ).toEqual({ ready: false, environmentKeys: [] });
  });

  it("reads only the trusted user-level Codex config path", () => {
    const readConfig = vi.fn(() => undefined);
    resolveVendorCredentialEvidence("codex", {
      env: {},
      homeDir: "/users/dev",
      readConfig,
    });

    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(readConfig).toHaveBeenCalledWith(
      join("/users/dev", ".codex", "config.toml")
    );
    expect(
      readConfig.mock.calls.some(([path]) =>
        String(path).includes("/workspace/.codex")
      )
    ).toBe(false);
  });

  it("ignores a relative CODEX_HOME instead of resolving it through cwd", () => {
    const readConfig = vi.fn(() => undefined);
    resolveVendorCredentialEvidence("codex", {
      env: { CODEX_HOME: ".codex" },
      homeDir: "/users/dev",
      readConfig,
    });

    expect(readConfig).toHaveBeenCalledWith(
      join("/users/dev", ".codex", "config.toml")
    );
  });

  it.each([
    "MUON_OPERATOR_TOKEN",
    "MUON_GITHUB_TOKEN",
    "MUON_GITHUB_REFRESH_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "MUON_RUNNER_LEASE_TOKEN",
    "MUON_ANY_FUTURE_CONTROL_TOKEN",
    "NODE_OPTIONS",
    "BASH_ENV",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "ANTHROPIC_API_KEY",
    "CURSOR_API_KEY",
  ])("rejects unsafe or foreign Codex env_key %s", (key) => {
    const config = `
model_provider = "unsafe"
[model_providers.unsafe]
env_key = "${key}"
`;
    expect(
      resolveVendorCredentialEvidence("codex", {
        env: {
          CODEX_HOME: "/trusted/codex",
          [key]: "must-not-forward",
        },
        readConfig: configReader("/trusted/codex/config.toml", config),
      })
    ).toEqual({ ready: false, environmentKeys: [] });
  });

  it("recognizes direct Claude and Cursor API keys independently", () => {
    const env = {
      ANTHROPIC_API_KEY: "anthropic-secret",
      CURSOR_API_KEY: "cursor-secret",
    };

    expect(resolveVendorCredentialEvidence("claude-code", { env })).toEqual({
      ready: true,
      method: "api-key",
      detail: "configured with a Claude Code API key",
      environmentKeys: ["ANTHROPIC_API_KEY"],
    });
    expect(resolveVendorCredentialEvidence("cursor", { env })).toEqual({
      ready: true,
      method: "api-key",
      detail: "configured with a Cursor API key",
      environmentKeys: ["CURSOR_API_KEY"],
    });
  });

  it("returns no evidence for empty direct credentials or an unknown vendor", () => {
    expect(
      resolveVendorCredentialEvidence("claude-code", {
        env: { ANTHROPIC_API_KEY: "" },
      })
    ).toEqual({ ready: false, environmentKeys: [] });
    expect(
      resolveVendorCredentialEvidence("unknown", {
        env: { OPENAI_API_KEY: "secret" },
      })
    ).toEqual({ ready: false, environmentKeys: [] });
  });

  it("never serializes any credential value", () => {
    const secrets = [
      "anthropic-value",
      "cursor-value",
      "openai-value",
      "azure-value",
    ];
    const evidence = [
      resolveVendorCredentialEvidence("claude-code", {
        env: { ANTHROPIC_API_KEY: secrets[0] },
      }),
      resolveVendorCredentialEvidence("cursor", {
        env: { CURSOR_API_KEY: secrets[1] },
      }),
      resolveVendorCredentialEvidence("codex", {
        env: { OPENAI_API_KEY: secrets[2] },
        readConfig: () => undefined,
      }),
      resolveVendorCredentialEvidence("codex", {
        env: {
          CODEX_HOME: "/trusted/codex",
          AZURE_OPENAI_API_KEY: secrets[3],
        },
        readConfig: configReader(
          "/trusted/codex/config.toml",
          AZURE_CONFIG
        ),
      }),
    ];

    const serialized = JSON.stringify(evidence);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
  });
});
