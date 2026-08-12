import { spawn } from "node:child_process";
import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { readCliVersion } from "../lib/app-version.js";
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
 * `muon update` — bring this install up to the latest published release.
 *
 * The CLI/TUI ship as an npm tarball from MUON's own download host (no
 * registry, no package manager to keep in step), which means an installed copy
 * has no way to learn that a newer one exists. Before this, "update" meant
 * remembering the curl one-liner and running it again.
 *
 * It does NOT touch the desktop app or the brain: those have their own signed
 * update path, and a CLI command that silently replaced the app would be
 * changing something the operator did not ask about.
 */
export function registerUpdateCommand(program: Command) {
  program
    .command("update")
    .description("update the MUON CLI + TUI to the latest published release")
    .option("--check", "report what is available and exit, changing nothing")
    .option("--dry-run", "print the exact install command instead of running it")
    .option(
      "--host <url>",
      "release host to read from",
      process.env.MUON_DOWNLOAD_HOST || DEFAULT_DOWNLOAD_HOST
    )
    .action(
      async (options: { check?: boolean; dryRun?: boolean; host: string }) => {
        try {
          const installed = await readCliVersion(import.meta.url);
          const latest = await fetchLatestVersion(options.host);
          const verdict = decideUpdate(installed, latest);
          process.stdout.write(`${describeVerdict(verdict)}\n`);

          if (options.check) {
            // Exit code carries the answer so a script can gate on it without
            // parsing prose: 0 = nothing to do, 10 = an update is available.
            process.exitCode = verdict.kind === "available" ? 10 : 0;
            return;
          }
          if (verdict.kind !== "available") {
            return;
          }
          if (options.dryRun) {
            process.stdout.write(
              `would run: npm ${installArgv(options.host).join(" ")}\n`
            );
            return;
          }

          process.stdout.write(
            `updating from ${latestTarballUrl(options.host)} …\n`
          );
          const code = await runInstall(options.host);
          if (code !== 0) {
            // A failed global install is usually EACCES, and `sudo npm` is the
            // wrong remedy — it leaves root-owned files that break every later
            // install.
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
        } catch (error) {
          failCommand(error, "Update check failed.");
        }
      }
    );
}
