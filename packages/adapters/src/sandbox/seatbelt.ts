import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NoopSandboxLauncher,
  sandboxDisabledByEnv,
  type SandboxLauncher,
  type SandboxWrapOptions,
  type WrappedCommand,
} from "./launcher.js";

/**
 * macOS `sandbox-exec` (Seatbelt) confinement (ADR-0010 Part A). Apple-
 * deprecated but functional (Chrome and codex itself use it); no signing, no
 * admin, no uid creation, it wraps the spawn only.
 */
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Canonicalize a path so Seatbelt's realpath-based matching works: `/var` →
 * `/private/var`, `/tmp` → `/private/tmp`, symlinked workspaces, etc. Falls back
 * to an absolute resolve when the path does not exist yet.
 */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Escape a path for a Seatbelt double-quoted string literal. */
function sbplLiteral(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a Seatbelt (SBPL) profile that BLINDS the confined process to the MUON
 * data dir while leaving the vendor's own needs intact.
 *
 *  - `(allow default)`, permissive baseline: process-exec/fork, mach lookups,
 *    sysctl, and (v1) network stay allowed, so the vendor CLI and its model
 *    calls run normally. We then subtract only F2's two vectors.
 *  - `(deny file-read* (subpath dataDir))`, the F2 read-vector closure:
 *    `brain.lock` (operator token), `muon.db`, and `graph/` become unreadable.
 *    `cat brain.lock` ⇒ EPERM.
 *  - `(deny file-write* (subpath dataDir))`, the untrusted process may not
 *    tamper with the brain's own state either.
 *  - WRITE confinement (only when `writeRoots` is given): deny writes by
 *    default, then re-allow the workspace(s) + tmp + `/dev` (+ per-vendor
 *    extras). The data-dir write-deny is re-asserted LAST so it always wins.
 *  - Network: allowed in v1 (loopback for the MUON MCP server + model egress);
 *    `allowNetwork:false` narrows to loopback only (a later phase).
 */
export function buildSeatbeltProfile(opts: SandboxWrapOptions): string {
  const dataDir = canonical(opts.dataDir);
  const confineWrites =
    Array.isArray(opts.writeRoots) && opts.writeRoots.length > 0;
  const allowNetwork = opts.allowNetwork !== false;

  const lines: string[] = ["(version 1)", "(allow default)"];

  // --- READ confinement (the F2 closure) ------------------------------------
  lines.push(`(deny file-read* (subpath "${sbplLiteral(dataDir)}"))`);
  lines.push(`(deny file-write* (subpath "${sbplLiteral(dataDir)}"))`);

  // --- WRITE confinement (workspace-scoped; A1 / tests) ---------------------
  if (confineWrites) {
    lines.push("(deny file-write*)");
    for (const root of opts.writeRoots ?? []) {
      lines.push(`(allow file-write* (subpath "${sbplLiteral(canonical(root))}"))`);
    }
    // Vendors need scratch + std devices even when workspace-confined.
    lines.push(`(allow file-write* (subpath "${sbplLiteral(canonical(tmpdir()))}"))`);
    lines.push('(allow file-write* (subpath "/private/tmp"))');
    lines.push('(allow file-write* (subpath "/dev"))');
    for (const extra of opts.allowWriteExtra ?? []) {
      lines.push(`(allow file-write* (subpath "${sbplLiteral(canonical(extra))}"))`);
    }
    // Re-assert LAST so the data-dir write-deny wins even if a write root
    // happens to contain it.
    lines.push(`(deny file-write* (subpath "${sbplLiteral(dataDir)}"))`);
  }

  // --- Network --------------------------------------------------------------
  if (!allowNetwork) {
    lines.push("(deny network*)");
    // Keep loopback so the vendor can still reach the MUON MCP server.
    lines.push('(allow network* (remote ip "localhost:*"))');
  }

  return `${lines.join("\n")}\n`;
}

/**
 * macOS Seatbelt launcher. `isAvailable()` probes `/usr/bin/sandbox-exec` and
 * honors the `MUON_SANDBOX=0` escape hatch; `wrap` prepends
 * `sandbox-exec -p <profile>` to the spawn (or returns it unchanged when
 * unavailable, graceful degradation).
 */
export class SeatbeltSandboxLauncher implements SandboxLauncher {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  isAvailable(): boolean {
    return (
      process.platform === "darwin" &&
      !sandboxDisabledByEnv(this.env) &&
      existsSync(SANDBOX_EXEC)
    );
  }

  wrap(
    command: string,
    args: string[],
    opts: SandboxWrapOptions
  ): WrappedCommand {
    if (!this.isAvailable()) {
      return { command, args, sandboxed: false };
    }
    const profile = buildSeatbeltProfile(opts);
    return {
      command: SANDBOX_EXEC,
      args: ["-p", profile, command, ...args],
      sandboxed: true,
    };
  }
}

/**
 * WHY confinement is off, when it is off (round-3 #9).
 *
 * `isAvailable()` collapses three causes into one boolean, and every surface
 * downstream inherited that collapse: the capability preflight told EVERY
 * unconfined host to "restart MUON to restore sandbox isolation" — true only
 * when an operator disabled it, and false forever on Linux, where there is no
 * implementation to restore. Telling an operator to take an action that
 * cannot work, about the control that protects the operator token, is the
 * honesty failure this distinction closes.
 *
 *  - `available`            confinement is on
 *  - `platform-unsupported` PERMANENT on this host; only macOS has an impl
 *  - `disabled-by-env`      operator set `MUON_SANDBOX=0`; reversible
 *  - `sandbox-exec-missing` macOS without `/usr/bin/sandbox-exec`
 */
export type SandboxAvailability =
  | "available"
  | "platform-unsupported"
  | "disabled-by-env"
  | "sandbox-exec-missing";

export function describeSandboxAvailability(
  env: NodeJS.ProcessEnv = process.env
): SandboxAvailability {
  // Platform first: on a non-macOS host the env flag and the binary probe are
  // both irrelevant, and reporting either would imply a reachable fix.
  if (process.platform !== "darwin") return "platform-unsupported";
  if (sandboxDisabledByEnv(env)) return "disabled-by-env";
  if (!existsSync(SANDBOX_EXEC)) return "sandbox-exec-missing";
  return "available";
}

/** Is this cause fixable by restarting, or is it a property of the host? */
export function sandboxAvailabilityIsPermanent(
  availability: SandboxAvailability
): boolean {
  return (
    availability === "platform-unsupported" ||
    availability === "sandbox-exec-missing"
  );
}

/**
 * Platform selection: the macOS Seatbelt launcher when available + enabled, else
 * the no-op launcher (non-macOS, missing `sandbox-exec`, or `MUON_SANDBOX=0`).
 */
export function selectSandboxLauncher(
  env: NodeJS.ProcessEnv = process.env
): SandboxLauncher {
  const seatbelt = new SeatbeltSandboxLauncher(env);
  return seatbelt.isAvailable() ? seatbelt : new NoopSandboxLauncher();
}
