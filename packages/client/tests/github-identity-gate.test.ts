import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACCEPTED_GRANT_VERSIONS,
  GATE_SURFACES,
  REGISTRATION_RETRY_BY_SURFACE,
  registerInstallWithRetry,
  type GateSurface,
  IDENTITY_GATE_STATES,
  INSTALL_REGISTRY_BODY_FIELDS,
  INSTALL_REGISTRY_DEFAULT,
  INSTALL_SURFACES,
  INSTALL_SURFACE_FOR_GATE,
  IdentityCredentialWriteError,
  InstallRegistryError,
  clearIdentityCredential,
  clearInstallRegistrationPending,
  defaultInstallPlatform,
  githubIdentityDeferredRefusal,
  githubIdentityGateDoorMissing,
  githubIdentityGateMisconfigured,
  githubIdentityGateRefusal,
  githubIdentityGateRequired,
  identityCredentialFilePath,
  identityGateRefusalFor,
  identityGateSatisfied,
  identityGateStateOf,
  installNeedsReregistration,
  installRecordDisclosure,
  installRegistrationPending,
  installRegistryOrigin,
  isIdentityGateState,
  markInstallRegistrationPending,
  readDistributionBake,
  readIdentityCredential,
  registerInstall,
  resolveGateArming,
  resolveInstallRegistryBase,
  writeIdentityCredential,
} from "../src/github-identity-gate.js";

const CLIENT_ID = { MUON_GITHUB_CLIENT_ID: "Iv1.abcdef1234567890" };
const GRANT = {
  token: "a".repeat(64),
  issuedAt: "2026-08-17T00:00:00.000Z",
  version: 1,
};

describe("githubIdentityGateRequired (ADR-0052 arming)", () => {
  it("is OFF in a dev checkout — no bake, nothing arms", () => {
    expect(
      githubIdentityGateRequired({ env: {}, distributed: false })
    ).toBe(false);
    expect(
      githubIdentityGateRequired({ env: { ...CLIENT_ID }, distributed: false })
    ).toBe(false);
  });

  it("is ON in a distributed build WITH a client id", () => {
    expect(
      githubIdentityGateRequired({ env: { ...CLIENT_ID }, distributed: true })
    ).toBe(true);
    // The bake is an equally good source as the environment.
    expect(
      githubIdentityGateRequired({
        env: {},
        distributed: true,
        clientId: "Iv1.abcdef1234567890",
      })
    ).toBe(true);
  });

  it("a distributed build with NO client id degrades UNGATED and reports the release defect", () => {
    expect(githubIdentityGateRequired({ env: {}, distributed: true })).toBe(
      false
    );
    expect(githubIdentityGateMisconfigured({ env: {}, distributed: true })).toBe(
      true
    );
    expect(
      githubIdentityGateMisconfigured({
        env: { ...CLIENT_ID },
        distributed: true,
      })
    ).toBe(false);
    // An explicit choice is never a mistake.
    expect(
      githubIdentityGateMisconfigured({
        env: { MUON_REQUIRE_GITHUB_LOGIN: "1" },
        distributed: true,
      })
    ).toBe(false);
  });

  it("MUON_REQUIRE_GITHUB_LOGIN arms anywhere, in every accepted spelling", () => {
    for (const spelling of ["1", "true", "on", " TRUE "]) {
      expect(
        githubIdentityGateRequired({
          env: { MUON_REQUIRE_GITHUB_LOGIN: spelling },
          distributed: false,
        }),
        spelling
      ).toBe(true);
    }
  });

  it("MUON_REQUIRE_GITHUB_LOGIN=0/false/off is the distributed escape hatch", () => {
    for (const spelling of ["0", "false", "off"]) {
      expect(
        githubIdentityGateRequired({
          env: { MUON_REQUIRE_GITHUB_LOGIN: spelling, ...CLIENT_ID },
          distributed: true,
        }),
        spelling
      ).toBe(false);
    }
  });
});

describe("readDistributionBake", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-bake-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const at = (file: string) => `file://${path.join(dir, file)}`;

  it("reads as NOT distributed when no manifest carries the bake", () => {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@muon/cli", version: "0.4.1" })
    );
    expect(readDistributionBake(at("index.js"))).toEqual({
      distributed: false,
    });
  });

  it("reads the bake and the baked client id from a release manifest", () => {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "muon-cli",
        muonDistributed: true,
        muonGitHubClientId: "Iv1.abcdef1234567890",
      })
    );
    expect(readDistributionBake(at("muon.mjs"))).toEqual({
      distributed: true,
      clientId: "Iv1.abcdef1234567890",
    });
  });

  it("only a literal true arms — a stringified flag does not", () => {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "muon-cli", muonDistributed: "false" })
    );
    expect(readDistributionBake(at("muon.mjs")).distributed).toBe(false);
  });

  it("survives a missing manifest without throwing", () => {
    expect(readDistributionBake(at("muon.mjs"))).toEqual({
      distributed: false,
    });
  });
});

/**
 * The bake-read PLUS the republish, in one step both distributed surfaces call.
 *
 * The CLI republished the baked client id into the environment so the brain it
 * spawns can run the device flow; the TUI read the same bake and did not, so a
 * desk-spawned brain had no client id and `muon login` from a locked desk had
 * nothing to run. The step is shared now, and these are the properties both
 * surfaces inherit from it.
 */
describe("resolveGateArming", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-arming-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const bakeAt = (manifest: Record<string, unknown>): string => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
    return `file://${path.join(dir, "muon.mjs")}`;
  };

  it("republishes the baked client id into the env it was handed", () => {
    const env: Record<string, string | undefined> = {};
    const arming = resolveGateArming(
      env,
      bakeAt({
        name: "muon-cli",
        muonDistributed: true,
        muonGitHubClientId: "Iv1.baked1234567890",
      })
    );
    // The env the surface will hand its child process now carries the id.
    expect(env.MUON_GITHUB_CLIENT_ID).toBe("Iv1.baked1234567890");
    expect(arming).toEqual({
      env,
      distributed: true,
      clientId: "Iv1.baked1234567890",
    });
    expect(githubIdentityGateRequired(arming)).toBe(true);
  });

  it("never overrides an id the operator already chose", () => {
    const env: Record<string, string | undefined> = {
      MUON_GITHUB_CLIENT_ID: "Iv1.operators1234567",
    };
    resolveGateArming(
      env,
      bakeAt({
        name: "muon-cli",
        muonDistributed: true,
        muonGitHubClientId: "Iv1.baked1234567890",
      })
    );
    expect(env.MUON_GITHUB_CLIENT_ID).toBe("Iv1.operators1234567");
  });

  it("a dev checkout publishes nothing and arms nothing", () => {
    const env: Record<string, string | undefined> = {};
    const arming = resolveGateArming(env, bakeAt({ name: "@muon/tui" }));
    expect(env.MUON_GITHUB_CLIENT_ID).toBeUndefined();
    expect(arming).toEqual({ env, distributed: false });
    expect(githubIdentityGateRequired(arming)).toBe(false);
  });
});

describe("the credential store", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-identity-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("absent is a distinct answer from unreadable", () => {
    expect(readIdentityCredential(dir)).toEqual({
      ok: false,
      reason: "absent",
    });
    expect(identityGateSatisfied(dir)).toBe(false);
  });

  it("round-trips at 0600 and satisfies the gate", () => {
    writeIdentityCredential(
      { github: { login: "octocat", id: 583231 }, token: "gho_" + "x".repeat(20), grant: GRANT },
      dir
    );
    const mode = fs.statSync(identityCredentialFilePath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
    const read = readIdentityCredential(dir);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.credential.github).toEqual({ login: "octocat", id: 583231 });
      expect(read.credential.grant.version).toBe(1);
    }
    expect(identityGateSatisfied(dir)).toBe(true);
    expect(clearIdentityCredential(dir)).toEqual({ ok: true, removed: true });
    expect(identityGateSatisfied(dir)).toBe(false);
  });

  it("a FORGED grant token shape re-gates", () => {
    writeIdentityCredential(
      { github: { login: "octocat", id: 1 }, token: "gho_" + "x".repeat(20), grant: GRANT },
      dir
    );
    const file = identityCredentialFilePath(dir);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.grant.token = "not-an-hmac";
    fs.writeFileSync(file, JSON.stringify(stored));
    expect(identityGateSatisfied(dir)).toBe(false);
    expect(readIdentityCredential(dir)).toMatchObject({ reason: "unreadable" });
  });

  it("an UNKNOWN grant version re-gates (the revocation hook)", () => {
    writeIdentityCredential(
      { github: { login: "octocat", id: 1 }, token: "gho_" + "x".repeat(20), grant: GRANT },
      dir
    );
    const file = identityCredentialFilePath(dir);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.grant.version = 99;
    fs.writeFileSync(file, JSON.stringify(stored));
    expect(ACCEPTED_GRANT_VERSIONS.has(99)).toBe(false);
    expect(identityGateSatisfied(dir)).toBe(false);
  });

  it("a grant issued in the FUTURE re-gates, and the WRITER says so", () => {
    // THE CLOCK-SKEW LIE. The writer persisted and reported nothing, so on a
    // machine whose clock disagrees with the registry's `muon login` printed
    // "registered and unlocked" and the very next command reported LOCKED —
    // permanently, with nothing on screen joining the two facts. The round-trip
    // is verified through the same reader now, so the write is the thing that
    // fails.
    let thrown: unknown;
    try {
      writeIdentityCredential(
        {
          github: { login: "octocat", id: 1 },
          token: "gho_" + "x".repeat(20),
          grant: {
            ...GRANT,
            issuedAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
        dir
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IdentityCredentialWriteError);
    const message = thrown instanceof Error ? thrown.message : "";
    // What happened, the likely cause, and the remedy — a caller printing this
    // message alone has to be enough.
    expect(message).toContain("cannot read it back");
    expect(message).toContain("CLOCK DISAGREEMENT");
    expect(message).toContain("muon login");
    // The file is left in place on purpose: it becomes readable by itself once
    // the clocks agree, with no second sign-in.
    expect(fs.existsSync(identityCredentialFilePath(dir))).toBe(true);
    expect(identityGateSatisfied(dir)).toBe(false);
    // `locked`, never `locked-unregistered`: the registration is not what
    // failed, so "MUON is retrying" would be the wrong story.
    expect(identityGateStateOf(dir)).toBe("locked");
    expect(installRegistrationPending(dir)).toBe(false);
  });

  it("a good write returns the credential it can actually read back", () => {
    // The verification is not a side channel: the value handed back is the one
    // that came off the disk, so a caller that trusts it is trusting the same
    // bytes the next command will read.
    const written = writeIdentityCredential(
      {
        github: { login: "octocat", id: 583231 },
        token: "gho_" + "x".repeat(20),
        grant: GRANT,
        registered: { surface: "cli", version: "0.4.2" },
      },
      dir
    );
    const read = readIdentityCredential(dir);
    expect(read.ok).toBe(true);
    if (read.ok) expect(written).toEqual(read.credential);
  });

  it("a grant version this build does not accept fails the WRITE, not the next command", () => {
    // The other round-trip gap, and the reason the check is the reader rather
    // than the schema: `identityCredentialSchema` accepts any positive version,
    // and `ACCEPTED_GRANT_VERSIONS` is what actually decides.
    expect(() =>
      writeIdentityCredential(
        {
          github: { login: "octocat", id: 1 },
          token: "gho_" + "x".repeat(20),
          grant: { ...GRANT, version: 42 },
        },
        dir
      )
    ).toThrow(IdentityCredentialWriteError);
    expect(identityGateSatisfied(dir)).toBe(false);
  });

  it("logout distinguishes 'nothing was there' from 'could not remove'", () => {
    // The failure this shape exists to stop: `clearIdentityCredential` returned a
    // boolean, and `false` meant BOTH. So a read-only data dir made `muon logout`
    // print "not signed in — nothing to remove" while the credential, access
    // token included, sat exactly where it was — the one command whose whole job
    // is to invalidate a credential reporting success for doing nothing.
    expect(clearIdentityCredential(dir)).toEqual({ ok: true, removed: false });

    writeIdentityCredential(
      { github: { login: "octocat", id: 1 }, token: `gho_${"x".repeat(20)}`, grant: GRANT },
      dir
    );
    const original = fs.statSync(dir).mode;
    // 0o500 — traversable and readable, NOT writable, so `unlink` fails with
    // EACCES while the file itself is still perfectly readable.
    fs.chmodSync(dir, 0o500);
    try {
      const result = clearIdentityCredential(dir);
      // Root ignores directory permissions; skip rather than assert a falsehood
      // about the environment.
      if (identityGateSatisfied(dir)) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.detail).toContain("could not be removed");
          expect(result.detail).toContain("still signed in");
        }
      }
    } finally {
      fs.chmodSync(dir, original);
    }
  });

  it("a credential with NO grant re-gates — half of the pair proves nothing", () => {
    const file = identityCredentialFilePath(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        github: { login: "octocat", id: 1 },
        token: "gho_" + "x".repeat(20),
        createdAt: new Date().toISOString(),
      })
    );
    expect(identityGateSatisfied(dir)).toBe(false);
  });
});

describe("registerInstall", () => {
  it("sends EXACTLY the decided record and nothing else", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(
        JSON.stringify({
          github: { login: "octocat", id: 583231 },
          grant: GRANT,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const result = await registerInstall({
      baseUrl: "https://registry.example.com/",
      token: "gho_secret_token_value",
      surface: "cli",
      version: "0.4.1",
      platform: "darwin-arm64",
      fetcher,
    });

    expect(result.github).toEqual({ login: "octocat", id: 583231 });
    expect(seen?.url).toBe("https://registry.example.com/v1/installs");
    const body = JSON.parse(String(seen?.init.body));
    // The exhaustive-field assertion: anything a future edit adds shows up here
    // before it reaches the network.
    expect(Object.keys(body).sort()).toEqual(
      [...INSTALL_REGISTRY_BODY_FIELDS].sort()
    );
    expect(body).toEqual({
      surface: "cli",
      version: "0.4.1",
      platform: "darwin-arm64",
    });
    // The token rides the header, never the body.
    expect(String(seen?.init.body)).not.toContain("gho_secret_token_value");
    expect(
      (seen?.init.headers as Record<string, string>).Authorization
    ).toBe("Bearer gho_secret_token_value");
  });

  it("maps an unverified token to `unauthorized`", async () => {
    const fetcher = (async () =>
      new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(
      registerInstall({
        baseUrl: "https://registry.example.com",
        token: "bad",
        surface: "cli",
        version: "0.4.1",
        platform: "linux-x64",
        fetcher,
      })
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("maps a transport failure to `unreachable`", async () => {
    const fetcher = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const error = await registerInstall({
      baseUrl: "https://registry.example.com",
      token: "gho_x",
      surface: "cli",
      version: "0.4.1",
      platform: "linux-x64",
      fetcher,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(InstallRegistryError);
    expect(error.code).toBe("unreachable");
  });

  it("refuses a grant whose version this build does not accept", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          github: { login: "octocat", id: 1 },
          grant: { ...GRANT, version: 7 },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    await expect(
      registerInstall({
        baseUrl: "https://registry.example.com",
        token: "gho_x",
        surface: "cli",
        version: "0.4.1",
        platform: "linux-x64",
        fetcher,
      })
    ).rejects.toMatchObject({ code: "unreadable" });
  });
});

describe("registry base + refusal copy", () => {
  it("defaults to the constant and honours the env override", () => {
    expect(resolveInstallRegistryBase({})).toBe(INSTALL_REGISTRY_DEFAULT);
    expect(
      resolveInstallRegistryBase({
        MUON_INSTALL_REGISTRY: "http://127.0.0.1:9099/",
      })
    ).toBe("http://127.0.0.1:9099");
  });

  it("names what is gated, the door, and the disclosure", () => {
    const copy = githubIdentityGateRefusal({
      what: "muon dispatch",
      surface: "cli",
      stillAvailable: ["muon --version", "muon mcp status"],
    });
    expect(copy).toContain("muon dispatch");
    expect(copy).toContain("muon login");
    expect(copy).toContain("records this install");
    expect(copy).toContain("(cli)");
    expect(copy).toContain("muon mcp status");
  });

  it("reports a platform without leaking anything else about the machine", () => {
    expect(defaultInstallPlatform()).toBe(
      `${process.platform}-${process.arch}`
    );
  });
});

/**
 * F4 — `MUON_INSTALL_REGISTRY` decides where a GitHub ACCESS TOKEN is POSTed,
 * and it was interpolated into a `fetch` with no validation at all. Two things
 * had to become true: the destination has to be one this build will send a
 * credential to, and the consent sentence has to name it.
 */
describe("the registry destination is validated before a token goes to it", () => {
  it("accepts https anywhere", () => {
    expect(
      resolveInstallRegistryBase({
        MUON_INSTALL_REGISTRY: "https://registry.example.com/",
      })
    ).toBe("https://registry.example.com");
    expect(resolveInstallRegistryBase({})).toBe(INSTALL_REGISTRY_DEFAULT);
  });

  it("accepts plain http ONLY on loopback, where there is no wire", () => {
    for (const host of ["127.0.0.1:9099", "localhost:9099"]) {
      expect(
        resolveInstallRegistryBase({
          MUON_INSTALL_REGISTRY: `http://${host}/`,
        }),
        host
      ).toBe(`http://${host}`);
    }
  });

  it("REFUSES cleartext to any other host, with a typed refusal", () => {
    for (const url of [
      "http://attacker.example",
      "http://registry.getmuon.com",
      "http://192.168.1.10:9099",
    ]) {
      const error = (() => {
        try {
          resolveInstallRegistryBase({ MUON_INSTALL_REGISTRY: url });
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error, url).toBeInstanceOf(InstallRegistryError);
      expect((error as InstallRegistryError).code, url).toBe("misconfigured");
      // Never a dead end: the refusal names the way out.
      expect((error as Error).message).toContain(INSTALL_REGISTRY_DEFAULT);
    }
  });

  it("refuses a non-URL rather than silently falling back", () => {
    // A silent fallback would send the token somewhere the operator did not
    // configure — the same class of surprise in the other direction.
    expect(() =>
      resolveInstallRegistryBase({ MUON_INSTALL_REGISTRY: "registry.example" })
    ).toThrow(InstallRegistryError);
  });

  it("also refuses a non-http scheme outright", () => {
    for (const url of ["ftp://registry.example", "file:///etc/passwd"]) {
      expect(() =>
        resolveInstallRegistryBase({ MUON_INSTALL_REGISTRY: url }),
        url
      ).toThrow(InstallRegistryError);
    }
  });

  it("the disclosure names the DESTINATION, so consent matches where bytes go", () => {
    expect(
      installRecordDisclosure({
        surface: "cli",
        registry: "https://registry.staging.example",
      })
    ).toContain("https://registry.staging.example");
    expect(
      installRegistryOrigin({
        MUON_INSTALL_REGISTRY: "https://registry.staging.example/v1",
      })
    ).toBe("https://registry.staging.example");
    // A destination this build refuses is named VERBATIM rather than replaced by
    // the default: the configured value is the fact worth seeing.
    expect(
      installRegistryOrigin({ MUON_INSTALL_REGISTRY: "http://attacker.example" })
    ).toBe("http://attacker.example");
  });

  it("maps a 429 to `rate_limited`, which is not `refused`", async () => {
    const fetcher = (async () =>
      new Response("{}", { status: 429 })) as unknown as typeof fetch;
    const error = await registerInstall({
      baseUrl: "https://registry.example.com",
      token: "gho_x",
      surface: "cli",
      version: "0.4.1",
      platform: "linux-x64",
      fetcher,
    }).catch((caught) => caught);
    expect(error.code).toBe("rate_limited");
    // A human reading this must not be sent to re-run a correct sign-in.
    expect(error.message).toContain("Try again in a minute");
    expect(error.message).toContain("nothing about this sign-in is wrong");
  });

  // The registry now distinguishes "GitHub did not answer me" from "GitHub
  // rejected this token". Collapsed into `refused`, a GitHub outage during a
  // first sign-in told a hard-gated user their identity was bad — a lockout
  // with the wrong remedy, since re-running the sign-in cannot fix GitHub.
  it("maps an upstream failure to `upstream_unavailable`, never to `refused`", async () => {
    for (const status of [502, 503]) {
      const fetcher = (async () =>
        new Response("{}", { status })) as unknown as typeof fetch;
      const error = await registerInstall({
        baseUrl: "https://registry.example.com",
        token: "gho_x",
        surface: "cli",
        version: "0.4.2",
        platform: "linux-x64",
        fetcher,
      }).catch((caught) => caught);
      expect(error.code, String(status)).toBe("upstream_unavailable");
      expect(error.message, String(status)).toContain(
        "Nothing about your sign-in is wrong"
      );
      // The verdict word is what made this a lockout: it reads as a judgement
      // on the caller when no judgement was reached.
      expect(error.message, String(status)).not.toContain("refused");
    }
  });

  it("still says `refused` when the registry really did refuse", async () => {
    const fetcher = (async () =>
      new Response("{}", { status: 400 })) as unknown as typeof fetch;
    const error = await registerInstall({
      baseUrl: "https://registry.example.com",
      token: "gho_x",
      surface: "cli",
      version: "0.4.2",
      platform: "linux-x64",
      fetcher,
    }).catch((caught) => caught);
    expect(error.code).toBe("refused");
  });

  it("keeps a rejected identity distinct from an unreachable upstream", async () => {
    const fetcher = (async () =>
      new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const error = await registerInstall({
      baseUrl: "https://registry.example.com",
      token: "gho_x",
      surface: "cli",
      version: "0.4.2",
      platform: "linux-x64",
      fetcher,
    }).catch((caught) => caught);
    expect(error.code).toBe("unauthorized");
    expect(error.message).toContain("Run the sign-in again");
  });
});

/**
 * F5 — the record went stale silently. The CLI registers first on most
 * machines, so `surface` stayed `cli` forever and an updated install never
 * re-registered its version.
 */
describe("registered surface + version", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-reg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (registered?: { surface: "cli" | "desktop"; version: string }) =>
    writeIdentityCredential(
      {
        github: { login: "octocat", id: 1 },
        token: `gho_${"x".repeat(20)}`,
        grant: GRANT,
        ...(registered ? { registered } : {}),
      },
      dir
    );

  it("persists what the install registered AS, and round-trips it", () => {
    write({ surface: "desktop", version: "0.4.1" });
    const read = readIdentityCredential(dir);
    expect(read.ok && read.credential.registered).toEqual({
      surface: "desktop",
      version: "0.4.1",
    });
  });

  it("re-registers when the SURFACE differs", () => {
    const credential = write({ surface: "cli", version: "0.4.1" });
    expect(
      installNeedsReregistration(credential, {
        surface: "desktop",
        version: "0.4.1",
      })
    ).toBe(true);
  });

  it("re-registers when the VERSION differs", () => {
    const credential = write({ surface: "cli", version: "0.4.1" });
    expect(
      installNeedsReregistration(credential, {
        surface: "cli",
        version: "0.4.2",
      })
    ).toBe(true);
  });

  it("does NOT re-register when both match", () => {
    const credential = write({ surface: "cli", version: "0.4.1" });
    expect(
      installNeedsReregistration(credential, {
        surface: "cli",
        version: "0.4.1",
      })
    ).toBe(false);
  });

  it("a credential from BEFORE the field existed re-registers once, and still opens the gate", () => {
    const credential = write();
    // The important half: an install that is legitimately registered must not
    // RE-GATE over a field it could not have written.
    expect(identityGateSatisfied(dir)).toBe(true);
    expect(
      installNeedsReregistration(credential, {
        surface: "cli",
        version: "0.4.1",
      })
    ).toBe(true);
  });
});

/**
 * F3 — the distinguished deferred state. An offline first sign-in left the
 * desktop working and every other surface saying "Run `muon login`", the one
 * action that had already succeeded.
 */
describe("locked-unregistered", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-deferred-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is a member of the positive wire set, readable across the package boundary", () => {
    expect(IDENTITY_GATE_STATES).toContain("locked-unregistered");
    for (const state of IDENTITY_GATE_STATES) {
      expect(isIdentityGateState(state), state).toBe(true);
    }
    expect(isIdentityGateState("locked_unregistered")).toBe(false);
  });

  it("nothing on disk is plain `locked`, not deferred", () => {
    expect(identityGateStateOf(dir)).toBe("locked");
  });

  it("the marker makes it `locked-unregistered`, and carries NO identity or token", () => {
    expect(markInstallRegistrationPending("desktop", dir)).toBe(true);
    expect(installRegistrationPending(dir)).toBe(true);
    expect(identityGateStateOf(dir)).toBe("locked-unregistered");
    const raw = fs.readFileSync(
      path.join(dir, "github-registration-pending.json"),
      "utf8"
    );
    // The invariant this file exists to protect: `github-identity.json` means
    // "the identity the REGISTRY verified", so the pending state must not smuggle
    // a self-claimed one anywhere.
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      "createdAt",
      "surface",
      "version",
    ]);
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("login");
    expect(fs.statSync(path.join(dir, "github-registration-pending.json")).mode & 0o777).toBe(
      0o600
    );
  });

  it("a landed registration clears the marker — the file WRITE does it", () => {
    markInstallRegistrationPending("cli", dir);
    writeIdentityCredential(
      { github: { login: "octocat", id: 1 }, token: `gho_${"x".repeat(20)}`, grant: GRANT },
      dir
    );
    expect(installRegistrationPending(dir)).toBe(false);
    expect(identityGateStateOf(dir)).toBe("open");
  });

  it("logout clears the marker too — a lock must not keep the wrong reason", () => {
    markInstallRegistrationPending("cli", dir);
    clearIdentityCredential(dir);
    expect(installRegistrationPending(dir)).toBe(false);
    expect(identityGateStateOf(dir)).toBe("locked");
  });

  it("a FORGED credential is `locked`, never `locked-unregistered`", () => {
    // Somebody edited the file, so the remedy really is to sign in again — and
    // the marker must not be able to soften that into "MUON is retrying".
    writeIdentityCredential(
      { github: { login: "octocat", id: 1 }, token: `gho_${"x".repeat(20)}`, grant: GRANT },
      dir
    );
    const file = identityCredentialFilePath(dir);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.grant.token = "not-an-hmac";
    fs.writeFileSync(file, JSON.stringify(stored));
    expect(identityGateStateOf(dir)).toBe("locked");
  });

  it("a malformed marker does not count", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "github-registration-pending.json"),
      JSON.stringify({ version: 1, surface: "mcp", createdAt: "nope" })
    );
    expect(installRegistrationPending(dir)).toBe(false);
    expect(identityGateStateOf(dir)).toBe("locked");
    clearInstallRegistrationPending(dir);
  });

  it("the deferred copy never sends an operator to redo a sign-in that worked", () => {
    for (const surface of GATE_SURFACES) {
      const copy = githubIdentityDeferredRefusal({
        what: "muon dispatch",
        surface,
      });
      // The distinguished state exists so nobody re-runs a working sign-in as
      // if it had failed.
      expect(copy, surface).toContain("verified but not yet registered");
      expect(copy, surface).toContain("the sign-in worked");
      expect(copy, surface).not.toContain("Run `muon login` to open it");
    }
  });

  // The defect this pins: "MUON retries automatically; no action needed" was
  // written for the desktop and rendered on every surface, so a CLI-only or
  // `muon-mcp` user was told to wait for a retry that does not exist there —
  // and the one remedy that does work was framed as a last resort.
  it("promises a retry only where a retry actually exists", () => {
    const deferred = (surface: GateSurface) =>
      githubIdentityDeferredRefusal({ what: "muon dispatch", surface });

    for (const surface of GATE_SURFACES) {
      const copy = deferred(surface);
      if (REGISTRATION_RETRY_BY_SURFACE[surface]) {
        expect(copy, surface).toContain("retries automatically");
        expect(copy, surface).toContain("can clear with no action");
      } else {
        expect(copy, surface).toContain("NOTHING here retries it");
        expect(copy, surface).toContain("`muon login` is what files the record");
        expect(copy, surface).not.toContain("no action");
      }
      // Either way the command that files the record is named, so no surface
      // leaves the reader without a move.
      expect(copy, surface).toContain("muon login");
    }

    // And the two really do differ — a table that said `true` everywhere would
    // pass every assertion above.
    expect(deferred("desktop")).not.toBe(deferred("cli"));
  });

  it("the retry table covers every surface, so a new one cannot default to a promise", () => {
    expect(Object.keys(REGISTRATION_RETRY_BY_SURFACE).sort()).toEqual(
      [...GATE_SURFACES].sort()
    );
    // MEASURED: exactly one retry loop exists in the tree
    // (`startInstallRegistrationRetry`, desktop main, alive only while open).
    // Asserted as a PROPERTY rather than a literal: a literal has to be edited
    // whenever a surface is added, and the edit is exactly the moment somebody
    // would paste `true` to make the test green. This fails instead.
    expect(REGISTRATION_RETRY_BY_SURFACE.desktop).toBe(true);
    for (const surface of GATE_SURFACES) {
      if (surface === "desktop") continue;
      expect(REGISTRATION_RETRY_BY_SURFACE[surface], surface).toBe(false);
    }
  });

  it("ONE selector decides the copy, and refuses nothing when open", () => {
    const input = { what: "muon dispatch", surface: "cli" as const };
    expect(identityGateRefusalFor("locked", input)).toContain("Run `muon login`");
    // Identified by what is TRUE OF THE STATE on every surface, not by the
    // retry promise — that clause is now surface-specific (only the desktop
    // retries), and pinning the selector on it made this test fail for the
    // right copy.
    expect(identityGateRefusalFor("locked-unregistered", input)).toContain(
      "verified but not yet registered"
    );
    // `open`/`unarmed` refuse nothing, and the absence is a value: an empty
    // string rendered as a refusal tells somebody they are locked when they are
    // not.
    expect(identityGateRefusalFor("open", input)).toBeNull();
    expect(identityGateRefusalFor("unarmed", input)).toBeNull();
  });
});

/** F5 + the copy bug it uncovered: `mcp` was a positive-set member no client
 *  ever sent, and the refusal promised a record naming it. */
describe("the surface sets", () => {
  it("INSTALL_SURFACES holds only surfaces that actually register", () => {
    expect([...INSTALL_SURFACES]).toEqual(["desktop", "cli"]);
    expect([...INSTALL_SURFACES]).not.toContain("mcp");
  });

  it("every ENFORCING surface maps to a REGISTERING one", () => {
    for (const surface of GATE_SURFACES) {
      expect(
        (INSTALL_SURFACES as readonly string[]).includes(
          INSTALL_SURFACE_FOR_GATE[surface]
        ),
        surface
      ).toBe(true);
    }
    // `muon-mcp` ships in the CLI tarball and is opened by `muon login`.
    expect(INSTALL_SURFACE_FOR_GATE.mcp).toBe("cli");
  });

  it("an mcp refusal discloses the record it will ACTUALLY file", () => {
    const copy = githubIdentityGateRefusal({
      what: "every MUON tool",
      surface: "mcp",
    });
    expect(copy).toContain("the surface (cli)");
    expect(copy).not.toContain("the surface (mcp)");
  });
});

/** F14 — armed by flag with no door. */
describe("githubIdentityGateDoorMissing", () => {
  it("is true only when the FLAG armed it and no client id exists", () => {
    expect(
      githubIdentityGateDoorMissing({
        env: { MUON_REQUIRE_GITHUB_LOGIN: "1" },
        distributed: false,
      })
    ).toBe(true);
    expect(
      githubIdentityGateDoorMissing({
        env: { MUON_REQUIRE_GITHUB_LOGIN: "1", ...CLIENT_ID },
        distributed: false,
      })
    ).toBe(false);
    // A distributed build with no client id degrades UNGATED; that is the
    // `misconfigured` case, and it must not also report a missing door.
    expect(
      githubIdentityGateDoorMissing({ env: {}, distributed: true })
    ).toBe(false);
    expect(
      githubIdentityGateDoorMissing({
        env: { MUON_REQUIRE_GITHUB_LOGIN: "0" },
        distributed: true,
      })
    ).toBe(false);
  });
});

// The first real sign-in against the live registry failed on a transient 404
// (the service was mid-deploy), and the operator's browser authorization — the
// one part of this flow a machine cannot redo — was discarded. These pin that
// it is not discarded again.
describe("registerInstallWithRetry", () => {
  const input = {
    baseUrl: "https://registry.example.com",
    token: "gho_x",
    surface: "cli" as const,
    version: "0.4.4",
    platform: "linux-x64",
  };
  const ok = () =>
    new Response(
      JSON.stringify({
        github: { id: 7, login: "octocat" },
        grant: { token: "a".repeat(64), issuedAt: new Date().toISOString(), version: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  it("survives a transient failure and returns the eventual success", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return calls < 3 ? new Response("{}", { status: 404 }) : ok();
    }) as unknown as typeof fetch;

    const registered = await registerInstallWithRetry(
      { ...input, fetcher },
      { delayMs: 0, sleep: async () => undefined }
    );
    expect(registered.github.login).toBe("octocat");
    expect(calls).toBe(3);
  });

  it("retries every failure that is about the PATH, not about the caller", async () => {
    for (const status of [404, 502, 503, 429]) {
      let calls = 0;
      const fetcher = (async () => {
        calls += 1;
        return calls === 1 ? new Response("{}", { status }) : ok();
      }) as unknown as typeof fetch;
      await registerInstallWithRetry(
        { ...input, fetcher },
        { delayMs: 0, sleep: async () => undefined }
      );
      expect(calls, `status ${status}`).toBe(2);
    }
  });

  it("does NOT retry a judgement on the caller — the answer will not change", async () => {
    for (const status of [401, 400]) {
      let calls = 0;
      const fetcher = (async () => {
        calls += 1;
        return new Response("{}", { status });
      }) as unknown as typeof fetch;
      await registerInstallWithRetry(
        { ...input, fetcher },
        { delayMs: 0, sleep: async () => undefined }
      ).catch(() => undefined);
      expect(calls, `status ${status}`).toBe(1);
    }
  });

  it("gives up after its bound and rethrows the LAST error, not a generic one", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;
    const error = await registerInstallWithRetry(
      { ...input, fetcher },
      { attempts: 3, delayMs: 0, sleep: async () => undefined }
    ).catch((caught) => caught);
    expect(calls).toBe(3);
    expect(error.code).toBe("upstream_unavailable");
  });

  it("tells the caller it is retrying, so a surface need not look hung", async () => {
    const seen: string[] = [];
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return calls === 1 ? new Response("{}", { status: 404 }) : ok();
    }) as unknown as typeof fetch;
    await registerInstallWithRetry(
      { ...input, fetcher },
      {
        delayMs: 0,
        sleep: async () => undefined,
        onRetry: (attempt, error) => seen.push(`${attempt}:${error.code}`),
      }
    );
    expect(seen).toEqual(["1:endpoint_missing"]);
  });

  it("maps a 404 to endpoint_missing, and says the sign-in was not judged", async () => {
    const fetcher = (async () =>
      new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const error = await registerInstall({ ...input, fetcher }).catch((c) => c);
    expect(error.code).toBe("endpoint_missing");
    expect(error.message).toContain("mid-deploy");
    expect(error.message).toContain("nothing about it was judged");
    // The word that made this a lockout: it reads as a verdict on the caller.
    expect(error.message).not.toContain("refused");
  });
});
