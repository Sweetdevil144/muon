import { describe, expect, it } from "vitest";
import { DELEGATION_MAX_CHILDREN } from "@muon/protocol";
import {
  describeSandboxDegradation,
  CAPABILITY_PREFLIGHT_VERSION,
  PREFLIGHT_LIMITS,
  PREFLIGHT_REASON_CODES,
  VENDOR_EXECUTION_MODES,
  buildCapabilityPreflight,
  collectCapabilityPreflight,
  type CapabilityPreflight,
  type CapabilityPreflightInput,
} from "../src/capability-preflight.js";
import type { FleetReadinessReport, VendorReadiness } from "../src/types.js";

/**
 * P0.5 capability preflight — the ONE client contract every surface (CLI,
 * MCP, desktop) projects from. Fixtures are plain readiness rows; the
 * projection must be honest (degraded/unknown states carry stable reason
 * codes), bounded (fixed provenance labels only, never credential values),
 * and structurally BYOK-safe (a usable API-key/custom-provider account can
 * never read as logged out).
 */

const NOW = new Date("2026-07-16T12:00:00.000Z");

const claudeByok: VendorReadiness = {
  vendor: "claude-code",
  installed: true,
  authenticated: true,
  credentialMethod: "api-key",
  detail: "configured with a Claude Code API key",
  authState: "confirmed",
};

const codexLogin: VendorReadiness = {
  vendor: "codex",
  installed: true,
  authenticated: true,
  credentialMethod: "vendor-login",
  detail: "logged in as dev@example.com",
  authState: "confirmed",
};

const cursorConnected: VendorReadiness = {
  vendor: "cursor",
  installed: true,
  authenticated: true,
  credentialMethod: "vendor-login",
  detail: "logged in as dev@example.com",
  authState: "confirmed",
};

function report(vendors: VendorReadiness[]): FleetReadinessReport {
  return { vendors, generatedAt: "2026-07-16T11:59:58.000Z" };
}

const liveRunner = {
  runner: { status: "online", lastSeenAt: "2026-07-16T11:59:59.000Z" },
  live: true,
};

/**
 * A fleet snapshot with `seats` worker rows for each named vendor. Mirrors
 * `/api/fleet`, which is already worker-only (reserved ordinal 0 excluded).
 */
function fleetOf(
  seatsByVendor: Record<string, number>,
  status: "idle" | "working" = "idle"
): { agents: { id: string; vendor: string; name: string; ordinal: number; status: string }[] } {
  return {
    agents: Object.entries(seatsByVendor).flatMap(([vendor, seats]) =>
      Array.from({ length: seats }, (_unused, index) => ({
        id: `${vendor}-${index + 1}`,
        vendor,
        name: `${vendor}-${index + 1}`,
        ordinal: index + 1,
        status,
      }))
    ),
  };
}

/** The fleet MUON seeds: every dispatchable lane at the full fan-out width. */
const seededFleet = fleetOf({
  "claude-code": 3,
  codex: 3,
  cursor: 3,
  opencode: 3,
});

function healthyInput(): CapabilityPreflightInput {
  return {
    brain: { reachable: true },
    readiness: report([claudeByok, codexLogin, cursorConnected]),
    runner: liveRunner,
    fleet: seededFleet,
    now: NOW,
  };
}

/** Collected outputs so the closed-enum sweep covers every fixture built. */
const built: CapabilityPreflight[] = [];

function build(input: CapabilityPreflightInput): CapabilityPreflight {
  const preflight = buildCapabilityPreflight(input);
  built.push(preflight);
  return preflight;
}

describe("buildCapabilityPreflight", () => {
  it("all-healthy fleet is ready with cursor scoped to the roles it can hold", () => {
    const preflight = build(healthyInput());

    expect(preflight.version).toBe(CAPABILITY_PREFLIGHT_VERSION);
    expect(preflight.status).toBe("ready");
    expect(preflight.headline).toBe("Ready · 2 crew members ready");
    expect(preflight.brainHealth.state).toBe("ok");
    expect(preflight.runnerHealth.state).toBe("live");
    expect(preflight.readiness.source).toBe("backend");
    expect(preflight.readiness.anyDispatchReady).toBe(true);
    expect(preflight.readiness.readyVendors).toEqual(["claude-code", "codex"]);
    expect(preflight.readiness.generatedAt).toBe("2026-07-16T11:59:58.000Z");

    // Only the informational role-scope boundary, no warnings.
    expect(preflight.degradations.map((d) => d.code)).toEqual([
      "VENDOR_ROLE_SCOPED",
    ]);
    expect(preflight.degradations[0]?.severity).toBe("info");

    // Asked without a role, the question is "can it take un-planned work?" —
    // cursor cannot, and says which roles it CAN hold.
    const cursor = preflight.vendors.find((v) => v.vendor === "cursor");
    expect(cursor?.dispatchReady).toBe(false);
    expect(cursor?.boundary).toBe("role-scoped");
    expect(cursor?.dispatchRoles).toEqual([
      "reviewer",
      "qa",
      "architect",
      "scout",
    ]);
    expect(cursor?.executionModes).toEqual(["one-shot", "background"]);

    const claude = preflight.vendors.find((v) => v.vendor === "claude-code");
    expect(claude?.dispatchReady).toBe(true);
    expect(claude?.boundary).toBe("dispatch-ready");
    expect(claude?.executionModes).toEqual([
      "one-shot",
      "interactive",
      "background",
    ]);
    // F1: capacity is MEASURED. Three seats exist, three are idle, and the
    // ceiling is published as a ceiling rather than as capacity.
    expect(claude?.activeLimits).toEqual({
      seatedAgents: 3,
      idleAgents: 3,
      maxConfigurableAgents: PREFLIGHT_LIMITS.maxAgentsPerVendor,
    });
  });

  it.each(["api-key", "custom-provider", "local-provider"] as const)(
    "BYOK invariant: a usable %s account never reads as logged out",
    (method) => {
      const row: VendorReadiness = {
        vendor: "codex",
        installed: true,
        authenticated: true,
        credentialMethod: method,
        detail: "configured through the selected provider",
        authState: "confirmed",
      };
      const preflight = build({
        brain: { reachable: true },
        readiness: report([row]),
        runner: liveRunner,
        now: NOW,
      });

      const vendor = preflight.vendors[0];
      expect(vendor?.auth).toBe("authenticated");
      expect(vendor?.authMethod).toBe(method);
      expect(
        preflight.degradations.filter((d) => d.surface === "vendor")
      ).toEqual([]);
    }
  );

  it("probe-degraded auth reads as unknown with VENDOR_AUTH_UNKNOWN, never signed-out language", () => {
    const row: VendorReadiness = {
      vendor: "codex",
      installed: true,
      authenticated: false,
      detail: "auth probe could not run (probe timed out after 6000ms)",
      fixHint: "log into Codex first: `codex login`",
      authState: "unknown",
    };
    const preflight = build({
      brain: { reachable: true },
      readiness: report([row]),
      runner: liveRunner,
      now: NOW,
    });

    const vendor = preflight.vendors[0];
    expect(vendor?.auth).toBe("unknown");
    expect(vendor?.authMethod).toBe("unknown");
    expect(vendor?.boundary).toBe("unknown");

    const degradation = preflight.degradations.find(
      (d) => d.code === "VENDOR_AUTH_UNKNOWN"
    );
    expect(degradation).toBeDefined();
    expect(degradation?.vendor).toBe("codex");
    expect(degradation?.nextAction).not.toMatch(/sign[ -]?in|log[ -]?in/i);
  });

  it("old-backend row without authState falls back to the boolean (VENDOR_SETUP_NEEDED)", () => {
    const row: VendorReadiness = {
      vendor: "codex",
      installed: true,
      authenticated: false,
      detail: "not logged in",
      fixHint: "log into Codex first: `codex login`",
    };
    const preflight = build({
      brain: { reachable: true },
      readiness: report([row]),
      runner: liveRunner,
      now: NOW,
    });

    expect(preflight.vendors[0]?.auth).toBe("unauthenticated");
    expect(preflight.vendors[0]?.boundary).toBe("setup-required");
    const codes = preflight.degradations.map((d) => d.code);
    expect(codes).toContain("VENDOR_SETUP_NEEDED");
    expect(codes).not.toContain("VENDOR_AUTH_UNKNOWN");
  });

  it("codex provider-unconfigured carries VENDOR_PROVIDER_UNCONFIGURED with the probe fixHint", () => {
    const row: VendorReadiness = {
      vendor: "codex",
      installed: true,
      authenticated: false,
      detail: "the active Codex provider credential is not configured",
      fixHint:
        "configure the active Codex provider credential in MUON's environment, then refresh readiness",
      authState: "provider-unconfigured",
    };
    const preflight = build({
      brain: { reachable: true },
      readiness: report([row]),
      runner: liveRunner,
      now: NOW,
    });

    const degradation = preflight.degradations.find(
      (d) => d.code === "VENDOR_PROVIDER_UNCONFIGURED"
    );
    expect(degradation).toBeDefined();
    expect(degradation?.nextAction).toContain(
      "configure the active Codex provider credential"
    );
  });

  it("readiness unavailable stays honest: unavailable source, empty vendors, never dispatch-ready", () => {
    const preflight = build({
      brain: { reachable: true },
      readiness: null,
      runner: liveRunner,
      now: NOW,
    });

    expect(preflight.readiness.source).toBe("unavailable");
    expect(preflight.vendors).toEqual([]);
    expect(preflight.readiness.anyDispatchReady).toBe(false);
    expect(preflight.degradations.map((d) => d.code)).toContain(
      "READINESS_UNAVAILABLE"
    );
    expect(preflight.status).toBe("degraded");
  });

  describe("runner health matrix", () => {
    const readiness = report([claudeByok]);

    it("null runner input → unknown + RUNNER_UNKNOWN", () => {
      const preflight = build({
        brain: { reachable: true },
        readiness,
        runner: null,
        now: NOW,
      });
      expect(preflight.runnerHealth.state).toBe("unknown");
      expect(preflight.degradations.map((d) => d.code)).toContain(
        "RUNNER_UNKNOWN"
      );
    });

    it("no runner row → offline + RUNNER_OFFLINE", () => {
      const preflight = build({
        brain: { reachable: true },
        readiness,
        runner: { runner: null, live: false },
        now: NOW,
      });
      expect(preflight.runnerHealth.state).toBe("offline");
      expect(preflight.degradations.map((d) => d.code)).toContain(
        "RUNNER_OFFLINE"
      );
    });

    it("starting row → starting + RUNNER_STARTING", () => {
      const preflight = build({
        brain: { reachable: true },
        readiness,
        runner: {
          runner: { status: "starting", lastSeenAt: "2026-07-16T11:59:00.000Z" },
          live: false,
        },
        now: NOW,
      });
      expect(preflight.runnerHealth.state).toBe("starting");
      expect(preflight.degradations.map((d) => d.code)).toContain(
        "RUNNER_STARTING"
      );
    });

    it("supervisor-live but heartbeat not live → stale + RUNNER_STALE_HEARTBEAT", () => {
      const preflight = build({
        brain: { reachable: true },
        readiness,
        runner: {
          runner: { status: "offline", lastSeenAt: "2026-07-16T11:50:00.000Z" },
          live: false,
        },
        supervisor: { phase: "live", sandboxed: true },
        now: NOW,
      });
      expect(preflight.runnerHealth.state).toBe("stale");
      expect(preflight.runnerHealth.lastSeenAt).toBe(
        "2026-07-16T11:50:00.000Z"
      );
      expect(preflight.degradations.map((d) => d.code)).toContain(
        "RUNNER_STALE_HEARTBEAT"
      );
    });

    it("live without sandbox isolation → SANDBOX_UNAVAILABLE info; status stays ready", () => {
      const preflight = build({
        brain: { reachable: true },
        readiness,
        runner: liveRunner,
        fleet: seededFleet,
        supervisor: { phase: "live", sandboxed: false },
        now: NOW,
      });
      expect(preflight.runnerHealth.state).toBe("live");
      expect(preflight.runnerHealth.sandboxed).toBe(false);
      const sandbox = preflight.degradations.find(
        (d) => d.code === "SANDBOX_UNAVAILABLE"
      );
      expect(sandbox?.severity).toBe("info");
      expect(preflight.status).toBe("ready");
    });
  });

  it("brain unreachable → blocked with exactly CONTROL_PLANE_UNREACHABLE (root-cause suppression)", () => {
    const preflight = build({
      brain: { reachable: false, detail: "fetch failed" },
      readiness: null,
      runner: null,
      now: NOW,
    });

    expect(preflight.status).toBe("blocked");
    expect(preflight.headline).toBe("Control offline");
    expect(preflight.brainHealth.state).toBe("unreachable");
    expect(preflight.runnerHealth.state).toBe("unknown");
    expect(preflight.readiness.source).toBe("unavailable");
    expect(preflight.degradations.map((d) => d.code)).toEqual([
      "CONTROL_PLANE_UNREACHABLE",
    ]);
    expect(preflight.degradations[0]?.severity).toBe("blocking");
  });

  it("cursor-only-authenticated fleet is NOT dispatch-ready for un-planned work (the CLI doctor bug, now impossible)", () => {
    const preflight = build({
      brain: { reachable: true },
      readiness: report([cursorConnected]),
      runner: liveRunner,
      now: NOW,
    });

    expect(preflight.readiness.anyDispatchReady).toBe(false);
    const codes = preflight.degradations.map((d) => d.code);
    expect(codes).toContain("NO_VENDOR_DISPATCH_READY");
    expect(codes).toContain("VENDOR_ROLE_SCOPED");
    expect(preflight.status).toBe("degraded");
  });

  it("cursor IS dispatch-ready when the role being planned is one it holds", () => {
    const preflight = build({
      brain: { reachable: true },
      readiness: report([cursorConnected]),
      runner: liveRunner,
      role: "reviewer",
      now: NOW,
    });

    const cursor = preflight.vendors.find((v) => v.vendor === "cursor");
    expect(cursor?.dispatchReady).toBe(true);
    expect(cursor?.boundary).toBe("dispatch-ready");
    expect(preflight.readiness.anyDispatchReady).toBe(true);
    expect(preflight.degradations.map((d) => d.code)).not.toContain(
      "NO_VENDOR_DISPATCH_READY"
    );
  });

  it("cursor stays refused for a role it does not hold", () => {
    const preflight = build({
      brain: { reachable: true },
      readiness: report([cursorConnected]),
      runner: liveRunner,
      role: "implementer",
      now: NOW,
    });

    const cursor = preflight.vendors.find((v) => v.vendor === "cursor");
    expect(cursor?.dispatchReady).toBe(false);
    expect(cursor?.boundary).toBe("role-scoped");
    expect(preflight.readiness.anyDispatchReady).toBe(false);
  });

  it("every degradation across all fixtures uses a closed reason code with a concrete next action", () => {
    // Extra fixture: not-installed vendors + degraded graph.
    build({
      brain: { reachable: true },
      readiness: report([
        {
          vendor: "claude-code",
          installed: false,
          authenticated: false,
          detail: "Claude Code CLI not found (expected one of: claude)",
          fixHint:
            "install the Claude Code CLI (`npm i -g @anthropic-ai/claude-code`), then run `claude` and sign in",
        },
      ]),
      runner: { runner: null, live: false },
      graph: { degraded: true, reason: "index is stale" },
      now: NOW,
    });

    expect(built.length).toBeGreaterThan(0);
    for (const preflight of built) {
      for (const degradation of preflight.degradations) {
        expect(PREFLIGHT_REASON_CODES).toContain(degradation.code);
        expect(degradation.nextAction.length).toBeGreaterThan(0);
        expect(degradation.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("degradations follow the deterministic surface order brain → runner → fleet → vendor → graph", () => {
    const preflight = build({
      brain: { reachable: true },
      readiness: report([
        {
          vendor: "codex",
          installed: true,
          authenticated: false,
          detail: "not logged in",
          fixHint: "log into Codex first: `codex login`",
          authState: "negative",
        },
      ]),
      runner: { runner: null, live: false },
      graph: { degraded: true },
      now: NOW,
    });

    const surfaces = preflight.degradations.map((d) => d.surface);
    const order = ["brain", "runner", "fleet", "vendor", "graph"];
    const ranks = surfaces.map((s) => order.indexOf(s));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(surfaces).toContain("graph");
  });

  it("never leaks anything token-shaped for a BYOK fleet (house no-secret regex)", () => {
    const preflight = build(healthyInput());
    expect(JSON.stringify(preflight)).not.toMatch(/sk-|secret|bearer/i);
    // "token" is asserted separately: no VALUE-bearing field may carry one.
    expect(JSON.stringify(preflight)).not.toMatch(/\btoken\b/i);
  });

  it("stamps the invariants block and generatedAt from the injected clock", () => {
    const preflight = build(healthyInput());
    expect(preflight.generatedAt).toBe(NOW.toISOString());
    expect(preflight.invariants).toEqual({
      credentialValuesNeverIncluded: true,
      environmentVariableNamesOnly: true,
      byokNeverLoggedOut: true,
      roleScopedLanesNeverOverreported: true,
      degradedStatesCarryReasonCodes: true,
    });
  });
});

describe("collectCapabilityPreflight (fail-safe collector)", () => {
  it("never rejects: a client whose every method rejects resolves to blocked", async () => {
    const preflight = await collectCapabilityPreflight({
      health: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
      },
      getFleetReadinessReport: async () => {
        throw new Error("down");
      },
      getRunner: async () => {
        throw new Error("down");
      },
    });

    expect(preflight.status).toBe("blocked");
    expect(preflight.degradations.map((d) => d.code)).toEqual([
      "CONTROL_PLANE_UNREACHABLE",
    ]);
    expect(preflight.readiness.source).toBe("unavailable");
    expect(preflight.runnerHealth.state).toBe("unknown");
  });

  it("falls back to getVendorReadiness on an older client and still reports backend source", async () => {
    const preflight = await collectCapabilityPreflight({
      health: async () => ({ status: "ok" }),
      getVendorReadiness: async () => [claudeByok],
      getRunner: async () => liveRunner,
    });

    expect(preflight.readiness.source).toBe("backend");
    expect(preflight.readiness.anyDispatchReady).toBe(true);
    expect(preflight.vendors).toHaveLength(1);
  });

  it("passes refresh through to the readiness report method", async () => {
    let observed: { refresh?: boolean } | undefined;
    await collectCapabilityPreflight(
      {
        health: async () => ({ status: "ok" }),
        getFleetReadinessReport: async (opts) => {
          observed = opts;
          return report([claudeByok]);
        },
        getRunner: async () => liveRunner,
      },
      { refresh: true }
    );

    expect(observed).toEqual({ refresh: true });
  });
});

// ── F1: reported capacity must EQUAL real capacity ───────────────────────────
describe("reported parallel capacity == seats that actually exist", () => {
  it("reports the real seat count, not the resize ceiling", () => {
    // The founder's DB: exactly ONE dispatchable claude-code worker seat, while
    // the preflight said `maxAgents: 3`. That number is what the coordinator
    // planned a 3-way parallel crew against.
    const preflight = build({
      brain: { reachable: true },
      readiness: report([claudeByok, codexLogin]),
      runner: liveRunner,
      fleet: fleetOf({ "claude-code": 1, codex: 1 }),
      now: NOW,
    });

    const claude = preflight.vendors.find((v) => v.vendor === "claude-code");
    expect(claude?.activeLimits.seatedAgents).toBe(1);
    expect(claude?.activeLimits.idleAgents).toBe(1);
    // The ceiling is still published — but it can no longer be MISTAKEN for
    // capacity, because it is not the field that answers "how many at once".
    expect(claude?.activeLimits.maxConfigurableAgents).toBe(3);
  });

  it("says out loud that a full-width fan-out on a one-seat lane will queue", () => {
    const preflight = build({
      brain: { reachable: true },
      readiness: report([claudeByok, codexLogin]),
      runner: liveRunner,
      fleet: fleetOf({ "claude-code": 1, codex: 1 }),
      now: NOW,
    });

    const serializing = preflight.degradations.filter(
      (d) => d.code === "VENDOR_FANOUT_SERIALIZES"
    );
    expect(serializing.map((d) => d.vendor)).toEqual(["claude-code", "codex"]);
    for (const entry of serializing) {
      expect(entry.severity).toBe("info");
      expect(entry.reason).toContain("1 worker seat");
      expect(entry.reason).toContain("queues");
      expect(entry.nextAction.length).toBeGreaterThan(0);
    }
  });

  it("a ZERO-seat lane reports a distinct not-dispatchable state, never 'it queues'", () => {
    // An operator sized claude-code to 0. The claim route refuses outright
    // ("Fleet has zero 'claude-code' agents"), so nothing queues — the
    // serialization sentence was printing "at most 0 of its agents run at once;
    // a fan-out wider than that queues instead of running in parallel", which
    // describes behaviour that does not exist, at severity info.
    const preflight = build({
      brain: { reachable: true },
      readiness: report([claudeByok, codexLogin]),
      runner: liveRunner,
      fleet: fleetOf({ codex: 3 }),
      now: NOW,
    });

    const codes = preflight.degradations.map((d) => d.code);
    expect(codes).not.toContain("VENDOR_FANOUT_SERIALIZES");
    const closed = preflight.degradations.find(
      (d) => d.code === "VENDOR_NO_SEATS"
    );
    expect(closed?.vendor).toBe("claude-code");
    expect(closed?.severity).toBe("warning");
    // It must not repeat the false claim, and it must deny it outright.
    expect(closed?.reason).not.toMatch(/queues instead/i);
    expect(closed?.reason).toContain("not queued");
    expect(closed?.reason).toContain("NO worker seats");
    expect(closed?.nextAction).toContain("muon fleet set --claude-code");
    // The measured capacity itself stays honest (0, not unknown, not the ceiling).
    const claude = preflight.vendors.find((v) => v.vendor === "claude-code");
    expect(claude?.activeLimits.seatedAgents).toBe(0);
    // codex is untouched: a full-width lane reports nothing at all.
    expect(
      preflight.degradations.some((d) => d.vendor === "codex")
    ).toBe(false);
  });

  it("stays silent about serialization once the fleet can honour a full fan-out", () => {
    const preflight = build(healthyInput());
    expect(preflight.degradations.map((d) => d.code)).not.toContain(
      "VENDOR_FANOUT_SERIALIZES"
    );
    const codex = preflight.vendors.find((v) => v.vendor === "codex");
    expect(codex?.activeLimits.seatedAgents).toBe(
      PREFLIGHT_LIMITS.maxParallelChildrenPerDispatch
    );
  });

  it("counts only IDLE seats as immediate capacity", () => {
    const preflight = build({
      brain: { reachable: true },
      readiness: report([claudeByok]),
      runner: liveRunner,
      fleet: {
        agents: [
          ...fleetOf({ "claude-code": 2 }, "working").agents,
          ...fleetOf({ "claude-code": 1 }, "idle").agents.map((agent) => ({
            ...agent,
            id: "claude-code-3",
            name: "claude-code-3",
            ordinal: 3,
          })),
        ],
      },
      now: NOW,
    });

    const claude = preflight.vendors.find((v) => v.vendor === "claude-code");
    expect(claude?.activeLimits.seatedAgents).toBe(3);
    expect(claude?.activeLimits.idleAgents).toBe(1);
  });

  it("an unreadable fleet reports capacity UNKNOWN, never the ceiling", () => {
    const preflight = build({
      brain: { reachable: true },
      readiness: report([claudeByok]),
      runner: liveRunner,
      fleet: null,
      now: NOW,
    });

    const claude = preflight.vendors.find((v) => v.vendor === "claude-code");
    expect(claude?.activeLimits.seatedAgents).toBeNull();
    expect(claude?.activeLimits.idleAgents).toBeNull();
    const unknown = preflight.degradations.find(
      (d) => d.code === "FLEET_CAPACITY_UNKNOWN"
    );
    expect(unknown?.severity).toBe("info");
    // Unknown capacity must not manufacture a serialization claim either.
    expect(preflight.degradations.map((d) => d.code)).not.toContain(
      "VENDOR_FANOUT_SERIALIZES"
    );
  });

  it("the collector reads the fleet from the client and degrades safely when it throws", async () => {
    const withFleet = await collectCapabilityPreflight({
      health: async () => ({ status: "ok" }),
      getVendorReadiness: async () => [claudeByok],
      getRunner: async () => liveRunner,
      getFleet: async () => ({
        counts: { "claude-code": 2 },
        agents: fleetOf({ "claude-code": 2 }).agents,
      }),
    });
    expect(withFleet.vendors[0]?.activeLimits.seatedAgents).toBe(2);

    const fleetDown = await collectCapabilityPreflight({
      health: async () => ({ status: "ok" }),
      getVendorReadiness: async () => [claudeByok],
      getRunner: async () => liveRunner,
      getFleet: async () => {
        throw new Error("down");
      },
    });
    expect(fleetDown.vendors[0]?.activeLimits.seatedAgents).toBeNull();
    expect(fleetDown.degradations.map((d) => d.code)).toContain(
      "FLEET_CAPACITY_UNKNOWN"
    );
  });
});

describe("preflight constants", () => {
  it("the role-scoped lanes advertise their one-shot execution modes", () => {
    expect(VENDOR_EXECUTION_MODES.cursor).toEqual(["one-shot", "background"]);
    expect(VENDOR_EXECUTION_MODES.opencode).toEqual(["one-shot", "background"]);
  });

  it("limits carry the fixed product constants", () => {
    expect(PREFLIGHT_LIMITS.maxAgentsPerVendor).toBe(3);
    // Published so "seats < this" — the difference between a parallel crew and
    // a queued one — is answerable from the preflight alone.
    expect(PREFLIGHT_LIMITS.maxParallelChildrenPerDispatch).toBe(
      DELEGATION_MAX_CHILDREN
    );
    expect(PREFLIGHT_LIMITS.readinessProbeTimeoutMs).toBe(6000);
    expect(PREFLIGHT_LIMITS.readinessCacheTtlMs).toBe(8000);
    expect(PREFLIGHT_LIMITS.runnerLiveWindowMs).toBe(15000);
    expect(PREFLIGHT_LIMITS.dispatchKinds).toEqual([
      "auto",
      "oneshot",
      "session",
      "loop",
    ]);
  });
});

// ── P0.1 checkpoint+resume (Slice B1): provider/version evidence carry ────────
describe("cliVersion carry", () => {
  it("carries the probed cliVersion onto the vendor row verbatim", () => {
    const preflight = build({
      brain: { reachable: true },
      readiness: report([{ ...claudeByok, cliVersion: "2.1.207 (Claude Code)" }]),
      runner: liveRunner,
      now: NOW,
    });
    expect(preflight.vendors[0]!.cliVersion).toBe("2.1.207 (Claude Code)");
  });

  it("never invents a version: unprobed readiness rows carry null", () => {
    const preflight = build(healthyInput());
    for (const vendor of preflight.vendors) {
      expect(vendor.cliVersion).toBeNull();
    }
  });
});

// ── Round-3 #9: the unconfined runner tells the truth about WHY ─────────────
describe("SANDBOX_UNAVAILABLE says something the operator can act on", () => {
  it("never tells a platform with no implementation to restart", () => {
    const described = describeSandboxDegradation("platform-unsupported");
    // The old single sentence. Restarting cannot restore what this platform
    // never had, and it was the ONLY thing MUON said about the control that
    // blinds a dispatched agent to the operator token.
    expect(described.nextAction).not.toMatch(/restart MUON to restore/i);
    expect(described.nextAction).toMatch(/MUON_REQUIRE_SANDBOX=1/);
    expect(described.reason).toMatch(/macOS only/i);
    expect(described.permanent).toBe(true);
  });

  it("keeps the restart advice for the one cause a restart fixes", () => {
    const described = describeSandboxDegradation("disabled-by-env");
    expect(described.nextAction).toMatch(/Unset MUON_SANDBOX and restart/i);
    expect(described.permanent).toBe(false);
  });

  it("falls back to the original wording rather than inventing a cause", () => {
    const described = describeSandboxDegradation(undefined);
    expect(described.reason).toMatch(/local file isolation is limited/);
    expect(described.permanent).toBe(false);
  });

  it("a permanent cause is a WARNING on the report, a reversible one stays info", () => {
    const build = (
      availability: "platform-unsupported" | "disabled-by-env"
    ) =>
      buildCapabilityPreflight({
        brain: { reachable: true },
        readiness: null,
        runner: { live: true, runner: { lastSeenAt: new Date().toISOString() } },
        supervisor: {
          phase: "live",
          sandboxed: false,
          sandboxAvailability: availability,
        },
      } as Parameters<typeof buildCapabilityPreflight>[0]).degradations.find(
        (degradation) => degradation.code === "SANDBOX_UNAVAILABLE"
      );

    expect(build("platform-unsupported")?.severity).toBe("warning");
    expect(build("platform-unsupported")?.nextAction).toMatch(
      /MUON_REQUIRE_SANDBOX=1/
    );
    expect(build("disabled-by-env")?.severity).toBe("info");
  });
});
