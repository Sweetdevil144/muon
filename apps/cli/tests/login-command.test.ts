import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  identityCredentialFilePath,
  identityGateSatisfied,
  installRegistrationPending,
  readIdentityCredential,
  resolveInstallRegistryBase,
  InstallRegistryError,
  type RegisterInstallInput,
} from "@muon/client/github-identity-gate";
import {
  POLL_DEFAULT_INTERVAL_MS,
  POLL_MAX_INTERVAL_MS,
  POLL_MAX_LIFETIME_MS,
  POLL_MIN_INTERVAL_MS,
  clampPollInterval,
  pollDeadline,
  registerLoginCommands,
} from "../src/commands/login.js";
import type { MuonApiClient } from "../src/lib/api-client.js";

/**
 * ADR-0052 — `muon login` end to end, with the REAL credential store and the
 * real registry client seam. The brain and GitHub are the only fakes, because
 * they are the only things this command does not own.
 */

const GRANT = {
  token: "d".repeat(64),
  issuedAt: "2026-08-17T00:00:00.000Z",
  version: 1,
};

function brain(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    startGitHubDeviceFlow: vi.fn(async () => ({
      flowId: "11111111-1111-4111-8111-111111111111",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      intervalMs: 5_000,
    })),
    pollGitHubDeviceFlow: vi.fn(async () => ({
      status: "connected" as const,
      login: "octocat",
      credential: { accessToken: "gho_real_device_flow_token" },
    })),
    ...overrides,
  } as unknown as MuonApiClient;
}

describe("muon login", () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-login-"));
    process.env.MUON_DATA_DIR = dir;
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MUON_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  function harness(
    client: MuonApiClient,
    registerInstall: (input: RegisterInstallInput) => Promise<unknown>
  ) {
    const program = new Command();
    program.exitOverride();
    registerLoginCommands(program, () => client, {
      registerInstall: registerInstall as never,
      readVersion: async () => "0.4.1",
      platform: () => "darwin-arm64",
      registryBase: () => "https://registry.example.com",
      sleep: async () => undefined,
    });
    return program;
  }

  it("persists the identity the REGISTRY verified, not the one the poll claimed", async () => {
    const seen: RegisterInstallInput[] = [];
    const program = harness(brain(), async (input) => {
      seen.push(input);
      // The registry read a DIFFERENT login than the device flow reported. The
      // service's answer is the one that must land on disk — a claimed login is
      // never trusted (ADR-0052 Decision 4).
      return { github: { login: "verified-octocat", id: 583231 }, grant: GRANT };
    });

    await program.parseAsync(["node", "muon", "login"]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      surface: "cli",
      version: "0.4.1",
      platform: "darwin-arm64",
      token: "gho_real_device_flow_token",
      baseUrl: "https://registry.example.com",
    });

    const read = readIdentityCredential(dir);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.credential.github).toEqual({
        login: "verified-octocat",
        id: 583231,
      });
      expect(read.credential.token).toBe("gho_real_device_flow_token");
      expect(read.credential.grant).toEqual(GRANT);
    }
    expect(identityGateSatisfied(dir)).toBe(true);
    expect(fs.statSync(identityCredentialFilePath(dir)).mode & 0o777).toBe(0o600);
    expect(stdout.join("")).toContain("signed in as verified-octocat");
  });

  it("discloses what registration records BEFORE opening the browser", async () => {
    const program = harness(brain(), async () => ({
      github: { login: "octocat", id: 1 },
      grant: GRANT,
    }));
    await program.parseAsync(["node", "muon", "login"]);
    const output = stderr.join("");
    const disclosureAt = output.indexOf("records this install");
    const codeAt = output.indexOf("ABCD-1234");
    expect(disclosureAt).toBeGreaterThan(-1);
    expect(codeAt).toBeGreaterThan(-1);
    expect(disclosureAt).toBeLessThan(codeAt);
  });

  it("never prints the access token or the grant HMAC", async () => {
    const program = harness(brain(), async () => ({
      github: { login: "octocat", id: 1 },
      grant: GRANT,
    }));
    await program.parseAsync(["node", "muon", "login", "--json"]);
    const output = [...stdout, ...stderr].join("");
    expect(output).not.toContain("gho_real_device_flow_token");
    expect(output).not.toContain(GRANT.token);
    expect(JSON.parse(stdout.join("")).login).toEqual({
      github: { login: "octocat", id: 1 },
      surface: "cli",
      version: "0.4.1",
      registered: true,
    });
  });

  it("records WHAT it registered as, so a later version re-registers", async () => {
    // F5 — without this the record went stale silently: `surface` stayed `cli`
    // after the desktop ran, and an updated install never re-registered.
    const program = harness(brain(), async () => ({
      github: { login: "octocat", id: 1 },
      grant: GRANT,
    }));
    await program.parseAsync(["node", "muon", "login"]);
    const read = readIdentityCredential(dir);
    expect(read.ok && read.credential.registered).toEqual({
      surface: "cli",
      version: "0.4.1",
    });
  });

  it("an unreachable registry leaves the gate CLOSED and says which half failed", async () => {
    const program = harness(brain(), async () => {
      throw new InstallRegistryError("unreachable", "registry unreachable (test)");
    });

    await program.parseAsync(["node", "muon", "login"]);

    expect(process.exitCode).toBe(1);
    expect(identityGateSatisfied(dir)).toBe(false);
    expect(readIdentityCredential(dir)).toEqual({ ok: false, reason: "absent" });
    const output = stderr.join("");
    expect(output).toContain("registry unreachable (test)");
    expect(output).toContain("MUON stays locked");
    // F3 — and it LEAVES A MARK, so the next `muon dispatch` on this machine
    // says "MUON is retrying" instead of telling them to run the command they
    // just ran. No identity and no token in it.
    expect(installRegistrationPending(dir)).toBe(true);
  });

  it("a credential that will not read back is NOT reported as a successful sign-in", async () => {
    // THE CLOCK-SKEW LIE, end to end through the REAL writer and the REAL
    // reader. On a machine whose clock disagrees with the registry's, the grant's
    // `issuedAt` reads as the future — so the credential persisted, this command
    // printed "registered and unlocked", and the very next command reported
    // LOCKED forever with nothing on screen joining the two facts.
    const program = harness(brain(), async () => ({
      github: { login: "octocat", id: 1 },
      grant: { ...GRANT, issuedAt: new Date(Date.now() + 86_400_000).toISOString() },
    }));

    await program.parseAsync(["node", "muon", "login"]);

    expect(process.exitCode).toBe(1);
    // The success line is the whole defect: it must not be on screen.
    expect(stdout.join("")).not.toContain("unlocked");
    expect(stdout.join("")).not.toContain("signed in as");
    // And the gate really is closed, which is what makes the old copy a lie.
    expect(identityGateSatisfied(dir)).toBe(false);
    const output = stderr.join("");
    // What happened, the likely cause, and the remedy.
    expect(output).toContain("cannot read it back");
    expect(output).toContain("CLOCK DISAGREEMENT");
    expect(output).toContain("automatic date & time");
    expect(output).toContain("MUON stays locked");
    // Honest about which half survived: the registration DID land.
    expect(output).toContain("IS registered");
  });

  it("the same failure is not hidden behind --json either", async () => {
    const program = harness(brain(), async () => ({
      github: { login: "octocat", id: 1 },
      grant: { ...GRANT, issuedAt: new Date(Date.now() + 86_400_000).toISOString() },
    }));

    await program.parseAsync(["node", "muon", "login", "--json"]);

    expect(process.exitCode).toBe(1);
    // A script reading stdout must not find a `registered: true` envelope for a
    // sign-in that left this machine locked.
    expect(stdout.join("")).toBe("");
  });

  it("refuses a registry destination it will not send a token to, BEFORE the device flow", async () => {
    // F4 — `MUON_INSTALL_REGISTRY` decides where an access token is POSTed, and
    // the consent sentence names it. A destination this build refuses has to
    // refuse before the browser opens, not after the token exists.
    const client = brain();
    const program = new Command();
    program.exitOverride();
    registerLoginCommands(program, () => client, {
      registerInstall: (async () => {
        throw new Error("must never be reached");
      }) as never,
      readVersion: async () => "0.4.1",
      platform: () => "darwin-arm64",
      // The real resolver, against a hostile override.
      registryBase: () =>
        resolveInstallRegistryBase({
          MUON_INSTALL_REGISTRY: "http://attacker.example",
        }),
      sleep: async () => undefined,
    });

    await program.parseAsync(["node", "muon", "login"]);

    expect(process.exitCode).toBe(1);
    expect(client.startGitHubDeviceFlow).not.toHaveBeenCalled();
    expect([...stdout, ...stderr].join("")).toContain("must be https:");
  });

  it("the disclosure names the destination the token actually goes to", async () => {
    const program = new Command();
    program.exitOverride();
    registerLoginCommands(program, () => brain(), {
      registerInstall: (async () => ({
        github: { login: "octocat", id: 1 },
        grant: GRANT,
      })) as never,
      readVersion: async () => "0.4.1",
      platform: () => "darwin-arm64",
      registryBase: () => "https://registry.staging.example/",
      sleep: async () => undefined,
    });
    await program.parseAsync(["node", "muon", "login"]);
    expect(stderr.join("")).toContain(
      "records this install with the MUON project at https://registry.staging.example"
    );
  });

  it("a denied device flow never reaches the registry", async () => {
    const registerInstall = vi.fn();
    const program = harness(
      brain({
        pollGitHubDeviceFlow: vi.fn(async () => ({
          status: "denied" as const,
          message: "GitHub authorization was canceled.",
        })),
      }),
      registerInstall as never
    );

    await program.parseAsync(["node", "muon", "login"]);

    expect(registerInstall).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(identityGateSatisfied(dir)).toBe(false);
  });

  it("keeps polling through a transient brain failure", async () => {
    let calls = 0;
    const program = harness(
      brain({
        pollGitHubDeviceFlow: vi.fn(async () => {
          calls += 1;
          if (calls === 1) throw new Error("fetch failed");
          if (calls === 2) return { status: "pending" as const, retryAfterMs: 5_000 };
          return {
            status: "connected" as const,
            login: "octocat",
            credential: { accessToken: "gho_real_device_flow_token" },
          };
        }),
      }),
      async () => ({ github: { login: "octocat", id: 1 }, grant: GRANT })
    );

    await program.parseAsync(["node", "muon", "login"]);

    expect(calls).toBe(3);
    expect(identityGateSatisfied(dir)).toBe(true);
  });
});

/**
 * The poll loop's bounds. Both were missing, and neither needs a hostile server
 * to bite — a clock skew or a schema change is enough.
 */
describe("the device-flow poll loop is bounded by THIS machine", () => {
  let dir: string;
  let stdout: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-poll-"));
    process.env.MUON_DATA_DIR = dir;
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MUON_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("clamps the interval at both ends, NaN-safe", () => {
    expect(clampPollInterval(5_000)).toBe(5_000);
    // A 0 made this a tight loop hammering GitHub through the local brain.
    expect(clampPollInterval(0)).toBe(POLL_MIN_INTERVAL_MS);
    expect(clampPollInterval(-1)).toBe(POLL_MIN_INTERVAL_MS);
    expect(clampPollInterval(9_999_999)).toBe(POLL_MAX_INTERVAL_MS);
    for (const junk of [Number.NaN, undefined, null, "soon", {}]) {
      expect(clampPollInterval(junk), String(junk)).toBe(
        POLL_DEFAULT_INTERVAL_MS
      );
    }
  });

  it("an UNPARSEABLE expiresAt falls back to the hard cap, never to 'forever'", () => {
    // This was the bug: `Number.isFinite(deadline) && now() > deadline` skipped
    // the expiry check entirely when `Date.parse` returned NaN, leaving a
    // `for(;;)` with no exit but ctrl-c.
    const now = 1_700_000_000_000;
    for (const bad of ["not-a-date", "", undefined, null, 12345]) {
      expect(pollDeadline(bad, now), String(bad)).toBe(
        now + POLL_MAX_LIFETIME_MS
      );
    }
  });

  it("honours a real expiresAt, and truncates one beyond the cap", () => {
    const now = 1_700_000_000_000;
    const soon = new Date(now + 60_000).toISOString();
    expect(pollDeadline(soon, now)).toBe(now + 60_000);
    const absurd = new Date(now + 86_400_000).toISOString();
    expect(pollDeadline(absurd, now)).toBe(now + POLL_MAX_LIFETIME_MS);
  });

  it("STOPS on an unparseable expiresAt instead of polling forever", async () => {
    // The behavioural half: a brain reporting junk expiry, a poll that never
    // resolves to connected, and a fake clock that walks past the cap. Before the
    // fix this test would not terminate.
    let clock = 1_700_000_000_000;
    let polls = 0;
    const program = new Command();
    program.exitOverride();
    registerLoginCommands(
      program,
      () =>
        ({
          startGitHubDeviceFlow: vi.fn(async () => ({
            flowId: "11111111-1111-4111-8111-111111111111",
            userCode: "ABCD-1234",
            verificationUri: "https://github.com/login/device",
            expiresAt: "whenever",
            intervalMs: 0,
          })),
          pollGitHubDeviceFlow: vi.fn(async () => {
            polls += 1;
            return { status: "pending" as const, retryAfterMs: 0 };
          }),
        }) as unknown as MuonApiClient,
      {
        registerInstall: (async () => {
          throw new Error("must never be reached");
        }) as never,
        readVersion: async () => "0.4.1",
        platform: () => "darwin-arm64",
        registryBase: () => "https://registry.example.com",
        // Every sleep advances the fake clock by what the loop asked for, so the
        // clamp is what decides how many polls fit inside the cap.
        sleep: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
      }
    );

    await program.parseAsync(["node", "muon", "login"]);

    expect(process.exitCode).toBe(1);
    expect(stdout.join("")).toContain("expired before authorization completed");
    // Bounded: 15 minutes at a clamped 1s floor is ~900 polls, not infinite.
    expect(polls).toBeGreaterThan(0);
    expect(polls).toBeLessThanOrEqual(POLL_MAX_LIFETIME_MS / POLL_MIN_INTERVAL_MS + 2);
  });
});

describe("muon logout", () => {
  let dir: string;
  let stdout: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-logout-"));
    process.env.MUON_DATA_DIR = dir;
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MUON_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("clears the credential and re-locks", async () => {
    const program = new Command();
    program.exitOverride();
    registerLoginCommands(program, () => brain(), {
      registerInstall: (async () => ({
        github: { login: "octocat", id: 1 },
        grant: GRANT,
      })) as never,
      readVersion: async () => "0.4.1",
      platform: () => "darwin-arm64",
      registryBase: () => "https://registry.example.com",
      sleep: async () => undefined,
    });

    await program.parseAsync(["node", "muon", "login"]);
    expect(identityGateSatisfied(dir)).toBe(true);

    stdout.length = 0;
    await program.parseAsync(["node", "muon", "logout"]);
    expect(identityGateSatisfied(dir)).toBe(false);
    expect(stdout.join("")).toContain("signed out (was octocat)");
  });

  it("says WHICH surfaces re-lock, and that the desktop is not one of them", async () => {
    // F9 — the copy said only "a distributed install re-locks", which left an
    // operator reasonably believing the app had signed out too. It has not: the
    // desktop keeps its own GitHub connection in its own settings file.
    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
    const program = new Command();
    program.exitOverride();
    registerLoginCommands(program, () => brain());
    await program.parseAsync(["node", "muon", "logout"]);
    const output = stderrLines.join("");
    expect(output).toContain("re-locks the CLI and `muon-mcp`");
    expect(output).toContain("desktop app keeps its own GitHub connection");
    expect(output).toContain("Settings");
    // And still honest about the record it does not withdraw.
    expect(output).toContain("not withdrawn by this");
  });

  it("is honest when there was nothing to remove", async () => {
    const program = new Command();
    program.exitOverride();
    registerLoginCommands(program, () => brain());
    await program.parseAsync(["node", "muon", "logout"]);
    expect(stdout.join("")).toContain("not signed in");
  });
});
