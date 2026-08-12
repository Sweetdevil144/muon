import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NoopSandboxLauncher,
  SeatbeltSandboxLauncher,
  buildSeatbeltProfile,
  describeSandboxAvailability,
  sandboxAvailabilityIsPermanent,
  sandboxDisabledByEnv,
  sandboxRequiredByEnv,
  sandboxedRunnerEnv,
  selectSandboxLauncher,
} from "../src/index.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const onMac = process.platform === "darwin" && existsSync(SANDBOX_EXEC);

/** Run `argv` under the given Seatbelt profile; report success + stdout. */
function runSandboxed(
  profile: string,
  argv: string[]
): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync(SANDBOX_EXEC, ["-p", profile, ...argv], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

// ---------------------------------------------------------------------------
// Cross-platform: degradation, escape hatch, platform selection, profile shape.
// These run on every OS (Linux CI included), no `sandbox-exec` required.
// ---------------------------------------------------------------------------
describe("SandboxLauncher, degradation + selection (all platforms)", () => {
  it("no-op launcher returns the command UNCHANGED (never hard-fail the CLI)", () => {
    const noop = new NoopSandboxLauncher();
    expect(noop.isAvailable()).toBe(false);
    const wrapped = noop.wrap("claude", ["-p", "hi"], { dataDir: "/x" });
    expect(wrapped).toEqual({
      command: "claude",
      args: ["-p", "hi"],
      sandboxed: false,
    });
  });

  it("MUON_SANDBOX=0 is the escape hatch (also false/off)", () => {
    expect(sandboxDisabledByEnv({ MUON_SANDBOX: "0" })).toBe(true);
    expect(sandboxDisabledByEnv({ MUON_SANDBOX: "false" })).toBe(true);
    expect(sandboxDisabledByEnv({ MUON_SANDBOX: "off" })).toBe(true);
    expect(sandboxDisabledByEnv({ MUON_SANDBOX: "1" })).toBe(false);
    expect(sandboxDisabledByEnv({})).toBe(false);
  });

  it("MUON_REQUIRE_SANDBOX=1 is the fail-closed opt-in (also true/on); default off", () => {
    expect(sandboxRequiredByEnv({ MUON_REQUIRE_SANDBOX: "1" })).toBe(true);
    expect(sandboxRequiredByEnv({ MUON_REQUIRE_SANDBOX: "true" })).toBe(true);
    expect(sandboxRequiredByEnv({ MUON_REQUIRE_SANDBOX: "on" })).toBe(true);
    expect(sandboxRequiredByEnv({ MUON_REQUIRE_SANDBOX: "0" })).toBe(false);
    expect(sandboxRequiredByEnv({})).toBe(false);
  });

  it("MUON_SANDBOX=0 selects the no-op launcher → wrap returns unchanged", () => {
    const launcher = selectSandboxLauncher({ ...process.env, MUON_SANDBOX: "0" });
    expect(launcher.isAvailable()).toBe(false);
    const wrapped = launcher.wrap("codex", ["app-server"], { dataDir: "/data" });
    expect(wrapped.sandboxed).toBe(false);
    expect(wrapped.command).toBe("codex");
    expect(wrapped.args).toEqual(["app-server"]);
  });

  it("Seatbelt launcher honors MUON_SANDBOX=0 even on macOS", () => {
    const disabled = new SeatbeltSandboxLauncher({
      ...process.env,
      MUON_SANDBOX: "0",
    });
    expect(disabled.isAvailable()).toBe(false);
    expect(
      disabled.wrap("claude", ["-p"], { dataDir: "/data" }).sandboxed
    ).toBe(false);
  });

  it("sandboxedRunnerEnv uses an explicit runtime/vendor allowlist (F-2)", () => {
    const env = sandboxedRunnerEnv({
      apiBase: "http://127.0.0.1:9999",
      agentToken: "AGENT-KEEP",
      leaseToken: `lease-${"l".repeat(58)}`,
      sandboxed: true,
      parentEnv: {
        PATH: "/usr/bin",
        HOME: "/Users/test",
        ANTHROPIC_API_KEY: "VENDOR-EXPLICIT",
        MUON_AUTO_CONTINUE: "0",
        MUON_FAKE_VENDOR: "1",
        MUON_FAKE_VENDOR_DESCENDANT_FILE: "/tmp/descendant.pid",
        MUON_DATA_DIR: "/Users/test/Library/Application Support/@muon/desktop",
        MUON_WORKTREE_ROOT: "/Users/test/worktrees-override",
        MUON_API_TOKEN: "OPERATOR-LEAK",
        MUON_OPERATOR_TOKEN: "OPERATOR-GOVERN",
        MUON_GITHUB_TOKEN: "GITHUB-OPERATOR-LEAK",
        MUON_GITHUB_REFRESH_TOKEN: "GITHUB-REFRESH-LEAK",
        MUON_AGENT_TOKEN: "STALE-AGENT",
        GH_TOKEN: "UNRELATED-SECRET",
        AWS_SECRET_ACCESS_KEY: "UNRELATED-CLOUD-SECRET",
        DATABASE_URL: "postgres://unrelated-secret",
        NODE_OPTIONS: "--require /tmp/inject.js",
      },
    });
    // Runtime + explicitly supported vendor auth survive.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/test");
    expect(env.ANTHROPIC_API_KEY).toBe("VENDOR-EXPLICIT");
    expect(env.MUON_AUTO_CONTINUE).toBe("0");
    expect(env.MUON_FAKE_VENDOR).toBe("1");
    expect(env.MUON_FAKE_VENDOR_DESCENDANT_FILE).toBe(
      "/tmp/descendant.pid"
    );
    // Profile coordinates flow so the runner derives the SAME worktree root as
    // the brain (they are paths, not credentials).
    expect(env.MUON_DATA_DIR).toBe(
      "/Users/test/Library/Application Support/@muon/desktop"
    );
    expect(env.MUON_WORKTREE_ROOT).toBe("/Users/test/worktrees-override");
    // MUON authority and unrelated parent secrets do not enter the runner.
    expect(env.MUON_API_TOKEN).toBeUndefined();
    expect(env.MUON_OPERATOR_TOKEN).toBeUndefined();
    expect(env.MUON_GITHUB_TOKEN).toBeUndefined();
    expect(env.MUON_GITHUB_REFRESH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.MUON_AGENT_TOKEN).toBe("AGENT-KEEP");
    expect(env.MUON_RUNNER_LEASE_TOKEN).toBe(`lease-${"l".repeat(58)}`);
    expect(env.MUON_API_BASE).toBe("http://127.0.0.1:9999");
    expect(env.MUON_SANDBOX_ACTIVE).toBe("1");
  });

  it("MUON_FULL_AUTO is absent by default (OFF byte-identical)", () => {
    const env = sandboxedRunnerEnv({
      apiBase: "http://127.0.0.1:9999",
      sandboxed: true,
      parentEnv: { PATH: "/usr/bin" },
    });
    expect(env.MUON_FULL_AUTO).toBeUndefined();
  });

  it("MUON_FULL_AUTO=1 is set only when fullAuto is requested", () => {
    const env = sandboxedRunnerEnv({
      apiBase: "http://127.0.0.1:9999",
      sandboxed: true,
      fullAuto: true,
      parentEnv: { PATH: "/usr/bin" },
    });
    expect(env.MUON_FULL_AUTO).toBe("1");
  });

  it("MUON_FULL_AUTO is never inherited from the parent env when fullAuto is off", () => {
    const env = sandboxedRunnerEnv({
      apiBase: "http://127.0.0.1:9999",
      sandboxed: true,
      parentEnv: { PATH: "/usr/bin", MUON_FULL_AUTO: "1" },
    });
    expect(env.MUON_FULL_AUTO).toBeUndefined();
  });

  it("sandboxedRunnerEnv without an agent token does not inherit a stale one", () => {
    const env = sandboxedRunnerEnv({
      apiBase: "http://127.0.0.1:9999",
      sandboxed: false,
      parentEnv: { MUON_AGENT_TOKEN: "STALE", MUON_API_TOKEN: "OP" },
    });
    expect(env.MUON_AGENT_TOKEN).toBeUndefined();
    expect(env.MUON_API_TOKEN).toBeUndefined();
    expect(env.MUON_SANDBOX_ACTIVE).toBeUndefined();
  });

  it("profile blinds the data dir and keeps a permissive baseline", () => {
    const profile = buildSeatbeltProfile({
      dataDir: "/some/data dir",
      writeRoots: ["/some/ws"],
    });
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(allow default)");
    // The F2 read-vector closure, the data dir is deny-read.
    expect(profile).toMatch(/\(deny file-read\* \(subpath "[^"]*data dir"\)\)/);
    // Write confinement present when writeRoots given.
    expect(profile).toContain("(deny file-write*)");
  });
});

// ---------------------------------------------------------------------------
// macOS Seatbelt E2E: prove F2's read vector is closed and writes are confined,
// while the vendor's OWN dirs stay reachable. Skips cleanly off macOS.
// ---------------------------------------------------------------------------
const describeMac = onMac ? describe : describe.skip;

describeMac("Seatbelt profile, F2 read/write confinement (macOS)", () => {
  let base: string;
  let dataDir: string;
  let workspace: string;
  let fakeHome: string; // stands in for ~/.claude-style vendor config
  let lockfile: string;
  let wsFile: string;
  let vendorConfig: string;
  const outsideWrite = path.join(
    homedir(),
    `.muon-sbx-test-${process.pid}-outside.txt`
  );
  let profile: string;

  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), "muon-sbx-"));
    dataDir = path.join(base, "data");
    workspace = path.join(base, "workspace");
    fakeHome = path.join(base, "home-dot-claude");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });

    lockfile = path.join(dataDir, "brain.lock");
    wsFile = path.join(workspace, "task.md");
    vendorConfig = path.join(fakeHome, "config.json");
    writeFileSync(lockfile, JSON.stringify({ token: "OPERATOR-SECRET" }));
    writeFileSync(wsFile, "workspace-visible");
    writeFileSync(vendorConfig, "vendor-owned-auth");

    // The A1-style workspace-scoped profile: blind the data dir, confine writes
    // to the workspace (+ tmp/devices).
    profile = buildSeatbeltProfile({ dataDir, writeRoots: [workspace] });
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(outsideWrite, { force: true });
  });

  it("DENIES reading the MUON lockfile (operator token), cat brain.lock ⇒ non-zero", () => {
    const result = runSandboxed(profile, ["/bin/cat", lockfile]);
    expect(result.ok).toBe(false);
    expect(result.stdout).not.toContain("OPERATOR-SECRET");
  });

  it("ALLOWS reading a workspace file (positive control)", () => {
    const result = runSandboxed(profile, ["/bin/cat", wsFile]);
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("workspace-visible");
  });

  it("ALLOWS reading the vendor's OWN config outside the data dir (positive control)", () => {
    const result = runSandboxed(profile, ["/bin/cat", vendorConfig]);
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("vendor-owned-auth");
  });

  it("ALLOWS writing under the workspace", () => {
    const target = path.join(workspace, "out.txt");
    const result = runSandboxed(profile, [
      "/bin/sh",
      "-c",
      `printf ok > ${target}`,
    ]);
    expect(result.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it("DENIES writing outside the workspace (echo x > ~/outside.txt ⇒ denied)", () => {
    const result = runSandboxed(profile, [
      "/bin/sh",
      "-c",
      `printf x > ${outsideWrite}`,
    ]);
    expect(result.ok).toBe(false);
    expect(existsSync(outsideWrite)).toBe(false);
  });

  it("A2 runner posture (no writeRoots) still blinds the data dir", () => {
    const runnerProfile = buildSeatbeltProfile({ dataDir });
    const denied = runSandboxed(runnerProfile, ["/bin/cat", lockfile]);
    expect(denied.ok).toBe(false);
    // ...but the runner may still write its many task workspaces.
    const allowedWrite = runSandboxed(runnerProfile, [
      "/bin/sh",
      "-c",
      `printf ok > ${path.join(workspace, "runner-write.txt")}`,
    ]);
    expect(allowedWrite.ok).toBe(true);
  });

  it("selectSandboxLauncher yields a working Seatbelt wrap on macOS", () => {
    const launcher = selectSandboxLauncher(process.env);
    expect(launcher.isAvailable()).toBe(true);
    const wrapped = launcher.wrap("/bin/cat", [lockfile], { dataDir });
    expect(wrapped.sandboxed).toBe(true);
    expect(wrapped.command).toBe(SANDBOX_EXEC);
    // Executing the wrapped argv directly reproduces the denial.
    let threw = false;
    try {
      execFileSync(wrapped.command, wrapped.args, { stdio: "ignore" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ── Round-3 #9: WHY confinement is off ──────────────────────────────────────
//
// `isAvailable()` collapses three causes into one boolean, and every surface
// downstream inherited the collapse — the capability preflight told EVERY
// unconfined host to "restart MUON to restore sandbox isolation", which is
// false forever on a platform that has no implementation to restore.
describe("describeSandboxAvailability (round-3 #9)", () => {
  it("names the platform as the cause when there is no implementation", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(describeSandboxAvailability({})).toBe("platform-unsupported");
      // Env and binary probes are IRRELEVANT off macOS: reporting either
      // would imply a fix that does not exist on this host.
      expect(describeSandboxAvailability({ MUON_SANDBOX: "0" })).toBe(
        "platform-unsupported"
      );
      expect(sandboxAvailabilityIsPermanent("platform-unsupported")).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("distinguishes the operator's own opt-out, which IS reversible", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(describeSandboxAvailability({ MUON_SANDBOX: "0" })).toBe(
        "disabled-by-env"
      );
      expect(sandboxAvailabilityIsPermanent("disabled-by-env")).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("reports availability honestly on this host, whatever it is", () => {
    const availability = describeSandboxAvailability({});
    expect([
      "available",
      "platform-unsupported",
      "disabled-by-env",
      "sandbox-exec-missing",
    ]).toContain(availability);
    // The claim under test is the AGREEMENT, not the value: whatever the
    // describer says, the launcher selection must match it.
    const launcherConfined = selectSandboxLauncher({}).isAvailable();
    expect(launcherConfined).toBe(availability === "available");
  });
});
