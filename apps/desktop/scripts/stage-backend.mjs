#!/usr/bin/env node
/**
 * stage-backend.mjs, assemble a SELF-CONTAINED copy of the embedded brain that
 * electron-builder ships as an unpacked extraResource (Resources/backend).
 *
 * Why this exists
 * ---------------
 * The desktop app spawns the backend as a real child process:
 *   spawn(<Electron bin as node>, ["<Resources>/backend/dist/index.js"])
 * so at runtime the backend does ordinary `require()` + `dlopen()` against a
 * node_modules tree sitting next to it, exactly like `node backend/dist/index.js`
 * in the monorepo. The monorepo, however, wires workspace packages with `file:`
 * SYMLINKS (backend/node_modules/@muon/graph -> ../../../packages/graph, whose
 * own node_modules holds the LadybugDB native addon). Shipping raw symlinks into
 * an app bundle is fragile, so we MATERIALIZE everything here: every symlink is
 * dereferenced into a plain file/dir, yielding a tree with no links that resolves
 * identically on any machine.
 *
 * The MUON package graph is a strict DAG (protocol -> adapters -> core -> client
 * -> graph -> mcp -> runner -> orchestrator -> backend), so dereferencing cannot
 * loop. It DOES duplicate shared deps, correctness over bytes for v1; see the
 * "Pruning" note at the bottom for the follow-up.
 *
 * What it copies from backend/:  dist/, prisma/, package.json, node_modules/
 * What it SKIPS:                 src/, tests/, *.ts, *.map, .env* (secrets!),
 *                                caches, VCS/OS junk. Never the backend .env,
 *                                it could inject a hosted DATABASE_URL and break
 *                                the local-first embedded-SQLite invariant.
 *
 * Usage:  node apps/desktop/scripts/stage-backend.mjs
 *         (run by the `package`/`dist` npm scripts BEFORE electron-builder)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..", "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");
const STAGE_DIR = path.join(DESKTOP_DIR, "staged", "backend");

// Names skipped anywhere in the tree.
const SKIP_NAMES = new Set([
  ".git",
  ".DS_Store",
  ".cache",
  ".turbo",
  ".vitest",
  "coverage",
  "tests",
  "test",
  "__tests__",
  "__mocks__",
]);

// Extensions/suffixes skipped anywhere.
function skipFile(name) {
  if (name.endsWith(".map")) return true;
  if (name.endsWith(".ts") && !name.endsWith(".d.ts")) return true; // keep .d.ts (cheap), drop sources
  if (name.endsWith(".tsbuildinfo")) return true;
  // Never ship env files (may carry secrets / a hosted DATABASE_URL). Keep .example.
  if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") {
    return true;
  }
  return false;
}

let fileCount = 0;
let linkCount = 0;

/**
 * Recursively copy `src` -> `dst`, DEREFERENCING every symlink into a real copy.
 * Safe against the DAG package graph (no cycles) but not against arbitrary
 * cyclic symlinks, the MUON graph has none.
 */
function copyTree(src, dst) {
  const stat = fs.lstatSync(src);

  if (stat.isSymbolicLink()) {
    linkCount += 1;
    const real = fs.realpathSync(src); // resolve to the ultimate target
    copyTree(real, dst); // materialize whatever it points at
    return;
  }

  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (SKIP_NAMES.has(entry)) continue;
      copyTree(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }

  if (stat.isFile()) {
    if (skipFile(path.basename(src))) return;
    fs.copyFileSync(src, dst);
    fileCount += 1;
    return;
  }
  // Sockets/fifos/etc., ignore.
}

function main() {
  if (!fs.existsSync(path.join(BACKEND_DIR, "dist", "index.js"))) {
    console.error(
      "[stage-backend] backend/dist/index.js not found, build the backend first (bash scripts/ci-install.sh)."
    );
    process.exit(1);
  }

  // Clean slate so a stale prior stage can't leak into the bundle.
  fs.rmSync(path.dirname(STAGE_DIR), { recursive: true, force: true });
  fs.mkdirSync(STAGE_DIR, { recursive: true });

  // Only the runtime surface of the backend, not src/tests/config/.env.
  const TOP_LEVEL = ["dist", "prisma", "package.json", "node_modules"];
  for (const name of TOP_LEVEL) {
    const src = path.join(BACKEND_DIR, name);
    if (!fs.existsSync(src)) {
      if (name === "node_modules") {
        console.error(
          "[stage-backend] backend/node_modules missing, run scripts/ci-install.sh first."
        );
        process.exit(1);
      }
      continue;
    }
    copyTree(src, path.join(STAGE_DIR, name));
  }

  // Sanity assertions: the pieces most likely to be silently missing.
  const mustExist = [
    ["backend entry", path.join(STAGE_DIR, "dist", "index.js")],
    // F6 guard: the graph boot-probe child is loaded by RUNTIME PATH, so a
    // bundler could drop it. Assert it made it into the stage.
    ["graph probe child", path.join(STAGE_DIR, "dist", "lib", "graph-probe-child.js")],
    ["@muon/graph (materialized)", path.join(STAGE_DIR, "node_modules", "@muon", "graph", "dist", "index.js")],
    ["LadybugDB native addon", path.join(STAGE_DIR, "node_modules", "@muon", "graph", "node_modules", "@ladybugdb", "core", "lbugjs.node")],
    ["Prisma generated client", path.join(STAGE_DIR, "node_modules", ".prisma", "client")],
  ];
  const missing = mustExist.filter(([, p]) => !fs.existsSync(p));
  if (missing.length > 0) {
    console.error("[stage-backend] staged tree is INCOMPLETE, missing:");
    for (const [label, p] of missing) {
      console.error(`  - ${label}: ${path.relative(STAGE_DIR, p)}`);
    }
    process.exit(1);
  }

  // Find the Prisma query engine (either the generated one or @prisma/engines).
  const engineCandidates = [
    path.join(STAGE_DIR, "node_modules", ".prisma", "client"),
    path.join(STAGE_DIR, "node_modules", "@prisma", "engines"),
  ];
  const hasEngine = engineCandidates.some((dir) => {
    try {
      return fs
        .readdirSync(dir)
        .some((f) => f.includes("libquery_engine") && f.endsWith(".node"));
    } catch {
      return false;
    }
  });
  if (!hasEngine) {
    console.warn(
      "[stage-backend] WARNING: no Prisma libquery_engine-*.node found in the stage, the brain may fail to open its SQLite store. Verify on a real build."
    );
  }

  console.log(
    `[stage-backend] staged backend -> ${path.relative(REPO_ROOT, STAGE_DIR)} ` +
      `(${fileCount} files, ${linkCount} symlinks materialized)`
  );
}

main();

// ---------------------------------------------------------------------------
// Pruning (follow-up, not required for correctness): this stage includes the
// backend's devDependencies and duplicates shared deps across each materialized
// @muon package, so it's larger than necessary. A future optimization is to run
// `npm ci --omit=dev` into a temp copy (or `npm prune --omit=dev`) before
// staging, and/or dedupe identical package copies. Kept simple + offline-safe
// for v1: a bigger .dmg that definitely boots beats a lean one that doesn't.
// ---------------------------------------------------------------------------
