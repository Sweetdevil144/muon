import { describe, expect, it } from "vitest";
import {
  buildOnboardingState,
  vendorOnboardingStep,
  vendorRoleScope,
  NEVER_STORES_TOKEN_NOTICE,
  MANUAL_CONNECT_STEPS,
  ONBOARDING_VENDORS,
  ONBOARDING_VENDOR_LABELS,
} from "../src/onboarding.js";
import {
  buildCapabilityPreflight,
  VENDOR_DISPATCH_ROLES,
} from "../src/capability-preflight.js";
import type { VendorReadiness } from "../src/types.js";

const notInstalled: VendorReadiness = {
  vendor: "codex",
  installed: false,
  authenticated: false,
  detail: "Codex CLI not found",
  fixHint: "install the Codex CLI (`npm i -g @openai/codex`), then `codex login`",
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

const opencodeNotInstalled: VendorReadiness = {
  vendor: "opencode",
  installed: false,
  authenticated: false,
  detail: "OpenCode CLI not found",
  fixHint:
    "install OpenCode (`curl -fsSL https://opencode.ai/install | bash`), then `opencode auth login`",
};

const opencodeSignedOut: VendorReadiness = {
  vendor: "opencode",
  installed: true,
  authenticated: false,
  detail: "not logged in",
  fixHint: "log into OpenCode first: `opencode auth login`",
};

describe("vendorOnboardingStep (readiness → guided step)", () => {
  it("not-installed → install step, keeps the install fixHint verbatim", () => {
    const step = vendorOnboardingStep(notInstalled);
    expect(step.step).toBe("install");
    expect(step.label).toBe("Codex");
    expect(step.fixHint).toBe(notInstalled.fixHint);
    expect(step.guidance).toMatch(/install/i);
  });

  it("installed-not-authenticated → setup step, keeps the exact fix command", () => {
    const step = vendorOnboardingStep(installedNotAuth);
    expect(step.step).toBe("login");
    expect(step.installed).toBe(true);
    expect(step.authenticated).toBe(false);
    // The user runs THIS themselves, MUON never handles the token.
    expect(step.fixHint).toBe("log into Codex first: `codex login`");
    expect(step.guidance).toMatch(/setup needed/i);
    expect(step.guidance).not.toMatch(/not logged in/i);
  });

  it("ready → ready step, no fixHint", () => {
    const step = vendorOnboardingStep(ready);
    expect(step.step).toBe("ready");
    expect(step.fixHint).toBeUndefined();
    expect(step.guidance).toMatch(/ready/i);
  });

  it("custom-provider readiness explains that Codex is configured through its active provider", () => {
    const step = vendorOnboardingStep(customProviderReady);
    expect(step.step).toBe("ready");
    expect(step.credentialMethod).toBe("custom-provider");
    expect(step.guidance).toBe(
      "Codex is configured through its active provider, ready to dispatch."
    );
  });

  it("API-key readiness explains that Claude Code uses its own API key", () => {
    const step = vendorOnboardingStep(apiKeyReady);
    expect(step.step).toBe("ready");
    expect(step.credentialMethod).toBe("api-key");
    expect(step.guidance).toBe(
      "Claude Code is configured with its own API key, ready to dispatch."
    );
  });

  it("Cursor ready copy names the managed read-only roles it actually holds", () => {
    const step = vendorOnboardingStep(cursorReady);
    expect(step.step).toBe("ready");
    // ADR-0020: Cursor is a MANAGED read-only lane, not a "someday" integration.
    expect(step.guidance).toMatch(/managed for read-only crew roles only/i);
    for (const role of ["reviewer", "qa", "architect", "scout"]) {
      expect(step.guidance).toContain(role);
    }
    expect(step.guidance).not.toMatch(/implementer|docs|orchestrator/);
    // The stale promise this replaces.
    expect(step.guidance).not.toMatch(
      /Dispatch depth expands|integration lands|takeover/i
    );
  });

  it("OpenCode is a first-class onboarding vendor with its own label and a real login", () => {
    expect(ONBOARDING_VENDORS).toContain("opencode");
    expect(ONBOARDING_VENDOR_LABELS.opencode).toBe("OpenCode");

    const install = vendorOnboardingStep(opencodeNotInstalled);
    expect(install.step).toBe("install");
    expect(install.label).toBe("OpenCode");
    expect(install.fixHint).toBe(opencodeNotInstalled.fixHint);
    // Unlike the Ollama lane it replaced, OpenCode HAS an account, so the copy
    // must not use the account-free wording (`connectKind: "account"`).
    expect(install.guidance).not.toMatch(/no account|no sign-in exists/i);

    // `opencode auth list` exits 0 WHEN LOGGED OUT, so a signed-out lane still
    // has to land on `login`, never on `ready`.
    const setup = vendorOnboardingStep(opencodeSignedOut);
    expect(setup.step).toBe("login");
    expect(setup.fixHint).toBe(opencodeSignedOut.fixHint);

    const ready = vendorOnboardingStep(opencodeReady);
    expect(ready.step).toBe("ready");
    // The scope shown is the ceiling: one role, not a wider read-only slice.
    expect(ready.guidance).toMatch(/scout/);
    expect(ready.guidance).not.toMatch(/implementer|orchestrator/);
  });

  it("manual fallback steps name OpenCode's real requirements (install + login, read-only)", () => {
    const step = MANUAL_CONNECT_STEPS.find((entry) => /opencode/i.test(entry));
    expect(step).toBeDefined();
    expect(step).toMatch(/opencode auth login/);
    expect(step).toMatch(/read/i);
    // It must never be advertised as something that can change the repo.
    expect(step).not.toMatch(/implement|write code/i);
  });
});

describe("vendorRoleScope (what a lane is FOR, derived from the role model)", () => {
  it("mirrors the ONE vendor→roles map rather than a second vendor list", () => {
    for (const vendor of ONBOARDING_VENDORS) {
      expect(vendorRoleScope(vendor).roles).toEqual([
        ...(VENDOR_DISPATCH_ROLES[vendor] ?? []),
      ]);
    }
  });

  it("marks Cursor read-only and role-scoped, and never claims it can implement", () => {
    const scope = vendorRoleScope("cursor");
    expect(scope.readOnly).toBe(true);
    expect(scope.scoped).toBe(true);
    expect(scope.takesUnplannedWork).toBe(false);
    expect(scope.roles).not.toContain("implementer");
    expect(scope.roles).not.toContain("docs");
    expect(scope.roles).not.toContain("orchestrator");
  });

  it("marks OpenCode role-scoped AND read-only (scout is its whole ceiling)", () => {
    const scope = vendorRoleScope("opencode");
    expect(scope.scoped).toBe(true);
    // The Ollama lane it replaced was `scoped` but NOT `readOnly`, because its
    // ceiling included `docs` (a write role). OpenCode holds one read-only role,
    // so both flags are true — a genuinely narrower lane, not a rename.
    expect(scope.readOnly).toBe(true);
    expect(scope.takesUnplannedWork).toBe(false);
    expect(scope.roles).toEqual(["scout"]);
  });

  it("full-role lanes are unscoped and take un-planned work", () => {
    for (const vendor of ["claude-code", "codex"]) {
      const scope = vendorRoleScope(vendor);
      expect(scope.scoped).toBe(false);
      expect(scope.takesUnplannedWork).toBe(true);
    }
  });

  it("an unknown vendor key holds NO role — absence is not a licence", () => {
    // This used to assert `scoped === false`, i.e. an unrecognized lane was
    // described to the operator as "a managed dispatch lane for every crew
    // role". It was the widest of the four `?? AGENT_ROLES` fail-opens and the
    // only one a human reads (the desktop Crew sidebar renders this copy).
    const scope = vendorRoleScope("some-future-vendor");
    expect(scope.label).toBe("some-future-vendor");
    expect(scope.roles).toEqual([]);
    expect(scope.scoped).toBe(true);
    expect(scope.takesUnplannedWork).toBe(false);
    expect(scope.readOnly).toBe(false);
    expect(scope.managedFor).toBe("no crew role");
    expect(scope.summary).toContain("not a managed dispatch lane");
    // The copy never renders a dangling "roles only: ." from an empty join.
    expect(scope.summary).not.toMatch(/:\s*\./);
  });

  it("agrees with the capability preflight about which lanes are dispatch-ready", () => {
    // Drift lock: two projections of the same role model must not disagree
    // about whether a connected lane can take un-planned work.
    const readiness: VendorReadiness[] = ONBOARDING_VENDORS.map((vendor) => ({
      vendor,
      installed: true,
      authenticated: true,
      credentialMethod: "vendor-login" as const,
      detail: "connected",
    }));
    const preflight = buildCapabilityPreflight({
      brain: { reachable: true },
      readiness: { vendors: readiness },
      runner: null,
    });
    const state = buildOnboardingState(readiness);
    for (const row of preflight.vendors) {
      expect(state.readyVendors.includes(row.vendor)).toBe(row.dispatchReady);
    }
  });
});

describe("buildOnboardingState (aggregate machine)", () => {
  it("loading when readiness is undefined (still probing)", () => {
    const state = buildOnboardingState(undefined);
    expect(state.phase).toBe("loading");
    expect(state.canDispatch).toBe(false);
    expect(state.degraded).toBe(false);
  });

  it("degrades to manual steps when readiness is unavailable (null)", () => {
    const state = buildOnboardingState(null);
    expect(state.phase).toBe("unavailable");
    expect(state.degraded).toBe(true);
    expect(state.canDispatch).toBe(false);
    expect(state.manualSteps).toEqual(MANUAL_CONNECT_STEPS);
    // Never claims a vendor is ready when it can't check.
    expect(state.anyReady).toBe(false);
  });

  it("no vendor ready → connect phase, first dispatch stays locked", () => {
    const state = buildOnboardingState([notInstalled, installedNotAuth]);
    expect(state.phase).toBe("connect");
    expect(state.anyReady).toBe(false);
    expect(state.canDispatch).toBe(false);
    expect(state.vendors.map((entry) => entry.step)).toEqual([
      "install",
      "login",
    ]);
  });

  it("≥1 vendor ready → ready phase unlocks first dispatch", () => {
    const state = buildOnboardingState([ready, installedNotAuth]);
    expect(state.phase).toBe("ready");
    expect(state.anyReady).toBe(true);
    expect(state.canDispatch).toBe(true);
    expect(state.readyVendors).toEqual(["claude-code"]);
    expect(state.subhead).toContain("Claude Code");
  });

  it("Cursor-only readiness keeps dispatch locked AND says why", () => {
    const state = buildOnboardingState([cursorReady]);
    expect(state.phase).toBe("connect");
    expect(state.anyReady).toBe(false);
    expect(state.canDispatch).toBe(false);
    expect(state.readyVendors).toEqual([]);
    expect(state.vendors[0]?.step).toBe("ready");
    // The gap this closes: a connected, green lane that leaves the user on
    // "connect an agent" with no reason given.
    expect(state.roleScopedVendors.map((scope) => scope.vendor)).toEqual([
      "cursor",
    ]);
    expect(state.subhead).toMatch(/read-only crew roles only/i);
    expect(state.subhead).toMatch(/reviewer, qa, architect, scout/);
    expect(state.subhead).toMatch(/can implement \(Claude Code or Codex\)/);
    expect(state.headline).toMatch(/can make changes/i);
  });

  it("OpenCode-only readiness keeps dispatch locked AND says why (it cannot implement)", () => {
    const state = buildOnboardingState([opencodeReady]);
    expect(state.phase).toBe("connect");
    expect(state.canDispatch).toBe(false);
    // Derived from the role model, not from a vendor name: this lane holds one
    // read-only role, so a machine with only OpenCode cannot produce a change.
    expect(state.readyVendors).toEqual([]);
    expect(state.roleScopedVendors.map((scope) => scope.vendor)).toEqual([
      "opencode",
    ]);
    expect(state.subhead).toMatch(/scout/);
  });

  it("a role-scoped lane beside a full lane unlocks dispatch, and is still explained", () => {
    const state = buildOnboardingState([cursorReady, ready, opencodeReady]);
    expect(state.phase).toBe("ready");
    expect(state.canDispatch).toBe(true);
    expect(state.readyVendors).toEqual(["claude-code"]);
    expect(state.roleScopedVendors.map((scope) => scope.vendor)).toEqual([
      "cursor",
      "opencode",
    ]);
    expect(state.subhead).toMatch(/Ready to dispatch: Claude Code/);
    expect(state.subhead).toMatch(/Cursor is a managed dispatch lane/);
    expect(state.subhead).toMatch(/OpenCode is a managed dispatch lane/);
  });

  it("mixed vendors → correct per-vendor step for each", () => {
    const state = buildOnboardingState([
      ready, // claude-code ready
      installedNotAuth, // codex login
      {
        vendor: "cursor",
        installed: false,
        authenticated: false,
        detail: "not found",
        fixHint: "install the Cursor agent CLI",
      },
    ]);
    const byVendor = new Map(state.vendors.map((v) => [v.vendor, v.step]));
    expect(byVendor.get("claude-code")).toBe("ready");
    expect(byVendor.get("codex")).toBe("login");
    expect(byVendor.get("cursor")).toBe("install");
  });

  it("carries the never-stores-token trust notice on every phase", () => {
    for (const input of [undefined, null, [ready], [notInstalled]] as const) {
      expect(buildOnboardingState(input).trustNotice).toBe(
        NEVER_STORES_TOKEN_NOTICE
      );
    }
  });

  it("states the least-authority credential handoff boundary", () => {
    expect(NEVER_STORES_TOKEN_NOTICE).toContain(
      "never stores, logs, or displays vendor credentials"
    );
    expect(NEVER_STORES_TOKEN_NOTICE).toContain(
      "only the selected credential variable to the selected vendor process"
    );
  });

  it("never reads or surfaces a token, only booleans + hints", () => {
    // A hostile probe result must not smuggle a secret into the view-model.
    const state = buildOnboardingState([
      { ...ready, detail: "logged in as dev@example.com" },
    ]);
    expect(JSON.stringify(state)).not.toMatch(/sk-|token|secret|bearer/i);
  });
});
