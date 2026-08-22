import { execFile } from "node:child_process";
import { lstatSync, readlinkSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  DOCS_GIT_MAX_BUFFER,
  DOCS_GIT_TIMEOUT_MS,
  DOCS_MAX_KNOWN_FILES,
} from "./bounds.js";

const execFileAsync = promisify(execFile);

/**
 * The corpus: ONE selector, ONE exclusion set, ONE repository root
 * (ADR-0053 §1).
 *
 * The selector is `git ls-files -co --exclude-standard '*.md'` — byte-for-byte
 * the one `scripts/check-docs.mjs:47-58` uses, INCLUDING untracked-but-not-
 * ignored files, for the reason recorded there: a brand-new doc is the one most
 * likely to carry a wrong link, and it was the one case the old tracked-only
 * gate skipped. `.muon/` is gitignored, so the worktree copies that trap agents
 * are excluded by construction rather than by a rule someone has to remember.
 *
 * The two selectors are duplicated DELIBERATELY until `check:docs` is refactored
 * to consume this package (blueprint §8 step 7); `tests/corpus.test.ts` pins
 * them equal so they cannot fork in the meantime.
 */

/**
 * Removed from the corpus, and REPORTED rather than silently dropped.
 *
 * `.claude/**`, `.kiro/**` and `.github/**` are agent-persona and skill prompts
 * — instructions authored FOR A MODEL — and ranking them as documentation is the
 * one thing this design must not do. `packaging/oss/**` are export templates
 * whose links are correct only at their destination
 * (`scripts/check-docs.mjs:98-106`).
 */
export const DOCS_EXCLUDED_PREFIXES = [
  ".claude/",
  ".kiro/",
  ".github/",
  "packaging/oss/",
] as const;

/** The prefix that excludes `relPath`, or `null` when it is in the corpus. */
export function exclusionFor(relPath: string): string | null {
  return (
    DOCS_EXCLUDED_PREFIXES.find((prefix) => relPath.startsWith(prefix)) ?? null
  );
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      timeout: DOCS_GIT_TIMEOUT_MS,
      maxBuffer: DOCS_GIT_MAX_BUFFER,
      windowsHide: true,
    });
    return String(stdout);
  } catch {
    // Not a repository, `git` missing, timed out, or output past `maxBuffer`.
    // All of them mean one thing here: we do not have the answer. Never a throw,
    // never a guess — the caller degrades and SAYS SO.
    return null;
  }
}

export type RepoProbe = {
  /** Absolute repository root, or `startDir` when git could not answer. */
  root: string;
  gitAvailable: boolean;
  /** `null` ⇒ git is unreadable, OR the repository has no commit yet. */
  head: string | null;
};

/**
 * The repository root and HEAD in ONE subprocess — `git rev-parse
 * --show-toplevel HEAD` prints the toplevel first, then the sha.
 *
 * A repository with no commit exits non-zero on that form (HEAD is not a
 * revision yet) and would take the root down with it, so it falls back to
 * `--show-toplevel` alone: the root is knowable, the commit is not, and
 * `head: null` says exactly that.
 *
 * `gitAvailable: false` means git could not answer at all. Every response then
 * carries `builtAtCommit: null` and says the corpus was read from the
 * filesystem, which is the whole honesty contract in ADR-0053 §6 — never a
 * claim of currency.
 */
export async function repoProbe(startDir: string): Promise<RepoProbe> {
  const combined = await git(startDir, ["rev-parse", "--show-toplevel", "HEAD"]);
  if (combined !== null) {
    const [top, head] = combined.trim().split("\n");
    return {
      root: top ? path.resolve(top) : path.resolve(startDir),
      gitAvailable: true,
      head: head?.trim() || null,
    };
  }
  const topOnly = await git(startDir, ["rev-parse", "--show-toplevel"]);
  if (topOnly === null) {
    return { root: path.resolve(startDir), gitAvailable: false, head: null };
  }
  const top = topOnly.trim();
  return {
    root: top ? path.resolve(top) : path.resolve(startDir),
    gitAvailable: true,
    head: null,
  };
}

/**
 * The mtime of the git INDEX, or `null`. One `statSync`, no subprocess — the
 * cheapest observable that moves exactly when the known-file set can change
 * (`git add`, `git rm`, `git commit`, a checkout). Same role, and the same
 * limits, as `backend/src/lib/anchor-resolution.ts:177-183`: a linked worktree's
 * `.git` is a FILE and reads `null` here, which degrades to the TTL backstop
 * rather than to a wrong answer.
 */
export function gitIndexStamp(root: string): number | null {
  try {
    return statSync(path.join(root, ".git", "index")).mtimeMs;
  } catch {
    return null;
  }
}

function splitNul(stdout: string): string[] {
  return [...new Set(stdout.split("\0").filter(Boolean))];
}

/**
 * Every `*.md` the selector yields, corpus files and exclusions alike, sorted.
 *
 * `-z` because git C-QUOTES a path containing a space, a quote or a non-ASCII
 * byte otherwise, and a quoted path is a DIFFERENT string from the anchor it has
 * to match. `--full-name` so a root that ever turned out to be a subdirectory
 * yields a failure rather than a short, wrongly-namespaced set.
 */
export async function listMarkdownPaths(root: string): Promise<string[] | null> {
  const out = await git(root, [
    "ls-files",
    "-z",
    "-c",
    "-o",
    "--exclude-standard",
    "--full-name",
    "--",
    "*.md",
  ]);
  return out === null ? null : splitNul(out).sort();
}

/**
 * The KNOWN-FILE set an anchor resolves against: tracked AND
 * untracked-but-not-ignored, the SAME selector the corpus uses.
 *
 * NOT the tracked-only `git ls-files` that memory's D1 uses, and the correction
 * is measured. A resolver narrower than the corpus selector manufactures false
 * `unresolved` for work in flight: this working tree carried 15
 * untracked-but-not-ignored source files when ADR-0053 was written, one of them
 * `packages/client/src/github-identity-gate.ts` — 18.9 KB on disk, named by
 * ADR-0052 — and a tracked-only resolver reports every citation of it as naming
 * a file this repository does not contain.
 *
 * `null` (refuse the whole set) past {@link DOCS_MAX_KNOWN_FILES} rather than a
 * truncated one: answering `unresolved` out of a partial set asserts "not in this
 * repository" about a file we simply stopped reading.
 */
export async function knownFileSet(
  root: string
): Promise<ReadonlySet<string> | null> {
  const out = await git(root, [
    "ls-files",
    "-z",
    "-c",
    "-o",
    "--exclude-standard",
    "--full-name",
    "--",
    ":/",
  ]);
  if (out === null) {
    return null;
  }
  const paths = splitNul(out);
  if (paths.length === 0 || paths.length > DOCS_MAX_KNOWN_FILES) {
    // An EMPTY result is not an empty SET: `git ls-files` exits 0 with no output
    // for a repository that tracks nothing, and "no output" is indistinguishable
    // from "the probe answered about the wrong thing".
    return null;
  }
  return new Set(paths);
}

/**
 * The TRACKED subset (index only), used solely to label each anchor's
 * `tracked: boolean`. `resolved` + `tracked: false` is the in-flight case above
 * and is a NORMAL answer, not a warning.
 */
export async function trackedFileSet(
  root: string
): Promise<ReadonlySet<string> | null> {
  const out = await git(root, [
    "ls-files",
    "-z",
    "--full-name",
    "--",
    ":/",
  ]);
  if (out === null) {
    return null;
  }
  const paths = splitNul(out);
  if (paths.length === 0 || paths.length > DOCS_MAX_KNOWN_FILES) {
    return null;
  }
  return new Set(paths);
}

/**
 * Whether any `*.md` in the worktree is untracked, staged or modified relative
 * to HEAD. `null` when git cannot answer — never `false`, which would read as
 * "the index describes a clean tree" on evidence we do not have.
 */
export async function worktreeDirty(root: string): Promise<boolean | null> {
  const out = await git(root, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    "--",
    "*.md",
  ]);
  if (out === null) {
    return null;
  }
  return out.length > 0;
}

/**
 * Is `absolutePath` inside `root` AS A STRING? The workspace fence's first half:
 * this package reads the files git named under the resolved root and nothing
 * else, and a link target such as `../../etc/passwd` is STRING-resolved against
 * the known-file set, never stat'd and never opened (ADR-0053 non-goals;
 * blueprint §7.3 P5).
 *
 * A string is the WHOLE answer for a link target, which is never opened. It is
 * not the whole answer for a path about to be READ — see {@link containedPath}.
 */
export function withinRoot(root: string, absolutePath: string): boolean {
  const relative = path.relative(root, absolutePath);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/**
 * Where a path REALLY lives, or why it is refused. Contained ⇒ `path` is the
 * link-free location to read; refused ⇒ `reason` is what a caller reports.
 */
export type Containment =
  | { contained: true; path: string }
  | { contained: false; reason: string };

/** Symlink hops followed before a path is refused. Bounds a cycle too. */
const MAX_LINK_HOPS = 32;

/**
 * Is `absolutePath` inside `root` ONCE EVERY SYMLINK ON IT IS RESOLVED?
 *
 * WHY {@link withinRoot} IS NOT ENOUGH FOR A READ. `git` tracks a symlink as an
 * ordinary index entry, so `git ls-files -- '*.md'` will happily name
 * `docs/escape.md → /etc/passwd`, and a string-prefix fence reads straight
 * through it: the path IS under the root, the bytes are not. The filesystem
 * fallback cannot make this mistake (`readdirSync`'s `isFile()` is `lstat`-shaped
 * and a symlink is neither file nor directory to it), which is exactly why the
 * git-selector path is the one that needs this.
 *
 * NOTHING OUTSIDE THE ROOT IS TOUCHED, NOT EVEN TO DECIDE. `realpathSync` would
 * answer in one call — by resolving the escaping target, i.e. by probing the very
 * path we are refusing. This walks the segments INSIDE the root instead,
 * `lstat`ing each prefix, and folds a link's target as a STRING; an escaping link
 * is therefore refused having read only the link itself. A link that stays inside
 * is followed and re-walked, so a legitimate in-tree symlink still resolves
 * rather than being over-refused.
 */
export function containedPath(root: string, absolutePath: string): Containment {
  if (!withinRoot(root, absolutePath)) {
    return { contained: false, reason: "outside the resolved repository root" };
  }
  let candidate = absolutePath;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    const link = firstLinkOn(root, candidate);
    if (link === null) {
      return { contained: true, path: candidate };
    }
    let target: string;
    try {
      target = readlinkSync(link);
    } catch {
      return { contained: false, reason: "unreadable symlink" };
    }
    const rest = path.relative(link, candidate);
    candidate = path.join(path.resolve(path.dirname(link), target), rest);
    if (!withinRoot(root, candidate)) {
      return {
        contained: false,
        reason: "a symlink on this path resolves outside the repository root",
      };
    }
  }
  // A cycle (`a → b → a`) and a 32-deep chain get the same answer, because the
  // useful answer is the same: this path does not name a file we will open.
  return { contained: false, reason: "too many symlink hops to resolve" };
}

/**
 * The first segment at or below `root` that is a symlink, or `null`.
 *
 * A missing segment answers `null` rather than a verdict: the CALLER's own read
 * reports a file that is not there, and inventing a containment failure for it
 * would put "escaped the workspace" next to a typo.
 */
function firstLinkOn(root: string, absolutePath: string): string | null {
  let prefix = root;
  for (const segment of path.relative(root, absolutePath).split(path.sep)) {
    if (segment.length === 0) {
      continue;
    }
    prefix = path.join(prefix, segment);
    let stat;
    try {
      stat = lstatSync(prefix);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) {
      return prefix;
    }
  }
  return null;
}

function fold(referringDir: string, cleaned: string): string | null {
  const joined = cleaned.startsWith("/")
    ? path.posix.normalize(cleaned.slice(1))
    : path.posix.normalize(path.posix.join(referringDir, cleaned));
  // A target that folds ABOVE the repository root is a coordinate this index
  // will not describe, rather than one it resolves. Nothing is stat'd to decide
  // that — it is a string result (blueprint §7.3 P5).
  if (joined.startsWith("../") || joined === ".." || joined.startsWith("/")) {
    return null;
  }
  // A TRAILING SLASH is dropped so `research/` and `research` are one key. The
  // "is this a directory" question is answered by the known-file set
  // (`KnownFiles.hasDirectory`), not by how the author happened to spell it.
  const normalized = joined.replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized === "." || normalized === "" ? null : normalized;
}

/**
 * A MARKDOWN LINK target, normalized. Always resolved relative to the referring
 * file's directory, exactly as `scripts/check-docs.mjs:104-116` does — that is
 * what a markdown link MEANS.
 */
export function normalizeLinkTarget(
  referringDir: string,
  target: string
): string | null {
  const cleaned = target.replace(/\\/g, "/").trim();
  return cleaned ? fold(referringDir, cleaned) : null;
}

/**
 * An INLINE CODE-SPAN citation, normalized. Repo-root-relative by default, and
 * relative to the referring document's directory only when it is spelled that
 * way (`./build.sh`, `../design/markdown-docs-index.md`).
 *
 * THE DEFAULT IS THE WHOLE POINT and getting it wrong is expensive: this corpus
 * writes `packages/mcp/src/gitnexus-tools.ts` from inside `docs/adr/`, and
 * joining that against the referring directory turns 1,660 exact resolutions
 * into 1,660 assertions that the repository does not contain its own files.
 */
export function normalizeCitationPath(
  referringDir: string,
  span: string
): string | null {
  const cleaned = span.replace(/\\/g, "/").trim();
  if (!cleaned) {
    return null;
  }
  // An ABSOLUTE path is not a repository coordinate and is refused rather than
  // reinterpreted. A markdown LINK spelled `/docs/x.md` is site-absolute and is
  // treated as root-relative by `normalizeLinkTarget`; a code span spelled
  // `/etc/shadow.conf` names the host filesystem, and folding the leading slash
  // away would enter it into the citation index as though it were ours.
  if (cleaned.startsWith("/")) {
    return null;
  }
  const documentRelative = cleaned.startsWith("./") || cleaned.startsWith("../");
  return fold(documentRelative ? referringDir : "", cleaned);
}
