#!/usr/bin/env node
/**
 * Electron's postinstall can fail when extract-zip gets a non-absolute target.
 * This script ensures the darwin arm64 binary is present before `electron .`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadArtifact } from "@electron/get";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(__dirname, "../node_modules/electron");
const distDir = path.join(electronDir, "dist");
const platformPath = "Electron.app/Contents/MacOS/Electron";
const electronBin = path.join(distDir, platformPath);
const { version } = JSON.parse(
  fs.readFileSync(path.join(electronDir, "package.json"), "utf8")
);

function isReady() {
  try {
    const recorded = fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim();
    const recordedVersion = fs
      .readFileSync(path.join(distDir, "version"), "utf8")
      .trim()
      .replace(/^v/, "");
    return recorded === platformPath && recordedVersion === version && fs.existsSync(electronBin);
  } catch {
    return false;
  }
}

// node-pty ships NAPI prebuilds (ABI-stable — no electron-rebuild needed to
// LOAD), but its `spawn-helper` binary can land without the executable bit after
// an npm install, which makes a real pty throw "posix_spawnp failed". Restore
// +x durably so `MUON_REAL_PTY=1` gives a working interactive vendor terminal.
function ensureNodePtyExecutable() {
  const prebuilds = path.resolve(
    __dirname,
    "../node_modules/node-pty/prebuilds"
  );
  for (const platform of ["darwin-arm64", "darwin-x64"]) {
    const helper = path.join(prebuilds, platform, "spawn-helper");
    try {
      if (!fs.existsSync(helper)) continue;
      if ((fs.statSync(helper).mode & 0o111) === 0) {
        fs.chmodSync(helper, 0o755);
      }
    } catch {
      // best-effort; the echo driver still works if this fails
    }
  }
}

ensureNodePtyExecutable();

if (isReady()) {
  process.exit(0);
}

const zipPath = await downloadArtifact({
  version,
  artifactName: "electron",
  platform: process.platform,
  arch: process.arch,
});

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
execFileSync("unzip", ["-q", zipPath, "-d", distDir], { stdio: "inherit" });
fs.writeFileSync(path.join(electronDir, "path.txt"), platformPath);
