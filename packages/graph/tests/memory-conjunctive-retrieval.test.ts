import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MuonGraph } from "../src/muon-graph.js";
import {
  anchorFenceIsEmpty,
  memoryAnchorArms,
  normalizeAnchorSet,
  noteMatchesAnchors,
} from "../src/memory-anchors.js";
import type { MemoryNoteRecord } from "../src/types.js";

// ── D4 (retrieval is CONJUNCTIVE) + D6 (ONE batched anchor query) ─────────────
//
// docs/design/memory-index-decisions.md §D4 / §D6, exit condition: "one store
// round trip per gate read regardless of anchor count; a byte-identical governed
// row set; and the anchor completeness invariant asserted by a test."
//
// Each of those three is a describe block below, and each is asserted the way the
// decision states it rather than by a proxy:
//   • the round-trip claim is COUNTED (a spy on the store), because a test that
//     only checks the RESULT cannot detect that the fan-out is still there;
//   • the row-set claim is DIFFERENTIAL against two independent oracles — the
//     per-anchor fan-out this replaced, and the AUTHORITY arrays the edge is only
//     an access path for;
//   • the completeness claim is asserted after DELETING an edge, so it fails when
//     the reconciler stops looking.

let graph: MuonGraph;
let dir: string;

/** 42 module anchors: the count `n.modules` reached on this brain after D15
 *  promoted prose to anchors (9 → 42), so the fan-out this replaces would be 42
 *  round trips for the gated arm alone. */
const ANCHOR_COUNT = 42;
const MODULES = Array.from(
  { length: ANCHOR_COUNT },
  (_, index) => `src/mod${String(index).padStart(2, "0")}.ts`
);
const SYMBOL = `${MODULES[0]}#chargeOnce`;
const CHAT = "chat-conj";

/** Store call counter. `execute` is private, so the spy is installed on the
 *  INSTANCE (shadowing the prototype method) — no production seam, and it counts
 *  the real thing rather than a stand-in. */
function countingSpy(target: MuonGraph): {
  calls: string[];
  restore: () => void;
} {
  const holder = target as unknown as {
    execute: (statement: string, params: unknown) => Promise<unknown[]>;
  };
  const real = holder.execute.bind(target);
  const calls: string[] = [];
  holder.execute = async (statement, params) => {
    calls.push(statement);
    return real(statement, params);
  };
  return {
    calls,
    restore: () => {
      delete (target as unknown as { execute?: unknown }).execute;
    },
  };
}

const ids = (notes: MemoryNoteRecord[]): string[] => notes.map((n) => n.id);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-conjunctive-"));
  // disableFts keeps the corpus deterministic; the FTS-arm intersection has its
  // own block below and arms FTS explicitly.
  graph = new MuonGraph(join(dir, "test.lbug"), { disableFts: true });
  await graph.init();

  // One CONFIRMED note per anchor, plus a decoy anchored nowhere near them, plus a
  // symbol-anchored note, plus an UNCONFIRMED same-chat note so the gate has
  // something to withhold.
  for (const [index, module] of MODULES.entries()) {
    const note = await graph.addMemoryNote({
      kind: index % 2 === 0 ? "decision" : "convention",
      text: `Module ${index} enforces idempotent charges by request key`,
      modules: [module],
      trust: "high",
      createdBy: "human",
      chatId: CHAT,
    });
    await graph.updateMemoryNote(note.id, { confirmed: true });
  }
  const decoy = await graph.addMemoryNote({
    kind: "decision",
    text: "An unrelated module enforces idempotent charges too",
    modules: ["src/elsewhere/far.ts"],
    trust: "high",
    createdBy: "human",
    chatId: CHAT,
  });
  await graph.updateMemoryNote(decoy.id, { confirmed: true });
  const symbolNote = await graph.addMemoryNote({
    kind: "constraint",
    text: "chargeOnce must never retry without the request key",
    modules: [MODULES[0]!],
    symbols: [SYMBOL],
    trust: "high",
    createdBy: "human",
    chatId: CHAT,
  });
  await graph.updateMemoryNote(symbolNote.id, { confirmed: true });
  await graph.addMemoryNote({
    kind: "attempt",
    text: "Tried skipping the request key on module 00",
    modules: [MODULES[0]!],
    trust: "medium",
    createdBy: "agent:codex",
    chatId: CHAT,
  });
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("D6 — the round-trip count, COUNTED not assumed", () => {
  it("1 anchor and 42 anchors cost the SAME number of store calls", async () => {
    const spy = countingSpy(graph);
    try {
      spy.calls.length = 0;
      const one = await graph.recallForGate(
        { modules: [MODULES[0]!] },
        { limit: 500 }
      );
      const oneCalls = spy.calls.length;

      spy.calls.length = 0;
      const many = await graph.recallForGate({ modules: MODULES }, { limit: 500 });
      const manyCalls = spy.calls.length;

      // The claim, stated as the decision states it: FLAT in anchor count.
      expect(manyCalls).toBe(oneCalls);
      // …and it is ONE query, not "the same small number by luck".
      expect(manyCalls).toBe(1);
      // The 42-anchor read really did see 42 anchors' worth of notes, so the
      // equality above is not the equality of two empty reads.
      expect(one.length).toBeGreaterThan(0);
      expect(one.every((note) => note.modules.includes(MODULES[0]!))).toBe(true);
      expect(many.length).toBeGreaterThanOrEqual(ANCHOR_COUNT);
    } finally {
      spy.restore();
    }
  });

  it("both anchor NAMESPACES together cost one query PER NAMESPACE, still flat in anchor count", async () => {
    const spy = countingSpy(graph);
    try {
      spy.calls.length = 0;
      await graph.recallForGate(
        { modules: [MODULES[0]!], symbols: [SYMBOL] },
        { limit: 500 }
      );
      const few = spy.calls.length;

      spy.calls.length = 0;
      await graph.recallForGate(
        { modules: MODULES, symbols: [SYMBOL] },
        { limit: 500 }
      );
      expect(spy.calls.length).toBe(few);
      expect(few).toBe(2);
    } finally {
      spy.restore();
    }
  });

  it("the batched query binds a LIST parameter, so its TEXT is identical at 1 and 42 anchors", async () => {
    // Why this matters beyond aesthetics: a predicate assembled by interpolating
    // one clause per anchor is also one round trip, but its statement text grows
    // with the anchor count, so the prepared-statement cache never hits twice.
    //
    // `limit: 100` on both sides deliberately: the row CEILING is 200 for a
    // one-anchor recall and MAX_ANCHORED_ROWS for a batched one, so a limit above
    // 200 would clamp differently and the `LIMIT n` literal — the one part of the
    // statement that is interpolated — would differ for that reason instead. Under
    // the same effective cap the two statements must be byte-identical.
    const spy = countingSpy(graph);
    try {
      spy.calls.length = 0;
      await graph.recallForGate({ modules: [MODULES[0]!] }, { limit: 100 });
      const oneText = spy.calls[0];
      spy.calls.length = 0;
      await graph.recallForGate({ modules: MODULES }, { limit: 100 });
      expect(spy.calls[0]).toBe(oneText);
      expect(oneText).toContain("list_contains($anchorModules");
    } finally {
      spy.restore();
    }
  });
});

describe("D6 — the DIFFERENTIAL proof: a byte-identical governed row set", () => {
  /** ORACLE 1: the per-anchor fan-out D6 replaced. One governed recall per anchor,
   *  merged by id — literally what `preEditContext` used to do. */
  async function fanOutOracle(
    modules: string[],
    symbols: string[],
    opts?: { crewChatId?: string }
  ): Promise<MemoryNoteRecord[]> {
    const byId = new Map<string, MemoryNoteRecord>();
    for (const module of modules) {
      for (const note of await graph.recallForGate(
        { module, ...opts },
        { limit: 500 }
      )) {
        if (!byId.has(note.id)) {
          byId.set(note.id, note);
        }
      }
    }
    for (const symbol of symbols) {
      for (const note of await graph.recallForGate(
        { symbol, ...opts },
        { limit: 500 }
      )) {
        if (!byId.has(note.id)) {
          byId.set(note.id, note);
        }
      }
    }
    return [...byId.values()];
  }

  /** ORACLE 2: the AUTHORITY. Every governed note in the store, filtered in JS by
   *  `n.modules`/`n.symbols`. Independent of the `ANCHORED_TO` edge entirely, so
   *  this is the oracle that catches an access path that has drifted from the
   *  authority it is supposed to be an index of. */
  async function authorityOracle(
    modules: string[],
    symbols: string[],
    opts?: { crewChatId?: string }
  ): Promise<MemoryNoteRecord[]> {
    const all = await graph.recallForGate({ ...opts }, { limit: 200 });
    const anchors = normalizeAnchorSet({ modules, symbols });
    return all.filter((note) => noteMatchesAnchors(note, anchors));
  }

  const sorted = (notes: MemoryNoteRecord[]): string[] => ids(notes).sort();

  it("42 anchors: the batched query and the per-anchor fan-out return the SAME ORDERED id list", async () => {
    const batched = await graph.recallForGate(
      { modules: MODULES, symbols: [SYMBOL] },
      { limit: 500 }
    );
    const fanOut = await fanOutOracle(MODULES, [SYMBOL]);
    // The SET first, so a failure says which notes moved rather than only that
    // something did.
    expect(sorted(batched)).toEqual(sorted(fanOut));
    // Then the ORDER. The batched answer is `createdAt DESC, id ASC`; the fan-out
    // is per-anchor order, so it is re-sorted the same way — the claim is that the
    // two answer the same question, not that a fan-out has a global order.
    expect(ids(batched)).toEqual(
      [...fanOut]
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
        )
        .map((n) => n.id)
    );
  });

  it("42 anchors: the batched query (via the EDGE) equals the AUTHORITY arrays", async () => {
    const batched = await graph.recallForGate(
      { modules: MODULES, symbols: [SYMBOL] },
      { limit: 500 }
    );
    expect(sorted(batched)).toEqual(
      sorted(await authorityOracle(MODULES, [SYMBOL]))
    );
  });

  it("holds under the CREW-VISIBLE widening too, where the fan-out and the batch see an unconfirmed note", async () => {
    const batched = await graph.recallForGate(
      { modules: MODULES, symbols: [SYMBOL], crewChatId: CHAT },
      { limit: 500 }
    );
    expect(sorted(batched)).toEqual(
      sorted(await fanOutOracle(MODULES, [SYMBOL], { crewChatId: CHAT }))
    );
    expect(sorted(batched)).toEqual(
      sorted(await authorityOracle(MODULES, [SYMBOL], { crewChatId: CHAT }))
    );
    // The widening is really engaged: an unconfirmed note is in the answer.
    expect(batched.some((note) => !note.confirmed)).toBe(true);
  });

  it("anchor multiplicity does not EAT THE LIMIT — the row budget counts notes, not (note, anchor) pairs", async () => {
    // WHY THIS AND NOT ONLY THE `appears exactly once` TEST BELOW: the JS merge
    // dedupes by id, so duplicate ROWS are invisible in the answer — right up until
    // the `LIMIT` binds. Then three rows for one note consume three of the budget
    // and the caller gets ONE note where it asked for two. Dropping `RETURN
    // DISTINCT` kills THIS test and nothing else, which is why it exists.
    const mods = ["src/mult/a.ts", "src/mult/b.ts", "src/mult/c.ts"];
    const older = await graph.addMemoryNote({
      kind: "convention",
      text: "The older single-anchor note that the budget must still reach",
      modules: ["src/mult/d.ts"],
      trust: "high",
      createdBy: "human",
      chatId: CHAT,
    });
    await graph.updateMemoryNote(older.id, { confirmed: true });
    // NEWER, so its three duplicate rows sort FIRST under `createdAt DESC`.
    const newer = await graph.addMemoryNote({
      kind: "decision",
      text: "The newer note anchored to three of the four requested modules",
      modules: mods,
      trust: "high",
      createdBy: "human",
      chatId: CHAT,
    });
    await graph.updateMemoryNote(newer.id, { confirmed: true });

    const gated = await graph.recallForGate(
      { modules: [...mods, "src/mult/d.ts"] },
      { limit: 2 }
    );
    expect(ids(gated).sort()).toEqual([newer.id, older.id].sort());
  });

  it("a note carrying MANY of the requested anchors appears EXACTLY ONCE (the DISTINCT trap)", async () => {
    // Without `RETURN DISTINCT` the join emits one row per matching anchor, so
    // this note would be counted 3 times against the LIMIT and the answer would
    // silently be short.
    const multi = await graph.addMemoryNote({
      kind: "decision",
      text: "A note anchored to three of the requested modules at once",
      modules: [MODULES[1]!, MODULES[2]!, MODULES[3]!],
      trust: "high",
      createdBy: "human",
      chatId: CHAT,
    });
    await graph.updateMemoryNote(multi.id, { confirmed: true });
    const batched = await graph.recallForGate(
      { modules: MODULES },
      { limit: 500 }
    );
    expect(ids(batched).filter((id) => id === multi.id)).toEqual([multi.id]);
    expect(sorted(batched)).toEqual(sorted(await fanOutOracle(MODULES, [])));
  });

  it("the LIMIT still bounds the GOVERNED set: an OLD governed note is not crowded out by newer UNGOVERNED rows", async () => {
    // The completeness property `governedConditions` exists to hold, restated for
    // the anchor term. `hot` is the OLDEST note on this anchor and the only
    // governed one; ten newer unconfirmed notes follow it. A `LIMIT 1` applied to a
    // WIDER (ungoverned) set would return one of the newer ones and drop `hot`.
    const hot = "src/limit/hot.ts";
    const old = await graph.addMemoryNote({
      kind: "decision",
      text: "The oldest governed decision about the hot module",
      modules: [hot],
      trust: "high",
      createdBy: "human",
      chatId: CHAT,
    });
    await graph.updateMemoryNote(old.id, { confirmed: true });
    for (let index = 0; index < 10; index += 1) {
      await graph.addMemoryNote({
        kind: "attempt",
        text: `A newer ungoverned attempt ${index} on the hot module`,
        modules: [hot],
        trust: "low",
        createdBy: "agent:intruder",
        chatId: CHAT,
      });
    }
    const gated = await graph.recallForGate({ modules: [hot] }, { limit: 1 });
    expect(ids(gated)).toEqual([old.id]);
  });
});

describe("D6 — the anchor COMPLETENESS invariant", () => {
  it("reports complete on a healthy store, with count(ANCHORED_TO) == Σ size(n.modules)", async () => {
    const report = await graph.reconcileAnchorEdges();
    expect(report.modules.edges).toBe(report.modules.expected);
    expect(report.symbols.edges).toBe(report.symbols.expected);
    expect(report.modules.notesMissingEdges).toBe(0);
    expect(report.modules.orphanEdges).toBe(0);
    expect(report.complete).toBe(true);
    expect(report.repairedNotes).toBe(0);
  });

  it("DETECTS a suppressed ANCHORED_TO write, and the gate stops seeing the note (this is the lost memory D6 pays for)", async () => {
    const orphan = await graph.addMemoryNote({
      kind: "decision",
      text: "A note whose anchor edge is about to be deleted underneath it",
      modules: ["src/divergent/one.ts"],
      trust: "high",
      createdBy: "human",
      chatId: CHAT,
    });
    await graph.updateMemoryNote(orphan.id, { confirmed: true });
    expect(
      ids(await graph.recallForGate({ modules: ["src/divergent/one.ts"] }))
    ).toContain(orphan.id);

    // Drop the edge, exactly as a swallowed write failure would have.
    await (
      graph as unknown as {
        execute: (s: string, p: unknown) => Promise<unknown[]>;
      }
    ).execute(
      `MATCH (n:MemoryNote {id: $id})-[r:ANCHORED_TO]->(:Module) DELETE r`,
      { id: orphan.id }
    );

    const broken = await graph.reconcileAnchorEdges();
    expect(broken.complete).toBe(false);
    expect(broken.modules.edges).toBe(broken.modules.expected - 1);
    expect(broken.modules.notesMissingEdges).toBe(1);
    // THE COST, made visible: the note is still in `n.modules` and is invisible.
    expect(
      ids(await graph.recallForGate({ modules: ["src/divergent/one.ts"] }))
    ).not.toContain(orphan.id);
    // The AUTHORITY still says it is anchored — which is exactly why the
    // reconciler can repair from it.
    expect((await graph.getMemoryNote(orphan.id))?.modules).toEqual([
      "src/divergent/one.ts",
    ]);

    // Repair, and the gate sees it again.
    const repaired = await graph.reconcileAnchorEdges({ repair: true });
    expect(repaired.repairedNotes).toBe(1);
    expect((await graph.reconcileAnchorEdges()).complete).toBe(true);
    expect(
      ids(await graph.recallForGate({ modules: ["src/divergent/one.ts"] }))
    ).toContain(orphan.id);
  });

  it("DETECTS and repairs an ORPHAN edge — one the note's array does not justify", async () => {
    const note = await graph.addMemoryNote({
      kind: "decision",
      text: "A note about to gain an edge it never claimed",
      modules: ["src/divergent/two.ts"],
      trust: "high",
      createdBy: "human",
      chatId: CHAT,
    });
    const exec = (
      graph as unknown as {
        execute: (s: string, p: unknown) => Promise<unknown[]>;
      }
    ).execute.bind(graph);
    await exec(
      `MERGE (m:Module {path: $path}) ON CREATE SET m.lastTouchedAt = ''`,
      { path: "src/divergent/forged.ts" }
    );
    await exec(
      `MATCH (n:MemoryNote {id: $id}), (m:Module {path: $path})
       MERGE (n)-[:ANCHORED_TO]->(m)`,
      { id: note.id, path: "src/divergent/forged.ts" }
    );

    const broken = await graph.reconcileAnchorEdges();
    expect(broken.complete).toBe(false);
    expect(broken.modules.orphanEdges).toBe(1);
    const repaired = await graph.reconcileAnchorEdges({ repair: true });
    expect(repaired.repairedNotes).toBeGreaterThanOrEqual(1);
    expect((await graph.reconcileAnchorEdges()).complete).toBe(true);
  });

  it("a reconcile WITHOUT `repair` never writes — it reports and stops", async () => {
    const note = await graph.addMemoryNote({
      kind: "decision",
      text: "A note whose divergence must survive a report-only reconcile",
      modules: ["src/divergent/three.ts"],
      trust: "high",
      createdBy: "human",
      chatId: CHAT,
    });
    await (
      graph as unknown as {
        execute: (s: string, p: unknown) => Promise<unknown[]>;
      }
    ).execute(
      `MATCH (n:MemoryNote {id: $id})-[r:ANCHORED_TO]->(:Module) DELETE r`,
      { id: note.id }
    );
    const report = await graph.reconcileAnchorEdges();
    expect(report.complete).toBe(false);
    expect(report.repairedNotes).toBe(0);
    // Still broken: the report-only call changed nothing.
    expect((await graph.reconcileAnchorEdges()).complete).toBe(false);
    await graph.reconcileAnchorEdges({ repair: true });
    expect((await graph.reconcileAnchorEdges()).complete).toBe(true);
  });
});

describe("D4 — anchors and `q` COMPOSE, and the fence fails CLOSED", () => {
  it("the anchor filter is HARD: a text match outside the anchor set is excluded", async () => {
    // Every note in this corpus mentions "idempotent charges", including the
    // decoy anchored to `src/elsewhere/far.ts`. Anchored search must not return it.
    const anchored = await graph.searchMemory("idempotent charges request key", 50, {
      modules: [MODULES[0]!],
      governedOnly: true,
    });
    expect(anchored.length).toBeGreaterThan(0);
    for (const note of anchored) {
      expect(note.modules).toContain(MODULES[0]!);
    }
    // …and the same query WITHOUT the anchor does reach the decoy, so the
    // exclusion above is the anchor's doing and not the query's.
    const open = await graph.searchMemory(
      "idempotent charges request key",
      50,
      { governedOnly: true }
    );
    expect(open.some((note) => note.modules.includes("src/elsewhere/far.ts"))).toBe(
      true
    );
  });

  it("`q` RANKS within the anchor set, and the anchored set is a SUPERSET of the anchored-plus-text set", async () => {
    // THE EXACT SEMANTIC, pinned because the decision's phrasing ("`q` orders
    // within it") admits a stronger reading than what shipped, and the difference
    // is worth a test rather than a paragraph.
    //
    // WHAT SHIPPED: the four retrieval arms GENERATE candidates from `q`, and the
    // anchor set BOUNDS them. So an anchored+`q` read is (arms ∩ anchors), ranked by
    // fusion — a note on the anchor that no arm can see for this `q` is not a
    // candidate, exactly as it is not a candidate for an unanchored search.
    //
    // WHAT DID NOT SHIP, deliberately: making the anchored set itself a fifth RRF
    // arm, so that every anchored note is a candidate ranked by `q`. That is a NEW
    // RETRIEVAL ARM, which ADR-0021 §4.3 requires an ablation re-run for, and it is
    // not what D4's own cost column describes ("the anchor predicate must be pushed
    // into EVERY arm's candidate query" only makes sense if the arms still generate).
    const withQuery = await graph.searchMemory("chargeOnce retry", 50, {
      modules: [MODULES[0]!],
      symbols: [SYMBOL],
      governedOnly: true,
    });
    const withoutQuery = await graph.recallForGate({
      modules: [MODULES[0]!],
      symbols: [SYMBOL],
    });
    // Bounded by the anchor set, in both directions of the claim.
    expect(withQuery.length).toBeGreaterThan(0);
    expect(withQuery.length).toBeLessThanOrEqual(withoutQuery.length);
    const anchored = new Set(ids(withoutQuery));
    for (const note of withQuery) {
      expect(anchored.has(note.id)).toBe(true);
    }
    // And `q` decided the ORDER: the note that actually mentions `chargeOnce` is
    // first, not merely present.
    expect(withQuery[0]?.symbols).toContain(SYMBOL);
  });

  it("an anchor set the caller SUPPLIED but that is EMPTY returns NOTHING, never the whole corpus", async () => {
    // The fail-open this test exists to prevent: `{ modules: [] }` must not fall
    // back to the unanchored candidate query. A gate asked about a target with no
    // resolvable module has to come back empty.
    expect(await graph.recallForGate({ modules: [] }, { limit: 500 })).toEqual([]);
    expect(await graph.recallMemory({ modules: [], symbols: [] })).toEqual([]);
    expect(
      await graph.searchMemory("idempotent charges", 50, { modules: [] })
    ).toEqual([]);
    // …while supplying NO anchor key at all is still the unanchored read.
    expect((await graph.recallForGate({}, { limit: 500 })).length).toBeGreaterThan(
      0
    );
  });

  it("the pure predicate agrees with the query on all three fence states", () => {
    expect(anchorFenceIsEmpty(normalizeAnchorSet({}))).toBe(false);
    expect(anchorFenceIsEmpty(normalizeAnchorSet({ modules: [] }))).toBe(true);
    expect(anchorFenceIsEmpty(normalizeAnchorSet({ module: "   " }))).toBe(true);
    expect(anchorFenceIsEmpty(normalizeAnchorSet({ modules: ["a"] }))).toBe(false);
    expect(memoryAnchorArms(normalizeAnchorSet({}))).toEqual([]);
    expect(memoryAnchorArms(normalizeAnchorSet({ modules: ["a"] })).length).toBe(1);
    expect(
      memoryAnchorArms(normalizeAnchorSet({ modules: ["a"], symbols: ["b#c"] }))
        .length
    ).toBe(2);
    // The JS net's answer for each state must match the query's.
    const note = { modules: ["a"], symbols: [] };
    expect(noteMatchesAnchors(note, normalizeAnchorSet({}))).toBe(true);
    expect(noteMatchesAnchors(note, normalizeAnchorSet({ modules: [] }))).toBe(
      false
    );
    expect(noteMatchesAnchors(note, normalizeAnchorSet({ modules: ["a"] }))).toBe(
      true
    );
    expect(noteMatchesAnchors(note, normalizeAnchorSet({ modules: ["z"] }))).toBe(
      false
    );
  });

  it("the singular `module` and the plural `modules` are the SAME question", async () => {
    expect(ids(await graph.recallForGate({ module: MODULES[0]! }))).toEqual(
      ids(await graph.recallForGate({ modules: [MODULES[0]!] }))
    );
  });
});

describe("D4 — the FTS/semantic INTERSECTION (the arms that take no WHERE)", () => {
  let ftsDir: string;
  let ftsGraph: MuonGraph;
  const HERE = "src/fts/here.ts";
  const THERE = "src/fts/there.ts";
  let hereId = "";
  let thereId = "";

  beforeEach(() => undefined);

  beforeAll(async () => {
    ftsDir = mkdtempSync(join(tmpdir(), "muon-conj-fts-"));
    // FTS ARMED (no `disableFts`) plus a deterministic fake embedder, so BOTH arms
    // that cannot carry a WHERE predicate are live. Without this the intersection
    // is untested — which is the whole hard part of D4.
    ftsGraph = new MuonGraph(join(ftsDir, "fts.lbug"), {
      embedder: {
        id: "test-fake",
        async embed(texts: string[]) {
          // A crude bag-of-chars vector: deterministic, no network, and it makes
          // any two notes with similar text similar in this space.
          return texts.map((text) => {
            const vec = new Array(26).fill(0);
            for (const ch of text.toLowerCase()) {
              const i = ch.charCodeAt(0) - 97;
              if (i >= 0 && i < 26) {
                vec[i] += 1;
              }
            }
            return vec;
          });
        },
      },
    });
    await ftsGraph.init();
    const here = await ftsGraph.addMemoryNote({
      kind: "decision",
      text: "Idempotency keys are derived from the payment intent",
      modules: [HERE],
      trust: "high",
      createdBy: "human",
    });
    await ftsGraph.updateMemoryNote(here.id, { confirmed: true });
    hereId = here.id;
    const there = await ftsGraph.addMemoryNote({
      kind: "decision",
      text: "Idempotency keys are derived from the payment intent elsewhere",
      modules: [THERE],
      trust: "high",
      createdBy: "human",
    });
    await ftsGraph.updateMemoryNote(there.id, { confirmed: true });
    thereId = there.id;
  });

  afterAll(async () => {
    await ftsGraph.close();
    rmSync(ftsDir, { recursive: true, force: true });
  });

  it("an FTS/dense candidate from OUTSIDE the anchor set is intersected away", async () => {
    // Both notes are near-identical text, so both arms surface both. Only the
    // anchored one may come back.
    const open = await ftsGraph.searchMemory("idempotency keys payment intent", 20);
    expect(ids(open).sort()).toEqual([hereId, thereId].sort());

    const fenced = await ftsGraph.searchMemory(
      "idempotency keys payment intent",
      20,
      { modules: [HERE] }
    );
    expect(ids(fenced)).toEqual([hereId]);
  });

  it("the intersection runs BEFORE the final `slice(limit)` — filtering after it would truncate the answer", async () => {
    // THE COMPLETENESS PROPERTY, for the anchor term. Ten UNANCHORED notes that
    // match the query STRICTLY BETTER than the anchored one (they carry the extra
    // token `sharded`, which `here` does not), and `limit: 1`. If the anchor net ran
    // after `slice(0, limit)` the single surviving row would be an unanchored note,
    // the filter would drop it, and the caller would get [] while an anchored answer
    // existed. Order of the two operations is the whole assertion.
    for (let index = 0; index < 10; index += 1) {
      const noise = await ftsGraph.addMemoryNote({
        kind: "decision",
        text: `Sharded idempotency keys payment intent sharded variant ${index}`,
        modules: [`src/fts/noise${index}.ts`],
        trust: "high",
        createdBy: "human",
      });
      await ftsGraph.updateMemoryNote(noise.id, { confirmed: true });
    }
    const QUERY = "sharded idempotency keys payment intent";
    // FIRST establish that `here` is NOT the top-ranked candidate for this query,
    // so the assertion below actually exercises the ordering. Without this the test
    // passes whenever `here` happens to rank first and proves nothing.
    const unfencedTop = await ftsGraph.searchMemory(QUERY, 1);
    expect(unfencedTop.length).toBe(1);
    expect(unfencedTop[0]!.id).not.toBe(hereId);
    expect(unfencedTop[0]!.modules[0]).toMatch(/^src\/fts\/noise/);

    const fenced = await ftsGraph.searchMemory(QUERY, 1, { modules: [HERE] });
    expect(fenced.map((n) => n.id)).toEqual([hereId]);
  });

  it(
    "the intersection is a SET INTERSECTION, not a wider FTS `top` — the arm's bound is unchanged",
    async ({ skip }) => {
      if (!(ftsGraph as unknown as { ftsEnabled: boolean }).ftsEnabled) {
        skip(
          "LadybugDB FTS is unavailable in this runtime; the dense intersection remains covered above."
        );
      }
      // Proof by statement text: the anchored search must not have widened the FTS
      // arm's `top` to compensate for filtering afterwards. `top` is `$ftsTop`, bound
      // to `pool`, and `pool` is a function of `limit` alone — never of the anchor
      // count.
      const spy = countingSpy(ftsGraph);
      try {
        spy.calls.length = 0;
        await ftsGraph.searchMemory("idempotency keys", 7);
        const openFts = spy.calls.filter((s) => s.includes("QUERY_FTS_INDEX"));
        spy.calls.length = 0;
        await ftsGraph.searchMemory("idempotency keys", 7, {
          modules: [HERE],
        });
        const fencedFts = spy.calls.filter((s) =>
          s.includes("QUERY_FTS_INDEX")
        );
        expect(fencedFts.length).toBe(1);
        expect(fencedFts[0]).toBe(openFts[0]);
      } finally {
        spy.restore();
      }
    }
  );

  it("the anchored LEXICAL and ENTITY arms carry the term in their OWN candidate queries", async () => {
    const spy = countingSpy(ftsGraph);
    try {
      spy.calls.length = 0;
      // A query with a path-shaped token so the R2 entity extractor yields keys and
      // the entity arm actually runs; otherwise its clause is untested.
      await ftsGraph.searchMemory(`idempotency keys ${HERE}`, 7, {
        modules: [HERE],
      });
      const anchored = spy.calls.filter((s) =>
        s.includes("list_contains($anchorModules")
      );
      // The LEXICAL arm is the one that guarantees completeness under an anchor
      // filter, so its query MUST hold the anchor term rather than lean on the net.
      const lexical = anchored.filter((s) => !s.includes("MENTIONS"));
      expect(lexical.length).toBe(1);
      expect(lexical[0]).toContain("-[:ANCHORED_TO]->(anchorModule:Module)");
      // The ENTITY arm joins the SAME `n` through a second comma-separated pattern,
      // and projects DISTINCT so anchor multiplicity cannot eat its row budget.
      const entity = anchored.filter((s) => s.includes("MENTIONS"));
      expect(entity.length).toBe(1);
      expect(entity[0]).toContain(", (n)-[:ANCHORED_TO]->(anchorModule:Module)");
      expect(entity[0]).toContain("RETURN DISTINCT");
    } finally {
      spy.restore();
    }
  });

  it("ADR-0026: the WORKSPACE fence still covers an FTS/dense candidate under an anchor filter", async () => {
    // The two nets are independent, and an anchored read must not become a way to
    // bypass either. Same anchor, foreign workspace → nothing.
    const foreign = await ftsGraph.searchMemory(
      "idempotency keys payment intent",
      20,
      { modules: [HERE], workspacePath: "/repo/elsewhere" }
    );
    expect(foreign).toEqual([]);
    // And the residue view (these notes carry no workspace) still returns it.
    const residue = await ftsGraph.searchMemory(
      "idempotency keys payment intent",
      20,
      { modules: [HERE], unscopedWorkspace: true }
    );
    expect(ids(residue)).toEqual([hereId]);
  });

  it("the CHAT partition still covers an FTS/dense candidate under an anchor filter", async () => {
    const foreign = await ftsGraph.searchMemory(
      "idempotency keys payment intent",
      20,
      { modules: [HERE], chatId: "some-other-chat" }
    );
    // These notes are NULL-chat and unpromoted, so a chat-scoped read sees none.
    expect(foreign).toEqual([]);
  });
});
