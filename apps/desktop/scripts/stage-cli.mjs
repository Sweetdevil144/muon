#!/usr/bin/env node
/**
 * stage-cli.mjs — stage the publishable CLI/TUI/MCP bundle into the desktop
 * app as a self-contained extraResource (Resources/cli), mirroring
 * stage-backend.mjs's shape for the embedded brain.
 *
 * WHY THE DESKTOP SHIPS THE CLI AT ALL (founder request, 2026-08-17): a
 * `.dmg`-only install had NO `muon`, `muon-tui` or `muon-mcp` anywhere — and
 * `muon mcp install <vendor>` resolves `muon-mcp` as a SIBLING of the running
 * `muon`, so a DMG-only user could not even register MUON with their own
 * vendor CLI. This closes that gap: the app now carries the same three
 * entries the npm tarball ships, and an in-app affordance
 * (`src/lib/cli-link.ts` + Settings -> Command Line Tools) links them onto
 * the user's PATH on request — never automatically, never with sudo.
 *
 * WHAT THIS SCRIPT DOES
 *   1. Runs `apps/cli/scripts/bundle-release.mjs` to (re)build
 *      apps/cli/release/{muon.mjs,muon-tui.mjs,muon-mcp.mjs,package.json}.
 *      Same script the CLI/TUI npm tarball ships from — one bundler, two
 *      distribution channels, never two builds that could drift.
 *   2. Copies exactly those four files into apps/desktop/staged/cli/.
 *
 * ADR-0052 — THE BAKE RIDES ALONG FOR FREE. `readDistributionBake` walks up
 * from the running entry looking for `./package.json` with
 * `muonDistributed: true`. Because this script copies bundle-release.mjs's
 * OWN manifest verbatim (not a hand-rolled one), a DMG-provided `muon.mjs`
 * sits beside the exact same manifest a tarball install ships beside — so it
 * is gated identically. Do not synthesize a package.json here; copy the
 * bundler's.
 *
 * `MUON_GITHUB_CLIENT_ID` flows through from THIS process's env into
 * bundle-release.mjs exactly as it does for `write-build-config.mjs` (the
 * desktop's own bake) — both run in the same `npm run package` invocation, so
 * a release that bakes the desktop's client id also bakes the staged CLI's.
 * An unset id degrades ungated (bundle-release.mjs's own rule) rather than
 * failing the build; that is a release defect to catch in review, not a
 * reason to block packaging.
 *
 * Usage:  node apps/desktop/scripts/stage-cli.mjs
 *         (run by the `package`/`dist` npm scripts, same slot as stage-backend)
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = join(__dirname, "..");
const REPO_ROOT = join(DESKTOP_DIR, "..", "..");
const CLI_DIR = join(REPO_ROOT, "apps", "cli");
const CLI_RELEASE_DIR = join(CLI_DIR, "release");
const STAGE_DIR = join(DESKTOP_DIR, "staged", "cli");

const FILES = ["muon.mjs", "muon-tui.mjs", "muon-mcp.mjs", "package.json"];

function main() {
  const bundler = join(CLI_DIR, "scripts", "bundle-release.mjs");
  if (!existsSync(bundler)) {
    console.error(`[stage-cli] ${bundler} not found — is this a full checkout?`);
    process.exit(1);
  }

  console.log("[stage-cli] building the CLI/TUI/MCP release bundle...");
  execFileSync(process.execPath, [bundler], {
    stdio: "inherit",
    cwd: CLI_DIR,
    env: process.env,
  });

  for (const name of FILES) {
    const src = join(CLI_RELEASE_DIR, name);
    if (!existsSync(src)) {
      console.error(`[stage-cli] bundler did not produce ${src}`);
      process.exit(1);
    }
  }

  // Clean slate, same reasoning as stage-backend: a stale prior stage must
  // never leak an older bundle into the app.
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });
  for (const name of FILES) {
    copyFileSync(join(CLI_RELEASE_DIR, name), join(STAGE_DIR, name));
  }

  // Executable bits: bundle-release.mjs chmods the three .mjs entries 0o755
  // in apps/cli/release, but copyFileSync does not carry POSIX modes across.
  // The shims this repo writes onto PATH `exec` these files directly (their
  // own `#!/usr/bin/env node` shebang), so they must stay executable.
  for (const name of ["muon.mjs", "muon-tui.mjs", "muon-mcp.mjs"]) {
    execFileSync("chmod", ["755", join(STAGE_DIR, name)]);
  }

  // Best-effort, not required: the manifest's `license` field points at
  // "SEE LICENSE IN LICENSE" — carry the repo's own LICENSE alongside it so
  // that pointer resolves locally too, the same as the published tarball
  // does. Read from the REPO ROOT directly (not from apps/cli/release/),
  // so this does not depend on the bundler also having copied one; a repo
  // checkout with no LICENSE file just skips this, quietly.
  const licenseSrc = join(REPO_ROOT, "LICENSE");
  if (existsSync(licenseSrc)) {
    copyFileSync(licenseSrc, join(STAGE_DIR, "LICENSE"));
  }

  // ADR-0052 sanity check, not a hard requirement: warn (not fail) when the
  // staged manifest carries no bake, so an operator packaging locally sees
  // the same "this artifact runs ungated" signal bundle-release.mjs already
  // printed, without having to scroll back.
  const manifest = JSON.parse(readFileSync(join(STAGE_DIR, "package.json"), "utf8"));
  if (manifest.muonDistributed !== true) {
    console.warn(
      "[stage-cli] staged CLI manifest has no muonDistributed bake — the DMG-provided muon will run UNGATED (ADR-0052 degrade-ungated rule)."
    );
  }

  // ── THE DEPENDENCIES, WITHOUT WHICH NONE OF THIS RUNS ──────────────────
  //
  // Measured dead on a real 0.4.8 install (2026-08-20): a DMG user who linked
  // the CLI got
  //   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'commander'
  //     imported from /Applications/MUON.app/Contents/Resources/cli/muon.mjs
  // for `muon`, `muon-tui` AND `muon-mcp` — so a DMG-only machine's MCP server
  // could not start in any vendor, which is the exact promise ADR-0055 makes.
  //
  // WHY IT WAS MISSING, stated so it is not "fixed" back out: the bundler
  // keeps commander/zod/@modelcontextprotocol/sdk/@anthropic-ai + ink/react
  // EXTERNAL (their platform binaries and wasm assets do not survive
  // single-file bundling). That is correct for the npm tarball, where `npm
  // install -g` materializes them — and fatal here, because a .dmg has no
  // install step at all. Staging the four files was only ever half the
  // artifact.
  //
  // GITNEXUS IS EXCLUDED BY MANIFEST, NOT BY `--omit=optional`. The flag is
  // RECURSIVE, and `@anthropic-ai/claude-agent-sdk` ships its `claude`
  // executable as a per-platform OPTIONAL dependency
  // (`…-sdk-darwin-arm64`) — omitting optionals stripped it and left the
  // staged CLI throwing "Native CLI binary for darwin-arm64 not found" the
  // moment a DMG user started a Claude session. So the install runs against a
  // manifest with the top-level `optionalDependencies` REMOVED (its only
  // member is gitnexus, whose ~1GB native closure belongs in the npm channel —
  // the desktop resolves the machine's copy instead), while every NESTED
  // optional still resolves normally.
  console.log("[stage-cli] installing the staged CLI's runtime dependencies...");
  const manifestPath = join(STAGE_DIR, "package.json");
  const shippedManifest = readFileSync(manifestPath, "utf8");
  const installManifest = JSON.parse(shippedManifest);
  delete installManifest.optionalDependencies;
  writeFileSync(manifestPath, `${JSON.stringify(installManifest, null, 2)}\n`);
  try {
    execFileSync(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { stdio: "inherit", cwd: STAGE_DIR, env: process.env }
    );
  } finally {
    // The PUBLISHED manifest is what ships — bake included (ADR-0052). The
    // install-time copy exists only for the resolution above.
    writeFileSync(manifestPath, shippedManifest);
  }

  // PROVE IT, here, rather than discovering it on a user's machine — and prove
  // ALL THREE entries, because `muon-mcp` is the one whose failure this whole
  // block exists to prevent and a `muon.mjs --version` gate would have passed
  // the very defect above. This is the manifest's OWN `scripts.test`
  // (bundle-release.mjs authors it): boots muon, syntax-checks the TUI, and
  // IMPORTS muon-mcp so a top-level runtime throw is caught. One author, not
  // a second copy that can drift.
  const nodeModules = join(STAGE_DIR, "node_modules");
  if (!existsSync(nodeModules)) {
    console.error("[stage-cli] npm install produced no node_modules — refusing to stage a CLI that cannot run.");
    process.exit(1);
  }
  // ── ONE COPY OF THE ~300MB CLAUDE BINARY PER BUNDLE, NOT TWO ────────────
  //
  // `npm install` correctly materializes `@anthropic-ai/claude-agent-sdk-<os>-<arch>`
  // (its `claude` executable), and the APP ALREADY SHIPS THAT SAME PACKAGE via
  // electron-builder's asarUnpack. Keeping the staged copy measured +305MB on a
  // 670MB download for bytes already inside the same .app.
  //
  // Dropping it is only safe because the resolution has somewhere else to look:
  // the SDK resolves its binary through `createRequire`, which consults
  // NODE_PATH, and the linked shim exports NODE_PATH pointing at the app's
  // unpacked tree (see `shimScript` in src/lib/cli-link.ts). Verified live
  // 2026-08-20: with the staged copy removed, that resolution finds the app's.
  // The three entries boot without it either way — the binary is loaded lazily,
  // only when a Claude session actually starts.
  //
  // The two halves must move together: if this pruning is ever removed, the
  // shim's NODE_PATH export becomes dead weight, and if the shim stops
  // exporting it, a DMG-linked `muon` loses the ability to start a session.
  // `tests/cli-link.test.ts` pins the shim half.
  for (const entry of readdirSync(join(nodeModules, "@anthropic-ai"))) {
    if (/^claude-agent-sdk-[a-z0-9]+-[a-z0-9]+/.test(entry)) {
      rmSync(join(nodeModules, "@anthropic-ai", entry), {
        recursive: true,
        force: true,
      });
      console.log(`[stage-cli] pruned ${entry} (the app already ships it)`);
    }
  }

  execFileSync("npm", ["test"], { stdio: "inherit", cwd: STAGE_DIR });

  console.log(
    `[stage-cli] staged CLI/TUI/MCP + runtime deps -> apps/desktop/staged/cli (${FILES.length} files)`
  );
}

main();
