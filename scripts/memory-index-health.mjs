#!/usr/bin/env node
//
// `npm run health:memory` — the baseline harness from
// `docs/design/memory-index-validation.md` §1: **index health as numbers**.
//
// `npm run debug:report` answers "what is this MUON install doing right now?"
// for DISPATCH. It reports nothing about the memory index. This reports the 28
// rows of §1.2 — how many notes exist, how many carry a coordinate, what the
// confirmed-only gate actually returns, and whether the ledger and the graph
// mirror still agree — each printed next to its 2026-07-30 baseline and next to
// whether that row's ALARM condition currently holds. (Row 26, the standing-arm
// sizing row, was added 2026-07-31 for TODO 0.3; its baseline states its own
// date. Rows 27-28 were added 2026-08-01 for context delivery evidence.)
//
// Two guarantees, both load-bearing:
//
//   * READ-ONLY. The ledger is opened through `openReadOnlyDb`
//     (scripts/lib/muon-debug.mjs), i.e. SQLite `readOnly`: no write lock, no
//     checkpoint, and `muon.db` itself is left byte-identical with an unchanged
//     mtime (measured). ONE precise caveat, because "read-only" is load-bearing
//     here: on a WAL-mode database whose `-shm` / `-wal` sidecars are ABSENT
//     (i.e. no brain is running), SQLite CREATES them — a 32 KB `muon.db-shm`
//     and an empty `muon.db-wal` — because a WAL reader needs the shared-memory
//     index to coordinate. That is a new file beside the database, never a
//     change to it. Against a live brain the sidecars already exist and nothing
//     is created. This is a property of `openReadOnlyDb`, shared with
//     `npm run debug:report`, not of this harness.
//
//     Direct graph-mirror inspection is OFF by default. The raw LadybugDB
//     `readOnly` handle SIGSEGVed both beside a live writer and after shutdown
//     on 2026-08-03. Mirror-backed rows therefore fail closed to `unavailable`.
//     A developer may set MUON_HEALTH_OFFLINE_MIRROR_READ=1 only against an
//     isolated scratch copy; the production data path must never set it.
//   * COUNTS AND COORDINATES ONLY. No note prose is ever read into the report.
//     Row 22 must scan note text to find path tokens, and emits only the matched
//     `git ls-files` PATH and the note id — never a fragment of the note. Row 19
//     emits entity keys, but only for the COORDINATE entity classes (symbol /
//     path / package / identifier / error); the `term` and `quoted` classes are
//     verbatim fragments of note text, so those keys are WITHHELD and reported
//     as `<term len=NN>` with their frequency intact. Row 21 emits the COUNT of
//     distinct workspaces, never the workspace paths (private repo names).
//     Absolute paths in the header are printed with `$HOME` collapsed to `~`.
//     The output is meant to be safe to paste into a public issue.
//
// Not-measured is never zero. Every row carries a status:
//
//   measured       a real number.
//   not-produced   nothing upstream writes this yet (§1.2 rows marked `n/a`).
//                  A missing row and a zero row mean different things.
//   unavailable    the store/column/dependency needed could not be read. Never
//                  reported as 0, never fatal to the rest of the report.
//
// Usage:
//   node scripts/memory-index-health.mjs [options]
//     --data-dir <path>   inspect this data dir (default: MUON_DATA_DIR, else
//                         the desktop's userData, else the CLI convention)
//     --repo <path>       repo root whose `git ls-files` row 22 intersects
//                         against (default: this repository)
//     --top <n>           row 19 entity-frequency rows (default 25)
//     --days <n>          row 25 gate-read window in days (default 7)
//     --json              machine-readable output, the SAME numbers
//     --help

import {
  REPO_ROOT,
  fileFacts,
  formatBytes,
  isProcessAlive,
  openReadOnlyDb,
  readBrainLock,
  resolveDataDir,
  toIso,
} from "./lib/muon-debug.mjs";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

/** The date §1.2's numbers were measured on. Every `baseline` below is from it. */
const BASELINE_DATE = "2026-07-30";
/** Row 19: a key above this share of the active corpus is the D-mem0-1 hazard. */
const ENTITY_DF_SHARE_ALARM = 0.1;
/** Row 19: entity classes that are coordinates, so safe to print verbatim.
 *  `term` and `quoted` are fragments of note prose and are withheld. */
const COORDINATE_ENTITY_KINDS = new Set([
  "symbol",
  "path",
  "package",
  "identifier",
  "error",
]);
/**
 * Row 19, the last resort: an entity key that does not re-classify (identifier
 * normalisation is lossy) may still be printed if it is a single token built
 * ONLY from the characters coordinates use. Anything else — a quote, a comma, a
 * character outside this set — is treated as note prose and withheld. No `g`
 * flag: a `g` regex's `.test()` is stateful and would skip alternate calls.
 */
const COORDINATE_TOKEN_RE = /^[A-Za-z0-9._/@:$#*+-]{1,64}$/;
/** Row 22 / 25: how many example coordinates to carry. Counts are the answer;
 *  the examples exist so a human can go look, not to enumerate the corpus. */
const MAX_EXAMPLES = 10;

const HELP = `MUON memory-index health — the 28 rows of docs/design/memory-index-validation.md §1.2.

  node scripts/memory-index-health.mjs [--data-dir <path>] [--repo <path>]
                                       [--top <n>] [--days <n>] [--json]

Read-only: the ledger is opened SQLite \`readOnly\`, the graph mirror with
@ladybugdb/core's \`readOnly\` flag. Both files are left byte-identical. ONE
caveat: on a WAL ledger whose \`-shm\`/\`-wal\` sidecars are absent (no brain
running) SQLite CREATES them beside \`muon.db\` — a new file, never a change to
the database. Copy a data dir you must not add files to.

Counts and coordinates only: no note text is ever emitted, so the output is safe
to paste into an issue.`;

export function parseArgs(argv) {
  const options = {
    dataDir: null,
    repo: null,
    top: 25,
    days: 7,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} needs a value.`);
      }
      index += 1;
      return next;
    };
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--data-dir":
        options.dataDir = path.resolve(value());
        break;
      case "--repo":
        options.repo = path.resolve(value());
        break;
      case "--top":
        options.top = positiveInt(arg, value());
        break;
      case "--days":
        options.days = positiveInt(arg, value());
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function positiveInt(flag, raw) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error(`${flag} expects an integer between 0 and 10000.`);
  }
  return parsed;
}

// ── row + alarm vocabulary ───────────────────────────────────────────────────
//
// The alarm logic is the POINT of this harness. A human reading the output must
// not have to re-derive it from the design note, so every row carries the
// condition text from §1.2's alarm column AND the verdict on it.

/** The predicate is false. Nothing to look at. */
const OK = "ok";
/** The predicate is true and unconditional. Something broke. */
const ALARM = "alarm";
/**
 * The predicate is true, but §1.2 states it only means a regression AFTER some
 * decision lands, and the harness cannot tell whether it has. Reported as its
 * own state rather than silently as `ok` (which would hide a real regression the
 * day the decision ships) or as `alarm` (which would cry wolf every run today).
 */
const PENDING = "pending";
/** The alarm cannot be evaluated — the row is unavailable, or §1.2 states none. */
const NA = "na";

function alarmOf(state, condition, detail = null) {
  return {
    state,
    holds: state === ALARM ? true : state === OK ? false : null,
    condition,
    detail,
  };
}

/** `alarm` if the predicate holds, else `ok`. The ordinary case. */
function alarmWhen(predicate, condition, detail = null) {
  return alarmOf(predicate ? ALARM : OK, condition, detail);
}

/** `pending` if the predicate holds (see PENDING), else `ok`. */
function alarmPendingWhen(predicate, condition, precondition) {
  return alarmOf(
    predicate ? PENDING : OK,
    condition,
    predicate
      ? `predicate holds, but it only means a regression once ${precondition}; this harness cannot tell whether that has happened.`
      : null
  );
}

/** `partial` when SOME sub-measure of a hybrid row could not be read (row 14 and
 *  row 18 each straddle the ledger and the mirror). Still a real measurement, but
 *  never presented as a complete one. */
function measured(n, label, display, values, baseline, alarm, partial = false) {
  return {
    n,
    label,
    status: partial ? "partial" : "measured",
    measured: display,
    values,
    baseline,
    alarm,
  };
}

function notProduced(n, label, baseline, why, alarmCondition) {
  return {
    n,
    label,
    status: "not-produced",
    measured: "not yet produced",
    values: null,
    baseline,
    alarm: alarmOf(NA, alarmCondition, why),
    why,
  };
}

function unavailable(n, label, baseline, why, alarmCondition) {
  return {
    n,
    label,
    status: "unavailable",
    measured: "unavailable",
    values: null,
    baseline,
    alarm: alarmOf(NA, alarmCondition, why),
    why,
  };
}

// ── small helpers ────────────────────────────────────────────────────────────

/** Ladybug returns BigInt for `sum()`; SQLite can too. One coercion, everywhere. */
function num(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Collapse $HOME so a pasted report does not carry the operator's username. */
function tildify(target) {
  if (typeof target !== "string") return target;
  const home = os.homedir();
  return home && target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}

/** Every query is individually guarded: one missing table must not kill the report. */
function safeAll(db, sql, params = []) {
  try {
    return { rows: db.prepare(sql).all(...params), error: null };
  } catch (error) {
    return { rows: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function scalar(db, sql, params = []) {
  const { rows, error } = safeAll(db, sql, params);
  if (error) return { value: null, error };
  const first = rows[0];
  if (!first) return { value: null, error: null };
  return { value: num(Object.values(first)[0]), error: null };
}

/** Does the ledger actually have this column? A decision that has not migrated
 *  onto THIS install must read as "not produced", never as 0. */
function ledgerColumns(db, table) {
  const { rows, error } = safeAll(db, `PRAGMA table_info(${table})`);
  if (error) return null;
  return new Set(rows.map((row) => String(row.name)));
}

/** Prisma DateTime on SQLite is epoch-ms integer OR ISO string. Compare via ms. */
function toMillis(value) {
  const iso = toIso(value);
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** `MemoryNote.modules` / `.symbols` are Json string[] columns. */
function jsonArray(value) {
  let text = value;
  if (Buffer.isBuffer(text)) text = text.toString("utf8");
  if (typeof text !== "string" || text.length === 0) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── the graph mirror, opened ONCE ────────────────────────────────────────────
//
// MEASURED: opening the same LadybugDB store twice in ONE process tears down the
// native binding (`ERR_IPC_CHANNEL_CLOSED`). This function is called exactly once
// per run and every mirror row reads through the single connection it returns.

async function openMirror(mirrorPath) {
  if (!existsSync(mirrorPath)) {
    return { conn: null, close: async () => {}, error: `no store at ${tildify(mirrorPath)}` };
  }
  let lbug;
  try {
    // Resolved from packages/graph, which owns the dependency. The root package
    // has no runtime deps, so a checkout whose workspaces are not installed must
    // degrade to "unavailable" rather than crash.
    const require = createRequire(path.join(REPO_ROOT, "packages", "graph", "package.json"));
    lbug = require("@ladybugdb/core");
  } catch (error) {
    return {
      conn: null,
      close: async () => {},
      error: `@ladybugdb/core is not installed (run \`npm --prefix packages/graph install\`): ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  try {
    // Positional args, because that is the only shape the constructor exposes:
    // (databasePath, bufferManagerSize, enableCompression, readOnly).
    const db = new lbug.Database(mirrorPath, 0, true, /* readOnly */ true);
    const conn = new lbug.Connection(db);
    // Prove the handle answers before any row depends on it.
    await (await conn.query("MATCH (n:MemoryNote) RETURN count(*) AS c")).getAll();
    return {
      conn,
      close: async () => {
        try {
          await conn.close?.();
          await db.close?.();
        } catch {
          /* a read-only handle that will not close changes nothing on disk */
        }
      },
      error: null,
    };
  } catch (error) {
    return {
      conn: null,
      close: async () => {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function mirrorReader(conn) {
  return async function cypher(query) {
    if (!conn) return { rows: null, error: "mirror unavailable" };
    try {
      const result = await conn.query(query);
      return { rows: await result.getAll(), error: null };
    } catch (error) {
      return {
        rows: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

// ── the production entity extractor, imported not restated ───────────────────
//
// §1.3: row 19's classification, row 18's path-shaped test and row 22's path
// tokens must come from the SAME code production uses
// (`packages/graph/src/memory-entities.ts`) — "import them, never restate them".
//
// Rows 18 and 22 now use the EXACT predicate. D15 exported `PATH_RE` / `SYMBOL_RE`
// and the two pure helpers over them (`isPathShaped`, `pathShapedTokens`), because
// the coordinate layer had to ask the same question the entity layer asks; the
// harness gets to stop approximating as a side effect. Before that, both rows
// round-tripped through `extractEntities`, which also applies the production caps
// (MAX_ENTITY_SCAN_CHARS 4000, key length 3-64, the stopword lists) and therefore
// answered a slightly different question.
//
// It changed NEITHER number, and that is measured, not assumed (§1.2's method note):
// row 18 is 65 both ways — the entity SET matches §1.2 exactly, so the five-key gap
// against the 60 baseline is in that baseline's ad-hoc classification — and row 22's
// 62-vs-63 is not a predicate question at all: 63 is the count over ALL 214 notes,
// while this row (as written) counts the 212 ACTIVE ones.
//
// Row 19 still classifies with `extractEntities`, and must: its question is "what
// CLASS is this key", which only the whole extractor can answer.

async function loadEntityExtractor() {
  const entry = path.join(REPO_ROOT, "packages", "graph", "dist", "memory-entities.js");
  if (!existsSync(entry)) {
    return {
      extract: null,
      isPathShaped: null,
      pathShapedTokens: null,
      entityIdf: null,
      error: "packages/graph is not built (run `npm run graph:build`), so the production path/symbol extractor cannot be imported",
    };
  }
  try {
    // NOT named `module`: `@next/next/no-assign-module-variable` fires on that
    // identifier, and `npm run lint` covers scripts/.
    const loaded = await import(pathToFileURL(entry).href);
    const missing = [
      "extractEntities",
      "isPathShaped",
      "pathShapedTokens",
      // D-mem0-1: row 19 no longer ASSERTS that no IDF term exists — it CALLS the
      // shipped one and reports what it actually does. See the row for why.
      "entityIdf",
    ].filter((name) => typeof loaded[name] !== "function");
    if (missing.length > 0) {
      return {
        extract: null,
        isPathShaped: null,
        pathShapedTokens: null,
        entityIdf: null,
        error: `@muon/graph no longer exports ${missing.join(", ")}`,
      };
    }
    return {
      extract: loaded.extractEntities,
      isPathShaped: loaded.isPathShaped,
      pathShapedTokens: loaded.pathShapedTokens,
      entityIdf: loaded.entityIdf,
      error: null,
    };
  } catch (error) {
    return {
      extract: null,
      isPathShaped: null,
      pathShapedTokens: null,
      entityIdf: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The entity CLASS of a key, per the production extractor. A key is of class K
 *  iff re-extracting it yields K as the leading entity AND consumes the whole
 *  key. Row 18 uses this for "path-shaped", which round-trips exactly: a path key
 *  is only lower-cased, and `PATH_RE` is case-insensitive over its own output.
 *
 *  Returns null when the key does not round-trip. That is NOT a bug: `identifier`
 *  normalisation is deliberately lossy (`claude-code` → `claudecode`, which
 *  `IDENTIFIER_RE` no longer matches because the internal structure is gone), so
 *  a normalised token frequently cannot be re-classified at all. Row 19 handles
 *  null by shape, below. */
function classifyEntityKey(extract, key) {
  const out = extract(key, 50);
  if (out.length === 0) return null;
  const first = out[0];
  return first.key === key ? first.kind : null;
}

/**
 * Row 19's text gate: may this entity key be printed?
 *
 * An `Entity` id is a normalised JOIN KEY, not a note field, and §1.2's own
 * baseline row quotes two of them (`gitnexus`, `apps/cli/readme.md`). But two of
 * the seven classes are verbatim fragments of note text — `quoted` (up to 64
 * characters between quotes, which can be a sentence fragment) and `term` (a run
 * of 1-4 capitalised words) — so those must not be printed.
 *
 * The rule, failing CLOSED on anything that could be prose:
 *   - round-trips to a coordinate class (symbol/path/package/identifier/error)
 *       → PRINT, labelled with the class.
 *   - round-trips to `term` or `quoted` → WITHHOLD.
 *   - does not round-trip AND contains whitespace → WITHHOLD. Whitespace is where
 *     the prose risk lives: every multi-word key is a `term` run or a quoted
 *     fragment, because no coordinate class can contain a space except `error`
 *     (`rc 0`), which is three characters of digits and a prefix.
 *   - does not round-trip, is a single token, AND is built only from characters a
 *     coordinate uses (`COORDINATE_TOKEN_RE`) → PRINT as `token`. This is the
 *     branch that recovers `gitnexus`, `claudecode` and `--version`. Anything
 *     with punctuation outside that set is treated as prose and withheld.
 *
 * Either way the FREQUENCY is always reported, so the alarm predicate is
 * unaffected by what is withheld.
 */
function entityKeyDisclosure(extract, key) {
  const kind = extract ? classifyEntityKey(extract, key) : null;
  if (kind !== null) {
    return COORDINATE_ENTITY_KINDS.has(kind)
      ? { print: true, kind, display: key }
      : { print: false, kind, display: `<${kind} len=${key.length}>` };
  }
  if (!extract) {
    return { print: false, kind: null, display: `<unclassified len=${key.length}>` };
  }
  if (/\s/.test(key)) {
    return { print: false, kind: null, display: `<multiword len=${key.length}>` };
  }
  if (!COORDINATE_TOKEN_RE.test(key)) {
    return { print: false, kind: null, display: `<opaque len=${key.length}>` };
  }
  return { print: true, kind: "token", display: key };
}

/** Path tokens a note's text names, in the note's OWN spelling.
 *
 *  THE EXACT PREDICATE (§1.3): `pathShapedTokens` applies `PATH_RE` / `SYMBOL_RE`
 *  and hands back the SURFACE spelling, so the case assertion needs no reverse
 *  lookup at all — the previous `extractEntities` round trip had to locate each
 *  LOWERCASED key back in the source text to recover its case, because comparing a
 *  lowercased key against `git ls-files` is the mistake this row exists to catch
 *  (it makes `apps/cli/readme.md` look correct).
 *
 *  `text.length` opts out of the production 4 000-character scan bound on purpose:
 *  this row measures the WHOLE note, and the harness is on no request path. The
 *  bound is a write-path guard, and D15's promoter keeps it. That is the one way
 *  this row can legitimately exceed what the backfill will anchor, and it cannot
 *  bite today (the longest live note is 3 172 characters).
 *
 *  The note text never leaves this function. */
function pathTokens(scan, text) {
  if (typeof text !== "string" || text.length === 0) return [];
  return scan(text, text.length).map((surface) => ({
    key: surface.toLowerCase(),
    surface,
  }));
}

/** The tracked-file set for a repo. `git ls-files`, NEVER a filesystem stat:
 *  APFS is case-insensitive, so a stat accepts `apps/cli/readme.md` and the case
 *  error this row exists to find disappears (§1.3, row 22). */
function trackedFiles(repoRoot) {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "ls-files"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exact = new Set();
    const byLower = new Map();
    for (const line of out.split("\n")) {
      if (!line) continue;
      exact.add(line);
      byLower.set(line.toLowerCase(), line);
    }
    return { exact, byLower, error: null };
  } catch (error) {
    return {
      exact: null,
      byLower: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── collection ───────────────────────────────────────────────────────────────

async function collect(options) {
  const resolved = options.dataDir
    ? { dir: options.dataDir, source: "--data-dir" }
    : resolveDataDir();
  const dataDir = resolved.dir;
  const ledgerPath = path.join(dataDir, "muon.db");
  const mirrorPath = path.join(dataDir, "graph", "muon.v3.lbug");
  const repoRoot = options.repo ?? REPO_ROOT;

  const report = {
    generatedAt: new Date().toISOString(),
    baselineDate: BASELINE_DATE,
    source: "docs/design/memory-index-validation.md §1.2",
    guarantees: {
      readOnly: true,
      countsAndCoordinatesOnly: true,
      noteTextEmitted: false,
    },
    dataDir: tildify(dataDir),
    dataDirSource: resolved.source,
    ledger: { ...fileFacts(ledgerPath), path: tildify(ledgerPath) },
    mirror: { ...fileFacts(mirrorPath), path: tildify(mirrorPath), opened: false, error: null },
    mirrorWal: { ...fileFacts(`${mirrorPath}.wal`), path: tildify(`${mirrorPath}.wal`) },
    repo: { root: tildify(repoRoot), read: false, trackedFiles: null, error: null },
    rows: [],
    summary: null,
    warnings: [],
  };

  if (!report.ledger.exists) {
    report.warnings.push(
      `no ledger at ${tildify(ledgerPath)} — MUON has not run against this data dir, so there is no memory index to measure.`
    );
    report.summary = summarize(report.rows);
    return report;
  }

  let db;
  try {
    db = await openReadOnlyDb(ledgerPath);
  } catch (error) {
    report.warnings.push(
      `could not open the ledger read-only: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    report.summary = summarize(report.rows);
    return report;
  }

  const liveBrain = readBrainLock(dataDir);
  const mirrorOwnedByLiveBrain = Boolean(
    liveBrain && isProcessAlive(liveBrain.pid)
  );
  const offlineMirrorReadOptIn =
    process.env.MUON_HEALTH_OFFLINE_MIRROR_READ === "1";
  const mirror = mirrorOwnedByLiveBrain || !offlineMirrorReadOptIn
    ? {
        conn: null,
        close: async () => {},
        error: mirrorOwnedByLiveBrain
          ? "live brain owns the mirror; out-of-process LadybugDB reads are disabled"
          : "out-of-process LadybugDB reads are disabled; use an isolated copy with MUON_HEALTH_OFFLINE_MIRROR_READ=1",
      }
    : await openMirror(mirrorPath);
  report.mirror.opened = mirror.conn !== null;
  report.mirror.error = mirror.error;
  if (mirror.error) {
    report.warnings.push(
      `graph mirror unavailable (${mirror.error}) — rows 15-18, 19, 23 and 24 read "unavailable", NOT 0.`
    );
  }

  const extractor = await loadEntityExtractor();
  if (extractor.error) {
    report.warnings.push(
      `${extractor.error} — rows 18 (path-shaped), 19 (key classes) and 22 (orphans) degrade.`
    );
  }

  try {
    await collectRows(report, {
      db,
      cypher: mirrorReader(mirror.conn),
      mirrorError: mirror.error,
      extract: extractor.extract,
      // Rows 18 and 22's exact predicate, imported not restated (§1.3). Null
      // together with `extract`, so one degraded import degrades one set of rows.
      isPathShaped: extractor.isPathShaped,
      pathShapedTokens: extractor.pathShapedTokens,
      // Row 19's D-mem0-1 probe: the SHIPPED discount, called rather than
      // described. Threaded separately from `extract` because that binding is the
      // extractor FUNCTION, not the loader's result object.
      entityIdf: extractor.entityIdf,
      extractError: extractor.error,
      repoRoot,
      options,
    });
  } finally {
    db.close();
    await mirror.close();
  }

  report.summary = summarize(report.rows);
  return report;
}

async function collectRows(report, ctx) {
  const {
    db,
    cypher,
    mirrorError,
    extract,
    isPathShaped,
    pathShapedTokens,
    entityIdf,
    extractError,
    repoRoot,
    options,
  } = ctx;
  const push = (row) => report.rows.push(row);
  const mirrorWhy = mirrorError ?? "mirror unavailable";
  const noteColumns = ledgerColumns(db, "MemoryNote");
  const edgeColumns = ledgerColumns(db, "MemoryEdge");

  // ── Row 1. notes total / active ───────────────────────────────────────────
  const statusRows = safeAll(
    db,
    "SELECT status, COUNT(*) AS c FROM MemoryNote GROUP BY status"
  );
  const byStatus = new Map(statusRows.rows.map((r) => [String(r.status), num(r.c)]));
  const notesTotal = [...byStatus.values()].reduce((a, b) => a + b, 0);
  const notesActive = byStatus.get("active") ?? 0;
  if (statusRows.error) {
    push(
      unavailable(1, "notes total / active", "214 / 212", statusRows.error, "active drops without a compaction or sweep in the log")
    );
  } else {
    push(
      measured(
        1,
        "notes total / active",
        `${notesTotal} / ${notesActive}`,
        { total: notesTotal, active: notesActive, byStatus: Object.fromEntries(byStatus) },
        "214 / 212",
        alarmWhen(
          notesActive < 212,
          "active drops without a compaction or sweep in the log",
          notesActive < 212
            ? `active fell from 212 to ${notesActive}; confirm a compaction or expiry sweep in brain.log explains it — this harness does not read the log.`
            : null
        )
      )
    );
  }

  // ── Rows 2 + 3. notes carrying a coordinate array ─────────────────────────
  const arrayRows = safeAll(db, "SELECT id, modules, symbols FROM MemoryNote");
  let withModules = null;
  let withSymbols = null;
  let sumModules = 0;
  let sumSymbols = 0;
  if (!arrayRows.error) {
    withModules = 0;
    withSymbols = 0;
    for (const row of arrayRows.rows) {
      const modules = jsonArray(row.modules);
      const symbols = jsonArray(row.symbols);
      if (modules.length > 0) withModules += 1;
      if (symbols.length > 0) withSymbols += 1;
      sumModules += modules.length;
      sumSymbols += symbols.length;
    }
  }
  push(
    withModules === null
      ? unavailable(2, "notes with non-empty `modules`", "33", arrayRows.error, "goes down")
      : measured(
          2,
          "notes with non-empty `modules`",
          String(withModules),
          { notes: withModules, totalEntries: sumModules },
          "33",
          alarmWhen(withModules < 33, "goes down")
        )
  );
  push(
    withSymbols === null
      ? unavailable(3, "notes with non-empty `symbols`", "0", arrayRows.error, "stays 0 after D1/D15 land")
      : measured(
          3,
          "notes with non-empty `symbols`",
          String(withSymbols),
          { notes: withSymbols, totalEntries: sumSymbols },
          "0",
          // D1 and D15 have both LANDED, and this row is still 0 by construction:
          // D15 promotes a path-shaped token into a MODULE anchor and deliberately
          // mints no symbol id (0 live entities contain `#` — nothing in the corpus
          // ever names one, so that arm has no producer). What would move this row is
          // a writer that supplies `symbols`, which is D2's question, so that is the
          // precondition this row now waits on rather than a shipped one.
          alarmPendingWhen(
            withSymbols === 0,
            "stays 0 after D1/D15 land",
            "a writer supplies a symbol id (D2) — D15 promotes MODULE anchors only"
          )
        )
  );

  // ── Row 4. anchors by kind (distinct) ─────────────────────────────────────
  const anchorRows = safeAll(
    db,
    "SELECT kind, COUNT(*) AS total, COUNT(DISTINCT value) AS distinctValues FROM MemoryAnchor GROUP BY kind"
  );
  const KINDS = ["topic", "task", "chat", "lane", "module", "symbol"];
  let moduleAnchorCount = null;
  if (anchorRows.error) {
    push(
      unavailable(
        4,
        "anchors by kind (distinct)",
        "topic 633 (163), task 214 (21), chat 212 (7), lane 209 (2), module 37 (9), symbol 0",
        anchorRows.error,
        "module count flat while note count grows"
      )
    );
  } else {
    const seen = new Map(
      anchorRows.rows.map((r) => [String(r.kind), { total: num(r.total), distinct: num(r.distinctValues) }])
    );
    const values = {};
    const parts = [];
    for (const kind of KINDS) {
      const entry = seen.get(kind) ?? { total: 0, distinct: 0 };
      values[kind] = entry;
      // `symbol 0` must PRINT as 0: a kind with no rows is absent from the
      // GROUP BY, and silently dropping it is how row 4's whole point is lost.
      parts.push(entry.total === 0 ? `${kind} 0` : `${kind} ${entry.total} (${entry.distinct})`);
    }
    for (const [kind, entry] of seen) {
      if (!KINDS.includes(kind)) {
        values[kind] = entry;
        parts.push(`${kind} ${entry.total} (${entry.distinct}) [NOT IN BASELINE]`);
      }
    }
    moduleAnchorCount = values.module.total;
    push(
      measured(
        4,
        "anchors by kind (distinct)",
        parts.join(", "),
        values,
        "topic 633 (163), task 214 (21), chat 212 (7), lane 209 (2), module 37 (9), symbol 0",
        alarmWhen(
          moduleAnchorCount <= 37 && notesTotal > 214,
          "module count flat while note count grows",
          moduleAnchorCount <= 37 && notesTotal > 214
            ? `notes grew 214 → ${notesTotal} while module anchors stayed at ${moduleAnchorCount} (baseline 37).`
            : null
        )
      )
    );
  }

  // ── Row 5. THE FLAGSHIP. §1.3's query, verbatim. ──────────────────────────
  const row5 = scalar(
    db,
    `WITH human_latest AS (
  SELECT c.noteId, c.decision FROM Confirmation c
  WHERE c.principal LIKE 'human%'
    AND c.at = (SELECT MAX(c2.at) FROM Confirmation c2
                WHERE c2.noteId = c.noteId AND c2.principal LIKE 'human%')
)
SELECT COUNT(DISTINCT n.id) FROM MemoryNote n
JOIN MemoryAnchor a ON a.noteId = n.id AND a.kind = 'module'
WHERE n.status = 'active'
  AND n.id IN (SELECT noteId FROM human_latest WHERE decision = 'confirm')`
  );
  push(
    row5.error
      ? unavailable(5, "GATE: human-confirmed + active + module-anchored", "0", row5.error, "stays 0 — this is §3")
      : measured(
          5,
          "GATE: human-confirmed + active + module-anchored",
          String(row5.value),
          { notes: row5.value },
          "0",
          alarmWhen(
            row5.value === 0,
            "stays 0 — this is §3",
            row5.value === 0
              ? "the flagship dual-graph query returns nothing on this install: `recallForGate({module})` has an empty index. This is the §3 exit condition, unmet."
              : null
          )
        )
  );

  // ── Row 6. The #133 crew-vouched widening. ────────────────────────────────
  // `governedConditions`' crew branch is `(n.chatId = $crewChatId AND n.chatId <> '')`,
  // and the outer chat partition bounds every row to that one chat — so summed
  // over chats it is exactly "active, module-anchored, chat-scoped".
  const row6 = scalar(
    db,
    `SELECT COUNT(DISTINCT n.id) FROM MemoryNote n
       JOIN MemoryAnchor a ON a.noteId = n.id AND a.kind = 'module'
      WHERE n.status = 'active' AND n.chatId IS NOT NULL AND n.chatId <> ''`
  );
  push(
    row6.error
      ? unavailable(6, "GATE: vouched + active + module-anchored", "32", row6.error, "drops")
      : measured(6, "GATE: vouched + active + module-anchored", String(row6.value), { notes: row6.value }, "32", alarmWhen(row6.value < 32, "drops"))
  );

  // ── Row 7. chats holding module-anchored active notes ─────────────────────
  const chatsWith = scalar(
    db,
    `SELECT COUNT(DISTINCT n.chatId) FROM MemoryNote n
       JOIN MemoryAnchor a ON a.noteId = n.id AND a.kind = 'module'
      WHERE n.status = 'active' AND n.chatId IS NOT NULL AND n.chatId <> ''`
  );
  const chatsTotal = scalar(
    db,
    "SELECT COUNT(DISTINCT chatId) FROM MemoryNote WHERE chatId IS NOT NULL AND chatId <> ''"
  );
  push(
    chatsWith.error || chatsTotal.error
      ? unavailable(7, "chats holding module-anchored active notes", "3 of 7", chatsWith.error ?? chatsTotal.error, "a new chat never reaches 1")
      : measured(
          7,
          "chats holding module-anchored active notes",
          `${chatsWith.value} of ${chatsTotal.value}`,
          { withModuleAnchoredNotes: chatsWith.value, chatsHoldingNotes: chatsTotal.value },
          "3 of 7",
          alarmWhen(
            chatsTotal.value > 7 && chatsWith.value <= 3,
            "a new chat never reaches 1",
            chatsTotal.value > 7 && chatsWith.value <= 3
              ? `chats holding notes grew 7 → ${chatsTotal.value}, but the count reaching one module anchor is still ${chatsWith.value} (baseline 3).`
              : null
          )
        )
  );

  // ── Row 8. MemoryEdge by kind / with a non-null weight ────────────────────
  const edgeRows = safeAll(
    db,
    "SELECT kind, COUNT(*) AS c, SUM(CASE WHEN weight IS NOT NULL THEN 1 ELSE 0 END) AS weighted FROM MemoryEdge GROUP BY kind"
  );
  const hasReasonColumn = edgeColumns?.has("reason") ?? false;
  if (edgeRows.error) {
    push(unavailable(8, "`MemoryEdge` by kind / with non-null `weight`", "10 / 0", edgeRows.error, "after D8, `reason` null on a new edge"));
  } else {
    const byKind = {};
    let edgeTotal = 0;
    let weighted = 0;
    for (const row of edgeRows.rows) {
      byKind[String(row.kind)] = num(row.c);
      edgeTotal += num(row.c);
      weighted += num(row.weighted);
    }
    // D8's `reason` column: present ⇒ the alarm is evaluable; absent ⇒ D8 has
    // not landed on THIS ledger and the alarm cannot fire yet.
    let reasonNulls = null;
    if (hasReasonColumn) {
      const r = scalar(db, "SELECT COUNT(*) FROM MemoryEdge WHERE reason IS NULL OR reason = ''");
      reasonNulls = r.error ? null : r.value;
    }
    push(
      measured(
        8,
        "`MemoryEdge` by kind / with non-null `weight`",
        `${edgeTotal} / ${weighted}` +
          (hasReasonColumn ? `  (reason null on ${reasonNulls ?? "?"})` : "  (D8 `reason` column absent)"),
        { total: edgeTotal, byKind, weighted, hasReasonColumn, reasonNulls },
        "10 / 0",
        hasReasonColumn
          ? alarmWhen((reasonNulls ?? 0) > 0, "after D8, `reason` null on a new edge")
          : alarmOf(NA, "after D8, `reason` null on a new edge", "D8 has not landed: `MemoryEdge` has no `reason` column on this ledger.")
      )
    );
  }

  // ── Row 9. MemoryEdge by `derivation` — D7, not yet produced. ─────────────
  const hasDerivation = edgeColumns?.has("derivation") ?? false;
  if (!hasDerivation) {
    push(
      notProduced(
        9,
        "`MemoryEdge` by `derivation` (after D7)",
        "n/a",
        "D7 has not landed: `MemoryEdge` has no `derivation` column, so no edge can be labelled asserted/proposed/derived. A zero here would claim the tier exists and is empty.",
        "any `derived` row reachable from a gate read"
      )
    );
  } else {
    const derivationRows = safeAll(
      db,
      "SELECT derivation, COUNT(*) AS c FROM MemoryEdge GROUP BY derivation"
    );
    const byDerivation = Object.fromEntries(
      derivationRows.rows.map((r) => [r.derivation === null ? "(null)" : String(r.derivation), num(r.c)])
    );
    const derived = byDerivation.derived ?? 0;
    push(
      measured(
        9,
        "`MemoryEdge` by `derivation` (after D7)",
        Object.entries(byDerivation).map(([k, v]) => `${k} ${v}`).join(", ") || "0",
        byDerivation,
        "n/a",
        alarmWhen(
          derived > 0,
          "any `derived` row reachable from a gate read",
          derived > 0
            ? `${derived} \`derived\` edge(s) exist; confirm none is reachable from a gate read — this harness counts them, it does not run the gate.`
            : null
        )
      )
    );
  }

  // ── Row 10. Confirmations by verb ─────────────────────────────────────────
  const confirmRows = safeAll(
    db,
    "SELECT principal, decision, COUNT(*) AS c FROM Confirmation GROUP BY principal, decision"
  );
  if (confirmRows.error) {
    push(
      unavailable(
        10,
        "Confirmations: human confirm / human reject / orchestrator / system-reconcile",
        "54 / 1 / 152 / 10",
        confirmRows.error,
        "a fourth verb appears with no reader"
      )
    );
  } else {
    // §8: bucket by `principal LIKE 'human%'` / `LIKE 'agent:orchestrator:%'` /
    // other. The PRINCIPAL is a coordinate, but a per-principal breakdown would
    // enumerate agent session ids, so only the class is reported.
    const buckets = { humanConfirm: 0, humanReject: 0, orchestrator: 0, systemReconcile: 0, other: 0 };
    const verbs = new Set();
    for (const row of confirmRows.rows) {
      const principal = String(row.principal ?? "");
      const decision = String(row.decision ?? "");
      const count = num(row.c);
      verbs.add(decision);
      if (principal.startsWith("human") && decision === "confirm") buckets.humanConfirm += count;
      else if (principal.startsWith("human") && decision === "reject") buckets.humanReject += count;
      else if (principal.startsWith("agent:orchestrator:")) buckets.orchestrator += count;
      else if (decision === "reconcile") buckets.systemReconcile += count;
      else buckets.other += count;
    }
    const KNOWN_VERBS = new Set(["confirm", "reject", "reconcile"]);
    const unknownVerbs = [...verbs].filter((verb) => !KNOWN_VERBS.has(verb));
    push(
      measured(
        10,
        "Confirmations: human confirm / human reject / orchestrator / system-reconcile",
        `${buckets.humanConfirm} / ${buckets.humanReject} / ${buckets.orchestrator} / ${buckets.systemReconcile}` +
          (buckets.other > 0 ? `  (+${buckets.other} unbucketed)` : ""),
        { ...buckets, verbs: [...verbs].sort(), unknownVerbs },
        "54 / 1 / 152 / 10",
        alarmWhen(
          unknownVerbs.length > 0,
          "a fourth verb appears with no reader",
          unknownVerbs.length > 0 ? `decision verb(s) outside {confirm, reject, reconcile}: ${unknownVerbs.join(", ")}` : null
        )
      )
    );
  }

  // ── Row 11. trust ─────────────────────────────────────────────────────────
  const trustRows = safeAll(db, "SELECT trust, COUNT(*) AS c FROM MemoryNote GROUP BY trust");
  if (trustRows.error) {
    push(unavailable(11, "trust high / medium / low", "0 / 213 / 1", trustRows.error, "—"));
  } else {
    const trust = { high: 0, medium: 0, low: 0 };
    for (const row of trustRows.rows) {
      const key = String(row.trust);
      if (key in trust) trust[key] += num(row.c);
      else trust[key] = num(row.c);
    }
    push(
      measured(
        11,
        "trust high / medium / low",
        `${trust.high} / ${trust.medium} / ${trust.low}`,
        trust,
        "0 / 213 / 1",
        alarmOf(NA, "—", "§1.2 states no alarm for this row; it is context for rows 6 and 12.")
      )
    );
  }

  // ── Row 12. staleSince set ────────────────────────────────────────────────
  const stale = scalar(
    db,
    "SELECT COUNT(*) FROM MemoryNote WHERE staleSince IS NOT NULL AND staleSince <> ''"
  );
  push(
    stale.error
      ? unavailable(12, "`staleSince` set", "0", stale.error, "jumps sharply on the same day D9's producer ships (see §5.7)")
      : measured(
          12,
          "`staleSince` set",
          String(stale.value),
          { notes: stale.value },
          "0",
          alarmWhen(
            stale.value > 0,
            "jumps sharply on the same day D9's producer ships (see §5.7)",
            stale.value > 0
              ? `rose from 0 to ${stale.value}. §5.7 step 3 must pass FIRST: while \`selectMemorySliceNotes\` drops \`!note.stale\`, staleness makes the brief measurably worse than empty.`
              : null
          )
        )
  );

  // ── Row 13. expiresAt set / already expired ───────────────────────────────
  const expiryRows = safeAll(
    db,
    "SELECT expiresAt, expiredAt FROM MemoryNote WHERE expiresAt IS NOT NULL"
  );
  if (expiryRows.error) {
    push(unavailable(13, "`expiresAt` set / already expired", "20 / 0", expiryRows.error, "expired > 0 with the sweeper idle"));
  } else {
    const now = Date.now();
    let expired = 0;
    let sweptAlready = 0;
    for (const row of expiryRows.rows) {
      const ms = toMillis(row.expiresAt);
      if (ms !== null && ms <= now) expired += 1;
      if (row.expiredAt !== null && row.expiredAt !== undefined) sweptAlready += 1;
    }
    // "already expired" is DERIVED from `expiresAt <= now` (the read path derives
    // hidden-ness the same way), so it is correct even if the sweeper never ran.
    const unswept = Math.max(0, expired - sweptAlready);
    push(
      measured(
        13,
        "`expiresAt` set / already expired",
        `${expiryRows.rows.length} / ${expired}`,
        { withExpiry: expiryRows.rows.length, expired, materializedBySweeper: sweptAlready, expiredButUnswept: unswept },
        "20 / 0",
        alarmWhen(
          unswept > 0,
          "expired > 0 with the sweeper idle",
          unswept > 0
            ? `${unswept} note(s) are past \`expiresAt\` with no \`expiredAt\` marker — the sweeper has not caught up. Reads still hide them (hidden-ness is derived), so this is a sweeper-liveness signal.`
            : null
        )
      )
    );
  }

  // ── Row 14. the embedder / partial-index hazard (§5.5) ────────────────────
  const cacheRows = scalar(db, "SELECT COUNT(*) FROM EmbeddingCache");
  const vectorized = await cypher(
    "MATCH (n:MemoryNote) WHERE size(n.embedding) > 0 RETURN count(*) AS c"
  );
  const mirrorNotes = await cypher("MATCH (n:MemoryNote) RETURN count(*) AS c");
  if (cacheRows.error && vectorized.error) {
    push(unavailable(14, "`EmbeddingCache` rows; mirror notes with a vector", "0; 0 of 214", cacheRows.error ?? mirrorWhy, "`0 < vectorized < active` — the partial-index hazard, §5.5"));
  } else {
    const vec = vectorized.rows ? num(vectorized.rows[0]?.c) : null;
    const mirrorTotal = mirrorNotes.rows ? num(mirrorNotes.rows[0]?.c) : null;
    const partial = vec !== null && vec > 0 && vec < notesActive;
    push(
      measured(
        14,
        "`EmbeddingCache` rows; mirror notes with a vector",
        `${cacheRows.error ? "unavailable" : cacheRows.value}; ${
          vec === null ? "unavailable" : `${vec} of ${mirrorTotal}`
        }`,
        { embeddingCacheRows: cacheRows.error ? null : cacheRows.value, vectorized: vec, mirrorNotes: mirrorTotal, activeNotes: notesActive },
        "0; 0 of 214",
        vec === null
          ? alarmOf(NA, "`0 < vectorized < active` — the partial-index hazard, §5.5", mirrorWhy)
          : alarmWhen(
              partial,
              "`0 < vectorized < active` — the partial-index hazard, §5.5",
              partial
                ? `${vec} of ${notesActive} active notes carry a vector. \`semanticCandidates\` filters \`size(n.embedding) > 0\`, so the dense arm is ranking over a SUBSET and, under RRF, presence-of-vector is acting as a ranking signal. §5.5 step 5: the arm must be DISABLED, not partially applied.`
                : null
            ),
        vec === null || cacheRows.error !== null
      )
    );
  }

  // ── Row 15. mirror Module / ANCHORED_TO ───────────────────────────────────
  const moduleNodes = await cypher("MATCH (m:Module) RETURN count(*) AS c");
  const anchoredTo = await cypher("MATCH (:MemoryNote)-[:ANCHORED_TO]->(:Module) RETURN count(*) AS c");
  const mirrorSumModules = await cypher("MATCH (n:MemoryNote) RETURN sum(size(n.modules)) AS s");
  if (!moduleNodes.rows || !anchoredTo.rows) {
    push(unavailable(15, "mirror `Module` / `ANCHORED_TO`", "9 / 37", mirrorWhy, "`ANCHORED_TO != Σ size(n.modules)`"));
  } else {
    const modules = num(moduleNodes.rows[0]?.c);
    const edges = num(anchoredTo.rows[0]?.c);
    const sumSize = mirrorSumModules.rows ? num(mirrorSumModules.rows[0]?.s) : null;
    push(
      measured(
        15,
        "mirror `Module` / `ANCHORED_TO`",
        `${modules} / ${edges}` + (sumSize === null ? "" : `  (Σ size(n.modules) = ${sumSize})`),
        { moduleNodes: modules, anchoredTo: edges, sumModuleArrayEntries: sumSize },
        "9 / 37",
        sumSize === null
          ? alarmOf(NA, "`ANCHORED_TO != Σ size(n.modules)`", mirrorWhy)
          : alarmWhen(
              edges !== sumSize,
              "`ANCHORED_TO != Σ size(n.modules)`",
              edges !== sumSize
                ? `${edges} edges vs ${sumSize} array entries. \`mirrorToGraph\` writes the ANCHORED_TO edge as a separate statement with a swallowed error (§5.8) — a dropped edge is invisible today and a LOST MEMORY under D6-B.`
                : null
            )
      )
    );
  }

  // ── Row 16. mirror Symbol / symbolUid ─────────────────────────────────────
  const symbolNodes = await cypher(
    "MATCH (s:Symbol) RETURN count(*) AS c, sum(CASE WHEN s.symbolUid = '' THEN 1 ELSE 0 END) AS blank"
  );
  const symbolProps = await cypher("CALL table_info('Symbol') RETURN *");
  if (!symbolNodes.rows) {
    push(unavailable(16, "mirror `Symbol` / with `symbolUid = ''`", "6 / 6", mirrorWhy, "a `symbolUid` set with no `symbolUidAt`"));
  } else {
    const total = num(symbolNodes.rows[0]?.c);
    const blank = num(symbolNodes.rows[0]?.blank);
    const set = total - blank;
    // D2's cache needs a commit stamp beside the uid; without one, a resolved
    // uid can never be read as a MISS on re-index (§5.2 step 3).
    const propNames = symbolProps.rows ? symbolProps.rows.map((r) => String(r.name ?? r["name"])) : null;
    const hasStamp = propNames ? propNames.includes("symbolUidAt") : null;
    push(
      measured(
        16,
        "mirror `Symbol` / with `symbolUid = ''`",
        `${total} / ${blank}`,
        { symbols: total, blankUid: blank, resolvedUid: set, hasSymbolUidAt: hasStamp },
        "6 / 6",
        hasStamp === null
          ? alarmOf(NA, "a `symbolUid` set with no `symbolUidAt`", "could not read the Symbol table's properties")
          : alarmWhen(
              set > 0 && !hasStamp,
              "a `symbolUid` set with no `symbolUidAt`",
              set > 0 && !hasStamp
                ? `${set} Symbol node(s) carry a resolved \`symbolUid\` but the table has no \`symbolUidAt\`, so a re-index (§5.2) cannot read the cached uid as a MISS and will serve a stale hit.`
                : null
            )
      )
    );
  }

  // ── Row 17. mirror ABOUT_SYMBOL / TOUCHED / ACTED_ON_MODULE / ACTED_ON ────
  const relCounts = {};
  const relErrors = [];
  for (const [key, query] of [
    ["ABOUT_SYMBOL", "MATCH (:MemoryNote)-[:ABOUT_SYMBOL]->(:Symbol) RETURN count(*) AS c"],
    ["TOUCHED", "MATCH (:TaskNode)-[:TOUCHED]->(:Module) RETURN count(*) AS c"],
    ["ACTED_ON_MODULE", "MATCH (:TaskNode)-[:ACTED_ON_MODULE]->(:Module) RETURN count(*) AS c"],
    ["ACTED_ON", "MATCH (:TaskNode)-[:ACTED_ON]->(:Symbol) RETURN count(*) AS c"],
  ]) {
    const result = await cypher(query);
    if (!result.rows) {
      relCounts[key] = null;
      relErrors.push(`${key}: ${result.error}`);
    } else {
      relCounts[key] = num(result.rows[0]?.c);
    }
  }
  const mirrorSumSymbols = await cypher("MATCH (n:MemoryNote) RETURN sum(size(n.symbols)) AS s");
  if (relErrors.length === 4) {
    push(
      unavailable(
        17,
        "mirror `ABOUT_SYMBOL` / `TOUCHED` / `ACTED_ON_MODULE` / `ACTED_ON`",
        "0 / 0 / 0 / 9",
        mirrorWhy,
        "`ABOUT_SYMBOL != Σ size(n.symbols)`"
      )
    );
  } else {
    const symbolSum = mirrorSumSymbols.rows ? num(mirrorSumSymbols.rows[0]?.s) : null;
    push(
      measured(
        17,
        "mirror `ABOUT_SYMBOL` / `TOUCHED` / `ACTED_ON_MODULE` / `ACTED_ON`",
        `${relCounts.ABOUT_SYMBOL ?? "?"} / ${relCounts.TOUCHED ?? "?"} / ${relCounts.ACTED_ON_MODULE ?? "?"} / ${relCounts.ACTED_ON ?? "?"}` +
          (symbolSum === null ? "" : `  (Σ size(n.symbols) = ${symbolSum})`),
        { ...relCounts, sumSymbolArrayEntries: symbolSum },
        "0 / 0 / 0 / 9",
        symbolSum === null || relCounts.ABOUT_SYMBOL === null
          ? alarmOf(NA, "`ABOUT_SYMBOL != Σ size(n.symbols)`", mirrorWhy)
          : alarmWhen(relCounts.ABOUT_SYMBOL !== symbolSum, "`ABOUT_SYMBOL != Σ size(n.symbols)`")
      )
    );
  }

  // ── Rows 18 + 19. the entity index ────────────────────────────────────────
  const entityNodes = await cypher("MATCH (e:Entity) RETURN count(*) AS c");
  const mentions = await cypher("MATCH (:MemoryNote)-[:MENTIONS]->(:Entity) RETURN count(*) AS c");
  const hashEntities = await cypher("MATCH (e:Entity) WHERE contains(e.id, '#') RETURN count(*) AS c");
  const allEntities = await cypher("MATCH (e:Entity) RETURN e.id AS id");
  if (!entityNodes.rows) {
    push(
      unavailable(
        18,
        "mirror `Entity` / `MENTIONS` / path-shaped / containing `#`",
        "481 / 867 / 60 / 0",
        mirrorWhy,
        "path-shaped entities grow while module anchors do not"
      )
    );
  } else {
    const entities = num(entityNodes.rows[0]?.c);
    const mentionCount = mentions.rows ? num(mentions.rows[0]?.c) : null;
    const hashCount = hashEntities.rows ? num(hashEntities.rows[0]?.c) : null;
    let pathShaped = null;
    if (isPathShaped && allEntities.rows) {
      // THE EXACT PREDICATE (§1.3), not an `extractEntities` round trip: a key is
      // path-shaped iff `PATH_RE` covers the whole of it. The round trip also
      // applied the key-length bounds and the stopword lists, which is why this row
      // read 65 against a baseline of 60 — method, not growth.
      pathShaped = allEntities.rows.filter((row) =>
        isPathShaped(String(row.id))
      ).length;
    }
    // moduleAnchorCount null ⇒ row 4 was unreadable, so "while module anchors do
    // not [grow]" is UNKNOWN. Never infer 0 for it: that would fire this alarm
    // every time row 4 fails.
    const grew =
      pathShaped !== null && moduleAnchorCount !== null && pathShaped > 60 && moduleAnchorCount <= 37;
    push(
      measured(
        18,
        "mirror `Entity` / `MENTIONS` / path-shaped / containing `#`",
        `${entities} / ${mentionCount ?? "?"} / ${pathShaped ?? "unavailable"} / ${hashCount ?? "?"}`,
        { entities, mentions: mentionCount, pathShaped, containingHash: hashCount },
        "481 / 867 / 60 / 0",
        pathShaped === null || moduleAnchorCount === null
          ? alarmOf(
              NA,
              "path-shaped entities grow while module anchors do not",
              pathShaped === null ? (extractError ?? mirrorWhy) : "row 4 (module anchor count) was unreadable"
            )
          : alarmWhen(
              grew,
              "path-shaped entities grow while module anchors do not",
              grew
                ? `${pathShaped} path-shaped entity keys (baseline 60) against ${moduleAnchorCount} module anchors (baseline 37): notes are naming more coordinates in prose while none of it becomes an anchor. D15 promotes them at INGEST, so this row keeps counting the prose while row 4 is what should now move; a run where this grows and row 4 does not means promotion is not firing (a NULL tracked set on every write would do it). CAVEAT: "path-shaped" is \`isPathShaped\` — \`PATH_RE\` over the whole key — which need not match the ad-hoc classification the 2026-07-30 baseline used, so a small delta may be method rather than growth. The number to diff against is THIS harness's own previous run.`
                : null
            ),
        pathShaped === null || mentionCount === null || hashCount === null
      )
    );
  }

  // Row 19. §1.3's predicate, verbatim — with ONE deliberate difference, measured:
  // `ORDER BY df DESC` has no tiebreak in the store, and the live brain has many
  // ties (six keys at df 6), so `LIMIT 25` returned a DIFFERENT set of tied keys
  // between two runs of the same query on the same bytes. A harness whose output
  // changes run to run cannot be diffed. So the predicate runs UNBOUNDED (a strict
  // superset of the LIMITed answer — 481 rows, nothing) and the cap is applied
  // here after a stable `(df DESC, key ASC)` sort. The counts are untouched.
  const dfRows = await cypher(
    `MATCH (n:MemoryNote)-[:MENTIONS]->(e:Entity)
RETURN e.id AS entity, count(*) AS df ORDER BY df DESC`
  );
  if (dfRows.rows) {
    dfRows.rows.sort(
      (left, right) =>
        num(right.df) - num(left.df) || String(left.entity).localeCompare(String(right.entity))
    );
    dfRows.rows = dfRows.rows.slice(0, Math.max(1, options.top));
  }
  if (!dfRows.rows) {
    push(
      unavailable(
        19,
        "top entity document frequency",
        "`gitnexus` 30, `apps/cli/readme.md` 30",
        mirrorWhy,
        "any key above ~10% of the active corpus with no IDF term (D-mem0-1)"
      )
    );
  } else {
    const threshold = ENTITY_DF_SHARE_ALARM * notesActive;
    const top = dfRows.rows.map((row) => {
      const key = String(row.entity);
      const df = num(row.df);
      // The FREQUENCY is the measurement and is always reported; the key itself
      // is printed only when it cannot be a fragment of note prose.
      const disclosure = entityKeyDisclosure(extract, key);
      return {
        key: disclosure.display,
        df,
        kind: disclosure.kind,
        withheld: !disclosure.print,
        overThreshold: df > threshold,
      };
    });
    const maxDf = top.reduce((acc, row) => Math.max(acc, row.df), 0);
    const over = top.filter((row) => row.overThreshold);
    // Ask the SHIPPED term what it does to the worst key here, versus a df-1 key
    // in the same corpus. Calling it beats asserting about it: if the term is ever
    // removed or neutered, this row notices on the next run instead of staying
    // green because a comment said the fix had landed.
    const corpusStats = {
      df: new Map([["worst", maxDf], ["rare", 1]]),
      activeNotes: notesActive,
    };
    const idfWorst = entityIdf ? entityIdf("worst", corpusStats) : 0;
    const idfRare = entityIdf ? entityIdf("rare", corpusStats) : 0;
    // Damping means the common key is worth STRICTLY less than a rare one. When no
    // key exceeds the threshold there is nothing to damp, so the row is vacuously
    // fine — never alarm on an absence of the hazard.
    const idfDamps = over.length === 0 || idfWorst < idfRare;
    push(
      measured(
        19,
        "top entity document frequency",
        top.slice(0, 3).map((row) => `${row.key} ${row.df}`).join(", ") +
          (top.length > 3 ? `, … (${top.length} rows)` : ""),
        { activeNotes: notesActive, thresholdDf: Number(threshold.toFixed(1)), maxDf, overThreshold: over.length, top },
        "`gitnexus` 30, `apps/cli/readme.md` 30",
        // D-mem0-1 SHIPPED, so this row's question changed and the row says so.
        //
        // The original condition was "any key above ~10% of the corpus WITH NO IDF
        // TERM". The first half is a corpus property and will always be true on a
        // real brain — some words ARE common. The second half was a claim about
        // CODE that this harness could not see, hard-coded as a judgement.
        //
        // So the row now CALLS the shipped `entityIdf` on the worst key it found,
        // exactly as rows 18/22 call the shipped path predicate rather than
        // restating it (§1.3, "import them, never restate them"). A high-df key is
        // no longer a defect — it is expected, and handled. The alarm survives only
        // for the case that would genuinely break retrieval again: a common key
        // that the shipped term does NOT damp relative to a rare one.
        //
        // notesActive 0 ⇒ row 1 was unreadable, so the threshold is 0 and EVERY
        // key would "exceed ~10% of the corpus". A zero denominator is not a
        // measurement; report it as such.
        notesActive === 0
          ? alarmOf(
              NA,
              "a high-df key that the shipped IDF term does not damp (D-mem0-1)",
              "the active-note count (row 1) is 0 or unreadable, so the ~10% threshold has no denominator"
            )
          : !entityIdf
            ? alarmOf(
                NA,
                "a high-df key that the shipped IDF term does not damp (D-mem0-1)",
                `the shipped \`entityIdf\` could not be imported (${extractError ?? "packages/graph is not built"}), so this row cannot check whether a common key is damped`
              )
            : alarmWhen(
          !idfDamps,
          "a high-df key that the shipped IDF term does not damp (D-mem0-1)",
          !idfDamps
            ? `${over.length} key(s) appear on more than ${threshold.toFixed(1)} notes (>${ENTITY_DF_SHARE_ALARM * 100}% of ${notesActive} active), top df ${maxDf}, and the shipped \`entityIdf\` scores the worst of them at ${idfWorst.toFixed(4)} against ${idfRare.toFixed(4)} for a df-1 key — it is NOT damping them, so a corpus-wide key still scores like a bullseye.`
            : over.length > 0
              ? `${over.length} key(s) exceed the threshold (top df ${maxDf}) and that is EXPECTED on a real corpus: the shipped \`entityIdf\` damps the worst of them to ${idfWorst.toFixed(4)} against ${idfRare.toFixed(4)} for a df-1 key, a ${(100 - (idfWorst / idfRare) * 100).toFixed(0)}% discount. D-mem0-1 is closed.`
              : null
        )
      )
    );
  }

  // ── Row 20. events carrying coordinates ───────────────────────────────────
  const eventsTotal = scalar(db, "SELECT COUNT(*) FROM Event");
  const eventsSymbols = scalar(
    db,
    "SELECT COUNT(*) FROM Event WHERE json_extract(metadata, '$.symbols') IS NOT NULL"
  );
  const eventsModules = scalar(
    db,
    "SELECT COUNT(*) FROM Event WHERE json_extract(metadata, '$.modules') IS NOT NULL"
  );
  if (eventsTotal.error) {
    push(
      unavailable(
        20,
        "events total / with `metadata.symbols` / with `metadata.modules`",
        "75 / 9 / 0",
        eventsTotal.error,
        "modules stays 0 after D9"
      )
    );
  } else {
    const withModules = eventsModules.error ? null : eventsModules.value;
    push(
      measured(
        20,
        "events total / with `metadata.symbols` / with `metadata.modules`",
        `${eventsTotal.value} / ${eventsSymbols.error ? "?" : eventsSymbols.value} / ${withModules ?? "?"}`,
        { total: eventsTotal.value, withSymbols: eventsSymbols.error ? null : eventsSymbols.value, withModules },
        "75 / 9 / 0",
        withModules === null
          ? alarmOf(NA, "modules stays 0 after D9", eventsModules.error)
          : alarmPendingWhen(withModules === 0, "modules stays 0 after D9", "D9's staleness producer ships")
      )
    );
  }

  // ── Row 21. one ledger, many workspaces ───────────────────────────────────
  // COUNTS ONLY: a workspace path is an absolute path carrying the operator's
  // username and private repository names, so the paths are never emitted.
  const chatWorkspaces = safeAll(
    db,
    "SELECT DISTINCT workspacePath FROM OrchestratorChat WHERE workspacePath IS NOT NULL AND workspacePath <> ''"
  );
  const hasNoteWorkspace = noteColumns?.has("workspacePath") ?? false;
  if (chatWorkspaces.error) {
    push(
      unavailable(
        21,
        "distinct `OrchestratorChat.workspacePath` in ONE ledger",
        "6",
        chatWorkspaces.error,
        "notes with a `repoKey` that no chat's workspace matches"
      )
    );
  } else {
    const distinct = chatWorkspaces.rows.length;
    // The shipped name for §1.2's `repoKey` is `MemoryNote.workspacePath`
    // (ADR-0026, migration 0041_memory_note_workspace).
    let unmatched = null;
    let notesWithRepoKey = null;
    if (hasNoteWorkspace) {
      const known = new Set(chatWorkspaces.rows.map((row) => String(row.workspacePath)));
      const noteWs = safeAll(
        db,
        "SELECT workspacePath, COUNT(*) AS c FROM MemoryNote WHERE workspacePath IS NOT NULL AND workspacePath <> '' GROUP BY workspacePath"
      );
      if (!noteWs.error) {
        unmatched = 0;
        notesWithRepoKey = 0;
        for (const row of noteWs.rows) {
          notesWithRepoKey += num(row.c);
          if (!known.has(String(row.workspacePath))) unmatched += num(row.c);
        }
      }
    }
    push(
      measured(
        21,
        "distinct `OrchestratorChat.workspacePath` in ONE ledger",
        String(distinct) +
          (hasNoteWorkspace
            ? `  (notes with a repoKey: ${notesWithRepoKey ?? "?"}, unmatched: ${unmatched ?? "?"})`
            : "  (note-side repoKey column absent)"),
        { distinctChatWorkspaces: distinct, hasNoteWorkspaceColumn: hasNoteWorkspace, notesWithRepoKey, notesWithUnmatchedRepoKey: unmatched },
        "6",
        unmatched === null
          ? alarmOf(
              NA,
              "notes with a `repoKey` that no chat's workspace matches",
              hasNoteWorkspace
                ? "could not read MemoryNote.workspacePath"
                : "ADR-0026's `MemoryNote.workspacePath` (§1.2's `repoKey`) does not exist on this ledger — migration 0041_memory_note_workspace has not been applied to this data dir, so no note carries a repoKey to check. A 0 here would claim the partition exists and is clean."
            )
          : alarmWhen(unmatched > 0, "notes with a `repoKey` that no chat's workspace matches")
      )
    );
  }

  // ── Row 22. orphans — the coordinate layer's debt ─────────────────────────
  const tracked = trackedFiles(repoRoot);
  report.repo.read = true;
  report.repo.trackedFiles = tracked.exact ? tracked.exact.size : null;
  report.repo.error = tracked.error;
  if (!pathShapedTokens || !tracked.byLower) {
    push(
      unavailable(
        22,
        "orphans: active notes naming a tracked repo file with no module anchor",
        "63",
        pathShapedTokens
          ? `git ls-files failed for ${tildify(repoRoot)}: ${tracked.error}`
          : extractError,
        "stays flat after D15"
      )
    );
  } else {
    const orphanRows = safeAll(
      db,
      `SELECT n.id AS id, n.text AS text
         FROM MemoryNote n
        WHERE n.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM MemoryAnchor a WHERE a.noteId = n.id AND a.kind = 'module')`
    );
    if (orphanRows.error) {
      push(
        unavailable(
          22,
          "orphans: active notes naming a tracked repo file with no module anchor",
          "63",
          orphanRows.error,
          "stays flat after D15"
        )
      );
    } else {
      let orphans = 0;
      let caseOnly = 0;
      const examples = [];
      for (const row of orphanRows.rows) {
        // Note text is read HERE and nowhere else, and only path tokens leave.
        const tokens = pathTokens(
          pathShapedTokens,
          typeof row.text === "string" ? row.text : ""
        );
        let hit = null;
        let hitCaseOnly = false;
        for (const token of tokens) {
          const canonical = tracked.byLower.get(token.key);
          if (canonical === undefined) continue;
          hit = canonical;
          // The case assertion (§1.3, and the D1-resolver mutation row): a token
          // that matches only case-insensitively would be ACCEPTED by an APFS
          // stat and is exactly the error this row exists to find. Never stat.
          hitCaseOnly = !tracked.exact.has(token.surface);
          if (!hitCaseOnly) break;
        }
        if (hit === null) continue;
        orphans += 1;
        if (hitCaseOnly) caseOnly += 1;
        if (examples.length < MAX_EXAMPLES) {
          // COORDINATES ONLY: the note id and the tracked path it names.
          examples.push({ noteId: String(row.id), trackedPath: hit, caseMismatchOnly: hitCaseOnly });
        }
      }
      push(
        measured(
          22,
          "orphans: active notes naming a tracked repo file with no module anchor",
          `${orphans}` + (caseOnly > 0 ? `  (${caseOnly} match only case-insensitively)` : ""),
          {
            orphans,
            candidates: orphanRows.rows.length,
            caseMismatchOnly: caseOnly,
            repoTrackedFiles: tracked.exact.size,
            examples,
          },
          "63",
          // NO LONGER `pending`: D15 has landed in this tree, so "stays flat after
          // D15" is a live predicate rather than one waiting on a decision. What it
          // cannot distinguish is a promoter that is not firing from a one-shot
          // backfill nobody has run yet, so the detail names both.
          alarmWhen(
            orphans >= 63,
            "stays flat after D15",
            orphans >= 63
              ? `${orphans} active notes name a tracked file and carry no module anchor. D15's ingest promotion only helps notes written from now on; the pre-existing debt is drained by \`npm run backfill:anchors\` (dry run by default, then --apply, then restart MUON so the boot projector republishes the mirror). If this row is still here AFTER that, promotion itself is not firing — check row 4, and check that these notes carry a workspace at all (no workspace → NULL tracked set → nothing is ever promoted, by design).`
              : null
          )
        )
      );
      if (caseOnly > 0) {
        report.warnings.push(
          `row 22: ${caseOnly} orphan(s) name a tracked file that matches only case-insensitively. On APFS a filesystem \`stat\` would ACCEPT these, which is precisely the D1-resolver defect §1.3 requires this row to catch. The comparison here is against \`git ls-files\`, never a stat.`
        );
      }
    }
  }

  // ── Row 23. ledger ↔ mirror divergence. §1.3's queries, verbatim. ─────────
  const div23a = await cypher(
    `MATCH (n:MemoryNote) WHERE size(n.modules) > 0
  AND NOT EXISTS { MATCH (n)-[:ANCHORED_TO]->(:Module) }
RETURN count(*) AS c`
  );
  const div23b = await cypher(
    `MATCH (n:MemoryNote)-[:ANCHORED_TO]->(m:Module)
WHERE NOT list_contains(n.modules, m.path)
RETURN count(*) AS c`
  );
  if (!div23a.rows || !div23b.rows) {
    push(
      unavailable(
        23,
        "divergence: `modules[]` with no `ANCHORED_TO`; `ANCHORED_TO` not in `modules[]`",
        "0 / 0",
        div23a.error ?? div23b.error ?? mirrorWhy,
        "either non-zero — §5.8"
      )
    );
  } else {
    const a = num(div23a.rows[0]?.c);
    const b = num(div23b.rows[0]?.c);
    push(
      measured(
        23,
        "divergence: `modules[]` with no `ANCHORED_TO`; `ANCHORED_TO` not in `modules[]`",
        `${a} / ${b}`,
        { arrayWithoutEdge: a, edgeWithoutArrayEntry: b },
        "0 / 0",
        alarmWhen(
          a > 0 || b > 0,
          "either non-zero — §5.8",
          a > 0 || b > 0
            ? "the ledger and the mirror disagree about anchors. Today recall reads `n.modules` so a dropped edge is invisible; under D6-B it is a lost memory."
            : null
        )
      )
    );
  }

  // ── Row 24. the BM25 index ────────────────────────────────────────────────
  const indexes = await cypher("CALL SHOW_INDEXES() RETURN *");
  if (!indexes.rows) {
    push(
      unavailable(
        24,
        "FTS index present (`CALL SHOW_INDEXES()`)",
        "`memory_note_fts` on `MemoryNote(text)`",
        indexes.error ?? mirrorWhy,
        "absent"
      )
    );
  } else {
    const fts = indexes.rows.find(
      (row) => String(row.index_name ?? "") === "memory_note_fts"
    );
    const properties = fts
      ? (Array.isArray(fts.property_names) ? fts.property_names : [fts.property_names]).map(String)
      : [];
    const onText = fts !== undefined && String(fts.table_name ?? "") === "MemoryNote" && properties.includes("text");
    push(
      measured(
        24,
        "FTS index present (`CALL SHOW_INDEXES()`)",
        onText
          ? `memory_note_fts on MemoryNote(${properties.join(", ")})`
          : fts
            ? `memory_note_fts present but on ${fts.table_name}(${properties.join(", ")})`
            : "ABSENT",
        {
          present: fts !== undefined,
          onMemoryNoteText: onText,
          extensionLoaded: fts ? Boolean(fts.extension_loaded) : null,
          indexes: indexes.rows.map((row) => ({
            table: String(row.table_name ?? ""),
            name: String(row.index_name ?? ""),
            type: String(row.index_type ?? ""),
          })),
        },
        "`memory_note_fts` on `MemoryNote(text)`",
        alarmWhen(
          !onText,
          "absent",
          !onText
            ? "the BM25 arm answers nothing without this index, and `tryEnableFts` degrades SILENTLY (§6, the shipped mutation target)."
            : null
        )
      )
    );
  }

  // ── Row 25. D14 gate-read coverage over time ──────────────────────────────
  //
  // D14 shipped the coverage OUTPUT and, later, its PRODUCER: every pre-edit gate
  // read now files a `memory.gate_read` Event carrying counts plus the closed
  // `emptyReason` enum (absent when the read was not empty). So this row is a
  // count at last — but only once traffic exists. On a brain that has served no
  // gate reads it stays NOT PRODUCED, because 0 would say "we looked and found no
  // empty reads" when the truth is "nothing has been asked yet".
  //
  // KEYED ON `kind`, NOT on the metadata text. The earlier version matched
  // `metadata LIKE '%emptyReason%'`, which can only ever see the EMPTY reads —
  // making the denominator invisible and the "dominating" alarm unevaluable
  // against anything. The producer records every read precisely so this row can
  // divide by something real.
  const persistedReasons = safeAll(
    db,
    "SELECT kind, COUNT(*) AS c FROM Event WHERE kind = 'memory.gate_read' GROUP BY kind"
  );
  const persistedCount = persistedReasons.error
    ? 0
    : persistedReasons.rows.reduce((acc, row) => acc + num(row.c), 0);
  if (persistedCount === 0) {
    push(
      notProduced(
        25,
        `gate reads in the last ${options.days} days by empty-reason enum`,
        "n/a",
        "The producer exists (`recordGateRead` files a `memory.gate_read` Event per pre-edit read), but this brain has served none yet, so there is nothing to count. The shipped enum is {no_anchors, no_notes_on_anchors, withheld_no_crew_chat, withheld_by_gate, withheld_agent_projection, index_unavailable} — §1.2 names `no_anchors_resolved`, which predates the landed enum and corresponds to `no_anchors` / `no_notes_on_anchors`.",
        "`no_anchors_resolved` dominating (shipped enum: `no_anchors` / `no_notes_on_anchors`)"
      )
    );
  } else {
    const now = Date.now();
    const cutoff = now - options.days * 24 * 60 * 60 * 1000;
    const rows = safeAll(
      db,
      "SELECT metadata, timestamp FROM Event WHERE kind = 'memory.gate_read'"
    );
    const byReason = {};
    // TWO counters, because they answer two different questions: how many gate
    // reads happened at all, and how many came back empty. The alarm below is a
    // share OF THE EMPTY ONES; `totalReads` is what makes that share meaningful
    // rather than a bare tally.
    let totalReads = 0;
    let inWindow = 0;
    for (const row of rows.rows) {
      const ms = toMillis(row.timestamp);
      if (ms === null || ms < cutoff) continue;
      totalReads += 1;
      let reason = null;
      try {
        const text = Buffer.isBuffer(row.metadata) ? row.metadata.toString("utf8") : String(row.metadata);
        const match = /"emptyReason"\s*:\s*"([a-z_]+)"/.exec(text);
        if (match) reason = match[1];
      } catch {
        reason = "(unparsed)";
      }
      // No `emptyReason` = the read SURFACED something. Absence is the signal, so
      // it is counted as a successful read rather than bucketed under a made-up
      // enum member that row 25 would then group by.
      if (reason === null) continue;
      inWindow += 1;
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
    const noAnchors = (byReason.no_anchors ?? 0) + (byReason.no_notes_on_anchors ?? 0);
    push(
      measured(
        25,
        `gate reads in the last ${options.days} days by empty-reason enum`,
        `${totalReads} read(s), ${inWindow} empty` +
          (inWindow > 0
            ? `: ${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(", ")}`
            : ""),
        {
          windowDays: options.days,
          gateReads: totalReads,
          gateReadsWithEmptyReason: inWindow,
          byReason,
        },
        "n/a",
        alarmWhen(
          inWindow > 0 && noAnchors > inWindow / 2,
          "`no_anchors_resolved` dominating (shipped enum: `no_anchors` / `no_notes_on_anchors`)",
          inWindow > 0 && noAnchors > inWindow / 2
            ? `${noAnchors} of ${inWindow} empty gate reads are "the coordinate layer had nothing", not "the gate refused" — the §0 hole, measured on live traffic.`
            : null
        )
      )
    );
  }

  // ── Row 26. active human-confirmed notes by kind × workspace (TODO 0.3) ───
  //
  // The STANDING-ARM sizing row. TODO 4.1 attaches human-confirmed `constraint`
  // + `convention` notes to every brief in the workspace regardless of anchors,
  // so its day-one payload is exactly this row's constraint+convention count —
  // and its per-workspace spread decides whether one repository's canon would
  // flood another's briefs if the workspace term were ever dropped.
  //
  // Same human-latest predicate as row 5 (the LATEST human Confirmation wins,
  // `memoryGateTier`'s rule), WITHOUT the module-anchor join: standing memory
  // needs no anchor, which is the whole point of the arm.
  //
  // PRIVACY, row 21's discipline: a workspacePath is an absolute path carrying
  // the operator's username and private repo names, so paths are NEVER emitted.
  // Workspaces are reported as ordinals (`w1`, `w2`, …) ordered by note count
  // desc (ties by an internal sort the output does not disclose), plus a
  // `(none)` bucket for pre-0041 rows whose column is NULL/''.
  const HUMAN_LATEST_CTE = `WITH human_latest AS (
  SELECT c.noteId, c.decision FROM Confirmation c
  WHERE c.principal LIKE 'human%'
    AND c.at = (SELECT MAX(c2.at) FROM Confirmation c2
                WHERE c2.noteId = c.noteId AND c2.principal LIKE 'human%')
)`;
  const confirmedByKind = safeAll(
    db,
    `${HUMAN_LATEST_CTE}
SELECT n.kind AS kind, COUNT(DISTINCT n.id) AS c FROM MemoryNote n
WHERE n.status = 'active'
  AND n.id IN (SELECT noteId FROM human_latest WHERE decision = 'confirm')
GROUP BY n.kind`
  );
  const ROW26_BASELINE =
    "54 — convention 27, constraint 11, question 6, attempt 5, decision 5; standing arm 38 (2026-07-31)";
  const ROW26_ALARM = "standing-arm payload (constraint + convention) drops";
  if (confirmedByKind.error) {
    push(
      unavailable(
        26,
        "active human-confirmed notes by kind × workspace",
        ROW26_BASELINE,
        confirmedByKind.error,
        ROW26_ALARM
      )
    );
  } else {
    const byKind = {};
    let confirmedActive = 0;
    for (const row of confirmedByKind.rows) {
      byKind[String(row.kind)] = num(row.c);
      confirmedActive += num(row.c);
    }
    // TODO 4.1's payload: the two standing kinds, by definition, not by rank —
    // `KIND_PRIORITY` (preedit.ts) rates `decision` HIGHER and is a display
    // nudge inside one gate read; the standing arm is its own selection.
    const standingArmPayload = (byKind.constraint ?? 0) + (byKind.convention ?? 0);

    // The workspace half exists only after migration 0041 put the column on
    // THIS ledger (`noteColumns` was probed once, top of collectRows). Absent
    // column ⇒ the half is structurally unmeasurable and the row goes PARTIAL
    // with the reason named — never a silent all-in-one-workspace claim.
    let workspaces = null;
    let workspaceError = null;
    if (noteColumns?.has("workspacePath")) {
      const perWorkspace = safeAll(
        db,
        `${HUMAN_LATEST_CTE}
SELECT COALESCE(NULLIF(n.workspacePath, ''), '(none)') AS ws, n.kind AS kind,
       COUNT(DISTINCT n.id) AS c
FROM MemoryNote n
WHERE n.status = 'active'
  AND n.id IN (SELECT noteId FROM human_latest WHERE decision = 'confirm')
GROUP BY ws, n.kind`
      );
      if (perWorkspace.error) {
        workspaceError = perWorkspace.error;
      } else {
        const byWs = new Map();
        for (const row of perWorkspace.rows) {
          const ws = String(row.ws);
          if (!byWs.has(ws)) byWs.set(ws, { total: 0, byKind: {} });
          const entry = byWs.get(ws);
          entry.byKind[String(row.kind)] = num(row.c);
          entry.total += num(row.c);
        }
        // Ordinals by size; the real key order is dropped on purpose. `(none)`
        // keeps its name — it is a bucket, not a workspace — and does not
        // consume an ordinal.
        let ordinal = 0;
        workspaces = [...byWs.entries()]
          .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
          .map(([ws, entry]) => ({
            workspace: ws === "(none)" ? "(none)" : `w${(ordinal += 1)}`,
            total: entry.total,
            byKind: entry.byKind,
            standingArm: (entry.byKind.constraint ?? 0) + (entry.byKind.convention ?? 0),
          }));
      }
    }
    const kindDisplay =
      Object.entries(byKind)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([kind, count]) => `${kind} ${count}`)
        .join(", ") || "0";
    const workspaceDisplay =
      workspaces === null
        ? noteColumns?.has("workspacePath")
          ? `(workspace half unavailable: ${workspaceError})`
          : "(workspace column absent — migration 0041 not applied here)"
        : `across ${workspaces.length} workspace bucket(s): ${workspaces
            .map((entry) => `${entry.workspace} ${entry.total} (standing ${entry.standingArm})`)
            .join(", ")}`;
    push(
      measured(
        26,
        "active human-confirmed notes by kind × workspace",
        `${confirmedActive} — ${kindDisplay}; standing arm ${standingArmPayload}  ${workspaceDisplay}`,
        {
          confirmedActive,
          byKind,
          standingArmPayload,
          hasWorkspaceColumn: noteColumns?.has("workspacePath") ?? false,
          workspaces,
        },
        ROW26_BASELINE,
        alarmWhen(
          standingArmPayload < 38,
          ROW26_ALARM,
          standingArmPayload < 38
            ? `constraint + convention fell to ${standingArmPayload} against the 2026-07-31 measure of 38 — TODO 4.1's day-one payload is shrinking (or this is not the founder's data dir, in which case diff against this install's own previous run).`
            : null
        ),
        workspaces === null
      )
    );
  }

  // ── Row 27. exact context delivery + exposure integrity ─────────────────
  const frameColumns = ledgerColumns(db, "ContextFrame");
  if (!frameColumns?.has("contentSha256")) {
    push(
      notProduced(
        27,
        "context frames / delivery receipts / prompt exposures",
        "migration 0048 introduced the producer on 2026-08-01",
        "ContextFrame is absent — migration 0048 has not reached this ledger.",
        "a terminal job has a frame with no receipt; a delivery/exposure is orphaned; or included=true while eligible=false"
      )
    );
  } else {
    const counts = safeAll(
      db,
      `SELECT
  (SELECT COUNT(*) FROM ContextFrame) AS frames,
  (SELECT COUNT(*) FROM ContextFrameDelivery WHERE status = 'delivered') AS delivered,
  (SELECT COUNT(*) FROM ContextFrameDelivery WHERE status = 'failed') AS failed,
  (SELECT COUNT(*) FROM ContextFrame f
     LEFT JOIN ContextFrameDelivery d ON d.frameId = f.id
     WHERE d.id IS NULL) AS queued,
  (SELECT COUNT(*) FROM ContextFrame f
     JOIN DispatchJob j ON j.id = f.jobId
     LEFT JOIN ContextFrameDelivery d ON d.frameId = f.id
     WHERE d.id IS NULL AND j.status IN ('done','failed','interrupted')) AS terminalQueued,
  (SELECT COUNT(*) FROM ContextExposure WHERE included = 1) AS included,
  (SELECT COUNT(*) FROM ContextExposure WHERE eligible = 1 AND included = 0) AS eligibleOmitted,
  (SELECT COUNT(*) FROM ContextExposure WHERE included = 1 AND eligible = 0) AS invalidIncluded,
  (SELECT COUNT(*) FROM ContextFrameDelivery d
     LEFT JOIN ContextFrame f ON f.id = d.frameId WHERE f.id IS NULL) AS orphanDeliveries,
  (SELECT COUNT(*) FROM ContextExposure e
     LEFT JOIN ContextFrame f ON f.id = e.frameId WHERE f.id IS NULL) AS orphanExposures`
    );
    if (counts.error || !counts.rows[0]) {
      push(
        unavailable(
          27,
          "context frames / delivery receipts / prompt exposures",
          "migration 0048 introduced the producer on 2026-08-01",
          counts.error ?? "context evidence aggregate returned no row",
          "a terminal job has a frame with no receipt; a delivery/exposure is orphaned; or included=true while eligible=false"
        )
      );
    } else {
      const row = Object.fromEntries(
        Object.entries(counts.rows[0]).map(([key, value]) => [key, num(value)])
      );
      const integrityFailures =
        row.terminalQueued + row.invalidIncluded + row.orphanDeliveries + row.orphanExposures;
      push(
        measured(
          27,
          "context frames / delivery receipts / prompt exposures",
          `${row.frames} frame(s): ${row.delivered} delivered, ${row.failed} failed, ${row.queued} outcome unknown (${row.terminalQueued} terminal); ${row.included} included exposure(s), ${row.eligibleOmitted} eligible omitted`,
          row,
          "new producer — establish a per-install volume baseline after first dispatches",
          alarmWhen(
            integrityFailures > 0,
            "a terminal job has a frame with no receipt; a delivery/exposure is orphaned; or included=true while eligible=false",
            integrityFailures > 0
              ? `${integrityFailures} context delivery integrity failure(s): terminal queued ${row.terminalQueued}, invalid included ${row.invalidIncluded}, orphan deliveries ${row.orphanDeliveries}, orphan exposures ${row.orphanExposures}.`
              : null
          )
        )
      );
    }
  }

  // ── Row 28. condensation replay honesty ─────────────────────────────────
  const condensationColumns = ledgerColumns(db, "ContextCondensation");
  if (!condensationColumns?.has("sourceResponseId")) {
    push(
      notProduced(
        28,
        "context condensations / vendor knowledge gaps",
        "migration 0048 introduced the producer on 2026-08-01",
        "ContextCondensation is absent — migration 0048 has not reached this ledger.",
        "a vendor marker claims a summary/member; a MUON condensation lacks exact replay fields; or a frame reference is orphaned"
      )
    );
  } else {
    const counts = safeAll(
      db,
      `SELECT
  (SELECT COUNT(*) FROM ContextCondensation) AS total,
  (SELECT COUNT(*) FROM ContextCondensation WHERE origin = 'vendor_reported') AS vendorGaps,
  (SELECT COUNT(*) FROM ContextCondensation WHERE origin = 'muon') AS muon,
  (SELECT COUNT(*) FROM ContextCondensation c
     WHERE c.origin = 'vendor_reported' AND
       (c.summary IS NOT NULL OR EXISTS (
         SELECT 1 FROM ContextCondensationMember m WHERE m.condensationId = c.id
       ))) AS vendorInvented,
  (SELECT COUNT(*) FROM ContextCondensation c
     WHERE c.origin = 'muon' AND
       (c.summary IS NULL OR c.summaryOffset IS NULL OR c.inputFrameId IS NULL OR c.outputFrameId IS NULL OR
        c.inputFrameId = c.outputFrameId OR NOT EXISTS (
         SELECT 1 FROM ContextCondensationMember m WHERE m.condensationId = c.id
       ) OR NOT EXISTS (
         SELECT 1 FROM ContextFrame f
         WHERE f.id = c.outputFrameId
           AND substr(
             CAST(f.content AS BLOB),
             c.summaryOffset + 1,
             length(CAST(c.summary AS BLOB))
           ) = CAST(c.summary AS BLOB)
       ))) AS muonIncomplete,
  (SELECT COUNT(*) FROM ContextCondensation
     WHERE origin NOT IN ('muon', 'vendor_reported')) AS invalidOrigins,
  (SELECT COUNT(*) FROM ContextCondensation c
     LEFT JOIN ContextFrame f ON f.id = c.inputFrameId
     WHERE c.inputFrameId IS NOT NULL AND f.id IS NULL) +
  (SELECT COUNT(*) FROM ContextCondensation c
     LEFT JOIN ContextFrame f ON f.id = c.outputFrameId
     WHERE c.outputFrameId IS NOT NULL AND f.id IS NULL) AS orphanFrames,
  (SELECT COUNT(*) FROM ContextCondensationMember m
     LEFT JOIN ContextCondensation c ON c.id = m.condensationId WHERE c.id IS NULL) AS orphanMembers`
    );
    if (counts.error || !counts.rows[0]) {
      push(
        unavailable(
          28,
          "context condensations / vendor knowledge gaps",
          "migration 0048 introduced the producer on 2026-08-01",
          counts.error ?? "context condensation aggregate returned no row",
          "a vendor marker claims a summary/member; a MUON condensation lacks exact replay fields; or a frame reference is orphaned"
        )
      );
    } else {
      const row = Object.fromEntries(
        Object.entries(counts.rows[0]).map(([key, value]) => [key, num(value)])
      );
      const integrityFailures =
        row.vendorInvented + row.muonIncomplete + row.invalidOrigins + row.orphanFrames + row.orphanMembers;
      push(
        measured(
          28,
          "context condensations / vendor knowledge gaps",
          `${row.total} condensation(s): ${row.muon} MUON replayable, ${row.vendorGaps} vendor knowledge gap(s)`,
          row,
          "new producer — vendor-reported rows intentionally carry no summary or members",
          alarmWhen(
            integrityFailures > 0,
            "a vendor marker claims a summary/member; a MUON condensation lacks exact replay fields; or a frame reference is orphaned",
            integrityFailures > 0
              ? `${integrityFailures} condensation integrity failure(s): vendor invented ${row.vendorInvented}, MUON incomplete ${row.muonIncomplete}, invalid origin ${row.invalidOrigins}, orphan frame refs ${row.orphanFrames}, orphan members ${row.orphanMembers}.`
              : null
          )
        )
      );
    }
  }
}

function summarize(rows) {
  const summary = {
    rows: rows.length,
    measured: 0,
    partial: 0,
    notProduced: 0,
    unavailable: 0,
    alarms: 0,
    pending: 0,
    alarmRows: [],
    pendingRows: [],
    partialRows: [],
    notProducedRows: [],
    unavailableRows: [],
  };
  for (const row of rows) {
    if (row.status === "measured") summary.measured += 1;
    else if (row.status === "partial") {
      summary.partial += 1;
      summary.partialRows.push(row.n);
    } else if (row.status === "not-produced") {
      summary.notProduced += 1;
      summary.notProducedRows.push(row.n);
    } else {
      summary.unavailable += 1;
      summary.unavailableRows.push(row.n);
    }
    if (row.alarm.state === ALARM) {
      summary.alarms += 1;
      summary.alarmRows.push(row.n);
    } else if (row.alarm.state === PENDING) {
      summary.pending += 1;
      summary.pendingRows.push(row.n);
    }
  }
  return summary;
}

// ── rendering ────────────────────────────────────────────────────────────────

function pad(value, width) {
  const text = value === null || value === undefined ? "—" : String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Greedy word wrap. Returns plain lines; the caller owns the indent, so a
 *  continuation line is never double-indented. */
function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/** `label` on the first line, the wrapped body aligned under it on the rest. */
function field(label, text, width = 92) {
  const head = `      ${pad(label, 10)}`;
  const gutter = " ".repeat(head.length);
  return wrap(text, width).map((line, index) => `${index === 0 ? head : gutter}${line}`);
}

const ALARM_LABEL = {
  [OK]: "no",
  [ALARM]: "*** ALARM ***",
  [PENDING]: "pending",
  [NA]: "n/a",
};

const STATUS_LABEL = {
  measured: "",
  partial: "  [PARTIALLY UNAVAILABLE]",
  "not-produced": "  [NOT YET PRODUCED]",
  unavailable: "  [UNAVAILABLE]",
};

function render(report) {
  const out = [];
  const line = (text = "") => out.push(text);

  line(`MUON memory-index health · ${report.generatedAt}`);
  line(`docs/design/memory-index-validation.md §1.2 · baseline ${report.baselineDate}`);
  line();
  line("READ-ONLY: both stores are opened readOnly and left byte-identical. (A WAL ledger");
  line("with no -shm/-wal sidecar gets them created beside it — a new file, not a change.)");
  line("COUNTS AND COORDINATES ONLY — no note text is emitted; safe to paste into an issue.");
  line();

  line("STORES");
  line(`  data dir      ${report.dataDir}  [${report.dataDirSource}]`);
  line(
    `  ledger        ${report.ledger.path}  ${
      report.ledger.exists ? formatBytes(report.ledger.bytes) : "(absent)"
    }`
  );
  line(
    `  mirror        ${report.mirror.path}  ${
      report.mirror.exists ? formatBytes(report.mirror.bytes) : "(absent)"
    }  → ${report.mirror.opened ? "opened read-only" : `NOT OPENED (${report.mirror.error})`}`
  );
  if (report.mirrorWal.exists) {
    line(`  mirror wal    ${formatBytes(report.mirrorWal.bytes)} unreplayed (read-only open leaves it byte-identical)`);
  }
  line(
    `  repo (row 22) ${report.repo.root}  ${
      !report.repo.read
        ? "(not read — row 22 never ran)"
        : report.repo.trackedFiles === null
          ? `(git ls-files unavailable: ${report.repo.error})`
          : `${report.repo.trackedFiles} tracked files`
    }`
  );
  line();

  line("ROWS  (measured · baseline · alarm)");
  line();
  for (const row of report.rows) {
    line(`${pad(row.n, 4)}${row.label}${STATUS_LABEL[row.status] ?? ""}`);
    for (const text of field("measured", row.measured)) line(text);
    for (const text of field("baseline", row.baseline)) line(text);
    for (const text of field("alarm", `${ALARM_LABEL[row.alarm.state]} — ${row.alarm.condition}`)) {
      line(text);
    }
    if (row.alarm.detail) {
      for (const text of field("", row.alarm.detail, 88)) line(text);
    }
    if (row.why && row.alarm.detail !== row.why) {
      for (const text of field("", row.why, 88)) line(text);
    }
    line();
  }

  // Row 19's full table and row 22's examples: coordinates only, printed after
  // the rows so the grid stays readable.
  const row19 = report.rows.find((row) => row.n === 19);
  if (row19?.values?.top?.length) {
    line(`ROW 19 · entity document frequency (threshold ${row19.values.thresholdDf} = ${ENTITY_DF_SHARE_ALARM * 100}% of ${row19.values.activeNotes} active notes)`);
    line("  keys that could be a fragment of note prose (`term` / `quoted` / any multi-word key)");
    line("  are WITHHELD as <kind len=N>. Their FREQUENCY is reported either way, so the alarm is unaffected.");
    for (const entry of row19.values.top) {
      line(
        `  ${pad(entry.df, 5)}${entry.overThreshold ? "! " : "  "}${entry.key}${
          entry.withheld ? "" : `   [${entry.kind}]`
        }`
      );
    }
    line();
  }
  const row22 = report.rows.find((row) => row.n === 22);
  if (row22?.values?.examples?.length) {
    line(
      `ROW 22 · orphan examples (${row22.values.examples.length} of ${row22.values.orphans}) — note id + the tracked path it names, never its text`
    );
    for (const entry of row22.values.examples) {
      line(
        `  ${entry.noteId}  ${entry.trackedPath}${
          entry.caseMismatchOnly ? "   [CASE MISMATCH — a filesystem stat would accept this]" : ""
        }`
      );
    }
    line();
  }

  const summary = report.summary;
  if (summary) {
    line("SUMMARY");
    line(
      `  ${summary.rows} rows · ${summary.measured} measured · ${summary.partial} partial · ${summary.notProduced} not yet produced · ${summary.unavailable} unavailable`
    );
    line(
      `  alarms HOLDING: ${
        summary.alarmRows.length === 0 ? "none" : summary.alarmRows.map((n) => `row ${n}`).join(", ")
      }`
    );
    if (summary.pendingRows.length > 0) {
      line(
        `  pending (predicate true, conditional on an unlanded decision): ${summary.pendingRows
          .map((n) => `row ${n}`)
          .join(", ")}`
      );
    }
    if (summary.partialRows.length > 0) {
      line(`  partially unavailable: ${summary.partialRows.map((n) => `row ${n}`).join(", ")}`);
    }
    if (summary.notProducedRows.length > 0) {
      line(`  not yet produced: ${summary.notProducedRows.map((n) => `row ${n}`).join(", ")}`);
    }
    if (summary.unavailableRows.length > 0) {
      line(`  unavailable: ${summary.unavailableRows.map((n) => `row ${n}`).join(", ")}`);
    }
  }

  if (report.warnings.length > 0) {
    line();
    line("NOTES");
    for (const warning of report.warnings) {
      const lines = wrap(warning, 92);
      lines.forEach((text, index) => line(`  ${index === 0 ? "!" : " "} ${text}`));
    }
  }

  return out.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const report = await collect(options);
  console.log(options.json ? JSON.stringify(report, null, 2) : render(report));
  // A held alarm is a finding, not a harness failure: exit 0 so the report is
  // usable in a pipeline that also wants the JSON. Callers gate on
  // `summary.alarms`.
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(
      `[muon memory-index-health] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}

export {
  ALARM,
  NA,
  OK,
  PENDING,
  alarmOf,
  alarmPendingWhen,
  alarmWhen,
  classifyEntityKey,
  collect,
  entityKeyDisclosure,
  jsonArray,
  pathTokens,
  render,
  summarize,
  tildify,
};
