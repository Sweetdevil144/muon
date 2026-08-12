import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── The confirm-versus-ingest mirror race ─────────────────────────────────────
//
// The ledger is authoritative and the graph is a best-effort mirror, so a mirror
// write rides an UNAWAITED chain (`mirrorToGraph`). That is fine right up until two
// chains touch the SAME node, because each chain carries a SNAPSHOT of the note
// taken when the chain was created:
//
//   1. ingest commits, creates chain A holding the note with `confirmed: false`;
//   2. a confirm commits, creates chain B holding the note with `confirmed: true`;
//   3. if A lands AFTER B, the mirror ends up showing `confirmed: false` over a
//      note the ledger says is confirmed.
//
// That is not a cosmetic drift. The confirmed-only gate is the product's central
// claim, `recallForGate` reads the MIRROR, and a wrongly-unconfirmed node is
// silently withheld from the gate until the next boot reproject — the exact
// failure mode D15 just spent a slice measuring away (§0's "the gate returns
// nothing"). Measured at 3 failures in 20 runs before the fix.
//
// The fix is the one this repo already chose for the identical shape: the hard
// delete drains in-flight mirrors first, because "this note's own ingest/edit
// projection rides an unawaited chain, and a chain that lands after this delete
// re-MERGEs the node". Confirm has the same shape and had no drain.
//
// WHY THIS TEST INJECTS A SLOW PROJECTION. Sequential caller code almost never
// loses this race: the confirm's own `runExclusive` + findUnique + transaction +
// re-read give chain A ample time to land, and a first attempt at this test passed
// 20/20 WITHOUT the fix — which proves nothing at all. The race needs chain A to
// still be in flight when chain B is created, so the test MAKES that true by
// delaying the first mirror projection. That turns a 3-in-20 flake into a
// deterministic assertion about ORDERING, which is what the fix actually changes.

let dir: string;
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphModule: typeof import("../src/lib/graph.js");

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-mirror-race-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  const db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphModule = await import("../src/lib/graph.js");
  await db.ensureSchema();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Hold the NEXT `projectMemoryNote` open for `ms`, then restore.
 *
 * `getGraph()` is a memoized singleton, so patching its method is enough to keep
 * one mirror chain in flight across the following ledger write. Only the FIRST
 * call is delayed: with the drain in place the confirm's own projection is the
 * second call and runs at full speed, so the test measures the ordering rather
 * than the delay.
 */
function delayFirstProjection(ms: number): () => void {
  const graph = graphModule.getGraph() as unknown as {
    projectMemoryNote: (...args: unknown[]) => Promise<void>;
  };
  const original = graph.projectMemoryNote.bind(graph);
  let delayed = false;
  graph.projectMemoryNote = async (...args: unknown[]) => {
    if (!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return original(...args);
  };
  return () => {
    graph.projectMemoryNote = original;
  };
}

describe("the mirror cannot end up less confirmed than the ledger", () => {
  it("a confirm immediately after an ingest wins in the mirror, not the ingest's stale snapshot", async () => {
    const restore = delayFirstProjection(400);
    let ingested;
    try {
      ingested = await ledger.ingestMemoryNote({
        kind: "decision",
        text: "Retries are capped at three attempts, victor-tango.",
        modules: ["src/retry.ts"],
        createdBy: "human",
      });
      // Chain A is now in flight, holding a snapshot whose `confirmed` is false.
      // NO drain here on purpose: the caller has no reason to know it must.
      await ledger.updateMemoryNote(ingested.note.id, {
        confirmed: true,
        principal: "human:tester",
      });
    } finally {
      restore();
    }
    await graphModule.awaitGraphMirrors();

    // The LEDGER is authoritative and was never in doubt.
    const fromLedger = await ledger.getMemoryNote(ingested.note.id);
    expect(fromLedger?.confirmed).toBe(true);

    // The MIRROR is what the gate reads, and it must agree.
    const mirrored = await graphModule
      .getGraph()
      .getMemoryNote(ingested.note.id);
    expect(mirrored).not.toBeNull();
    expect(mirrored?.confirmed).toBe(true);
  });

  it("and the gate therefore returns it — the read that the drift would silently empty", async () => {
    const restore = delayFirstProjection(400);
    let ingested;
    try {
      ingested = await ledger.ingestMemoryNote({
        kind: "constraint",
        text: "Charges are idempotent by request key, whiskey-xray.",
        modules: ["src/pay/charge.ts"],
        createdBy: "human",
      });
      await ledger.updateMemoryNote(ingested.note.id, {
        confirmed: true,
        principal: "human:tester",
      });
    } finally {
      restore();
    }
    await graphModule.awaitGraphMirrors();

    // The GATE itself: `recallForGate` is a graph read (`preEditContext` fans one
    // out per anchor module), so a wrongly-unconfirmed mirror node is exactly what
    // it silently withholds.
    const gated = await graphModule
      .getGraph()
      .recallForGate({ module: "src/pay/charge.ts" });
    expect(gated.map((note) => note.id)).toContain(ingested.note.id);
  });
});
