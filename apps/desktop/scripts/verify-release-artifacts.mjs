#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const releaseDir = process.env.MUON_RELEASE_DIR?.trim()
  ? path.resolve(process.env.MUON_RELEASE_DIR)
  : path.join(desktopDir, "release");

const unquote = (value) =>
  value.trim().replace(/^(['"])(.*)\1$/, "$2");

async function sha512Base64(filePath) {
  return createHash("sha512")
    .update(await readFile(filePath))
    .digest("base64");
}

async function main() {
  const packageJson = JSON.parse(
    await readFile(path.join(desktopDir, "package.json"), "utf8")
  );
  const feedPath = path.join(releaseDir, "latest-mac.yml");
  const feed = await readFile(feedPath, "utf8");
  const version = feed.match(/^version:\s*(.+)$/m)?.[1];
  assert.equal(
    unquote(version ?? ""),
    packageJson.version,
    "latest-mac.yml version does not match the desktop package"
  );

  const entries = [
    ...feed.matchAll(
      /^  - url:\s*(.+)\n    sha512:\s*(.+)\n    size:\s*(\d+)$/gm
    ),
  ].map((match) => ({
    url: unquote(match[1]),
    sha512: unquote(match[2]),
    size: Number(match[3]),
  }));
  assert.equal(entries.length, 2, "expected exactly one ZIP and one DMG feed entry");
  assert.equal(entries.filter((entry) => entry.url.endsWith(".zip")).length, 1);
  assert.equal(entries.filter((entry) => entry.url.endsWith(".dmg")).length, 1);

  for (const entry of entries) {
    assert.equal(
      path.basename(entry.url),
      entry.url,
      `feed artifact must be a local release filename: ${entry.url}`
    );
    const artifactPath = path.join(releaseDir, entry.url);
    assert.equal(
      (await stat(artifactPath)).size,
      entry.size,
      `${entry.url} size does not match latest-mac.yml`
    );
    assert.equal(
      await sha512Base64(artifactPath),
      entry.sha512,
      `${entry.url} sha512 does not match latest-mac.yml`
    );
  }

  const primaryPath = unquote(feed.match(/^path:\s*(.+)$/m)?.[1] ?? "");
  const primarySha = unquote(feed.match(/^sha512:\s*(.+)$/m)?.[1] ?? "");
  const primary = entries.find((entry) => entry.url === primaryPath);
  assert(primary, "latest-mac.yml primary path is not one of its file entries");
  assert.equal(
    primary.url.endsWith(".zip"),
    true,
    "latest-mac.yml primary update artifact must be the ZIP"
  );
  assert.equal(
    primarySha,
    primary.sha512,
    "latest-mac.yml primary sha512 does not match its ZIP entry"
  );

  process.stdout.write(
    `release feed verified: ${entries.map((entry) => entry.url).join(", ")}\n`
  );
}

main().catch((error) => {
  process.stderr.write(
    `release artifact verification failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`
  );
  process.exitCode = 1;
});
