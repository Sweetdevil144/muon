import { describe, expect, it } from "vitest";
import type { VendorReadiness } from "@muon/client";
import { fleetVendorIds } from "@muon/client/vendors";
import {
  buildLaneStatus,
  buildLaneStatuses,
  freshnessLabel,
  summarizeLanes,
} from "../src/renderer/lib/lane-status.js";
import type { ReadinessSnapshotMeta } from "../src/shared/ipc.js";

/**
 * The three situations a human must act on DIFFERENTLY, and the trap that makes
 * getting them right non-obvious:
 *
 *   `cursor-agent status` EXITS 0 WHETHER OR NOT ANYONE IS LOGGED IN, and so
 *   does `opencode auth list`.
 *
 * So "ready" can never come from an exit code. The probe layer already refuses
 * to infer it (it requires an explicit "logged in" phrase, or a credential
 * count), and these tests pin that this UI projection reads only the
 * interpreted verdict and keeps the three outcomes apart.
 */

function readiness(over: Partial<VendorReadiness>): VendorReadiness {
  return {
    vendor: "cursor",
    installed: true,
    authenticated: false,
    detail: "",
    ...over,
  } as VendorReadiness;
}

const meta = (state: ReadinessSnapshotMeta["state"]): ReadinessSnapshotMeta => ({
  state,
  checkedAt: null,
  ageMs: null,
  error: null,
});

describe("lane status — not installed / signed out / ready are distinct", () => {
  it("NOT INSTALLED: names the install step, never a login one", () => {
    const lane = buildLaneStatus({
      vendor: "cursor",
      readiness: readiness({
        installed: false,
        detail: "Cursor CLI not found (expected one of: agent, cursor-agent)",
        fixHint: "install the Cursor agent CLI (`curl https://cursor.com/install -fsS | bash`)",
      }),
    });

    expect(lane.state).toBe("missing");
    expect(lane.chip).toBe("not installed");
    expect(lane.needsAttention).toBe(true);
    expect(lane.action).toContain("install");
    expect(lane.action).not.toMatch(/\blogin\b/i);
  });

  it("SIGNED OUT: a zero exit code does not make a logged-out lane ready", () => {
    // The exact shape the probe produces for `cursor-agent status` exiting 0
    // while signed out. If this UI ever inferred readiness from a status code,
    // this is the case that would silently claim "ready".
    const lane = buildLaneStatus({
      vendor: "cursor",
      readiness: readiness({
        installed: true,
        authenticated: false,
        authState: "negative",
        detail: "not logged in",
        fixHint: "log into Cursor first: `cursor-agent login`",
      }),
    });

    expect(lane.state).toBe("signed-out");
    expect(lane.chip).toBe("signed out");
    expect(lane.chip).not.toContain("ready");
    expect(lane.needsAttention).toBe(true);
    // The exact command, straight from the probe.
    expect(lane.action).toBe("log into Cursor first: `cursor-agent login`");
  });

  it("READY: only a confirmed verdict, and role scope is carried on the chip", () => {
    const lane = buildLaneStatus({
      vendor: "cursor",
      readiness: readiness({
        installed: true,
        authenticated: true,
        authState: "confirmed",
        credentialMethod: "vendor-login",
        detail: "logged in as dev@example.com",
      }),
    });

    expect(lane.state).toBe("ready");
    expect(lane.needsAttention).toBe(false);
    expect(lane.action).toBeNull();
    // Cursor is managed for read-only roles only — "ready" alone would overstate it.
    expect(lane.chip).toBe("ready · role-scoped");
    expect(lane.roleScope.scoped).toBe(true);
  });

  it("UNKNOWN probe is its own state — never folded into 'signed out'", () => {
    // The bug this closes: the Crew sidebar rendered "setup needed" for a probe
    // that could not RUN, telling the user to log in when the truth was that
    // MUON had no idea. The Doctor strip, reading the same field, said
    // "unknown". Both now come from here.
    const lane = buildLaneStatus({
      vendor: "codex",
      readiness: readiness({
        vendor: "codex",
        installed: true,
        authenticated: false,
        authState: "unknown",
        detail: "auth probe could not run (spawn timeout)",
      }),
    });

    expect(lane.state).toBe("unknown");
    expect(lane.chip).toBe("check failed");
    expect(lane.chip).not.toContain("signed out");
    // The one lane state loud enough to be red: MUON does not know, and silence
    // here is what lets a dispatch die deep in the runner.
    expect(lane.tone).toBe("danger");
    expect(lane.action).toMatch(/re-check/i);
  });

  it("BYOK reads differently from a vendor login", () => {
    const lane = buildLaneStatus({
      vendor: "codex",
      readiness: readiness({
        vendor: "codex",
        installed: true,
        authenticated: true,
        credentialMethod: "custom-provider",
        detail: "using AZURE_OPENAI_API_KEY",
      }),
    });
    expect(lane.state).toBe("ready-byok");
    expect(lane.chip).toBe("ready · BYOK");
    expect(lane.needsAttention).toBe(false);
  });

  it("PROVIDER UNCONFIGURED is distinct from signed out", () => {
    const lane = buildLaneStatus({
      vendor: "codex",
      readiness: readiness({
        vendor: "codex",
        installed: true,
        authenticated: false,
        authState: "provider-unconfigured",
        detail: "Missing environment variable: AZURE_OPENAI_API_KEY.",
      }),
    });
    expect(lane.state).toBe("provider-unconfigured");
    expect(lane.chip).toBe("provider not configured");
  });
});

describe("lane status — absent evidence is never a verdict", () => {
  it("says CHECKING while the first probe runs, and claims nothing", () => {
    const lane = buildLaneStatus({ vendor: "codex", meta: meta("probing") });
    expect(lane.state).toBe("checking");
    expect(lane.known).toBe(false);
    // Not "needs attention" — that would accuse the user of a problem that may
    // not exist. Not "ready" either.
    expect(lane.needsAttention).toBe(false);
    expect(lane.action).toBeNull();
    expect(lane.detail).toMatch(/checking/i);
  });

  it("says NOT CHECKED when no probe is running", () => {
    const lane = buildLaneStatus({ vendor: "codex", meta: meta("unknown") });
    expect(lane.state).toBe("unchecked");
    expect(lane.known).toBe(false);
    expect(lane.chip).toBe("not checked");
  });
});

describe("lane status — the roster comes from the registry", () => {
  it("renders exactly the registry's fleet lanes, and no retired one", () => {
    const lanes = buildLaneStatuses({
      vendors: fleetVendorIds(),
      readiness: null,
      meta: meta("probing"),
    });

    const vendors = lanes.map((lane) => lane.vendor);
    expect(vendors).toContain("claude-code");
    expect(vendors).toContain("codex");
    expect(vendors).toContain("cursor");
    expect(vendors).toContain("opencode");
    // Ollama was removed as a lane. Building the roster from the registry
    // rather than from a probe payload is what makes that unrepeatable.
    expect(vendors).not.toContain("ollama");
  });

  it("ignores a retired vendor even if a stale payload still carries one", () => {
    const lanes = buildLaneStatuses({
      vendors: fleetVendorIds(),
      readiness: [
        readiness({ vendor: "ollama", installed: true, authenticated: true }),
      ],
    });
    expect(lanes.map((lane) => lane.vendor)).not.toContain("ollama");
  });

  it("marks only claude-code and codex as coordinator-eligible", () => {
    const lanes = buildLaneStatuses({
      vendors: fleetVendorIds(),
      readiness: null,
    });
    const eligible = lanes
      .filter((lane) => lane.coordinatorEligible)
      .map((lane) => lane.vendor)
      .sort();
    expect(eligible).toEqual(["claude-code", "codex"]);
  });

  it("keeps OpenCode's ceiling at scout alone", () => {
    const lane = buildLaneStatus({ vendor: "opencode" });
    expect(lane.roleScope.roles).toEqual(["scout"]);
    expect(lane.roleScope.takesUnplannedWork).toBe(false);
  });
});

describe("lane summary", () => {
  const lanes = () =>
    buildLaneStatuses({
      vendors: ["claude-code", "cursor", "opencode"],
      readiness: [
        readiness({
          vendor: "claude-code",
          authenticated: true,
          detail: "logged in",
        }),
        readiness({ vendor: "cursor", authState: "negative", detail: "not logged in" }),
        readiness({
          vendor: "opencode",
          authenticated: true,
          detail: "logged in (2 stored credentials)",
        }),
      ],
      counts: { "claude-code": 2, cursor: 1 },
      agents: [
        {
          id: "claude-code-1",
          vendor: "claude-code",
          ordinal: 1,
          name: "Claude Code 1",
          status: "working",
        },
        {
          id: "claude-code-2",
          vendor: "claude-code",
          ordinal: 2,
          name: "Claude Code 2",
          status: "idle",
        },
      ] as never,
    });

  it("counts ready lanes, lanes needing setup, seats and live work", () => {
    const totals = summarizeLanes(lanes());
    expect(totals.ready).toBe(2);
    expect(totals.needsAttention).toBe(1);
    expect(totals.seats).toBe(3);
    expect(totals.working).toBe(1);
  });

  it("is role-aware about dispatch, exactly like the backend's anyVendorReady", () => {
    // A ready OpenCode holds `scout` only, so on its own it cannot make the app
    // dispatch-capable — the same rule the brain enforces.
    const opencodeOnly = buildLaneStatuses({
      vendors: ["opencode"],
      readiness: [
        readiness({ vendor: "opencode", authenticated: true, detail: "logged in" }),
      ],
    });
    expect(summarizeLanes(opencodeOnly).ready).toBe(1);
    expect(summarizeLanes(opencodeOnly).canDispatch).toBe(false);

    expect(summarizeLanes(lanes()).canDispatch).toBe(true);
  });
});

describe("freshness label — a stale value is always labelled", () => {
  it("names the probe in flight rather than showing a bare age", () => {
    expect(freshnessLabel(meta("probing"))).toBe("Checking providers…");
  });

  it("renders the age of a fresh value", () => {
    expect(
      freshnessLabel({ state: "fresh", checkedAt: null, ageMs: 12_000, error: null })
    ).toBe("Checked 12s ago");
    expect(
      freshnessLabel({ state: "fresh", checkedAt: null, ageMs: 1_000, error: null })
    ).toBe("Checked just now");
  });

  it("says plainly when a refresh has stalled, instead of implying live data", () => {
    expect(
      freshnessLabel({
        state: "stale",
        checkedAt: null,
        ageMs: 240_000,
        error: "brain unreachable",
      })
    ).toBe("Last checked 4m ago · refresh stalled");
  });
});
