import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  sandboxRequiredByEnv,
  sandboxedRunnerEnv,
  selectSandboxLauncher,
} from "@muon/adapters";
import {
  authorizeRunnerLease,
  resolveAgentToken,
  resolveApiBase,
  resolveApiToken,
  resolveDataDir,
  type MuonApiClient,
} from "@muon/client";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type EnsureRunnerResult = {
  /** A runner is confirmed live (was already up, or we started one). */
  live: boolean;
  /** We spawned a runner process this call. */
  started: boolean;
  /** Whether the runner we started is confined by the OS sandbox (ADR-0010 A2). */
  sandboxed?: boolean;
  /** Where a spawned runner's logs go (for debugging a failed start). */
  logPath?: string;
  note?: string;
  /**
   * The ORIGINAL error behind a `note`, when there was one. Callers that
   * re-throw the note must attach it as `cause`
   * (`new Error(note, { cause: failure })`) so `isAuthorizationFailure` can
   * still classify a lease 401/403 and the exit-2 contract survives the
   * string boundary.
   */
  failure?: unknown;
};

/**
 * Guarantees a persistent runner is available before the chat dispatches, so
 * jobs don't sit queued forever. If one is already live, it no-ops. Otherwise
 * it spawns a DETACHED `muon runner` from the same entrypoint that launched us
 * and waits briefly to confirm it came online. Failing to start is reported,
 * never fatal, the human can always run `muon runner` by hand.
 *
 * ADR-0010 Part A / A2, sandbox the WHOLE runner. Dispatched claude runs the
 * Agent SDK IN-PROCESS inside the runner (execute.ts: kind `auto`/`session` →
 * startManagedSession → ClaudeSessionDriver), so a per-spawn wrapper can't
 * confine it. We instead wrap the runner's own spawn in a Seatbelt profile that
 * blinds it (and the in-process SDK + every child it spawns) to the MUON data
 * dir, closing F2's read vector for the flagship dispatched-claude path. Since
 * the sandboxed runner can no longer read `brain.lock`, trusted CLI code first
 * operator-authorizes a narrow launch lease, then hands the child only the
 * brain URL + AGENT token + that lease via a HYGIENIC env (operator token
 * stripped, see `sandboxedRunnerEnv`). Degrades to an unsandboxed runner rather
 * than blocking dispatch, but never leaves a sandboxed + unsandboxed pair
 * racing (F-3).
 */
export async function ensureRunner(
  client: MuonApiClient,
  opts: {
    /** RESOLVED base, forwarded to the spawned runner's `--api-base`. */
    apiBase?: string;
    /**
     * The RAW `--api-base` flag (undefined when not given). Drives the
     * token↔base pairing rule in the resolvers: a flag-supplied base must
     * never receive the local brain's lockfile credentials. Passing the
     * RESOLVED base here instead would mark the auto-discovered local brain
     * as "explicit" and break ordinary lockfile auth — keep the two apart.
     */
    apiBaseFlag?: string;
    /** The RAW `--api-token` flag: the operator credential when supplied. */
    apiTokenFlag?: string;
    confirmMs?: number;
  } = {}
): Promise<EnsureRunnerResult> {
  const initial = await client
    .getRunner()
    .catch(() => ({ runner: null, live: false }));
  if (initial.live) {
    return { live: true, started: false };
  }

  const entry = process.argv[1];
  if (!entry) {
    return {
      live: false,
      started: false,
      note: "could not locate the muon entrypoint to auto-start a runner; run `muon runner` manually",
    };
  }

  // UNPREDICTABLE name + O_EXCL create (in spawnRunner): `muon-runner.log`
  // was a fixed name in the world-shared /tmp, and `openSync(path, "a", 0600)`
  // applies the mode only when it CREATES the file — a pre-planted file (or
  // symlink) at the known path was followed and appended to as this user. The
  // random name removes the rendezvous; exclusive-create refuses anything
  // pre-planted. Generated PER SPAWN ATTEMPT: one shared path + O_EXCL made
  // the second (unsandboxed-fallback) spawn EEXIST and silently fail, so the
  // ADR-0010 degradation path could never fire. `logPath` tracks the latest
  // attempt for the result's reporting.
  const newLogPath = () =>
    join(tmpdir(), `muon-runner-${randomBytes(6).toString("hex")}.log`);
  let logPath = newLogPath();
  const host = hostname();
  const runnerArgs = [entry, "runner", "--host", host];
  if (opts.apiBase) {
    runnerArgs.push("--api-base", opts.apiBase);
  }

  // Resolve the brain URL + AGENT token NOW, while we (the CLI) are unsandboxed
  // and can still read the lockfile. A sandboxed runner is blinded to the data
  // dir, so `sandboxedRunnerEnv` hands it the base + agent token + preauthorized
  // launch lease via env (no lockfile read) with the OPERATOR token stripped
  // (F-2). The RAW flag values ride along: no-arg calls here dropped a
  // `--api-token` operator credential (the lease POST 401'd) and skipped the
  // pairing rule, sending the local lockfile tokens to a `--api-base` host.
  const agentToken = resolveAgentToken(undefined, opts.apiBaseFlag);
  const operatorToken = resolveApiToken(opts.apiTokenFlag, opts.apiBaseFlag);
  const apiBase = resolveApiBase(opts.apiBase);
  const dataDir = resolveDataDir();
  const launcher = selectSandboxLauncher();
  const leaseToken = randomBytes(32).toString("hex");

  // Track the child we spawn so a slow-but-ALIVE sandboxed boot never triggers a
  // second (unsandboxed) runner, F-3: at most one runner per host, deterministic
  // sandbox coverage.
  let child: ChildProcess | null = null;
  let childExited = false;
  // What the LAST spawn attempt actually was: the final "did not report live"
  // return used to claim `sandboxed: wantSandbox` even after the fallback path
  // had respawned UNSANDBOXED — so a slow unsandboxed runner that came online
  // late was on record as confined. Only read after a spawn, which always
  // stamps it first.
  let lastSpawnSandboxed = false;

  const spawnRunner = (sandboxed: boolean): boolean => {
    // A FRESH exclusive path per attempt (see newLogPath above) — reusing one
    // path made the fallback attempt EEXIST and silently fail.
    logPath = newLogPath();
    let out: number | null = null;
    try {
      // Owner-only (0600) + exclusive-create: this exact path must not exist
      // yet, so nothing pre-planted can be followed.
      out = openSync(logPath, "ax", 0o600);
      const wrapped = sandboxed
        ? launcher.wrap(process.execPath, runnerArgs, { dataDir })
        : { command: process.execPath, args: runnerArgs, sandboxed: false };
      // Every runner boots from a HYGIENIC env: agent capability + its narrow
      // launch lease, never operator/cloud/database credentials. An
      // unsandboxed fallback can still read user files (documented residual),
      // but it no longer receives unrelated secrets by inheritance.
      const env = sandboxedRunnerEnv({
        apiBase,
        agentToken,
        leaseToken,
        sandboxed: wrapped.sandboxed,
        parentEnv: {
          ...process.env,
          MUON_RUNNER_HOST: host,
        },
      });
      const spawned = spawn(wrapped.command, wrapped.args, {
        detached: true,
        stdio: ["ignore", out, out],
        env,
      });
      childExited = false;
      const markExited = () => {
        if (child === spawned) {
          childExited = true;
        }
      };
      spawned.on("error", markExited);
      spawned.on("exit", markExited);
      spawned.unref();
      child = spawned;
      // Only a SUCCESSFUL spawn stamps the sandbox honesty field — stamping
      // before the try meant a failed attempt re-labeled a still-running
      // earlier runner.
      lastSpawnSandboxed = sandboxed;
      return true;
    } catch {
      return false;
    } finally {
      // The child holds its own duplicate; the parent's fd would otherwise
      // leak once per spawn in a long-lived `muon chat`.
      if (out !== null) {
        try {
          closeSync(out);
        } catch {
          /* already closed */
        }
      }
    }
  };

  const confirmLive = async (deadlineMs: number): Promise<boolean> => {
    // Confirm it actually came online (dev launched via tsx can't re-exec a .ts
    // entry with node, so the spawn may no-op, we surface that honestly).
    let waited = 0;
    while (waited < deadlineMs) {
      await delay(500);
      waited += 500;
      const state = await client
        .getRunner()
        .catch(() => ({ runner: null, live: false }));
      if (state.live) {
        return true;
      }
    }
    return false;
  };

  const wantSandbox = launcher.isAvailable();
  const requireSandbox = sandboxRequiredByEnv();
  // FAIL-CLOSED (MUON_REQUIRE_SANDBOX=1): never start an UNSANDBOXED runner. When
  // confinement is unavailable (non-macOS, sandbox-exec missing, or
  // MUON_SANDBOX=0), REFUSE to dispatch rather than expose the operator token in
  // brain.lock to an unconfined same-uid vendor agent (the ADR-0010 residual,
  // made opt-in-strict). Default (unset) keeps the documented graceful fallback.
  if (requireSandbox && !wantSandbox) {
    return {
      live: false,
      started: false,
      // No logPath: nothing was spawned, so the log file was never created.
      note: "MUON_REQUIRE_SANDBOX=1 but sandbox confinement is unavailable (non-macOS, sandbox-exec missing, or MUON_SANDBOX=0), refusing to start an UNSANDBOXED runner. Run on macOS with sandbox-exec, or unset MUON_REQUIRE_SANDBOX to allow the documented degraded fallback.",
    };
  }

  // MINT THE LEASE ONLY AFTER EVERY REFUSAL GATE ABOVE.
  //
  // `POST /api/runner/lease` is DESTRUCTIVE: it overwrites the host's leaseHash
  // and nulls its pid, so the incumbent runner's next heartbeat 409s and it
  // aborts in-flight vendor jobs and dies. Minting before the fail-closed check
  // meant a healthy runner whose heartbeat had merely slipped past the 15s live
  // window (sleep/resume, load spike) was fenced and killed — and then the CLI
  // refused to start a replacement. A safety knob must never be the thing that
  // ends the fleet.
  try {
    await authorizeRunnerLease({ apiBase, operatorToken }, host, leaseToken);
  } catch (error) {
    return {
      live: false,
      started: false,
      // No logPath: the refusal happened before any spawn created the file.
      note: `could not authorize the runner launch: ${
        error instanceof Error ? error.message : String(error)
      }`,
      failure: error,
    };
  }
  // A Seatbelt profile compile + a cold node under the sandbox can exceed a 4s
  // window; give the sandboxed cold start more room before judging it failed.
  const confirmMs = opts.confirmMs ?? (wantSandbox ? 8000 : 4000);

  if (!spawnRunner(wantSandbox)) {
    return {
      live: false,
      started: false,
      note: "could not spawn a runner; run `muon runner` manually",
      logPath,
    };
  }

  if (await confirmLive(confirmMs)) {
    return {
      live: true,
      started: true,
      sandboxed: wantSandbox,
      logPath,
      note: wantSandbox
        ? undefined
        : "runner is UNSANDBOXED (sandbox-exec unavailable or MUON_SANDBOX=0), unsandboxed: a dispatched agent could read the operator token",
    };
  }

  // Graceful degradation (ADR-0010, non-negotiable) WITHOUT a double-spawn (F-3):
  //  - if the sandboxed child DIED, Seatbelt likely broke → retry UNSANDBOXED
  //    (safe: a dead child can't also be live, so never two runners at once);
  //  - if it is still ALIVE, it is merely a slow cold start → leave it to come
  //    online; NEVER spawn a second runner racing it.
  if (wantSandbox) {
    const late = await client
      .getRunner()
      .catch(() => ({ runner: null, live: false }));
    if (late.live) {
      return { live: true, started: true, sandboxed: true, logPath };
    }
    if (childExited && !requireSandbox) {
      if (spawnRunner(false) && (await confirmLive(4000))) {
        return {
          live: true,
          started: true,
          sandboxed: false,
          logPath,
          note: `sandboxed runner failed to start, fell back to UNSANDBOXED (ADR-0010 residual). Check ${logPath}`,
        };
      }
    } else if (!childExited) {
      return {
        live: false,
        started: true,
        sandboxed: true,
        logPath,
        note: `sandboxed runner is still starting (cold Seatbelt boot), it should come online shortly; check ${logPath} if it does not`,
      };
    }
  }

  return {
    live: false,
    started: true,
    sandboxed: lastSpawnSandboxed,
    logPath,
    note: `started a runner but it did not report live within ${Math.round(
      confirmMs / 1000
    )}s, check ${logPath}, or run \`muon runner\` manually`,
  };
}
