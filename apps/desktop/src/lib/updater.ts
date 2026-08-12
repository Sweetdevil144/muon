/**
 * Auto-update decision logic + a thin controller over electron-updater.
 *
 * INVARIANT: the update CHECK is an explicit outbound call to the GitHub
 * releases feed. It is opt-in (settings.autoUpdate) or user-initiated ("Check
 * for updates"), NEVER silent: every state transition is surfaced to the UI via
 * onStatus, and nothing downloads or installs without an explicit user action
 * (autoDownload / autoInstallOnAppQuit are forced off). PR/check egress is a
 * separate operator-authorized path after device-flow connection. Unsigned
 * builds apply updates via the MUON-owned staged swap (ADR-0029,
 * lib/staged-swap.ts) — download and apply are each their own explicit user
 * action; the Squirrel path stays behind "signed-verified" for a future
 * signed build. See docs/install.md.
 *
 * This module is deliberately electron-FREE: the real `autoUpdater` from
 * electron-updater is injected by main.ts. That keeps the decision logic pure +
 * deterministically testable (tests/updater.test.ts) and keeps the desktop build
 * green even before electron-updater is installed.
 */

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; notes?: string }
  | { state: "up-to-date"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  /** Round-3 #2: the restart is QUEUED behind live governed work, named. The
   *  install completes on its own when the crew drains, or immediately via
   *  install({force: true}) — an informed interruption, never a silent one. */
  | { state: "waiting-for-work"; version: string; lanes: string[] }
  /** ADR-0029: first healthy boot of a new version (the confirmation toast). */
  | { state: "updated"; version: string; from?: string }
  | { state: "error"; message: string };

export type UpdateAction = "prompt-download" | "up-to-date" | "silent";

type Parsed = { main: [number, number, number]; pre: string[] };

function parseVersion(v: string): Parsed {
  const cleaned = v.trim().replace(/^v/i, "").split("+")[0]; // drop leading v + build metadata
  const [core, pre = ""] = cleaned.split("-");
  const nums = core.split(".").map((n) => Number.parseInt(n, 10));
  const main: [number, number, number] = [
    Number.isFinite(nums[0]) ? nums[0] : 0,
    Number.isFinite(nums[1]) ? nums[1] : 0,
    Number.isFinite(nums[2]) ? nums[2] : 0,
  ];
  return { main, pre: pre ? pre.split(".") : [] };
}

/**
 * Compare two semver-ish versions. Returns -1 if a<b, 0 if equal, 1 if a>b.
 * Follows semver precedence: numeric core first, then a release outranks its
 * prerelease (1.0.0 > 1.0.0-rc.1), then prerelease identifiers compared
 * numerically/lexically. Tolerant of malformed input (missing parts => 0).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.main[i] > pb.main[i]) return 1;
    if (pa.main[i] < pb.main[i]) return -1;
  }
  // Equal core. No prerelease outranks a prerelease.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // shorter prerelease set is lower
    if (y === undefined) return 1;
    const xn = Number.parseInt(x, 10);
    const yn = Number.parseInt(y, 10);
    const xNum = String(xn) === x;
    const yNum = String(yn) === y;
    if (xNum && yNum) {
      if (xn > yn) return 1;
      if (xn < yn) return -1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numeric identifiers are lower than alphanumeric
    } else if (x > y) {
      return 1;
    } else if (x < y) {
      return -1;
    }
  }
  return 0;
}

/**
 * The core decision the test locks down:
 *   - newer available  -> "prompt-download"
 *   - same or older     -> "up-to-date"   (no-op)
 *   - offline / no feed -> "silent"        (do nothing, never crash)
 */
export function decideUpdateAction(
  current: string,
  latest: string | null | undefined,
  opts: { online: boolean }
): UpdateAction {
  if (!opts.online || !latest) {
    return "silent";
  }
  return compareVersions(latest, current) > 0 ? "prompt-download" : "up-to-date";
}

// ---------------------------------------------------------------------------
// Controller: wires an injected electron-updater `autoUpdater` to status
// callbacks. Kept structural (no electron import) so it's unit-testable with a
// fake emitter.
// ---------------------------------------------------------------------------

export type AutoUpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};

export type UpdateController = {
  /** Run a check (opt-in on launch, or the manual button). Never throws. */
  check(): Promise<void>;
  /** User confirmed: download the available update. Never throws. */
  download(): Promise<void>;
  /** User confirmed: quit and install a downloaded update. Round-3 #2: with
   *  live governed work in flight this QUEUES (status `waiting-for-work`)
   *  and completes when the crew drains; `force` interrupts by name. */
  install(options?: { force?: boolean }): void;
  /** Latest status emitted (also pushed through onStatus). */
  status(): UpdateStatus;
};

type UpdateInfoLike = {
  version?: string;
  releaseNotes?: unknown;
  files?: { url?: string; sha512?: string; size?: number }[];
};
type ProgressLike = { percent?: number };

/** ADR-0029: the unsigned apply path main.ts injects under `"staged-swap"`. */
export type StagedSwapHooks = {
  /**
   * Download the feed-named zip and VERIFY its sha512 before resolving with
   * the local path. Must throw (never resolve) on a hash mismatch.
   */
  download(file: { url: string; sha512: string }, onPercent: (p: number) => void): Promise<string>;
  /** Unpack + atomic swap + relaunch (does not resolve on success — the app exits). */
  apply(zipPath: string, version: string): Promise<void>;
};

export function createUpdateController(opts: {
  autoUpdater: AutoUpdaterLike;
  currentVersion: string;
  onStatus: (status: UpdateStatus) => void;
  /** Override online detection (tests). Defaults to always-attempt (errors are handled). */
  isOnline?: () => boolean;
  /**
   * Explicit activation seam (ADR-0029): "check-only" until a policy is
   * earned; "staged-swap" for packaged UNSIGNED builds installed under
   * /Applications; "signed-verified" for the future Squirrel path once
   * signed two-version install evidence exists.
   */
  installPolicy?: "check-only" | "staged-swap" | "signed-verified";
  /** Required when installPolicy is "staged-swap". */
  staged?: StagedSwapHooks;
  /**
   * Round-3 #2 — labels of LIVE GOVERNED WORK a restart would interrupt
   * (active dispatch jobs). Supplied by main.ts, the only caller that
   * enables installs; when absent the gate is skipped (the caller vouches
   * there is no governed work to guard — true of every test harness).
   * A probe FAILURE fails closed: no restart over an unverifiable crew.
   */
  liveWork?: () => Promise<string[]>;
  /** Recheck cadence while queued (tests shrink it). */
  workRecheckMs?: number;
}): UpdateController {
  const { autoUpdater, currentVersion, onStatus } = opts;
  const isOnline = opts.isOnline ?? (() => true);
  const stagedMode = opts.installPolicy === "staged-swap" && Boolean(opts.staged);
  const installsEnabled = opts.installPolicy === "signed-verified" || stagedMode;
  const installUnavailable =
    "In-app install is disabled until a signed, notarized two-version upgrade is verified.";

  /** The zip entry of the latest "available" feed answer (staged-swap needs
   *  its url + sha512), and the verified local file once downloaded. */
  let pendingFile: { url: string; sha512: string; version: string } | null = null;
  let downloadedZip: { path: string; version: string } | null = null;
  /** Signed path's downloaded version (staged mode tracks downloadedZip). */
  let lastDownloadedVersion: string | null = null;
  /** Round-3 #2: the queued-install recheck timer. One at a time; cleared
   *  the moment an install proceeds or a new install() call supersedes it. */
  let workRecheck: ReturnType<typeof setInterval> | null = null;
  const clearWorkRecheck = () => {
    if (workRecheck) {
      clearInterval(workRecheck);
      workRecheck = null;
    }
  };
  /** Every install() call mints a new generation; a probe that resolves
   *  AFTER being superseded (a force landed mid-await) must neither apply a
   *  second swap nor resurrect the waiting state (Greptile P1 on PR #35). */
  let installGeneration = 0;
  /**
   * An apply is in flight, or already relaunched. CONTROLLER-scoped, not
   * per-install: the generation fence guards the PROBE, but a second
   * install() used to get fresh local guards and could start a second
   * `staged.apply` against the same application, backup and staging paths
   * while the first was still running — rename failures, a failed rollback,
   * or a stranded bundle (Greptile P1, PR #35 round 4). Cleared only when an
   * apply FAILS, so a genuine retry is still possible.
   */
  let applyInFlight = false;

  // Never auto-download or auto-install: every step needs explicit consent.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  let current: UpdateStatus = { state: "idle" };
  const emit = (next: UpdateStatus): void => {
    current = next;
    onStatus(next);
  };

  autoUpdater.on("checking-for-update", () => emit({ state: "checking" }));

  autoUpdater.on("update-available", (...args: unknown[]) => {
    const info = (args[0] ?? {}) as UpdateInfoLike;
    const version = info.version ?? "unknown";
    // Route through our own decision so "same/older" can never falsely prompt,
    // regardless of what the feed emits.
    const action = decideUpdateAction(currentVersion, info.version, {
      online: true,
    });
    if (action === "prompt-download") {
      // Capture the feed's zip entry for the staged-swap download. Only an
      // entry WITH a sha512 is usable — verified bytes only (ADR-0029).
      const zip = info.files?.find(
        (f) => typeof f.url === "string" && f.url.endsWith(".zip")
      );
      pendingFile =
        zip?.url && zip.sha512
          ? { url: zip.url, sha512: zip.sha512, version }
          : null;
      const notes =
        typeof info.releaseNotes === "string" ? info.releaseNotes : undefined;
      emit({ state: "available", version, notes });
    } else {
      emit({ state: "up-to-date", version: currentVersion });
    }
  });

  autoUpdater.on("update-not-available", () =>
    emit({ state: "up-to-date", version: currentVersion })
  );

  autoUpdater.on("download-progress", (...args: unknown[]) => {
    const p = (args[0] ?? {}) as ProgressLike;
    emit({ state: "downloading", percent: Math.round(p.percent ?? 0) });
  });

  autoUpdater.on("update-downloaded", (...args: unknown[]) => {
    const info = (args[0] ?? {}) as UpdateInfoLike;
    lastDownloadedVersion = info.version ?? currentVersion;
    emit({ state: "downloaded", version: lastDownloadedVersion });
  });

  autoUpdater.on("error", (...args: unknown[]) => {
    // Offline / feed unreachable / rate-limited: a benign, non-fatal status.
    // NEVER rethrow, a failed check must not crash the app.
    const err = args[0];
    const message =
      err instanceof Error ? err.message : String(err ?? "update check failed");
    emit({ state: "error", message });
  });

  return {
    async check() {
      if (!isOnline()) {
        // Silent no-op: honor no-egress; surface a low-key status only.
        emit({ state: "error", message: "offline, skipped update check" });
        return;
      }
      try {
        emit({ state: "checking" });
        await autoUpdater.checkForUpdates();
      } catch (err) {
        // electron-updater also emits 'error'; swallow the rejection so a check
        // can never throw into the caller.
        const message =
          err instanceof Error ? err.message : String(err ?? "update check failed");
        emit({ state: "error", message });
      }
    },
    async download() {
      if (!installsEnabled) {
        emit({ state: "error", message: installUnavailable });
        return;
      }
      if (stagedMode) {
        if (!pendingFile) {
          emit({
            state: "error",
            message:
              "No verifiable update is pending (the feed carried no sha512). Run a check first.",
          });
          return;
        }
        try {
          const target = pendingFile;
          emit({ state: "downloading", percent: 0 });
          const zipPath = await opts.staged!.download(target, (p) =>
            emit({ state: "downloading", percent: Math.round(p) })
          );
          downloadedZip = { path: zipPath, version: target.version };
          emit({ state: "downloaded", version: target.version });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err ?? "download failed");
          emit({ state: "error", message });
        }
        return;
      }
      try {
        await autoUpdater.downloadUpdate();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err ?? "download failed");
        emit({ state: "error", message });
      }
    },
    install(options) {
      // A new explicit install (forced or not) supersedes any queued one —
      // including any probe currently mid-await (generation fence below).
      installGeneration += 1;
      const generation = installGeneration;
      clearWorkRecheck();
      const proceed = () => {
        // The swap renames the running bundle. Two of them over the same
        // paths is unrecoverable, so this latch outranks every other guard.
        if (applyInFlight) return;
        if (stagedMode) {
          if (!downloadedZip) {
            emit({ state: "error", message: "No downloaded update to install." });
            return;
          }
          applyInFlight = true;
          // apply() swaps and relaunches; it only returns by throwing.
          void opts.staged!.apply(downloadedZip.path, downloadedZip.version).catch(
            (err) => {
              // A FAILED apply releases the latch: the swap did not happen,
              // so a retry is legitimate.
              applyInFlight = false;
              const message =
                err instanceof Error ? err.message : String(err ?? "install failed");
              emit({ state: "error", message });
            }
          );
          return;
        }
        applyInFlight = true;
        autoUpdater.quitAndInstall();
      };
      if (!installsEnabled) {
        emit({ state: "error", message: installUnavailable });
        return;
      }
      if (options?.force || !opts.liveWork) {
        proceed();
        return;
      }
      // Round-3 #2: an update is a governed state change. The restart QUEUES
      // behind live crew work and NAMES what it would interrupt, instead of
      // quitting under it. The human's explicit install intent is completed
      // on its own the moment the crew drains — deferred, never forgotten.
      const version =
        downloadedZip?.version ?? lastDownloadedVersion ?? "update";
      // ONE probe at a time, and one apply per generation: a probe slower
      // than the recheck interval must not let overlapping same-generation
      // gates each observe "clear" and each swap (Greptile round-2 P1).
      let gateInFlight = false;
      const gate = async (): Promise<void> => {
        if (gateInFlight || applyInFlight) return;
        gateInFlight = true;
        try {
          await gateOnce();
        } finally {
          gateInFlight = false;
        }
      };
      const gateOnce = async (): Promise<void> => {
        let lanes: string[];
        try {
          lanes = await opts.liveWork!();
        } catch {
          if (generation !== installGeneration) return; // superseded mid-await
          // Fail closed: no restart over a crew MUON could not verify.
          clearWorkRecheck();
          emit({
            state: "error",
            message:
              "Could not verify that no governed work is mid-flight. Retry, or use Restart now to interrupt.",
          });
          return;
        }
        // A probe that outlived its install() call decides NOTHING: a newer
        // (possibly forced) install owns the swap now, and a stale "all
        // clear" here would race a second apply over the same bundle paths.
        if (generation !== installGeneration) return;
        if (lanes.length === 0) {
          clearWorkRecheck();
          proceed();
          return;
        }
        emit({
          state: "waiting-for-work",
          version,
          lanes: lanes.slice(0, 8),
        });
        if (!workRecheck) {
          workRecheck = setInterval(() => {
            void gate();
          }, opts.workRecheckMs ?? 30_000);
        }
      };
      void gate();
    },
    status() {
      return current;
    },
  };
}
