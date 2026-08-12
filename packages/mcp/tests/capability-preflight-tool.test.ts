import { describe, expect, it, vi } from "vitest";
import type { FleetReadinessReport, MuonApiClient } from "@muon/client";
import {
  PREFLIGHT_LIMITS,
  VENDOR_DISPATCH_ROLES,
  VENDOR_EXECUTION_MODES,
} from "@muon/client";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_READINESS_TTL_MS,
  FAKE_VENDOR_KEY,
  VENDOR_CAPABILITY_DESCRIPTORS,
  createDefaultAdapters,
} from "@muon/adapters";
import { createToolDefinitions } from "../src/handlers.js";

const NOW = "2026-07-16T00:00:00.000Z";

/** BYOK codex + connected cursor: the fleet a real desktop reports. */
const readinessReport: FleetReadinessReport = {
  vendors: [
    {
      vendor: "codex",
      installed: true,
      authenticated: true,
      credentialMethod: "custom-provider",
      detail: "codex CLI configured through its active provider",
      authState: "confirmed",
    },
    {
      vendor: "cursor",
      installed: true,
      authenticated: true,
      detail: "cursor-agent connected",
      authState: "confirmed",
    },
  ],
  anyReady: true,
  generatedAt: NOW,
};

type StubOverrides = {
  health?: () => Promise<{ status: string }>;
  getFleetReadinessReport?: (opts?: {
    refresh?: boolean;
  }) => Promise<FleetReadinessReport>;
  getRunner?: () => Promise<{
    runner: { status: string; lastSeenAt: string } | null;
    live: boolean;
  }>;
};

function stubClient(overrides: StubOverrides = {}): MuonApiClient {
  return {
    health: overrides.health ?? (async () => ({ status: "ok" })),
    getFleetReadinessReport:
      overrides.getFleetReadinessReport ?? (async () => readinessReport),
    getRunner:
      overrides.getRunner ??
      (async () => ({
        runner: { status: "online", lastSeenAt: NOW },
        live: true,
      })),
  } as unknown as MuonApiClient;
}

function preflightTool(client: MuonApiClient) {
  const tool = createToolDefinitions(client, {}).find(
    (entry) => entry.name === "capability_preflight"
  );
  if (!tool) throw new Error("capability_preflight tool not registered");
  return tool;
}

describe("capability_preflight MCP tool", () => {
  it("returns the versioned contract with cursor role-scoped and a bounded envelope", async () => {
    const tool = preflightTool(stubClient());
    const result = await tool.handler({});

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, any>;
    const preflight = structured.preflight;
    expect(preflight.version).toBe(1);
    expect(preflight.status).toBe("ready");
    expect(preflight.readiness.anyDispatchReady).toBe(true);

    // Connected, and dispatchable only for the roles it declares — asked
    // without a role the answer is "not for un-planned work".
    const cursor = preflight.vendors.find(
      (row: any) => row.vendor === "cursor"
    );
    expect(cursor.dispatchReady).toBe(false);
    expect(cursor.boundary).toBe("role-scoped");
    expect(cursor.dispatchRoles).toEqual([
      "reviewer",
      "qa",
      "architect",
      "scout",
    ]);
    expect(cursor.executionModes).toEqual(["one-shot", "background"]);

    const codex = preflight.vendors.find((row: any) => row.vendor === "codex");
    expect(codex.auth).toBe("authenticated");
    expect(codex.authMethod).toBe("custom-provider");

    const envelope = structured._muon as Record<string, any>;
    expect(envelope.degradation).toEqual({ active: false });
    expect(envelope.evidence).toMatchObject({
      bounded: true,
      limit: 4,
      included: 2,
      omitted: 0,
      kind: "vendor capability observations",
    });

    // House no-secret rule: never a credential value or token shape.
    expect(JSON.stringify(structured)).not.toMatch(
      /api[-_ ]?key.{0,20}(sk-|secret|token)/i
    );
    expect(JSON.stringify(structured)).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("degrades honestly (never errors) when readiness is unreadable", async () => {
    const tool = preflightTool(
      stubClient({
        getFleetReadinessReport: async () => {
          throw new Error("readiness route exploded");
        },
      })
    );
    const result = await tool.handler({});

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.preflight.readiness.source).toBe("unavailable");
    expect(structured.preflight.readiness.anyDispatchReady).toBe(false);
    const envelope = structured._muon as Record<string, any>;
    expect(envelope.degradation.active).toBe(true);
    expect(envelope.degradation.reason).toMatch(/READINESS_UNAVAILABLE/);
    expect(envelope.degradation.action.length).toBeGreaterThan(0);
  });

  it("forwards refresh:true to the readiness read", async () => {
    const getFleetReadinessReport = vi.fn(async () => readinessReport);
    const tool = preflightTool(stubClient({ getFleetReadinessReport }));

    await tool.handler({ refresh: true });

    expect(getFleetReadinessReport).toHaveBeenCalledWith({ refresh: true });
  });

  it("drift-locks the per-vendor dispatch roles against the adapters' declarations", () => {
    // The client mirror is what every surface routes on; the adapter is the
    // ground truth. They must agree exactly, or a lane is offered work its
    // adapter refuses (or denied work it can do).
    //
    // This used to skip any adapter without `supportedRoles` — the exact hole
    // the drift lock exists to catch. An adapter that omits the field is
    // precisely the one admitted to every role today, so skipping it let the
    // fail-open pass this assertion silently. The only exemption now is the
    // dev/test fake, which is named rather than inferred from a missing field.
    for (const adapter of createDefaultAdapters()) {
      if (adapter.id === FAKE_VENDOR_KEY) continue;
      expect(
        VENDOR_DISPATCH_ROLES[adapter.id],
        `${adapter.id} has a client-side role mirror`
      ).toBeDefined();
      expect(
        adapter.supportedRoles,
        `${adapter.id} declares a role ceiling`
      ).toBeDefined();
      expect(new Set(VENDOR_DISPATCH_ROLES[adapter.id])).toEqual(
        new Set(adapter.supportedRoles)
      );
    }
  });

  it("drift-locks execution modes and limits against the adapters ground truth", () => {
    for (const vendor of ["claude-code", "codex"] as const) {
      const descriptor = VENDOR_CAPABILITY_DESCRIPTORS[vendor];
      const expected = new Set<string>(
        descriptor.actions.flatMap((action) => action.modes)
      );
      if (descriptor.laneCapabilities.canBackground) {
        expected.add("background");
      }
      expect(new Set(VENDOR_EXECUTION_MODES[vendor])).toEqual(expected);
    }
    // The role-scoped lanes are one-shot only: MUON runs one child process per
    // dispatch and neither has a session driver to steer.
    expect(VENDOR_EXECUTION_MODES.cursor).toEqual(["one-shot", "background"]);
    expect(VENDOR_EXECUTION_MODES.opencode).toEqual(["one-shot", "background"]);

    expect(PREFLIGHT_LIMITS.readinessProbeTimeoutMs).toBe(
      DEFAULT_PROBE_TIMEOUT_MS
    );
    expect(PREFLIGHT_LIMITS.readinessCacheTtlMs).toBe(
      DEFAULT_READINESS_TTL_MS
    );
  });
});
