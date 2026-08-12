import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isProcessAlive } from "./paths.js";

// ONE cross-process mutual exclusion for indexing ONE GitNexus store.
//
// MUON spawns `gitnexus analyze` from two of its own processes against the same
// `<repo>/.gitnexus/` store: the desktop's index supervisor (background debounce
// + the operator's Re-index button) and the MCP server's freshness refresh
// (`code_impact`). Neither knew about the other. The forced rebuild path deletes
// the store's DB files (`lbug`, `lbug.wal`, `lbug.lock`) before recreating them,
// so a forced rebuild racing an incremental run on one store can destroy a graph
// that takes minutes to rebuild — and every governed child is graph-blind until
// it does. Both spawn sites are MUON's own code, so the exclusion lives here,
// used by BOTH; a second copy of this logic is how the two drift apart.
//
// The lock is advisory between MUON processes only. It never touches, moves, or
// truncates anything the indexer owns: acquiring creates exactly one file
// (`<repo>/.gitnexus/muon-index.lock`), releasing removes exactly that file.
// The name deliberately avoids `lbug.lock`, which the CLI's own rebuild deletes.

/** The store directory GitNexus keeps per repo (`getStoragePath` upstream). */
export const GITNEXUS_STORE_DIR = ".gitnexus";
/** MUON's lock file inside that store. NOT a GitNexus file — MUON owns it. */
export const GITNEXUS_INDEX_LOCK_FILE = "muon-index.lock";

/**
 * How long an UNREADABLE lock (corrupt/truncated — never produced by the writer
 * below, but disks lie) may block indexing before it is reclaimed on age alone.
 * Far beyond both callers' analyze timeouts (10 min each), so it can never
 * reclaim a legitimately held lock.
 */
export const GITNEXUS_INDEX_LOCK_MAX_HOLD_MS = 30 * 60_000;

/** Which MUON surface holds the lock — for the refusal note, never for policy. */
export type GitNexusIndexLockOwner = "desktop" | "mcp";

/** The complete record published in the lock file. Written in ONE atomic step. */
export type GitNexusIndexLockHolder = {
  /** The MUON process that acquired it (desktop main / MCP server). */
  pid: number;
  /**
   * The `analyze` child, once spawned. The desktop's child is DETACHED, so it
   * outlives a killed supervisor: a lock whose holder is gone but whose child
   * still runs is still HELD, or we would hand a second process a store that is
   * actively being written.
   */
  childPid?: number;
  /** ISO start timestamp — diagnostics + the unreadable-lock age fallback. */
  startedAt: string;
  owner: GitNexusIndexLockOwner;
  /** The resolved repo root whose store this lock covers. */
  target: string;
  /**
   * Per-acquisition random id. Release removes the file only when the record
   * still carries OUR nonce, so a recycled pid can never delete a live holder's
   * lock (the same discipline as `removeLockfile`'s ownerPid guard).
   */
  nonce: string;
};

/** A held lock. Both methods are idempotent and never throw. */
export type GitNexusIndexLockHandle = {
  holder: GitNexusIndexLockHolder;
  /** Record the spawned analyze child, so a killed holder does not free it. */
  adoptChild: (childPid: number) => void;
  /** Remove OUR lock file. Idempotent. Never touches store data. */
  release: () => void;
};

/**
 * The answer to "may I index this store now" — a VALUE, never a throw, so both
 * callers can render/route the refusal instead of guessing. `held` means another
 * MUON process is indexing; `unavailable` means we could not even create the
 * lock (unwritable store dir) and therefore must not pretend we hold it.
 */
export type GitNexusIndexLockAttempt =
  | { acquired: true; lock: GitNexusIndexLockHandle }
  | {
      acquired: false;
      reason: "held" | "unavailable";
      holder?: GitNexusIndexLockHolder;
      note: string;
    };

export type AcquireGitNexusIndexLockOptions = {
  owner: GitNexusIndexLockOwner;
  /** Overridable for tests; defaults to this process. */
  pid?: number;
  now?: () => number;
  /** Age at which an UNREADABLE lock is reclaimed. */
  maxHoldMs?: number;
};

/**
 * The canonical store root for a repo. Realpath'd, because the two callers
 * arrive with differently-spelled paths for the same store (macOS `/tmp` vs
 * `/private/tmp`, a symlinked checkout) and two spellings would mean two locks
 * and no exclusion at all. Falls back to `resolve` when the path does not exist
 * yet — nothing to symlink through in that case.
 */
export function gitnexusStoreRoot(repoRoot: string): string {
  const absolute = path.resolve(repoRoot);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Absolute path to MUON's index lock for this repo's store. */
export function gitnexusIndexLockPath(repoRoot: string): string {
  return path.join(
    gitnexusStoreRoot(repoRoot),
    GITNEXUS_STORE_DIR,
    GITNEXUS_INDEX_LOCK_FILE
  );
}

/** Read the published holder, or null when absent/unreadable/unparseable. */
export function readGitNexusIndexLock(
  repoRoot: string
): GitNexusIndexLockHolder | null {
  return readHolderAt(gitnexusIndexLockPath(repoRoot));
}

function readHolderAt(lockPath: string): GitNexusIndexLockHolder | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(lockPath, "utf8")
    ) as Partial<GitNexusIndexLockHolder>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.target === "string" &&
      typeof parsed.nonce === "string" &&
      (parsed.childPid === undefined || typeof parsed.childPid === "number")
    ) {
      return parsed as GitNexusIndexLockHolder;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Is this record's work still running? EITHER process being alive holds the
 * lock: the MUON process that will release it, or the detached analyze child
 * that is writing the store right now.
 */
function holderIsLive(holder: GitNexusIndexLockHolder): boolean {
  if (isProcessAlive(holder.pid)) return true;
  return holder.childPid !== undefined && isProcessAlive(holder.childPid);
}

function describe(holder: GitNexusIndexLockHolder): string {
  return `An index run is already in progress (${holder.owner}, pid ${holder.pid}, started ${holder.startedAt}).`;
}

/**
 * Publish `holder` at `lockPath` if and only if nothing is published there yet.
 *
 * ATOMICITY: `link(2)` is the primitive. POSIX requires it to fail with EEXIST
 * when the new path already exists, and the existence test + directory-entry
 * creation happen together inside the kernel — on macOS (APFS/HFS+) and Linux
 * local filesystems exactly one of any number of concurrent linkers can win.
 * We link a temp file that ALREADY holds the finished JSON rather than
 * `open(O_CREAT|O_EXCL)` + write, because O_EXCL publishes an EMPTY file first:
 * a racing reader could see a lock with no pid in it and would have no way to
 * tell "held, mid-write" from "corrupt, reclaim me". Linking a complete record
 * removes that window entirely — the lock is invisible until it is whole.
 */
function publishLock(
  lockPath: string,
  holder: GitNexusIndexLockHolder
): "published" | "taken" | "unavailable" {
  const temporary = `${lockPath}.${holder.pid}.${holder.nonce}.tmp`;
  try {
    // `wx` = O_CREAT|O_EXCL: never clobber; the nonce makes collision impossible.
    fs.writeFileSync(temporary, JSON.stringify(holder), {
      mode: 0o600,
      flag: "wx",
    });
    fs.linkSync(temporary, lockPath);
    return "published";
  } catch (error) {
    // EEXIST is the ONLY "someone else holds it" answer. Anything else (an
    // unwritable store dir, a full disk) must not be reported as contention —
    // the caller would tell the operator to wait for a run that isn't there.
    return (error as NodeJS.ErrnoException)?.code === "EEXIST"
      ? "taken"
      : "unavailable";
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // the link succeeded or never happened; a leftover temp is harmless
    }
  }
}

/**
 * Reclaim a lock whose work is provably over. Returns true when THIS caller is
 * the one that removed it — at most one caller can be.
 *
 * ATOMICITY: `rename(2)`, which POSIX also makes atomic. Two processes that
 * both judge the same lock stale race to move it to their OWN private path;
 * the loser's rename fails ENOENT because the entry is already gone. So the
 * winner is single, and only the winner goes on to publish. A read-then-unlink
 * would let both delete "the stale lock" and both then publish.
 *
 * The parked copy is re-read before it is discarded: if the record we judged
 * dead had already been replaced by a LIVE holder between our read and our
 * rename, we link it straight back and lose the race honestly rather than
 * evicting a process that is mid-rebuild.
 */
function reclaimStaleLock(
  lockPath: string,
  wasJudgedStale: (holder: GitNexusIndexLockHolder) => boolean
): boolean {
  const parked = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    fs.renameSync(lockPath, parked);
  } catch {
    return false; // another process reclaimed it first, or it is already gone
  }
  try {
    const parkedHolder = readHolderAt(parked);
    if (parkedHolder && !wasJudgedStale(parkedHolder)) {
      try {
        fs.linkSync(parked, lockPath); // put the live holder's lock back
      } catch {
        // someone published a new lock in the gap; theirs wins, ours is moot
      }
      return false;
    }
    return true;
  } finally {
    try {
      fs.rmSync(parked, { force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Take the index lock for `repoRoot`'s store, or say why not. Never throws.
 *
 * Stale recovery is mandatory here, not optional: without it the first crashed
 * indexer would wedge indexing for this repo forever. A lock whose holder AND
 * analyze child are both gone is free. A lock we cannot parse at all is
 * respected until `maxHoldMs` has passed, so a mid-write file is never mistaken
 * for a corpse.
 *
 * Recovery is pid-based, NOT age-based, for a live record: an orphaned rebuild
 * (its supervisor killed, the detached child still writing) may legitimately
 * run longer than any timeout we could pick, and evicting it is the exact data
 * loss this lock exists to prevent. The residual risk is pid REUSE — a
 * recycled pid keeps a dead lock looking alive. The escape hatch is one file:
 * delete `<repo>/.gitnexus/muon-index.lock`.
 */
export function acquireGitNexusIndexLock(
  repoRoot: string,
  options: AcquireGitNexusIndexLockOptions
): GitNexusIndexLockAttempt {
  const target = gitnexusStoreRoot(repoRoot);
  const lockPath = path.join(
    target,
    GITNEXUS_STORE_DIR,
    GITNEXUS_INDEX_LOCK_FILE
  );
  const now = options.now ?? Date.now;
  const maxHoldMs = options.maxHoldMs ?? GITNEXUS_INDEX_LOCK_MAX_HOLD_MS;
  const holder: GitNexusIndexLockHolder = {
    pid: options.pid ?? process.pid,
    startedAt: new Date(now()).toISOString(),
    owner: options.owner,
    target,
    nonce: randomUUID(),
  };

  try {
    // `recursive` never truncates an existing dir, and the store dir is the
    // indexer's own — creating it early costs nothing and destroys nothing.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (error) {
    return {
      acquired: false,
      reason: "unavailable",
      note: `MUON could not open the index lock for this repository: ${reason(
        error
      )}`,
    };
  }

  const published = publishLock(lockPath, holder);
  if (published === "published") {
    return { acquired: true, lock: makeHandle(lockPath, holder) };
  }
  if (published === "unavailable") {
    return {
      acquired: false,
      reason: "unavailable",
      note: "MUON could not write the index lock for this repository.",
    };
  }

  const current = readHolderAt(lockPath);
  if (current && holderIsLive(current)) {
    return {
      acquired: false,
      reason: "held",
      holder: current,
      note: describe(current),
    };
  }
  if (!current) {
    // Unreadable: either a file being published this instant (respect it) or a
    // corpse no pid can vouch for (reclaim it once it is impossibly old).
    let ageMs = 0;
    try {
      ageMs = now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      ageMs = Number.POSITIVE_INFINITY; // vanished under us — treat as free
    }
    if (ageMs < maxHoldMs) {
      return {
        acquired: false,
        reason: "held",
        note: "An index run is already in progress.",
      };
    }
  }

  const reclaimed = reclaimStaleLock(
    lockPath,
    (parkedHolder) => !holderIsLive(parkedHolder)
  );
  if (reclaimed && publishLock(lockPath, holder) === "published") {
    return { acquired: true, lock: makeHandle(lockPath, holder) };
  }
  const winner = readHolderAt(lockPath);
  return {
    acquired: false,
    reason: "held",
    ...(winner ? { holder: winner } : {}),
    note: winner ? describe(winner) : "An index run is already in progress.",
  };
}

function makeHandle(
  lockPath: string,
  holder: GitNexusIndexLockHolder
): GitNexusIndexLockHandle {
  let record = holder;
  let released = false;
  return {
    get holder() {
      return record;
    },
    adoptChild: (childPid: number) => {
      if (released || !Number.isInteger(childPid) || childPid <= 0) return;
      const next = { ...record, childPid };
      // Replace in place with rename(2): a reader sees the old complete record
      // or the new one, never a half-rewritten file.
      const temporary = `${lockPath}.${record.nonce}.child`;
      try {
        if (readHolderAt(lockPath)?.nonce !== record.nonce) return; // not ours
        fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
        fs.renameSync(temporary, lockPath);
        record = next;
      } catch {
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          // best-effort
        }
      }
    },
    release: () => {
      if (released) return;
      released = true;
      try {
        // Only ever OUR lock file, and only while it is still ours: a lock a
        // successor already reclaimed must survive our release.
        if (readHolderAt(lockPath)?.nonce !== record.nonce) return;
        fs.rmSync(lockPath, { force: true });
      } catch {
        // best-effort: a holder that cannot clean up still exits, and the next
        // acquirer reclaims it on the dead-pid path.
      }
    },
  };
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
