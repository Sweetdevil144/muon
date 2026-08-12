#!/usr/bin/env node
/**
 * Lockfile contract for the MUON root (marketing Next.js site + npm monorepo).
 *
 * This repository is npm-only: CI, release, and local install all use
 * package-lock.json + `npm ci`. A checked-in pnpm-lock.yaml / yarn.lock makes
 * Vercel (and other detectors that prefer those files) install with a different
 * manager than Dependabot updates — which is exactly how next@16.2.10 peer
 * snapshots went stale while package.json said 16.2.11.
 *
 * Fail closed if a second lockfile appears at the repo root.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const required = "package-lock.json";
const forbidden = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

const errors = [];

if (!existsSync(join(root, required))) {
  errors.push(`missing required ${required} at repo root`);
}

for (const file of forbidden) {
  if (existsSync(join(root, file))) {
    errors.push(
      `forbidden ${file} at repo root — this repo is npm-only; delete it so Vercel/CI cannot drift from package-lock.json`
    );
  }
}

if (errors.length > 0) {
  console.error("Lockfile contract failed:");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    "\nUse npm only at the root (npm ci / npm install). Do not reintroduce pnpm-lock.yaml."
  );
  process.exit(1);
}

console.log("Lockfile contract ok: package-lock.json only (npm).");
