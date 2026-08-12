import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  ATTACHED_COORDINATOR_BOOTSTRAP_HORIZON_MS,
  ATTACHED_COORDINATOR_LEASE_HORIZON_MS,
  attachedCoordinatorCapabilityFileSchema,
  type AttachedCoordinatorCapabilityFile,
} from "@muon/protocol";
import { resolveDataDir } from "./paths.js";

// ── ADR-0028 Tier C: the attached-coordinator capability file ───────────────
//
// This is an OWNER-ONLY secret, not a vendor config. A vendor MCP entry names
// only this file's absolute PATH (`MUON_ATTACHED_CAPABILITY_FILE`); the file
// itself carries the one-shot exact-job bearer
// (`backend/src/lib/attached-coordinator.ts`'s `POST /attached` mints it) and
// every coordinate a positively-scoped `muon-mcp` process needs. NEVER log
// `apiToken` or `delegationToken` — every function here that reports a
// rejection reason names the FIELD, never the VALUE.

export const ATTACHED_COORDINATOR_CAPABILITY_DIR_NAME =
  "attached-coordinators";

/**
 * Hard ceiling well above any real file (nine short strings). Guards a read
 * against a corrupted or hostile oversized file forcing an unbounded
 * read+parse — checked from `fs.lstatSync` BEFORE the file is ever opened.
 */
export const ATTACHED_COORDINATOR_CAPABILITY_MAX_BYTES = 64 * 1024;

/** `<dataDir>/attached-coordinators`. */
export function attachedCoordinatorCapabilityDir(
  dataDir: string = resolveDataDir()
): string {
  return path.join(dataDir, ATTACHED_COORDINATOR_CAPABILITY_DIR_NAME);
}

/**
 * `<dataDir>/attached-coordinators/<vendor>.json`. `vendor` must already be a
 * real coordinator-seat vendor id by the time this is called (the attach
 * route validates that server-side), but this still refuses a path-traversal
 * or separator attempt defensively rather than trusting the caller.
 */
export function attachedCoordinatorCapabilityFilePath(
  vendor: string,
  dataDir: string = resolveDataDir()
): string {
  const cleaned = vendor.trim();
  if (!cleaned || cleaned !== path.basename(cleaned) || cleaned.includes("..")) {
    throw new Error(`invalid attached-coordinator vendor id '${vendor}'`);
  }
  return path.join(
    attachedCoordinatorCapabilityDir(dataDir),
    `${cleaned}.json`
  );
}

export type CapabilityFileRejectionReason =
  | "missing"
  | "symlink"
  | "oversized"
  | "unreadable"
  | "malformed-json"
  | "invalid-schema"
  | "expired"
  | "inconsistent"
  | "insecure-permissions";

export type CapabilityFileReadResult =
  | { ok: true; capability: AttachedCoordinatorCapabilityFile }
  | { ok: false; reason: CapabilityFileRejectionReason; detail: string };

function writeCapabilityAtomically(
  target: string,
  capability: AttachedCoordinatorCapabilityFile
): void {
  const tmp = `${target}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    // `wx` makes the random temporary name exclusive. A predictable temp name
    // plus ordinary `writeFileSync` follows a pre-planted symlink and can
    // truncate an unrelated same-user file before the final rename.
    fs.writeFileSync(tmp, JSON.stringify(capability, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(tmp, target);
  } finally {
    // Rename removes the temp path on success; a failed write/rename must not
    // leave a secret-bearing artifact behind.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup; the original failure remains the useful error.
    }
  }
}

/**
 * Write the capability file ATOMICALLY (temp + rename) at owner-only 0600,
 * creating `<dataDir>/attached-coordinators` at 0700 if needed. Returns the
 * absolute path written. Re-validates against the protocol schema before
 * touching disk — a caller-constructed object that fails the schema is never
 * partially written.
 */
export function writeAttachedCoordinatorCapabilityFile(
  capability: AttachedCoordinatorCapabilityFile,
  dataDir: string = resolveDataDir()
): string {
  const parsed = attachedCoordinatorCapabilityFileSchema.parse(capability);
  const dir = attachedCoordinatorCapabilityDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = attachedCoordinatorCapabilityFilePath(parsed.vendor, dataDir);
  writeCapabilityAtomically(target, parsed);
  return target;
}

const NON_BLANK_FIELDS = [
  "apiBase",
  "apiToken",
  "jobId",
  "delegationToken",
  "chatId",
  "chatTaskId",
  "workspacePath",
  "vendor",
] as const satisfies readonly (keyof AttachedCoordinatorCapabilityFile)[];

/**
 * Read + validate one capability file end to end. Fails CLOSED on every
 * ambiguity — missing, a symlink (never followed), oversized, unreadable,
 * malformed JSON, schema-invalid, expired, group/other-readable, or
 * internally inconsistent (a field that is blank once trimmed) — and never
 * throws for an expected rejection, only returns one. The caller decides what
 * "closed" means (refuse to start, refuse a tool call).
 */
export function readAttachedCoordinatorCapabilityFile(
  filePath: string,
  opts: { now?: Date; allowExpired?: boolean } = {}
): CapabilityFileReadResult {
  if (!path.isAbsolute(filePath)) {
    return {
      ok: false,
      reason: "inconsistent",
      detail: `${filePath}: capability path must be absolute`,
    };
  }
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(filePath);
  } catch (error) {
    return {
      ok: false,
      reason: "missing",
      detail: `${filePath}: ${(error as Error).message}`,
    };
  }
  // Never follow a symlink for a secret-bearing file: a same-uid attacker who
  // can plant one at this exact path could otherwise redirect the read to a
  // file this code does not own. Checked via lstat BEFORE any open/read.
  if (lstat.isSymbolicLink()) {
    return {
      ok: false,
      reason: "symlink",
      detail: `${filePath} is a symlink; refusing to follow it`,
    };
  }
  if (!lstat.isFile()) {
    return {
      ok: false,
      reason: "missing",
      detail: `${filePath} is not a regular file`,
    };
  }
  if (lstat.size > ATTACHED_COORDINATOR_CAPABILITY_MAX_BYTES) {
    return {
      ok: false,
      reason: "oversized",
      detail: `${filePath} is ${lstat.size} bytes, over the ${ATTACHED_COORDINATOR_CAPABILITY_MAX_BYTES}-byte bound`,
    };
  }
  const mode = lstat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return {
      ok: false,
      reason: "insecure-permissions",
      detail: `${filePath} is mode ${mode
        .toString(8)
        .padStart(4, "0")}; it must be readable only by its owner (0600)`,
    };
  }
  let raw: string;
  let fd: number | undefined;
  try {
    // lstat gives a useful direct-symlink refusal above; O_NOFOLLOW + fstat
    // closes the replacement race between that check and the read. All
    // security checks below apply to the exact descriptor whose bytes we use.
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      return {
        ok: false,
        reason: "missing",
        detail: `${filePath} is not a regular file`,
      };
    }
    if (opened.size > ATTACHED_COORDINATOR_CAPABILITY_MAX_BYTES) {
      return {
        ok: false,
        reason: "oversized",
        detail: `${filePath} is ${opened.size} bytes, over the ${ATTACHED_COORDINATOR_CAPABILITY_MAX_BYTES}-byte bound`,
      };
    }
    const openedMode = opened.mode & 0o777;
    if ((openedMode & 0o077) !== 0) {
      return {
        ok: false,
        reason: "insecure-permissions",
        detail: `${filePath} is mode ${openedMode
          .toString(8)
          .padStart(4, "0")}; it must be readable only by its owner (0600)`,
      };
    }
    if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
      return {
        ok: false,
        reason: "insecure-permissions",
        detail: `${filePath} is not owned by the current user`,
      };
    }
    raw = fs.readFileSync(fd, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: "unreadable",
      detail: `${filePath}: ${(error as Error).message}`,
    };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The read result remains authoritative; close failure is non-actionable.
      }
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: "malformed-json",
      detail: `${filePath} is not valid JSON: ${(error as Error).message}`,
    };
  }
  const parsed = attachedCoordinatorCapabilityFileSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid-schema",
      detail: `${filePath} failed schema validation: ${parsed.error.message}`,
    };
  }
  const capability = parsed.data;
  // The schema's `.min(1)` already rejects "", but a value of only whitespace
  // passes it — every coordinate here is later trusted as a non-empty scope.
  const blankFields = NON_BLANK_FIELDS.filter(
    (key) => capability[key].trim().length === 0
  );
  if (blankFields.length > 0) {
    return {
      ok: false,
      reason: "inconsistent",
      detail: `${filePath}: blank field(s) after trim: ${blankFields.join(", ")}`,
    };
  }
  const expiresAtMs = new Date(capability.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) {
    return {
      ok: false,
      reason: "inconsistent",
      detail: `${filePath}: expiresAt is not a valid timestamp`,
    };
  }
  const nowMs = (opts.now ?? new Date()).getTime();
  if (!opts.allowExpired && expiresAtMs <= nowMs) {
    return {
      ok: false,
      reason: "expired",
      detail: `${filePath}: expired at ${capability.expiresAt}`,
    };
  }
  // ADR-0049: a file may widen its own horizon ONLY by declaring that it has
  // never heartbeated. Absent `bootstrap` is the NARROW case — the direction an
  // omission has to fail in — so a file from an older build is bounded exactly
  // as it was, and a forged far-future timestamp still needs the declaration to
  // buy even the wider window.
  const horizonMs = capability.bootstrap
    ? ATTACHED_COORDINATOR_BOOTSTRAP_HORIZON_MS
    : ATTACHED_COORDINATOR_LEASE_HORIZON_MS;
  if (expiresAtMs - nowMs > horizonMs) {
    return {
      ok: false,
      reason: "inconsistent",
      detail: `${filePath}: expiresAt exceeds the independent lease horizon`,
    };
  }
  return { ok: true, capability };
}

/**
 * Persist the server-issued next heartbeat expiry without changing any other
 * coordinate or bearer. The existing file must still be the exact capability
 * this process started with; a replaced/malformed file makes renewal fail
 * closed instead of silently overwriting a different attach.
 */
export function renewAttachedCoordinatorCapabilityFile(
  filePath: string,
  current: AttachedCoordinatorCapabilityFile,
  expiresAt: string,
  opts: { now?: Date } = {}
): AttachedCoordinatorCapabilityFile {
  const now = opts.now ?? new Date();
  const nextExpiryMs = new Date(expiresAt).getTime();
  // The brain answers a heartbeat with the STEADY-STATE lease, so the ordinary
  // horizon is what a renewal is checked against — the bootstrap width buys
  // nothing here, and accepting it would let one wide grant renew itself wide
  // forever.
  if (
    Number.isNaN(nextExpiryMs) ||
    nextExpiryMs <= now.getTime() ||
    nextExpiryMs - now.getTime() > ATTACHED_COORDINATOR_LEASE_HORIZON_MS
  ) {
    throw new Error(
      "heartbeat returned an invalid, expired, or out-of-horizon lease"
    );
  }

  // Read with the Unix epoch so a heartbeat response that crossed the old
  // expiry by milliseconds can still renew it. Authority for renewal came
  // from the successful exact-job heartbeat; this read proves the local file
  // was not replaced with another capability in the meantime.
  const existing = readAttachedCoordinatorCapabilityFile(filePath, {
    now,
    allowExpired: true,
  });
  if (!existing.ok) {
    throw new Error(
      `capability file cannot be renewed (${existing.reason}): ${existing.detail}`
    );
  }
  for (const key of [
    "apiBase",
    "apiToken",
    "jobId",
    "delegationToken",
    "chatId",
    "chatTaskId",
    "workspacePath",
    "vendor",
  ] as const) {
    if (existing.capability[key] !== current[key]) {
      throw new Error(`capability file changed at field ${key}; refusing renewal`);
    }
  }

  // ADR-0049: the first successful heartbeat ENDS the bootstrap window. The
  // flag is dropped rather than carried, so from here the seat lives under the
  // steady-state horizon and a terminal that dies is reaped in one lease
  // period, exactly as before.
  const { bootstrap: _bootstrapEnded, ...steadyState } = current;
  const renewed = attachedCoordinatorCapabilityFileSchema.parse({
    ...steadyState,
    expiresAt,
  });
  writeCapabilityAtomically(filePath, renewed);
  return renewed;
}

/**
 * Delete/invalidate the capability file on detach. A missing file is already
 * clean. Returns whether the path is absent afterwards so callers never claim
 * cleanup succeeded after a filesystem refusal.
 */
export function deleteAttachedCoordinatorCapabilityFile(
  filePath: string
): boolean {
  try {
    fs.rmSync(filePath, { force: true });
    return !fs.existsSync(filePath);
  } catch {
    return false;
  }
}
