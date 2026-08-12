#!/usr/bin/env node
/**
 * Generates docs/THIRD-PARTY-NOTICES.md from the root package-lock.json.
 *
 * Scope: the PRODUCTION dependency tree of this repository's root workspace
 * (the muon-labs package that builds this marketing site), as recorded in
 * package-lock.json. It does not walk the separate package-lock.json files
 * that live under apps/*, backend/, or packages/* — those are independent
 * npm installs, not part of this root workspace's dependency graph.
 *
 * For each production package this records {name, version, license}. It does
 * NOT copy full license texts, only the license identifier declared by the
 * package itself (from package-lock.json, falling back to the package's own
 * package.json when the lockfile entry omits a license field).
 *
 * Run with: npm run notices
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const lockfilePath = path.join(repoRoot, "package-lock.json");
const outputPath = path.join(repoRoot, "docs", "THIRD-PARTY-NOTICES.md");

/** Given a package-lock.json `packages` key, derive the installed package name.
 *  Keys look like "node_modules/foo", "node_modules/@scope/foo", or a nested
 *  "node_modules/a/node_modules/@scope/foo" for a shadowed transitive dep. The
 *  package name is always everything after the LAST "node_modules/" segment. */
function packageNameFromKey(key) {
  const marker = "node_modules/";
  const lastIndex = key.lastIndexOf(marker);
  if (lastIndex === -1) return null;
  return key.slice(lastIndex + marker.length);
}

/** Best-effort fallback: read the license straight from the installed
 *  package's own package.json when the lockfile entry doesn't carry one. */
function licenseFromInstalledPackage(name) {
  try {
    const pkgJsonPath = path.join(repoRoot, "node_modules", name, "package.json");
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    if (typeof pkg.license === "string") return pkg.license;
    if (pkg.license && typeof pkg.license === "object" && pkg.license.type) {
      return pkg.license.type;
    }
    if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
      return pkg.licenses.map((entry) => entry.type).filter(Boolean).join(" OR ");
    }
  } catch {
    // Not installed locally, or no readable package.json. Fall through.
  }
  return "UNKNOWN";
}

function normalizeLicense(rawLicense, name) {
  if (typeof rawLicense === "string" && rawLicense.trim().length > 0) {
    return rawLicense.trim();
  }
  return licenseFromInstalledPackage(name);
}

function main() {
  const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
  const packages = lockfile.packages ?? {};

  const seen = new Map(); // key: `${name}@${version}` -> {name, version, license}

  for (const [key, entry] of Object.entries(packages)) {
    if (key === "") continue; // the root package itself
    if (entry.dev) continue; // devDependencies are not distributed
    if (entry.link) continue; // local workspace symlink, not third-party

    const name = packageNameFromKey(key);
    if (!name) continue;
    const version = entry.version ?? "UNKNOWN";
    const license = normalizeLicense(entry.license, name);

    const dedupeKey = `${name}@${version}`;
    if (!seen.has(dedupeKey)) {
      seen.set(dedupeKey, { name, version, license });
    }
  }

  const rows = [...seen.values()].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
  });

  const generatedAt = new Date().toISOString().slice(0, 10);
  const lines = [
    "<!-- GENERATED FILE. Do not hand-edit. -->",
    "<!-- Regenerate with: npm run notices -->",
    "",
    "# Third-Party Notices",
    "",
    `Generated ${generatedAt} by \`scripts/generate-third-party-notices.mjs\` from` +
      " this repository's root `package-lock.json`.",
    "",
    "Scope: production dependencies of the root workspace (the site you are" +
      " reading now). This does not yet enumerate the separate dependency" +
      " trees under `apps/*`, `backend/`, or `packages/*`, each of which has" +
      " its own `package-lock.json`.",
    "",
    "Each row lists the package's own declared license identifier only. This" +
      " file does not reproduce full license texts; consult the named" +
      " package's own repository or npm listing for that.",
    "",
    `Total packages: ${rows.length}`,
    "",
    "| Package | Version | License |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${row.name} | ${row.version} | ${row.license} |`),
    "",
  ];

  writeFileSync(outputPath, lines.join("\n"));
  console.log(`Wrote ${rows.length} production package entries to ${path.relative(repoRoot, outputPath)}`);
}

main();
