import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { booleanEnvFlag } from "./config.js";
import { resolveDataDir } from "./paths.js";

/**
 * ADR-0052 — THE ONE GATE EVALUATOR EVERY DISTRIBUTED SURFACE READS.
 *
 * The desktop shipped this policy first (`apps/desktop/src/lib/github-gate.ts`,
 * P0-2): a packaged build asks the operator to verify a GitHub identity before
 * it will start work, enforced at the IPC boundary with a POSITIVE exemption
 * list. ADR-0052 extends the same policy to the two surfaces that shipped
 * anonymous — an installed CLI tarball and the `muon-mcp` under it — and the
 * parity rule for a governed policy is the one every other one follows: it
 * lives ONCE, here, and each surface enforces it at its own boundary.
 *
 * The desktop asks `isPackaged`; the CLI and MCP ask a build-time `distributed`
 * bake (`bundle-release.mjs` writes `muonDistributed: true` into the published
 * manifest). Same truth table, different name for "this is a build somebody
 * installed rather than a repo somebody is working in".
 *
 * WHAT THIS IS NOT, restated because the desktop's list still holds:
 *  - Not a connectivity check AFTER the first run. Satisfied means "a verified
 *    credential and its install grant are persisted"; going offline later never
 *    re-locks any surface.
 *  - Not on in development. A dev checkout has no bake, so nothing arms.
 *    `MUON_REQUIRE_GITHUB_LOGIN=1` arms it anywhere for testing; `=0` is the
 *    explicit distributed-build escape hatch.
 *  - Not a telemetry channel. The registration below carries the ADR's decided
 *    record and NOTHING else — no workspace paths, no repo names, no code, no
 *    usage. ADR-0031 still owns consent-gated telemetry, separately.
 */

/**
 * Every surface that may REGISTER an install. Positive set, ADR-0022.
 *
 * `mcp` used to be here and is gone (2026-08-17 adversarial review): nothing
 * ever sent it. `muon-mcp` ships INSIDE the CLI tarball and is opened by
 * `muon login`, which files `cli` — so the set carried a member no MUON build
 * produces, and the registry would have accepted a surface that can only come
 * from something that is not MUON. A positive set must not carry a dead member.
 */
export const INSTALL_SURFACES = ["desktop", "cli"] as const;
export type InstallSurface = (typeof INSTALL_SURFACES)[number];

/**
 * Every surface that ENFORCES the gate. Deliberately NOT the same set: the
 * `muon-mcp` server refuses in its own name and the agent reading that refusal
 * has to know which surface refused it, even though the install record it will
 * eventually carry says `cli`.
 */
export const GATE_SURFACES = ["desktop", "cli", "tui", "mcp"] as const;
export type GateSurface = (typeof GATE_SURFACES)[number];

/**
 * WHICH SURFACES RETRY A DEFERRED INSTALL REGISTRATION — the fact, stated once.
 *
 * Only the desktop does, in `startInstallRegistrationRetry`, and only while the
 * app is open. `muon login` registers exactly once; the TUI's startup guard only
 * READS the state; `muon-mcp` never registers at all. Every refusal and note
 * about `locked-unregistered` has to be true for the surface it is read on, and
 * before this was data, two of them told a CLI-only user that MUON was retrying
 * and no action was needed — on an install where nothing retries and the only
 * remedy was the one sentence they were told to ignore.
 *
 * A `Record` over `GATE_SURFACES`, so a fourth surface does not compile until
 * somebody states whether it retries.
 */
export const REGISTRATION_RETRY_BY_SURFACE: Readonly<
  Record<GateSurface, boolean>
> = {
  desktop: true,
  cli: false,
  tui: false,
  mcp: false,
};

/**
 * Which surface a refusal's install record is actually filed under.
 *
 * Explicit rather than an identity assumption, because the disclosure states
 * this value to a human as fact: a `muon-mcp` refusal used to promise the
 * record would say `(mcp)` when `muon login` was about to file `cli`.
 */
export const INSTALL_SURFACE_FOR_GATE: Readonly<
  Record<GateSurface, InstallSurface>
> = {
  desktop: "desktop",
  cli: "cli",
  // The desk and the CLI are one install and one record. `tui` exists as an
  // ENFORCING surface only so its own messages say `tui:` — a refusal that
  // labels itself `cli:` while the operator is looking at the desk is a small
  // lie that costs someone a search for a command they did not run.
  tui: "cli",
  mcp: "cli",
};

const CLIENT_ID_MIN = 8;
const CLIENT_ID_MAX = 200;

/** The effective GitHub App client id: an explicit bake, else the environment. */
function effectiveClientId(input: {
  env: Readonly<Record<string, string | undefined>>;
  clientId?: string;
}): string {
  return input.clientId?.trim() || input.env.MUON_GITHUB_CLIENT_ID?.trim() || "";
}

function clientConfigured(clientId: string): boolean {
  return clientId.length >= CLIENT_ID_MIN && clientId.length <= CLIENT_ID_MAX;
}

export type GateArmingInput = {
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * This build was DISTRIBUTED (a release tarball / packaged app), not run out
   * of a checkout. Desktop passes `app.isPackaged`; CLI and `muon-mcp` pass
   * their manifest's `muonDistributed` bake.
   */
  readonly distributed: boolean;
  /**
   * The client id baked into the release manifest, when there is one. Falls
   * back to `env.MUON_GITHUB_CLIENT_ID`. Never a literal in source — ADR-0052
   * Decision 2.
   */
  readonly clientId?: string;
};

/**
 * Whether this build ARMS the gate.
 *
 * Distributed builds default ON — that is the founder requirement — but ONLY
 * when the GitHub App client id is actually configured: the device flow is the
 * gate's one door, and a gate whose door does not exist must not lock. A
 * release shipped WITHOUT a client id would otherwise be a consumer dead end
 * (every command refused, with an env-var instruction as the only copy). Such a
 * build degrades to UNGATED and the caller logs it loudly, because it is a
 * release mistake, just not one the user should pay for.
 */
export function githubIdentityGateRequired(input: GateArmingInput): boolean {
  const flag = booleanEnvFlag(input.env.MUON_REQUIRE_GITHUB_LOGIN);
  if (flag !== undefined) return flag;
  return input.distributed && clientConfigured(effectiveClientId(input));
}

/** True when a distributed build SHOULD be gated but cannot be (no client id) —
 *  the caller must log this as a release defect. */
export function githubIdentityGateMisconfigured(
  input: GateArmingInput
): boolean {
  const flag = booleanEnvFlag(input.env.MUON_REQUIRE_GITHUB_LOGIN);
  if (flag !== undefined) return false; // explicit choice, not a mistake
  return input.distributed && !clientConfigured(effectiveClientId(input));
}

/**
 * ARMED BY FLAG, WITH NO DOOR — a silent, unopenable lock.
 *
 * `MUON_REQUIRE_GITHUB_LOGIN=1` is an explicit choice, so it is deliberately
 * NOT a "misconfiguration" and deliberately never degrades ungated: forcing the
 * gate on to SEE the locked state is the whole point of the flag. But with no
 * client id there is also no device flow to run, so every surface refuses with
 * "Run `muon login`" and `muon login` cannot start — a dead end with nothing on
 * screen naming the missing piece.
 *
 * The gate still arms (the operator asked for it). The surface says this once,
 * out loud, in the same release-defect voice, so the missing client id is named
 * rather than discovered.
 */
export function githubIdentityGateDoorMissing(input: GateArmingInput): boolean {
  return (
    booleanEnvFlag(input.env.MUON_REQUIRE_GITHUB_LOGIN) === true &&
    !clientConfigured(effectiveClientId(input))
  );
}

/** The one line every surface prints for the state above. */
export function githubIdentityGateDoorMissingWarning(
  surface: GateSurface
): string {
  return (
    `${surface}: MUON_REQUIRE_GITHUB_LOGIN=1 arms the identity gate, but no GitHub App client id ` +
    "is configured (MUON_GITHUB_CLIENT_ID) — so the gate is ON and `muon login` has no device flow " +
    "to run. Set MUON_GITHUB_CLIENT_ID, or unset MUON_REQUIRE_GITHUB_LOGIN."
  );
}

/**
 * HOW A SURFACE REPORTS THE GATE TO SOMETHING THAT MUST ACT ON IT.
 *
 * FOUR states, POSITIVE set (ADR-0022), and the four are deliberately not two:
 *
 *  - `unarmed` (a dev checkout, or a distributed build that degraded because it
 *    has no client id) is NOT the same fact as `open` (armed, and a verified
 *    identity is persisted). Collapsing them would have every dev run report
 *    "signed in".
 *  - `locked-unregistered` is NOT the same fact as `locked`, and conflating
 *    them shipped a wrong instruction: a first sign-in completed OFFLINE leaves
 *    a verified identity on this machine with no install grant, and every
 *    surface told the operator to "Run `muon login`" — the one thing they had
 *    just done and the one thing that would not help. The distinguished state
 *    exists so the deferred case can say what is actually true (MUON retries by
 *    itself) instead of naming a remedy that does not apply.
 *
 * Both locked states REFUSE. This is a copy discriminator, never an authority
 * one — `locked-unregistered` opens nothing.
 *
 * Named here rather than at each surface because the gate policy lives once
 * (ADR-0052 Decision 1) and this is now a wire value: `muon-mcp` emits it from
 * `whoami`, and `muon mcp probe` reads it back out of a server it did not
 * build. A discriminator that each side spells for itself is the drift this
 * file exists to prevent.
 */
export const IDENTITY_GATE_STATES = [
  "locked",
  "locked-unregistered",
  "open",
  "unarmed",
] as const;
export type IdentityGateState = (typeof IDENTITY_GATE_STATES)[number];

export function isIdentityGateState(value: unknown): value is IdentityGateState {
  return (
    typeof value === "string" &&
    (IDENTITY_GATE_STATES as readonly string[]).includes(value)
  );
}

/**
 * Read the DISTRIBUTED bake out of the artifact's own manifest.
 *
 * Same candidate walk `readCliVersion` uses, and for the same reason: the
 * entry's position differs per artifact. The published bundle is a single
 * `.mjs` with its manifest BESIDE it (`./package.json`); the dev/dist layout is
 * two hops up. A dev checkout's manifest carries no `muonDistributed`, so it
 * reads as NOT distributed with no file to add or remove — which is what keeps
 * every repo run ungated by construction rather than by configuration.
 */
export function readDistributionBake(importMetaUrl: string): {
  distributed: boolean;
  clientId?: string;
} {
  for (const hop of ["./package.json", "../package.json", "../../package.json"]) {
    let manifest: { muonDistributed?: unknown; muonGitHubClientId?: unknown };
    try {
      manifest = JSON.parse(
        fs.readFileSync(new URL(hop, importMetaUrl), "utf8")
      ) as typeof manifest;
    } catch {
      continue; // try the next hop
    }
    // Only a literal `true` counts. A truthy string ("false", "0") baked by a
    // shell that stringified everything must not arm a gate.
    if (manifest.muonDistributed !== true) continue;
    const clientId =
      typeof manifest.muonGitHubClientId === "string"
        ? manifest.muonGitHubClientId.trim()
        : "";
    return { distributed: true, ...(clientId ? { clientId } : {}) };
  }
  return { distributed: false };
}

/**
 * READ THE BAKE, REPUBLISH THE CLIENT ID, HAND BACK THE ARMING INPUT.
 *
 * SIDE EFFECT, deliberate and narrow: a release bakes the GitHub App's client id
 * into its own manifest, and the device flow runs through the local brain — which
 * the surface spawns with `{...process.env}`. Without republishing the baked id
 * into the environment, an installed build arms a gate whose door the brain
 * cannot open ("not configured"). A GitHub App client id is a PUBLIC identifier,
 * not a secret; an id already present in the environment always wins, so this
 * can never override an operator's own choice.
 *
 * IT LIVES HERE BECAUSE IT WAS WRITTEN TWICE AND ONLY ONCE. The CLI republished;
 * the TUI read the same bake and did not, so a `muon-tui`-spawned brain had no
 * client id at all and `muon login` from that path had no device flow to run —
 * a locked desk whose one remedy was dead. Two surfaces reading one bake and
 * disagreeing about what to do with it is precisely the drift this module exists
 * to prevent, so the step is one function both call rather than a paragraph both
 * are expected to remember.
 */
export function resolveGateArming(
  /** MUTATED (one key, only when it is unset). `process.env` in production; a
   *  plain object in tests. */
  env: Record<string, string | undefined>,
  importMetaUrl: string
): GateArmingInput {
  const bake = readDistributionBake(importMetaUrl);
  if (bake.clientId && !env.MUON_GITHUB_CLIENT_ID?.trim()) {
    env.MUON_GITHUB_CLIENT_ID = bake.clientId;
  }
  return {
    env,
    distributed: bake.distributed,
    ...(bake.clientId ? { clientId: bake.clientId } : {}),
  };
}

// ── The credential store ────────────────────────────────────────────────────

export const IDENTITY_CREDENTIAL_FILE_NAME = "github-identity.json";

/**
 * Grant formats this build accepts. Positive set — an unknown version re-gates
 * rather than being trusted, which is the revocation hook ADR-0052's Non-goals
 * reserve.
 *
 * HOW REVOCATION ACTUALLY HAS TO WORK, recorded here because the obvious
 * assumption is wrong: **`version` is not covered by the grant's HMAC.** The
 * registry signs `"<ghId>:<surface>:<issuedAt>"` and nothing else, so `version`
 * rides beside the signature as plain, unauthenticated data. It is a
 * COMPATIBILITY marker today — "does this build understand this grant" — and it
 * cannot become an authorization marker by itself.
 *
 * A revocation slice therefore has to do two things, not one: bump the number
 * AND bring it inside the signed string (and, to be worth anything against a
 * local edit, move to asymmetric signing so the client can verify at all — see
 * the note on `token` below). Bumping the number alone re-gates honest clients
 * and stops nobody who is willing to edit a JSON file.
 */
export const ACCEPTED_GRANT_VERSIONS: ReadonlySet<number> = new Set([1]);
export const INSTALL_GRANT_VERSION = 1;

/** Tolerated clock skew when judging a grant's `issuedAt`. */
const GRANT_FUTURE_SKEW_MS = 5 * 60_000;

const installGrantSchema = z
  .object({
    /**
     * The HMAC the registry minted over `"<ghId>:<surface>:<issuedAt>"`.
     *
     * OPAQUE, AND NOBODY VERIFIES IT. The comment here used to say "the service
     * validates the signature", which is not true of anything in this system:
     * the registry only ever MINTS a grant — no endpoint is ever presented one —
     * and this machine holds no signing secret, so it cannot verify one either.
     * That is the correct design (a client able to verify is a client able to
     * mint), but it means the honest description of this field is narrow:
     *
     *   what is checked  — 64 lowercase hex characters, an accepted `version`,
     *                      and an `issuedAt` that is not in the future.
     *   what is NOT      — that the registry actually issued it.
     *
     * So a forged grant of the right SHAPE opens the gate, and rotating
     * `REGISTRY_SIGNING_SECRET` re-gates nobody. Both facts are stated in
     * ADR-0052's corrections and in the registry README; asymmetric signing is
     * the shape that would change them, and is deliberately not built.
     */
    token: z.string().regex(/^[0-9a-f]{64}$/),
    issuedAt: z.string().datetime(),
    version: z.number().int().positive().max(1_000),
  })
  .strict();

/**
 * WHAT THIS INSTALL LAST REGISTERED AS.
 *
 * Without it the record went stale silently: the CLI registers first on most
 * machines, so `surface` stayed `cli` forever even after the operator opened
 * the desktop, and `version` stayed at whatever shipped on the day of the first
 * sign-in — an updated install never re-registered, which is precisely the
 * "who is running WHAT" question the registry exists to answer.
 *
 * OPTIONAL on read: a credential written before this field existed must not
 * re-gate an install that is legitimately registered. It re-registers instead,
 * which is the same thing a surface or version change does.
 */
const registeredAsSchema = z
  .object({
    surface: z.enum(INSTALL_SURFACES),
    version: z.string().min(1).max(64),
  })
  .strict();

export type RegisteredAs = z.infer<typeof registeredAsSchema>;

export const identityCredentialSchema = z
  .object({
    version: z.literal(1),
    /** The identity the REGISTRY verified against GitHub's `/user` — never a
     *  login this machine claimed for itself (ADR-0052 Decision 4). */
    github: z
      .object({
        login: z.string().min(1).max(100),
        id: z.number().int().positive(),
      })
      .strict(),
    /** The device-flow access token, custodied 0600 like every other token
     *  (ADR-0017). Never printed, never logged, never sent anywhere but
     *  GitHub and the install registry's verification call. */
    token: z.string().min(8).max(4_096),
    grant: installGrantSchema,
    registered: registeredAsSchema.optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type IdentityCredential = z.infer<typeof identityCredentialSchema>;
export type InstallGrant = z.infer<typeof installGrantSchema>;

export function identityCredentialFilePath(
  dataDir: string = resolveDataDir()
): string {
  return path.join(dataDir, IDENTITY_CREDENTIAL_FILE_NAME);
}

export type IdentityCredentialRead =
  | { readonly ok: true; readonly credential: IdentityCredential }
  /** No file: this machine has never opened the gate. */
  | { readonly ok: false; readonly reason: "absent" }
  /** A file that will not parse, or whose grant this build does not accept
   *  (forged shape, unknown version, an `issuedAt` in the future). Reported
   *  rather than silently treated as absent — the two lead a human to
   *  different actions, and only one of them is "somebody edited this". */
  | {
      readonly ok: false;
      readonly reason: "unreadable";
      readonly detail: string;
    };

export function readIdentityCredential(
  dataDir: string = resolveDataDir()
): IdentityCredentialRead {
  let raw: string;
  try {
    raw = fs.readFileSync(identityCredentialFilePath(dataDir), "utf8");
  } catch {
    return { ok: false, reason: "absent" };
  }
  let credential: IdentityCredential;
  try {
    credential = identityCredentialSchema.parse(JSON.parse(raw));
  } catch (error) {
    return {
      ok: false,
      reason: "unreadable",
      detail:
        error instanceof Error ? error.message : "invalid identity credential",
    };
  }
  if (!ACCEPTED_GRANT_VERSIONS.has(credential.grant.version)) {
    return {
      ok: false,
      reason: "unreadable",
      detail: `install grant version ${credential.grant.version} is not one this build accepts`,
    };
  }
  if (Date.parse(credential.grant.issuedAt) > Date.now() + GRANT_FUTURE_SKEW_MS) {
    return {
      ok: false,
      reason: "unreadable",
      detail: "install grant is issued in the future",
    };
  }
  return { ok: true, credential };
}

/**
 * The gate is open: a verified identity AND its install grant are persisted.
 *
 * Both halves are required and neither is inferable from the other — a token
 * alone proves nothing was registered, and a grant alone names nobody.
 */
export function identityGateSatisfied(
  dataDir: string = resolveDataDir()
): boolean {
  return readIdentityCredential(dataDir).ok;
}

/**
 * This install must register again: the record on file describes a different
 * surface, a different version, or A DIFFERENT PERSON than the one now running
 * (ADR-0052 F5).
 *
 * The identity check is the one that matters most and was missing longest.
 * Idempotence keyed on "a grant file exists", so signing in with a SECOND GitHub
 * account — the ordinary work/personal split, or a handover — registered nothing
 * and silently inherited the first account's grant: the founder's table never
 * learned the second person existed, and the second person's install was opened
 * by a record naming somebody else.
 *
 * A credential from before `registered` existed re-registers once, which is the
 * cheapest correct answer — it is the same call the surface/version change
 * makes, and it replaces a guess with a fact.
 */
export function installNeedsReregistration(
  credential: IdentityCredential,
  running: RegisteredAs & {
    /**
     * The login of the identity CURRENTLY connected on this surface, when the
     * surface knows it (the desktop's device-flow credential carries a login but
     * no id). Omitted means "cannot tell", which never forces a re-registration
     * on its own — guessing here would re-register on every launch.
     */
    readonly login?: string;
  }
): boolean {
  // Compared case-insensitively: GitHub logins are case-preserving but not
  // case-sensitive, so `OctoCat` and `octocat` are one person and must not
  // re-register each other forever.
  if (
    running.login &&
    running.login.toLowerCase() !== credential.github.login.toLowerCase()
  ) {
    return true;
  }
  const recorded = credential.registered;
  if (!recorded) return true;
  return (
    recorded.surface !== running.surface || recorded.version !== running.version
  );
}

/**
 * A credential that PERSISTED and then would not read back.
 *
 * Thrown rather than returned, and that is the whole point. `writeIdentityCredential`
 * wrote and reported nothing, so `muon login` printed "this MUON install is
 * registered and unlocked" and the very next command reported LOCKED — forever,
 * with no sentence anywhere on the machine connecting the two. Every caller
 * ignores this function's return value (the CLI's login and the desktop's
 * registration both do), so a discriminated result would have left the defect
 * live at both sites and made every future caller responsible for remembering.
 * A throw is the one shape a caller cannot drop: `muon login` already routes it
 * to `failCommand` (message printed, exit 1, success line never reached) and the
 * desktop's registration already catches it into `deferred`.
 */
export class IdentityCredentialWriteError extends Error {
  constructor(
    /** The reader's own words for why it refused. */
    readonly detail: string,
    readonly filePath: string
  ) {
    super(
      `${filePath} was written, but this build cannot read it back: ${detail}. ` +
        "The usual cause is a CLOCK DISAGREEMENT between this machine and the MUON install registry — the grant carries the registry's timestamp, and one more than 5 minutes ahead of this machine's clock is refused as issued in the future. " +
        "Set this machine's clock (turn on automatic date & time / NTP) and run `muon login` again. The file is left where it is: once the clocks agree it becomes readable without another sign-in."
    );
    this.name = "IdentityCredentialWriteError";
  }
}

/** Persist the credential atomically at 0600 — a half-written credential is
 *  exactly the state the next run would then refuse on — and VERIFY THE
 *  ROUND-TRIP through the same reader every surface uses (see
 *  `IdentityCredentialWriteError`). */
export function writeIdentityCredential(
  input: {
    github: { login: string; id: number };
    token: string;
    grant: InstallGrant;
    /** What this install just registered AS. */
    registered?: RegisteredAs;
  },
  dataDir: string = resolveDataDir(),
  now: Date = new Date()
): IdentityCredential {
  const credential = identityCredentialSchema.parse({
    version: 1,
    github: input.github,
    token: input.token,
    grant: input.grant,
    ...(input.registered ? { registered: input.registered } : {}),
    createdAt: now.toISOString(),
  });
  const filePath = identityCredentialFilePath(dataDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(credential, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
  // The registration landed, so the deferred marker is no longer true. Cleared
  // BEFORE the verification below on purpose: a credential that will not read
  // back must report `locked` ("sign in again"), not `locked-unregistered`
  // ("MUON is retrying") — the registration is not what failed.
  clearInstallRegistrationPending(dataDir);
  // VERIFIED THROUGH THE SAME READER EVERY OTHER SURFACE USES, never through
  // the schema alone: `identityCredentialSchema` accepts a grant `readIdentityCredential`
  // then rejects (an unaccepted `version`, an `issuedAt` this machine's clock
  // calls the future), so "it parsed on the way out" was never the same fact as
  // "the next command can read it".
  const verified = readIdentityCredential(dataDir);
  if (!verified.ok) {
    throw new IdentityCredentialWriteError(
      verified.reason === "absent"
        ? "the file is not there after the write"
        : verified.detail,
      filePath
    );
  }
  // The bytes actually on disk, not the ones we hoped to put there.
  return verified.credential;
}

/** Remove one file, distinguishing "was not there" from "could not". */
function removeFile(filePath: string): { removed: boolean; error?: string } {
  try {
    fs.rmSync(filePath);
    return { removed: true };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { removed: false };
    return {
      removed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type IdentityCredentialClear =
  /** The file is gone. `removed: false` means there was nothing to remove. */
  | { readonly ok: true; readonly removed: boolean }
  /** It is STILL THERE. A logout that reports success over this is the failure
   *  this shape exists to make impossible. */
  | { readonly ok: false; readonly detail: string };

/**
 * `muon logout`. Removing the file re-gates the CLI and `muon-mcp` on this
 * machine — which is the whole point, so it is not best-effort silent.
 *
 * THREE OUTCOMES, NOT TWO. This returned a boolean, and `false` meant both "you
 * were not signed in" and "the unlink failed" — so a read-only data dir, a
 * `chown`ed file, or a locked volume made `muon logout` print "not signed in —
 * nothing to remove" while the credential, INCLUDING THE ACCESS TOKEN, sat
 * exactly where it was. The one command whose entire job is "make this
 * credential stop working" reported success for having done nothing.
 *
 * The marker is cleared too, and its failure is a failure as well: a leftover
 * marker leaves every surface saying "verified, waiting to register" about an
 * identity this machine no longer holds — a lock with the wrong reason attached.
 */
export function clearIdentityCredential(
  dataDir: string = resolveDataDir()
): IdentityCredentialClear {
  const filePath = identityCredentialFilePath(dataDir);
  const credential = removeFile(filePath);
  const marker = removeFile(registrationPendingFilePath(dataDir));
  if (credential.error) {
    return {
      ok: false,
      detail: `${filePath} could not be removed (${credential.error}); this machine is still signed in.`,
    };
  }
  if (marker.error) {
    return {
      ok: false,
      detail: `${registrationPendingFilePath(dataDir)} could not be removed (${marker.error}); surfaces on this machine will keep reporting a pending registration.`,
    };
  }
  return { ok: true, removed: credential.removed };
}

// ── The deferred-registration marker ────────────────────────────────────────

/**
 * ADR-0052 F3 — "a GitHub identity is verified on this machine and the install
 * record has NOT landed yet".
 *
 * A separate file rather than a half-written credential, for one reason worth
 * stating: `github-identity.json` means "the identity the REGISTRY verified",
 * and the whole point of Decision 4 is that a login this machine claimed for
 * itself is never trusted. Storing a self-claimed identity there to represent
 * a pending state would break exactly the invariant the file exists to hold.
 *
 * So this marker carries NO identity and NO token — only that somebody here
 * completed a device flow whose registration deferred, and which surface was
 * carrying it. That is the entire fact the other surfaces on this machine need
 * in order to say the true thing instead of "Run `muon login`".
 */
export const REGISTRATION_PENDING_FILE_NAME = "github-registration-pending.json";

const registrationPendingSchema = z
  .object({
    version: z.literal(1),
    surface: z.enum(INSTALL_SURFACES),
    createdAt: z.string().datetime(),
  })
  .strict();

export function registrationPendingFilePath(
  dataDir: string = resolveDataDir()
): string {
  return path.join(dataDir, REGISTRATION_PENDING_FILE_NAME);
}

/** Record that this machine holds a verified identity whose registration has
 *  not landed. Best-effort: failing to write it must never break a sign-in. */
export function markInstallRegistrationPending(
  surface: InstallSurface,
  dataDir: string = resolveDataDir(),
  now: Date = new Date()
): boolean {
  try {
    const filePath = registrationPendingFilePath(dataDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(
        { version: 1, surface, createdAt: now.toISOString() },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    return true;
  } catch {
    return false;
  }
}

export function clearInstallRegistrationPending(
  dataDir: string = resolveDataDir()
): void {
  try {
    fs.rmSync(registrationPendingFilePath(dataDir));
  } catch {
    // Nothing to clear is the ordinary case.
  }
}

export function installRegistrationPending(
  dataDir: string = resolveDataDir()
): boolean {
  try {
    return registrationPendingSchema.safeParse(
      JSON.parse(fs.readFileSync(registrationPendingFilePath(dataDir), "utf8"))
    ).success;
  } catch {
    return false;
  }
}

/**
 * The gate state of an ARMED surface, read from disk.
 *
 * `unarmed` is not reachable here on purpose — it is a property of the BUILD,
 * which this function cannot see. Each surface composes the two: unarmed if it
 * does not arm, otherwise whatever this says.
 */
export function identityGateStateOf(
  dataDir: string = resolveDataDir()
): Exclude<IdentityGateState, "unarmed"> {
  if (identityGateSatisfied(dataDir)) return "open";
  // A credential that will not PARSE is not a deferred registration — somebody
  // edited it, and that reads as `locked` so the remedy stays "sign in again".
  return installRegistrationPending(dataDir) ? "locked-unregistered" : "locked";
}

// ── The install registry ────────────────────────────────────────────────────

/**
 * Where installs register. A default constant plus an env override, exactly
 * like the download host — never a literal buried at a call site, and never a
 * value a release has to be rebuilt to change.
 */
export const INSTALL_REGISTRY_DEFAULT = "https://registry.getmuon.com";

export type InstallRegistryErrorCode =
  /** The registry could not be reached at all (first run needs reachability). */
  | "unreachable"
  /** GitHub did not verify the token the client presented. */
  | "unauthorized"
  /** The registry answered, and refused. */
  | "refused"
  /** The registry is refusing for RATE rather than for this caller: the same
   *  request will work shortly, which is a different instruction to a human
   *  than "refused". */
  | "rate_limited"
  /** The registry is up, and the failure is UPSTREAM of it — it could not reach
   *  GitHub to verify the token. Nothing about the sign-in is wrong, so this
   *  must not read as a verdict on the caller: `refused` sent people to redo a
   *  sign-in that had not been judged at all. */
  | "upstream_unavailable"
  /** There is no registry endpoint at that URL right now — the hostname may not
   *  point at the registry yet, or the service is mid-deploy. NOT a refusal:
   *  nothing judged this caller, and `refused (HTTP 404)` sent people to re-run
   *  a sign-in that had already succeeded. */
  | "endpoint_missing"
  /** The registry answered with something this build cannot read. */
  | "unreadable"
  /** `MUON_INSTALL_REGISTRY` does not name a destination this build will send
   *  a GitHub token to. Refused BEFORE anything leaves the machine. */
  | "misconfigured";

export class InstallRegistryError extends Error {
  constructor(
    readonly code: InstallRegistryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "InstallRegistryError";
  }
}

/** Hosts where plain `http:` is not a downgrade, because the bytes never leave
 *  the machine. Positive set (ADR-0022): anything else must be `https:`. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

/**
 * The registry base, VALIDATED.
 *
 * `MUON_INSTALL_REGISTRY` decides where a GitHub access token is POSTed. It was
 * interpolated straight into a `fetch` with no check at all, so
 * `MUON_INSTALL_REGISTRY=http://attacker.example` sent the operator's token
 * over cleartext to a host of the environment's choosing while the consent copy
 * still said "the MUON project". Both halves of that are fixed: transport is
 * required to be `https:` unless the host is loopback (where there is no wire),
 * and the resolved origin is interpolated into the disclosure so the sentence a
 * human agrees to names the destination the bytes go to.
 *
 * THROWS rather than falling back to the default. A silent fallback would send
 * the token somewhere the operator did not configure, which is the same class
 * of surprise in the other direction.
 */
export function resolveInstallRegistryBase(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const configured = env.MUON_INSTALL_REGISTRY?.trim() || "";
  const raw = (configured || INSTALL_REGISTRY_DEFAULT).replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InstallRegistryError(
      "misconfigured",
      `MUON_INSTALL_REGISTRY is not a URL (${raw}), so MUON will not send a GitHub token to it. Unset it to use ${INSTALL_REGISTRY_DEFAULT}.`
    );
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new InstallRegistryError(
      "misconfigured",
      `MUON_INSTALL_REGISTRY (${raw}) must be https: — a GitHub access token is presented to it. Plain http: is accepted only for 127.0.0.1 or localhost. Unset it to use ${INSTALL_REGISTRY_DEFAULT}.`
    );
  }
  return raw;
}

/**
 * The registry ORIGIN as the consent copy should name it.
 *
 * NEVER THROWS: it is read on refusal paths, where throwing would replace a
 * governed refusal with a stack trace. When the override is one this build will
 * not send to, the copy names the CONFIGURED value verbatim rather than the
 * default — the disclosure's job is "here is where your configuration points",
 * and quietly printing `registry.getmuon.com` beside a
 * `MUON_INSTALL_REGISTRY=http://elsewhere` would hide the one fact worth
 * seeing. Sending to it is refused separately, by the resolver above.
 */
export function installRegistryOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  try {
    return new URL(resolveInstallRegistryBase(env)).origin;
  } catch {
    return env.MUON_INSTALL_REGISTRY?.trim() || INSTALL_REGISTRY_DEFAULT;
  }
}

/**
 * EVERY field that leaves this machine. Exhaustive and asserted in tests:
 * ADR-0052 Decision 4 names the record, and the identity half of it is
 * derived by the SERVICE from the token, never claimed by the client. There is
 * deliberately no room here for a workspace path, a repo name, or a counter.
 */
export const INSTALL_REGISTRY_BODY_FIELDS = [
  "surface",
  "version",
  "platform",
] as const;

const INSTALL_REGISTRY_TIMEOUT_MS = 10_000;

const registerInstallResponseSchema = z
  .object({
    github: z
      .object({
        login: z.string().min(1).max(100),
        id: z.number().int().positive(),
      })
      .strict(),
    grant: installGrantSchema,
  })
  .strict();

export type RegisteredInstall = z.infer<typeof registerInstallResponseSchema>;

export type RegisterInstallInput = {
  readonly baseUrl: string;
  /** The GitHub device-flow access token. Presented as a bearer so the SERVICE
   *  can verify it against GitHub itself; it is never stored server-side. */
  readonly token: string;
  readonly surface: InstallSurface;
  readonly version: string;
  readonly platform: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
};

/**
 * WHICH FAILURES ARE WORTH RETRYING — and why retrying at all is the point.
 *
 * By the time `registerInstall` runs, the human has already opened a browser
 * and authorized a device code. That is the expensive, unrepeatable half. A
 * single transient failure — a deploy swapping containers, a DNS record still
 * propagating, a momentary network drop — used to discard that authorization
 * entirely and send the operator back through the whole flow, and the copy told
 * them to "run `muon login` again once you are online" when they had never been
 * offline. This happened on the very first real sign-in against a live registry.
 *
 * Retried: the failures that are about the PATH to the registry, not about the
 * caller. Not retried: `unauthorized` (GitHub judged the token — a retry asks
 * the same question and gets the same answer), `refused` (the registry judged
 * the request), `misconfigured` (refused before anything left the machine), and
 * `unreadable` (a shape this build cannot parse will not parse next time).
 */
export const RETRYABLE_INSTALL_REGISTRY_CODES: ReadonlySet<InstallRegistryErrorCode> =
  new Set(["unreachable", "upstream_unavailable", "rate_limited", "endpoint_missing"]);

export type RegisterInstallRetryOptions = {
  /** Total attempts, including the first. */
  readonly attempts?: number;
  /** Base backoff; each attempt waits `delayMs * attemptNumber` (linear, not
   *  exponential — the whole budget is seconds, and a human is watching). */
  readonly delayMs?: number;
  /** Told about each failed attempt, so a surface can say "retrying" rather
   *  than appearing to hang. */
  readonly onRetry?: (attempt: number, error: InstallRegistryError) => void;
  readonly sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_REGISTER_ATTEMPTS = 4;
const DEFAULT_REGISTER_DELAY_MS = 1500;

/**
 * `registerInstall`, with a bounded retry over the transient classes.
 *
 * Bounded and short by construction: four attempts over about nine seconds,
 * because a person is staring at a terminal that has just told them to check
 * their browser. It is NOT a background loop — when this returns, the answer is
 * final for this invocation, and the caller still owns what to say about it.
 */
export async function registerInstallWithRetry(
  input: RegisterInstallInput,
  options: RegisterInstallRetryOptions = {}
): Promise<RegisteredInstall> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_REGISTER_ATTEMPTS);
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_REGISTER_DELAY_MS);
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await registerInstall(input);
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof InstallRegistryError &&
        RETRYABLE_INSTALL_REGISTRY_CODES.has(error.code);
      if (!retryable || attempt === attempts) break;
      options.onRetry?.(attempt, error as InstallRegistryError);
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

/** `<platform>-<arch>`, the only machine fact the registry receives. */
export function defaultInstallPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Register this install and collect the signed grant that opens the gate.
 *
 * The body is built field by field from `INSTALL_REGISTRY_BODY_FIELDS` rather
 * than spread from the input: a `{...input}` here would put `baseUrl` and the
 * ACCESS TOKEN into the JSON body the first time somebody added a field, which
 * is the bounded-surface failure this codebase has already paid for twice.
 */
export async function registerInstall(
  input: RegisterInstallInput
): Promise<RegisteredInstall> {
  const body: Record<(typeof INSTALL_REGISTRY_BODY_FIELDS)[number], string> = {
    surface: input.surface,
    version: input.version,
    platform: input.platform,
  };
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(
      `${input.baseUrl.replace(/\/$/, "")}/v1/installs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(
          input.timeoutMs ?? INSTALL_REGISTRY_TIMEOUT_MS
        ),
      }
    );
  } catch {
    throw new InstallRegistryError(
      "unreachable",
      `The MUON install registry (${input.baseUrl}) could not be reached. A first sign-in needs network access; after that MUON works offline.`
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new InstallRegistryError(
      "unauthorized",
      "GitHub did not verify that sign-in. Run the sign-in again."
    );
  }
  if (response.status === 429) {
    // A DIFFERENT instruction to a human than "refused": nothing about this
    // install is wrong, the service is shedding load and the same call works
    // shortly. Collapsing it into `refused` sent people to re-run a sign-in
    // that was already correct.
    throw new InstallRegistryError(
      "rate_limited",
      "The MUON install registry is rate limiting this network right now. Try again in a minute; nothing about this sign-in is wrong."
    );
  }
  if (response.status === 404) {
    throw new InstallRegistryError(
      "endpoint_missing",
      `No registry endpoint answered at ${input.baseUrl}/v1/installs (HTTP 404). The registry may be mid-deploy, or that hostname may not point at it yet. Your sign-in is fine — nothing about it was judged.`
    );
  }
  if (response.status === 502 || response.status === 503) {
    // The registry answered, and what it said is "I could not check with
    // GitHub" — a 5xx from GitHub, a timeout, or a registry that cannot mint.
    // Both used to land in `refused`, whose copy ("refused the registration")
    // reads as a judgement on this sign-in. It is not one: nothing here has
    // been judged, and the same request works later untouched.
    throw new InstallRegistryError(
      "upstream_unavailable",
      "MUON could not verify that sign-in with GitHub right now — the registry is up, but GitHub did not answer it. Nothing about your sign-in is wrong. Try again shortly."
    );
  }
  if (!response.ok) {
    throw new InstallRegistryError(
      "refused",
      `The MUON install registry refused the registration (HTTP ${response.status}).`
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new InstallRegistryError(
      "unreadable",
      "The MUON install registry returned an unreadable response."
    );
  }
  const parsed = registerInstallResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InstallRegistryError(
      "unreadable",
      "The MUON install registry returned a grant this build does not recognise."
    );
  }
  if (!ACCEPTED_GRANT_VERSIONS.has(parsed.data.grant.version)) {
    throw new InstallRegistryError(
      "unreadable",
      `The MUON install registry issued a version ${parsed.data.grant.version} grant, which this build does not accept.`
    );
  }
  return parsed.data;
}

// ── The refusal copy ────────────────────────────────────────────────────────

export type GateRefusalInput = {
  /** What was refused: a command, a channel, a tool name. */
  readonly what: string;
  readonly surface: GateSurface;
  /** What a locked operator can still reach. Positive list, rendered so the
   *  refusal never reads as a dead end. */
  readonly stillAvailable?: readonly string[];
};

/**
 * THE DISCLOSURE SENTENCE, with exactly one author.
 *
 * This is the consent text for the install record (ADR-0052 Decision 5), and it
 * is now read on FOUR surfaces — every gate refusal, `muon login` before the
 * browser opens, the desktop gate screen, and the Settings connect panel. Three
 * of those were added by a review that found the desktop registering installs
 * with no disclosure anywhere on the screen that collected the consent. It is a
 * function rather than a string constant because the DESTINATION is part of the
 * disclosure: consent to "the MUON project" means nothing if
 * `MUON_INSTALL_REGISTRY` points somewhere else.
 *
 * Never retyped at a call site. A second copy of a consent sentence is a second
 * thing to forget to correct.
 */
export function installRecordDisclosure(input: {
  /** The surface the RECORD will carry — not necessarily the one refusing. */
  readonly surface: InstallSurface;
  /** The resolved registry origin. Defaults to whatever this process would
   *  actually send to. */
  readonly registry?: string;
}): string {
  return (
    `Opening it records this install with the MUON project at ${input.registry ?? installRegistryOrigin()} — ` +
    `your GitHub id and login, the surface (${input.surface}), MUON's version, and your platform. ` +
    "Nothing else leaves this machine."
  );
}

/**
 * ONE refusal copy, rendered by every surface (ADR-0052 Decision 1 + 5).
 *
 * Three things, in this order, because a refusal that omits any of them sends
 * the reader somewhere else to find it: what is gated, the one command that
 * opens it, and — plainly, because this IS the consent moment — exactly what
 * opening it records.
 */
export function githubIdentityGateRefusal(
  input: GateRefusalInput & { readonly registry?: string }
): string {
  const lines = [
    `MUON is locked until a GitHub identity is verified (${input.what} is gated).`,
    "Run `muon login` to open it: GitHub's device flow verifies who you are, and no password or token is typed into MUON.",
    installRecordDisclosure({
      surface: INSTALL_SURFACE_FOR_GATE[input.surface],
      ...(input.registry ? { registry: input.registry } : {}),
    }),
  ];
  if (input.stillAvailable?.length) {
    lines.push(`Still available while locked: ${input.stillAvailable.join(", ")}.`);
  }
  return lines.join("\n");
}

/**
 * THE OTHER LOCKED COPY: verified here, not yet registered centrally.
 *
 * Composed beside the refusal above rather than at each surface, for the reason
 * that made it necessary at all: the CLI, `muon-mcp`, the probe and the desk all
 * rendered `githubIdentityGateRefusal` for this state, so an operator whose
 * FIRST sign-in happened offline was told to "Run `muon login`" — the exact
 * thing they had just done successfully. The remedy here is that there is no
 * remedy: MUON retries on its own, and the only action is to wait.
 *
 * Still a refusal. `locked-unregistered` opens nothing.
 */
export function githubIdentityDeferredRefusal(input: GateRefusalInput): string {
  // TRUE FOR THIS SURFACE. "MUON retries automatically; no action needed" was
  // written for the desktop and rendered everywhere, so a CLI or `muon-mcp`
  // user was told to wait for a retry that does not exist there — and the
  // remedy that does work was framed as the thing to try only if waiting fails.
  const retriesHere = REGISTRATION_RETRY_BY_SURFACE[input.surface];
  const lines = [
    `MUON is locked until this install is registered (${input.what} is gated).`,
    "This install's identity is verified but not yet registered — the sign-in worked, the record did not reach the MUON project.",
    retriesHere
      ? "This surface retries automatically while it is open, so it can clear with no action. If it does not, `muon login` re-runs the whole flow and files the record."
      : "NOTHING here retries it. `muon login` is what files the record — it is not a wasted trip, because the registration is the half that failed.",
  ];
  if (input.stillAvailable?.length) {
    lines.push(`Still available while locked: ${input.stillAvailable.join(", ")}.`);
  }
  return lines.join("\n");
}

/**
 * THE ONE SELECTOR: state in, the right copy out.
 *
 * Five surfaces choose between the two refusals above — the CLI hook, the TUI
 * startup guard, `muon-mcp`'s `tools/call`, `muon mcp probe`, and the desktop's
 * probe bridge. Written five times, that ternary is five places for a third
 * state to be quietly read as permission, which is the bounded-surface failure
 * this codebase has already paid for twice. Written once, adding a state is one
 * edit and every surface follows.
 *
 * `null` means "nothing to refuse" — `open` and `unarmed`. A caller that
 * renders a refusal for null is telling somebody they are locked when they are
 * not, so the absence is a value rather than an empty string.
 */
export function identityGateRefusalFor(
  state: IdentityGateState,
  input: GateRefusalInput & { readonly registry?: string }
): string | null {
  if (state === "locked") return githubIdentityGateRefusal(input);
  if (state === "locked-unregistered") return githubIdentityDeferredRefusal(input);
  return null;
}
