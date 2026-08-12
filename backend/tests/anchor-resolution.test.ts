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
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearTrackedFileCache,
  coordinateResolverFor,
  resolutionOf,
  trackedFileSet,
} from "../src/lib/anchor-resolution.js";

// D1 (docs/design/memory-index-decisions.md §D1, option B) — the resolver itself.
//
// Real `git`, real repositories, real `git ls-files`. Nothing is stubbed, because
// the defect being closed is a property of the FILESYSTEM and of git rather than of
// our code: §D1's reason for choosing the tracked-file set over `stat()` is that
// macOS APFS is case-insensitive, so a filesystem check silently accepts the wrong
// spelling — and the wrong spelling is a different anchor string.
//
// The four states each get their own test, and the one that matters most is
// NULL-BECAUSE-UNKNOWABLE: collapsing it into `unresolved` is the single most
// likely defect in this change, because `unresolved` is an ASSERTION about a
// repository and it is only true relative to a set we actually held.

/** This repository, derived from THIS FILE rather than from `process.cwd()`: a cwd
 *  drift once made a whole verification matrix falsely report failures. */
const MUON_REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

/** Two paths measured in §D1/§1 as live anchor values on the founder's own brain.
 *  `apps/cli/README.md` is one of the nine real module anchors; the lowercased
 *  spelling is one of the 60 path-shaped `Entity` keys describing the SAME file,
 *  which is exactly the case fork D15 has to repair. */
const TRACKED = "apps/cli/README.md";
const TRACKED_CASE_VARIANT = "apps/cli/readme.md";

let scratch: string;
/** A second, unrelated git repository holding a path MUON does not have. */
let otherRepo: string;
let emptyRepo: string;
let notARepo: string;

/** Is this filesystem case-insensitive? Probed, not assumed: the APFS hazard §D1
 *  names only exists on a case-insensitive volume, and a Linux CI ext4 volume
 *  demands a different assertion about what `stat` would have done. */
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
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-anchor-res-")));
  caseInsensitive = existsSync(path.join(MUON_REPO, TRACKED_CASE_VARIANT));

  otherRepo = path.join(scratch, "other-repo");
  mkdirSync(path.join(otherRepo, "only-here"), { recursive: true });
  git(otherRepo, "init", "--initial-branch=main");
  writeFileSync(path.join(otherRepo, "only-here", "file.ts"), "export {};\n");
  git(otherRepo, "add", "only-here/file.ts");
  git(otherRepo, "commit", "-m", "init");

  emptyRepo = path.join(scratch, "empty-repo");
  mkdirSync(emptyRepo, { recursive: true });
  git(emptyRepo, "init", "--initial-branch=main");

  notARepo = path.join(scratch, "not-a-repo");
  mkdirSync(notARepo, { recursive: true });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  clearTrackedFileCache();
});

const resolverFor = (workspacePath: string | null, planned: string[] = []) =>
  coordinateResolverFor({ workspacePath, plannedCoordinates: planned });

describe("D1 the tracked-file set", () => {
  it("reads THIS repository's real git index, repo-root-relative", async () => {
    const tracked = await trackedFileSet(MUON_REPO);
    expect(tracked).not.toBeNull();
    expect(tracked!.has(TRACKED)).toBe(true);
    // Repo-root-relative, not CWD-relative: the tests run from `backend/`, and a
    // CWD-relative listing would namespace every path one level short and make
    // every module anchor `unresolved`.
    expect(tracked!.has("backend/src/lib/memory-ledger.ts")).toBe(true);
    expect(tracked!.has("src/lib/memory-ledger.ts")).toBe(false);
  });

  it("is NULL — never an empty set — for a non-repository, a missing directory, and a repo that tracks nothing", async () => {
    expect(await trackedFileSet(notARepo)).toBeNull();
    clearTrackedFileCache();
    expect(await trackedFileSet(path.join(scratch, "vanished"))).toBeNull();
    clearTrackedFileCache();
    // A repository with no tracked files prints nothing and exits 0, which is
    // indistinguishable from a probe that answered about the wrong thing.
    expect(await trackedFileSet(emptyRepo)).toBeNull();
    clearTrackedFileCache();
    expect(await trackedFileSet(null)).toBeNull();
    expect(await trackedFileSet(undefined)).toBeNull();
  });

  it("is NULL when `git` is not on PATH", async () => {
    const previous = process.env.PATH;
    process.env.PATH = path.join(scratch, "no-binaries-here");
    try {
      expect(await trackedFileSet(MUON_REPO)).toBeNull();
    } finally {
      process.env.PATH = previous;
    }
  });

  it("MEMOIZES per repo root, and a `git add` INVALIDATES the memo on the spot", async () => {
    const staged = path.join(otherRepo, "only-here", "staged-later.ts");
    const first = await trackedFileSet(otherRepo);
    expect(first!.has("only-here/staged-later.ts")).toBe(false);
    // Memoized: the same call inside the window returns the SAME set instance, so
    // the burst that D1's memo exists for still pays for one `git ls-files`.
    expect(await trackedFileSet(otherRepo)).toBe(first);

    writeFileSync(staged, "export {};\n");
    git(otherRepo, "add", "only-here/staged-later.ts");

    // The memo is keyed on the git index's mtime as well as on the 30 s TTL, and
    // `git add` writes the index. Before that key existed this returned the STALE
    // answer, and since D15 reads the set to decide whether an anchor is created
    // AT ALL, the note mentioning `only-here/staged-later.ts` lost that coordinate
    // permanently — ingest never re-runs and the one-shot backfill only revisits
    // notes with no module anchor at all. The INDEX is the set, so a `git add`
    // with no commit is enough.
    expect((await trackedFileSet(otherRepo))!.has("only-here/staged-later.ts")).toBe(
      true
    );

    // …and the fresh answer is itself memoized again (no re-probe per call).
    const second = await trackedFileSet(otherRepo);
    expect(await trackedFileSet(otherRepo)).toBe(second);
    expect(second).not.toBe(first);
  });

  it("degrades to the TTL alone when the git index cannot be stat'd, and never fails", async () => {
    // A non-git workspace has no `.git/index` to stamp, so the stamp is `null` on
    // both sides of the comparison and the entry stays valid for its TTL — exactly
    // the behaviour before the stamp existed. The one property that must never
    // change is that the write still proceeds with a NULL set rather than throwing.
    expect(await trackedFileSet(notARepo)).toBeNull();
    expect(await trackedFileSet(notARepo)).toBeNull();
    expect(await trackedFileSet(path.join(scratch, "no-such-dir"))).toBeNull();
  });
});

describe("D1 the four states", () => {
  it("RESOLVED: a real tracked path in the real repository", async () => {
    const resolver = await resolverFor(MUON_REPO);
    expect(resolutionOf("module", TRACKED, resolver)).toBe("resolved");
  });

  it("UNRESOLVED: a case-variant of a tracked path — the APFS hazard §D1 names", async () => {
    const resolver = await resolverFor(MUON_REPO);
    // The hazard itself, asserted rather than assumed: on this volume the
    // filesystem ACCEPTS the wrong spelling, so a `stat()`-based resolver would
    // have called this a real coordinate and stored a second, forked anchor string.
    if (caseInsensitive) {
      expect(existsSync(path.join(MUON_REPO, TRACKED_CASE_VARIANT))).toBe(true);
    }
    expect(resolutionOf("module", TRACKED_CASE_VARIANT, resolver)).toBe(
      "unresolved"
    );
  });

  it("UNRESOLVED: a path tracked in a DIFFERENT repository", async () => {
    const foreign = "only-here/file.ts";
    // Tracked where it belongs...
    expect(
      resolutionOf("module", foreign, await resolverFor(otherRepo))
    ).toBe("resolved");
    clearTrackedFileCache();
    // ...and an assertion, not a NULL, when resolved against this repo: we HELD
    // MUON's tracked set and the path is genuinely not in it. This is the case that
    // makes D15's retro-anchoring specifiable — 37 of the 60 live path-shaped
    // entity keys are another repository's paths.
    expect(
      resolutionOf("module", foreign, await resolverFor(MUON_REPO))
    ).toBe("unresolved");
  });

  it("PLANNED: an explicit per-coordinate declaration, and ONLY for what was declared", async () => {
    const resolver = await resolverFor(MUON_REPO, ["src/not/written/yet.ts"]);
    expect(resolutionOf("module", "src/not/written/yet.ts", resolver)).toBe(
      "planned"
    );
    // The undeclared typo beside it is still an assertion. This is the property
    // that makes `planned` explicit: a typo can never SILENTLY become "planned".
    expect(resolutionOf("module", "src/not/writen/yet.ts", resolver)).toBe(
      "unresolved"
    );
  });

  it("NULL because UNKNOWABLE: no tracked set means no assertion, ever", async () => {
    // Four different ways to have no set, and not one of them may answer
    // `unresolved` — that would assert "this file is not in the repository" about a
    // repository we never read.
    for (const workspace of [null, notARepo, emptyRepo, path.join(scratch, "gone")]) {
      clearTrackedFileCache();
      const resolver = await resolverFor(workspace);
      expect(resolutionOf("module", TRACKED, resolver)).toBeNull();
      expect(resolutionOf("module", "anything/at/all.ts", resolver)).toBeNull();
      expect(resolutionOf("symbol", "anything/at/all.ts#f", resolver)).toBeNull();
    }
  });

  it("NULL: a caller that passes NO resolver resolves nothing", () => {
    // The safe direction for any future write path that has not learned to resolve.
    expect(resolutionOf("module", TRACKED, undefined)).toBeNull();
    expect(resolutionOf("symbol", `${TRACKED}#x`, undefined)).toBeNull();
  });
});

describe("D1 precedence and the symbol limit", () => {
  it("REALITY WINS: a declaration for a file that IS tracked lands resolved", async () => {
    const resolver = await resolverFor(MUON_REPO, [TRACKED]);
    // The other precedence would let a stale declaration hold a real, resolvable
    // coordinate out of the coordinate index D15 and D4+D6 build on this column.
    expect(resolutionOf("module", TRACKED, resolver)).toBe("resolved");
  });

  it("PLANNED survives a NULL tracked set, because the declaration is the CALLER's claim", async () => {
    // `~/SWE/ATLAS` is a measured, real, in-use, NON-git MUON workspace, so
    // this is not a hypothetical shape. `resolved`/`unresolved` are our
    // observations and need the set; `planned` needs nothing but the declaration,
    // and dropping it here would leave the enum member with no producer at all on
    // such a workspace.
    const resolver = await resolverFor(notARepo, ["src/future.ts"]);
    expect(resolutionOf("module", "src/future.ts", resolver)).toBe("planned");
    expect(resolutionOf("module", "src/other.ts", resolver)).toBeNull();
  });

  it("a SYMBOL resolves by its MODULE PREFIX ONLY, including the measured junk case", async () => {
    const resolver = await resolverFor(MUON_REPO);
    expect(resolutionOf("symbol", `${TRACKED}#anything`, resolver)).toBe("resolved");
    // The measured junk D1 CANNOT catch: three of six live `Symbol` ids are a
    // file's own basename used as a symbol name, and the module prefix IS tracked,
    // so they resolve. Validating the NAME half needs the code index, which §D1
    // rejected as the identity resolver. D2 owns this, not D1 — pinned so nobody
    // reads a green suite as "the junk is gone".
    expect(resolutionOf("symbol", "apps/cli/README.md#README.md", resolver)).toBe(
      "resolved"
    );
    // The prefix is what is checked, so a bogus module makes the whole id bogus.
    expect(resolutionOf("symbol", "src/nope.ts#realName", resolver)).toBe(
      "unresolved"
    );
    // And the case-variant prefix stays an assertion at symbol level too.
    expect(
      resolutionOf("symbol", `${TRACKED_CASE_VARIANT}#README.md`, resolver)
    ).toBe("unresolved");
  });

  it("a declaration names a FILE, whichever way the caller spells it", async () => {
    // Declaring the MODULE also covers a symbol in it...
    const byModule = await resolverFor(MUON_REPO, ["src/new.ts"]);
    expect(resolutionOf("module", "src/new.ts", byModule)).toBe("planned");
    expect(resolutionOf("symbol", "src/new.ts#build", byModule)).toBe("planned");

    clearTrackedFileCache();
    // ...and declaring the SYMBOL also covers the module anchor `effectiveModules`
    // AUTO-DERIVES from it. Without that, one write would land the symbol `planned`
    // and its own derived module `unresolved` — two answers about one file.
    const bySymbol = await resolverFor(MUON_REPO, ["src/new.ts#build"]);
    expect(resolutionOf("symbol", "src/new.ts#build", bySymbol)).toBe("planned");
    expect(resolutionOf("module", "src/new.ts", bySymbol)).toBe("planned");
  });

  it("a module path containing `#` is taken VERBATIM, never split", async () => {
    const weird = "src/weird#name.ts";
    writeFileSync(path.join(otherRepo, "only-here", "hash#name.ts"), "export {};\n");
    git(otherRepo, "add", "only-here/hash#name.ts");
    clearTrackedFileCache();
    const resolver = await resolverFor(otherRepo);
    // `#` is a legal POSIX filename character, which is why `toSymbolId` DECLINES a
    // module containing one rather than splitting it. Reducing a module anchor by
    // the symbol rule would look for `only-here/hash` and call a real, tracked file
    // `unresolved`.
    expect(resolutionOf("module", "only-here/hash#name.ts", resolver)).toBe(
      "resolved"
    );
    expect(resolutionOf("module", weird, resolver)).toBe("unresolved");
  });

  it("ignores blank declarations rather than declaring the empty string", async () => {
    const resolver = await resolverFor(MUON_REPO, ["", "   "]);
    expect(resolver.declaredFiles.size).toBe(0);
    expect(resolutionOf("module", "", resolver)).toBe("unresolved");
  });
});
