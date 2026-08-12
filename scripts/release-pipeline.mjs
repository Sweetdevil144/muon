#!/usr/bin/env node
/**
 * release-pipeline.mjs — one command from a checkout to a published release on
 * download.getmuon.com. Automates the manual v1 release of 2026-08-06 exactly:
 *
 *   preflight → build (desktop DMG/zip + CLI tarball) → verify (release
 *   artifacts + packaged-runner smoke) → stage +
 *   SHA256SUMS → upload via `railway ssh` (sha256-verified, retried) → host-side
 *   latest aliases → public URL verification.
 *
 * Usage:
 *   node scripts/release-pipeline.mjs [--skip-build] [--no-upload] [--yes]
 *
 * --skip-build  reuse apps/desktop/release + apps/cli/release as built
 * --no-upload   stop after staging (inspect the staging dir, upload later)
 * --yes         skip the interactive publish confirmation (CI / scripted use)
 *
 * Requirements it CHECKS rather than assumes: clean-enough tree, semver in
 * apps/desktop/package.json, MUON_GITHUB_CLIENT_ID in the env (the login gate
 * of a packaged build is dead without it), and a Railway-linked
 * packaging/download-server directory for the upload leg.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aliasCommands, checksummedArtifacts, feedNamesVersion, publicChecks,
  releaseArtifacts,
} from "./lib/release-plan.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DESKTOP = join(ROOT, "apps", "desktop");
const CLI = join(ROOT, "apps", "cli");
const DL_SERVER = join(ROOT, "packaging", "download-server");
const STAGE = join(ROOT, ".release-stage");

const args = process.argv.slice(2);
const SKIP_BUILD = args.includes("--skip-build");
const NO_UPLOAD = args.includes("--no-upload");
const ASSUME_YES = args.includes("--yes");

const log = (msg) => console.log(`[release] ${msg}`);
const fail = (msg) => {
  console.error(`[release] FAIL: ${msg}`);
  process.exit(1);
};

const run = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { stdio: "inherit", cwd: ROOT, ...opts });

// ---------------------------------------------------------------------------
// 1. Preflight
// ---------------------------------------------------------------------------
const version = JSON.parse(
  readFileSync(join(DESKTOP, "package.json"), "utf8")
).version;
log(`releasing version ${version}`);

const artifacts = releaseArtifacts(version); // also validates semver

const dirty = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter((l) => l.trim() && !l.includes(".release-stage"));
if (dirty.length > 0) {
  log(`warning: working tree has ${dirty.length} uncommitted change(s); the build ships what is on disk`);
}

if (!SKIP_BUILD && !process.env.MUON_GITHUB_CLIENT_ID?.trim()) {
  fail(
    "MUON_GITHUB_CLIENT_ID is not set. A packaged build arms the GitHub login gate; " +
      "without the client id baked in, the shipped app cannot log in. " +
      "Export it (repo Actions variable of the same name) and re-run."
  );
}

// ---------------------------------------------------------------------------
// 2. Build
// ---------------------------------------------------------------------------
if (!SKIP_BUILD) {
  log("building desktop package (this is the slow step)...");
  run("npm", ["run", "package"], { cwd: DESKTOP });
  log("building CLI/TUI release bundle...");
  run("node", [join(CLI, "scripts", "bundle-release.mjs")]);
  run("npm", ["pack", "--pack-destination", join(CLI, "release")], {
    cwd: join(CLI, "release"),
  });
} else {
  log("--skip-build: reusing existing release directories");
}

// ---------------------------------------------------------------------------
// 3. Verify the build the way the release workflow does
// ---------------------------------------------------------------------------
log("verifying release artifacts + packaged runner...");
run("npm", ["run", "verify:release-artifacts"], { cwd: DESKTOP });
run("npm", ["run", "smoke:packaged-runner"], { cwd: DESKTOP });

const feedText = readFileSync(join(DESKTOP, "release", "latest-mac.yml"), "utf8");
if (!feedNamesVersion(feedText, version)) {
  fail(`latest-mac.yml does not describe version ${version} — stale release dir?`);
}

// ---------------------------------------------------------------------------
// 4. Stage + SHA256SUMS
// ---------------------------------------------------------------------------
log("staging artifacts...");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const sourceFor = (a) => {
  if (a.from === "desktop") return join(DESKTOP, "release", a.name);
  if (a.from === "cli") return join(CLI, "release", a.name);
  return null; // generated files are written below
};
for (const a of artifacts) {
  const src = sourceFor(a);
  if (src) {
    if (!existsSync(src)) fail(`missing artifact: ${src}`);
    copyFileSync(src, join(STAGE, a.name));
  }
}
const sums = checksummedArtifacts(version)
  .map((name) => {
    const digest = createHash("sha256")
      .update(readFileSync(join(STAGE, name)))
      .digest("hex");
    return `${digest}  ${name}`;
  })
  .join("\n");
writeFileSync(join(STAGE, "SHA256SUMS"), `${sums}\n`);
log(`staged ${artifacts.length} artifacts in ${STAGE}`);

if (NO_UPLOAD) {
  log("--no-upload: stopping after staging. Upload later with --skip-build.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 6. Publish confirmation — uploading replaces what users download.
// ---------------------------------------------------------------------------
if (!ASSUME_YES) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) =>
    rl.question(
      `[release] publish ${version} to download.getmuon.com? This replaces the live release. [y/N] `,
      resolve
    )
  );
  rl.close();
  if (answer.trim().toLowerCase() !== "y") fail("publish declined");
}

// ---------------------------------------------------------------------------
// 7. Upload (sha256-verified, retried) + aliases
// ---------------------------------------------------------------------------
const ssh = (remoteCmd) =>
  spawnSync("railway", ["ssh", remoteCmd], {
    cwd: DL_SERVER,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

const sshStatus = spawnSync("railway", ["status"], { cwd: DL_SERVER, encoding: "utf8" });
if (sshStatus.status !== 0) {
  fail("packaging/download-server is not linked to Railway (run `railway link` there first)");
}

const localSha256 = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

for (const a of artifacts) {
  const local = join(STAGE, a.name);
  const want = statSync(local).size;
  // Review finding 5: size alone lets an equal-length corruption publish.
  // Every upload must hash-match end to end before it counts.
  const wantSha = await localSha256(local);
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
    log(`uploading ${a.name} (${(want / 1e6).toFixed(1)}MB, attempt ${attempt})...`);
    const up = spawnSync("bash", ["-c", `cat "${local}" | railway ssh "cat > /data/${a.name}"`], {
      cwd: DL_SERVER,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (up.status !== 0) continue;
    const remote = ssh(`sha256sum /data/${a.name}`).stdout?.trim().split("\n").pop() ?? "";
    const gotSha = remote.split(/\s+/)[0];
    ok = gotSha === wantSha;
    if (!ok) log(`  sha256 mismatch (want ${wantSha.slice(0, 12)}…, got ${(gotSha ?? "none").slice(0, 12)}…); retrying`);
  }
  if (!ok) fail(`could not upload ${a.name} with a verified checksum after 3 attempts`);
}

for (const cmd of aliasCommands(version)) {
  log(`alias: ${cmd}`);
  if (ssh(cmd).status !== 0) fail(`alias command failed: ${cmd}`);
}

// ---------------------------------------------------------------------------
// 8. Public verification — what a user's browser/updater will actually see.
// ---------------------------------------------------------------------------
log("verifying public URLs...");
for (const check of publicChecks(version)) {
  const res = await fetch(check.url, { method: "HEAD" });
  if (res.status !== 200) fail(`${check.url} → ${res.status}`);
  if (check.noCache && res.headers.get("cache-control") !== "no-cache") {
    fail(`${check.url} must be no-cache (got ${res.headers.get("cache-control")})`);
  }
}
const publicFeed = await (await fetch(`https://download.getmuon.com/latest-mac.yml`)).text();
if (!feedNamesVersion(publicFeed, version)) {
  fail("public latest-mac.yml does not name this release");
}

log(`release ${version} is LIVE on download.getmuon.com`);
