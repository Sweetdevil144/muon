import { GRAPH_MIRROR_FAILED_EVENT_KIND } from "@muon/client";
import { redactForLog } from "@muon/core";
import { spawn } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Prisma } from "@prisma/client";
import { MuonGraph, type Embedder } from "@muon/graph";
import { prisma } from "./db.js";
import { durableEmbeddingCache } from "./embedding-cache.js";
import { createLocalOllamaEmbedder } from "./embedder.js";

let instance: MuonGraph | null = null;

// Bump when a whole GENERATION of on-disk stores must be abandoned. A LadybugDB
// store corrupted by a crash mid-write SEGFAULTS the native engine on open,
// which no JS try/catch can trap, so it crash-loops the whole backend and the
// ONLY recovery is a fresh store. The permanent cure now lives in code:
// `recoverGraphStoreIfCorrupt()` opens the store in a CHILD-PROCESS probe at
// boot and, if it crashes, quarantines the corrupt store so `getGraph()` opens a
// FRESH one. This is safe because the memory graph is a DERIVED index, the
// relational ledger (backend/prisma: MemoryNote/MemoryEdge/Episode/Confirmation)
// is the source of truth and `projectLedgerToGraph()` replays it into the fresh
// store, so no human-confirmed memory is ever lost (ADR-0009 Slice 1 / KG-1).
// v3 abandons the 2026-08-03 desktop store whose MemoryNote FTS update path was
// verified to SIGSEGV under Electron. The SQLite ledger remains authoritative;
// boot reprojects every note into this fresh derived generation.
const STORE_VERSION = "v3";

// In-memory generation, bumped only if the boot-probe can't quarantine a corrupt
// store on disk (e.g. a read-only volume), a belt-and-suspenders so `getGraph()`
// still lands on a fresh path. Resets to 0 each process; the on-disk quarantine
// is the durable recovery.
let storeGeneration = 0;

function graphDirPath(): string {
  return (
    process.env.MUON_GRAPH_DIR?.trim() ||
    path.join(process.cwd(), ".muon", "graph")
  );
}

function graphPath(): string {
  const suffix = storeGeneration > 0 ? `.r${storeGeneration}` : "";
  return path.join(graphDirPath(), `muon.${STORE_VERSION}${suffix}.lbug`);
}

/**
 * Optional dense embeddings tier (ADR-0009 Slice 3 / KG-3). Lexical-first is the
 * DEFAULT and the fallback (design decision D3): the dense path is LOCAL-ONLY
 * (a loopback Ollama, never a cloud API, no data egress), OPT-IN (only fires
 * when a local Ollama is actually running), and AUTO-DETECTED (a single cached
 * async probe; no Ollama → silently lexical, nothing required on first run).
 * `MUON_EMBED_DISABLE=1` is a hard off. The embedder never fails a request,
 * any error degrades to lexical. Both the graph (semantic recall) and the ledger
 * (ingest compute+cache + dense dedup) resolve the embedder through here so
 * there is exactly ONE instance / one detection.
 */
function buildEmbedder(): Embedder | undefined {
  if (process.env.MUON_EMBED_DISABLE === "1") {
    return undefined; // hard off → pure lexical, embedder absent
  }
  return createLocalOllamaEmbedder();
}

// Memoized once per process. `null` = not yet resolved; the wrapper lets a test
// inject a deterministic fake (or force-disable) via `__setEmbedderForTests`.
let embedderMemo: { value: Embedder | undefined } | null = null;

/**
 * The single shared embedder instance (or undefined = dense off). The ledger
 * imports this to compute+cache a note's vector on ingest, and getGraph injects
 * the SAME instance into MuonGraph for semantic recall, one detection probe,
 * one source of truth for "is dense on".
 */
export function getEmbedder(): Embedder | undefined {
  embedderMemo ??= { value: buildEmbedder() };
  return embedderMemo.value;
}

/**
 * TEST SEAM ONLY: inject a deterministic fake embedder (no network) or undefined
 * (force dense off). Must be called BEFORE the first getGraph()/ingest so the
 * graph is constructed with it. Never used by production code.
 */
export function __setEmbedderForTests(embedder: Embedder | undefined): void {
  embedderMemo = { value: embedder };
}

export function getGraph(): MuonGraph {
  instance ??= new MuonGraph(graphPath(), {
    embedder: getEmbedder(),
    embeddingCache: durableEmbeddingCache,
    // Container hosts (Railway) cannot load the Ladybug FTS native
    // extension; set MUON_GRAPH_DISABLE_FTS=1 there so retrieval uses
    // lexical + salience (+ optional embeddings) and writes never touch an
    // FTS index that would fail without the extension.
    disableFts: process.env.MUON_GRAPH_DISABLE_FTS === "1",
  });
  return instance;
}

/** One Event row per operation label per window; every failure inside the window
 *  is counted into the next row's `suppressed`. A persistently broken store then
 *  signals continuously without turning every memory write into an audit row. */
const MIRROR_EVENT_INTERVAL_MS = 30_000;
const mirrorFailures = new Map<
  string,
  { lastEventAt: number; suppressed: number }
>();

/**
 * The `Event.kind` a coalesced mirror failure lands on. EXPORTED so the two places
 * that must NAME the degradation signal — the bounded activity replay, which
 * excludes it, and the events route's `kind` filter, which is how a surface asks
 * for it without racing higher-volume rows for a slot in the recent window — import
 * the literal instead of restating it.
 */
// ONE definition, in `@muon/client`, because the desktop polls for this kind by
// name and cannot import the backend. Re-exported so existing importers here are
// unchanged.
export { GRAPH_MIRROR_FAILED_EVENT_KIND };

/**
 * Record a mirror failure LOUDLY. The old behaviour was a single
 * once-per-process `console.error`, which meant a projection that had silently
 * stopped tracking the ledger looked exactly like a healthy one from the second
 * failure onward. Since R3 that silence is expensive: the graph carries
 * `confirmed`/`expiresAt`, so a mirror that missed a confirm is a graph that
 * disagrees with the ledger about whether a human-adjudicated note exists.
 *
 * COORDINATES ONLY: the operation label and the error message. No note id, no
 * note text, nothing content-bearing ever reaches the log or the Event row.
 *
 * EXPORTED since D6 for exactly ONE caller outside `mirrorToGraph`:
 * `projectLedgerToGraph`'s per-note loop, which now has a failure worth surfacing
 * (a dropped `ANCHORED_TO` write is a lost memory once the edge is the access
 * path) but must not abort a whole-brain replay over one note. Deliberately reused
 * rather than paired with a second convention — the decision asks for the failure
 * to arrive on the SAME coalesced `memory.graph_mirror_failed` Event the operator
 * surfaces already read, and two signals for one condition is how one of them
 * stops being watched.
 *
 * THE COALESCING'S OWN JUSTIFICATION — "the operator surfaces that already read the
 * event log show that memory is degraded" — needed the Event to still BE in the
 * window those surfaces read. `GET /api/events?limit=50` is the only consumer of
 * this kind anywhere in the tree, and D14's per-pre-edit gate-read row can push a
 * once-per-30 s alarm out of fifty rows. That is why the route takes a `kind`
 * filter: the signal is now addressable by name, so the justification holds without
 * depending on winning a race against a higher-volume producer.
 */
export function reportMirrorFailure(label: string, error: unknown): void {
  // TODO 7.1: reason lands on console AND Event.message — scrub both.
  const reason = redactForLog(error);
  // One line PER FAILURE (not per process), naming the operation, so the next
  // occurrence of an opaque driver error identifies itself.
  console.error(`[memory] graph mirror failed (op=${label}): ${reason}`);
  const now = Date.now();
  const state = mirrorFailures.get(label) ?? { lastEventAt: 0, suppressed: 0 };
  if (now - state.lastEventAt < MIRROR_EVENT_INTERVAL_MS) {
    mirrorFailures.set(label, { ...state, suppressed: state.suppressed + 1 });
    return;
  }
  mirrorFailures.set(label, { lastEventAt: now, suppressed: 0 });
  // Best-effort like the mirror itself: the ledger already committed, and an
  // event-log hiccup must not turn a degraded projection into a failed request.
  void prisma.event
    .create({
      data: {
        laneId: "muon",
        taskId: "memory",
        kind: GRAPH_MIRROR_FAILED_EVENT_KIND,
        message: `graph mirror failed (${label}): ${reason}`,
        metadata: {
          op: label,
          reason,
          suppressed: state.suppressed,
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);
}

/** Mirror chains nobody awaits, so a caller that must not race one can. */
const inFlightMirrors = new Set<Promise<void>>();

/** Bound on drain rounds, so a pathological chain that keeps spawning mirrors
 *  can never turn a drain into an unbounded wait. */
const MAX_MIRROR_DRAIN_ROUNDS = 8;

/**
 * Best-effort mirror into the embedded graph. The relational ledger is the
 * source of truth; a graph failure must never fail the API request — but it must
 * never be SILENT either, because a stale projection and a healthy one are
 * indistinguishable from the outside. Every failure logs a line and (coalesced
 * per label) raises a `memory.graph_mirror_failed` Event, so the operator
 * surfaces that already read the event log show that memory is degraded.
 *
 * `label` names the mirrored operation and is OPTIONAL so every existing call
 * site keeps working unchanged.
 */
export function mirrorToGraph(
  op: (graph: MuonGraph) => Promise<void>,
  label = "graph"
): void {
  const run: Promise<void> = op(getGraph())
    .catch((error) => reportMirrorFailure(label, error))
    .finally(() => {
      inFlightMirrors.delete(run);
    });
  inFlightMirrors.add(run);
}

/**
 * Mirror, and let the CALLER wait for this one projection.
 *
 * Same registration as `mirrorToGraph` — the chain joins `inFlightMirrors`, so
 * a later `awaitGraphMirrors()` still orders a delete behind it — and the same
 * never-throws contract. The only difference is that the promise comes back.
 *
 * For the writes where the LEDGER's half of a change is visible instantly and
 * the GRAPH's half is not. A text-edit is the case: the predecessor retires
 * inside the transaction while the successor's anchors arrive with the mirror,
 * so between the two an edit-boundary gate saw NEITHER — an operator's typo
 * fix briefly took the finding off the ground it was about. Awaiting only THIS
 * projection (rather than draining every mirror in flight) keeps one note's
 * edit from waiting on unrelated ingest traffic.
 */
export function mirrorToGraphNow(
  op: (graph: MuonGraph) => Promise<void>,
  label = "graph"
): Promise<void> {
  const run: Promise<void> = op(getGraph())
    .catch((error) => reportMirrorFailure(label, error))
    .finally(() => {
      inFlightMirrors.delete(run);
    });
  inFlightMirrors.add(run);
  return run;
}

/**
 * Await every mirror chain currently in flight.
 *
 * A fire-and-forget projection is fine right up until a LATER write has to be
 * ordered against it. Hard delete is the case that matters: `deleteMemoryNote`
 * removes the node from the graph, but the note's own ingest/edit mirror is an
 * unawaited chain, and if that chain lands AFTER the delete it re-MERGEs the
 * node — putting a deleted note's TEXT back into the projection until the next
 * reproject. Draining first makes the ordering structural instead of a race.
 *
 * Never throws: every chain already swallows its own failure into
 * `reportMirrorFailure`.
 */
export async function awaitGraphMirrors(): Promise<void> {
  for (let round = 0; round < MAX_MIRROR_DRAIN_ROUNDS; round += 1) {
    if (inFlightMirrors.size === 0) {
      return;
    }
    await Promise.all([...inFlightMirrors]).catch(() => undefined);
  }
}

/**
 * Close and forget the memoized graph handle so the NEXT getGraph() reopens the
 * store from disk. Used on shutdown and after a corrupt-store quarantine (and by
 * tests that wipe the store to prove the rebuild path).
 */
export async function closeGraph(): Promise<void> {
  if (instance) {
    const current = instance;
    instance = null;
    await current.close().catch(() => undefined);
  }
}

/** The graph store file the app would open right now (plus its sidecars). */
export function currentGraphStorePath(): string {
  return graphPath();
}

/**
 * Every sidecar LadybugDB writes beside a store file. `.shadow` and
 * `.wal.checkpoint` are load-bearing here: a leftover `<base>.shadow` with no
 * `<base>` makes LadybugDB REFUSE to create a fresh store at that path
 * ("Found shadow file ... but no corresponding database file"), which turns a
 * completed quarantine into a permanently degraded graph.
 */
const STORE_SIDECAR_SUFFIXES = [
  ".wal",
  ".shm",
  ".lock",
  ".tmp",
  ".shadow",
  ".wal.checkpoint",
] as const;

/** Best-effort removal of every sidecar beside `base`. */
function removeStoreSidecars(base: string): void {
  for (const suffix of STORE_SIDECAR_SUFFIXES) {
    try {
      rmSync(`${base}${suffix}`, { force: true });
    } catch {
      // best-effort
    }
  }
}

/** Move a corrupt store (and its WAL/shm/shadow sidecars) aside for forensics. */
function quarantineStore(base: string): string | undefined {
  const target = `${base}.corrupt-${Date.now()}`;
  try {
    renameSync(base, target);
  } catch {
    return undefined;
  }
  // A quarantined store's sidecars are stale, drop them so a fresh store at the
  // same path starts clean.
  removeStoreSidecars(base);
  return target;
}

// Resolved by RUNTIME PATH, not a static import. F6/P4: a bundler (esbuild/pkg,
// the desktop bundles the backend) won't emit graph-probe-child.js unless it is
// an explicit entry/asset; if it's absent, spawnGraphProbe below treats it as
// "cannot probe" and auto-recovery silently self-disables. CI asserts this file
// exists after build (scripts/ci-boot-smoke.sh).
function probeChildPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "graph-probe-child.js"
  );
}

/**
 * Open the store in a CHILD PROCESS so a corrupt-store SEGFAULT (uncatchable
 * in-process) is contained. Resolves 0 iff the child opened + queried the store
 * and exited cleanly; any crash/signal/timeout resolves non-zero. Missing probe
 * script (dev/tsx, where only .ts exists) is treated as "cannot probe" → 0, so a
 * healthy dev store is never falsely quarantined.
 *
 * F5 (accepted, bounded): if a PRIOR backend was SIGKILLed it may leave a live
 * lock/WAL; this probe could then read that as a fault and quarantine an
 * otherwise-recoverable store. Cost is bounded, the ledger fully rebuilds the
 * fresh store, and the alternative (never quarantining) risks the crash-loop we
 * are curing, so we accept the rare unnecessary rebuild. A lock-age heuristic can
 * refine this later.
 */
function spawnGraphProbe(storePath: string): Promise<number> {
  const script = probeChildPath();
  if (!existsSync(script)) {
    return Promise.resolve(0);
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, storePath], {
      stdio: "ignore",
      env: process.env,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(0); // couldn't launch the probe, don't punish the store
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

/**
 * P5a boot-probe recovery. Probe the on-disk store in a child process BEFORE the
 * main process ever opens it; if the probe crashes (corrupt store), quarantine
 * the store so getGraph() opens a fresh one, which projectLedgerToGraph() then
 * repopulates from the durable ledger. The permanent cure for the corrupt-store
 * crash-loop (docs/research/review-r1-r4.md). Must run before any getGraph().
 */
export async function recoverGraphStoreIfCorrupt(opts?: {
  probe?: (storePath: string) => Promise<number>;
  /**
   * The desktop supervisor sets this after an unexpected native brain exit.
   * A SIGSEGV cannot leave JavaScript evidence inside the child, so the parent
   * is the only component that can request a fail-safe rebuild on the restart.
   */
  force?: boolean;
}): Promise<{ recovered: boolean; storePath: string; quarantinedTo?: string }> {
  const probe = opts?.probe ?? spawnGraphProbe;
  const storePath = graphPath();
  // Nothing on disk yet (first launch or a completed quarantine): the fresh
  // store is created on open. An earlier quarantine may still have left orphan
  // sidecars behind (`.shadow` in particular blocks the fresh open outright —
  // observed live on 2026-08-03), so sweep them before the store is created.
  if (!existsSync(storePath)) {
    const orphaned = STORE_SIDECAR_SUFFIXES.filter((suffix) =>
      existsSync(`${storePath}${suffix}`)
    );
    if (orphaned.length > 0) {
      removeStoreSidecars(storePath);
      console.error(
        `graph store absent but orphan sidecar(s) ${orphaned.join(", ")} ` +
          "remained (an earlier quarantine was incomplete); removed them so the fresh store can be created."
      );
    }
    return { recovered: false, storePath };
  }
  const forced = opts?.force ?? process.env.MUON_GRAPH_FORCE_RECOVER === "1";
  const code = forced ? 1 : await probe(storePath);
  if (!forced && code === 0) {
    return { recovered: false, storePath };
  }
  const quarantinedTo = quarantineStore(storePath);
  if (!quarantinedTo) {
    // Couldn't move it (e.g. read-only volume), bump the generation so the
    // fresh store lands on a new path instead.
    storeGeneration += 1;
  }
  console.error(
    `${
      forced
        ? "graph store rebuild requested after an unexpected native brain exit"
        : `graph store failed boot-probe (exit ${code})`
    }; ${
      quarantinedTo
        ? `quarantined to ${path.basename(quarantinedTo)}`
        : `switching to generation r${storeGeneration}`
    } and rebuilding from the ledger.`
  );
  return { recovered: true, storePath: graphPath(), quarantinedTo };
}
