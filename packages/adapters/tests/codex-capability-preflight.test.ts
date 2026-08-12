import { describe, expect, it, vi } from "vitest";
import { MUON_CONTEXT_TOOL_NAMES } from "@muon/protocol";
import {
  runCodexCapabilityPreflight,
  type CodexCapabilityMethod,
} from "../src/codex-capability-preflight.js";

type RpcResults = Partial<Record<CodexCapabilityMethod, unknown>>;

const completeMuonTools = () =>
  Object.fromEntries(
    MUON_CONTEXT_TOOL_NAMES.map((name) => [
      name,
      { name, inputSchema: { type: "object" } },
    ])
  );

function defaultResults(): RpcResults {
  return {
    "account/read": {
      account: null,
      requiresOpenaiAuth: true,
    },
    "config/read": {
      config: {
        model_provider: "openai",
        approval_policy: "on-request",
        sandbox_mode: "workspace-write",
        apps: null,
      },
      origins: {},
      layers: null,
    },
    "configRequirements/read": {
      requirements: null,
    },
    "plugin/list": {
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    },
    "mcpServerStatus/list": {
      data: [
        {
          name: "muon",
          serverInfo: null,
          tools: completeMuonTools(),
          resources: [],
          resourceTemplates: [],
          authStatus: "unsupported",
        },
      ],
      nextCursor: null,
    },
  };
}

function makeCall(
  results: RpcResults,
  errors: Partial<Record<CodexCapabilityMethod, Error>> = {}
) {
  return vi.fn(async (method: CodexCapabilityMethod) => {
    const error = errors[method];
    if (error) {
      throw error;
    }
    return results[method];
  });
}

const threadState = {
  thread: { id: "thread-7" },
  model: "codex-test",
  modelProvider: "openai",
  cwd: "/repo",
  approvalPolicy: "on-request",
  sandbox: {
    type: "workspaceWrite",
    writableRoots: ["/repo"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
};

describe("runCodexCapabilityPreflight", () => {
  it("uses the exact child environment for BYOK evidence and attests provider-owned state", async () => {
    const childEnv = {
      CODEX_HOME: "/task/codex-home",
      AZURE_OPENAI_API_KEY: "task-scoped-secret",
    };
    const resolveCredentials = vi.fn(() => ({
      ready: true,
      method: "custom-provider" as const,
      detail: "configured with the active Codex provider",
      environmentKeys: ["AZURE_OPENAI_API_KEY"],
    }));
    const results = defaultResults();
    results["config/read"] = {
      config: {
        model_provider: "azure",
        approval_policy: "on-request",
        sandbox_mode: "workspace-write",
        apps: null,
      },
      origins: {},
      layers: null,
    };

    const evidence = await runCodexCapabilityPreflight({
      call: makeCall(results),
      threadId: "thread-7",
      cwd: "/repo",
      childEnv,
      initializeResult: { userAgent: "codex-cli/0.144.4" },
      threadStartResult: { ...threadState, modelProvider: "azure" },
      resolveCredentials,
    });

    expect(resolveCredentials).toHaveBeenCalledWith(childEnv);
    expect(evidence.account).toEqual({
      state: "provider-owned",
      provider: "custom",
      credential: "custom-provider",
    });
    expect(evidence.vendorVersion).toBe("0.144.4");
    expect(JSON.stringify(evidence)).not.toContain("task-scoped-secret");
  });

  it("blocks before a turn when the active custom provider credential is absent", async () => {
    const results = defaultResults();
    results["config/read"] = {
      config: {
        model_provider: "azure",
        approval_policy: "on-request",
        sandbox_mode: "workspace-write",
        apps: null,
      },
      origins: {},
      layers: null,
    };

    const evidence = await runCodexCapabilityPreflight({
      call: makeCall(results),
      threadId: "thread-7",
      childEnv: { CODEX_HOME: "/task/codex-home" },
      threadStartResult: { ...threadState, modelProvider: "azure" },
      resolveCredentials: () => ({
        ready: false,
        method: "custom-provider",
        detail: "the active Codex provider credential is not configured",
        environmentKeys: ["AZURE_OPENAI_API_KEY"],
      }),
    });

    expect(evidence.decision).toBe("block");
    expect(evidence.blockReason).toBe("provider-credential-missing");
    expect(evidence.account).toEqual({
      state: "provider-owned",
      provider: "custom",
      credential: "none",
    });
    expect(JSON.stringify(evidence)).not.toContain("AZURE_OPENAI_API_KEY");
  });

  it("attests effective thread policy, config-backed apps, and local plugins with bounded counts", async () => {
    const results = defaultResults();
    results["config/read"] = {
      config: {
        model_provider: "openai",
        approval_policy: "untrusted",
        sandbox_mode: "read-only",
        apps: {
          _default: null,
          docs: { enabled: true },
          tickets: { enabled: false },
        },
      },
      origins: {},
      layers: null,
    };
    results["configRequirements/read"] = {
      requirements: {
        allowedApprovalPolicies: ["on-request"],
        allowedSandboxModes: ["workspace-write"],
      },
    };
    results["plugin/list"] = {
      marketplaces: [
        {
          name: "hostile-local-name",
          path: "/private/plugin/path",
          interface: null,
          plugins: [
            {
              id: "one",
              name: "one",
              installed: true,
              enabled: true,
              availability: "AVAILABLE",
            },
            {
              id: "two",
              name: "two",
              installed: true,
              enabled: false,
              availability: "DISABLED_BY_ADMIN",
            },
            {
              id: "three",
              name: "three",
              installed: false,
              enabled: false,
              availability: "AVAILABLE",
            },
          ],
        },
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    };

    const evidence = await runCodexCapabilityPreflight({
      call: makeCall(results),
      threadId: "thread-7",
      cwd: "/repo",
      childEnv: {},
      initializeResult: { userAgent: "codex-cli/0.144.4" },
      threadStartResult: threadState,
      resolveCredentials: () => ({ ready: false, environmentKeys: [] }),
    });

    expect(evidence.policy).toEqual({
      source: "thread",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      unsafeFullAccess: false,
      // This fixture predates the field, so it reports `unknown` rather than
      // being assumed safe.
      multiAgentMode: "unknown",
      requirementsObserved: true,
      requirementsConflict: false,
    });
    expect(evidence.apps).toEqual({
      source: "effective-config",
      configuredCount: 2,
      enabledCount: 1,
    });
    expect(evidence.plugins).toEqual({
      source: "local-only",
      installedCount: 2,
      enabledCount: 1,
      availableCount: 2,
    });
    expect(JSON.stringify(evidence)).not.toContain("hostile-local-name");
    expect(JSON.stringify(evidence)).not.toContain("/private/plugin/path");
  });

  it.each([
    {
      name: "mismatched embedded name",
      tool: {
        name: "memory_recall",
        inputSchema: { type: "object" },
        description: "credential=do-not-copy",
      },
    },
    {
      name: "missing embedded name",
      tool: {
        inputSchema: { type: "object" },
        description: "credential=do-not-copy",
      },
    },
  ])("rejects malformed MCP tool objects: $name", async ({ tool }) => {
    const results = defaultResults();
    results["mcpServerStatus/list"] = {
      data: [
        {
          name: "muon",
          serverInfo: null,
          tools: {
            ...completeMuonTools(),
            memory_search: tool,
          },
          resources: [],
          resourceTemplates: [],
          authStatus: "unsupported",
        },
      ],
      nextCursor: null,
    };

    const evidence = await runCodexCapabilityPreflight({
      call: makeCall(results),
      threadId: "thread-7",
      childEnv: {},
      threadStartResult: threadState,
      resolveCredentials: () => ({ ready: false, environmentKeys: [] }),
    });

    expect(evidence.decision).toBe("block");
    expect(evidence.blockReason).toBe("mcp-inventory-error");
    expect(evidence.mcp).toMatchObject({
      inventory: "error",
      requiredMuon: "unknown",
    });
    expect(JSON.stringify(evidence)).not.toContain("credential=do-not-copy");
  });

  it("blocks a truncated inventory that never verifies MUON tools", async () => {
    const results = defaultResults();
    let page = 0;
    const call = vi.fn(async (method: CodexCapabilityMethod) => {
      if (method !== "mcpServerStatus/list") {
        return results[method];
      }
      page += 1;
      return {
        data: [
          {
            name: `crowded-${page}`,
            serverInfo: null,
            tools: {
              unrelated: {
                name: "unrelated",
                inputSchema: { type: "object" },
              },
            },
            resources: [],
            resourceTemplates: [],
            authStatus: "unsupported",
          },
        ],
        // Always another page — hits MAX_MCP_PAGES without ever seeing muon.
        nextCursor: `page-${page + 1}`,
      };
    });

    const evidence = await runCodexCapabilityPreflight({
      call,
      threadId: "thread-7",
      childEnv: {},
      threadStartResult: threadState,
      resolveCredentials: () => ({ ready: false, environmentKeys: [] }),
    });

    expect(evidence.decision).toBe("block");
    expect(evidence.blockReason).toBe("required-muon-missing");
    expect(evidence.mcp).toMatchObject({
      inventory: "verified",
      requiredMuon: "unknown",
      truncated: true,
    });
  });

  it("blocks a supported inventory missing one canonical MUON tool", async () => {
    const results = defaultResults();
    const tools = completeMuonTools();
    delete tools.handoff_read;
    results["mcpServerStatus/list"] = {
      data: [
        {
          name: "muon",
          serverInfo: null,
          tools,
          resources: [],
          resourceTemplates: [],
          authStatus: "unsupported",
        },
      ],
      nextCursor: null,
    };

    const evidence = await runCodexCapabilityPreflight({
      call: makeCall(results),
      threadId: "thread-7",
      childEnv: {},
      threadStartResult: threadState,
      resolveCredentials: () => ({ ready: false, environmentKeys: [] }),
    });

    expect(evidence.decision).toBe("block");
    expect(evidence.blockReason).toBe("required-muon-missing");
    expect(evidence.mcp.missingTools).toEqual(["handoff_read"]);
  });

  it("degrades when MCP inventory is unsupported but blocks unsafe effective policy", async () => {
    const methodNotFound = Object.assign(new Error("unsupported"), {
      code: -32601,
    });
    const compatible = await runCodexCapabilityPreflight({
      call: makeCall(defaultResults(), {
        "mcpServerStatus/list": methodNotFound,
      }),
      threadId: "thread-7",
      childEnv: {},
      threadStartResult: threadState,
      resolveCredentials: () => ({ ready: false, environmentKeys: [] }),
    });

    expect(compatible).toMatchObject({
      posture: "compatibility-import",
      decision: "proceed",
      mcp: {
        inventory: "unsupported",
        requiredMuon: "unknown",
      },
    });
    expect(compatible.unsupportedMethods).toContain("mcpServerStatus/list");

    const unsafe = await runCodexCapabilityPreflight({
      call: makeCall(defaultResults()),
      threadId: "thread-7",
      childEnv: {},
      threadStartResult: {
        ...threadState,
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      },
      resolveCredentials: () => ({ ready: false, environmentKeys: [] }),
    });

    expect(unsafe.decision).toBe("block");
    expect(unsafe.blockReason).toBe("unsafe-policy");
    expect(unsafe.policy.unsafeFullAccess).toBe(true);
  });
});

/**
 * Codex's native fan-out. `thread/start` volunteers `multiAgentMode` on every
 * thread and MUON was mining only the thread id out of that payload — so the one
 * place the vendor states whether a governed child can spawn subagents MUON
 * cannot see, budget, or collect evidence from was being discarded.
 *
 * The vocabulary is the binary's own: asking 0.145 for an invalid value answers
 * `expected one of 'none', 'custom', 'explicitRequestOnly', 'proactive'`.
 */
describe("runCodexCapabilityPreflight native multi-agent", () => {
  const withMode = (mode: unknown) =>
    runCodexCapabilityPreflight({
      call: makeCall(defaultResults()),
      threadId: "thread-7",
      childEnv: {},
      threadStartResult: { ...threadState, multiAgentMode: mode },
      resolveCredentials: () => ({ ready: false, environmentKeys: [] }),
    });

  it("refuses a thread that may fan out on its own initiative", async () => {
    for (const mode of ["proactive", "custom"]) {
      const evidence = await withMode(mode);
      expect(evidence.policy.multiAgentMode).toBe(mode);
      expect(evidence.decision).toBe("block");
      expect(evidence.blockReason).toBe("native-multi-agent");
    }
  });

  it("records the mode the vendor reported instead of discarding it", async () => {
    // Applies to EVERY governed Codex child. The `features.multi_agent=false`
    // narrowing lived only in the runner's orchestrator profile branch, and the
    // delegate branch resets `rawConfig: {}` — so the workers that actually edit
    // files were the ones running unbounded.
    expect((await withMode("none")).policy.multiAgentMode).toBe("none");
    expect((await withMode("explicitRequestOnly")).policy.multiAgentMode).toBe(
      "explicitRequestOnly"
    );
  });

  it("proceeds on the modes MUON has no vendor lever to close, rather than refusing every run", async () => {
    // Measured on codex 0.145: `explicitRequestOnly` is what EVERY thread
    // reports — identical with and without CODEX_AMBIENT_SUPPRESSION_ARGS, and
    // unchanged when the client declares `experimentalApi` and asks for `none`.
    // Blocking it would refuse every interactive Codex run, which is an outage
    // and not a boundary; it is surfaced on the preflight so the residual
    // exposure is named rather than silently dropped.
    const evidence = await withMode("explicitRequestOnly");
    expect(evidence.decision).toBe("proceed");
    expect(evidence.policy.multiAgentMode).toBe("explicitRequestOnly");
  });

  it("reports an unrecognized mode as unknown rather than assuming it is safe", async () => {
    expect((await withMode("someFutureMode")).policy.multiAgentMode).toBe(
      "unknown"
    );
    expect((await withMode(undefined)).policy.multiAgentMode).toBe("unknown");
  });
});
