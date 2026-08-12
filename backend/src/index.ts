import {
  hydrateAttendanceFromStore,
  startUnattendedHorizonSweep,
} from "./lib/unattended-horizon.js";
import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import type { AddressInfo } from "node:net";
import {
  dbFilePath,
  graphDir,
  removeLockfile,
  resolveDataDir,
  writeLockfile,
} from "@muon/client/paths";
import { buildApp } from "./app.js";
import {
  startAttachedCoordinatorSweep,
  stopAttachedCoordinatorSweep,
} from "./lib/attached-coordinator.js";
import {
  assertHostedTokensConfigured,
  resolveAuthTokens,
} from "./lib/auth.js";
import {
  ensureDefaultFleet,
  ensureDefaultHarnesses,
  ensureDefaultLanes,
  ensureDefaultWorkflowTemplates,
  settleOrphanedLoopRuns,
} from "./lib/bootstrap.js";
import { enableWal, ensureSchema, prisma } from "./lib/db.js";
import { resolveBrainListenPlan } from "./lib/brain-listen.js";
import { env } from "./lib/env.js";
import {
  closeGraph,
  getGraph,
  recoverGraphStoreIfCorrupt,
} from "./lib/graph.js";
import {
  compactMemory,
  projectLedgerToGraph,
  startReinforcementFlush,
  sweepExpiredMemory,
  stopReinforcementFlush,
} from "./lib/memory-ledger.js";
import { getMemoryCompactionRetentionDays } from "./lib/operator-settings.js";
import { retireUnregisteredLanes } from "./lib/vendor-lanes.js";

// A `file:` DATABASE_URL means the local-first embedded brain (SQLite in the
// per-user data dir); a Postgres URL means a hosted deployment. The two differ
// only at the edges (bind address, local token, lockfile), everything between
// is identical. See docs/adr/0008-embedded-brain-sqlite.md.
const embedded = env.DATABASE_URL.startsWith("file:");
const dataDir = resolveDataDir();

if (embedded) {
  // Keep the graph store next to the db in the shared data dir.
  process.env.MUON_GRAPH_DIR ??= graphDir(dataDir);
  // Two-tier local credentials (P3-A), minted BEFORE buildApp() wires the gate.
  // The OPERATOR token carries human / govern authority and is advertised to
  // LOCAL HUMAN surfaces via the 0600 lockfile `token`; the AGENT token is the
  // agent tier (reads + agent-writes, never govern) injected into DISPATCHED
  // SUB-AGENTS via the lockfile `agentToken`. Both are 256-bit random,
  // loopback-only, never custodied off-machine. Minting BOTH here is what makes
  // embedded boot fail-closed-by-construction (H3) and separates the sub-agent's
  // credential from the human's (closes the shared-token blast radius, C1/H1).
  // A preconfigured legacy MUON_API_TOKEN becomes the operator token (back-compat).
  if (!env.MUON_OPERATOR_TOKEN) {
    const token = env.MUON_API_TOKEN ?? randomBytes(32).toString("hex");
    env.MUON_OPERATOR_TOKEN = token;
    process.env.MUON_OPERATOR_TOKEN = token;
  }
  if (!env.MUON_AGENT_TOKEN) {
    const token = randomBytes(32).toString("hex");
    env.MUON_AGENT_TOKEN = token;
    process.env.MUON_AGENT_TOKEN = token;
  }
}

// Boot seeding hits a remote Postgres (Railway), transient P1001s happen
// (cold connections, lingering pools from a previous process). Retry with
// backoff instead of dying on the first blip.
async function withRetries(label: string, fn: () => Promise<void>) {
  const delaysMs = [0, 5_000, 15_000];
  for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
    if (delaysMs[attempt] > 0) {
      console.error(`${label}: retrying in ${delaysMs[attempt] / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
    try {
      await fn();
      return;
    } catch (error) {
      if (attempt === delaysMs.length - 1) {
        throw error;
      }
      console.error(
        `${label} failed (attempt ${attempt + 1}): ${error instanceof Error ? error.message.split("\n")[0] : error}`
      );
    }
  }
}

async function start() {
  const app = buildApp();

  // Embedded SQLite: switch the journal to WAL once (concurrent-read throughput
  // under MUON's constant polling), then materialize the schema on first launch.
  // Both no-op on Postgres.
  await enableWal();
  await ensureSchema();

  // P5a boot-probe recovery: open the embedded graph store in a CHILD-PROCESS
  // probe FIRST, a store corrupted by a crash mid-write SEGFAULTs the native
  // engine on open, which is uncatchable in-process and crash-loops the backend.
  // If the probe crashes, the corrupt store is quarantined so the next getGraph()
  // opens a fresh one. Runs before any getGraph(). The permanent cure for the
  // corrupt-store crash-loop (docs/research/review-r1-r4.md).
  await recoverGraphStoreIfCorrupt();

  await withRetries("bootstrap seeds", async () => {
    await ensureDefaultLanes();
    // AFTER the seed, never before: the seed owns the registered keys and this
    // owns the rest, so running it second makes the pair deterministic on a boot
    // where both have work. Retire-not-delete — the row stays for history, it
    // just stops claiming to be available. Advisory only; the reads that decide
    // which lanes EXIST derive from the registry (lib/vendor-lanes.ts).
    await retireUnregisteredLanes();
    await ensureDefaultHarnesses();
    await ensureDefaultWorkflowTemplates();
    await ensureDefaultFleet();
    // Nothing can still be running at boot: every runner lease predates this
    // process. Phantom "running" LoopRuns settle here so no surface shows a
    // live loop nothing executes.
    const settled = await settleOrphanedLoopRuns();
    if (settled > 0) {
      console.log(`[boot] settled ${settled} orphaned loop run(s)`);
    }
  });

  // Rebuild the memory graph from the durable relational ledger (ADR-0009 Slice
  // 1 / KG-1): a fresh store, first launch, a STORE_VERSION bump, OR a store
  // just quarantined above, is repopulated from the source of truth, so ZERO
  // human-confirmed memory is ever lost.
  //
  // Order matters (F2): seed LaneNodes and AWAIT them FIRST so the projector can
  // attach BY_LANE edges to existing lane nodes; then replay the ledger. All
  // best-effort in one guard, a graph failure must NEVER fail boot (the ledger
  // stays the source of truth; the next boot retries the projection).
  try {
    const graph = getGraph();
    // DELIBERATELY UNFILTERED, unlike every "available lane" read. This is
    // PROVENANCE: a memory note confirmed on a lane that has since been retired
    // still needs its LaneNode, or the BY_LANE edge the projector attaches below
    // would dangle and the note would lose where it came from. Retiring a lane
    // removes an OPTION, never a fact (ADR-0021: the graph is for provenance).
    const lanes = await prisma.lane.findMany();
    for (const lane of lanes) {
      await graph.upsertLane({ id: lane.id, key: lane.key, name: lane.name });
    }
    const retentionDays = await getMemoryCompactionRetentionDays();
    if (retentionDays === null) {
      console.error(
        "memory compaction skipped: retention setting unavailable (fail-closed)"
      );
    } else {
      // Compact the durable ledger BEFORE replay. The projector that follows is
      // then the one authoritative graph write, avoiding an asynchronous live
      // mirror racing boot.
      await compactMemory(retentionDays, new Date(), { mirrorGraph: false }).catch((error) => {
        console.error(
          `memory compaction skipped: ${
            error instanceof Error ? error.message : error
          }`
        );
      });
    }
    // R3: materialize the soft tombstone for notes whose TTL has passed, BEFORE
    // the replay below, so the projector is still the one authoritative graph
    // write. Bounded (one batch) and non-destructive — it only stamps
    // `expiredAt` + appends provenance, never clears text — and reads already
    // derive hidden-ness from `expiresAt`, so a skipped or partial sweep changes
    // nothing a caller can observe. `sweepExpiredMemory` mirrors best-effort and
    // is told not to, since the reproject that follows covers it.
    await sweepExpiredMemory(new Date(), { mirrorGraph: false }).catch(
      (error) => {
        console.error(
          `memory expiry sweep skipped: ${
            error instanceof Error ? error.message : error
          }`
        );
      }
    );
    await projectLedgerToGraph(graph);
  } catch (error) {
    console.error(
      `memory/graph bootstrap degraded: ${error instanceof Error ? error.message : error}`
    );
  }

  // Reinforcement OFF the read path (ADR-0009 §2.4 / KG-2): buffered explicit
  // used-signals are flushed on this timer (and on shutdown) into the graph and
  // persisted to the durable ledger, reads never write.
  startReinforcementFlush();

  // ADR-0028 §4: the brain-side lapse reaper. Runs regardless of embedded vs
  // hosted — an attached coordinator's lease can lapse either way — and is
  // a no-op read when no attached coordinator is running.
  startAttachedCoordinatorSweep();
    // ADR-0040 D3 + D3a — the bound on a daemon nobody returns to. ENABLED
    // once attendance became a positive assertion from a surface rather than
    // an inference from operator-tier traffic. Hydrate FIRST so a restart does
    // not reset the clock and make a crash-looping daemon immortal.
    await hydrateAttendanceFromStore();
    startUnattendedHorizonSweep();

  if (embedded) {
    // Loopback only, and on a STABLE port by default.
    //
    // The port used to be OS-assigned (`0`) so that tests, a second checkout
    // and the desktop could never collide. Churn cost more than collision
    // ever did: an attached seat's capability file pins `apiBase` at attach
    // time, so every restart silently invalidated every attached seat, and a
    // long-lived MCP server kept calling an address nobody was listening on.
    // A user sees none of that — only tools that stopped working.
    //
    // CONTENTION IS HANDLED, NOT TRADED FOR:
    //   - the DEFAULT falls back to an ephemeral port if the constant is
    //     taken, because a machine where 47100 belongs to something unrelated
    //     must still get a working brain;
    //   - an EXPLICIT `MUON_BRAIN_PORT` still fails loudly, because someone
    //     who chose a number deserves to hear it was unavailable rather than
    //     silently receive a different one;
    //   - `MUON_BRAIN_PORT=0` asks for the old ephemeral behaviour outright.
    //
    // Either way the lockfile publishes the port actually bound, so discovery
    // is unchanged and no caller may hard-code the constant.
    const plan = resolveBrainListenPlan(env.MUON_BRAIN_PORT);
    let portFallbackFrom: number | null = null;
    try {
      await app.listen({ host: "127.0.0.1", port: plan.port });
    } catch (error) {
      const inUse =
        (error as NodeJS.ErrnoException | null)?.code === "EADDRINUSE";
      if (!inUse || !plan.mayFallBack) {
        throw error;
      }
      portFallbackFrom = plan.port;
      await app.listen({ host: "127.0.0.1", port: 0 });
    }
    const address = app.server.address() as AddressInfo | null;
    const port = address?.port ?? env.PORT;
    if (portFallbackFrom !== null) {
      // SAID OUT LOUD. A brain quietly on a different port is exactly the
      // condition every surface then has to re-resolve around, so the one
      // moment it becomes true is worth a line in the log.
      app.log.warn(
        `port ${portFallbackFrom} is held by another process; this brain took ${port} instead. Surfaces discover it from the lockfile, so nothing needs reconfiguring.`
      );
    }
    // Owner-only perms on the db (+ WAL sidecars): task briefs and the graph
    // are private to this user on a shared host (review finding F8).
    const dbPath = dbFilePath(dataDir);
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // best-effort: a sidecar may not exist yet; perms are hardened in P3.
      }
    }
    // Publish coordinates so every local surface auto-targets this brain. The
    // operator token (`token`) is for LOCAL HUMAN surfaces (CLI/TUI/desktop); the
    // agent token (`agentToken`) is injected into dispatched sub-agents (P3-A).
    writeLockfile(
      {
        port,
        token: env.MUON_OPERATOR_TOKEN ?? "",
        agentToken: env.MUON_AGENT_TOKEN ?? "",
        pid: process.pid,
        dbPath,
        startedAt: new Date().toISOString(),
      },
      dataDir
    );
    console.error(
      `MUON brain ready on http://127.0.0.1:${port} (data dir: ${dataDir})`
    );
  } else {
    // H3 FAIL-CLOSED: a hosted deploy binds a NON-loopback interface, so it MUST
    // present both tier credentials, otherwise the entire privileged API would
    // be exposed unauthenticated on every interface (the pre-P3-A hole where the
    // gate was registered only `if (MUON_API_TOKEN)`). Refuse the bind without
    // them. Embedded always mints both above, so this only guards a hosted host.
    assertHostedTokensConfigured(resolveAuthTokens(env));
    await app.listen({ host: "0.0.0.0", port: env.PORT });
  }
}

start().catch(async (error) => {
  const { redactForLog } = await import("@muon/core");
  console.error(redactForLog(error));
  await prisma.$disconnect();
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // Clear OUR lockfile (only if it's still ours) so clients don't probe a
    // dead port, but never delete a successor brain's lockfile (finding F7).
    if (embedded) {
      removeLockfile(dataDir, process.pid);
    }
    // Drain buffered reinforcement into the ledger BEFORE the graph closes, so
    // explicit used-signals accrued this session are not lost on restart (KG-2).
    await stopReinforcementFlush();
    stopAttachedCoordinatorSweep();
    // Close the graph store cleanly so its lock/WAL release before restart (a
    // clean close means the next boot-probe never mistakes a live lock for
    // corruption).
    await closeGraph();
    await prisma.$disconnect();
    process.exit(0);
  });
}
