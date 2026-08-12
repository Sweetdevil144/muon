// Child-process boot-probe (P5a). The parent (recoverGraphStoreIfCorrupt in
// lib/graph.ts) spawns this with the store path as argv[2]. It opens the store
// and reads across the MAJOR node/rel tables: a LadybugDB store corrupted by a
// crash mid-write SEGFAULTs the native engine on open/first-query, which is
// UNCATCHABLE in-process, so isolating it in this child means the crash kills
// the child, not the backend. Clean open + queries → exit 0. Any crash/signal/
// non-zero tells the parent to quarantine the store and rebuild from the ledger.
//
// P4 BUNDLING REQUIREMENT: this module is invoked by RUNTIME PATH
// (dist/lib/graph-probe-child.js), not by a static import, so a bundler
// (esbuild/pkg, the desktop bundles the backend) will NOT emit it unless it is
// listed as an explicit entry/asset. If it is missing, the probe self-disables
// (spawnGraphProbe treats a missing script as "cannot probe"), silently losing
// corrupt-store auto-recovery. CI asserts its presence after build
// (scripts/ci-boot-smoke.sh); the desktop build must ship it too.
import { MuonGraph } from "@muon/graph";

async function main(): Promise<void> {
  const storePath = process.argv[2];
  if (!storePath) {
    process.exit(2);
  }
  const graph = new MuonGraph(storePath, {
    // Match the app's FTS posture; FTS-load failure degrades gracefully inside
    // init() (it never throws), so it can't be mistaken for store corruption.
    disableFts: process.env.MUON_GRAPH_DISABLE_FTS === "1",
  });
  // recallMemory forces init() (open + schema) AND reads the MemoryNote table;
  // suggestLanes reads the ROUTING tables (LaneNode / WORKED_ON / TaskNode /
  // Module), so localized data-page corruption outside MemoryNote (which the
  // main process would then hit on its first routing query) is caught here too (F4).
  await graph.recallMemory({});
  await graph.suggestLanes();
  await graph.close();
  process.exit(0);
}

main().catch(() => process.exit(1));
