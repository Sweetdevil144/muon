// Writes staged/build-config.json — the release coordinates a packaged app
// reads back at boot (src/lib/build-config.ts). Runs in the package/dist npm
// scripts AFTER stage-backend (staged/ must exist); electron-builder's
// extraResources (`from: staged, to: "."`) lands the file at <Resources>/.
//
// The GitHub App client id is PUBLIC by design (device flow, no client
// secret) — baking it is configuration, not secret embedding. An empty env
// still writes the file (with no id) so a missing id is a visible, diffable
// fact of the artifact rather than a missing file that could be anything.
//
// WHAT WAS MISSING, and why the guard below is imported rather than reimplemented:
// `MUON_GITHUB_CLIENT_SECRET` is seven characters away from
// `MUON_GITHUB_CLIENT_ID` in a release script nobody reads twice at 2am. The CLI
// bundler closed that hole by refusing secret-shaped values; this script baked
// the same variable with no check at all, so the `.dmg` — a public artifact,
// downloaded and unpackable by anyone — still had it. One guard, both bundlers.
//
// THE SHARED-CODE CHOICE: a relative hop into `apps/cli/scripts/lib/`. Both
// files are build-time-only scripts that run from the monorepo checkout and are
// never shipped inside any artifact, so a relative import costs nothing at
// package time; `apps/desktop` does not depend on `@muon/cli`, and inventing
// that dependency to share one pure function would be the worse trade (the same
// call `apps/tui` records for the six words it keeps in step with the CLI by
// test). Hoisting the guard to the repo-level `scripts/lib/` was the other
// option and is not obviously better: it would move the refusal away from the
// bundler whose mistake it exists to prevent, and rewrite that bundler's import
// for no behavioural gain.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBakedClientId } from "../../cli/scripts/lib/client-id-guard.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Bake the build config, or REFUSE.
 *
 * Exported (and the top-level run is guarded) for the same reason the guard
 * itself lives in its own module: a check against publishing a credential is
 * exactly the code that has to be tested by driving it, not by grepping its
 * source. Nothing is created before the guard answers — a refusal must not cost
 * the operator the `staged/` they had.
 *
 * @param {{ env?: Record<string, string | undefined>, stagedDir?: string,
 *           log?: (message: string) => void,
 *           warn?: (message: string) => void }} [options]
 * @returns {{ target: string, clientId: string }}
 */
export function writeBuildConfig(options = {}) {
  const env = options.env ?? process.env;
  const stagedDir = options.stagedDir ?? join(root, "staged");
  const log = options.log ?? ((message) => console.log(message));
  const warn = options.warn ?? ((message) => console.warn(message));

  // FIRST, before anything is written. The message is the guard's own, so the
  // desktop and the CLI tell an operator the same thing about the same value.
  const check = checkBakedClientId(env.MUON_GITHUB_CLIENT_ID);
  if (!check.ok) {
    throw new Error(
      `[build-config] refusing to bake MUON_GITHUB_CLIENT_ID into the desktop artifact. ${check.reason}`
    );
  }
  // The value the GUARD returned, never the environment a second time — reading
  // `process.env` again at the write is the one way this guard gets defeated.
  const clientId = check.clientId;
  if (check.warning) warn(`[build-config] ${check.warning}`);

  const target = join(stagedDir, "build-config.json");
  const config = clientId ? { githubClientId: clientId } : {};
  mkdirSync(stagedDir, { recursive: true });
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);

  if (clientId) {
    log(
      `[build-config] baked GitHub client id (${clientId.length} chars) into ${target}`
    );
  } else {
    warn(
      "[build-config] MUON_GITHUB_CLIENT_ID is not set — packaging WITHOUT a GitHub client id; the packaged identity gate will be disabled and logged as a release defect."
    );
  }
  return { target, clientId };
}

// Run only when invoked as a script (`node scripts/write-build-config.mjs`), so
// a test can import the function above without writing into the operator's
// `staged/`. Same guard shape the repo's other importable scripts use.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    writeBuildConfig();
  } catch (error) {
    // The reason, not a stack: this is a build refusal an operator has to act on.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
