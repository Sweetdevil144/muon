import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitCommitsMatch } from "@muon/protocol";
import {
  GITNEXUS_STORE_DIR,
  readGitNexusIndexRebuild,
  type GitNexusIndexLockOwner,
} from "./gitnexus-index-lock.js";

const execFileAsync = promisify(execFile);

/** The meta file is a few KB in practice; anything past this bound is not a
 *  GitNexus meta and must not be read into memory on a dispatch path. */
const META_MAX_BYTES = 512 * 1024;

/**
 * A10 — dispatch-time index-freshness probe.
 *
 * The local GitNexus store writes `<repo>/.gitnexus/meta.json` on every
 * index pass with the commit it indexed (`lastCommit`), when (`indexedAt`),
 * and the graph's shape (`stats`). Reading that file is the cheapest honest
 * freshness signal MUON can put in a worker's brief: no CLI spawn, no store
 * open, one fs read. It deliberately reports THREE states, because "missing"
 * and "stale" demand different next actions and collapsing them into one
 * boolean is how a silent degrade gets trained into agents:
 *
 * - `fresh`   — the graph's indexed commit matches HEAD.
 * - `stale`   — both commits known and different: impact/review evidence
 *               computed from this graph is UNKNOWN risk, never implicit
 *               clear (`preflight_edit` refuses; `review_diff` goes
 *               review-blind — this probe is the brief-side echo of those
 *               fail-closed gates, not a new gate).
 * - `missing` — no readable meta: the repo was never indexed here, or the
 *               store is unreadable. Also unknown risk, said differently.
 *
 * This is an OBSERVATION for a brief, not an enforcement point — the
 * enforcement already exists server-side. Never make a dispatch fail on it.
 */
export type GitNexusIndexFreshness = {
  status: "fresh" | "stale" | "missing";
  /** Commit the local graph store last indexed, when known. */
  indexedCommit?: string;
  /** ISO timestamp of the last index pass, when known. */
  indexedAt?: string;
  /** The repository HEAD the caller compared against, when supplied. */
  headCommit?: string;
  /** Graph shape from the store's own meta, for a one-line brief summary. */
  stats?: {
    files?: number;
    nodes?: number;
    processes?: number;
  };
  /**
   * ADR-0054 — a MUON process is rebuilding this store RIGHT NOW.
   *
   * Present on EVERY status, `fresh` included, and that is the point: this
   * value is the one thing every surface reads to decide what to say about the
   * graph, and "the store is being rewritten as you read it" is a fact about
   * all three states, not just the bad two. It NEVER upgrades a status — a
   * stale index mid-rebuild is still stale — it only stops a surface from
   * claiming a settled answer while the store is in motion, and it changes the
   * one piece of ADVICE that was wrong mid-run: "refresh the index" becomes
   * "wait for the run MUON already started".
   *
   * Absent ⇒ no live rebuild (or the lock was unreadable — treated the same,
   * because an unprovable rebuild must not become a reason to wait).
   */
  rebuild?: {
    /** Which MUON surface started it. Omitted when the record names one this
     *  build does not recognise — see {@link asLockOwner}. */
    owner?: GitNexusIndexLockOwner;
    /** ISO start timestamp, when the record carried a plausible one. */
    startedAt?: string;
  };
};

// EVERY string leaving this module can end up inside a WORKER BRIEF (the
// stale-index TOOL GAP block and the institutional pack's graph line), and
// `.gitnexus/meta.json` is repo-resident — any process that ever wrote the
// repo owns its bytes. So the fields are not "strings from our own store",
// they are UNTRUSTED input to a prompt, and each one is validated against
// the narrow shape a real meta value has. A value that does not match is
// dropped, never clipped-and-kept: half an injected payload is still an
// injected payload.

/** A git commit id: hex only. Anything else is not a commit. */
function asCommit(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-fA-F]{6,64}$/.test(value)
    ? value
    : undefined;
}

/** An ISO-8601-shaped timestamp: digits and date punctuation only, bounded.
 *  A newline, a space, or a sentence can never pass this. */
function asTimestamp(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]?[0-9:.+Zz-]{0,24}$/.test(value)
    ? value
    : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * The lock file lives in the SAME repo-resident store dir as the meta, so its
 * `owner` is untrusted for exactly the same reason every field above is. It is
 * checked against the closed set of surfaces rather than passed through: the
 * value ends up in a worker brief sentence, and "an index run is already in
 * progress (<anything the repo wrote>)" is a free prompt line.
 *
 * An unrecognised owner drops the NAME, never the FACT — the rebuild is still
 * reported, just anonymously ("another MUON process"), because pid liveness is
 * what proved it and no string can un-prove that.
 */
const LOCK_OWNERS: readonly GitNexusIndexLockOwner[] = ["desktop", "mcp", "cli"];

function asLockOwner(value: unknown): GitNexusIndexLockOwner | undefined {
  return LOCK_OWNERS.includes(value as GitNexusIndexLockOwner)
    ? (value as GitNexusIndexLockOwner)
    : undefined;
}

/**
 * The live-rebuild fact, or undefined. Never throws and never blocks: one
 * bounded read of a tiny file in the store dir the meta was already read from,
 * plus a signal-0 liveness probe. A lock we cannot read is not a rebuild we can
 * assert, so it degrades to "no rebuild" — an unprovable run must not become a
 * reason for a surface to tell someone to wait.
 */
function readRebuild(repoRoot: string): GitNexusIndexFreshness["rebuild"] {
  let holder: ReturnType<typeof readGitNexusIndexRebuild>;
  try {
    holder = readGitNexusIndexRebuild(repoRoot);
  } catch {
    return undefined;
  }
  if (!holder) return undefined;
  const owner = asLockOwner(holder.owner);
  const startedAt = asTimestamp(holder.startedAt);
  return {
    ...(owner ? { owner } : {}),
    ...(startedAt ? { startedAt } : {}),
  };
}

/**
 * Read the local store's meta and classify freshness against `headCommit`.
 * Every failure path degrades to `missing` — this probe must never throw
 * into a dispatch.
 */
export async function readGitNexusIndexFreshness(input: {
  repoRoot: string;
  headCommit?: string;
}): Promise<GitNexusIndexFreshness> {
  const classified = await classifyStore(input);
  // Stamped on EVERY arm by construction rather than at each return site.
  // `classifyStore` has six of them, and an arm that forgot the stamp would be
  // a surface reporting a settled index while MUON rewrites the store
  // underneath it — a caveat that covers most states is not a caveat
  // (bounded-surface completeness).
  //
  // Read AFTER the meta, deliberately: a rebuild still live once the meta has
  // been read was certainly live while it was being read. Reading first would
  // let a run that finished in between be reported as in flight, which tells a
  // caller to wait for nothing.
  const rebuild = readRebuild(input.repoRoot);
  return rebuild ? { ...classified, rebuild } : classified;
}

async function classifyStore(input: {
  repoRoot: string;
  headCommit?: string;
}): Promise<GitNexusIndexFreshness> {
  const metaPath = join(input.repoRoot, GITNEXUS_STORE_DIR, "meta.json");
  let raw: string;
  try {
    // Size + regular-file check BEFORE the read: an attacker-sized meta must
    // not be read into memory on a dispatch path, and a FIFO at this path
    // would block `readFile` forever (the probe has no timeout of its own —
    // `stat` returns immediately for a FIFO and `isFile()` refuses it).
    const info = await stat(metaPath);
    if (!info.isFile() || info.size > META_MAX_BYTES) {
      return { status: "missing", headCommit: input.headCommit };
    }
    raw = await readFile(metaPath, "utf8");
  } catch {
    return { status: "missing", headCommit: input.headCommit };
  }
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch {
    return { status: "missing", headCommit: input.headCommit };
  }
  if (typeof meta !== "object" || meta === null) {
    return { status: "missing", headCommit: input.headCommit };
  }
  const record = meta as Record<string, unknown>;
  const indexedCommit = asCommit(record.lastCommit);
  const indexedAt = asTimestamp(record.indexedAt);
  const statsRecord =
    typeof record.stats === "object" && record.stats !== null
      ? (record.stats as Record<string, unknown>)
      : undefined;
  const stats = statsRecord
    ? {
        files: asCount(statsRecord.files),
        nodes: asCount(statsRecord.nodes),
        processes: asCount(statsRecord.processes),
      }
    : undefined;
  if (!indexedCommit) {
    return { status: "missing", indexedAt, headCommit: input.headCommit, stats };
  }
  if (!input.headCommit) {
    // An indexed store with an unverifiable HEAD is not provably fresh;
    // report the store facts and let the renderer say "unverified".
    return { status: "missing", indexedCommit, indexedAt, stats };
  }
  return {
    status: gitCommitsMatch(indexedCommit, input.headCommit)
      ? "fresh"
      : "stale",
    indexedCommit,
    indexedAt,
    headCommit: input.headCommit,
    stats,
  };
}

/**
 * Convenience probe for callers that hold only a repo root: resolves HEAD via
 * git itself (5s cap), then classifies. Every failure degrades to the fs-only
 * read with no head commit — never throws into a dispatch.
 */
export async function probeGitNexusIndexFreshness(
  repoRoot: string
): Promise<GitNexusIndexFreshness> {
  let headCommit: string | undefined;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: repoRoot, timeout: 5_000, maxBuffer: 64 * 1024 }
    );
    headCommit = stdout.trim() || undefined;
  } catch {
    headCommit = undefined;
  }
  return readGitNexusIndexFreshness({ repoRoot, headCommit });
}

/**
 * ADR-0054 — the remedy clause, chosen by whether MUON is ALREADY fixing it.
 *
 * The gap sentence used to end in "until the index is refreshed (an operator
 * action)" unconditionally, and that instruction is wrong for the whole several
 * minutes a rebuild takes: it points a worker at an act that is already under
 * way, and the obvious way to carry it out — running `gitnexus analyze` — is
 * the destructive overlap the cross-process index lock exists to prevent (a
 * forced rebuild deletes the store's DB files). The MCP's own refusal copy
 * learned this the hard way; this is the same sentence for the brief side, so
 * the two surfaces cannot advise differently about one store.
 */
function remedyClause(freshness: GitNexusIndexFreshness): string {
  if (!freshness.rebuild) {
    return "Refreshing it is an operator action: `muon graph reindex`, or Re-index in the desktop. ";
  }
  const who = freshness.rebuild.owner
    ? `MUON's ${freshness.rebuild.owner} surface`
    : "another MUON process";
  const since = freshness.rebuild.startedAt
    ? ` at ${freshness.rebuild.startedAt}`
    : "";
  return (
    `${who} already started a rebuild${since} — WAIT for it and retry. ` +
    "Do NOT start another `gitnexus analyze`: a second run against one store races the first, " +
    "and the forced path deletes the store it is rebuilding. "
  );
}

/**
 * The one-line TOOL GAP detail a stale/missing index contributes to a brief.
 * Returns undefined when the index is fresh — a brief that says "everything
 * is fine" on every dispatch trains agents to skip the block on the one
 * dispatch where it matters (same rule as the environment-drift block).
 *
 * A live rebuild does NOT open a fourth arm here: it changes the remedy, never
 * the verdict. A stale index mid-rebuild is still stale, and a fresh one stays
 * quiet (the noise rule above), so `rebuild` only ever narrows the advice.
 */
export function describeIndexFreshnessGap(
  freshness: GitNexusIndexFreshness
): string | undefined {
  if (freshness.status === "fresh") return undefined;
  if (freshness.status === "stale") {
    const indexed = freshness.indexedCommit?.slice(0, 8) ?? "unknown";
    const head = freshness.headCommit?.slice(0, 8) ?? "unknown";
    const at = freshness.indexedAt ? ` on ${freshness.indexedAt}` : "";
    return (
      `the workspace's code-graph index is STALE (indexed ${indexed}${at}; HEAD is ${head}). ` +
      "Impact and review evidence computed from it is UNKNOWN risk, never implicit clear: " +
      "preflight_edit will refuse and review_diff cannot certify until it is refreshed. " +
      remedyClause(freshness) +
      "Name every conclusion that leans on the stale graph"
    );
  }
  return (
    "no readable code-graph index exists for this workspace (missing or unverifiable .gitnexus meta). " +
    "Graph-backed claims are unavailable, which is UNKNOWN risk, not clear. " +
    remedyClause(freshness) +
    "Say plainly which conclusions are file-read-only because of it"
  );
}
