/**
 * ADR-0052 — registering the DESKTOP install.
 *
 * The desktop's gate shipped first and already works: device flow, IPC-level
 * enforcement, satisfied-once-persisted. ADR-0052 adds the half it never had —
 * the founder learning the install exists — and deliberately adds ONLY that.
 *
 * JUDGMENT CALL, recorded because the ADR leaves room for it. Decision 4 makes
 * "credential + grant" the satisfied condition, and Consequences accepts that a
 * first run needs reachability. Applying that literally to the PACKAGED desktop
 * would mean an existing signed-in operator is locked out the moment the
 * registry is unreachable — a regression in the shipped app, for a record the
 * founder wants rather than a boundary the user needs. So:
 *
 *   - packaged desktop: arming and satisfaction are EXACTLY as they were
 *     (credential present ⇒ open). Registration is best-effort, and retried on
 *     the next launch until it lands.
 *   - flag-forced desktop (`MUON_REQUIRE_GITHUB_LOGIN=1`): the grant is
 *     required too, which is what makes ADR-0052's hard shape testable on a
 *     real desktop without shipping a lockout.
 *
 * The CLI and `muon-mcp` take the hard form directly, because neither has an
 * installed base to regress and both are what the ADR names.
 */
import {
  InstallRegistryError,
  clearInstallRegistrationPending,
  installNeedsReregistration,
  markInstallRegistrationPending,
  readIdentityCredential,
  registerInstall,
  resolveInstallRegistryBase,
  writeIdentityCredential,
  defaultInstallPlatform,
} from "@muon/client/github-identity-gate";

export type DesktopRegistrationOutcome =
  /** Already registered — a grant for THIS surface and version is on disk.
   *  Nothing was sent. */
  | { readonly state: "already" }
  | { readonly state: "registered"; readonly login: string }
  /** Best-effort failure. The desktop keeps working; the retry loop and the
   *  next launch try again, and the machine now carries a marker saying so. */
  | { readonly state: "deferred"; readonly reason: string };

export type DesktopRegistrationInput = {
  /** The device-flow access token the desktop already custodies. */
  readonly token: string;
  readonly version: string;
  /** The desktop's own ledger profile, so every surface reads one credential. */
  readonly dataDir: string;
  /**
   * The login of the GitHub account currently connected here (the device flow
   * reports one; there is no id in the desktop's credential).
   *
   * Load-bearing: without it, switching to a SECOND account registered nothing
   * and inherited the first account's grant, because idempotence keyed purely on
   * "a grant file exists".
   */
  readonly login?: string;
  readonly registryBase?: string;
  readonly platform?: string;
  readonly fetcher?: typeof fetch;
};

/**
 * Register this desktop install once, and store the grant beside the identity.
 *
 * NEVER THROWS. A registration failure must not break a working app or a
 * completed sign-in — it defers, and the caller logs one line. Idempotent by
 * the grant already on disk, so the launch retry is a cheap file read on every
 * launch after the first successful one.
 */
export async function ensureDesktopInstallRegistered(
  input: DesktopRegistrationInput
): Promise<DesktopRegistrationOutcome> {
  // FAIL CLOSED ON THE CREDENTIAL, HERE, in the function that sends the bytes.
  //
  // `guardDesktopRegistration` already answers this and `main.ts` already asks it
  // — but a guard the CALLER holds is a guard a second caller can be added
  // without, which is the whole reason the funnel had to be asserted about by
  // counting call sites in `main.ts` as text. Half of that guard is a property of
  // this input, so it belongs on this input: with no token there is nothing for
  // the registry to verify against GitHub, and `Bearer ` with nothing after it is
  // a request whose only possible answer is 401.
  //
  // Returned BEFORE the try, so it cannot leave the F3 marker behind: an empty
  // token is not "verified here, waiting on the registry" — nothing was verified.
  if (input.token.trim() === "") {
    return {
      state: "deferred",
      reason:
        "no GitHub credential on this install, so there is nothing to register",
    };
  }
  const running = {
    surface: "desktop" as const,
    version: input.version,
    ...(input.login ? { login: input.login } : {}),
  };
  try {
    // ADR-0052 F5 — "a grant is on disk" was the whole short-circuit, so the
    // record went stale and stayed stale: the CLI registers first on most
    // machines, which left `surface: cli` on file forever even after the desktop
    // ran, and an updated install never re-registered its new version. The
    // credential now carries what it registered AS, and a mismatch on the
    // surface, the version, OR THE CONNECTED IDENTITY registers again rather
    // than reporting a fact that stopped being true.
    //
    // The identity half is the one that mattered most: a second GitHub account
    // registered nothing and inherited the first account's grant. Note the trade
    // if THAT re-registration then fails offline — the previous account's
    // credential stays on disk and the gate stays open on it. Deliberate, and the
    // same judgment call recorded at the top of this file: a packaged desktop
    // with an installed base must not lock itself out because a central service
    // is unreachable. The retry loop and the next launch correct the record.
    const existing = readIdentityCredential(input.dataDir);
    if (existing.ok && !installNeedsReregistration(existing.credential, running)) {
      // Nothing is in flight and nothing is pending; a stale marker here would
      // keep every other surface reporting "waiting to register".
      clearInstallRegistrationPending(input.dataDir);
      return { state: "already" };
    }
    const registered = await registerInstall({
      baseUrl: input.registryBase ?? resolveInstallRegistryBase(),
      token: input.token,
      surface: "desktop",
      version: input.version,
      platform: input.platform ?? defaultInstallPlatform(),
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    });
    writeIdentityCredential(
      {
        github: registered.github,
        token: input.token,
        grant: registered.grant,
        // FIELD BY FIELD, never `registered: running`. `running` also carries the
        // connected `login`, which is a comparison input and NOT part of the
        // stored record — and `registeredAsSchema` is `.strict()`, so passing the
        // whole object made every write throw and every registration "defer".
        // Caught by the second-account test; it is the same widening-by-spread
        // shape this file's registry body-building already avoids on purpose.
        registered: { surface: "desktop", version: input.version },
      },
      input.dataDir
    );
    return { state: "registered", login: registered.github.login };
  } catch (error) {
    // ADR-0052 F3 — LEAVE A MARK. The desktop is satisfied by its own
    // credential, so it keeps working; `muon-mcp` and the CLI are not, and
    // without this they told the operator to "Run `muon login`" — the thing
    // they had just done successfully, offline. The marker carries no identity
    // and no token: only that a verified sign-in here is waiting on the
    // registry. Best-effort, like the registration it describes.
    //
    // Written only when the credential is ABSENT — the genuine "verified here,
    // never recorded" case. Deliberately not written when:
    //  - a credential is already registered and this was a version refresh:
    //    that install is legitimately open, and a marker would re-lock every
    //    other surface over a stale version field;
    //  - a credential exists and will not PARSE: somebody edited it, and
    //    "MUON is retrying" is the wrong story for tampering. `locked` keeps the
    //    remedy at "sign in again", which is the true one.
    const onDisk = readIdentityCredential(input.dataDir);
    if (!onDisk.ok && onDisk.reason === "absent") {
      markInstallRegistrationPending("desktop", input.dataDir);
    }
    return {
      state: "deferred",
      reason:
        error instanceof InstallRegistryError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

// ── The decisions main.ts used to hold inline ────────────────────────────────
//
// Extracted so they can be TESTED rather than asserted about. The tests for this
// area read `main.ts` as TEXT — a regex for `githubGateForcesGrant &&` and a
// count of `registerDesktopInstall(` call sites — which is a test that passes on
// any refactor that keeps the words and breaks the behaviour, and which broke on
// a legitimate third call site (the bounded retry) purely because the count went
// from 3 to 4. These functions carry the same policy as data in, boolean out.

/**
 * Is the desktop's gate CLOSED right now?
 *
 * The exact policy `main.ts` had inline, unchanged, including the judgment call
 * recorded at the top of this file:
 *
 *  - not armed            → open. Nothing is gated.
 *  - armed, no credential → CLOSED. Nothing has been verified here.
 *  - armed, credential    → open for a PACKAGED build (credential-only
 *                           satisfaction: an installed base that is already
 *                           signed in must not lock itself out because a central
 *                           service is unreachable), and gated on the grant only
 *                           when `MUON_REQUIRE_GITHUB_LOGIN=1` forced the gate on
 *                           — which is what makes ADR-0052's hard shape testable
 *                           on a real desktop without shipping a lockout.
 *
 * `grantPresent` is a THUNK, not a boolean, and that is load-bearing: this runs on
 * every IPC call and every state poll, and the grant is a file read. The current
 * code only touches the disk when the answer actually depends on it, and an eager
 * boolean would silently turn that into a syscall per call.
 */
export function desktopGateActive(input: {
  readonly required: boolean;
  readonly forcesGrant: boolean;
  readonly hasCredential: boolean;
  readonly grantPresent: () => boolean;
}): boolean {
  if (!input.required) return false;
  if (!input.hasCredential) return true;
  return input.forcesGrant && !input.grantPresent();
}

/**
 * ADR-0052 F2 — may this call register at all?
 *
 * THE ARMING GUARD, as a function. Registration fired from the device-flow
 * handler and from boot with no check, so every dev run that connected GitHub
 * POSTed to the central registry, every existing installed-base credential
 * registered retroactively on the first boot after it shipped with no disclosure
 * ever having been on the screen that collected it, and a Settings connect made
 * purely for pull-request review filed an "install".
 *
 * A named reason rather than a bare boolean, because the caller logs different
 * things: an unarmed build is a dev run and says nothing; a missing credential
 * means the retry loop should stop.
 *
 * THE CREDENTIAL HALF IS NOW ALSO ENFORCED BY THE SENDER (see the top of
 * `ensureDesktopInstallRegistered`), so this is the caller's early exit rather
 * than the only thing standing between an empty token and the registry. The
 * ARMING half still lives only here, which is why `main.ts` keeping registration
 * behind one guarded funnel is still a property its test has to assert.
 */
export type RegistrationGuard =
  | { readonly proceed: true }
  | { readonly proceed: false; readonly reason: "gate-unarmed" | "no-credential" };

export function guardDesktopRegistration(input: {
  /** `githubGateIsRequired` — packaged, or flag-forced (ADR-0052 Decision 2). */
  readonly gateArmed: boolean;
  readonly hasCredential: boolean;
}): RegistrationGuard {
  // Arming FIRST: an unarmed build must not even be asked about a credential,
  // because the answer would never change what it may do.
  if (!input.gateArmed) return { proceed: false, reason: "gate-unarmed" };
  if (!input.hasCredential) return { proceed: false, reason: "no-credential" };
  return { proceed: true };
}

/**
 * ADR-0052 F3 — should the bounded retry fire again?
 *
 * Relaunch-only was the whole retry policy, which on an app that stays open for a
 * week means "never" — and that app is exactly the one whose first sign-in was
 * offline. Bounded in the other direction too: a background loop hitting a
 * central service for the life of the process is not a fix.
 */
export function shouldRetryRegistration(input: {
  readonly gateArmed: boolean;
  readonly hasCredential: boolean;
  readonly attempts: number;
  readonly maxAttempts: number;
}): boolean {
  if (!guardDesktopRegistration(input).proceed) return false;
  return input.attempts < input.maxAttempts;
}

/**
 * Whether the desktop holds a registry grant for this machine.
 *
 * Read live (not cached) for the same reason the desktop reads its own
 * satisfaction live: `muon login` in a terminal writes the same file, and the
 * app must notice without a restart.
 */
export function desktopInstallGrantPresent(dataDir: string): boolean {
  return readIdentityCredential(dataDir).ok;
}
