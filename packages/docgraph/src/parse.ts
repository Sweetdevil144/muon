import { createHash } from "node:crypto";
import { marked, type Token, type Tokens } from "marked";
import { SlugDeduper, sectionIdOf } from "./slug.js";

/**
 * One markdown file → sections, fences, links and code-span candidates, with
 * exact line ranges (ADR-0053 §2, blueprint §3).
 *
 * A REAL COMMONMARK AST, NOT A LINE SCANNER, and the reason is measured rather
 * than stylistic: 56 heading-shaped lines in this repository's corpus sit INSIDE
 * fenced blocks, and a regex scanner mints a phantom section from each one that
 * then steals its bytes from the real parent. `marked` is already a pinned
 * first-party dependency of this workspace (`apps/tui`, `apps/desktop`), pure
 * JS, no native or WASM asset.
 *
 * OFFSETS. `marked` tokens carry `raw` but no line or column, so a token's
 * position is derived by walking the TOP-LEVEL token list and accumulating
 * `raw.length`. That `Σ raw === source.length` is an INVARIANT, not an
 * observation — verified on 179/179 corpus files here and on 195/195 under two
 * `marked` majors when the blueprint was written — and it is pinned by a test
 * (`tests/parse.test.ts`), because a dependency bump that broke it would
 * silently shift every line number in every answer rather than fail.
 *
 * NORMALIZATION. `Lexer.lex` rewrites `\r\n`/`\r` to `\n` BEFORE tokenizing, so
 * every offset it implies is an offset into the NORMALIZED text. This module
 * therefore normalizes first and reports line numbers against that, which is
 * also what an editor shows. Every file in this corpus is already LF-only, so
 * the two agree byte-for-byte today; doing it in the other order would put a
 * CRLF file's line numbers quietly out by one per line.
 */

/** A fenced block, recorded as an ATTRIBUTE of its section, never as a node. */
export type DocFence = {
  /** Info-string language, lowercased first word, or `null` for a bare fence. */
  lang: string | null;
  startLine: number;
  endLine: number;
  bytes: number;
  /** sha256 of the fence BODY (the info string and the delimiters excluded). */
  sha256: string;
};

/** A markdown link, before resolution (see `anchors.ts`). */
export type RawLink = {
  /** The link's visible text, inline markdown flattened. */
  text: string;
  /** The href exactly as authored. */
  href: string;
};

/**
 * A section of one document. Sections PARTITION the file: a section runs from
 * its heading line to the line before the NEXT heading of ANY depth, or EOF.
 *
 * DEVIATION FROM BLUEPRINT §3.1, deliberate and load-bearing. §3.1's prose says
 * a range runs to "the next heading of depth ≤ its own", which nests a parent
 * section over its children. Its own test plan (§7.2 T5) then requires
 * `Σ section.bytes === file.bytes` with "no byte … double-counted", which
 * nesting cannot satisfy, and a nested body would additionally count every child
 * heading's prose again in the BM25 term statistics — inflating both the corpus
 * length and every ancestor's term frequencies. The partition satisfies T5
 * exactly; the hierarchy §3.1 wanted survives intact in `headingPath` and
 * `depth`, which is where the `CONTAINS` edge reads it from.
 */
export type ParsedSection = {
  /** `${docPath}#${slug}`. */
  id: string;
  docPath: string;
  /** 1..6 for a heading; `0` for the synthetic preamble. */
  depth: number;
  /** Heading text with inline markdown flattened; `null` for the preamble. */
  heading: string | null;
  /** Breadcrumb: each ancestor heading in order, then this one. */
  headingPath: string[];
  /** The slug alone, for `#anchor` link resolution. Empty for the preamble. */
  anchor: string;
  /** 1-based inclusive. An EMPTY section reports `endLine === startLine - 1`. */
  startLine: number;
  endLine: number;
  bytes: number;
  /** sha256 of the section's raw bytes, heading line included. */
  contentHash: string;
  /** Prose with fences removed and inline-code markers stripped — the ranking body. */
  text: string;
  fences: DocFence[];
  links: RawLink[];
  /** Inline code spans, verbatim. `anchors.ts` decides which are path-shaped. */
  codeSpans: string[];
};

export type ParsedDoc = {
  path: string;
  /** Text of the first depth-1 heading, or `null`. */
  title: string | null;
  /** sha256 of the file's bytes, as read. */
  contentHash: string;
  bytes: number;
  lines: number;
  sections: ParsedSection[];
};

/** Byte length of a UTF-8 string. Sections are measured in bytes, not code units. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * marked escapes `&<>"'` inside `codespan.text` and link hrefs (it emits HTML).
 * A citation is compared against `git ls-files` byte-for-byte, so the escapes
 * are undone before anything downstream sees them.
 */
function unescapeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Flatten inline tokens to plain text — GitHub slugs the RENDERED heading. */
function flattenInline(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens || tokens.length === 0) {
    return unescapeEntities(fallback).trim();
  }
  let out = "";
  for (const token of tokens) {
    const generic = token as Tokens.Generic;
    if (
      token.type === "codespan" ||
      token.type === "text" ||
      token.type === "escape"
    ) {
      out += unescapeEntities(String(generic.text ?? ""));
    } else if (Array.isArray(generic.tokens) && generic.tokens.length > 0) {
      out += flattenInline(generic.tokens as Token[], String(generic.text ?? ""));
    } else {
      out += unescapeEntities(String(generic.text ?? generic.raw ?? ""));
    }
  }
  return out.trim();
}

/** Line-start offsets, so a character offset maps to a 1-based line in O(log n). */
class LineIndex {
  private readonly starts: number[] = [0];

  constructor(source: string) {
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] === "\n") {
        this.starts.push(i + 1);
      }
    }
  }

  lineAt(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.starts[mid] <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low + 1;
  }
}

/**
 * Where a NESTED token's `raw` sits inside its parent's slice, or `-1`.
 *
 * Top-level offsets are exact (`Σ raw === length`). Nested ones are not free:
 * a list item's or blockquote's children carry DEDENTED / prefix-stripped `raw`,
 * so an exact `indexOf` misses. Measured on this corpus: 12 of 390 fenced blocks
 * are nested, all `bash` inside list items, none of them mermaid. The fallback
 * matches the child's first non-empty line by its TRIMMED text, which is exactly
 * the indented-fence case. When even that misses we return `-1` and the caller
 * keeps the child's position UNKNOWN rather than inventing one.
 */
function locateNested(
  parentSlice: string,
  childRaw: string,
  cursor: number
): number {
  const exact = parentSlice.indexOf(childRaw, cursor);
  if (exact >= 0) {
    return exact;
  }
  const firstLine = childRaw.split("\n").find((line) => line.trim().length > 0);
  if (!firstLine) {
    return -1;
  }
  const needle = firstLine.trim();
  let scan = cursor;
  while (scan < parentSlice.length) {
    const lineEnd = parentSlice.indexOf("\n", scan);
    const stop = lineEnd < 0 ? parentSlice.length : lineEnd;
    if (parentSlice.slice(scan, stop).trim() === needle) {
      return scan;
    }
    if (lineEnd < 0) {
      break;
    }
    scan = lineEnd + 1;
  }
  return -1;
}

/** Child token lists of a container token, in document order. */
function childTokens(token: Token): Token[] {
  const generic = token as Tokens.Generic;
  const children: Token[] = [];
  if (Array.isArray(generic.items)) {
    children.push(...(generic.items as Token[]));
  }
  if (Array.isArray(generic.tokens)) {
    children.push(...(generic.tokens as Token[]));
  }
  // Tables really do carry links and paths in this corpus
  // (`docs/adr/0011-local-code-graph.md` alone has four), so a walker that
  // skipped `header`/`rows` would drop those citations silently.
  if (Array.isArray(generic.header)) {
    for (const cell of generic.header as Tokens.TableCell[]) {
      children.push(...((cell.tokens ?? []) as Token[]));
    }
  }
  if (Array.isArray(generic.rows)) {
    for (const row of generic.rows as Tokens.TableCell[][]) {
      for (const cell of row) {
        children.push(...((cell.tokens ?? []) as Token[]));
      }
    }
  }
  return children;
}

type Collector = {
  fences: DocFence[];
  links: RawLink[];
  codeSpans: string[];
};

/** Collect fences, links and code spans out of one token subtree. */
function collectFrom(
  token: Token,
  /** Absolute offset, or `null` when the token's position could not be located. */
  absoluteOffset: number | null,
  source: string,
  lines: LineIndex,
  into: Collector
): void {
  if (token.type === "code") {
    const fence = token as Tokens.Code;
    // A fence with no located position is still RECORDED — it is a real block
    // and `fenceLang` filtering must see it — with a `startLine` of 0 marking
    // the position as unknown rather than guessed.
    const startLine = absoluteOffset === null ? 0 : lines.lineAt(absoluteOffset);
    const endLine =
      absoluteOffset === null
        ? 0
        : lines.lineAt(absoluteOffset + Math.max(0, fence.raw.length - 1));
    const lang = (fence.lang ?? "").trim().split(/\s+/)[0] || null;
    into.fences.push({
      lang: lang ? lang.toLowerCase() : null,
      startLine,
      endLine,
      bytes: byteLength(fence.raw),
      sha256: sha256(fence.text ?? ""),
    });
    // A fence's body is never walked for links or code spans: its contents are
    // an EXAMPLE, not a citation, and treating one as the other is the same
    // mistake a line scanner makes with a heading-shaped line.
    return;
  }
  if (token.type === "codespan") {
    into.codeSpans.push(
      unescapeEntities(String((token as Tokens.Codespan).text ?? ""))
    );
    return;
  }
  if (token.type === "link") {
    const link = token as Tokens.Link;
    into.links.push({
      text: flattenInline(link.tokens as Token[] | undefined, link.text ?? ""),
      href: unescapeEntities(link.href ?? ""),
    });
    // Falls through: a link's own text may itself carry a code span.
  }

  const children = childTokens(token);
  if (children.length === 0) {
    return;
  }
  const parentSlice =
    absoluteOffset === null
      ? ""
      : source.slice(absoluteOffset, absoluteOffset + token.raw.length);
  let cursor = 0;
  for (const child of children) {
    let childOffset: number | null = null;
    if (absoluteOffset !== null) {
      const at = locateNested(parentSlice, child.raw ?? "", cursor);
      if (at >= 0) {
        childOffset = absoluteOffset + at;
        cursor = at + Math.max(1, (child.raw ?? "").length);
      }
    }
    collectFrom(child, childOffset, source, lines, into);
  }
}

/** JS `\s`, so the scan below splits a link exactly where a regex would. */
const LINK_SPACE = /\s/;

/** Where `([^)\s]+)` stops: the first `)` or whitespace after a link target. */
function isTargetStop(char: string): boolean {
  return char === ")" || LINK_SPACE.test(char);
}

/**
 * The index of the `)` that closes a link whose target stops at `stop`, or `-1`.
 * `(target)` and `(target "title")` are the only two shapes.
 */
function closingParenAt(text: string, stop: number): number {
  if (text[stop] === ")") {
    return stop;
  }
  let scan = stop;
  while (scan < text.length && LINK_SPACE.test(text[scan])) {
    scan += 1;
  }
  if (text[scan] !== '"') {
    return -1;
  }
  const quote = text.indexOf('"', scan + 1);
  if (quote < 0) {
    return -1;
  }
  return text[quote + 1] === ")" ? quote + 1 : -1;
}

/**
 * Flatten `[text](target)` — and `[text](target "title")`, whose title is dropped
 * — to `text target`, in ONE forward pass. Exported so a test can pin it on the
 * REAL corpus (see {@link topLevelRawSum}).
 *
 * WHY NOT THE REGEX IT REPLACES. `/\[([^\]]*)\]\(([^)\s]+)…\)/g` is quadratic in
 * the worst case: at every `[` the engine runs `[^\]]*` to the end of the
 * document and then gives the characters back one at a time looking for `]`, so a
 * file of unbalanced brackets costs O(n²) — MEASURED here at 200,000 brackets:
 * 41.6 SECONDS for the regex against 0.04 ms for this scan. One pathological
 * document does not get to hang a whole index build.
 *
 * WHY IT IS ACTUALLY LINEAR. The three cursors below only ever move FORWARD —
 * `closeAt` (the next `]`), `stopAt` (where the target ends) and `stopEnd` (the
 * `)` that closes it) are recomputed only once the scan has passed them — so
 * every character is examined a bounded number of times even when match after
 * match fails. The OUTPUT is unchanged: byte-identical to the old pattern on every
 * file of this repository's corpus and across 20,000 seeded fuzz strings over the
 * `[]()"` alphabet (`tests/parse.test.ts`).
 */
export function flattenLinkSyntax(text: string): string {
  let out = "";
  let i = 0;
  let closeAt = -1;
  let stopAt = -1;
  /** `-2` ⇒ not computed for the current `stopAt` yet. */
  let stopEnd = -2;
  while (i < text.length) {
    const open = text.indexOf("[", i);
    if (open < 0) {
      break;
    }
    if (closeAt < open) {
      closeAt = text.indexOf("]", open + 1);
      if (closeAt < 0) {
        break; // no `]` remains anywhere, so no later `[` can match either
      }
    }
    const targetStart = closeAt + 2;
    if (text[closeAt + 1] === "(") {
      if (stopAt < targetStart) {
        let scan = targetStart;
        while (scan < text.length && !isTargetStop(text[scan])) {
          scan += 1;
        }
        stopAt = scan;
        stopEnd = -2;
      }
      if (stopEnd === -2) {
        stopEnd = closingParenAt(text, stopAt);
      }
      // `[^)\s]+` needs at least one character, and the `)` must be there.
      if (stopAt > targetStart && stopEnd >= 0) {
        out +=
          text.slice(i, open) +
          text.slice(open + 1, closeAt) +
          " " +
          text.slice(targetStart, stopAt);
        i = stopEnd + 1;
        continue;
      }
    }
    // Not a link. Copy through the `[` and resume at the next character, which is
    // where the old pattern retried from.
    out += text.slice(i, open + 1);
    i = open + 1;
  }
  return out + text.slice(i);
}

/**
 * The BM25 body: the section's own bytes with every FENCE blanked (by the AST's
 * own line ranges, not a regex), inline-code markers dropped so a path-shaped
 * span survives as a term, and `[text](target)` flattened to `text target` so a
 * query naming either half still matches.
 */
function bodyText(
  slice: string,
  sectionStartLine: number,
  fences: DocFence[]
): string {
  const rows = slice.split("\n");
  for (const fence of fences) {
    if (fence.startLine === 0) {
      continue; // position unknown — blanking a guess would eat real prose
    }
    const from = Math.max(0, fence.startLine - sectionStartLine);
    const to = Math.min(rows.length - 1, fence.endLine - sectionStartLine);
    for (let i = from; i <= to; i += 1) {
      rows[i] = "";
    }
  }
  return flattenLinkSyntax(rows.join("\n").replace(/`+/g, " "));
}

/**
 * Parse one markdown document.
 *
 * `rawSource` is the file's text exactly as read; every offset, line number and
 * section hash below is taken against its NEWLINE-NORMALIZED form (see the
 * module note). `ParsedDoc.contentHash` and `ParsedDoc.bytes` describe the file
 * AS READ, because those are what the revalidator compares against the disk.
 */
export function parseMarkdown(docPath: string, rawSource: string): ParsedDoc {
  const source = rawSource.replace(/\r\n|\r/g, "\n");
  const lines = new LineIndex(source);
  const tokens = marked.lexer(source);

  // Pass 1: top-level offsets, and the heading cut points that define sections.
  type Placed = { token: Token; offset: number };
  const placed: Placed[] = [];
  let offset = 0;
  for (const token of tokens) {
    placed.push({ token, offset });
    offset += token.raw.length;
  }

  type Cut = { offset: number; depth: number; heading: string };
  const cuts: Cut[] = [];
  for (const entry of placed) {
    if (entry.token.type === "heading") {
      const heading = entry.token as Tokens.Heading;
      cuts.push({
        offset: entry.offset,
        depth: heading.depth,
        heading: flattenInline(
          heading.tokens as Token[] | undefined,
          heading.text ?? ""
        ),
      });
    }
  }

  // Pass 2: the section partition. The synthetic preamble ALWAYS exists so
  // `docPath#` is a valid coordinate for every file and no byte is unreachable;
  // when a document opens on its own `# Title` it is simply empty, reported as
  // `endLine === startLine - 1`.
  const deduper = new SlugDeduper();
  const stack: Cut[] = [];
  const sections: ParsedSection[] = [];
  const slices: string[] = [];

  const pushSection = (
    start: number,
    end: number,
    depth: number,
    heading: string | null,
    headingPath: string[],
    slug: string
  ): void => {
    const slice = source.slice(start, end);
    const startLine = lines.lineAt(start);
    slices.push(slice);
    sections.push({
      id: sectionIdOf(docPath, slug),
      docPath,
      depth,
      heading,
      headingPath,
      anchor: slug,
      startLine,
      endLine:
        slice.length === 0
          ? startLine - 1
          : lines.lineAt(start + slice.length - 1),
      bytes: byteLength(slice),
      contentHash: sha256(slice),
      text: "",
      fences: [],
      links: [],
      codeSpans: [],
    });
  };

  const firstCut = cuts.length > 0 ? cuts[0].offset : source.length;
  // The preamble takes its empty slug FROM THE DEDUPER, so `#` is a reserved
  // coordinate: a heading whose text is all punctuation (`## !!!`) slugs empty
  // too, and two sections sharing one id means the later one overwrites the
  // earlier in `DocsIndex.sections` — the same silent loss the deduper's loop
  // exists to prevent. It gets `-1` instead.
  pushSection(0, firstCut, 0, null, [], deduper.next(""));

  for (let i = 0; i < cuts.length; i += 1) {
    const cut = cuts[i];
    const end = i + 1 < cuts.length ? cuts[i + 1].offset : source.length;
    while (stack.length > 0 && stack[stack.length - 1].depth >= cut.depth) {
      stack.pop();
    }
    // The breadcrumb is the ANCESTOR STACK, so a depth-3 that follows a depth-1
    // reads `[h1, h3]` — a skipped level never invents a phantom parent (T4).
    const headingPath = [...stack.map((entry) => entry.heading), cut.heading];
    stack.push(cut);
    pushSection(
      cut.offset,
      end,
      cut.depth,
      cut.heading,
      headingPath,
      deduper.next(cut.heading)
    );
  }

  // Pass 3: attribute every top-level token's fences/links/code spans to the one
  // section its offset falls in. The partition makes that assignment total.
  let cursor = 0;
  for (const entry of placed) {
    while (cursor < cuts.length && entry.offset >= cuts[cursor].offset) {
      cursor += 1;
    }
    collectFrom(entry.token, entry.offset, source, lines, sections[cursor]);
  }

  for (let i = 0; i < sections.length; i += 1) {
    sections[i].text = bodyText(slices[i], sections[i].startLine, sections[i].fences);
  }

  const title = cuts.find((cut) => cut.depth === 1)?.heading ?? null;
  return {
    path: docPath,
    title,
    contentHash: sha256(rawSource),
    bytes: byteLength(rawSource),
    lines:
      source.length === 0
        ? 0
        : source.split("\n").length - (source.endsWith("\n") ? 1 : 0),
    sections,
  };
}

/**
 * The offset invariant, exposed so a test can assert it on the REAL corpus:
 * the sum of top-level `raw` lengths equals the normalized source length.
 */
export function topLevelRawSum(rawSource: string): {
  sum: number;
  length: number;
} {
  const source = rawSource.replace(/\r\n|\r/g, "\n");
  const tokens = marked.lexer(source);
  return {
    sum: tokens.reduce((total, token) => total + token.raw.length, 0),
    length: source.length,
  };
}
