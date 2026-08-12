/**
 * ADR-0029: the unsigned staged-swap apply path.
 *
 * Everything here is electron-free and side-effect-injected, mirroring
 * updater.ts: the PLAN is pure data a test can assert on, and PERFORM runs
 * the plan through an injected io so rollback behaviour is provable without
 * touching a real /Applications. main.ts supplies the real io (ditto, xattr,
 * rename, spawn) — and only main.ts.
 *
 * INVARIANTS (ADR-0029):
 *   - verified bytes only: no sha512 → refuse; mismatch → delete + refuse;
 *   - the swap is two renames with rollback of the first on any failure;
 *   - the backup bundle survives until a NEW version boots healthy;
 *   - every refusal names the manual fallback (the download page).
 */
import { createHash } from "node:crypto";

export const MANUAL_FALLBACK =
  "Update could not be applied automatically. Download the latest release from https://getmuon.com/download.";

/** The feed's description of the update zip (electron-updater UpdateInfo.files entry). */
export type FeedFile = { url: string; sha512?: string; size?: number };

/** Where a staged-swap is allowed to run. Every field is checked, none inferred.
 *  The two ownership fields are REQUIRED (round-3 #3): an omitted check would
 *  silently fail open, and a package-manager-owned bundle that MUON swaps
 *  underneath the manager corrupts the manager's state on its next upgrade.
 *  `null` means "checked, none found" — never "did not look". */
export type SwapPreconditions = {
  packaged: boolean;
  platform: NodeJS.Platform;
  /** Absolute path of the RUNNING .app bundle (derived from the executable path). */
  appBundlePath: string | null;
  /** Where the bundle path REALLY resolves when that is somewhere else (a
   *  manager's symlink into its own store), or null when path === realpath. */
  resolvedElsewhere: string | null;
  /** A package-manager receipt claiming a MUON install (e.g. a Homebrew
   *  Caskroom directory), or null when none was found. */
  packageManagerReceipt: string | null;
};

/** Refusal reason, or null when the swap may proceed. */
export function swapRefusalReason(pre: SwapPreconditions): string | null {
  if (!pre.packaged) {
    return "not a packaged build; update from your checkout instead";
  }
  if (pre.platform !== "darwin") {
    return "staged swap is a macOS path";
  }
  if (!pre.appBundlePath || !/^\/Applications\/[^/]+\.app$/.test(pre.appBundlePath)) {
    return `app is not installed under /Applications. ${MANUAL_FALLBACK}`;
  }
  // A managed install updates through its manager, or the two fight: the
  // manager's next upgrade replaces MUON's swapped bundle (silent downgrade)
  // and its uninstall strands or deletes the wrong bytes. Latent until the
  // tap publishes; checked from day one so it never becomes live by surprise.
  if (pre.resolvedElsewhere) {
    return (
      `this bundle is a link into ${pre.resolvedElsewhere} — a package manager owns it; ` +
      `update with that manager instead (e.g. \`brew upgrade --cask muon\`)`
    );
  }
  if (pre.packageManagerReceipt) {
    return (
      `a package manager owns this install (receipt: ${pre.packageManagerReceipt}); ` +
      `update with \`brew upgrade --cask muon\` instead`
    );
  }
  return null;
}

/** sha512 (base64, electron-builder convention) of a byte stream. */
export function sha512Base64(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

export type SwapPlan = {
  version: string;
  appBundlePath: string;
  /** Unpacked new bundle (must contain Contents/MacOS before any rename). */
  stagedBundlePath: string;
  /** Where the current bundle is parked for rollback / post-boot cleanup. */
  backupBundlePath: string;
};

export function planSwap(opts: {
  appBundlePath: string;
  stagingDir: string;
  currentVersion: string;
  newVersion: string;
}): SwapPlan {
  return {
    version: opts.newVersion,
    appBundlePath: opts.appBundlePath,
    stagedBundlePath: `${opts.stagingDir}/MUON.app`,
    // Dot-prefixed so Finder/Launchpad never shows the parked copy; version
    // suffix so a failed cleanup from an older update can never be mistaken
    // for this one's rollback point.
    backupBundlePath: `${opts.appBundlePath.replace(/\/([^/]+)$/, "/.$1")}.backup-${opts.currentVersion}`,
  };
}

/** The io the swap needs — supplied by main.ts, faked in tests. */
export type SwapIo = {
  /** ditto -x -k zip → destDir (preserves Frameworks symlinks). */
  unpackZip(zipPath: string, destDir: string): Promise<void>;
  /** xattr -dr com.apple.quarantine path (belt and braces; may no-op). */
  stripQuarantine(path: string): Promise<void>;
  exists(path: string): boolean;
  rename(from: string, to: string): Promise<void>;
  removeTree(path: string): Promise<void>;
};

/**
 * Unpack, validate the staged bundle, and swap with rollback.
 * Resolves when /Applications holds the NEW bundle; the caller relaunches.
 * On any failure after the first rename, the original bundle is restored.
 */
export async function performSwap(
  plan: SwapPlan,
  zipPath: string,
  io: SwapIo
): Promise<void> {
  const stagingDir = plan.stagedBundlePath.replace(/\/[^/]+$/, "");
  await io.unpackZip(zipPath, stagingDir);
  if (!io.exists(`${plan.stagedBundlePath}/Contents/MacOS`)) {
    await io.removeTree(stagingDir).catch(() => undefined);
    throw new Error(`update zip did not contain an app bundle. ${MANUAL_FALLBACK}`);
  }
  await io.stripQuarantine(plan.stagedBundlePath).catch(() => undefined);

  // A stale backup from an interrupted older update would make the rename
  // below fail; it is rollback residue, never user data.
  if (io.exists(plan.backupBundlePath)) {
    await io.removeTree(plan.backupBundlePath);
  }

  await io.rename(plan.appBundlePath, plan.backupBundlePath);
  try {
    await io.rename(plan.stagedBundlePath, plan.appBundlePath);
  } catch (error) {
    // Roll the park-rename back so the user still has a working app. If the
    // rollback ALSO fails (review finding 4), the app is stranded at the
    // dot-hidden backup path — say exactly where it is instead of letting the
    // rollback's error mask the original one.
    try {
      await io.rename(plan.backupBundlePath, plan.appBundlePath);
    } catch {
      throw new Error(
        `update failed AND rollback failed: your app is intact at ${plan.backupBundlePath} — ` +
          `move it back to ${plan.appBundlePath} in Finder (⌘⇧. shows hidden files). ` +
          `Original failure: ${error instanceof Error ? error.message : String(error)}. ${MANUAL_FALLBACK}`
      );
    }
    throw error;
  }
}

/**
 * First healthy boot of a new version: report the update and drop the
 * rollback copy. Pure decision + injected cleanup, called from main.ts boot.
 */
export async function confirmBoot(opts: {
  currentVersion: string;
  lastRunVersion: string | undefined;
  appBundlePath: string | null;
  io: Pick<SwapIo, "exists" | "removeTree">;
}): Promise<{ justUpdated: boolean; from?: string }> {
  const justUpdated = Boolean(
    opts.lastRunVersion && opts.lastRunVersion !== opts.currentVersion
  );
  if (opts.appBundlePath) {
    const backup = `${opts.appBundlePath.replace(/\/([^/]+)$/, "/.$1")}.backup-${opts.lastRunVersion}`;
    if (justUpdated && opts.io.exists(backup)) {
      await opts.io.removeTree(backup).catch(() => undefined);
    }
  }
  return justUpdated ? { justUpdated, from: opts.lastRunVersion } : { justUpdated: false };
}
