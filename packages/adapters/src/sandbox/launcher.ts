/**
 * Agent sandbox, the `SandboxLauncher` seam (ADR-0010 Part A).
 *
 * A launcher wraps a spawn so an UNTRUSTED, dispatched vendor process runs under
 * an OS sandbox that BLINDS it to the MUON data dir (the operator token in
 * `brain.lock`, `muon.db`, and `graph/`), closing F2's read vector, while
 * still letting the vendor read its own auth/config/caches, write its workspace
 * + state + tmp, and reach its model API. Platform impls live behind this seam:
 * macOS `sandbox-exec` (Seatbelt) in `./seatbelt.ts`; a NO-OP everywhere else.
 *
 * Non-negotiable degradation (ADR-0010 residual #1): when confinement is
 * unavailable or disabled (`MUON_SANDBOX=0`), `wrap` returns the command
 * UNCHANGED so the user's own CLI is never hard-failed, sandboxing is the only
 * added step, so removing it is a zero-behavior-change fallback.
 */

import { allVendorCredentialEnvKeys, vendorsWhere } from "@muon/protocol";
import { ALL_LANE_GUARD_ENV_KEYS } from "../lane-guard-env.js";
import { resolveVendorCredentialEvidence } from "../provider-credentials.js";
import { OPERATOR_TOKEN_ENV_VARS } from "./credential-policy.js";

export { OPERATOR_TOKEN_ENV_VARS } from "./credential-policy.js";

/** Options threaded into a sandbox wrap. */
export type SandboxWrapOptions = {
  /**
   * The MUON data dir the confined process must be BLINDED to (deny
   * `file-read*` + `file-write*`). Blinds `brain.lock` (operator token),
   * `muon.db`, and `graph/`. This is the F2 read-vector closure. REQUIRED.
   */
  dataDir: string;
  /**
   * Directories the confined process may WRITE. When set, writes OUTSIDE these
   * roots (and tmp/devices) are denied, the per-spawn (A1) / test posture that
   * confines a vendor to its task workspace. When omitted, writes stay open
   * except the data dir, the whole-runner (A2) posture, since the long-lived
   * runner serves many task workspaces not known at spawn time.
   */
  writeRoots?: string[];
  /**
   * Loopback (the MUON MCP server) + the vendor's model egress. v1 default is
   * `true`, network tightening is a later phase; never break model calls now.
   */
  allowNetwork?: boolean;
  /**
   * Per-vendor escape valve: extra subpaths a specific vendor legitimately
   * writes outside the profile (its own state dirs). Only used when `writeRoots`
   * confines writes.
   */
  allowWriteExtra?: string[];
};

/** The result of a wrap: the command to actually spawn, and whether it is confined. */
export type WrappedCommand = {
  command: string;
  args: string[];
  /** True when an OS sandbox was applied; false when it degraded to unchanged. */
  sandboxed: boolean;
};

/** A launcher wraps a command so it runs under an OS sandbox (or unchanged). */
export interface SandboxLauncher {
  /** Whether this launcher can actually confine on this host right now. */
  isAvailable(): boolean;
  /**
   * Returns the (possibly rewritten) command+args to spawn. When confinement is
   * unavailable/disabled, returns the command UNCHANGED with `sandboxed:false`
   * (graceful degradation, never hard-fail the user's own CLI).
   */
  wrap(command: string, args: string[], opts: SandboxWrapOptions): WrappedCommand;
}

/**
 * The explicit escape hatch (ADR-0010): `MUON_SANDBOX=0` (also `false`/`off`)
 * disables confinement everywhere, degrading to the no-op launcher.
 */
export function sandboxDisabledByEnv(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const flag = env.MUON_SANDBOX?.trim().toLowerCase();
  return flag === "0" || flag === "false" || flag === "off";
}

/**
 * FAIL-CLOSED opt-in (security hardening, closes the non-macOS / `MUON_SANDBOX=0`
 * fail-OPEN residual). `MUON_REQUIRE_SANDBOX=1` (also `true`/`on`) makes runner
 * spawn REFUSE to start an UNSANDBOXED runner: when confinement is unavailable
 * (non-macOS, `sandbox-exec` missing, or `MUON_SANDBOX=0`), the dispatch is
 * declined rather than exposing the operator token in `brain.lock` to an
 * unconfined same-uid vendor agent. Default (unset) preserves the documented
 * graceful degradation (ADR-0010 residual #1) so the user's CLI is never
 * hard-failed on a host that simply can't sandbox.
 */
export function sandboxRequiredByEnv(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const flag = env.MUON_REQUIRE_SANDBOX?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on";
}

/**
 * Environment inherited by the untrusted runner. Keep this deliberately small:
 * process.env commonly carries deployment, cloud, package-registry, and database
 * credentials that have nothing to do with a local vendor CLI.
 *
 * Vendor OAuth remains owned by each installed CLI (its own config/keychain).
 * Static API-key names are the explicit fallback contract. The active trusted
 * provider configuration may add an exact resolver-validated credential name
 * below; repository text can never nominate one.
 */
export const RUNNER_ENV_ALLOWLIST = [
  // Process/runtime discovery.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  // Windows process discovery for the degrade-safe non-Seatbelt path.
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  // Enterprise certificate roots without arbitrary Node code injection.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  // Explicit vendor API-key fallback + endpoint roots. WAVE C5: the union of
  // every registry entry's `credentials.envKeys`, so a vendor added with a key
  // MUON never allowlisted here would be silently starved rather than silently
  // served. Registry order, deduped, positive construction.
  ...allVendorCredentialEnvKeys(),
  // Vendor CONFIG ROOTS (`CODEX_HOME`). Not credentials — MUON's lane guards
  // OWN these on a child — but the runner must still be able to FIND an
  // operator who relocated their own vendor install, because that is where
  // their login lives. `lane-runner.ts` is what stops the ambient value
  // reaching any child; see lane-guard-env.ts for both halves.
  ...ALL_LANE_GUARD_ENV_KEYS,
  // Desktop runner bootstrap values supplied by the trusted parent.
  "ELECTRON_RUN_AS_NODE",
  "MUON_RUNNER_HOST",
  // Profile COORDINATES, not credentials. The runner and the brain must derive
  // the SAME governed-worktree root (`managedWorktreesRoot`); a runner that
  // falls back to the default profile while the brain runs an explicit one
  // creates task trees the backend's execution-path/containment checks then
  // refuse (observed live 2026-08-04: desktop brain on its userData profile,
  // runner on the fallback). The sandboxed runner never READS the data dir —
  // it stays Seatbelt-blinded — these values only feed path computation.
  "MUON_DATA_DIR",
  "MUON_WORKTREE_ROOT",
  // Non-secret operator preference. The desktop writes an explicit 0/1 and
  // restarts the runner when it changes, so runner reconciliation cannot drift
  // from the UI's consent posture.
  "MUON_AUTO_CONTINUE",
  // Explicit dev/test-only packaged process-tree proof.
  "MUON_FAKE_VENDOR",
  "MUON_FAKE_VENDOR_DESCENDANT_FILE",
] as const;

/**
 * WAVE C5: a positive projection of `credentials.forwardToRunner`, not a list.
 * A vendor is resolved into the long-lived runner's env only where the registry
 * says so; opencode (BYO-provider) and the dev/test fake state `false`, so they
 * contribute nothing and cannot start contributing by omission later.
 */
const RUNNER_VENDOR_CREDENTIALS = vendorsWhere(
  (entry) => entry.credentials.forwardToRunner
);

/**
 * Build the env for a dispatched (untrusted) runner spawn: the brain URL + the
 * AGENT token only, with the OPERATOR token STRIPPED (ADR-0010 F-2). The agent
 * token is safe to expose, the agent is entitled to it and it cannot govern
 * once Part B's route gate holds, but the operator token is the crown jewel and
 * must never enter the runner's address space. Setting `MUON_API_BASE` also
 * makes the runner resolve base+token from env (no lockfile read) and
 * short-circuits the CLI preAction's `ensureBrain` (a data-dir write that would
 * EPERM under the sandbox). `MUON_SANDBOX_ACTIVE` advertises the confinement.
 */
export function sandboxedRunnerEnv(opts: {
  apiBase: string;
  agentToken?: string;
  /** Narrow, operator-authorized launch capability; never forwarded to vendors. */
  leaseToken?: string;
  sandboxed: boolean;
  /**
   * Full-Auto operator standing consent active: set MUON_FULL_AUTO=1 in the
   * detached runner so the worker choke point threads the FULL-AUTO safety block
   * into every dispatched worker/delegate preamble. Set explicitly from opts (never
   * inherited from the parent env), so OFF deletes the key — reversible by respawn.
   */
  fullAuto?: boolean;
  parentEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const parent = opts.parentEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of RUNNER_ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // The long-lived runner is itself a sanitization boundary. Preserve only
  // credentials selected by trusted user-level vendor configuration so the
  // later per-lane child filter can still deliver them to the matching vendor.
  // Values never enter argv, logs, events, renderer state, or durable storage.
  for (const vendor of RUNNER_VENDOR_CREDENTIALS) {
    const evidence = resolveVendorCredentialEvidence(vendor, { env: parent });
    for (const key of evidence.environmentKeys) {
      const value = parent[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }
  env.MUON_API_BASE = opts.apiBase;
  if (opts.agentToken) {
    env.MUON_AGENT_TOKEN = opts.agentToken;
  } else {
    // Never inherit a stale agent token from the parent env.
    delete env.MUON_AGENT_TOKEN;
  }
  if (opts.leaseToken) {
    env.MUON_RUNNER_LEASE_TOKEN = opts.leaseToken;
  } else {
    delete env.MUON_RUNNER_LEASE_TOKEN;
  }
  if (opts.sandboxed) {
    env.MUON_SANDBOX_ACTIVE = "1";
  } else {
    delete env.MUON_SANDBOX_ACTIVE;
  }
  // Full-Auto standing consent carrier: set explicitly from opts (not the
  // allowlist), so OFF drops the key on the next respawn — the reversibility hinge.
  if (opts.fullAuto) {
    env.MUON_FULL_AUTO = "1";
  } else {
    delete env.MUON_FULL_AUTO;
  }
  return env;
}

/**
 * No-op launcher: returns the command unchanged. Used on non-macOS, when
 * `sandbox-exec` is absent, or when `MUON_SANDBOX=0`. Wrapping is the only added
 * step, so this is a zero-behavior-change fallback.
 */
export class NoopSandboxLauncher implements SandboxLauncher {
  isAvailable(): boolean {
    return false;
  }

  wrap(command: string, args: string[]): WrappedCommand {
    return { command, args, sandboxed: false };
  }
}
