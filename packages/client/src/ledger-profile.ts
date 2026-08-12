import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbFilePath, isProcessAlive, readLockfile, resolveDataDir } from "./paths.js";

/**
 * ONE MACHINE, ONE LEDGER (ADR-0050).
 *
 * The desktop used to pass Electron's `userData` as its data dir. Electron
 * derives that from `productName ?? name`, and the package is `@muon/desktop`,
 * so the desktop's ledger lived in `…/Application Support/@muon/desktop` while
 * every other surface resolved `…/Application Support/MUON`. Measured
 * 2026-08-12: two brains on two databases (1.9 MB and 17 MB), the CLI
 * reporting a coordination score of zero for a mission the desktop had on
 * screen, and 30 memory notes against 200.
 *
 * `ensureBrain` adopts a sibling profile, but only when THIS surface has none —
 * so the split is invisible until both exist, and permanent afterwards.
 *
 * This module answers one question: given a legacy profile a surface used to
 * use, which ledger should it open now? It never merges. Two databases with
 * overlapping ids cannot be unioned into a truthful history — the result would
 * be a brain that confidently reports things that never happened.
 */
export type LedgerProfile = {
  /** The data dir to use. */
  readonly dataDir: string;
  readonly reason:
    /** Canonical, nothing legacy to consider. */
    | "canonical"
    /** The legacy ledger was MOVED to the canonical profile. The good ending. */
    | "migrated"
    /**
     * The legacy ledger is unambiguous but could not be moved right now (a
     * brain holds it, or the rename failed). Opened where it lies, so the
     * surface still sees its own history, and retried on the next boot.
     */
    | "adopted-legacy"
    /**
     * BOTH hold a ledger. Kept on the legacy one the surface has always used,
     * because moving a running user's history under them is worse than a
     * split they can see and resolve.
     */
    | "collision";
  /** Operator-facing sentence when there is something to say. */
  readonly note?: string;
  /** Set on a collision, so a surface can show both. */
  readonly otherDataDir?: string;
};

function nonEmpty(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/**
 * THE SIDECARS COUNT. The brain opens SQLite in WAL mode, so a profile's
 * committed history can be sitting in `muon.db-wal` with the main file not yet
 * checkpointed. Judging emptiness by `muon.db` alone would let a real ledger
 * read as a fresh profile — and this module's whole job is deciding which
 * history is real.
 */
function hasLedger(dataDir: string): boolean {
  const db = dbFilePath(dataDir);
  return nonEmpty(db) || nonEmpty(`${db}-wal`) || nonEmpty(`${db}-journal`);
}

/** A brain currently holding this profile open — the reason not to move it. */
function profileIsBusy(dataDir: string): boolean {
  const lock = readLockfile(dataDir);
  return lock !== null && isProcessAlive(lock.pid);
}

/**
 * MOVE the ledger, rather than open it where it lies.
 *
 * Adoption alone does not converge: the desktop would keep writing the legacy
 * profile while every CLI command still resolves the canonical one, so the
 * first `muon` command run with the desktop closed spawns a second brain on an
 * empty canonical db — and then BOTH exist and the split is permanent. The
 * unambiguous case is the one moment moving is safe, because the canonical
 * profile has no history to lose.
 *
 * Two renames, never a merge. If a canonical directory already exists (a
 * lockfile, logs, an empty db — anything but a ledger) it is moved ASIDE and
 * kept, not deleted and not merged into. Any failure returns false and the
 * caller falls back to opening the legacy profile in place: a machine that
 * stays split is recoverable, a half-moved profile is not.
 */
function migrateProfile(legacy: string, canonical: string): boolean {
  if (profileIsBusy(legacy) || profileIsBusy(canonical)) return false;
  try {
    if (fs.existsSync(canonical)) {
      const displaced = `${canonical}.pre-migration`;
      // One shot: a second displaced directory would mean an earlier migration
      // already happened and something is wrong with the assumptions here.
      if (fs.existsSync(displaced)) return false;
      fs.renameSync(canonical, displaced);
    }
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.renameSync(legacy, canonical);
    return true;
  } catch {
    // Cross-device, permissions, a file held open on Windows — all mean the
    // move did not happen. It is retried on the next boot.
    return false;
  }
}

/**
 * Resolve which ledger a surface with a LEGACY profile should open.
 *
 * `legacyDataDir` is what that surface used before ADR-0050 (for the desktop,
 * Electron's `userData`). Passing the canonical dir itself is fine and answers
 * `canonical`.
 */
export function resolveLedgerProfile(
  legacyDataDir: string,
  canonicalDataDir: string = resolveDataDir()
): LedgerProfile {
  const legacy = path.resolve(legacyDataDir);
  const canonical = path.resolve(canonicalDataDir);
  if (legacy === canonical) {
    return { dataDir: canonical, reason: "canonical" };
  }

  const legacyHas = hasLedger(legacy);
  const canonicalHas = hasLedger(canonical);

  if (legacyHas && !canonicalHas) {
    // The ordinary upgrade, and the ONLY branch that can actually end the
    // split — so it moves the ledger rather than opening it in place.
    if (migrateProfile(legacy, canonical)) {
      return {
        dataDir: canonical,
        reason: "migrated",
        note: `moved this machine's MUON ledger from ${legacy} to ${canonical}, so every surface now reads one brain.`,
        otherDataDir: legacy,
      };
    }
    return {
      dataDir: legacy,
      reason: "adopted-legacy",
      note: `using the existing MUON ledger at ${legacy}; it could not be moved to ${canonical} right now (a brain still holds it, or the move failed). Nothing was lost and this is retried on the next start — but until it succeeds, a CLI command run with this app closed will start a second, empty brain.`,
      otherDataDir: canonical,
    };
  }

  if (legacyHas && canonicalHas) {
    // DO NOT CHOOSE. Both are real, and picking by size or mtime would
    // silently strand somebody's history — the exact failure this ADR exists
    // to end, committed by the code meant to fix it.
    return {
      dataDir: legacy,
      reason: "collision",
      note: `TWO MUON ledgers exist on this machine and they will not agree: ${legacy} (in use here) and ${canonical}. MUON is one brain per machine, so one of them is not the history you think you have. They are never merged automatically — inspect both and keep one.`,
      otherDataDir: canonical,
    };
  }

  // Canonical only, or a fresh machine: one profile from the first boot.
  return { dataDir: canonical, reason: "canonical" };
}

/**
 * Where a pre-ADR-0050 desktop kept its ledger, computed WITHOUT Electron so
 * the CLI can look.
 *
 * Electron derives `userData` from `productName ?? name` under the per-platform
 * app-data root. The package is `@muon/desktop` and sets no productName, so the
 * slash is part of the directory name — `Application Support/@muon/desktop`.
 * Reproduced here rather than imported because `muon doctor` must be able to
 * report a split the desktop is not running to describe.
 */
export function legacyDesktopDataDir(): string {
  const name = path.join("@muon", "desktop");
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", name);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    return path.join(appData || path.join(home, "AppData", "Roaming"), name);
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg || path.join(home, ".config"), name);
}

export type LedgerCollision = {
  /** True only when TWO ledgers exist and disagree. */
  readonly split: boolean;
  readonly canonicalDataDir: string;
  readonly legacyDataDir: string;
  readonly detail: string;
};

/**
 * The check `muon doctor` runs: is there more than one ledger on this machine?
 *
 * Previously invisible on every surface — the CLI answered from one database
 * and the desktop from another, each internally consistent, so the only symptom
 * was a memory graph missing work the human had just watched happen.
 */
export function detectLedgerCollision(
  canonicalDataDir: string = resolveDataDir(),
  legacyDataDir: string = legacyDesktopDataDir()
): LedgerCollision {
  const canonical = path.resolve(canonicalDataDir);
  const legacy = path.resolve(legacyDataDir);
  const split =
    canonical !== legacy && hasLedger(canonical) && hasLedger(legacy);
  return {
    split,
    canonicalDataDir: canonical,
    legacyDataDir: legacy,
    detail: split
      ? `two MUON ledgers exist and cannot agree: ${canonical} and ${legacy}. MUON is one brain per machine — quit the desktop, keep the one with the history you want, and remove or rename the other. They are never merged automatically.`
      : "one ledger",
  };
}
