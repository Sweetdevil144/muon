import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { moduleOfSymbol } from "@muon/graph";

const execFileAsync = promisify(execFile);

// ── D1: who resolves a coordinate, and when ──────────────────────────────────
//
// `docs/design/memory-index-decisions.md` §D1, option **B**. An anchor value used
// to be whatever the caller typed: `anchorRowsFor` persisted `input.modules` and
// `input.symbols` verbatim and nothing checked that either named a real file. The
// measured consequence on the founder's own brain: three of six live `Symbol` ids
// are `<file>#<file's own basename>`, four of nine module anchors are paths that
// resolve in no workspace that ledger knows about, and 63 active notes name a
// TRACKED repo file in their prose while carrying no module anchor at all.
//
// So a coordinate is resolved AT INGEST and the answer is recorded on the anchor
// row. Three rules make that safe, and each one is load-bearing:
//
//   1. RESOLVE AGAINST THE TRACKED-FILE SET (`git ls-files`), NOT THE FILESYSTEM.
//      macOS APFS is case-insensitive by default, so `stat("apps/cli/readme.md")`
//      SUCCEEDS and a filesystem check would silently accept the wrong spelling —
//      and the wrong spelling is a DIFFERENT anchor string, which
//      `preEditContext`'s exact-string membership test then misses. The tracked
//      set also carries the CANONICAL SPELLING, which D15 (promoting path-shaped
//      entities out of note prose into anchors) needs next.
//   2. THE WRITE NEVER FAILS. Not for a mistyped path, not for a missing `git`,
//      not for a non-repo workspace, not for a timeout, not for a repository
//      bigger than the cap below. Every one of those lands the anchor row with a
//      NULL resolution. "A gate that refuses to remember a fact because a path
//      was mistyped is worse than one that remembers it weakly."
//   3. FOUR STATES, and the distinction between `unresolved` and NULL is the whole
//      point — see {@link MemoryAnchorResolution}.
//
// REJECTED, recorded here so nobody re-buys them:
//   • D1-C, resolve against the GitNexus code index. Rejected as the IDENTITY
//     resolver for the same reason ADR-0012 rejected the GitNexus uid as the
//     identity: it couples the namespace to an optional, possibly-stale provider,
//     and a mid-rebuild index would refuse valid writes — contradicting
//     ADR-0012's reaffirmed "degrade-to-null never fails a gate".
//   • D1-D, batch resolution at reproject time. Rejected because a note stays
//     unanchored until the batch runs, which is two truths in flight.
//   • §2.2's `MemoryAnchor(kind,value)`-as-read-index plan is NOT what this is.
//     `MemoryAnchor` stays the write-path dedup index; `resolution` is a label on
//     it, not a new access path.
//
// D1 CHANGES NO READ BEHAVIOUR. Nothing filters on `resolution` yet: that is D15
// and D4+D6. Writing the column first is deliberate — a column added after a
// consumer exists cannot retroactively tell you which rows were never resolved.

/**
 * The FOUR states of a coordinate: three named, and the fourth being NULL.
 *
 *   • `resolved`   — the coordinate IS in the tracked-file set.
 *   • `unresolved` — we HAVE the tracked-file set and the coordinate is not in
 *                    it. This is an ASSERTION about the repository.
 *   • `planned`    — an EXPLICIT per-coordinate caller declaration for a file
 *                    that does not exist yet.
 *   • NULL         — we could NOT obtain the tracked set (no workspace on the
 *                    note, the workspace is not a git repository, `git` is
 *                    missing, the probe timed out, the repo exceeds
 *                    {@link MAX_TRACKED_FILES}), or the row predates this change.
 *
 * **Never write `unresolved` when the tracked set could not be read.** That would
 * assert a fact we do not have, and it is the single most likely defect in this
 * change. `unresolved` is OUR claim and it is only true relative to a set we
 * actually held; NULL is the honest answer when we held none.
 *
 * `planned` is the one state that is NOT ours, and it therefore survives a NULL
 * tracked set: it is the CALLER's declaration and needs no observation to record.
 * Collapsing it into NULL there would silently discard the only thing that can
 * produce this state on a non-git workspace — and the founder's own machine has
 * one (`~/SWE/ATLAS`, measured: a real, in-use, non-git MUON workspace).
 * A state nothing can produce is a state nobody maintains.
 *
 * REALITY WINS over the declaration. A coordinate declared `planned` that IS in
 * the tracked set lands `resolved`, because the declaration is a claim about the
 * world and the tracked set is the world. The other precedence would let a stale
 * declaration hold a real, resolvable coordinate out of the coordinate index that
 * D15 and D4+D6 are going to build on this column.
 */
export type MemoryAnchorResolution = "resolved" | "unresolved" | "planned";

/** Bounded memo, ONE entry per repo root. `git ls-files` on this repository is
 *  1,281 paths / 50 KB / 14 ms measured, so the memo is a courtesy to an ingest
 *  BURST (the extractor writes a handful of notes in a loop) rather than a
 *  necessity. Same shape as `workspace-identity.ts`'s memos — whole-cache drop,
 *  never per-entry eviction — with ONE deliberate difference stated below. */
const trackedCache = new Map<string, TrackedCacheEntry>();
type TrackedCacheEntry = {
  expiresAt: number;
  /** The git index's mtime when this entry was minted, or `null` when it could
   *  not be read. See {@link gitIndexStamp}. */
  stamp: number | null;
  /** The PROMISE, not the value, so two concurrent ingests in one workspace share
   *  one subprocess instead of racing to spawn two. */
  tracked: Promise<ReadonlySet<string> | null>;
};

/** A workspace's IDENTITY cannot change under a live process, which is why
 *  `workspace-identity.ts` memoizes it for the process lifetime. Its TRACKED SET
 *  can and does: an agent commits or `git add`s a file between two notes.
 *
 *  THE STALENESS WINDOW IS NO LONGER FREE, and this comment used to say it was:
 *  it claimed the memo admits only "a mislabelled coordinate inside the window,
 *  which nothing reads yet (D1 changes no read behaviour)". Both halves stopped
 *  being true. D15's `promoteResolvedPathEntities` reads this set to decide
 *  whether a module anchor is CREATED AT ALL, and D6 made `ANCHORED_TO` the
 *  anchored read's access path. So a note written seconds after `git add
 *  src/new.ts`, in a workspace whose set was memoized before the add, gets NO
 *  anchor for `src/new.ts` — PERMANENTLY. Ingest never re-runs for that note, and
 *  `backfillPromotedModuleAnchors` only considers notes with no module anchor at
 *  all, so a note that got SOME anchors is never revisited.
 *
 *  Hence {@link gitIndexStamp}: the memo is keyed on the git index's mtime as well
 *  as on time, and `git add` writes the index. The TTL stays as the BACKSTOP for
 *  the cases the stamp cannot see — a workspace with no readable `.git/index`
 *  (non-git, or a `.git` FILE), and two index writes inside one mtime tick — so
 *  the bound this comment always promised is unchanged. What the pair still cannot
 *  admit is a refused or lost write: an unreadable stamp degrades to today's
 *  TTL-only behaviour, never to a failure. */
const TRACKED_TTL_MS = 30_000;
/** At most this many workspaces are memoized at once; the whole map is dropped
 *  rather than evicted per entry, so the bound is trivially safe. A set is
 *  thousands of strings, so this is deliberately far smaller than
 *  `workspace-identity.ts`'s 256 single-string entries. */
const TRACKED_CACHE_MAX = 8;
const GIT_TIMEOUT_MS = 5_000;
/** `git ls-files -z` output ceiling. 64 MB is ~600k typical paths; a repository
 *  past it makes `execFile` reject, which degrades to NULL like any other git
 *  failure. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/**
 * Hard cap on retained paths. A repository past it is refused OUTRIGHT (NULL)
 * rather than truncated, and that direction is not a detail: answering
 * `unresolved` out of a truncated set would assert "this file is not in the
 * repository" about a file we simply stopped reading. Refusing the whole set
 * keeps the one rule this module has — never assert `unresolved` without the set.
 */
const MAX_TRACKED_FILES = 200_000;

/** Test seam: drop the memo so a test can observe the probe itself, and so one
 *  test's staged file is visible to the next. Mirrors
 *  `clearWorkspaceIdentityCaches`. */
export function clearTrackedFileCache(): void {
  trackedCache.clear();
}

/**
 * The mtime of the git INDEX under `repoRoot`, or `null` when it cannot be read.
 *
 * The index is exactly what `git ls-files` reports, so its mtime is the one cheap
 * observable that changes precisely when the tracked set can change — `git add`,
 * `git rm`, `git commit`, a checkout. One `stat`, no subprocess.
 *
 * SYNCHRONOUS ON PURPOSE, following `workspace-identity.ts`'s `statSync`/
 * `readdirSync` precedent rather than `fs/promises`. `trackedFileSet`'s memo
 * relies on there being NO await between its `get` and its `set` — that is what
 * makes two concurrent ingests share one `git ls-files` instead of racing to spawn
 * two. An `await stat` would open exactly that window; a `statSync` cannot.
 *
 * `<repoRoot>/.git/index` and nothing cleverer. Asking git where its index lives
 * would cost the subprocess this exists to avoid, and the value MUON derives for a
 * workspace (`repoRootOf`) is the MAIN worktree, where `.git` is a directory.
 *
 * WHERE THAT ASSUMPTION DOES NOT HOLD, named rather than assumed: a caller can pass
 * a path MUON never reduced — a note carrying 0041's raw worktree spelling is the
 * live example — and a linked worktree's `.git` is a FILE. That, a non-git
 * workspace, a bare repo, and an operator with `GIT_INDEX_FILE` pointed elsewhere
 * all read `null` here and fall back to the TTL alone, which is byte-for-byte the
 * behaviour before the stamp existed. The SET is still correct in those cases —
 * `git ls-files` resolves a linked worktree perfectly well — only the invalidation
 * degrades.
 */
function gitIndexStamp(repoRoot: string): number | null {
  try {
    return statSync(path.join(repoRoot, ".git", "index")).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The set of paths git TRACKS in `repoRoot`, repo-root-relative and POSIX — the
 * exact namespace a module anchor lives in (`toWorkspaceRelativePosix`, ADR-0012's
 * F-1 namespace) — or `null` when the set could not be obtained.
 *
 * `-z` because git otherwise C-QUOTES a path containing a space, a quote or a
 * non-ASCII byte, and a quoted path is a different string from the anchor it is
 * supposed to match. `--full-name -- :/` because bare `git ls-files` lists only
 * the CWD subtree with CWD-relative names: a `repoRoot` that ever turned out to
 * be a subdirectory would then silently yield a short, wrongly-namespaced set
 * instead of a failure.
 *
 * This reads the git INDEX, so a file that was just `git add`ed IS tracked and a
 * brand-new UNSTAGED file is not. That is the intended reading of "real
 * coordinate" and it is exactly the gap `planned` exists to cover. Reading the
 * index rather than the worktree also means a sparse checkout still resolves every
 * path the repository has, which a filesystem check could not.
 *
 * ONE MEASURED BLIND SPOT: a SUBMODULE appears in the index as a single gitlink
 * entry (its directory path), never as its files, so `sub/lib/deep.ts` lands
 * `unresolved` even though it is tracked in the submodule. Not designed for, in the
 * same way ADR-0026 §15 does not design for a nested repository, and it bites
 * nothing today — this repository has no `.gitmodules`.
 */
export async function trackedFileSet(
  repoRoot: string | null | undefined
): Promise<ReadonlySet<string> | null> {
  if (!repoRoot) {
    // No workspace on the note → nothing to resolve against, so NULL rather than
    // `unresolved`.
    //
    // CORRECTED AFTER ADR-0026 STEP 5: this comment used to name the pack-import
    // path as a permanent example, on the reasoning that a pack's coordinates are a
    // FOREIGN repository's. Step 5 stamps the RECEIVING workspace on an imported
    // note, so an import that names one now resolves — correctly, because
    // `unresolved` asserts "not in THIS partition's tracked set", the note now
    // belongs to this partition, and the claim says nothing about the origin repo.
    // What still lands here is any caller that names NO workspace: an import whose
    // route was given none, and today's operator-tier write path (ADR-0026 step 2
    // gives an operator write no derived workspace, so the human's own notes get no
    // resolution until that changes).
    return null;
  }
  const now = Date.now();
  // The stamp is read BEFORE the probe it guards, so an index written while
  // `git ls-files` is in flight stamps the entry OLD and the next caller re-probes.
  // Stamping after would record a set that predates its own key.
  const stamp = gitIndexStamp(repoRoot);
  const cached = trackedCache.get(repoRoot);
  // Two keys, ANDed: the entry must be inside the TTL *and* describe the same
  // index. A `git add` moves the stamp, so the memo is dropped on the spot rather
  // than costing an anchor that no later write will ever mint.
  if (cached && cached.expiresAt > now && cached.stamp === stamp) {
    return cached.tracked;
  }
  if (trackedCache.size >= TRACKED_CACHE_MAX) {
    trackedCache.clear();
  }
  const tracked = probeTrackedFiles(repoRoot);
  trackedCache.set(repoRoot, {
    expiresAt: now + TRACKED_TTL_MS,
    stamp,
    tracked,
  });
  return tracked;
}

async function probeTrackedFiles(
  repoRoot: string
): Promise<ReadonlySet<string> | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-z", "--full-name", "--", ":/"],
      {
        cwd: repoRoot,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
      }
    );
    const paths = String(stdout).split("\0");
    const tracked = new Set<string>();
    for (const entry of paths) {
      if (!entry) {
        continue; // the trailing NUL, and any empty record
      }
      if (tracked.size >= MAX_TRACKED_FILES) {
        return null; // refuse the whole set, never a truncated one
      }
      tracked.add(entry);
    }
    // An EMPTY result is not treated as an empty SET. `git ls-files` exits 0 with
    // no output for a repository that tracks nothing, and "no output" is
    // indistinguishable from "the probe answered about the wrong thing". The cost
    // is real and accepted: in a genuinely empty repository every coordinate lands
    // NULL where `unresolved` would have been true. The alternative is asserting
    // `unresolved` for every coordinate in a workspace we may have learned nothing
    // about, and this module's one rule is that we never do that.
    return tracked.size > 0 ? tracked : null;
  } catch {
    // Not a repository, `git` missing, timed out, output past `maxBuffer`, or the
    // directory is gone. All of them mean the same thing here: we do not have the
    // set. The write proceeds; the row lands NULL.
    return null;
  }
}

/**
 * Everything the SYNCHRONOUS anchor emitter needs to label one coordinate.
 *
 * Built off the ingest mutex (`coordinateResolverFor`) and then threaded in, for
 * the same reason `ingestMemoryNote` already resolves the embedding, the TTL
 * policy and the auto-confirm posture off it: a subprocess must not serialize
 * behind the write actor.
 */
export type CoordinateResolver = {
  /** `null` when the tracked set could not be obtained — the NULL state. */
  readonly tracked: ReadonlySet<string> | null;
  /**
   * The FILES the caller explicitly declared do not exist yet.
   *
   * A declaration names the file. A caller may name it directly
   * (`src/new.ts`) or name a symbol in it (`src/new.ts#build`); both reduce to
   * the same file, which is what keeps a symbol anchor and the module anchor
   * AUTO-DERIVED from it (`effectiveModules`) from disagreeing about one file.
   */
  readonly declaredFiles: ReadonlySet<string>;
};

/**
 * Resolve the tracked set for this write and normalize its `planned` declaration.
 *
 * The declaration is a per-coordinate CALLER assertion and nothing else: it can
 * only ever label an anchor the note already carries. It never MINTS an anchor,
 * so it is not a way to add a coordinate to a note, and it carries no prose into
 * the brain — it is consumed here and reduced to one enum member per row.
 *
 * It IS a claim a caller can make wrongly: a writer may declare a junk path
 * `planned` and it will land `planned` rather than `unresolved`. That is inherent
 * to an explicit declaration and is the price of the property D1 actually asked
 * for — a TYPO can never SILENTLY become `planned`. The claim is attributed by the
 * note's own `createdBy`, it confers no visibility (nothing reads this column),
 * and it is bounded at the route/tool boundary like every other anchor array.
 */
export async function coordinateResolverFor(input: {
  workspacePath?: string | null;
  plannedCoordinates?: readonly string[];
}): Promise<CoordinateResolver> {
  const declaredFiles = new Set<string>();
  for (const declared of input.plannedCoordinates ?? []) {
    const value = declared.trim();
    if (!value) {
      continue;
    }
    // Both spellings: the value verbatim (a module path may legally CONTAIN `#`,
    // which is why `toSymbolId` declines such a module rather than splitting it)
    // and its module prefix (so declaring a symbol also declares its file).
    declaredFiles.add(value);
    declaredFiles.add(moduleOfSymbol(value));
  }
  return {
    tracked: await trackedFileSet(input.workspacePath),
    declaredFiles,
  };
}

/**
 * The file a coordinate is ABOUT.
 *
 * A SYMBOL RESOLVES BY ITS MODULE PREFIX ONLY. A symbol id is `<module>#<name>`
 * (ADR-0012 Decision 1) and validating the `<name>` half needs the code index —
 * which §D1 rejected as the identity resolver. So `resolved` on a symbol anchor
 * means "the file exists", never "the symbol exists".
 *
 * The measured junk this therefore CANNOT catch: three of the six live `Symbol`
 * ids are a file's own basename used as a symbol name
 * (`apps/cli/README.md#README.md`), whose module prefix IS tracked, so they land
 * `resolved`. That is D2's problem — one anchor namespace or two, and who
 * validates a symbol NAME — and it is explicitly not this one's.
 *
 * A `module` value is taken VERBATIM. Reducing it with `moduleOfSymbol` would
 * mis-split a tracked path that legally contains `#` (`src/weird#name.ts` →
 * `src/weird`) and report a real file as `unresolved`.
 */
function fileOf(kind: "module" | "symbol", value: string): string {
  return kind === "symbol" ? moduleOfSymbol(value) : value;
}

/**
 * The four states, in the one precedence D1 requires: reality, then the caller's
 * declaration, then an assertion only if we hold the set to assert against.
 *
 * A resolver of `undefined` is the "this caller does not resolve" answer and
 * yields NULL for everything — the safe direction for any future write path that
 * has not learned to pass one.
 */
export function resolutionOf(
  kind: "module" | "symbol",
  value: string,
  resolver: CoordinateResolver | undefined
): MemoryAnchorResolution | null {
  if (!resolver) {
    return null;
  }
  const file = fileOf(kind, value);
  if (resolver.tracked?.has(file)) {
    return "resolved";
  }
  if (resolver.declaredFiles.has(file)) {
    return "planned";
  }
  return resolver.tracked ? "unresolved" : null;
}
