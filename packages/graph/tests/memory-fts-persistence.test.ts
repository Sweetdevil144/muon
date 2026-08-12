import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The BM25 arm must survive a RESTART.
 *
 * `tryEnableFts` used to call `CREATE_FTS_INDEX` unconditionally inside a
 * try/catch that set `ftsEnabled = false`. The index is DURABLE — it lives in
 * the store file — so every process after the first threw "Index
 * memory_note_fts already exists" and silently ran memory recall with the
 * lexical arm switched off for its whole lifetime. Measured before the fix,
 * three consecutive processes against one store: `true`, `false`, `false`.
 *
 * WHY THIS TEST SPAWNS PROCESSES, which is unusual for this suite: the defect
 * only exists ACROSS process starts, and it cannot be reproduced in-process —
 * opening the same store twice inside one Node process tears down the native
 * lbug binding and takes the vitest worker with it (`ERR_IPC_CHANNEL_CLOSED`).
 * That is also the structural reason the defect survived review: every other
 * graph test roots at a fresh `mkdtempSync` dir, so only the first-boot path was
 * ever exercised, and no in-process test could have exercised the second.
 *
 * It runs against `dist/` because a child process cannot import the TypeScript
 * source without a loader. `npm run build` therefore has to have run — the test
 * says so explicitly rather than failing as a confusing module-not-found.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_GRAPH = join(HERE, "..", "dist", "muon-graph.js");

/** Open the store in a FRESH process; report whether BM25 came up armed. */
function ftsArmedInFreshProcess(
  storePath: string,
  noteId: string
): "armed" | "off" {
  const script = `
    const { MuonGraph } = await import(${JSON.stringify(DIST_GRAPH)});
    const graph = new MuonGraph(${JSON.stringify(storePath)});
    await graph.ingestMemoryNote({
      id: ${JSON.stringify(noteId)},
      kind: "decision",
      text: "the coordinator reserves fleet ordinal zero",
      createdBy: "human:test",
      modules: [],
      topics: [],
    });
    console.log(graph.ftsEnabled === true ? "ARMED" : "OFF");
    await graph.close();
  `;
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 120_000 }
  );
  return out.includes("ARMED") ? "armed" : "off";
}

describe("BM25 survives reopening a persisted store", () => {
  let dir: string;
  let storePath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "muon-fts-persistence-"));
    storePath = join(dir, "fts.lbug");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("arms FTS on the first open, and ADOPTS it on every open after", ({ skip }) => {
    expect(
      existsSync(DIST_GRAPH),
      `${DIST_GRAPH} is missing — run \`npm run build\` in packages/graph first`
    ).toBe(true);

    const first = ftsArmedInFreshProcess(storePath, "fts-note-1");
    if (first === "off") {
      skip(
        "LadybugDB FTS is unavailable in this runtime; production degrades to lexical retrieval."
      );
    }
    expect(first, "first open must CREATE the index").toBe("armed");

    // The regression: this process finds the index already in the store.
    // Creating it again throws, and the old code read that throw as "no FTS".
    expect(
      ftsArmedInFreshProcess(storePath, "fts-note-2"),
      "reopening a store that already has the index must ADOPT it, not disable BM25"
    ).toBe("armed");

    // Not only the second — the defect made every later start false too.
    expect(
      ftsArmedInFreshProcess(storePath, "fts-note-3"),
      "and every start after that"
    ).toBe("armed");
  }, 400_000);
});
