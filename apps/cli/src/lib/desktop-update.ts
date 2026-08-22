/**
 * `muon update` — the DESKTOP half (founder requirement, 2026-08-19: "update
 * SHOULD auto-update all aspects").
 *
 * One command now updates everything the machine runs: the npm half updates
 * `muon`/`muon-tui`/`muon-mcp` (update.ts), and this module updates
 * `MUON.app` — which is ALSO where the embedded brain lives
 * (Resources/backend; `@muon/client/ensure-brain` spawns the CLI's brain from
 * the installed app), so updating the app is what updates the brain for every
 * surface.
 *
 * The mechanics are ADR-0029's staged swap, from the outside: read the SAME
 * feed the in-app updater reads (latest-mac.yml on the download host), fetch
 * the zip, verify its sha512 against the feed BEFORE anything is touched,
 * extract, and swap with two renames so the app path never half-exists. The
 * one thing this must never do is replace an app that is RUNNING — that is a
 * corrupted session, not an update — so a live app is a refusal with the
 * remedy named, never a force.
 *
 * Decision logic is pure and injectable; the IO lives behind `DesktopUpdateIo`
 * so every rule is testable without a 600MB download or a real /Applications.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { decideUpdate, type UpdateVerdict } from "./update-check.js";

/** The feed file electron-builder publishes beside the artifacts. */
export const DESKTOP_FEED_FILE = "latest-mac.yml";

export function desktopFeedUrl(host: string): string {
  return `${host.replace(/\/+$/, "")}/${DESKTOP_FEED_FILE}`;
}

// The https rule lives ONCE, in @muon/client/download-host — the desktop's
// background CLI refresh applies the same predicate, and two copies of a
// security rule drift (cubic pass-3 #6). Re-exported so existing importers
// keep their name.
import { hostSchemeRefusal } from "@muon/client/download-host";
export { hostSchemeRefusal };

export type DesktopFeed = {
  readonly version: string;
  /** The zip artifact's file name on the host (the feed's `path`). */
  readonly zipPath: string;
  /** Base64 sha512 of that zip, from the feed. */
  readonly sha512: string;
};

/**
 * Parse the minimal facts out of latest-mac.yml. Deliberately not a YAML
 * library: the feed is machine-written by electron-builder with a fixed shape
 * (`version`, `files[]`, top-level `path` + `sha512`), and the three scalars
 * this needs are single-line `key: value` pairs. A malformed feed returns
 * null — the caller reports "feed unreadable", never a guess.
 */
export function parseDesktopFeed(yml: string): DesktopFeed | null {
  const scalar = (key: string): string | null => {
    // Top-level only: `files:` entries are indented, so anchoring at column 0
    // keeps a per-file sha512 from masquerading as the artifact's.
    const match = yml.match(new RegExp(`^${key}:\\s*(.+)\\s*$`, "m"));
    return match ? match[1]!.trim().replace(/^['"]|['"]$/g, "") : null;
  };
  const version = scalar("version");
  const zipPath = scalar("path");
  const sha512 = scalar("sha512");
  if (!version || !zipPath || !sha512) return null;
  // The top-level path has always been the zip; a feed that starts naming
  // something else should be looked at by a human, not auto-installed.
  if (!zipPath.endsWith(".zip")) return null;
  return { version, zipPath, sha512 };
}

/** Where an installed MUON.app can live, in probe order. */
export function desktopAppCandidatePaths(
  env: Readonly<Record<string, string | undefined>>,
  home: string
): readonly string[] {
  const override = env.MUON_APP_PATH?.trim();
  return [
    ...(override ? [override] : []),
    "/Applications/MUON.app",
    `${home}/Applications/MUON.app`,
  ];
}

export type DesktopUpdateOutcome =
  /** No MUON.app on this machine — not an error; DMG-less installs exist. */
  | { readonly kind: "not-installed" }
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "ahead"; readonly installed: string; readonly latest: string }
  /** An update exists but the app is RUNNING. Refused, remedy named. */
  | {
      readonly kind: "running";
      readonly installed: string;
      readonly latest: string;
    }
  | {
      readonly kind: "updated";
      readonly from: string;
      readonly to: string;
      readonly appPath: string;
    }
  | { readonly kind: "failed"; readonly reason: string };

/** Everything with a side effect, injectable. Defaults are the real thing. */
export type DesktopUpdateIo = {
  readonly findApp: () => Promise<{ appPath: string; version: string } | null>;
  readonly fetchFeed: (url: string) => Promise<string>;
  /** Download `url` into a fresh staging dir. Returns the file, its base64
   *  sha512, and the STAGING DIR ITSELF — the recursive delete keys on what
   *  this function says it created, never on a path derived from the file.
   *  On failure the implementation removes its own partial staging first. */
  readonly download: (
    url: string
  ) => Promise<{ file: string; sha512: string; staging: string }>;
  readonly isAppRunning: (appPath: string) => Promise<boolean>;
  /** Extract the zip and return the path of the .app inside it. */
  readonly extract: (zipFile: string) => Promise<string>;
  /** Two-rename swap: retire the old app, move the new one in. */
  readonly swap: (appPath: string, newAppPath: string) => Promise<void>;
  /** Remove the download/extract staging tree. Best-effort. */
  readonly removeStaging: (path: string) => Promise<void>;
};

export function realDesktopUpdateIo(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = process.env.HOME ?? "~"
): DesktopUpdateIo {
  return {
    async findApp() {
      for (const appPath of desktopAppCandidatePaths(env, home)) {
        try {
          if (!(await stat(appPath)).isDirectory()) continue;
        } catch {
          continue;
        }
        const version = readAppVersion(appPath);
        if (version) return { appPath, version };
      }
      return null;
    },
    async fetchFeed(url) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`could not read ${url} (HTTP ${response.status})`);
      }
      return response.text();
    },
    async download(url) {
      const response = await fetch(url);
      if (!response.ok || !response.body) {
        throw new Error(`could not download ${url} (HTTP ${response.status})`);
      }
      const dir = await mkdtemp(join(tmpdir(), "muon-app-update-"));
      try {
        const file = join(dir, "MUON-update.zip");
        const hash = createHash("sha512");
        // Streamed to disk, hashed on the way through — never 600MB in memory.
        await pipeline(
          Readable.fromWeb(response.body as import("stream/web").ReadableStream),
          async function* (source) {
            for await (const chunk of source) {
              hash.update(chunk as Buffer);
              yield chunk;
            }
          },
          createWriteStream(file)
        );
        return { file, sha512: hash.digest("base64"), staging: dir };
      } catch (error) {
        // A mid-stream failure (reset, ENOSPC) is the exit MOST likely to
        // leave a large partial file — the caller never learns this dir
        // existed, so it is removed here, where it was created.
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },
    async isAppRunning(appPath) {
      // The app's own binary path, so another app named MUON-something (or a
      // grep of this very command line) never counts. FAIL CLOSED: pgrep's
      // contract is 0 = matched, 1 = no match — anything else (or a spawn
      // failure) means the question was not answered, and the only safe
      // reading of "unknown" for a live-app check that gates a bundle swap is
      // "assume running, refuse".
      try {
        const probe = spawnSync("pgrep", ["-f", `${appPath}/Contents/MacOS/`], {
          encoding: "utf8",
          timeout: 5000,
        });
        if (probe.status === 0) return probe.stdout.trim().length > 0;
        if (probe.status === 1) return false;
        return true;
      } catch {
        return true;
      }
    },
    async extract(zipFile) {
      const dest = join(zipFile.replace(/[^/]+$/, ""), "extracted");
      // ditto preserves symlinks, resource forks and exec bits — the things a
      // .app bundle breaks without. `unzip` is not equivalent.
      await new Promise<void>((resolve, reject) => {
        const child = spawn("ditto", ["-x", "-k", zipFile, dest], {
          stdio: "ignore",
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`ditto exited ${code} extracting the update`))
        );
      });
      const entries = await readdir(dest);
      const app = entries.find((name) => name.endsWith(".app"));
      if (!app) throw new Error("the update zip contains no .app bundle");
      return join(dest, app);
    },
    async swap(appPath, newAppPath) {
      const retired = `${appPath}.retired-${process.pid}-${Date.now()}`;
      await rename(appPath, retired);
      try {
        await rename(newAppPath, appPath);
      } catch (error) {
        // Roll the old app back — a machine with NO app is strictly worse
        // than a machine with the old one.
        await rename(retired, appPath).catch(() => undefined);
        throw error;
      }
      await rm(retired, { recursive: true, force: true }).catch(() => undefined);
    },
    async removeStaging(path) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** CFBundleShortVersionString, read with plutil (always present on macOS). */
export function readAppVersion(appPath: string): string | null {
  try {
    const result = spawnSync(
      "plutil",
      [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        "-o",
        "-",
        join(appPath, "Contents", "Info.plist"),
      ],
      { encoding: "utf8", timeout: 5000 }
    );
    const version = result.status === 0 ? result.stdout.trim() : "";
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/** The check half alone — what `muon update --check` prints for the desktop. */
export async function desktopUpdateVerdict(
  host: string,
  io: DesktopUpdateIo
): Promise<
  | { kind: "not-installed" }
  | { kind: "feed-unreadable"; reason: string }
  /** The feed read fine; one of the two VERSIONS is not comparable (a
   *  hand-edited Info.plist, a typo'd feed). Its own kind, because "could not
   *  read the release feed" about a feed that parsed is a wrong sentence. */
  | { kind: "uncomparable"; reason: string }
  | { kind: "verdict"; verdict: UpdateVerdict; appPath: string }
> {
  const schemeRefusal = hostSchemeRefusal(host);
  if (schemeRefusal) {
    return { kind: "feed-unreadable", reason: schemeRefusal };
  }
  const app = await io.findApp();
  if (!app) return { kind: "not-installed" };
  let feed: DesktopFeed | null;
  try {
    feed = parseDesktopFeed(await io.fetchFeed(desktopFeedUrl(host)));
  } catch (error) {
    return {
      kind: "feed-unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!feed) {
    return {
      kind: "feed-unreadable",
      reason: `${desktopFeedUrl(host)} did not carry version + path + sha512`,
    };
  }
  // `decideUpdate` throws on a non-semver version (a hand-edited Info.plist,
  // a feed someone typo'd). The CLI half of `muon update --check` may already
  // have printed a correct verdict by the time this runs, so a throw here
  // would report a whole-command failure about a half that merely could not
  // be compared.
  try {
    return {
      kind: "verdict",
      verdict: decideUpdate(app.version, feed.version),
      appPath: app.appPath,
    };
  } catch (error) {
    return {
      kind: "uncomparable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Update the installed desktop app, end to end. Never throws — every failure
 * is an outcome with a reason, because this runs as the second half of a
 * command whose first half (the CLI update) may already have succeeded, and a
 * throw here would read as "the update failed" about a CLI that updated fine.
 */
export async function updateDesktopApp(
  host: string,
  io: DesktopUpdateIo
): Promise<DesktopUpdateOutcome> {
  // A staging tree exists from the moment a download starts; whatever path the
  // function leaves by, it is removed (success included — the swap MOVED the
  // .app out of it, so only wrappage remains).
  let staging: string | undefined;
  try {
    const schemeRefusal = hostSchemeRefusal(host);
    if (schemeRefusal) {
      return { kind: "failed", reason: schemeRefusal };
    }

    const app = await io.findApp();
    if (!app) return { kind: "not-installed" };

    const feedText = await io.fetchFeed(desktopFeedUrl(host));
    const feed = parseDesktopFeed(feedText);
    if (!feed) {
      return {
        kind: "failed",
        reason: `${desktopFeedUrl(host)} did not carry version + path + sha512`,
      };
    }

    let verdict: UpdateVerdict;
    try {
      verdict = decideUpdate(app.version, feed.version);
    } catch (error) {
      // A non-semver version (hand-edited Info.plist, typo'd feed) is a
      // legible refusal, never a throw past the CLI half's own output.
      return {
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (verdict.kind === "current") {
      return { kind: "current", version: app.version };
    }
    if (verdict.kind === "ahead") {
      return { kind: "ahead", installed: app.version, latest: feed.version };
    }

    // Checked BEFORE the download — a 600MB pull nobody can use is rude.
    if (await io.isAppRunning(app.appPath)) {
      return { kind: "running", installed: app.version, latest: feed.version };
    }

    const zipUrl = `${host.replace(/\/+$/, "")}/${feed.zipPath}`;
    const downloaded = await io.download(zipUrl);
    staging = downloaded.staging;
    if (downloaded.sha512 !== feed.sha512) {
      // ADR-0029's rule, held here too: verify BEFORE applying, and a mismatch
      // names both digests so "corrupted download" and "stale feed" are
      // distinguishable at the terminal.
      return {
        kind: "failed",
        reason:
          `sha512 mismatch for ${zipUrl}: feed says ${feed.sha512}, ` +
          `download hashed ${downloaded.sha512}. Nothing was installed.`,
      };
    }

    const newApp = await io.extract(downloaded.file);

    // Re-checked AFTER the download, immediately before the swap: the first
    // check gated a multi-minute download, and an app launched during it
    // would otherwise have /Applications/MUON.app renamed out from under a
    // live process — exactly the corrupted session this module promises
    // never to cause.
    if (await io.isAppRunning(app.appPath)) {
      return { kind: "running", installed: app.version, latest: feed.version };
    }

    await io.swap(app.appPath, newApp);
    return {
      kind: "updated",
      from: app.version,
      to: feed.version,
      appPath: app.appPath,
    };
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (staging) await io.removeStaging(staging);
  }
}

/** Human sentence per outcome — one author, so update.ts prints and tests
 *  assert the same words. */
export function describeDesktopOutcome(outcome: DesktopUpdateOutcome): string {
  switch (outcome.kind) {
    case "not-installed":
      return "desktop app: not installed on this machine — skipped.";
    case "current":
      return `desktop app: MUON.app ${outcome.version} is the latest release.`;
    case "ahead":
      return `desktop app: MUON.app ${outcome.installed} is newer than the latest release (${outcome.latest}) — a local build, most likely.`;
    case "running":
      return (
        `desktop app: MUON ${outcome.latest} is available (you have ${outcome.installed}), but the app is running. ` +
        "Quit MUON (⌘Q) and re-run `muon update`, or use Settings → Updates inside the app."
      );
    case "updated":
      return `desktop app: updated MUON.app ${outcome.from} → ${outcome.to} (brain included — the CLI and TUI spawn it from the app).`;
    case "failed":
      return `desktop app: update failed — ${outcome.reason}`;
  }
}
