import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  identityGateSatisfied,
  installRegistrationPending,
  readIdentityCredential,
  writeIdentityCredential,
} from "@muon/client/github-identity-gate";
import {
  desktopGateActive,
  desktopInstallGrantPresent,
  ensureDesktopInstallRegistered,
  guardDesktopRegistration,
  shouldRetryRegistration,
} from "../src/lib/install-registration.js";

/**
 * ADR-0052 — the desktop's registration half.
 *
 * The behaviour under test is deliberately narrow: register once, store the
 * grant beside the identity, and NEVER break a working app when the registry is
 * unreachable. The desktop's arming and satisfaction rules are github-gate.ts's
 * and are covered by github-gate.test.ts, unchanged.
 */

const GRANT = {
  token: "e".repeat(64),
  issuedAt: "2026-08-17T00:00:00.000Z",
  version: 1,
};

describe("ensureDesktopInstallRegistered", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-desktop-reg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function registryReturning(body: unknown, status = 200): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  it("registers, stores the grant, and reports the verified login", async () => {
    const outcome = await ensureDesktopInstallRegistered({
      token: "gho_desktop_token_value",
      version: "0.4.1",
      dataDir: dir,
      registryBase: "https://registry.example.com",
      platform: "darwin-arm64",
      fetcher: registryReturning({
        github: { login: "octocat", id: 583231 },
        grant: GRANT,
      }),
    });

    expect(outcome).toEqual({ state: "registered", login: "octocat" });
    const read = readIdentityCredential(dir);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.credential.github).toEqual({ login: "octocat", id: 583231 });
      expect(read.credential.grant).toEqual(GRANT);
    }
    expect(desktopInstallGrantPresent(dir)).toBe(true);
  });

  it("sends surface `desktop` and nothing beyond the decided record", async () => {
    let body: unknown;
    const fetcher = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ github: { login: "octocat", id: 1 }, grant: GRANT }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    await ensureDesktopInstallRegistered({
      token: "gho_desktop_token_value",
      version: "0.4.1",
      dataDir: dir,
      registryBase: "https://registry.example.com",
      platform: "darwin-arm64",
      fetcher,
    });

    expect(body).toEqual({
      surface: "desktop",
      version: "0.4.1",
      platform: "darwin-arm64",
    });
  });

  it("is idempotent — a grant for THIS surface and version sends nothing", async () => {
    writeIdentityCredential(
      {
        github: { login: "octocat", id: 1 },
        token: "gho_x".repeat(4),
        grant: GRANT,
        registered: { surface: "desktop", version: "0.4.1" },
      },
      dir
    );
    const fetcher = vi.fn();
    const outcome = await ensureDesktopInstallRegistered({
      token: "gho_desktop_token_value",
      version: "0.4.1",
      dataDir: dir,
      registryBase: "https://registry.example.com",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ state: "already" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("F5 — re-registers when the recorded SURFACE differs", async () => {
    // A CLI-first machine: `muon login` filed `cli`, so the founder's table said
    // this operator had never opened the desktop. The grant was on disk, so the
    // desktop never sent anything and the record stayed wrong forever.
    writeIdentityCredential(
      {
        github: { login: "octocat", id: 1 },
        token: "gho_x".repeat(4),
        grant: GRANT,
        registered: { surface: "cli", version: "0.4.1" },
      },
      dir
    );
    let body: unknown;
    const outcome = await ensureDesktopInstallRegistered({
      token: "gho_desktop_token_value",
      version: "0.4.1",
      dataDir: dir,
      registryBase: "https://registry.example.com",
      fetcher: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ github: { login: "octocat", id: 1 }, grant: GRANT }),
          { status: 200 }
        );
      }) as unknown as typeof fetch,
    });
    expect(outcome.state).toBe("registered");
    expect(body).toMatchObject({ surface: "desktop" });
    const read = readIdentityCredential(dir);
    expect(read.ok && read.credential.registered).toEqual({
      surface: "desktop",
      version: "0.4.1",
    });
  });

  it("F5 — re-registers when the VERSION differs, so updates are visible", async () => {
    writeIdentityCredential(
      {
        github: { login: "octocat", id: 1 },
        token: "gho_x".repeat(4),
        grant: GRANT,
        registered: { surface: "desktop", version: "0.4.1" },
      },
      dir
    );
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ github: { login: "octocat", id: 1 }, grant: GRANT }),
          { status: 200 }
        )
    );
    const outcome = await ensureDesktopInstallRegistered({
      token: "gho_desktop_token_value",
      version: "0.4.2",
      dataDir: dir,
      registryBase: "https://registry.example.com",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(outcome.state).toBe("registered");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a SECOND GitHub account registers as itself, never inheriting the first grant", async () => {
    // Idempotence keyed on "a grant file exists", so the ordinary work/personal
    // split — or a laptop handover — registered NOTHING: the founder's table never
    // learned the second person existed, and the second person's install was
    // opened by a record naming somebody else.
    writeIdentityCredential(
      {
        github: { login: "first-account", id: 1 },
        token: "gho_x".repeat(4),
        grant: GRANT,
        registered: { surface: "desktop", version: "0.4.1" },
      },
      dir
    );
    let body: unknown;
    const outcome = await ensureDesktopInstallRegistered({
      token: "gho_second_account_token",
      version: "0.4.1",
      dataDir: dir,
      // Same surface, same version — the ONLY thing that differs is who is
      // connected. Before the identity check this returned `already`.
      login: "second-account",
      registryBase: "https://registry.example.com",
      fetcher: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            github: { login: "second-account", id: 2 },
            grant: GRANT,
          }),
          { status: 200 }
        );
      }) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ state: "registered", login: "second-account" });
    expect(body).toMatchObject({ surface: "desktop" });
    // The stored identity is the SECOND account's, verified by the registry.
    const read = readIdentityCredential(dir);
    expect(read.ok && read.credential.github).toEqual({
      login: "second-account",
      id: 2,
    });
  });

  it("the SAME account in different letter case is one person, not a re-register loop", async () => {
    // GitHub logins are case-preserving and case-insensitive. Comparing exactly
    // would re-register on every single launch.
    writeIdentityCredential(
      {
        github: { login: "OctoCat", id: 1 },
        token: "gho_x".repeat(4),
        grant: GRANT,
        registered: { surface: "desktop", version: "0.4.1" },
      },
      dir
    );
    const fetcher = vi.fn();
    const outcome = await ensureDesktopInstallRegistered({
      token: "gho_desktop_token_value",
      version: "0.4.1",
      dataDir: dir,
      login: "octocat",
      registryBase: "https://registry.example.com",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ state: "already" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a credential from BEFORE the field existed re-registers once, and never re-locks", async () => {
    writeIdentityCredential(
      { github: { login: "octocat", id: 1 }, token: "gho_x".repeat(4), grant: GRANT },
      dir
    );
    // The important half FIRST: this install is open, and a failed refresh must
    // not change that.
    expect(identityGateSatisfied(dir)).toBe(true);
    const outcome = await ensureDesktopInstallRegistered({
      token: "gho_desktop_token_value",
      version: "0.4.1",
      dataDir: dir,
      registryBase: "https://registry.example.com",
      fetcher: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(outcome.state).toBe("deferred");
    expect(identityGateSatisfied(dir)).toBe(true);
    // And it must NOT mark the machine as pending: this install IS registered,
    // and a marker here would re-lock every other surface over a stale version.
    expect(installRegistrationPending(dir)).toBe(false);
  });

  it("DEFERS instead of throwing when the registry is unreachable", async () => {
    const outcome = await ensureDesktopInstallRegistered({
      token: "gho_desktop_token_value",
      version: "0.4.1",
      dataDir: dir,
      registryBase: "https://registry.example.com",
      fetcher: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(outcome.state).toBe("deferred");
    if (outcome.state === "deferred") {
      expect(outcome.reason).toContain("unreachable");
    }
    // The app keeps working: no credential was written, and the retry will run.
    expect(identityGateSatisfied(dir)).toBe(false);
    // F3 — but the machine now CARRIES the fact. Without this, `muon-mcp` and
    // the CLI (which are not satisfied by a credential alone) told the operator
    // to "Run `muon login`" — the thing they had just done, offline.
    expect(installRegistrationPending(dir)).toBe(true);
    const marker = JSON.parse(
      fs.readFileSync(
        path.join(dir, "github-registration-pending.json"),
        "utf8"
      )
    );
    // No identity, no token: `github-identity.json` means "verified by the
    // REGISTRY", and a pending state must not smuggle a self-claimed one.
    expect(Object.keys(marker).sort()).toEqual([
      "createdAt",
      "surface",
      "version",
    ]);
    expect(marker.surface).toBe("desktop");
  });

  it("DEFERS on a refused registration rather than storing a bad grant", async () => {
    const outcome = await ensureDesktopInstallRegistered({
      token: "gho_desktop_token_value",
      version: "0.4.1",
      dataDir: dir,
      registryBase: "https://registry.example.com",
      fetcher: registryReturning({ error: "unauthorized" }, 401),
    });
    expect(outcome.state).toBe("deferred");
    expect(readIdentityCredential(dir)).toEqual({ ok: false, reason: "absent" });
  });

  it("NO CREDENTIAL means nothing leaves this machine — checked by the sender, not only by its caller", async () => {
    // The behavioural half of "registration only fires when armed". Half of that
    // guard is a property of THIS input, and it used to live only in `main.ts`'s
    // funnel — which is why the suite had to assert the funnel by counting call
    // sites in `main.ts` as text. With no token there is nothing for the registry
    // to verify against GitHub and `Bearer ` with nothing after it can only be a
    // 401, so the function that sends the bytes refuses first.
    const fetcher = vi.fn();
    for (const token of ["", "   "]) {
      const outcome = await ensureDesktopInstallRegistered({
        token,
        version: "0.4.1",
        dataDir: dir,
        registryBase: "https://registry.example.com",
        fetcher: fetcher as unknown as typeof fetch,
      });
      expect(outcome.state, JSON.stringify(token)).toBe("deferred");
      if (outcome.state === "deferred") {
        expect(outcome.reason).toContain("nothing to register");
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(readIdentityCredential(dir)).toEqual({ ok: false, reason: "absent" });
    // And NOT the F3 marker: "verified here, waiting on the registry" would be a
    // false story about a machine where nothing was verified at all.
    expect(installRegistrationPending(dir)).toBe(false);
  });

  it("a credential that will not READ BACK defers instead of reporting a landed registration", async () => {
    // The clock-skew round trip, from the desktop's side. `writeIdentityCredential`
    // verifies through the same reader every surface uses and throws when the
    // grant it just stored is unreadable here — a machine whose clock disagrees
    // with the registry's used to be told the registration had landed while every
    // other surface read LOCKED.
    const outcome = await ensureDesktopInstallRegistered({
      token: "gho_desktop_token_value",
      version: "0.4.1",
      dataDir: dir,
      registryBase: "https://registry.example.com",
      fetcher: registryReturning({
        github: { login: "octocat", id: 1 },
        grant: {
          ...GRANT,
          issuedAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      }),
    });
    expect(outcome.state).toBe("deferred");
    if (outcome.state === "deferred") {
      // The cause reaches the renderer, because that string is what the desk
      // shows: a bare "deferred" would send the operator to check their network.
      expect(outcome.reason).toContain("CLOCK DISAGREEMENT");
    }
    expect(identityGateSatisfied(dir)).toBe(false);
    // Not "MUON is retrying": the registration landed, the clock is what is
    // wrong, and `locked` keeps the remedy on the thing that will help.
    expect(installRegistrationPending(dir)).toBe(false);
  });

  it("DEFERS on a grant version this build does not accept", async () => {
    const outcome = await ensureDesktopInstallRegistered({
      token: "gho_desktop_token_value",
      version: "0.4.1",
      dataDir: dir,
      registryBase: "https://registry.example.com",
      fetcher: registryReturning({
        github: { login: "octocat", id: 1 },
        grant: { ...GRANT, version: 42 },
      }),
    });
    expect(outcome.state).toBe("deferred");
    expect(identityGateSatisfied(dir)).toBe(false);
  });
});

/**
 * THE DECISIONS, AS BEHAVIOUR.
 *
 * These used to be assertions about `main.ts` as TEXT — a regex for
 * `githubGateForcesGrant &&`, and a COUNT of `registerDesktopInstall(` call sites.
 * Both are the wrong shape twice over: they pass on any refactor that keeps the
 * words and breaks the behaviour, and the count broke on a legitimate third call
 * site (the bounded retry) purely by going from 3 to 4. The policy now lives in
 * `lib/install-registration.ts` as data-in/boolean-out functions that `main.ts`
 * calls, so it can be exercised as a truth table.
 */
describe("desktopGateActive — the packaged-vs-forced judgment call", () => {
  const active = (over: Partial<Parameters<typeof desktopGateActive>[0]>) =>
    desktopGateActive({
      required: true,
      forcesGrant: false,
      hasCredential: true,
      grantPresent: () => false,
      ...over,
    });

  it("an UNARMED build is never gated, whatever else is true", () => {
    for (const forcesGrant of [false, true]) {
      for (const hasCredential of [false, true]) {
        expect(active({ required: false, forcesGrant, hasCredential })).toBe(false);
      }
    }
  });

  it("armed with NO credential is CLOSED", () => {
    expect(active({ hasCredential: false })).toBe(true);
    expect(active({ hasCredential: false, forcesGrant: true })).toBe(true);
  });

  it("a PACKAGED build is satisfied by the credential ALONE, grant or not", () => {
    // The judgment call recorded in install-registration.ts: an installed base
    // that is already signed in must not lock itself out because a central
    // service is unreachable. If someone makes the packaged build demand the
    // grant, this fails.
    expect(active({ forcesGrant: false, grantPresent: () => false })).toBe(false);
    expect(active({ forcesGrant: false, grantPresent: () => true })).toBe(false);
  });

  it("a FLAG-FORCED build demands the grant too — the ADR's hard shape", () => {
    expect(active({ forcesGrant: true, grantPresent: () => false })).toBe(true);
    expect(active({ forcesGrant: true, grantPresent: () => true })).toBe(false);
  });

  it("does NOT touch the disk unless the answer depends on it", () => {
    // `grantPresent` is a thunk on purpose: this runs on every IPC call and every
    // state poll, and the grant is a file read. An eager boolean would silently
    // turn that into a syscall per call.
    let reads = 0;
    const counting = () => {
      reads += 1;
      return true;
    };
    active({ required: false, grantPresent: counting });
    active({ hasCredential: false, grantPresent: counting });
    active({ forcesGrant: false, grantPresent: counting });
    expect(reads).toBe(0);
    active({ forcesGrant: true, grantPresent: counting });
    expect(reads).toBe(1);
  });
});

describe("guardDesktopRegistration — F2, the arming guard", () => {
  it("an UNARMED build never registers — no dev run may phone home", () => {
    // The bug: registration fired from the device-flow handler and from boot with
    // no check at all, so every developer run that connected GitHub POSTed to the
    // central registry, and every existing installed-base credential registered
    // retroactively on the first boot after it shipped — with no disclosure ever
    // having been on the screen that collected the consent.
    const verdict = guardDesktopRegistration({
      gateArmed: false,
      hasCredential: true,
    });
    expect(verdict.proceed).toBe(false);
    if (!verdict.proceed) expect(verdict.reason).toBe("gate-unarmed");
  });

  it("arming is checked BEFORE the credential — an unarmed build is not asked", () => {
    const verdict = guardDesktopRegistration({
      gateArmed: false,
      hasCredential: false,
    });
    expect(verdict.proceed).toBe(false);
    if (!verdict.proceed) expect(verdict.reason).toBe("gate-unarmed");
  });

  it("no credential is its own reason, so the retry loop can stop", () => {
    const verdict = guardDesktopRegistration({
      gateArmed: true,
      hasCredential: false,
    });
    expect(verdict.proceed).toBe(false);
    if (!verdict.proceed) expect(verdict.reason).toBe("no-credential");
  });

  it("armed AND holding a credential is the only way through", () => {
    expect(
      guardDesktopRegistration({ gateArmed: true, hasCredential: true })
    ).toEqual({ proceed: true });
  });
});

describe("shouldRetryRegistration — F3, bounded in both directions", () => {
  const base = {
    gateArmed: true,
    hasCredential: true,
    attempts: 0,
    maxAttempts: 8,
  };

  it("retries while under the cap", () => {
    for (const attempts of [0, 1, 7]) {
      expect(shouldRetryRegistration({ ...base, attempts })).toBe(true);
    }
  });

  it("STOPS at the cap — never a loop against a central service forever", () => {
    for (const attempts of [8, 9, 100]) {
      expect(shouldRetryRegistration({ ...base, attempts })).toBe(false);
    }
  });

  it("stops when the credential goes away, or the gate disarms", () => {
    expect(shouldRetryRegistration({ ...base, hasCredential: false })).toBe(false);
    expect(shouldRetryRegistration({ ...base, gateArmed: false })).toBe(false);
  });

  it("shares the arming guard, so it can never register what the guard refused", () => {
    // Derived, not restated: `shouldRetryRegistration` calls
    // `guardDesktopRegistration`. A retry path with its own copy of the arming
    // rule is exactly how one surface ends up phoning home while the other does
    // not.
    for (const gateArmed of [false, true]) {
      for (const hasCredential of [false, true]) {
        const guard = guardDesktopRegistration({ gateArmed, hasCredential });
        const retry = shouldRetryRegistration({
          ...base,
          gateArmed,
          hasCredential,
        });
        expect(retry, `${gateArmed}/${hasCredential}`).toBe(guard.proceed);
      }
    }
  });
});

/**
 * THE TEXT ASSERTIONS THAT REMAIN, AND WHY THEY ARE THE EXCEPTION.
 *
 * Everything about the POLICY is a behaviour test above — the three truth tables,
 * and the sender's own refusal when there is no credential. What is left here is
 * a different kind of claim: not "what does this decide" but "is the decided
 * thing the one `main.ts` actually runs". That is a property of a call graph in a
 * module which boots Electron, reaches the keychain and takes over the app's
 * lifecycle at import time, so there is no way to drive it in a unit test and no
 * pure function to extract it into — the wiring IS the fact.
 *
 * Kept deliberately narrow, and each one says what would make it behavioural:
 *  - no regex for a policy EXPRESSION (that passes on any refactor which keeps
 *    the words and breaks the meaning),
 *  - no count of `registerDesktopInstall(` call sites (that broke on a legitimate
 *    third one, going from 3 to 4).
 * The one count that stays is `ensureDesktopInstallRegistered(`, because "exactly
 * one caller" is the property itself and not a proxy for it.
 */
describe("main.ts wires those decisions in, rather than repeating them", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "main.ts"),
    "utf8"
  );

  it("calls the extracted policy instead of re-deriving it", () => {
    // WIRING EXCEPTION: the behavioural half is the truth tables above; this
    // asserts only that the functions those tables cover are the ones running.
    for (const fn of [
      "desktopGateActive({",
      "guardDesktopRegistration({",
      "shouldRetryRegistration({",
    ]) {
      expect(source, fn).toContain(fn);
    }
    // And that the old inline policy is gone, so there is one implementation.
    expect(source).not.toContain(
      "return githubGateForcesGrant && !desktopInstallGrantPresent("
    );
  });

  it("keeps registration behind a SINGLE funnel", () => {
    // WIRING EXCEPTION, and the one that cannot be anything else: "nothing calls
    // `ensureDesktopInstallRegistered` except the guarded `registerDesktopInstall`"
    // is a statement about main.ts's call graph. It would stop being needed if the
    // ARMING half moved into `ensureDesktopInstallRegistered` the way the
    // credential half now has (see the no-credential test above) — that needs a
    // signature change through main.ts and is not this change.
    const sends = source.match(/ensureDesktopInstallRegistered\(/g) ?? [];
    expect(sends.length).toBe(1);
    const funnel = source.slice(
      source.indexOf("function registerDesktopInstall("),
      source.indexOf("ensureDesktopInstallRegistered(")
    );
    expect(funnel).toContain("guardDesktopRegistration({");
    expect(funnel).toContain("return;");
  });

  it("surfaces a deferred registration to the RENDERER, not only console.warn", () => {
    // F3 second half. `console.warn` is the same as nothing: the operator whose
    // first sign-in was offline had a desktop that worked and dispatched agents
    // that were locked, with no surface connecting the two.
    expect(source).toContain("installRegistration = {");
    expect(source).toContain('state: "locked-unregistered"');
    expect(source).toContain("registration: installRegistration");
  });

  it("unrefs the retry timer so it cannot outlive the window", () => {
    expect(source).toContain("installRegistrationTimer.unref?.()");
  });

  it("disconnect clears the SHARED credential and stops the retry", () => {
    // The mirror of the `muon logout` copy fix: Disconnect used to remove the
    // credential from the desktop's own settings and leave `github-identity.json`
    // — access token included — in the shared data dir, so the CLI and `muon-mcp`
    // stayed signed in on an identity the operator had just disconnected.
    const handler = source.slice(
      source.indexOf('ipcMain.handle("muon:disconnectGitHub"'),
      source.indexOf('ipcMain.handle("muon:githubReview"')
    );
    expect(handler.length).toBeGreaterThan(200);
    expect(handler).toContain("clearIdentityCredential(desktopDataDir())");
    expect(handler).toContain("stopInstallRegistrationRetry()");
    expect(handler).toContain("installRegistration = undefined");
  });

  it("the disclosure reaches BOTH consent screens, composed by @muon/client", () => {
    // F2 second half: the record must never be filed by a screen that did not
    // say it would be. The sentence has one author and is rendered verbatim.
    const main = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "main.ts"),
      "utf8"
    );
    expect(main).toContain("installRecordDisclosure({ surface: \"desktop\" })");

    const panel = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "renderer", "sidebar.tsx"),
      "utf8"
    );
    // Rendered, never composed: no second copy of a consent sentence.
    expect(panel).toContain("{props.gateRecordDisclosure}");
    expect(panel).not.toContain("records this install with the MUON project");

    for (const file of ["app.tsx", "settings-panel.tsx"]) {
      const source = fs.readFileSync(
        path.join(import.meta.dirname, "..", "src", "renderer", file),
        "utf8"
      );
      expect(source, file).toContain("gateRecordDisclosure");
    }
  });
});
