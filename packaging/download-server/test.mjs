#!/usr/bin/env node
// Seeded check for the download host: boots the real server on an ephemeral
// port against a temp artifact dir and verifies the four behaviours that
// matter — health, artifact roundtrip, traversal refusal, and the feed's
// no-cache header.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "muon-dl-"));
writeFileSync(join(dataDir, "MUON-0.1.0-arm64.dmg"), "fake-dmg-bytes");
writeFileSync(join(dataDir, "latest-mac.yml"), "version: 0.1.0\n");

const port = 18000 + Math.floor(Math.random() * 2000);
const child = spawn(process.execPath, [join(here, "server.mjs")], {
  env: { ...process.env, PORT: String(port), MUON_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "inherit"],
});

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  child.kill();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
};

await new Promise((resolve) => child.stdout.once("data", resolve));
const base = `http://127.0.0.1:${port}`;

try {
  const health = await fetch(`${base}/healthz`);
  if (health.status !== 200) fail(`healthz ${health.status}`);

  const dmg = await fetch(`${base}/MUON-0.1.0-arm64.dmg`);
  if (dmg.status !== 200) fail(`dmg ${dmg.status}`);
  if ((await dmg.text()) !== "fake-dmg-bytes") fail("dmg body mismatch");
  if (!dmg.headers.get("cache-control")?.includes("immutable"))
    fail("versioned artifact should be immutable-cached");

  const feed = await fetch(`${base}/latest-mac.yml`);
  if (feed.status !== 200) fail(`feed ${feed.status}`);
  if (feed.headers.get("cache-control") !== "no-cache")
    fail("latest-mac.yml must be no-cache");

  const traversal = await fetch(`${base}/..%2Fserver.mjs`);
  if (traversal.status !== 404) fail(`traversal ${traversal.status}`);

  const index = await fetch(`${base}/`);
  if (!(await index.text()).includes("MUON-0.1.0-arm64.dmg"))
    fail("index missing artifact");

  console.log("ok: download-server seeded check passed (4 behaviours)");
} finally {
  child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
