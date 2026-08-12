// Writes staged/build-config.json — the release coordinates a packaged app
// reads back at boot (src/lib/build-config.ts). Runs in the package/dist npm
// scripts AFTER stage-backend (staged/ must exist); electron-builder's
// extraResources (`from: staged, to: "."`) lands the file at <Resources>/.
//
// The GitHub App client id is PUBLIC by design (device flow, no client
// secret) — baking it is configuration, not secret embedding. An empty env
// still writes the file (with no id) so a missing id is a visible, diffable
// fact of the artifact rather than a missing file that could be anything.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stagedDir = join(root, "staged");
const target = join(stagedDir, "build-config.json");

const clientId = (process.env.MUON_GITHUB_CLIENT_ID ?? "").trim();
const config = clientId ? { githubClientId: clientId } : {};

mkdirSync(stagedDir, { recursive: true });
writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);

if (clientId) {
  console.log(
    `[build-config] baked GitHub client id (${clientId.length} chars) into ${target}`
  );
} else {
  console.warn(
    "[build-config] MUON_GITHUB_CLIENT_ID is not set — packaging WITHOUT a GitHub client id; the packaged identity gate will be disabled and logged as a release defect."
  );
}
