#!/usr/bin/env node
//
// `npm run debug:report` — one command that answers "what is this MUON install
// actually doing right now?" without a single hand-written sqlite3 query.
//
// It prints a triage snapshot of the LIVE data dir: where everything is, whether
// the brain and runner are up, the last N dispatch jobs, the newest job's
// terminal outcome and stream tail, ledger counts, and the tail of runner.log.
//
// Guarantees:
//   * READ-ONLY. The database is opened `readOnly`, which is safe against the
//     running brain's WAL — no write lock, no checkpoint, no mutation. Nothing
//     in this script writes to the data dir at all.
//   * NO SECRETS. Bearer tokens in brain.lock are reported as present/absent,
//     never printed. Every vendor/agent-authored string (job results, stream
//     chunks, runner.log) goes through @muon/core's `redactedTail`, THE shared
//     redaction control — and if that cannot be loaded the text is omitted
//     rather than printed raw (fail closed).
//
// Usage:
//   node scripts/debug-report.mjs [options]
//     --data-dir <path>   inspect this data dir (default: MUON_DATA_DIR, else
//                         the desktop's userData, else the CLI convention)
//     --jobs <n>          dispatch jobs to list (default 10)
//     --job <id>          detail this job instead of the newest (id or prefix)
//     --stream <n>        stream chunks to show for the detailed job (default 12)
//     --tail <n>          runner.log lines to show (default 25)
//     --json              machine-readable output
//     --help

import {
  fileFacts,
  formatAge,
  formatBytes,
  isProcessAlive,
  loadRedactedTail,
  logPaths,
  openReadOnlyDb,
  probeBrainHealth,
  readBrainLock,
  resolveDataDir,
  tailFile,
  toIso,
} from "./lib/muon-debug.mjs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

const RESULT_TAIL_CHARS = 1200;
const CHUNK_TAIL_CHARS = 400;
const LOG_TAIL_CHARS = 8000;
/** A runner whose heartbeat is older than this is not serving work. */
const RUNNER_STALE_MS = 30_000;

export function parseArgs(argv) {
  const options = {
    dataDir: null,
    jobs: 10,
    job: null,
    stream: 12,
    tail: 25,
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
      case "--job":
        options.job = value();
        break;
      case "--jobs":
        options.jobs = positiveInt(arg, value());
        break;
      case "--stream":
        options.stream = positiveInt(arg, value());
        break;
      case "--tail":
        options.tail = positiveInt(arg, value());
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

const HELP = `MUON debug report — read-only triage snapshot of the live data dir.

  node scripts/debug-report.mjs [--data-dir <path>] [--jobs <n>] [--job <id>]
                                [--stream <n>] [--tail <n>] [--json]

Never writes to the data dir, never opens the database for write, and never
prints a bearer token. Vendor-authored text is redacted through @muon/core.`;

/** Every query is individually guarded: one missing table must not kill the report. */
function safeQuery(db, sql, params = []) {
  try {
    return { rows: db.prepare(sql).all(...params), error: null };
  } catch (error) {
    return { rows: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function groupCounts(db, table, column = "status") {
  const { rows, error } = safeQuery(
    db,
    `SELECT ${column} AS bucket, COUNT(*) AS count FROM ${table} GROUP BY ${column}`
  );
  if (error) {
    return { total: null, buckets: {}, error };
  }
  const buckets = {};
  let total = 0;
  for (const row of rows) {
    const key = row.bucket === null ? "(null)" : String(row.bucket);
    const count = Number(row.count);
    buckets[key] = count;
    total += count;
  }
  return { total, buckets, error: null };
}

async function collect(options) {
  const resolved = options.dataDir
    ? { dir: options.dataDir, source: "--data-dir" }
    : resolveDataDir();
  const dataDir = resolved.dir;
  const dbPath = path.join(dataDir, "muon.db");
  const logs = logPaths(dataDir);

  const report = {
    generatedAt: new Date().toISOString(),
    dataDir,
    dataDirSource: resolved.source,
    dataDirExists: existsSync(dataDir),
    database: fileFacts(dbPath),
    graphDir: path.join(dataDir, "graph"),
    logs: {
      dir: logs.logDir,
      brain: fileFacts(logs.brain),
      brainRotated: fileFacts(`${logs.brain}.1`),
      runner: fileFacts(logs.runner),
      runnerRotated: fileFacts(`${logs.runner}.1`),
      desktop: fileFacts(logs.desktop),
    },
    brain: null,
    runners: { rows: [], error: null },
    jobs: { rows: [], error: null },
    detail: null,
    counts: {},
    runnerLogTail: null,
    warnings: [],
  };

  // --- redaction control: load first, fail closed if absent -----------------
  let redactedTail = null;
  try {
    redactedTail = await loadRedactedTail();
  } catch (error) {
    report.warnings.push(
      `${error instanceof Error ? error.message : String(error)} — vendor-authored text (job results, stream chunks, runner.log) is OMITTED from this report.`
    );
  }
  const redact = (text, max) =>
    redactedTail && typeof text === "string" ? redactedTail(text, max) : null;

  // --- brain ----------------------------------------------------------------
  const lock = readBrainLock(dataDir);
  if (lock) {
    report.brain = {
      ...lock,
      processAlive: isProcessAlive(lock.pid),
      healthy: await probeBrainHealth(lock.base),
    };
  }

  if (!report.database.exists) {
    report.warnings.push(
      `no database at ${dbPath} — MUON has not run against this data dir yet.`
    );
    return { report, redact };
  }

  // --- database (read-only) -------------------------------------------------
  let db;
  try {
    db = await openReadOnlyDb(dbPath);
  } catch (error) {
    report.warnings.push(
      `could not open the database read-only: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { report, redact };
  }

  try {
    const runners = safeQuery(
      db,
      "SELECT host, pid, status, lastSeenAt FROM Runner ORDER BY lastSeenAt DESC"
    );
    report.runners = {
      error: runners.error,
      rows: runners.rows.map((row) => {
        const lastSeenAt = toIso(row.lastSeenAt);
        const ageMs = lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() : null;
        return {
          host: row.host,
          pid: row.pid === null ? null : Number(row.pid),
          status: row.status,
          lastSeenAt,
          online:
            row.status === "online" && ageMs !== null && ageMs < RUNNER_STALE_MS,
        };
      }),
    };

    const jobs = safeQuery(
      db,
      `SELECT id, vendor, kind, status, role, capabilityMode, taskId, chatId, host,
              createdAt, startedAt, endedAt, exitCode
         FROM DispatchJob
        ORDER BY createdAt DESC
        LIMIT ?`,
      [Math.max(options.jobs, options.job ? 1 : 0)]
    );
    report.jobs = {
      error: jobs.error,
      rows: jobs.rows.map((row) => ({
        id: row.id,
        vendor: row.vendor,
        kind: row.kind,
        status: row.status,
        role: row.role,
        capabilityMode: row.capabilityMode,
        taskId: row.taskId,
        chatId: row.chatId,
        host: row.host,
        createdAt: toIso(row.createdAt),
        startedAt: toIso(row.startedAt),
        endedAt: toIso(row.endedAt),
        exitCode: row.exitCode === null ? null : Number(row.exitCode),
      })),
    };

    // --- the one job we explain in full -------------------------------------
    let target = null;
    if (options.job) {
      const match = safeQuery(
        db,
        `SELECT id, vendor, kind, status, role, capabilityMode, taskId, chatId, host,
                createdAt, startedAt, endedAt, exitCode, result
           FROM DispatchJob
          WHERE id = ? OR id LIKE ?
          ORDER BY createdAt DESC
          LIMIT 1`,
        [options.job, `${options.job}%`]
      );
      target = match.rows[0] ?? null;
      if (!target) {
        report.warnings.push(`no dispatch job matches "${options.job}".`);
      }
    } else if (report.jobs.rows.length > 0) {
      const newestId = report.jobs.rows[0].id;
      const match = safeQuery(
        db,
        `SELECT id, vendor, kind, status, role, capabilityMode, taskId, chatId, host,
                createdAt, startedAt, endedAt, exitCode, result
           FROM DispatchJob WHERE id = ?`,
        [newestId]
      );
      target = match.rows[0] ?? null;
    }

    if (target) {
      const total = safeQuery(
        db,
        "SELECT COUNT(*) AS count FROM StreamChunk WHERE runId = ?",
        [target.id]
      );
      const chunks = safeQuery(
        db,
        `SELECT seq, kind, content, timestamp
           FROM StreamChunk
          WHERE runId = ?
          ORDER BY seq DESC
          LIMIT ?`,
        [target.id, options.stream]
      );
      report.detail = {
        id: target.id,
        vendor: target.vendor,
        kind: target.kind,
        status: target.status,
        role: target.role,
        capabilityMode: target.capabilityMode,
        taskId: target.taskId,
        chatId: target.chatId,
        host: target.host,
        createdAt: toIso(target.createdAt),
        startedAt: toIso(target.startedAt),
        endedAt: toIso(target.endedAt),
        exitCode: target.exitCode === null ? null : Number(target.exitCode),
        // Vendor-authored: redacted, or withheld when no redactor is available.
        result: redact(target.result ?? "", RESULT_TAIL_CHARS),
        resultWithheld: Boolean(target.result) && redactedTail === null,
        streamTotal: total.rows[0] ? Number(total.rows[0].count) : null,
        streamError: chunks.error ?? total.error,
        stream: chunks.rows
          .slice()
          .reverse()
          .map((row) => ({
            seq: Number(row.seq),
            kind: row.kind,
            timestamp: toIso(row.timestamp),
            content: redact(row.content ?? "", CHUNK_TAIL_CHARS),
          })),
      };
    }

    report.counts = {
      chats: groupCounts(db, "OrchestratorChat"),
      tasks: groupCounts(db, "Task"),
      memoryNotes: groupCounts(db, "MemoryNote"),
      approvals: groupCounts(db, "ApprovalRequest"),
      dispatchJobs: groupCounts(db, "DispatchJob"),
    };
  } finally {
    db.close();
  }

  // --- runner.log tail ------------------------------------------------------
  const tail = tailFile(logs.runner, options.tail);
  if (tail) {
    const redacted = redact(tail.text, LOG_TAIL_CHARS);
    report.runnerLogTail = {
      truncated: tail.truncated,
      text: redacted,
      withheld: redacted === null && tail.text.length > 0,
    };
  }

  return { report, redact };
}

// ── rendering ────────────────────────────────────────────────────────────────

function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : "—";
}

function pad(value, width) {
  const text = value === null || value === undefined ? "—" : String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function fileLine(label, facts) {
  if (!facts.exists) {
    return `    ${pad(label, 14)} (absent)`;
  }
  return `    ${pad(label, 14)} ${pad(formatBytes(facts.bytes), 9)} ${
    facts.mtime
  } (${formatAge(facts.mtime)})`;
}

function render(report) {
  const out = [];
  const line = (text = "") => out.push(text);

  line(`MUON debug report · ${report.generatedAt}`);
  line();

  line("DATA");
  line(`  data dir      ${report.dataDir}  [${report.dataDirSource}]`);
  if (!report.dataDirExists) {
    line("                (does not exist yet)");
  }
  line(
    `  database      ${report.database.path}${
      report.database.exists ? `  ${formatBytes(report.database.bytes)}` : "  (absent)"
    }`
  );
  line(`  graph store   ${report.graphDir}`);
  line(`  logs          ${report.logs.dir}`);
  line(fileLine("brain.log", report.logs.brain));
  if (report.logs.brainRotated.exists) {
    line(fileLine("brain.log.1", report.logs.brainRotated));
  }
  line(fileLine("runner.log", report.logs.runner));
  if (report.logs.runnerRotated.exists) {
    line(fileLine("runner.log.1", report.logs.runnerRotated));
  }
  line(
    report.logs.desktop.exists
      ? fileLine("desktop.log", report.logs.desktop)
      : "    desktop.log    (absent — written by `npm run dev:desktop:debug`)"
  );
  line();

  line("BRAIN");
  if (!report.brain) {
    line("  no brain.lock — no embedded brain has published coordinates here.");
  } else {
    line(
      `  endpoint      ${report.brain.base}   port ${report.brain.port}  pid ${report.brain.pid}`
    );
    line(
      `  started       ${report.brain.startedAt ?? "unknown"} (${formatAge(
        report.brain.startedAt
      )})`
    );
    line(
      `  process       ${report.brain.processAlive ? "alive" : "NOT RUNNING (stale lockfile)"}`
    );
    line(`  health        GET /health → ${report.brain.healthy ? "ok" : "unreachable"}`);
    line(
      `  credentials   operator token ${
        report.brain.hasOperatorToken ? "present" : "absent"
      }, agent token ${
        report.brain.hasAgentToken ? "present" : "absent"
      } (values never printed)`
    );
  }
  line();

  line("RUNNER");
  if (report.runners.error) {
    line(`  unavailable: ${report.runners.error}`);
  } else if (report.runners.rows.length === 0) {
    line("  no runner has ever registered against this brain.");
  } else {
    for (const runner of report.runners.rows) {
      line(
        `  ${pad(runner.host, 22)} ${pad(runner.status, 9)} pid ${pad(
          runner.pid,
          7
        )} last seen ${pad(formatAge(runner.lastSeenAt), 10)} → ${
          runner.online ? "ONLINE" : "not serving work"
        }`
      );
    }
  }
  line();

  line(`DISPATCH JOBS (newest ${report.jobs.rows.length})`);
  if (report.jobs.error) {
    line(`  unavailable: ${report.jobs.error}`);
  } else if (report.jobs.rows.length === 0) {
    line("  none.");
  } else {
    line(
      `  ${pad("id", 9)}${pad("vendor", 13)}${pad("kind", 9)}${pad(
        "status",
        12
      )}${pad("role", 14)}${pad("capability", 14)}created`
    );
    for (const job of report.jobs.rows) {
      line(
        `  ${pad(shortId(job.id), 9)}${pad(job.vendor, 13)}${pad(
          job.kind,
          9
        )}${pad(job.status, 12)}${pad(job.role, 14)}${pad(
          job.capabilityMode,
          14
        )}${job.createdAt ?? "—"} (${formatAge(job.createdAt)})`
      );
    }
  }
  line();

  if (report.detail) {
    const detail = report.detail;
    line(`JOB ${detail.id}`);
    line(
      `  ${detail.vendor} · ${detail.kind} · status ${detail.status}${
        detail.exitCode === null ? "" : ` · exit ${detail.exitCode}`
      }${detail.role ? ` · role ${detail.role}` : ""}${
        detail.capabilityMode ? ` · capability ${detail.capabilityMode}` : ""
      }`
    );
    line(`  task ${detail.taskId ?? "—"}   chat ${detail.chatId ?? "—"}   host ${detail.host ?? "—"}`);
    line(
      `  created ${detail.createdAt ?? "—"}   started ${
        detail.startedAt ?? "—"
      }   ended ${detail.endedAt ?? "—"}`
    );
    line("  terminal result (redacted tail):");
    if (detail.resultWithheld) {
      line("    (withheld — no redactor available, see warnings)");
    } else if (!detail.result) {
      line("    (none recorded)");
    } else {
      for (const resultLine of detail.result.split("\n")) {
        line(`    ${resultLine}`);
      }
    }
    if (detail.streamError) {
      line(`  stream unavailable: ${detail.streamError}`);
    } else {
      line(
        `  stream tail (${detail.stream.length} of ${
          detail.streamTotal ?? "?"
        } chunks, redacted):`
      );
      if (detail.stream.length === 0) {
        line("    (no stream chunks for this job)");
      }
      for (const chunk of detail.stream) {
        const stamp = chunk.timestamp ? chunk.timestamp.slice(11, 19) : "--:--:--";
        const body =
          chunk.content === null
            ? "(withheld — no redactor available)"
            : chunk.content.split("\n").join(" ⏎ ");
        line(`    [${stamp} ${chunk.kind}] ${body}`);
      }
    }
    line();
  }

  line("COUNTS");
  for (const [label, value] of Object.entries(report.counts)) {
    if (value.error) {
      line(`  ${pad(label, 14)} unavailable: ${value.error}`);
      continue;
    }
    const buckets = Object.entries(value.buckets)
      .sort((left, right) => right[1] - left[1])
      .map(([bucket, count]) => `${bucket} ${count}`)
      .join(", ");
    line(`  ${pad(label, 14)} ${value.total}${buckets ? `  (${buckets})` : ""}`);
  }
  line();

  line("RUNNER LOG (tail)");
  if (!report.runnerLogTail) {
    line("  runner.log does not exist yet.");
  } else if (report.runnerLogTail.withheld) {
    line("  (withheld — no redactor available, see warnings)");
  } else if (!report.runnerLogTail.text) {
    line("  (empty)");
  } else {
    for (const logLine of report.runnerLogTail.text.split("\n")) {
      line(`  ${logLine}`);
    }
  }

  if (report.warnings.length > 0) {
    line();
    line("WARNINGS");
    for (const warning of report.warnings) {
      line(`  ! ${warning}`);
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
  const { report } = await collect(options);
  console.log(options.json ? JSON.stringify(report, null, 2) : render(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(
      `[muon debug-report] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}

export { collect, render };
