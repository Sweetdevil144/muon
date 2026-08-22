import { spawn } from "node:child_process";
import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { readCliVersion } from "../lib/app-version.js";
import {
  describeDesktopOutcome,
  desktopUpdateVerdict,
  hostSchemeRefusal,
  realDesktopUpdateIo,
  updateDesktopApp,
  type DesktopUpdateIo,
} from "../lib/desktop-update.js";
import {
  DEFAULT_DOWNLOAD_HOST,
  decideUpdate,
  describeVerdict,
  installArgv,
  latestTarballUrl,
} from "../lib/update-check.js";

/** Read the published version from the release host's own tarball metadata. */
async function fetchLatestVersion(host: string): Promise<string> {
  // The published package.json is inside the tarball, so the cheap read is the
  // GitHub release list — but that would tie `muon update` to GitHub's API and
  // its rate limit. Instead the download host serves a tiny version marker
  // beside the tarball; when it is absent we fall back to the tarball itself.
  const versionUrl = `${host.replace(/\/+$/, "")}/latest-cli.json`;
  const response = await fetch(versionUrl);
  if (!response.ok) {
    throw new Error(
      `could not read the latest version from ${versionUrl} (HTTP ${response.status})`
    );
  }
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !body.version) {
    throw new Error(`${versionUrl} did not name a version`);
  }
  return body.version;
}

function runInstall(host: string): Promise<number> {
  return new Promise((resolve) => {
    // npm, not a curl|bash re-run: the installer's job is Node discovery and a
    // first-time greeting, neither of which applies to an in-place upgrade.
    const child = spawn("npm", installArgv(host), { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/**
 * `muon update` — bring EVERYTHING this machine runs up to the latest release.
 *
 * Two halves, one command (founder requirement, 2026-08-19: "update SHOULD
 * auto-update all aspects"):
 *
 *  1. The npm half: `muon`/`muon-tui`/`muon-mcp` ship as a tarball from MUON's
 *     own download host; `npm install -g` replaces them (and materializes the
 *     pinned `gitnexus` beside them).
 *  2. The desktop half (macOS): MUON.app — which is also where the embedded
 *     BRAIN lives (Resources/backend; the CLI and TUI spawn it from the
 *     installed app) — is updated from the same feed the in-app updater reads,
 *     sha512-verified before anything is touched (ADR-0029's rule, held from
 *     the outside). A RUNNING app is never replaced: that half refuses with
 *     the remedy named, and the in-app Settings → Updates path remains.
 *
 * `--cli-only` / `--desktop-only` narrow it when the operator means one half.
 */
export function registerUpdateCommand(
  program: Command,
  desktopIo?: DesktopUpdateIo
) {
  program
    .command("update")
    .description(
      "update MUON — CLI, TUI, MCP, and the desktop app (brain included) — to the latest published release"
    )
    .option("--check", "report what is available and exit, changing nothing")
    .option("--dry-run", "print what would run instead of running it")
    .option("--cli-only", "update only the CLI/TUI/MCP half")
    .option("--desktop-only", "update only the desktop app half")
    .option(
      "--host <url>",
      "release host to read from",
      process.env.MUON_DOWNLOAD_HOST || DEFAULT_DOWNLOAD_HOST
    )
    .action(
      async (options: {
        check?: boolean;
        dryRun?: boolean;
        cliOnly?: boolean;
        desktopOnly?: boolean;
        host: string;
      }) => {
        try {
          // https for the WHOLE command, not just the desktop half. The CLI
          // half is the HIGHER-risk one: `npm install -g <url>` executes the
          // tarball's lifecycle scripts, so a plaintext --host (or
          // MUON_DOWNLOAD_HOST) hands a network position code execution.
          const schemeRefusal = hostSchemeRefusal(options.host);
          if (schemeRefusal) {
            failCommand(new Error(schemeRefusal), "Update refused.");
            return;
          }
          if (options.cliOnly && options.desktopOnly) {
            // Both narrows at once select nothing — refuse rather than print
            // nothing and exit 0, which reads as a successful update.
            failCommand(
              new Error(
                "--cli-only and --desktop-only exclude each other; pass one or neither."
              ),
              "Update refused."
            );
            return;
          }
          if (options.desktopOnly && process.platform !== "darwin") {
            // A silent no-op is indistinguishable from a successful update.
            process.stdout.write(
              "desktop app: MUON.app is distributed for macOS only — nothing to update on this platform.\n"
            );
            return;
          }
          const doCli = !options.desktopOnly;
          const doDesktop = !options.cliOnly && process.platform === "darwin";
          const io = desktopIo ?? realDesktopUpdateIo();
          let cliAvailable = false;
          let desktopAvailable = false;

          if (doCli) {
            const installed = await readCliVersion(import.meta.url);
            const latest = await fetchLatestVersion(options.host);
            const verdict = decideUpdate(installed, latest);
            process.stdout.write(`${describeVerdict(verdict)}\n`);
            cliAvailable = verdict.kind === "available";

            if (!options.check && cliAvailable) {
              if (options.dryRun) {
                process.stdout.write(
                  `would run: npm ${installArgv(options.host).join(" ")}\n`
                );
              } else {
                process.stdout.write(
                  `updating from ${latestTarballUrl(options.host)} …\n`
                );
                const code = await runInstall(options.host);
                if (code !== 0) {
                  // A failed global install is usually EACCES, and `sudo npm`
                  // is the wrong remedy — it leaves root-owned files that
                  // break every later install.
                  failCommand(
                    new Error(
                      "npm install failed. If this is a permissions error, configure a user-writable npm prefix (https://docs.npmjs.com/resolving-eacces-permissions-errors) rather than using sudo, then re-run `muon update`."
                    ),
                    "Update failed."
                  );
                  return;
                }
                process.stdout.write(
                  `updated to ${latest}. Open a new shell if \`muon --version\` still reports the old one.\n`
                );
              }
            }
          }

          if (doDesktop) {
            if (options.check || options.dryRun) {
              const check = await desktopUpdateVerdict(options.host, io);
              if (check.kind === "not-installed") {
                process.stdout.write(
                  "desktop app: not installed on this machine — skipped.\n"
                );
              } else if (check.kind === "feed-unreadable") {
                // Same rule as `uncomparable` below, and as the CLI half
                // (whose fetchLatestVersion throw exits 1): a state that could
                // not be DETERMINED must never exit 0 — a gating script would
                // read a dead feed as "nothing to do" forever.
                process.stdout.write(
                  `desktop app: could not read the release feed — ${check.reason}\n`
                );
                process.exitCode = 1;
              } else if (check.kind === "uncomparable") {
                // The feed parsed; a VERSION is the problem (hand-edited
                // Info.plist, typo'd feed). Named as such, and exit 1: an
                // install whose version cannot be read is an anomaly a script
                // must not read as "nothing to do".
                process.stdout.write(
                  `desktop app: version not comparable — ${check.reason}\n`
                );
                process.exitCode = 1;
              } else {
                desktopAvailable = check.verdict.kind === "available";
                process.stdout.write(
                  `desktop app: ${describeVerdict(check.verdict).replace(
                    /^muon /,
                    "MUON.app "
                  )}\n`
                );
                if (options.dryRun && desktopAvailable) {
                  process.stdout.write(
                    `would update ${check.appPath} in place (sha512-verified staged swap).\n`
                  );
                }
              }
            } else {
              const outcome = await updateDesktopApp(options.host, io);
              process.stdout.write(`${describeDesktopOutcome(outcome)}\n`);
              // A refused-while-running desktop half is not a FAILED command,
              // but it is not a completed one either: exit 11 so a script (or
              // the founder) can tell "everything updated" from "one half is
              // waiting on a quit". `failed` keeps the ordinary failure exit.
              if (outcome.kind === "running") process.exitCode = 11;
              if (outcome.kind === "failed") process.exitCode = 1;
            }
          }

          if (options.check) {
            // Exit code carries the answer so a script can gate on it without
            // parsing prose: 0 = nothing to do, 10 = an update is available,
            // 1 = a state that could not be determined (dead feed,
            // uncomparable version). The ANOMALY wins over "available": exit
            // codes exist for the unattended consumer, and an unattended
            // consumer must be pulled to the broken half — the pending update
            // is not lost, the next run after the feed is fixed still
            // reports 10. Both facts are always printed above.
            if (!process.exitCode) {
              process.exitCode = cliAvailable || desktopAvailable ? 10 : 0;
            }
          }
        } catch (error) {
          failCommand(error, "Update check failed.");
        }
      }
    );
}
