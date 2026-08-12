import { beforeEach, describe, expect, it } from "vitest";
import {
  clearVendorReadinessCache,
  getVendorReadinessCached,
  probeVendorReadiness,
  probeAllVendorReadiness,
  anyVendorReady,
  vendorIsReady,
  vendorDispatchRoles,
  VENDOR_READINESS_PROBES,
  type ProbeExec,
  type ProbeExecResult,
  type ProbeOptions,
} from "../src/vendor-readiness.js";
import { createDefaultAdapters } from "../src/registry.js";
import { FAKE_VENDOR_KEY } from "../src/fake-lane-adapter.js";

/**
 * The auth-aware readiness probe (P2). Everything is injected, no real vendor
 * CLI is ever spawned, and no token is ever read:
 *  - `hasCommand` decides which binaries "exist" on PATH, and
 *  - `exec` returns each vendor CLI's canned status output + exit code.
 */
function hasCommand(installed: string[]) {
  return (cmd: string) => installed.includes(cmd);
}

function exec(map: Record<string, ProbeExecResult>): ProbeExec {
  return (command) =>
    map[command] ?? { status: 127, stdout: "", stderr: "not found" };
}

const noCredentialEvidence = () => ({
  ready: false,
  environmentKeys: [],
});

function probe(vendor: string, options: ProbeOptions = {}) {
  return probeVendorReadiness(vendor, {
    resolveCredentials: noCredentialEvidence,
    ...options,
  });
}

function probeAll(options: ProbeOptions = {}) {
  return probeAllVendorReadiness({
    resolveCredentials: noCredentialEvidence,
    ...options,
  });
}

describe("probeVendorReadiness", () => {
  it("reports not-installed with an install fixHint when no binary is present", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand([]),
      exec: exec({}),
    });
    expect(r).toMatchObject({ vendor: "codex", installed: false, authenticated: false });
    expect(r.fixHint).toMatch(/install the Codex CLI/i);
  });

  it("claude-code: parses `auth status --json` loggedIn:true → authenticated (no token in detail)", async () => {
    const r = await probe("claude-code", {
      hasCommand: hasCommand(["claude"]),
      exec: exec({
        claude: {
          status: 0,
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "claude.ai",
            email: "dev@example.com",
            subscriptionType: "max",
          }),
          stderr: "",
        },
      }),
    });

    expect(r).toMatchObject({ installed: true, authenticated: true });
    expect(r.fixHint).toBeUndefined();
    expect(r.detail).toContain("dev@example.com");
    // Ownership provenance is fine; a token must never leak in.
    expect(JSON.stringify(r)).not.toMatch(/sk-|token|secret|bearer/i);
  });

  it("claude-code: loggedIn:false → not authenticated with the login fixHint", async () => {
    const r = await probe("claude-code", {
      hasCommand: hasCommand(["claude"]),
      exec: exec({ claude: { status: 0, stdout: '{"loggedIn":false}', stderr: "" } }),
    });

    expect(r).toMatchObject({ installed: true, authenticated: false });
    expect(r.fixHint).toMatch(/claude/i);
  });

  it("codex: `login status` exit 1 + 'Not logged in' → not authenticated, `codex login` hint", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({ codex: { status: 1, stdout: "Not logged in", stderr: "" } }),
    });

    expect(r).toMatchObject({ installed: true, authenticated: false });
    expect(r.fixHint).toBe("log into Codex first: `codex login`");
  });

  it("codex: exit 0 with an explicit 'Logged in' phrase → authenticated", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: { status: 0, stdout: "Logged in using ChatGPT (dev@example.com)", stderr: "" },
      }),
    });

    expect(r).toMatchObject({ installed: true, authenticated: true });
    expect(r.fixHint).toBeUndefined();
  });

  // F2: exit-0 alone must NOT count as authenticated.
  it("codex: exit 0 but usage/help text (no 'logged in' phrase) → NOT authenticated (fail-closed)", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: {
          status: 0,
          stdout:
            "Manage login\n\nUsage: codex login [OPTIONS] [COMMAND]\n\nCommands:\n  status  Show login status",
          stderr: "",
        },
      }),
    });

    expect(r).toMatchObject({ installed: true, authenticated: false });
    expect(r.fixHint).toMatch(/codex login/);
  });

  it("cursor: agent CLI 'Logged in as <email>' exit 0 → authenticated", async () => {
    const r = await probe("cursor", {
      hasCommand: hasCommand(["cursor-agent", "agent"]),
      exec: exec({
        "cursor-agent": { status: 0, stdout: "✓ Logged in as dev@example.com", stderr: "" },
        agent: { status: 0, stdout: "✓ Logged in as dev@example.com", stderr: "" },
      }),
    });

    expect(r).toMatchObject({ installed: true, authenticated: true });
    expect(r.fixHint).toBeUndefined();
  });

  it("cursor: not-logged-in text → not authenticated with `cursor-agent login`", async () => {
    const r = await probe("cursor", {
      hasCommand: hasCommand(["cursor-agent", "agent"]),
      exec: exec({
        "cursor-agent": { status: 1, stdout: "Not logged in", stderr: "" },
        agent: { status: 1, stdout: "Not logged in", stderr: "" },
      }),
    });

    expect(r).toMatchObject({ installed: true, authenticated: false });
    expect(r.fixHint).toMatch(/cursor-agent login/);
  });

  // F3: a bare success glyph or an `@` is NOT proof of login.
  it("cursor: exit 0 with a ✓ glyph and an `@` but no 'logged in' phrase → NOT authenticated", async () => {
    const r = await probe("cursor", {
      hasCommand: hasCommand(["cursor-agent", "agent"]),
      exec: exec({
        "cursor-agent": { status: 0, stdout: "✓ cursor-agent@2026.1.0 ready", stderr: "" },
        agent: { status: 0, stdout: "✓ cursor-agent@2026.1.0 ready", stderr: "" },
      }),
    });

    expect(r).toMatchObject({ installed: true, authenticated: false });
    expect(r.fixHint).toMatch(/login/);
  });

  it("cursor: installed only as the bare `cursor` IDE launcher → probes it but stays honest", async () => {
    const r = await probe("cursor", {
      hasCommand: hasCommand(["cursor"]),
      exec: exec({ cursor: { status: 0, stdout: "Cursor 1.2.3", stderr: "" } }),
    });
    expect(r).toMatchObject({ installed: true, authenticated: false });
    expect(r.fixHint).toMatch(/login/);
  });

  it("cursor: an API key cannot make the IDE-only launcher dispatch-ready", async () => {
    const r = await probe("cursor", {
      hasCommand: hasCommand(["cursor"]),
      exec: exec({
        cursor: { status: 0, stdout: "Cursor 1.2.3", stderr: "" },
      }),
      resolveCredentials: () => ({
        ready: true,
        method: "api-key",
        detail: "configured with a Cursor API key",
        environmentKeys: ["CURSOR_API_KEY"],
      }),
    });

    expect(r).toMatchObject({ installed: true, authenticated: false });
    expect(r).not.toHaveProperty("credentialMethod");
  });

  // F5: `detail` is built from a parsed field, never the raw first line, so a
  // secret a CLI might print on line 1 cannot surface.
  it("builds detail from a parsed account field, never the raw output line (no secret leak)", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: {
          status: 0,
          // Hostile line 1 with a secret-looking token, real signal on line 2.
          stdout: "sk-live-DEADBEEFsupersecret\nLogged in as dev@example.com",
          stderr: "",
        },
      }),
    });

    expect(r.authenticated).toBe(true);
    expect(r.detail).toBe("logged in as dev@example.com");
    expect(r.detail).not.toContain("sk-live");
    expect(JSON.stringify(r)).not.toContain("DEADBEEF");
  });

  it("a probe that errors (spawn failure / timeout) never reports authenticated", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: { status: null, stdout: "", stderr: "", error: new Error("ETIMEDOUT") },
      }),
    });

    expect(r).toMatchObject({ installed: true, authenticated: false });
    expect(r.detail).toMatch(/could not run/i);
    expect(r.fixHint).toMatch(/codex login/);
  });

  it("recognizes an active Codex custom provider when native login is absent", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: { status: 1, stdout: "Not logged in", stderr: "" },
      }),
      resolveCredentials: () => ({
        ready: true,
        method: "custom-provider",
        detail: "configured with the active Codex provider",
        environmentKeys: ["AZURE_OPENAI_API_KEY"],
      }),
    });

    expect(r).toMatchObject({
      installed: true,
      authenticated: true,
      credentialMethod: "custom-provider",
      detail: "configured with the active Codex provider",
    });
    expect(r.fixHint).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("azure-secret");
  });

  it("uses the active custom provider even when a native Codex login is cached", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: {
          status: 0,
          stdout: "Logged in as dev@example.com",
          stderr: "",
        },
      }),
      resolveCredentials: () => ({
        ready: true,
        method: "custom-provider",
        detail: "configured with the active Codex provider",
        environmentKeys: ["AZURE_OPENAI_API_KEY"],
      }),
    });

    expect(r).toMatchObject({
      authenticated: true,
      credentialMethod: "custom-provider",
      detail: "configured with the active Codex provider",
    });
  });

  it("does not let a cached native login mask a missing active custom-provider credential", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: {
          status: 0,
          stdout: "Logged in as dev@example.com",
          stderr: "",
        },
      }),
      resolveCredentials: () => ({
        ready: false,
        method: "custom-provider",
        detail: "the active Codex provider credential is not configured",
        environmentKeys: ["AZURE_OPENAI_API_KEY"],
      }),
    });

    expect(r).toMatchObject({
      installed: true,
      authenticated: false,
      authState: "provider-unconfigured",
      detail: "the active Codex provider credential is not configured",
    });
    expect(r.fixHint).toMatch(/active Codex provider credential/i);
    expect(r.fixHint).not.toMatch(/codex login/i);
  });

  it("uses positive provider evidence when the native probe errors", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: {
          status: null,
          stdout: "",
          stderr: "",
          error: new Error("native status unavailable"),
        },
      }),
      resolveCredentials: () => ({
        ready: true,
        method: "custom-provider",
        detail: "configured with the active Codex provider",
        environmentKeys: ["AZURE_OPENAI_API_KEY"],
      }),
    });

    expect(r).toMatchObject({
      authenticated: true,
      credentialMethod: "custom-provider",
    });
  });

  it.each([
    ["claude-code", "claude", "ANTHROPIC_API_KEY"],
    ["cursor", "cursor-agent", "CURSOR_API_KEY"],
  ])(
    "%s: direct API-key evidence makes an installed CLI ready",
    async (vendor, binary, environmentKey) => {
      const r = await probe(vendor, {
        hasCommand: hasCommand([binary]),
        exec: exec({
          [binary]: { status: 1, stdout: "Not logged in", stderr: "" },
        }),
        resolveCredentials: () => ({
          ready: true,
          method: "api-key",
          detail: `configured with a ${vendor} API key`,
          environmentKeys: [environmentKey],
        }),
      });

      expect(r).toMatchObject({
        installed: true,
        authenticated: true,
        credentialMethod: "api-key",
      });
      expect(r.fixHint).toBeUndefined();
    }
  );

  it("keeps native negative behavior when provider evidence is negative", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: { status: 1, stdout: "Not logged in", stderr: "" },
      }),
    });

    expect(r).toMatchObject({
      installed: true,
      authenticated: false,
      detail: "not logged in",
    });
    expect(r).not.toHaveProperty("credentialMethod");
    expect(r.fixHint).toBe("log into Codex first: `codex login`");
  });

  it("degrades to native behavior when credential resolution throws", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: {
          status: 0,
          stdout: "Logged in as dev@example.com",
          stderr: "",
        },
      }),
      resolveCredentials: () => {
        throw new Error("credential resolver unavailable");
      },
    });

    expect(r).toMatchObject({
      authenticated: true,
      credentialMethod: "vendor-login",
    });
  });

  it("guides missing custom-provider credentials without falsely requiring codex login", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: { status: 1, stdout: "Not logged in", stderr: "" },
      }),
      resolveCredentials: () => ({
        ready: false,
        method: "custom-provider",
        detail: "the active Codex provider credential is not configured",
        environmentKeys: ["AZURE_OPENAI_API_KEY"],
      }),
    });

    expect(r).toMatchObject({
      authenticated: false,
      detail: "the active Codex provider credential is not configured",
    });
    expect(r.fixHint).toMatch(/active Codex provider credential/i);
    expect(r.fixHint).not.toMatch(/codex login/i);
  });
});

describe("probeAllVendorReadiness, async / non-blocking (F1)", () => {
  it("runs every vendor probe CONCURRENTLY, not sequentially", async () => {
    let active = 0;
    let maxActive = 0;
    // An async exec that overlaps: if the probes were serialized (sync
    // spawnSync, blocking the loop), maxActive would never exceed 1.
    const slowExec: ProbeExec = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return { status: 0, stdout: "Logged in as dev@example.com", stderr: "" };
    };
    // Async hasCommand too, proves the PATH check doesn't block either.
    const asyncHas = async () => true;

    const all = await probeAll({ exec: slowExec, hasCommand: asyncHas });

    expect(all).toHaveLength(VENDOR_READINESS_PROBES.length);
    // Every vendor overlaps every other vendor (the original F1 claim) AND,
    // since R2, each vendor's own version + auth probes overlap each other —
    // hence two per vendor rather than one.
    expect(maxActive).toBe(VENDOR_READINESS_PROBES.length * 2);
  });
});

describe("authState (P0.5 machine-stable auth evidence)", () => {
  it("native login carries authState:'confirmed'", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: { status: 0, stdout: "Logged in as dev@example.com", stderr: "" },
      }),
    });
    expect(r.authState).toBe("confirmed");
  });

  it("provider (BYOK) evidence carries authState:'confirmed'", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: { status: 1, stdout: "Not logged in", stderr: "" },
      }),
      resolveCredentials: () => ({
        ready: true,
        method: "custom-provider",
        detail: "configured with the active Codex provider",
        environmentKeys: ["AZURE_OPENAI_API_KEY"],
      }),
    });
    expect(r).toMatchObject({ authenticated: true, authState: "confirmed" });
  });

  it("a probe failure carries authState:'unknown' (honest tri-state, not signed-out)", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: { status: null, stdout: "", stderr: "", error: new Error("ETIMEDOUT") },
      }),
    });
    // `authenticated` stays false for existing consumers, but the tri-state
    // records that auth was NOT probed to a negative verdict.
    expect(r).toMatchObject({ authenticated: false, authState: "unknown" });
  });

  it("codex custom-provider-unconfigured carries authState:'provider-unconfigured'", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: { status: 1, stdout: "Not logged in", stderr: "" },
      }),
      resolveCredentials: () => ({
        ready: false,
        method: "custom-provider",
        detail: "the active Codex provider credential is not configured",
        environmentKeys: ["AZURE_OPENAI_API_KEY"],
      }),
    });
    expect(r.authState).toBe("provider-unconfigured");
  });

  it("an explicit negative verdict carries authState:'negative'", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: exec({
        codex: { status: 1, stdout: "Not logged in", stderr: "" },
      }),
    });
    expect(r.authState).toBe("negative");
  });

  it("not-installed and unknown vendors leave authState absent (auth never probed)", async () => {
    const notInstalled = await probe("codex", {
      hasCommand: hasCommand([]),
      exec: exec({}),
    });
    expect(notInstalled).not.toHaveProperty("authState");

    const unknownVendor = await probe("no-such-vendor", {
      hasCommand: hasCommand([]),
      exec: exec({}),
    });
    expect(unknownVendor).not.toHaveProperty("authState");
  });
});

describe("readiness helpers", () => {
  it("probeAllVendorReadiness returns one entry per known vendor", async () => {
    const all = await probeAll({
      hasCommand: hasCommand([]),
      exec: exec({}),
    });
    expect(all.map((entry) => entry.vendor).sort()).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "opencode",
    ]);
  });

  it("anyVendorReady / vendorIsReady reflect installed AND authenticated", () => {
    const list = [
      { vendor: "claude-code", installed: true, authenticated: true, detail: "ok" },
      { vendor: "codex", installed: true, authenticated: false, detail: "no" },
      { vendor: "cursor", installed: false, authenticated: false, detail: "no" },
    ];
    expect(anyVendorReady(list)).toBe(true);
    expect(vendorIsReady(list, "claude-code")).toBe(true);
    expect(vendorIsReady(list, "codex")).toBe(false);
    expect(vendorIsReady(list, "cursor")).toBe(false);
    expect(vendorIsReady(list, "unknown")).toBe(false);
  });

  it("treats an authenticated Cursor as ready for READ-ONLY roles only", () => {
    // This assertion used to be "never dispatch-ready", from when Cursor was a
    // readiness-only integration. Cursor is now a MANAGED lane — but only for
    // roles that cannot write — so the honest answers differ per question:
    // it IS a usable lane, it is NOT something you can implement with, and a
    // machine holding only Cursor still cannot get work done.
    const cursorOnly = [
      {
        vendor: "cursor",
        installed: true,
        authenticated: true,
        detail: "logged in",
      },
    ];
    expect(vendorIsReady(cursorOnly, "cursor")).toBe(true);
    expect(vendorIsReady(cursorOnly, "cursor", "reviewer")).toBe(true);
    expect(vendorIsReady(cursorOnly, "cursor", "qa")).toBe(true);
    expect(vendorIsReady(cursorOnly, "cursor", "implementer")).toBe(false);
    expect(vendorIsReady(cursorOnly, "cursor", "orchestrator")).toBe(false);
    // A reviewer with nothing to review is not a working setup.
    expect(anyVendorReady(cursorOnly)).toBe(false);
  });

  it("judges the OpenCode lane by its roles, not by its name", () => {
    const opencodeOnly = [
      {
        vendor: "opencode",
        installed: true,
        authenticated: true,
        detail: "logged in (1 stored credential)",
      },
    ];
    expect(vendorIsReady(opencodeOnly, "opencode")).toBe(true);
    expect(vendorIsReady(opencodeOnly, "opencode", "scout")).toBe(true);
    // `scout` is the ENTIRE ceiling, so every other role is refused — including
    // the read-only ones Cursor holds. This lane earns less than Cursor, not
    // more, and these refusals are what pin that.
    for (const role of [
      "implementer",
      "orchestrator",
      "docs",
      "reviewer",
      "qa",
      "architect",
    ] as const) {
      expect(vendorIsReady(opencodeOnly, "opencode", role)).toBe(false);
    }
    // The Ollama lane it replaced DID satisfy `anyVendorReady` on its own,
    // because its ceiling included `docs` (a write role). OpenCode's does not,
    // so a machine holding only this lane is honestly told it cannot yet produce
    // a change. Same derivation, different answer — which is the point of
    // deriving it from ROLE_SPECS instead of from a vendor name.
    expect(anyVendorReady(opencodeOnly)).toBe(false);
  });

  it("keeps the probe roles identical to the adapters' own supportedRoles", () => {
    // The drift joint. `vendor-readiness.ts` cannot import the adapters
    // (cursor-adapter imports IT), so the role lists are declared twice. If they
    // ever disagree, readiness would answer a different question than dispatch.
    //
    // The adapter list is `createDefaultAdapters()` — the SAME set dispatch
    // resolves against — and not a hand-written array. A hardcoded four walked
    // straight past a fifth vendor: the newcomer had no probe row, no assertion
    // named it, and the file stayed green while readiness answered `[]` for it.
    const adapters = createDefaultAdapters().filter(
      (adapter) => adapter.id !== FAKE_VENDOR_KEY
    );

    // Membership first, so a new adapter FAILS here until it has a probe row.
    expect(adapters.map((adapter) => adapter.id).sort()).toEqual(
      VENDOR_READINESS_PROBES.map((spec) => spec.vendor).sort()
    );

    for (const adapter of adapters) {
      const declared = adapter.supportedRoles;
      expect(declared, `${adapter.id} declares supportedRoles`).toBeDefined();
      expect([...vendorDispatchRoles(adapter.id)].sort()).toEqual(
        [...(declared ?? [])].sort()
      );
    }
  });

  it("states that the dev/test fake has no readiness probe at all", () => {
    // The one named exemption from the membership assertion above, written as a
    // POSITIVE statement rather than left as an omission: `fake` is a hermetic
    // double with no binary to probe, so readiness answers `[]` for it and it
    // can never be counted as a ready lane.
    expect(
      VENDOR_READINESS_PROBES.some((spec) => spec.vendor === FAKE_VENDOR_KEY)
    ).toBe(false);
    expect(vendorDispatchRoles(FAKE_VENDOR_KEY)).toEqual([]);
    expect(
      vendorIsReady(
        [
          {
            vendor: FAKE_VENDOR_KEY,
            installed: true,
            authenticated: true,
            detail: "hermetic double",
          },
        ],
        FAKE_VENDOR_KEY
      )
    ).toBe(false);
  });

  it("still recognizes a dispatch-ready Codex lane alongside Cursor", () => {
    const list = [
      {
        vendor: "cursor",
        installed: true,
        authenticated: true,
        detail: "logged in",
      },
      {
        vendor: "codex",
        installed: true,
        authenticated: true,
        detail: "logged in",
      },
    ];
    expect(anyVendorReady(list)).toBe(true);
    expect(vendorIsReady(list, "codex")).toBe(true);
  });
});

// ── P0.1 checkpoint+resume (Slice B1): vendor CLI version fingerprint ─────────
//
// The run bundle carries provider/version evidence so a resume can surface
// drift between the exporting install and the live one. The probe reuses the
// injectable exec seam; a version string is a fingerprint REF, not a secret.
// Honest absence: any failure to probe omits the field, never guesses.
describe("cliVersion probe", () => {
  it("captures the first line of `--version` (trimmed) when installed", async () => {
    const r = await probe("claude-code", {
      hasCommand: hasCommand(["claude"]),
      exec: (command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "  2.1.207 (Claude Code)\nextra noise\n", stderr: "" };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ loggedIn: true, email: "dev@example.com" }),
          stderr: "",
        };
      },
    });
    expect(r.installed).toBe(true);
    expect(r.cliVersion).toBe("2.1.207 (Claude Code)");
  });

  it("bounds a runaway version line to 100 chars", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: (_command, args) =>
        args[0] === "--version"
          ? { status: 0, stdout: `1.2.3-${"v".repeat(500)}`, stderr: "" }
          : { status: 1, stdout: "Not logged in", stderr: "" },
    });
    expect(r.cliVersion).toHaveLength(100);
  });

  it("omits a first line that does not look like a version (no secret-shaped capture)", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: (_command, args) =>
        args[0] === "--version"
          ? { status: 0, stdout: "sk-live-DEADBEEFsupersecret", stderr: "" }
          : { status: 1, stdout: "Not logged in", stderr: "" },
    });
    expect(r.cliVersion).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("DEADBEEF");
  });

  it("omits the field on a version-probe failure and leaves readiness unchanged", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: (_command, args) =>
        args[0] === "--version"
          ? { status: null, stdout: "", stderr: "", error: new Error("spawn failed") }
          : { status: 0, stdout: "Logged in using ChatGPT (dev@example.com)", stderr: "" },
    });
    expect(r).toMatchObject({ installed: true, authenticated: true });
    expect(r.cliVersion).toBeUndefined();
  });

  it("omits the field when the version output is empty", async () => {
    const r = await probe("codex", {
      hasCommand: hasCommand(["codex"]),
      exec: (_command, args) =>
        args[0] === "--version"
          ? { status: 0, stdout: "\n\n", stderr: "" }
          : { status: 1, stdout: "Not logged in", stderr: "" },
    });
    expect(r.cliVersion).toBeUndefined();
  });

  it("never runs the version probe when the CLI is not installed", async () => {
    const seen: string[][] = [];
    const r = await probe("claude-code", {
      hasCommand: hasCommand([]),
      exec: (_command, args) => {
        seen.push([...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(r.installed).toBe(false);
    expect(r.cliVersion).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

// ── Probe COST: the readiness probe spawns real vendor CLIs ──────────────────
//
// Measured on the founder's machine with all four lanes installed and logged in:
// `cursor-agent status` alone is ~3.3s, and the whole set ~3.7s. The desktop has
// its own display cache, but the CLI, TUI, MCP and runner all come through these
// functions unprotected. Both fixes below are about how OFTEN and how SERIALLY
// those children are spawned — neither may change a single verdict, because
// these feed real gates (`requireOrchestratorReady`), not a display.
describe("readiness probe cost", () => {
  /** A probe seam that records call order and resolves on demand. */
  function slowExec(order: string[], delayMs = 5): ProbeExec {
    return async (command, args) => {
      order.push(`${command} ${args.join(" ")}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        status: 0,
        stdout: command === "cursor-agent" ? "1.2.3\nLogged in as a@b.co" : "9.9.9",
        stderr: "",
      };
    };
  }

  beforeEach(() => {
    clearVendorReadinessCache();
  });

  it("R2: runs the version and auth probes CONCURRENTLY, not one after the other", async () => {
    const order: string[] = [];
    let concurrent = 0;
    let peak = 0;
    const exec: ProbeExec = async (command, args) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      order.push(`${command} ${args.join(" ")}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return { status: 0, stdout: "1.2.3\nLogged in as a@b.co", stderr: "" };
    };

    const result = await probeVendorReadiness("cursor", {
      hasCommand: hasCommand(["cursor-agent"]),
      resolveCredentials: noCredentialEvidence,
      exec,
    });

    // Both probes were in flight at once — the serial version cost is gone.
    expect(peak).toBe(2);
    expect(order).toHaveLength(2);
    // And the verdict is unchanged: still gated on the explicit positive phrase.
    expect(result).toMatchObject({
      vendor: "cursor",
      installed: true,
      authenticated: true,
      authState: "confirmed",
      cliVersion: "1.2.3",
    });
  });

  it("R2: parallelism cannot turn a REFUSAL into an ADMISSION", async () => {
    // `cursor-agent` exits 0 while logged out — the gotcha this repo has already
    // been bitten by. Concurrency must not launder that into a positive.
    const result = await probeVendorReadiness("cursor", {
      hasCommand: hasCommand(["cursor-agent"]),
      resolveCredentials: noCredentialEvidence,
      exec: async () => ({ status: 0, stdout: "1.2.3", stderr: "" }),
    });
    expect(result.authenticated).toBe(false);
    expect(result.authState).toBe("negative");
  });

  it("R1: concurrent callers on an expired cache share ONE probe set", async () => {
    const order: string[] = [];
    const exec = slowExec(order);
    const opts = {
      hasCommand: hasCommand(["claude", "codex", "cursor-agent", "opencode"]),
      resolveCredentials: noCredentialEvidence,
      exec,
    };

    const [a, b, c] = await Promise.all([
      getVendorReadinessCached(opts),
      getVendorReadinessCached(opts),
      getVendorReadinessCached(opts),
    ]);

    // One set of children for three callers, not three.
    const perCallerCalls = VENDOR_READINESS_PROBES.length * 2;
    expect(order).toHaveLength(perCallerCalls);
    // Every caller still got the full, identical answer.
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a).toHaveLength(VENDOR_READINESS_PROBES.length);
  });

  it("R1: a post-login `refresh` NEVER joins an in-flight probe", async () => {
    // The regression that would matter: the runner re-probes with refresh:true
    // right after a login precisely so a job is not permanently failed on a
    // stale "not logged in". Joining a probe that started BEFORE the login would
    // hand it exactly that stale refusal.
    let loggedIn = false;
    const exec: ProbeExec = async (_command, args) => {
      const isAuth = !args.includes("--version");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: 0,
        stdout: isAuth
          ? loggedIn
            ? "Logged in as a@b.co"
            : "not logged in"
          : "1.2.3",
        stderr: "",
      };
    };
    const opts = {
      hasCommand: hasCommand(["claude"]),
      resolveCredentials: noCredentialEvidence,
      exec,
    };

    const pending = getVendorReadinessCached(opts);
    // The login lands while that first probe is still running.
    loggedIn = true;
    const refreshed = await getVendorReadinessCached({ ...opts, refresh: true });
    await pending;

    expect(
      refreshed.find((entry) => entry.vendor === "claude-code")?.authenticated
    ).toBe(true);
  });

  it("R1: the in-flight slot is released, so a later caller re-probes after the TTL", async () => {
    const order: string[] = [];
    const opts = {
      hasCommand: hasCommand(["claude"]),
      resolveCredentials: noCredentialEvidence,
      exec: slowExec(order),
      ttlMs: 0,
    };

    await getVendorReadinessCached(opts);
    const afterFirst = order.length;
    await getVendorReadinessCached(opts);

    expect(order.length).toBeGreaterThan(afterFirst);
  });
});
