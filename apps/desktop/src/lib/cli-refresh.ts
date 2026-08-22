/**
 * After the DESKTOP updates itself, pull the machine's npm-global CLI along
 * (founder requirement, 2026-08-19: "update SHOULD auto-update all aspects").
 *
 * The two install channels update through different doors — `muon update`
 * replaces the npm tarball and (since the same date) the app; the in-app
 * updater replaces the app. This module closes the remaining gap: an operator
 * who only ever updates through the APP would otherwise keep an aging global
 * `muon` forever, drifting from the brain it spawns.
 *
 * Strictly BEST-EFFORT and strictly NARROW:
 *  - only a PRESENT global `muon-cli` is touched — a machine that never ran
 *    the curl installer gets nothing installed on it uninvited (the app's own
 *    staged CLI under Resources/cli is already updated by the app swap);
 *  - only an OLDER one — a newer global CLI (a CLI-only release, a dev box)
 *    is left alone;
 *  - failure is a log line, never a dialog, never a blocked launch. The
 *    operator's own `muon update` remains the manual door.
 */
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { compareVersions } from "./updater.js";

const execFileAsync = promisify(execFile);

/** The canonical download host, identical to electron-builder.yml's publish
 *  url. PINNED — this module deliberately has NO override path of any kind
 *  (cubic pass-4 #1: a `host` parameter made the pin a call-site convention
 *  one re-added line could undo with a green typecheck). The plan feeds a
 *  promptless `npm install -g`; anything that could point it elsewhere —
 *  an env var, a parameter — is an arbitrary-code-execution bridge. Staging
 *  overrides live only on the explicit, typed-out surfaces (`muon update
 *  --host`, install.sh). */
export const DOWNLOAD_HOST_PINNED = "https://download.getmuon.com";

export function cliTarballUrl(): string {
  return `${DOWNLOAD_HOST_PINNED}/muon-cli-latest.tgz`;
}

export type CliRefreshPlan =
  | { readonly refresh: false; readonly reason: string }
  | { readonly refresh: true; readonly from: string; readonly argv: string[] };

/**
 * The decision, pure. `globalCliVersion` is null when no global muon-cli is
 * installed (or its manifest is unreadable, which for a refresh is the same
 * answer: do not touch what cannot be compared).
 */
export function cliRefreshPlan(input: {
  readonly appVersion: string;
  readonly globalCliVersion: string | null;
}): CliRefreshPlan {
  if (!input.globalCliVersion) {
    return { refresh: false, reason: "no npm-global muon-cli on this machine" };
  }
  // STRICT semver, checked here: the updater's own compareVersions is lenient
  // (garbage parses as 0.0.0), which for an update PROMPT is the right call —
  // but this function decides whether to run npm against the operator's global
  // prefix uninvited, and "I could not read your version so I replaced it"
  // is not the narrow posture this module promises.
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(input.globalCliVersion)) {
    return {
      refresh: false,
      reason: `global muon-cli version ${input.globalCliVersion} is not comparable`,
    };
  }
  const order = compareVersions(input.globalCliVersion, input.appVersion);
  if (order >= 0) {
    return {
      refresh: false,
      reason: `global muon-cli ${input.globalCliVersion} is not older than the app (${input.appVersion})`,
    };
  }
  return {
    refresh: true,
    from: input.globalCliVersion,
    argv: ["install", "-g", cliTarballUrl()],
  };
}

/**
 * `npm root -g`, ASYNC. The refresh runs on Electron's main thread right after
 * an updated boot; a `spawnSync` here — even inside a `void`ed IIFE — blocks
 * the process until npm answers, because sync is sync wherever it sits
 * relative to an `await`. Null when npm is missing or slow.
 */
export async function resolveNpmGlobalRootAsync(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const root = String(stdout).trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/** Read the global muon-cli's version from an npm global root. Null when it is
 *  not installed there or will not parse. */
export function readGlobalCliVersion(npmGlobalRoot: string | null): string | null {
  if (!npmGlobalRoot) return null;
  try {
    const manifest = JSON.parse(
      readFileSync(join(npmGlobalRoot, "muon-cli", "package.json"), "utf8")
    ) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version
      ? manifest.version
      : null;
  } catch {
    return null;
  }
}

/**
 * Run the refresh npm decided on. Resolves to a one-line outcome for the
 * caller's log; never throws, never blocks anything (the caller `void`s it).
 */
export function runCliRefresh(
  plan: CliRefreshPlan,
  spawnImpl: typeof spawn = spawn
): Promise<string> {
  if (!plan.refresh) return Promise.resolve(`skipped: ${plan.reason}`);
  return new Promise((resolve) => {
    try {
      const child = spawnImpl("npm", plan.argv, {
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", (error) =>
        resolve(`failed to spawn npm: ${error.message}`)
      );
      child.on("close", (code) =>
        resolve(
          code === 0
            ? `refreshed the npm-global muon-cli (was ${plan.from})`
            : `npm install exited ${code} — run \`muon update\` to retry by hand`
        )
      );
    } catch (error) {
      resolve(
        `failed to spawn npm: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });
}
