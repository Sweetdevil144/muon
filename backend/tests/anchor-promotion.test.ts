import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MuonGraph, type MemoryNoteInput } from "@muon/graph";
import {
  promoteResolvedPathEntities,
  type PromotedCoordinates,
} from "../src/lib/anchor-promotion.js";
import {
  clearTrackedFileCache,
  coordinateResolverFor,
} from "../src/lib/anchor-resolution.js";
import { preEditContext } from "../src/lib/preedit.js";

// D15 (docs/design/memory-index-decisions.md §D15, option B) — the promoter itself,
// against real git repositories and a real `git ls-files`. Nothing is stubbed,
// because the defect being closed is a property of git and of the filesystem: an
// entity key is LOWERCASED, a module anchor is VERBATIM, and on APFS a `stat` of the
// wrong spelling succeeds — so a promoter that trusted the note's own spelling, or
// the entity namespace's, would fork the anchor namespace by case.
//
// The last describe block is the one that matters most: it drives the REAL
// `preEditContext` over a promoted anchor. Promoting the lowercased key instead of
// the tracked spelling makes that test fail and nothing else, which is exactly why
// it exists — every other assertion here would still pass with the case bug in.

/** Committed in `repo` before anything runs. Mixed case ON PURPOSE: this is the
 *  measured shape (`apps/cli/README.md` is a live module anchor and
 *  `apps/cli/readme.md` is a live `Entity` key, for one file). */
const TRACKED = "src/pay/Charge.ts";
const TRACKED_LOWER = "src/pay/charge.ts";

let dir: string;
let repo: string;
let plain: string;
/** Is this volume case-insensitive? Probed, not assumed — the APFS hazard only
 *  exists on one, and a Linux CI ext4 volume needs a different assertion. */
let caseInsensitive = false;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "muon",
      GIT_AUTHOR_EMAIL: "muon@example.invalid",
      GIT_COMMITTER_NAME: "muon",
      GIT_COMMITTER_EMAIL: "muon@example.invalid",
    },
  });
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-anchor-promo-")));
  repo = path.join(dir, "repo");
  plain = path.join(dir, "plain");
  mkdirSync(path.join(repo, "src", "pay"), { recursive: true });
  mkdirSync(plain, { recursive: true });

  git(repo, "init", "--initial-branch=main");
  writeFileSync(path.join(repo, TRACKED), "export const charge = 1;\n");
  writeFileSync(path.join(repo, "README.md"), "repo\n");
  git(repo, "add", TRACKED, "README.md");
  git(repo, "commit", "-m", "init");
  caseInsensitive = existsSync(path.join(repo, TRACKED_LOWER));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clearTrackedFileCache();
});

const promote = async (
  text: string,
  workspacePath: string | null
): Promise<PromotedCoordinates> =>
  promoteResolvedPathEntities(
    text,
    await coordinateResolverFor({ workspacePath })
  );

describe("D15 promotion: what becomes a coordinate", () => {
  it("promotes a path the note spells EXACTLY as the repository does", async () => {
    const promoted = await promote(
      `the retry cap lives in ${TRACKED} and nowhere else`,
      repo
    );
    expect(promoted).toEqual({ modules: [TRACKED], ambiguous: [] });
  });

  it("REPAIRS THE CASE: the tracked spelling wins over the note's", async () => {
    // The whole decision in one assertion. The note names the file the way the
    // entity namespace would have keyed it (lower case); the anchor must be the
    // REPOSITORY's spelling, or `preEditContext`'s exact-string membership test
    // misses it (see the last block).
    const promoted = await promote(`see ${TRACKED_LOWER} for the cap`, repo);
    expect(promoted.modules).toEqual([TRACKED]);
    // And the hazard is real on this volume rather than hypothetical: a `stat` of
    // the wrong spelling SUCCEEDS here, which is why D1 resolves against the git
    // index and never against the filesystem.
    if (caseInsensitive) {
      expect(existsSync(path.join(repo, TRACKED_LOWER))).toBe(true);
    }
  });

  it("promotes a symbol id's MODULE, so prose naming a symbol anchors its file", async () => {
    // Measured caveat, pinned here: 0 live entities contain `#`, so this arm has
    // never fired on real data. It is the same reduction `effectiveModules` makes.
    const promoted = await promote(`${TRACKED}#charge is idempotent`, repo);
    expect(promoted.modules).toEqual([TRACKED]);
  });

  it("promotes NOTHING for a path that is not tracked here — including another repo's", async () => {
    const other = path.join(dir, "other-repo");
    mkdirSync(path.join(other, "elsewhere"), { recursive: true });
    git(other, "init", "--initial-branch=main");
    writeFileSync(path.join(other, "elsewhere", "only.ts"), "export {};\n");
    git(other, "add", "elsewhere/only.ts");
    git(other, "commit", "-m", "init");

    // 37 of the 60 live path-shaped entity keys are ANOTHER repository's paths.
    // Promoting them "would fill the coordinate layer with junk faster than any
    // agent ever could" — this is the assertion that says we do not.
    const promoted = await promote(
      "elsewhere/only.ts and src/pay/typo.ts are named in prose",
      repo
    );
    expect(promoted.modules).toEqual([]);
    clearTrackedFileCache();
    // ...and the same prose DOES promote in the repo that tracks it, so the
    // assertion above is about the tracked set and not about the extractor.
    expect((await promote("elsewhere/only.ts", other)).modules).toEqual([
      "elsewhere/only.ts",
    ]);
  });

  it("promotes NOTHING without a tracked set: no workspace, a non-repo, no resolver", async () => {
    // D1's NULL state. We hold no set, so we make no claim — the same direction
    // `resolutionOf` takes, and the reason an imported pack (a foreign workspace's
    // paths, no local partition) promotes nothing at all.
    expect((await promote(`about ${TRACKED}`, null)).modules).toEqual([]);
    clearTrackedFileCache();
    expect((await promote(`about ${TRACKED}`, plain)).modules).toEqual([]);
    expect(promoteResolvedPathEntities(`about ${TRACKED}`, undefined)).toEqual({
      modules: [],
      ambiguous: [],
    });
  });

  it("dedupes two spellings of ONE file into one coordinate", async () => {
    const promoted = await promote(
      `${TRACKED} and ${TRACKED_LOWER} are the same file`,
      repo
    );
    expect(promoted.modules).toEqual([TRACKED]);
  });

  it("does not read past the ENTITY namespace's scan window", async () => {
    // The coordinate layer never sees text the entity layer would not have. The cost
    // is stated in the harness: row 22 measures the WHOLE note, so a note naming its
    // only tracked path past 4 000 characters counts as an orphan the backfill will
    // not fix. It cannot bite today (the longest live note is 3 172 characters).
    const buried = `${"x".repeat(5_000)} ${TRACKED}`;
    expect((await promote(buried, repo)).modules).toEqual([]);
    // The same text INSIDE the window promotes, so the assertion above is about the
    // bound and not about the tracked-set check.
    expect((await promote(`${"x".repeat(100)} ${TRACKED}`, repo)).modules).toEqual([
      TRACKED,
    ]);
  });

  it("is BOUNDED: a pasted file listing cannot anchor a note to the whole repo", async () => {
    // A pasted `git ls-files` dump is a realistic input from an agent-authored note.
    const files = Array.from({ length: 40 }, (_, index) => `bulk${index}.ts`);
    for (const file of files) {
      writeFileSync(path.join(repo, file), "export {};\n");
      git(repo, "add", "--", file);
    }
    clearTrackedFileCache();
    const promoted = await promote(files.join(" "), repo);
    // Every one of the 40 IS tracked, so the cap is the only thing bounding this —
    // without it this note would anchor to forty files.
    const tracked = (await coordinateResolverFor({ workspacePath: repo })).tracked;
    expect(files.every((file) => tracked!.has(file))).toBe(true);
    // MAX_ENTITIES_PER_NOTE: a note that can mint at most 12 entities must not be
    // able to mint more coordinates than that.
    expect(promoted.modules.length).toBe(12);
    expect(promoted.modules[0]).toBe("bulk0.ts");
  });
});

describe("D15 promotion: the case fold REFUSES an ambiguous match", () => {
  /** Two paths differing only by case, both in the git INDEX. `update-index` is what
   *  makes this constructible on a case-INSENSITIVE volume, where the worktree
   *  cannot hold both — and the index is what `git ls-files` reads, so the hazard is
   *  real for us even here. */
  let ambiguousRepo: string;

  beforeAll(() => {
    ambiguousRepo = path.join(dir, "ambiguous-repo");
    mkdirSync(path.join(ambiguousRepo, "a"), { recursive: true });
    git(ambiguousRepo, "init", "--initial-branch=main");
    writeFileSync(path.join(ambiguousRepo, "a", "Case.ts"), "export {};\n");
    git(ambiguousRepo, "add", "a/Case.ts");
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: ambiguousRepo,
      input: "export {};\n",
      encoding: "utf8",
    }).trim();
    git(
      ambiguousRepo,
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob},a/case.ts`
    );
    git(ambiguousRepo, "commit", "-m", "init");
  });

  it("REFUSES rather than guesses when two tracked paths fold together", async () => {
    // Picking one would be a genuine mis-identification: an anchor pointing at a
    // file the note did not name, inside the layer the pre-edit gate trusts.
    const promoted = await promote("a/CASE.ts holds the rule", ambiguousRepo);
    expect(promoted.modules).toEqual([]);
    expect(promoted.ambiguous).toEqual(["a/case.ts"]);
  });

  it("but an EXACT tracked spelling still wins — that is evidence, not a guess", async () => {
    for (const spelling of ["a/Case.ts", "a/case.ts"]) {
      clearTrackedFileCache();
      const promoted = await promote(`${spelling} holds the rule`, ambiguousRepo);
      expect(promoted.modules).toEqual([spelling]);
      expect(promoted.ambiguous).toEqual([]);
    }
  });

  it("refuses the ambiguous one WITHOUT losing an unambiguous sibling", async () => {
    writeFileSync(path.join(ambiguousRepo, "a", "clear.ts"), "export {};\n");
    git(ambiguousRepo, "add", "a/clear.ts");
    clearTrackedFileCache();
    const promoted = await promote("a/CASE.ts and a/Clear.ts", ambiguousRepo);
    expect(promoted.modules).toEqual(["a/clear.ts"]);
    expect(promoted.ambiguous).toEqual(["a/case.ts"]);
  });
});

// ── the case rule, asserted through the READ it exists to serve ───────────────
//
// Everything above would still pass if the promoter emitted the LOWERCASED key: it
// would just be a different string in `modules`. This block is what makes the case
// rule load-bearing rather than cosmetic — `preEditContext` fans out one
// `recallForGate({ module })` per anchor and matches the anchor string EXACTLY, so a
// case-forked anchor is an anchor the hero query can never see.

describe("D15 promotion: preEditContext finds a promoted anchor", () => {
  let graph: MuonGraph;
  let graphDir: string;

  beforeAll(async () => {
    graphDir = mkdtempSync(path.join(tmpdir(), "muon-promo-graph-"));
    graph = new MuonGraph(path.join(graphDir, "promo.lbug"), {
      disableFts: true,
    });
    await graph.init();
  });

  afterAll(async () => {
    await graph.close();
    rmSync(graphDir, { recursive: true, force: true });
  });

  const governed = async (input: MemoryNoteInput) => {
    const note = await graph.addMemoryNote(input);
    await graph.updateMemoryNote(note.id, { confirmed: true });
    return note;
  };

  it("surfaces a note whose ONLY coordinate came from its own prose, in the TRACKED spelling", async () => {
    // The note names the file in the WRONG case and carries no `modules` at all —
    // the shape of all 62 measured orphans.
    const text = `Charge settlement retries are capped at five; see ${TRACKED_LOWER}.`;
    const promoted = await promote(text, repo);
    expect(promoted.modules).toEqual([TRACKED]);

    const note = await governed({
      kind: "decision",
      text,
      modules: promoted.modules,
      trust: "high",
      createdBy: "human",
      workspacePath: repo,
    });

    // The hero query, fanned out on the TRACKED spelling, which is what an editing
    // agent has (it is editing the real file).
    const found = await preEditContext(
      graph,
      { module: TRACKED },
      { workspacePath: repo }
    );
    expect(found.memories.map((memory) => memory.id)).toContain(note.id);
    expect(found.memories.find((memory) => memory.id === note.id)?.onTarget).toBe(
      true
    );

    // And the fork it would have been: nothing is anchored to the lowercased
    // spelling, so a promoter that used the entity key would return 0 memories here
    // and the change would measure as a success while the gate stayed empty.
    const forked = await preEditContext(
      graph,
      { module: TRACKED_LOWER },
      { workspacePath: repo }
    );
    expect(forked.memories.map((memory) => memory.id)).not.toContain(note.id);
  });
});
