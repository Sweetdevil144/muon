import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { forkSeedsRoot, sanitizeTaskId } from "@muon/core";
import { prisma } from "./db.js";

/**
 * ADR-0071/0084 — the crash-window GC (D34's named "GC sweep candidate").
 *
 * Two recorded failure shapes leave a seed stash on disk that no task row
 * references:
 *
 *  - the fork mint crashes between CAPTURE and the mint transaction
 *    (D34: "a crash between capture and tx leaves an inert unreferenced
 *    stash");
 *  - a compensation `discardForkSeed` itself fails after a refused mint or
 *    a failed inheritance insert (D56 logs that stranded coordinate LOUDLY
 *    at the moment it happens — this sweep is the recovery that log
 *    promises).
 *
 * WHAT MAY BE SWEPT is deliberately narrow, and errs toward keeping:
 *
 *  - Only entries under the ONE stash root (`forkSeedsRoot()`, @muon/core —
 *    never a re-spelled path), and only DIRECTORIES; anything else is
 *    counted `skipped`, never deleted (it is not something capture wrote).
 *  - Only stashes older than `minAgeMs`, judged by the WRITE-COMPLETION
 *    signal, not the root directory's mtime (which deep writes never
 *    bump). Capture writes `meta.json` LAST, and a copied `meta.json` is
 *    fresh by construction, so: meta present ⇒ the stash is complete and
 *    its meta's mtime is the completion time; meta absent ⇒ the stash is
 *    mid-write or a crash half, and its age is the NEWEST mtime anywhere
 *    in its subtree — an in-flight capture is always touching something.
 *    A task row referencing a complete stash is created in the SAME
 *    REQUEST (seconds later), and ours is a DAY, so "the create was slow"
 *    cannot make a pending stash look orphaned. The signal is re-read
 *    immediately before each removal: a stash rewritten mid-sweep is
 *    kept.
 *  - Only stashes NO task references. `sanitizeTaskId` is not invertible
 *    (`a/b` and `a-b` both map to `a-b`), so membership is computed by
 *    sanitizing every task id and comparing DIRECTORY NAMES — a raw-id
 *    equality query would mis-read a live task's stash as orphaned, which
 *    is a fail-open deletion of the recorded state a fork exists to carry.
 *    A stash whose task EXISTS is kept unconditionally: a rootless fork
 *    mission is RECOVERABLE by design (D34), and a settled task's stash
 *    dies with the task, not with this sweep.
 *
 * A missing root is a stated empty result, never an error — most installs
 * have simply never forked.
 */
export type ForkSeedGcResult = {
  /** Directory names removed (each logged loudly with its full path). */
  swept: string[];
  /** Aged directories kept because a task references them, plus young ones. */
  kept: number;
  /** Non-directory entries left alone — not something capture wrote. */
  skipped: number;
};

/** A DAY: ~10^5 times the capture→tx window. Orphans are crash artifacts —
 *  this is disk hygiene, not urgency, so the gate errs far toward keeping. */
export const FORK_SEED_GC_MIN_AGE_MS = 24 * 60 * 60_000;

/** Orphans only accrete on crashes, so a slow cadence is honest load. */
export const FORK_SEED_GC_INTERVAL_MS = 60 * 60_000;

/** The stash's last-write time: `meta.json`'s mtime when the stash is
 *  complete (capture writes it last; a copy's is fresh), else the newest
 *  mtime in the subtree (a mid-write stash is always touching something).
 *  Unreadable resolves to `now` — when age cannot be read, keep. */
async function stashLastWriteMs(dir: string): Promise<number> {
  const meta = await stat(join(dir, "meta.json")).catch(() => null);
  if (meta) {
    return meta.mtimeMs;
  }
  let newest = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return Date.now();
  }
  const own = await stat(dir).catch(() => null);
  if (own) {
    newest = own.mtimeMs;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await stashLastWriteMs(path));
    } else {
      const stats = await stat(path).catch(() => null);
      if (!stats) {
        return Date.now();
      }
      newest = Math.max(newest, stats.mtimeMs);
    }
  }
  return newest;
}

export async function sweepOrphanedForkSeeds(
  minAgeMs = FORK_SEED_GC_MIN_AGE_MS
): Promise<ForkSeedGcResult> {
  const root = forkSeedsRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { swept: [], kept: 0, skipped: 0 };
    }
    throw error;
  }

  const result: ForkSeedGcResult = { swept: [], kept: 0, skipped: 0 };
  const aged: string[] = [];
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      result.skipped += 1;
      continue;
    }
    if (now - (await stashLastWriteMs(join(root, entry.name))) < minAgeMs) {
      result.kept += 1;
      continue;
    }
    aged.push(entry.name);
  }
  if (aged.length === 0) {
    return result;
  }

  // The referenced set, by SANITIZED name (see the header for why raw-id
  // equality would be a fail-open deletion). Read AFTER the age scan so a
  // task minted mid-sweep references a FRESH stash, never an aged candidate.
  // Scoped to FORK-MINTED tasks: a stash exists only under a fork task's
  // key, and both writers (the mint, the inheritance copy) stamp
  // `forkSourceTaskId` — the create route's consistency guard enforces it —
  // so the recurring read is bounded by the fork subset, not the whole
  // ledger, and it runs ONLY when an aged candidate exists. Reading the
  // fork id out of each stash's own meta.json was rejected: the manifest
  // is the artifact being judged, and its recorded id is the SOURCE
  // task's, not the fork's — the ledger is the authority on what exists.
  const tasks = await prisma.task.findMany({
    where: { forkSourceTaskId: { not: null } },
    select: { id: true },
  });
  const referenced = new Set<string>();
  for (const task of tasks) {
    try {
      referenced.add(sanitizeTaskId(task.id));
    } catch {
      // An id that maps to no directory name references no stash.
    }
  }

  for (const name of aged) {
    if (referenced.has(name)) {
      result.kept += 1;
      continue;
    }
    const path = join(root, name);
    // The signal re-read at the last moment: a stash written to since the
    // scan is live RIGHT NOW (a copy under an about-to-exist task) and is
    // kept for the next sweep to judge.
    if (now - (await stashLastWriteMs(path)) < minAgeMs) {
      result.kept += 1;
      continue;
    }
    await rm(path, { recursive: true, force: true });
    result.swept.push(name);
    // LOUD, like the strand was when it happened: the coordinate that was
    // logged at compensation failure is the one this line closes out.
    console.warn(
      `[fork-seed-gc] swept orphaned fork seed stash '${path}' — no task references it and it is older than ${Math.round(
        minAgeMs / 60_000
      )} min (crash-window artifact, D34)`
    );
  }
  return result;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Idempotent, and unref'd so it never keeps the process alive on its own —
 *  the same shape as the attached-coordinator and horizon sweeps. */
export function startForkSeedGc(intervalMs = FORK_SEED_GC_INTERVAL_MS): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweepOrphanedForkSeeds().catch((error) => {
      console.error(
        `fork-seed GC failed: ${error instanceof Error ? error.message : error}`
      );
    });
  }, intervalMs);
  sweepTimer.unref?.();
}

export function stopForkSeedGc(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
