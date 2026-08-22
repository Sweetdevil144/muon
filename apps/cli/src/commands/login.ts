import type { Command } from "commander";
import {
  clearIdentityCredential,
  defaultInstallPlatform,
  githubIdentityGateRefusal,
  identityCredentialFilePath,
  markInstallRegistrationPending,
  readIdentityCredential,
  InstallRegistryError,
  registerInstall,
  registerInstallWithRetry,
  resolveInstallRegistryBase,
  writeIdentityCredential,
  type RegisteredInstall,
} from "@muon/client/github-identity-gate";
import type { MuonApiClient } from "../lib/api-client.js";
import { readCliVersion } from "../lib/app-version.js";
import {
  presentDeviceCode,
  type DeviceCodePresenterDeps,
} from "../lib/device-code-prompt.js";
import { printJson } from "../lib/output.js";
import { failCommand } from "../lib/refusal.js";

/**
 * ADR-0052 — `muon login` / `muon logout`: the gate's one door.
 *
 * The flow is the SAME device flow the desktop runs and the same operator-tier
 * brain routes (`/api/github/*`) — no second GitHub client, no client secret
 * anywhere (device flow is a PUBLIC client), no token typed into MUON.
 *
 * What is new is the two things a distributed install needs afterwards:
 *  1. The identity is REGISTERED. The registry re-verifies the token against
 *     GitHub's `/user` itself and answers with the identity IT read, so the
 *     login and id persisted here are the ones a server confirmed rather than
 *     anything this machine claimed.
 *  2. The signed grant is persisted beside the token, 0600. Credential + grant
 *     is what "satisfied" means, and it survives every later offline run.
 *
 * `muon github login` is deliberately left alone: it connects the LIVE brain
 * for the duration of its process (pull-request review) and persists nothing.
 * This command is the durable one.
 */

/**
 * HOW LONG A DEVICE FLOW MAY RUN, and how fast it may ask.
 *
 * Both bounds exist because both were missing. `expiresAt` and `retryAfterMs`
 * arrive from a response, and the loop trusted them: an unparseable `expiresAt`
 * made the expiry check `NaN`-false and left `for(;;)` polling forever, and a
 * `retryAfterMs` of 0 made it poll as fast as the process could manage. Neither
 * needs a malicious server — a clock skew or a schema change is enough.
 *
 * The values are the device-flow envelope: GitHub codes live 15 minutes, and the
 * documented polling interval is 5 seconds.
 */
export const POLL_MIN_INTERVAL_MS = 1_000;
export const POLL_MAX_INTERVAL_MS = 30_000;
export const POLL_DEFAULT_INTERVAL_MS = 5_000;
/** Hard cap on the whole flow, whatever `expiresAt` claims. */
export const POLL_MAX_LIFETIME_MS = 15 * 60_000;

/**
 * NaN-safe, and bounded at BOTH ends.
 *
 * "Not a number at all" and "a number out of range" are answered differently on
 * purpose. A missing or malformed field means the response told us nothing, so
 * the documented default applies; an actual number is a claim, so it is clamped
 * rather than discarded. Coercing instead of type-checking would map `null` to
 * `0` and then to the floor — treating an absent field as a request to poll as
 * fast as the floor allows.
 */
export function clampPollInterval(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return POLL_DEFAULT_INTERVAL_MS;
  }
  return Math.min(POLL_MAX_INTERVAL_MS, Math.max(POLL_MIN_INTERVAL_MS, raw));
}

/**
 * The absolute moment this loop stops, in epoch ms.
 *
 * An unreadable or absent `expiresAt` falls back to the hard cap rather than to
 * "no deadline" — the whole failure was a missing bound being treated as an
 * unlimited one. A deadline further out than the cap is truncated to it, and one
 * already in the past is honoured (the caller reports the expiry immediately).
 */
export function pollDeadline(expiresAt: unknown, nowMs: number): number {
  const cap = nowMs + POLL_MAX_LIFETIME_MS;
  const parsed =
    typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(parsed)) return cap;
  return Math.min(parsed, cap);
}

export type LoginCommandDeps = {
  readonly registerInstall?: typeof registerInstall;
  readonly writeIdentityCredential?: typeof writeIdentityCredential;
  readonly clearIdentityCredential?: typeof clearIdentityCredential;
  readonly readIdentityCredential?: typeof readIdentityCredential;
  readonly markInstallRegistrationPending?: typeof markInstallRegistrationPending;
  readonly readVersion?: () => Promise<string>;
  readonly platform?: () => string;
  readonly registryBase?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** The gh-style code presenter (clipboard + Enter-to-open). Injectable so
   *  tests never touch a real clipboard, browser, or stdin. */
  readonly presenter?: DeviceCodePresenterDeps;
};

/**
 * The login flow as a callable, extracted verbatim from the command action so
 * the interactive `muon setup` wizard can run THE SAME sign-in as step 1
 * instead of a re-implementation that would drift. It communicates exactly as
 * the command does — stdout/stderr + `process.exitCode` — and the wizard reads
 * the credential probe afterwards, not a return value.
 */
export async function runLoginCommand(
  createClient: () => MuonApiClient,
  deps: LoginCommandDeps,
  options: { json?: boolean }
): Promise<void> {
  // RETRYING by default. The human's browser authorization is already spent by
  // the time this runs, so a transient failure must not throw it away — see
  // `registerInstallWithRetry`. An injected `deps.registerInstall` is used
  // exactly as given: a test that supplies a fake is controlling the answer,
  // and wrapping it in retries would change what that test asserts.
  const doRegister =
    deps.registerInstall ??
    ((input: Parameters<typeof registerInstall>[0]) =>
      registerInstallWithRetry(input, {
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        onRetry: (attempt, error) => {
          process.stdout.write(
            `Registering this install did not go through (${error.code}) — retrying (${attempt})…\n`
          );
        },
      }));
  const doWrite = deps.writeIdentityCredential ?? writeIdentityCredential;
  const doClear = deps.clearIdentityCredential ?? clearIdentityCredential;
  const doRead = deps.readIdentityCredential ?? readIdentityCredential;
  const doMarkPending =
    deps.markInstallRegistrationPending ?? markInstallRegistrationPending;
  const readVersion =
    deps.readVersion ?? (() => readCliVersion(import.meta.url).catch(() => "0.0.0"));
  const platform = deps.platform ?? defaultInstallPlatform;
  const registryBase = deps.registryBase ?? (() => resolveInstallRegistryBase());
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;

  try {
        // RESOLVED FIRST, and allowed to throw. `MUON_INSTALL_REGISTRY` decides
        // where a GitHub token is about to be POSTed, so a destination this
        // build will not send to has to refuse BEFORE the device flow starts —
        // and the resolved origin is what the disclosure names, so the sentence
        // the operator agrees to is about the host that receives the bytes.
        const registry = registryBase();

        // The disclosure comes BEFORE the browser opens, not after: this is
        // the consent moment for the record, so it is stated where a person
        // can still decide not to (ADR-0052 Decision 5).
        process.stderr.write(
          `${githubIdentityGateRefusal({
            what: "this install",
            surface: "cli",
            registry: new URL(registry).origin,
          })}\n\n`
        );

        const client = createClient();
        const flow = await client.startGitHubDeviceFlow();
        // gh-style (founder, 2026-08-19): code onto the clipboard, Enter opens
        // the browser. Waiting at the Enter prompt is safe — the poll deadline
        // below is computed AFTER it, still capped by the code's own expiry.
        await presentDeviceCode(flow, deps.presenter ?? {});
        // THE LOOP IS BOUNDED BY THIS MACHINE, not by what the brain reported.
        //
        // `deadline` came straight from `flow.expiresAt`, and the expiry check
        // was `if (Number.isFinite(deadline) && …)` — so an UNPARSEABLE
        // `expiresAt` produced `NaN`, skipped the check entirely, and left a
        // `for(;;)` polling GitHub forever with no way out but ctrl-c. The
        // fallback is not "no deadline"; it is the hard cap.
        const deadline = pollDeadline(flow.expiresAt, now());
        let waitMs = clampPollInterval(flow.intervalMs);
        let accessToken: string | undefined;
        for (;;) {
          await sleep(waitMs);
          if (now() > deadline) {
            process.stdout.write(
              "The GitHub code expired before authorization completed. Run `muon login` again.\n"
            );
            process.exitCode = 1;
            return;
          }
          // A transient failure reaching the BRAIN must not abandon a device
          // flow GitHub still considers live — retry until the code's own
          // expiry bounds the loop (same rule as `muon github login`).
          let result;
          try {
            result = await client.pollGitHubDeviceFlow(flow.flowId);
          } catch (error) {
            process.stderr.write(
              `poll failed (${
                error instanceof Error ? error.message : String(error)
              }); retrying…\n`
            );
            continue;
          }
          if (result.status === "pending") {
            // CLAMPED, every time. `retryAfterMs` is whatever the response said,
            // and it was assigned raw: a 0 (or a NaN) turned this into a tight
            // loop hammering GitHub through the local brain, which is how a
            // sign-in earns a rate-limit instead of a token.
            waitMs = clampPollInterval(result.retryAfterMs);
            continue;
          }
          if (result.status === "connected") {
            accessToken = result.credential.accessToken;
            break;
          }
          // expired / denied / error all carry a human message.
          process.stdout.write(`${result.message}\n`);
          process.exitCode = 1;
          return;
        }

        const version = await readVersion();
        let registered: RegisteredInstall;
        try {
          registered = await doRegister({
            baseUrl: registry,
            token: accessToken,
            surface: "cli",
            version,
            platform: platform(),
          });
        } catch (error) {
          // Registration failure is the ONE thing that leaves a signed-in
          // operator still locked, so it says which half failed and what to
          // do — never a bare stack.
          //
          // The marker is what stops every OTHER surface on this machine from
          // then telling them to "Run `muon login`" — the thing they just did.
          // It carries no identity and no token (see @muon/client): only that
          // a verified sign-in here is waiting on the registry.
          doMarkPending("cli");
          // The second sentence used to say "once you are online" for EVERY
          // failure, including a 404 and a registry 503 — telling someone to
          // fix a network that was never broken. It now follows the class of
          // failure, because a remedy that does not match what happened is how
          // a person concludes the tool is lying to them.
          const code =
            error instanceof InstallRegistryError ? error.code : "unreadable";
          const next =
            code === "unreachable"
              ? "Run `muon login` again once you are online."
              : code === "unauthorized"
                ? "Run `muon login` again — GitHub did not verify that sign-in."
                : code === "misconfigured"
                  ? "Fix MUON_INSTALL_REGISTRY (or unset it) and run `muon login` again."
                  : "MUON already retried. Run `muon login` again in a minute; if it keeps happening, the registry is down and this is not something you can fix from here.";
          process.stderr.write(
            `${
              error instanceof Error ? error.message : String(error)
            }\nGitHub verified you, but this install is not registered yet, so MUON stays locked. ${next}\n`
          );
          process.exitCode = 1;
          return;
        }

        try {
          doWrite({
            github: registered.github,
            token: accessToken,
            grant: registered.grant,
            // ADR-0052 F5: what this install registered AS, so a later run on a
            // new version (or from another surface) knows to register again
            // rather than reporting a record that stopped being true.
            registered: { surface: "cli", version },
          });
        } catch (error) {
          // THE OTHER WAY THIS COMMAND USED TO LIE. The writer persisted and
          // reported nothing, so a machine whose clock disagrees with the
          // registry's got "registered and unlocked" here and LOCKED on the very
          // next command, permanently, with nothing on screen joining the two
          // facts. The writer now verifies the round-trip and throws; this names
          // which half survived (the sign-in and the record) and which did not.
          process.stderr.write(
            `${
              error instanceof Error ? error.message : String(error)
            }\nGitHub verified you and this install IS registered with the MUON project, but the credential could not be stored in a form MUON reads back — so MUON stays locked.\n`
          );
          process.exitCode = 1;
          return;
        }

        if (options.json) {
          // The token and the grant's HMAC are NOT printed. What a script
          // needs is who and whether, not the credential.
          printJson({
            login: {
              github: registered.github,
              surface: "cli",
              version,
              registered: true,
            },
          });
          return;
        }
        process.stdout.write(
          `signed in as ${registered.github.login} — this MUON install is registered and unlocked\n`
        );
  } catch (error) {
    failCommand(error, "Login failed.");
  }
}

export function registerLoginCommands(
  program: Command,
  createClient: () => MuonApiClient,
  deps: LoginCommandDeps = {}
) {
  const doClear = deps.clearIdentityCredential ?? clearIdentityCredential;
  const doRead = deps.readIdentityCredential ?? readIdentityCredential;

  program
    .command("login")
    .description(
      "Verify your GitHub identity and register this install — the one command that opens a locked MUON"
    )
    .option("--json", "Print the result as JSON")
    .action((options: { json?: boolean }) => runLoginCommand(createClient, deps, options));

  program
    .command("logout")
    .description(
      "Forget this machine's verified GitHub identity (a distributed install re-locks)"
    )
    .action(() => {
      try {
        const before = doRead();
        const result = doClear();
        if (!result.ok) {
          // THE ONE OUTCOME THAT MUST NOT READ AS SUCCESS. A read-only data dir
          // used to print "not signed in — nothing to remove" while the
          // credential and its access token sat exactly where they were.
          failCommand(
            new Error(
              `${result.detail}\nThe credential was NOT removed, so this machine is still signed in. Fix the permissions on ${identityCredentialFilePath()} and run \`muon logout\` again.`
            ),
            "Logout failed."
          );
          return;
        }
        process.stdout.write(
          result.removed
            ? `signed out${
                before.ok ? ` (was ${before.credential.github.login})` : ""
              } — ${identityCredentialFilePath()} removed\n`
            : "not signed in — nothing to remove\n"
        );
        // WHICH surfaces this actually re-locks, said out loud. The credential
        // file is read by the CLI and by `muon-mcp`; the desktop keeps its own
        // GitHub connection in its own settings and is NOT touched here, so an
        // operator who ran this expecting the app to sign out would otherwise
        // be quietly wrong about their own machine.
        process.stderr.write(
          "This re-locks the CLI and `muon-mcp` on this machine. The MUON desktop app keeps its own GitHub connection (Settings → GitHub → Disconnect) and is unaffected.\n" +
            "The install record already sent to the MUON project is not withdrawn by this; it is a record that this install exists, not a live session.\n"
        );
      } catch (error) {
        failCommand(error, "Logout failed.");
      }
    });
}
