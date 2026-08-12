import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// P5a boot-probe recovery. A corrupt LadybugDB store SEGFAULTs the native engine
// on open (uncatchable in-process), so the real probe runs in a child process;
// here we inject a deterministic probe to exercise the parent's recovery logic:
// a probe crash quarantines the store so a fresh one is opened and rebuilt from
// the ledger, while a healthy store (or a first launch) is left untouched.

let dir: string;
let graphLib: typeof import("../src/lib/graph.js");

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-probe-"));
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  graphLib = await import("../src/lib/graph.js");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedStore(): string {
  const storePath = graphLib.currentGraphStorePath();
  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(storePath, "not-a-real-lbug-store");
  writeFileSync(`${storePath}.wal`, "stale-wal");
  return storePath;
}

beforeEach(() => {
  rmSync(path.join(dir, "graph"), { recursive: true, force: true });
});

describe("graph boot-probe recovery", () => {
  it("leaves a healthy store in place (probe exits 0)", async () => {
    const storePath = seedStore();
    const result = await graphLib.recoverGraphStoreIfCorrupt({
      probe: async () => 0,
    });
    expect(result.recovered).toBe(false);
    expect(result.quarantinedTo).toBeUndefined();
    expect(existsSync(storePath)).toBe(true);
  });

  it("quarantines a corrupt store so getGraph opens a fresh one (probe crashes)", async () => {
    const storePath = seedStore();
    const result = await graphLib.recoverGraphStoreIfCorrupt({
      probe: async () => 1, // non-zero: the child crashed opening the store
    });
    expect(result.recovered).toBe(true);
    expect(result.quarantinedTo).toBeDefined();
    // The corrupt store is moved aside (kept for forensics) and its stale WAL dropped.
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(`${storePath}.wal`)).toBe(false);
    expect(existsSync(result.quarantinedTo!)).toBe(true);
    // getGraph() will now open a fresh store at the original path.
    expect(result.storePath).toBe(storePath);
  });

  it("quarantine sweeps EVERY sidecar, .shadow and .wal.checkpoint included", async () => {
    // Live incident 2026-08-03: quarantine moved the store but left
    // `<store>.shadow` behind, and LadybugDB refuses to CREATE a fresh store
    // while an orphan shadow file exists — every boot after the quarantine ran
    // degraded. The sweep must cover the full sidecar family.
    const storePath = seedStore();
    writeFileSync(`${storePath}.shadow`, "");
    writeFileSync(`${storePath}.wal.checkpoint`, "stale-checkpoint");
    const result = await graphLib.recoverGraphStoreIfCorrupt({
      probe: async () => 1,
    });
    expect(result.recovered).toBe(true);
    expect(existsSync(`${storePath}.shadow`)).toBe(false);
    expect(existsSync(`${storePath}.wal.checkpoint`)).toBe(false);
    expect(existsSync(`${storePath}.wal`)).toBe(false);
  });

  it("heals orphan sidecars left by an earlier incomplete quarantine (store absent)", async () => {
    // The exact on-disk state the 2026-08-03 incident left behind: no store
    // file, but a 0-byte `.shadow` and a `.wal.checkpoint` beside where it was.
    const storePath = graphLib.currentGraphStorePath();
    mkdirSync(path.dirname(storePath), { recursive: true });
    writeFileSync(`${storePath}.shadow`, "");
    writeFileSync(`${storePath}.wal.checkpoint`, "stale-checkpoint");
    const result = await graphLib.recoverGraphStoreIfCorrupt({
      probe: async () => 1, // must never run: there is no store to probe
    });
    expect(result.recovered).toBe(false);
    expect(existsSync(`${storePath}.shadow`)).toBe(false);
    expect(existsSync(`${storePath}.wal.checkpoint`)).toBe(false);
  });

  it("forces a rebuild without probing after the supervisor observes a native crash", async () => {
    const storePath = seedStore();
    let probed = false;
    const result = await graphLib.recoverGraphStoreIfCorrupt({
      force: true,
      probe: async () => {
        probed = true;
        return 0;
      },
    });
    expect(probed).toBe(false);
    expect(result.recovered).toBe(true);
    expect(result.quarantinedTo).toBeDefined();
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(result.quarantinedTo!)).toBe(true);
  });

  it("is a no-op on first launch (no store on disk)", async () => {
    let probed = false;
    const result = await graphLib.recoverGraphStoreIfCorrupt({
      probe: async () => {
        probed = true;
        return 1;
      },
    });
    expect(result.recovered).toBe(false);
    expect(probed).toBe(false); // nothing to probe
  });

  it("default probe is dev-safe: a missing child script never quarantines", async () => {
    // In tests/dev the compiled probe child (dist/lib/graph-probe-child.js) does
    // not exist, so the default probe returns 0 rather than falsely condemning a
    // healthy store.
    const storePath = seedStore();
    const result = await graphLib.recoverGraphStoreIfCorrupt();
    expect(result.recovered).toBe(false);
    expect(existsSync(storePath)).toBe(true);
  });
});
