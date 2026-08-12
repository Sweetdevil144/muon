import { spawn } from "node:child_process";
import {
  ROLE_SPECS,
  vendorLabel,
  vendorRoleCeiling,
  type AgentRole,
} from "@muon/protocol";
import { commandExistsAsync } from "./command-check.js";
import {
  resolveVendorCredentialEvidence,
  type VendorCredentialEvidence,
  type VendorCredentialMethod,
} from "./provider-credentials.js";

/**
 * Auth-aware vendor readiness (P2 onboarding core).
 *
 * `adapter.health()` only answers "is the CLI binary installed?". A fresh user
 * can have the binary yet not be logged in, so a fleet sizes and a dispatch
 * happens, only to fail deep in the runner with a cryptic vendor error. This
 * module closes that gap: for each vendor it reports BOTH whether the binary is
 * present AND whether MUON has positive evidence that the CLI can authenticate,
 * with the exact action to fix a gap.
 *
 * INVARIANT, never custody a vendor token. We probe login by running each
 * vendor CLI's OWN read-only status/whoami command and interpreting its exit
 * code / stdout, or by observing that the selected vendor's trusted provider
 * configuration names a credential variable that is present. We never return,
 * log, or store the token itself. `detail` may echo the account identity (e.g.
 * the email) that the CLI prints, that is ownership provenance, never a
 * secret, but a token never appears here.
 */
export type VendorReadiness = {
  /** The MUON lane/vendor key: "claude-code" | "codex" | "cursor". */
  vendor: string;
  /** A usable CLI binary is on PATH (reuses commandExists). */
  installed: boolean;
  /** Positive evidence says this installed CLI can authenticate. */
  authenticated: boolean;
  /** Which evidence source established readiness. Absent when not ready. */
  credentialMethod?: VendorCredentialMethod;
  /** Human-readable status. NEVER contains a token (may include the account). */
  detail: string;
  /** The exact command to become ready (install or log in). Absent when ready. */
  fixHint?: string;
  /**
   * Machine-stable auth evidence (P0.5 preflight tri-state). Absent on older
   * payloads AND when auth was never probed (not installed / unknown vendor) —
   * consumers fall back to `authenticated`.
   *  - "confirmed": positive native-login or trusted provider evidence
   *  - "negative": the vendor's own probe explicitly said not logged in
   *  - "unknown": the probe could not run (timeout/spawn failure), NOT a
   *    negative — a probe outage must never read as "signed out"
   *  - "provider-unconfigured": the selected custom provider names a
   *    credential variable that is not present
   */
  authState?: "confirmed" | "negative" | "unknown" | "provider-unconfigured";
  /**
   * Provider/version fingerprint (P0.1 checkpoint+resume): the first line of
   * the CLI's own `--version` output, trimmed and bounded. A version string is
   * a fingerprint REF (never a secret). Absent when the CLI is not installed
   * or the version probe failed — honest absence, never a guess.
   */
  cliVersion?: string;
};

/** Default per-probe wall-clock budget. Short, these are status commands. */
export const DEFAULT_PROBE_TIMEOUT_MS = 6000;

/** Raw result of running one probe command. Injectable so tests never spawn. */
export type ProbeExecResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the probe could not run at all (spawn error / timeout). */
  error?: Error;
};

/**
 * Where a bounded vendor command runs. Both fields matter for commands that are
 * not pure status probes: `cursor-agent mcp enable` keys its approvals file on
 * the PROJECT ROOT it resolves from cwd, and on `HOME`. An auth probe passes
 * neither and inherits the parent's, which is what it wants.
 */
export type BoundedExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type ProbeExec = (
  command: string,
  args: string[],
  timeoutMs: number,
  options?: BoundedExecOptions
) => ProbeExecResult | Promise<ProbeExecResult>;

/** Cap probe output so a runaway CLI can't balloon memory (fail-closed). */
const MAX_PROBE_OUTPUT = 256 * 1024;

/**
 * The real probe: spawn the vendor CLI's status command ASYNCHRONOUSLY so the
 * event loop never blocks (a sync spawnSync would stall the embedded backend
 * for up to the timeout × N vendors, starving runner heartbeats). stdin is
 * IGNORED so a probe can never hang on an input prompt, and it is bounded by a
 * timeout. We only READ the CLI's own status output, never pass/capture a
 * token, and this never rejects: any failure → a fail-closed result.
 *
 * EXPORTED because the same four properties (async, stdin-EOF, bounded,
 * never-rejects) are what any short vendor SIDE-command needs, not just an auth
 * probe — `CursorAdapter`'s targeted `mcp enable` is one. A second copy of this
 * boilerplate is how one of them would quietly lose the stdin or timeout half.
 */
export const runBoundedVendorCommand: ProbeExec = (
  command,
  args,
  timeoutMs,
  options
) =>
  new Promise<ProbeExecResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: options.env } : {}),
      });
    } catch (error) {
      resolve({
        status: null,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        status: null,
        stdout,
        stderr,
        error: new Error(`auth probe timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);

    const finish = (result: ProbeExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_PROBE_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_PROBE_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ status: null, stdout, stderr, error }));
    child.on("close", (code) => finish({ status: code, stdout, stderr }));
  });

type AuthVerdict = { authenticated: boolean; detail: string };

type VendorProbeSpec = {
  vendor: string;
  displayName: string;
  /**
   * The crew roles this lane may hold. Sourced from THE registry (ADR-0022) via
   * `vendorRoleCeiling`, not restated: this module cannot import the adapters
   * (`cursor-adapter.ts` imports IT, so the reverse would be a cycle), but both
   * sides can import `@muon/protocol`, which has no `@muon` dependencies at all.
   * `tests/vendor-readiness.test.ts` still asserts this agrees with each
   * adapter's own declaration, so the two remaining statements cannot drift.
   */
  dispatchRoles: readonly AgentRole[];
  /** Binaries that count as "installed" (mirrors the lane adapter candidates). */
  installedCandidates: string[];
  /**
   * A second binary that must ALSO be present because MUON spawns it rather
   * than (or as well as) the vendor's own CLI. No vendor needs this today — the
   * Ollama lane, which ran through the Codex OSS runtime, was the only one and
   * has been removed. Kept because it is the only honest way for such a lane to
   * declare its co-requisite, and the registry still models the same field.
   */
  runtimeRequirement?: {
    candidates: string[];
    detail: string;
    fixHint: string;
  };
  /**
   * Binaries able to answer the auth probe. For Cursor this is the AGENT CLI
   * (`cursor-agent`/`agent`), NOT the bare `cursor` IDE launcher, which has no
   * agent auth surface.
   */
  authCandidates: string[];
  /** The vendor's own read-only auth/whoami arguments. */
  authArgs: string[];
  /** The vendor's own version-print arguments (fingerprint probe). */
  versionArgs: string[];
  /** Interpret the probe output WITHOUT reading any secret. */
  interpret: (result: ProbeExecResult) => AuthVerdict;
  /** The exact command the user runs to log in, given the resolved binary. */
  loginHint: (bin: string) => string;
  /** The exact command to install the CLI when no binary is present. */
  installHint: string;
};

/**
 * An explicit "logged in / signed in" phrase, the ONLY positive auth signal we
 * trust. exit-0 alone is NOT enough: a CLI that prints usage/help for its
 * status subcommand and exits 0 would otherwise read as authenticated while the
 * user is logged out (re-introducing the cryptic deep-runner failure P2 fixes).
 */
const LOGGED_IN = /logged[ -]?in|signed[ -]?in/i;

/** Any explicit negative signal, treated as logged out regardless of exit. */
const NOT_LOGGED_IN =
  /not (logged|signed)[ -]?in|logged out|signed out|no (stored )?credential|please (log|sign) ?in|not authenticated|run\s+`?(codex|cursor-agent|claude)(\s|`)/i;

/**
 * Pull a structured account identifier (email) out of the CLI's own output for
 * `detail`. This is ownership provenance ("which account is connected"), never
 * a secret, and building `detail` from a PARSED field (not the raw first line)
 * means a stray secret a CLI might print on line 1 can never surface here.
 */
function extractEmail(text: string): string | undefined {
  const match = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return match ? match[0] : undefined;
}

/** Structured "logged in [as <email>]", never the raw CLI output line. */
function loggedInDetail(text: string): string {
  const email = extractEmail(text);
  return email ? `logged in as ${email}` : "logged in";
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Tolerate a stray banner line around the JSON body.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Claude Code: `claude auth status --json` prints a machine-readable object
 * with a `loggedIn` boolean (and account fields, never a token). Verified
 * against claude 2.1.207. We parse `loggedIn`; if the JSON shape ever changes
 * we fall back to a conservative exit-code + text heuristic.
 */
function interpretClaude(result: ProbeExecResult): AuthVerdict {
  const parsed = tryParseJson(result.stdout) as
    | { loggedIn?: unknown; email?: unknown; authMethod?: unknown }
    | undefined;
  if (parsed && typeof parsed.loggedIn === "boolean") {
    const who = typeof parsed.email === "string" ? ` as ${parsed.email}` : "";
    const via =
      typeof parsed.authMethod === "string" ? ` via ${parsed.authMethod}` : "";
    return {
      authenticated: parsed.loggedIn,
      detail: parsed.loggedIn ? `logged in${who}${via}` : "not logged in",
    };
  }
  // Fallback when `--json` shape ever changes: require an explicit positive
  // phrase (not a loose "organization/subscription" match) and exit 0.
  const text = `${result.stdout}\n${result.stderr}`;
  const authed =
    result.status === 0 && LOGGED_IN.test(text) && !NOT_LOGGED_IN.test(text);
  return {
    authenticated: authed,
    detail: authed ? loggedInDetail(text) : "not logged in",
  };
}

/**
 * Codex: `codex login status` prints "Not logged in" and exits 1 when signed
 * out, and prints the account and exits 0 when signed in. Verified against the
 * codex CLI locally. We treat exit 0 (without a negative phrase) as authed.
 */
function interpretCodex(result: ProbeExecResult): AuthVerdict {
  const text = `${result.stdout}\n${result.stderr}`;
  // Require an explicit positive phrase (not exit-0 alone): a help/usage dump
  // that exits 0 must NOT be read as authenticated.
  const authed =
    result.status === 0 && LOGGED_IN.test(text) && !NOT_LOGGED_IN.test(text);
  return {
    authenticated: authed,
    detail: authed ? loggedInDetail(text) : "not logged in",
  };
}

/**
 * Cursor: `cursor-agent status` prints "✓ Logged in as <email>" and exits 0
 * when signed in. Verified against cursor-agent locally. We require exit 0 AND
 * a positive phrase, and reject any explicit negative phrase.
 */
function interpretCursor(result: ProbeExecResult): AuthVerdict {
  const text = `${result.stdout}\n${result.stderr}`;
  // Require an explicit "logged in / signed in" phrase, NOT a bare success
  // glyph (✓) or an `@` (a handle/path/`@latest` would false-positive).
  const authed =
    result.status === 0 && LOGGED_IN.test(text) && !NOT_LOGGED_IN.test(text);
  return {
    authenticated: authed,
    detail: authed ? loggedInDetail(text) : "not logged in",
  };
}

/**
 * OpenCode: `opencode auth list` EXITS 0 WHETHER OR NOT ANYONE IS LOGGED IN —
 * the same trap `cursor-agent` sets, verified here rather than assumed. Run
 * against the real binary (1.18.5) with the credential store relocated to an
 * empty directory, it still exits 0 and prints:
 *
 *     ┌  Credentials  <path>/auth.json
 *     └  0 credentials
 *
 * against `2 credentials` when signed in. So the COUNT is the signal and the
 * exit code is worthless, exactly as for Cursor.
 *
 * The `Environment` section is deliberately IGNORED. `auth list` also reports
 * provider keys it found in the probe's own environment (e.g. `OPENAI_API_KEY`),
 * but MUON does not forward those to this lane — `credentials.envKeys` is empty
 * precisely so one vendor's key never reaches another vendor's binary. Counting
 * them would report a lane as ready that cannot actually authenticate once MUON
 * scopes the child env. Only opencode's OWN stored credentials count.
 */
function interpretOpencode(result: ProbeExecResult): AuthVerdict {
  const text = `${result.stdout}\n${result.stderr}`;
  const count = parseOpencodeCredentialCount(text);
  if (count === undefined) {
    // The line we key on is gone: the CLI changed shape. Fail closed rather
    // than guessing from the exit code, which is 0 either way.
    return { authenticated: false, detail: "not logged in" };
  }
  if (count === 0) {
    return { authenticated: false, detail: "not logged in" };
  }
  return {
    authenticated: true,
    detail: `logged in (${count} stored credential${count === 1 ? "" : "s"})`,
  };
}

/**
 * The `N credentials` summary from `opencode auth list`, or `undefined` when
 * that line is absent. Bounded to the CREDENTIALS wording so the `N environment
 * variable(s)` line below it can never be mistaken for stored auth.
 */
function parseOpencodeCredentialCount(text: string): number | undefined {
  const match = /(\d+)\s+credentials?\b/i.exec(text);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

/**
 * Per-vendor probe specs. These auth-probe commands are the load-bearing piece
 * a reviewer must scrutinize (and re-verify against live CLIs in the P7
 * dogfood), each was verified against the installed CLI on 2026-07-11, but
 * vendor CLIs evolve, so they are centralized here for a one-line change.
 */
export const VENDOR_READINESS_PROBES: VendorProbeSpec[] = [
  {
    vendor: "claude-code",
    dispatchRoles: vendorRoleCeiling("claude-code"),
    displayName: vendorLabel("claude-code"),
    installedCandidates: ["claude"],
    authCandidates: ["claude"],
    authArgs: ["auth", "status", "--json"],
    versionArgs: ["--version"],
    interpret: interpretClaude,
    loginHint: () =>
      "log into Claude Code first: run `claude` and sign in (or `claude auth login`; API-key alternative: set ANTHROPIC_API_KEY)",
    installHint:
      "install the Claude Code CLI (`npm i -g @anthropic-ai/claude-code`), then run `claude` and sign in",
  },
  {
    vendor: "codex",
    dispatchRoles: vendorRoleCeiling("codex"),
    displayName: vendorLabel("codex"),
    installedCandidates: ["codex"],
    authCandidates: ["codex"],
    authArgs: ["login", "status"],
    versionArgs: ["--version"],
    interpret: interpretCodex,
    loginHint: () => "log into Codex first: `codex login`",
    installHint:
      "install the Codex CLI (`npm i -g @openai/codex` or `brew install codex`), then `codex login`",
  },
  {
    vendor: "cursor",
    dispatchRoles: vendorRoleCeiling("cursor"),
    displayName: vendorLabel("cursor"),
    // Installed check mirrors CursorAdapter.commandCandidates (incl. the bare
    // `cursor` IDE launcher), but the auth probe only trusts the agent CLI.
    installedCandidates: ["agent", "cursor-agent", "cursor"],
    authCandidates: ["cursor-agent", "agent"],
    authArgs: ["status"],
    versionArgs: ["--version"],
    interpret: interpretCursor,
    loginHint: (bin) => `log into Cursor first: \`${bin} login\``,
    installHint:
      "install the Cursor agent CLI (`curl https://cursor.com/install -fsS | bash`), then `cursor-agent login`",
  },
  {
    vendor: "opencode",
    dispatchRoles: vendorRoleCeiling("opencode"),
    displayName: vendorLabel("opencode"),
    installedCandidates: ["opencode"],
    authCandidates: ["opencode"],
    // Read-only, and it prints a COUNT rather than any credential material.
    authArgs: ["auth", "list"],
    versionArgs: ["--version"],
    interpret: interpretOpencode,
    loginHint: (bin) => `log into OpenCode first: \`${bin} auth login\``,
    installHint:
      "install OpenCode (`curl -fsSL https://opencode.ai/install | bash`), then `opencode auth login`",
  },
];

export type ProbeOptions = {
  /** Override the spawner (tests inject canned CLI output; never spawns). */
  exec?: ProbeExec;
  /** Per-probe timeout. */
  timeoutMs?: number;
  /** Override the PATH check (tests inject which binaries "exist"). */
  hasCommand?: (command: string) => boolean | Promise<boolean>;
  /** Override provider evidence resolution (tests never inspect real env). */
  resolveCredentials?: (
    vendor: string
  ) => VendorCredentialEvidence | Promise<VendorCredentialEvidence>;
};

/** First candidate whose binary resolves (async, never blocks the loop). */
async function firstAvailable(
  candidates: string[],
  has: (command: string) => boolean | Promise<boolean>
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Probe one vendor's readiness. Order of resolution:
 *  1. binary present?  → installed
 *  2. resolve trusted provider/API-key evidence
 *  3. run the vendor's own auth/whoami command
 * An explicitly selected custom provider owns the verdict. Otherwise positive
 * native login wins, with direct provider evidence as the fallback when the
 * native-login probe is negative or unavailable.
 */
export async function probeVendorReadiness(
  vendor: string,
  opts: ProbeOptions = {}
): Promise<VendorReadiness> {
  const spec = VENDOR_READINESS_PROBES.find((entry) => entry.vendor === vendor);
  if (!spec) {
    return {
      vendor,
      installed: false,
      authenticated: false,
      detail: `unknown vendor '${vendor}'`,
    };
  }

  const exec = opts.exec ?? runBoundedVendorCommand;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const has = opts.hasCommand ?? commandExistsAsync;

  const installedBin = await firstAvailable(spec.installedCandidates, has);
  if (!installedBin) {
    return {
      vendor,
      installed: false,
      authenticated: false,
      detail: `${spec.displayName} CLI not found (expected one of: ${spec.installedCandidates.join(", ")})`,
      fixHint: spec.installHint,
    };
  }

  // A vendor MUON drives through another vendor's runtime is only installed when
  // that runtime is present too — otherwise nothing can be spawned.
  if (spec.runtimeRequirement) {
    const runtimeBin = await firstAvailable(
      spec.runtimeRequirement.candidates,
      has
    );
    if (!runtimeBin) {
      return {
        vendor,
        installed: false,
        authenticated: false,
        detail: spec.runtimeRequirement.detail,
        fixHint: spec.runtimeRequirement.fixHint,
      };
    }
  }

  const authProbeBin = await firstAvailable(spec.authCandidates, has);
  const probeBin = authProbeBin ?? installedBin;
  const resolveCredentials =
    opts.resolveCredentials ?? resolveVendorCredentialEvidence;

  // R2: the three evidence sources are INDEPENDENT — a version print, a
  // read-only auth probe, and an environment/provider inspection — so they run
  // concurrently instead of one after another. Measured on this machine, Cursor
  // paid the whole `--version` (497ms) before `status` (3363ms) even started.
  //
  // No verdict changes: each source keeps its OWN failure handling (below), and
  // none of them reads what another writes. What is deliberately NOT hoisted in
  // here is the `firstAvailable` resolution above — the auth probe must run
  // against the binary that answers auth, and that has to be known first.
  let cliVersion: string | undefined;
  let credentialEvidence: VendorCredentialEvidence = {
    ready: false,
    environmentKeys: [],
  };
  let verdict: AuthVerdict | undefined;
  let probeFailure:
    | {
        detail: string;
        fixHint: string;
      }
    | undefined;
  await Promise.all([
    // Provider/version fingerprint (P0.1 checkpoint+resume): one extra probe
    // through the same injectable exec seam, only when installed. Any failure
    // simply omits the field — honest absence, never a guess.
    (async () => {
      try {
        const versionResult = await exec(
          installedBin,
          spec.versionArgs,
          timeoutMs
        );
        if (!versionResult.error) {
          const firstLine = versionResult.stdout
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0);
          // Only accept a line that actually LOOKS like a version (a dotted
          // numeric token). A CLI that prints anything else on line 1 (usage
          // text, or worse, something secret-shaped) is omitted — the
          // no-credential-material invariant outranks version evidence.
          if (firstLine && /\d+\.\d+/.test(firstLine)) {
            cliVersion = firstLine.slice(0, 100);
          }
        }
      } catch {
        // Version evidence is additive; a probe crash never degrades readiness.
      }
    })(),
    (async () => {
      try {
        credentialEvidence = await resolveCredentials(vendor);
      } catch {
        // Provider inspection is additive. Any resolver failure degrades to the
        // established native-login behavior.
      }
    })(),
    (async () => {
      try {
        const result = await exec(probeBin, spec.authArgs, timeoutMs);
        if (result.error) {
          probeFailure = {
            detail: `auth probe could not run (${result.error.message})`,
            fixHint: spec.loginHint(probeBin),
          };
        } else {
          verdict = spec.interpret(result);
        }
      } catch (error) {
        probeFailure = {
          detail: `auth probe error: ${
            error instanceof Error ? error.message : String(error)
          }`,
          fixHint: spec.loginHint(probeBin),
        };
      }
    })(),
  ]);
  const versionEvidence = cliVersion !== undefined ? { cliVersion } : {};

  if (
    vendor === "codex" &&
    credentialEvidence.method === "custom-provider"
  ) {
    // The effective Codex provider owns execution. A cached ChatGPT login is
    // valid native-account evidence, but it cannot authenticate an explicitly
    // selected Azure/proxy provider or compensate for that provider's missing
    // env_key. Keep readiness aligned with the child that MUON will launch.
    if (
      authProbeBin &&
      credentialEvidence.ready &&
      credentialEvidence.detail
    ) {
      return {
        vendor,
        installed: true,
        authenticated: true,
        credentialMethod: "custom-provider",
        detail: credentialEvidence.detail,
        authState: "confirmed",
        ...versionEvidence,
      };
    }
    if (credentialEvidence.detail) {
      return {
        vendor,
        installed: true,
        authenticated: false,
        detail: credentialEvidence.detail,
        fixHint:
          "configure the active Codex provider credential in MUON's environment, then refresh readiness",
        authState: "provider-unconfigured",
        ...versionEvidence,
      };
    }
  }

  if (verdict?.authenticated) {
    return {
      vendor,
      installed: true,
      authenticated: true,
      credentialMethod: "vendor-login",
      detail: verdict.detail,
      authState: "confirmed",
      ...versionEvidence,
    };
  }

  if (
    authProbeBin &&
    credentialEvidence.ready &&
    credentialEvidence.method &&
    credentialEvidence.detail
  ) {
    return {
      vendor,
      installed: true,
      authenticated: true,
      credentialMethod: credentialEvidence.method,
      detail: credentialEvidence.detail,
      // The BYOK branch: probe order guarantees a usable provider/API-key
      // account is authenticated:true with confirmed provenance.
      authState: "confirmed",
      ...versionEvidence,
    };
  }

  if (probeFailure) {
    // The probe could not run at all: `authenticated` stays false (existing
    // consumers unchanged), but the tri-state records UNKNOWN, never a
    // negative — a probe timeout must not read as "signed out".
    return {
      vendor,
      installed: true,
      authenticated: false,
      ...probeFailure,
      authState: "unknown",
      ...versionEvidence,
    };
  }

  return {
    vendor,
    installed: true,
    authenticated: false,
    detail: verdict?.detail ?? "authentication could not be confirmed",
    fixHint: spec.loginHint(probeBin),
    authState: "negative",
    ...versionEvidence,
  };
}

/** Probe every known vendor concurrently. */
export async function probeAllVendorReadiness(
  opts: ProbeOptions = {}
): Promise<VendorReadiness[]> {
  return Promise.all(
    VENDOR_READINESS_PROBES.map((spec) =>
      probeVendorReadiness(spec.vendor, opts)
    )
  );
}

/** The crew roles a lane may hold, or `[]` for a vendor MUON does not manage. */
export function vendorDispatchRoles(vendor: string): readonly AgentRole[] {
  return (
    VENDOR_READINESS_PROBES.find((spec) => spec.vendor === vendor)
      ?.dispatchRoles ?? []
  );
}

/** True when a lane can hold at least one role that may WRITE to the workspace. */
function vendorCanWrite(vendor: string): boolean {
  return vendorDispatchRoles(vendor).some(
    (role) => ROLE_SPECS[role].authority === "write"
  );
}

/**
 * True when at least one lane that can actually DO the work is ready.
 *
 * "Ready" here answers the onboarding question "can this user get an
 * implementation dispatched at all", so a lane whose entire role ceiling is
 * read-only (Cursor, OpenCode) does not satisfy it on its own — a machine with
 * only a reviewer cannot produce a change to review.
 *
 * This used to be spelled `entry.vendor !== "cursor"`, from when Cursor was not
 * a managed lane at all. That hardcoding silently became wrong when Cursor
 * BECAME dispatchable for read-only roles. Deriving it from the role model
 * fixes that and cannot drift again — which is what let the Ollama→OpenCode
 * swap land here as a pure data change: Ollama's ceiling included `docs` (a
 * WRITE role, so it DID count toward "ready"), OpenCode's is `scout` alone (so
 * it does not), and neither fact is spelled anywhere in this function.
 */
export function anyVendorReady(readiness: VendorReadiness[]): boolean {
  return readiness.some(
    (entry) => entry.installed && entry.authenticated && vendorCanWrite(entry.vendor)
  );
}

/**
 * Look up one vendor's readiness (installed AND authenticated), optionally for a
 * SPECIFIC role. Without a role this is the honest answer to "is this lane
 * usable at all" — including Cursor, which is a real managed lane for read-only
 * roles. Pass `role` to ask the sharper question the dispatch path cares about:
 * can this lane be dispatched AS a reviewer / implementer / …
 */
export function vendorIsReady(
  readiness: VendorReadiness[],
  vendor: string,
  role?: AgentRole
): boolean {
  const entry = readiness.find((item) => item.vendor === vendor);
  if (!entry || !entry.installed || !entry.authenticated) {
    return false;
  }
  const roles = vendorDispatchRoles(vendor);
  // An unmanaged vendor key is never "ready" for dispatch.
  if (roles.length === 0) {
    return false;
  }
  return role === undefined ? true : roles.includes(role);
}

// ---- Short-lived cache -----------------------------------------------------
//
// Each probe spawns processes, so the LOCAL backend caches the last result for
// a few seconds. Every dispatch and every runner tick then reads readiness
// without hammering the vendor CLIs. A freshly-logged-in user sees the change
// within the TTL, and the onboarding wizard can force a refresh.

export const DEFAULT_READINESS_TTL_MS = 8000;

let cache: { at: number; value: VendorReadiness[] } | null = null;
/**
 * R1: the single in-flight (non-refresh) probe set.
 *
 * The TTL alone does nothing for callers that arrive on an EXPIRED cache at the
 * same moment: each of them used to launch its own full probe set. Measured on
 * this machine with all four lanes installed and logged in, three concurrent
 * callers took 5576ms against 3717ms for one, because the vendor CLIs were being
 * spawned three times over. The desktop shields itself with a display cache, but
 * the CLI, TUI, MCP and runner all share this function and had no such cover.
 *
 * Joining an in-flight probe cannot stale a verdict beyond what this cache
 * already accepts: the joiner receives a result from a probe that started at
 * most one probe-duration earlier, which is well inside the TTL it would
 * otherwise have been served from outright.
 */
let inFlight: Promise<VendorReadiness[]> | null = null;

export type CachedReadinessOptions = ProbeOptions & {
  /** Cache lifetime. */
  ttlMs?: number;
  /** Bypass the cache and re-probe now (post-login refresh). */
  refresh?: boolean;
};

export async function getVendorReadinessCached(
  opts: CachedReadinessOptions = {}
): Promise<VendorReadiness[]> {
  const ttlMs = opts.ttlMs ?? DEFAULT_READINESS_TTL_MS;
  const now = Date.now();
  if (opts.refresh) {
    // R1 SAFETY BOUNDARY: a refresh NEVER joins, and is never joined.
    //
    // `refresh: true` means "something just changed, re-ask NOW" — it is what
    // the runner calls right after a login so a job is not permanently failed on
    // a stale "not logged in". A refresh that joined a probe which STARTED
    // before that login would receive the pre-login verdict and fail the job on
    // it: a dedupe that turned a fresh answer into a stale refusal. So a refresh
    // always spawns its own set, and is deliberately not published as the
    // in-flight slot for others to join.
    const refreshed = await probeAllVendorReadiness(opts);
    cache = { at: Date.now(), value: refreshed };
    return refreshed;
  }
  if (cache && now - cache.at < ttlMs) {
    return cache.value;
  }
  if (inFlight) {
    return inFlight;
  }
  const probe = probeAllVendorReadiness(opts).then((value) => {
    // Stamped on COMPLETION, not on start: the TTL then measures how old the
    // answer is, never how long ago someone asked for it.
    cache = { at: Date.now(), value };
    return value;
  });
  inFlight = probe;
  try {
    return await probe;
  } finally {
    // Only clear OUR slot: a `clearVendorReadinessCache()` between start and
    // settle (tests, a forced re-check) may already have replaced it, and
    // blanking someone else's in-flight probe would resurrect the stampede.
    if (inFlight === probe) {
      inFlight = null;
    }
  }
}

/** Drop the cache (tests, or a forced re-check). */
export function clearVendorReadinessCache(): void {
  cache = null;
  inFlight = null;
}
