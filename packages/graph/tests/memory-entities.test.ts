import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_ENTITIES_PER_NOTE,
  MAX_ENTITY_CHARS,
  MAX_ENTITY_SCAN_CHARS,
  MAX_QUERY_ENTITIES,
  PATH_RE,
  SYMBOL_RE,
  extractEntities,
  extractQueryEntities,
  isPathShaped,
  pathShapedTokens,
  rankByEntityMentions,
} from "../src/memory-entities.js";
import { MuonGraph } from "../src/muon-graph.js";

/**
 * R2 entity extraction + linking (mem0 §5.3, ported signal / MUON fusion).
 *
 * The extractor runs on UNTRUSTED agent-authored note text, and its output
 * becomes a retrieval join key, so the tests below are weighted towards the two
 * things that would actually hurt: unbounded work on hostile input, and an
 * entity match leaking a note the caller is not allowed to read.
 */

const keys = (text: string): string[] =>
  extractEntities(text).map((entity) => entity.key);

const kinds = (text: string): string[] =>
  extractEntities(text).map((entity) => `${entity.kind}:${entity.key}`);

describe("entity classes", () => {
  it("extracts a symbol id AS its id, its path, AND its bare name", () => {
    // This three-way emission is the whole point of the class: a query naming
    // `mod.ts#fn` has to reach a note whose prose only ever says `fn`.
    expect(kinds("see packages/runner/src/execute.ts#runCommand for the rule")).toEqual([
      "symbol:packages/runner/src/execute.ts#runcommand",
      "path:packages/runner/src/execute.ts",
      "identifier:runcommand",
    ]);
  });

  it("extracts paths with a separator and bare files with a code extension", () => {
    expect(keys("backend/src/lib/preedit.ts changed")).toContain(
      "backend/src/lib/preedit.ts"
    );
    expect(keys("check electron-builder.yml first")).toContain(
      "electron-builder.yml"
    );
    // Prose ending a sentence must not become a path.
    expect(keys("that is the rule.")).toEqual([]);
  });

  it("extracts identifiers only when they carry INTERNAL structure", () => {
    // Structure (case transition or _ / -) is what keeps English out.
    expect(keys("the retryPolicy is shared")).toContain("retrypolicy");
    expect(keys("set RETRY_POLICY globally")).toContain("retrypolicy");
    expect(keys("use the retry-policy value")).toContain("retrypolicy");
    // ...and all three normalise to the SAME key. That is the match neither the
    // stemmer nor the substring scan can make, and it is the reason the entity
    // signal earns its round-trip at all.
    expect(keys("the retryPolicy is shared")[0]).toBe(
      keys("set RETRY_POLICY globally")[0]
    );
    // A plain English word is not an identifier.
    expect(keys("the retry is shared")).not.toContain("retry");
  });

  it("extracts error / exit / status codes, case-SENSITIVELY", () => {
    expect(keys("throws ENOENT on the first probe")).toContain("enoent");
    expect(keys("killed by SIGKILL reports exit 137")).toEqual(
      expect.arrayContaining(["sigkill", "exit 137"])
    );
    expect(keys("a vendor returning HTTP 429 must back off")).toContain(
      "http 429"
    );
    // REGRESSION: an `i` flag on `E[A-Z]{3,}` turns it into "any word starting
    // with e" and silently classifies ordinary English as error codes. That bug
    // shipped `error:edit`, `error:enters` and `error:every` before it was caught.
    for (const word of ["edit", "enters", "every", "even", "engine", "extra"]) {
      expect(kinds(`we ${word} the thing`)).not.toContain(`error:${word}`);
    }
  });

  it("extracts proper nouns, including a sentence-initial one", () => {
    // A POSITIONAL "drop whatever starts the sentence" rule was tried first and
    // was wrong: engineering notes routinely open on the product name itself,
    // and it threw away the single most useful entity in each.
    expect(keys("Ollama silently downloads a missing default model")).toContain(
      "ollama"
    );
    expect(keys("Postgres stays the hosted ledger")).toContain("postgres");
    // But a leading function word is still grammar, not evidence.
    expect(keys("The Stripe webhook retry policy")).toContain("stripe");
    expect(keys("The Stripe webhook retry policy")).not.toContain("the stripe");
    expect(keys("Every panel needs an empty state")).not.toContain("every");
  });

  it("does not open a quoted span on an English apostrophe", () => {
    // REGRESSION: the naive `'([^'\n]{3,64})'` arm treats apostrophes as quotes,
    // so "the daemon's cwd, not the task's" captured a whole sentence fragment.
    const extracted = keys(
      "a relative one resolves against the daemon's working directory, not the task's worktree"
    );
    for (const key of extracted) {
      expect(key).not.toContain("working directory, not the task");
    }
    // A real quoted literal still works.
    expect(keys('pass the "--oss" flag')).toContain("--oss");
  });
});

describe("bounds on untrusted text", () => {
  it("caps entities per note and per query", () => {
    const hostile = Array.from(
      { length: 400 },
      (_, index) => `someIdentifier${index}`
    ).join(" ");
    expect(extractEntities(hostile).length).toBeLessThanOrEqual(
      MAX_ENTITIES_PER_NOTE
    );
    expect(extractQueryEntities(hostile).length).toBeLessThanOrEqual(
      MAX_QUERY_ENTITIES
    );
  });

  it("caps entity length and rejects fragments that are too short", () => {
    const long = `a${"b".repeat(MAX_ENTITY_CHARS * 3)}Tail`;
    for (const key of keys(long)) {
      expect(key.length).toBeLessThanOrEqual(MAX_ENTITY_CHARS);
    }
    expect(keys("a-b")).toEqual([]);
  });

  it("bounds the text it scans, so a pasted blob cannot make ingest superlinear", () => {
    const blob = `${"x".repeat(MAX_ENTITY_SCAN_CHARS)} tailIdentifier`;
    // The tail is past the scan window, so it is never seen.
    expect(keys(blob)).not.toContain("tailidentifier");
    const started = performance.now();
    extractEntities("z".repeat(200_000));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("is deterministic and total: same input, same output; junk input, no throw", () => {
    const text = "runCommand in packages/runner/src/execute.ts#runCommand hit ENOENT";
    expect(extractEntities(text)).toEqual(extractEntities(text));
    for (const junk of ["", "   ", "\u0000\u0000", "((((", "'''", "```"]) {
      expect(() => extractEntities(junk)).not.toThrow();
    }
    // Non-string input must degrade, not crash (the ledger's text is `unknown`
    // shaped at some boundaries).
    expect(extractEntities(undefined as unknown as string)).toEqual([]);
  });

  it("dedups: repeating an entity does not multiply it", () => {
    expect(keys("retryPolicy retryPolicy RETRY_POLICY retry-policy")).toEqual([
      "retrypolicy",
    ]);
  });
});

describe("rankByEntityMentions", () => {
  const mention = (noteId: string, entityKey: string, createdAt = "2026-01-01") => ({
    noteId,
    entityKey,
    createdAt,
  });

/**
 * A FLAT corpus: every key equally rare, so `entityIdf` is the same constant for
 * all of them. These three cases are about distinct-counting, query filtering and
 * total ordering — NOT about the D-mem0-1 popularity discount, which has its own
 * file (`memory-entity-idf.test.ts`). Holding df flat keeps each test measuring
 * the one property it was written for.
 */
const FLAT_CORPUS = { df: new Map<string, number>(), activeNotes: 100 };

  it("scores by summed weight of DISTINCT matched entities, not by repetition", () => {
    const queryEntities = extractQueryEntities(
      "packages/runner/src/execute.ts#runCommand"
    );
    const ranked = rankByEntityMentions(
      [
        // `n-two` matches two distinct query entities.
        mention("n-two", "packages/runner/src/execute.ts"),
        mention("n-two", "runcommand"),
        // `n-one` repeats a single one; repetition must buy nothing.
        mention("n-one", "runcommand"),
        mention("n-one", "runcommand"),
        mention("n-one", "runcommand"),
      ],
      queryEntities,
      10,
      FLAT_CORPUS
    );
    expect(ranked).toEqual(["n-two", "n-one"]);
  });

  it("ignores mentions of entities the query never asked for", () => {
    expect(
      rankByEntityMentions(
        [mention("n-a", "somethingelse")],
        extractQueryEntities("retryPolicy"),
        10,
        FLAT_CORPUS
      )
    ).toEqual([]);
  });

  it("is totally ordered, so equal scores never rank nondeterministically", () => {
    const queryEntities = extractQueryEntities("retryPolicy");
    const rows = [
      mention("n-b", "retrypolicy", "2026-01-01"),
      mention("n-a", "retrypolicy", "2026-01-01"),
    ];
    // Same score, same createdAt → id breaks the tie, both orderings agree.
    expect(rankByEntityMentions(rows, queryEntities, 10, FLAT_CORPUS)).toEqual([
      "n-a",
      "n-b",
    ]);
    expect(
      rankByEntityMentions([...rows].reverse(), queryEntities, 10, FLAT_CORPUS)
    ).toEqual([
      "n-a",
      "n-b",
    ]);
  });
});

describe("real store: entity linking end to end", () => {
  it("links a note by an entity in its PROSE that no anchor would have caught", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muon-entity-"));
    const graph = new MuonGraph(join(dir, "e.lbug"), { disableFts: true });
    try {
      await graph.init();
      // The motivating case: NO module, NO symbol — invisible to anchor-based
      // recall by construction.
      const anchorless = await graph.addMemoryNote({
        kind: "constraint",
        text: "The Stripe webhook retry policy needs idempotency keys, or a retried charge double-bills.",
        createdBy: "agent:claude",
      });
      await graph.addMemoryNote({
        kind: "convention",
        text: "Panels need an explicit empty state before they ship.",
        createdBy: "agent:claude",
      });

      const hits = await graph.searchMemory("Stripe idempotency", 10);
      expect(hits.map((note) => note.id)).toContain(anchorless.id);
    } finally {
      await graph.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("an entity match NEVER crosses the #126 chat partition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muon-entity-chat-"));
    const graph = new MuonGraph(join(dir, "e.lbug"), { disableFts: true });
    try {
      await graph.init();
      const other = await graph.addMemoryNote({
        kind: "constraint",
        text: "The Stripe webhook retry policy needs idempotency keys.",
        chatId: "chat-other",
        createdBy: "agent:claude",
      });
      // Searching from a DIFFERENT chat must not surface it, even though the
      // entity `stripe` matches perfectly. The entity join carries the caller's
      // visibility predicate, so it can only ever return what lexical could.
      const scoped = await graph.searchMemory("Stripe idempotency", 10, {
        chatId: "chat-mine",
      });
      expect(scoped.map((note) => note.id)).not.toContain(other.id);
      // Same query, own chat → visible, so the negative above is the partition
      // doing its job rather than the entity index simply being empty.
      const own = await graph.searchMemory("Stripe idempotency", 10, {
        chatId: "chat-other",
      });
      expect(own.map((note) => note.id)).toContain(other.id);
    } finally {
      await graph.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("an entity match NEVER escapes the confirmed-only gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muon-entity-gate-"));
    const graph = new MuonGraph(join(dir, "e.lbug"), { disableFts: true });
    try {
      await graph.init();
      const unconfirmed = await graph.addMemoryNote({
        kind: "constraint",
        text: "The Stripe webhook retry policy needs idempotency keys.",
        trust: "low",
        createdBy: "agent:rogue",
      });
      const gated = await graph.searchMemory("Stripe idempotency", 10, {
        governedOnly: true,
      });
      expect(gated.map((note) => note.id)).not.toContain(unconfirmed.id);
      for (const note of gated) {
        expect(note.confirmed).toBe(true);
      }
      // And the ungated read DOES find it — so the gate is what excluded it.
      const open = await graph.searchMemory("Stripe idempotency", 10);
      expect(open.map((note) => note.id)).toContain(unconfirmed.id);
    } finally {
      await graph.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("re-projection REPLACES a note's entities instead of accumulating them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muon-entity-reproject-"));
    const graph = new MuonGraph(join(dir, "e.lbug"), { disableFts: true });
    try {
      await graph.init();
      const created = await graph.addMemoryNote({
        kind: "decision",
        text: "Ollama is the default embedder.",
        createdBy: "human:founder",
      });
      expect(
        (await graph.searchMemory("Ollama", 10)).map((note) => note.id)
      ).toContain(created.id);

      // Re-project the SAME id with different text. The old entity must go.
      const record = (await graph.getMemoryNote(created.id))!;
      await graph.projectMemoryNote({
        ...record,
        text: "Postgres is the hosted ledger.",
      });
      const stale = await graph.searchMemory("Ollama", 10);
      expect(stale.map((note) => note.id)).not.toContain(created.id);
      const fresh = await graph.searchMemory("Postgres", 10);
      expect(fresh.map((note) => note.id)).toContain(created.id);
    } finally {
      await graph.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ── D15 / memory-index-validation.md §1.3: the exported path predicate ────────
//
// `pathShapedTokens` and `isPathShaped` exist so THREE consumers ask one question
// once: the entity extractor (this file), D15's coordinate promoter
// (`backend/src/lib/anchor-promotion.ts`) and the health harness's rows 18 and 22.
// The property that makes them worth exporting is the one asserted first: they
// return the SURFACE spelling, where an entity key is lower-cased. A promoter built
// on the lower-cased key forks the anchor namespace by case, and
// `preEditContext`'s exact-string membership test then finds nothing.

describe("the exported path predicate (D15)", () => {
  it("returns the SURFACE spelling, where the entity key is LOWERCASED", () => {
    const text = "apps/cli/README.md is the one the founder reads";
    // The same token, through the two namespaces, differing only in case — this is
    // the measured fork: `apps/cli/readme.md` is a live `Entity` key and
    // `apps/cli/README.md` is a live `Module` anchor, for one file.
    expect(keys(text)).toContain("apps/cli/readme.md");
    expect(pathShapedTokens(text)).toEqual(["apps/cli/README.md"]);
  });

  it("yields a symbol id's MODULE PREFIX, matching the extractor's symbol arm", () => {
    expect(
      pathShapedTokens("packages/runner/src/Execute.ts#runCommand is the seam")
    ).toEqual(["packages/runner/src/Execute.ts"]);
  });

  it("dedupes on the surface form and keeps extraction order", () => {
    expect(
      pathShapedTokens("b/two.ts then a/one.ts then b/two.ts again")
    ).toEqual(["b/two.ts", "a/one.ts"]);
  });

  it("is bounded by the entity scan window by DEFAULT, and opts out explicitly", () => {
    // The bound is a write-path guard (untrusted note text; `PATH_RE`'s
    // `(?:segment/)+` can be made to backtrack), which is why the default is the
    // extractor's own window and the opt-out has to be spelled.
    const buried = `${"x".repeat(MAX_ENTITY_SCAN_CHARS)} late/file.ts`;
    expect(pathShapedTokens(buried)).toEqual([]);
    expect(pathShapedTokens(buried, buried.length)).toEqual(["late/file.ts"]);
  });

  it("finds nothing in prose, and nothing in an empty or non-string input", () => {
    expect(pathShapedTokens("that is the rule.")).toEqual([]);
    expect(pathShapedTokens("")).toEqual([]);
    expect(pathShapedTokens(undefined as unknown as string)).toEqual([]);
  });

  it("isPathShaped is a WHOLE-value test, so a trailing `:line` is not a path", () => {
    expect(isPathShaped("backend/src/lib/preedit.ts")).toBe(true);
    expect(isPathShaped("electron-builder.yml")).toBe(true);
    // Row 18 counts `#`-bearing keys separately: a symbol id CONTAINS a path, it is
    // not one.
    expect(isPathShaped("a/b.ts#fn")).toBe(false);
    expect(isPathShaped("backend/src/lib/preedit.ts:383")).toBe(false);
    expect(isPathShaped("two a/b.ts paths c/d.ts")).toBe(false);
    expect(isPathShaped("gitnexus")).toBe(false);
    expect(isPathShaped("")).toBe(false);
  });

  it("is STATELESS across calls, unlike the `g` regexes it is built on", () => {
    // A bare `PATH_RE.test(x)` in a loop skips alternate inputs because `lastIndex`
    // survives the call. Both helpers reset it (via `sweep`), and this is the test
    // that catches a future implementation that stops doing so.
    //
    // The two loops are SEPARATE deliberately: interleaving them masks the bug,
    // because `pathShapedTokens` resets `lastIndex` on the way through `sweep`, so a
    // stateful `isPathShaped` beside it looks clean. (Measured — the first version of
    // this test interleaved them and a stateful-`isPathShaped` mutation survived it.)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(isPathShaped("a/b.ts")).toBe(true);
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(pathShapedTokens("a/b.ts")).toEqual(["a/b.ts"]);
    }
    expect(PATH_RE.lastIndex).toBe(0);
    expect(SYMBOL_RE.lastIndex).toBe(0);
  });
});
