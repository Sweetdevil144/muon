#!/usr/bin/env node
//
// `npm run backfill:anchors` — D15's one-shot retro-anchor backfill,
// **DRY RUN BY DEFAULT**.
//
// `docs/design/memory-index-decisions.md` §D15. Promotion at ingest only helps the
// NEXT note; the measured debt is already written. `npm run health:memory` row 22
// counts it: active notes that name a TRACKED repo file in their prose and carry no
// module anchor at all — 62 on the founder's install on 2026-07-30, against 33 notes
// that carry a coordinate. This drains that debt by promoting each resolvable
// path-shaped token into a module anchor spelled the way the repository spells it.
//
// Three properties, all load-bearing:
//
//   * DRY RUN UNLESS `--apply`. It reports what it would write, per workspace, with
//     example coordinates, and writes nothing. This lands rows in the layer the
//     pre-edit gate trusts, so an operator sees the plan first.
//   * IT NEVER MIGRATES. A dry run against a LIVE data dir must not change the
//     schema of the brain it is describing, so this refuses outright when the ledger
//     predates the columns it needs, and names the migration. Start MUON once (its
//     `ensureSchema` applies pending migrations at boot) and re-run.
//
//     ONE PRECISE CAVEAT, because "dry run" is load-bearing: unlike
//     `npm run health:memory`, which opens the ledger SQLite `readOnly`, this opens
//     it through PRISMA — the same client the ingest path uses, deliberately, so the
//     promotion rule cannot drift from production. A Prisma open of a WAL database
//     whose `-wal` / `-shm` sidecars are ABSENT (no brain running) CREATES them
//     (measured). That is a new file beside the database, never a change to it, and
//     it is the same caveat the health harness carries. A dry run still writes no
//     row, applies no migration, and leaves `muon.db` itself byte-identical.
//   * COORDINATES ONLY. Note ids and `git ls-files` paths are printed; note text
//     never is. Workspace roots print with `$HOME` collapsed to `~`, matching
//     `npm run health:memory`.
//
// The graph mirror is deliberately NOT written (see `backend/src/lib/
// memory-anchor-backfill.ts`): the ledger is the source of truth and
// `projectLedgerToGraph` republishes it at every boot. Restart MUON after `--apply`,
// or recall (which reads the mirror) will not see the new anchors yet.
//
// Usage:
//   node scripts/memory-anchor-backfill.mjs [options]
//     --data-dir <path>   inspect this data dir (default: MUON_DATA_DIR, else the
//                         desktop's userData, else the CLI convention)
//     --apply             WRITE the plan (default: dry run)
//     --json              machine-readable output, the SAME numbers
//     --help

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DB_FILE_NAME,
  REPO_ROOT,
  fileFacts,
  formatBytes,
  resolveDataDir,
} from "./lib/muon-debug.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

const HELP = `MUON D15 retro-anchor backfill — dry run by default.

  node scripts/memory-anchor-backfill.mjs [--data-dir <path>] [--apply] [--json]

Promotes each RESOLVABLE path-shaped token in an orphan note's prose into a module
anchor, using the tracked-file spelling (\`git ls-files\`, never a filesystem stat).
Orphans only: an active note with no module anchor, so this can only ADD.

Writes nothing without --apply. Never migrates the ledger. Prints coordinates and
counts only — no note text. After --apply, restart MUON so the boot projector
republishes the anchors into the graph mirror that recall reads.

Caveat: the ledger is opened through Prisma (not SQLite readOnly like
\`npm run health:memory\`), so a dry run against a stopped brain can CREATE the
\`muon.db-wal\` / \`-shm\` sidecars beside it — a new file, never a change to the
database, and no row is written.`;

export function parseArgs(argv) {
  const options = { dataDir: null, apply: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--data-dir": {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new Error(`${arg} needs a value.`);
        }
        options.dataDir = path.resolve(next);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

/** `$HOME` → `~`. A workspace root carries the operator's username and private
 *  repository names; the output is meant to be safe to paste. */
function tildify(value) {
  const home = process.env.HOME;
  return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

/**
 * The columns this backfill needs, and the migration that added each. Checked with
 * `PRAGMA table_info` (a READ) before anything else, because the alternative is a
 * raw Prisma error about a column name — and the actionable fact is not "no such
 * column" but "this brain is at an older schema; boot MUON once".
 */
const REQUIRED_COLUMNS = [
  ["MemoryNote", "workspacePath", "0041_memory_note_workspace"],
  ["MemoryAnchor", "resolution", "0042_memory_anchor_resolution"],
];

async function loadBackend() {
  const entry = path.join(
    REPO_ROOT,
    "backend",
    "dist",
    "lib",
    "memory-anchor-backfill.js"
  );
  if (!existsSync(entry)) {
    throw new Error(
      "backend is not built (run `npm run --prefix backend build`), so the backfill cannot be imported. It is imported rather than reimplemented on purpose: the promotion rule must be the SAME code the ingest path runs, or the two drift."
    );
  }
  const backfill = await import(pathToFileURL(entry).href);
  const db = await import(
    pathToFileURL(path.join(REPO_ROOT, "backend", "dist", "lib", "db.js")).href
  );
  return { backfill, db };
}

async function run(options) {
  const resolved = options.dataDir
    ? { dir: options.dataDir, source: "--data-dir" }
    : resolveDataDir();
  const ledgerPath = path.join(resolved.dir, DB_FILE_NAME);
  if (!existsSync(ledgerPath)) {
    throw new Error(
      `no ledger at ${ledgerPath}. Pass --data-dir, or set MUON_DATA_DIR. (This script never CREATES a database: an empty one would report 0 orphans and look like success.)`
    );
  }
  // Before importing anything from the backend: `db.js` reads DATABASE_URL at
  // module init, and the whole point of --data-dir is that it decides which brain
  // is opened.
  process.env.DATABASE_URL = `file:${ledgerPath}`;
  const { backfill, db } = await loadBackend();

  for (const [table, column, migration] of REQUIRED_COLUMNS) {
    const columns = await db.prisma.$queryRawUnsafe(
      `PRAGMA table_info("${table}")`
    );
    if (!columns.some((row) => String(row.name) === column)) {
      throw new Error(
        `${table}.${column} does not exist on this ledger — migration ${migration} has not been applied to ${tildify(resolved.dir)}. Start MUON once (its boot applies pending migrations) and re-run. This script never migrates: a DRY RUN must not change the brain it is describing.`
      );
    }
  }

  const result = await backfill.backfillPromotedModuleAnchors({
    apply: options.apply,
  });
  await db.prisma.$disconnect();
  return {
    generatedAt: new Date().toISOString(),
    source: "docs/design/memory-index-decisions.md §D15",
    dataDir: tildify(resolved.dir),
    dataDirSource: resolved.source,
    ledger: { ...fileFacts(ledgerPath), path: tildify(ledgerPath) },
    result,
  };
}

function render(report) {
  const out = [];
  const line = (text = "") => out.push(text);
  const result = report.result;
  const pad = (value, width) => String(value).padStart(width);

  line(
    `MUON D15 retro-anchor backfill · ${report.generatedAt} · ${
      result.applied ? "APPLIED" : "DRY RUN (nothing written)"
    }`
  );
  line(`${report.source}`);
  line();
  line(`  data dir      ${report.dataDir}  [${report.dataDirSource}]`);
  line(
    `  ledger        ${report.ledger.path}  ${formatBytes(
      report.ledger.bytes
    )}  mtime ${report.ledger.mtime}`
  );
  line();
  line("PLAN  (orphan = active note with NO module anchor)");
  line(`  ${pad(result.scanned, 6)}  orphans scanned${result.truncated ? "  [SCAN CEILING HIT — this is a partial answer]" : ""}`);
  line(
    `  ${pad(result.notes, 6)}  would gain a module anchor  (${result.anchors} anchor rows)`
  );
  line(`  ${pad(result.noWorkspace, 6)}  skipped: no workspace on the note (nothing to resolve against)`);
  line(`  ${pad(result.noTrackedSet, 6)}  skipped: no tracked set for that workspace (not a git repo / no git)`);
  line(`  ${pad(result.noResolvablePath, 6)}  skipped: prose named no tracked file in that workspace`);
  line(`  ${pad(result.ambiguous, 6)}  coordinates REFUSED: two tracked paths differ only by case`);
  line();
  if (result.byWorkspace.length > 0) {
    line("BY WORKSPACE");
    for (const row of result.byWorkspace) {
      line(
        `  ${pad(row.notes, 6)} notes / ${pad(row.anchors, 4)} anchors   ${tildify(
          row.workspacePath
        )}`
      );
    }
    line();
  }
  if (result.examples.length > 0) {
    line(
      `EXAMPLES (${result.examples.length} of ${result.notes}) — note id + the tracked paths it names, never its text`
    );
    for (const example of result.examples) {
      line(`  ${example.noteId}  ${example.modules.join(", ")}`);
    }
    line();
  }
  if (result.applied) {
    line(
      "WRITTEN to the LEDGER. Restart MUON: the boot projector (projectLedgerToGraph)"
    );
    line(
      "republishes these anchors into the graph mirror, and the mirror is what recall and"
    );
    line("the pre-edit gate actually read. Until that restart `npm run health:memory` shows");
    line("row 4 (ledger anchors) grown while row 15 (mirror Module / ANCHORED_TO) stays flat.");
    line("Row 23 does NOT show it — both of its queries are mirror-internal (measured).");
  } else {
    line("Nothing was written. Re-run with --apply to write this plan.");
  }
  return out.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const report = await run(options);
  console.log(options.json ? JSON.stringify(report, null, 2) : render(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(
      `[muon memory-anchor-backfill] ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
  });
}

export { render, run };
