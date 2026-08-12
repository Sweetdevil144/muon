/**
 * Entity extraction + linking (R2, docs/research/mem0-capability-reference.md §5.3).
 *
 * WHY. Today a note only ANCHORS if it names a module or a symbol. A note that
 * says "the Stripe webhook retry policy needs idempotency keys" anchors to
 * nothing, so it is invisible to anchor-based recall and reachable only if FTS or
 * the substring scan happens to hit it. `Entity` + `MENTIONS` closes that hole:
 * the durable nouns a note carries become first-class join keys, extracted from
 * the note's own text at ingest.
 *
 * WHAT WE TOOK FROM mem0 AND WHAT WE DID NOT. We take the SIGNAL (§5.3: query
 * entities, capped at 8, deduped, normalised, matched against a second index whose
 * hits point back at memories). We do NOT take their scoring (§5.2): their
 * candidate set comes only from semantic search, so a perfect entity match that
 * embeds poorly can never enter the result set, and their threshold gates the
 * semantic score BEFORE the entity boost is added. Our entity retriever emits a
 * full ranked LIST that enters `reciprocalRankFusion` as a peer of FTS/lexical/
 * dense, which has neither defect.
 *
 * THE ENTITY CLASSES ARE OURS, NOT THEIRS. mem0's extractor is spaCy tuned for
 * consumer nouns ("Paris", "Max the dog"). Code work-memory's durable nouns are
 * identifiers, file paths, symbol ids, quoted literals, error/exit codes, and
 * package names. Those are the classes below; a generic English noun is
 * deliberately NOT one, because the flat retrievers already read prose.
 *
 * TWO TIERS, LIKE THE FTS EXTENSION. The BASE tier is this file: pure regex, pure
 * function, zero dependencies, deterministic. mem0 ships spaCy as an OPTIONAL
 * extra (`pip install mem0ai[nlp]`) with documented graceful degradation; MUON
 * already runs that posture for the Ladybug FTS extension (try, and silently fall
 * back to a weaker tier when it will not load). `MuonGraph` mirrors it exactly:
 * it TRIES to create the Entity/MENTIONS tables at init and clears
 * `entitiesEnabled` if that fails, and an optional `entityExtractor` may be
 * INJECTED to enrich the base tier. Nothing here is a runtime dependency.
 *
 * UNTRUSTED INPUT. Note text is agent-authored and never reviewed before ingest,
 * so every dimension is bounded: characters scanned, entity length, entities per
 * note, entities per query. Nothing here is quadratic in the input.
 *
 * THE TEXT GATE IS NOT TOUCHED. An entity is a normalised FRAGMENT used as a join
 * key; it is never returned to a caller and never traversable. The retriever that
 * consumes it (`entityCandidates`) applies the SAME visibility + governed
 * predicate as the lexical scan, so an entity match can only ever surface a note
 * the caller could already have retrieved lexically. Per-chat scoping (#126)
 * therefore holds by construction: the join is note-scoped, never entity-scoped.
 */

/** The entity classes worth indexing for code work-memory. Ordered by how much
 *  evidence a match carries: a symbol id is a near-certain topic match, a
 *  capitalized multiword term is a hint. */
export type MemoryEntityKind =
  | "symbol"
  | "path"
  | "package"
  | "error"
  | "identifier"
  | "quoted"
  | "term";

export type MemoryEntity = {
  /** Normalised join key. THIS is what `MENTIONS` links and what a query matches. */
  key: string;
  /** The class that produced it, used to weight a match at query time. */
  kind: MemoryEntityKind;
};

// ---- bounds (every one of these is a guard on UNTRUSTED note text) ----------

/** Characters of a note scanned. Longer text is truncated, never rejected. */
export const MAX_ENTITY_SCAN_CHARS = 4_000;
/** Shortest accepted key — below this the signal is noise ("id", "ok"). */
export const MIN_ENTITY_CHARS = 3;
/** Longest accepted key. A minified blob or a pasted stack frame is dropped. */
export const MAX_ENTITY_CHARS = 64;
/** Entities persisted per note. Bounds the write fan-out per ingest. */
export const MAX_ENTITIES_PER_NOTE = 12;
/** Entities used from ONE query. mem0 caps theirs at 8 (§5.3); so do we. */
export const MAX_QUERY_ENTITIES = 8;

/**
 * How much a match on each class is worth when ranking entity candidates. A
 * symbol id or a path is an unambiguous coordinate; a capitalized term is a hint
 * that a common English phrase could produce by accident. Deliberately a fixed
 * table rather than a learned weight: the fused RRF rank is what the ranker
 * consumes, so only the ORDER within this one list matters.
 */
const KIND_WEIGHT: Record<MemoryEntityKind, number> = {
  symbol: 3,
  path: 3,
  package: 2.5,
  error: 2,
  identifier: 2,
  quoted: 1.5,
  term: 1,
};

export function entityKindWeight(kind: MemoryEntityKind): number {
  return KIND_WEIGHT[kind] ?? 1;
}

/** Priority for the per-query cap: when a query yields more than
 *  MAX_QUERY_ENTITIES, the most evidential classes survive. */
const KIND_PRIORITY: MemoryEntityKind[] = [
  "symbol",
  "path",
  "package",
  "identifier",
  "error",
  "quoted",
  "term",
];

// ---- patterns --------------------------------------------------------------
//
// Applied in priority order. Each pass MASKS the spans it consumed so a later,
// lower-priority pattern cannot re-extract a fragment of an earlier match (the
// one deliberate exception is a symbol id, which intentionally ALSO yields its
// path and its bare name — that is the entity-linking behaviour we want: a query
// naming `mod.ts#fn` must reach a note that only ever says `fn`).

const FILE_EXT = "ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|toml|sql|py|rs|go|sh|css|html";

/**
 * `<module>#<name>` — MUON's own symbol id shape (ADR-0012).
 *
 * EXPORTED, with {@link PATH_RE}, for two consumers that must ask "is this
 * path-shaped?" with THIS predicate and not a copy of it:
 * `docs/design/memory-index-validation.md` §1.3 binds the health harness to
 * "import them, never restate them" (the exact predicate IS the measurement), and
 * D15 promotes a path-shaped token out of note prose into a module anchor, which
 * is the same question a third time. A second copy of either pattern is drift this
 * repo has already paid for.
 *
 * BOTH CARRY `g`, SO BOTH ARE STATEFUL: `lastIndex` survives a call, so a bare
 * `PATH_RE.test(x)` in a loop silently skips alternate inputs — the trap
 * `COORDINATE_TOKEN_RE` in `scripts/memory-index-health.mjs` already carries a
 * comment about. `sweep` resets `lastIndex` before every pass; an outside caller
 * should use {@link pathShapedTokens} / {@link isPathShaped}, which do, rather
 * than touching these directly.
 */
export const SYMBOL_RE = new RegExp(
  `[\\w.@/-]*\\/[\\w.@-]+\\.(?:${FILE_EXT})#[A-Za-z_][\\w$]*`,
  "g"
);
/** A path with a separator, or a bare file name with a known code extension.
 *  Exported, and STATEFUL, for the reasons on {@link SYMBOL_RE}. */
export const PATH_RE = new RegExp(
  `(?:[\\w.@-]+\\/)+[\\w.@-]+\\.(?:${FILE_EXT})\\b|\\b[\\w.@-]+\\.(?:${FILE_EXT})\\b`,
  "g"
);
/** npm scoped package, e.g. `@ladybugdb/core`. */
const PACKAGE_RE = /@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/gi;
/**
 * Error / exit / status codes, the class an agent actually pastes: errno-style
 * `ENOENT`, signals `SIGKILL`, hex codes. These are worthless to a stemmer and
 * invisible to a term index, which is exactly why they earn their own class.
 *
 * CASE-SENSITIVE ON PURPOSE. An `i` flag here turns `E[A-Z]{3,}` into "any word
 * starting with e", which silently classifies `edit`, `enters` and `every` as
 * error codes and floods the index with English. Errno and signal names are
 * upper-case by definition, so the case IS the signal.
 */
const ERROR_CODE_RE = /\b(?:E[A-Z]{3,}|SIG[A-Z]{2,})\b|\b0x[0-9a-fA-F]{2,}\b/g;
/** The numeric half — `rc=0`, `exit 137`, `status 429`, `HTTP 503`. The digits
 *  make this unambiguous, so it is safe to match case-insensitively. */
const ERROR_NUMERIC_RE =
  /\b(?:rc|exit(?:\s+code)?|status(?:\s+code)?|code|errno)\s*[=:]?\s*\d{1,4}\b|\bHTTP\s?\d{3}\b/gi;
/**
 * Quoted literals — a flag, a config value, an exact message an agent must echo.
 * The single-quote arm is guarded by word-boundary lookarounds because an English
 * APOSTROPHE is the same character: without the guard, "the daemon's cwd, not the
 * task's" opens a quote at `daemon's` and closes it at `task's`, capturing a
 * sentence fragment as an entity.
 */
const QUOTED_RE =
  /"([^"\n]{3,64})"|(?<![A-Za-z0-9])'([^'\n]{3,64})'(?![A-Za-z0-9])|`([^`\n]{3,64})`/g;
/**
 * Identifiers with INTERNAL STRUCTURE only: snake_case, kebab-case,
 * SCREAMING_SNAKE, camelCase, PascalCase. The structure requirement is what keeps
 * ordinary English words out — `retry` is not an entity, `retryPolicy` is.
 */
const IDENTIFIER_RE =
  /\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+\b|\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;
/**
 * Runs of 1–4 Capitalized words — "Reciprocal Rank Fusion", "Stripe", "Postgres".
 * A single proper noun counts: a note saying "the Stripe webhook retry policy
 * needs idempotency keys" has exactly one durable noun and it is `Stripe`. The
 * sentence-position rule below is what makes a 1-word run safe.
 */
const TERM_RE = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,3}\b/g;

/**
 * Leading words that are grammar, not evidence. A sentence's first word is
 * capitalized by rule, so "The Stripe webhook…" would otherwise mint the term
 * "The Stripe" and "Every panel needs…" would mint "Every".
 *
 * A POSITIONAL rule ("drop whatever starts the sentence") was tried first and is
 * WRONG for this corpus: engineering notes routinely open on the product name
 * itself — "Ollama silently downloads…", "Postgres stays the hosted ledger…",
 * "Railway deploys go through the CLI…" — and the positional rule threw away the
 * single most useful entity in each. So the filter is a CLOSED CLASS of English
 * function words and imperative openers instead. It only ever COSTS an entity,
 * never admits one, and it contains no domain noun (adding one would be tuning
 * the extractor to the corpus).
 */
const TERM_LEAD_STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "when", "if", "every",
  "each", "our", "it", "its", "but", "and", "for", "no", "all", "do", "does",
  "run", "use", "never", "always", "any", "both", "after", "before", "only",
  "keep", "stop", "add", "set", "we", "you", "they", "there", "here", "some",
  "most", "without", "with", "while", "since", "unless", "because", "so",
  "then", "than", "from", "into", "over", "under", "once", "avoid", "prefer",
  "treat", "make", "ensure", "check", "call", "pass", "drop", "hold", "let",
  "allow", "deny", "given", "where", "what", "why", "how", "who", "which",
]);

/** Generic hyphenated/compound English that the identifier rule would otherwise
 *  admit. Kept SMALL and additive: a false entity is only noise, never a leak. */
const IDENTIFIER_STOPWORDS = new Set([
  "besteffort", "readonly", "writeonly", "opensource", "wellknown", "uptodate",
  "endtoend", "firstclass", "longrunning", "builtin", "outofscope",
]);

// ---- extraction ------------------------------------------------------------

/** Normalise a surface form into its join key. Identifiers are made CASE- AND
 *  SEPARATOR-INSENSITIVE (`RERANK_CALIBRATED`, `rerank-calibrated` and
 *  `rerankCalibrated` are one entity), which is precisely the match neither the
 *  stemmer nor the substring scan can make. Every other class keeps its shape and
 *  is only lowercased/whitespace-collapsed. */
function normalizeEntity(kind: MemoryEntityKind, value: string): string {
  const lower = value.toLowerCase().trim();
  if (kind === "identifier") {
    return lower.replace(/[^a-z0-9]/g, "");
  }
  if (kind === "term" || kind === "quoted") {
    return lower.replace(/\s+/g, " ");
  }
  if (kind === "error") {
    // `rc=0`, `rc: 0` and `rc 0` are one code; the separator carries nothing.
    return lower.replace(/[\s=:]+/g, " ").trim();
  }
  return lower;
}

type Collector = {
  seen: Set<string>;
  out: MemoryEntity[];
};

function collect(
  collector: Collector,
  kind: MemoryEntityKind,
  value: string
): void {
  const key = normalizeEntity(kind, value);
  if (key.length < MIN_ENTITY_CHARS || key.length > MAX_ENTITY_CHARS) {
    return;
  }
  if (kind === "identifier" && IDENTIFIER_STOPWORDS.has(key)) {
    return;
  }
  // Digits-only keys ("2026", "500") carry no topic; the error class already
  // captures the ones that matter, WITH their prefix.
  if (kind !== "error" && !/[a-z]/.test(key)) {
    return;
  }
  if (collector.seen.has(key)) {
    return;
  }
  collector.seen.add(key);
  collector.out.push({ key, kind });
}

/** Blank out a consumed span so a lower-priority pattern cannot re-match inside
 *  it. Same length in, same length out, so every later offset stays valid. */
function mask(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

function sweep(
  text: string,
  pattern: RegExp,
  onMatch: (match: RegExpExecArray) => void
): string {
  let masked = text;
  pattern.lastIndex = 0;
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    onMatch(match);
    masked = mask(masked, match.index, match.index + match[0].length);
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
    }
  }
  return masked;
}

/**
 * Extract the durable entities from one piece of text. Pure, deterministic, and
 * bounded in every dimension. Order of the returned list is extraction order
 * (highest-evidence class first), which is what the per-note / per-query caps
 * truncate against.
 */
export function extractEntities(
  text: string,
  limit = MAX_ENTITIES_PER_NOTE
): MemoryEntity[] {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }
  const collector: Collector = { seen: new Set(), out: [] };
  let rest = text.slice(0, MAX_ENTITY_SCAN_CHARS);

  // Symbol ids first, and they yield THREE entities: the id, its module path, and
  // its bare name. That is the link that lets a query naming
  // `memory-ranking.ts#rerankCalibrated` reach a note that only says
  // `rerankCalibrated`, which no substring scan over the note text can do.
  rest = sweep(rest, SYMBOL_RE, (match) => {
    const [full] = match;
    const hash = full.indexOf("#");
    collect(collector, "symbol", full);
    collect(collector, "path", full.slice(0, hash));
    collect(collector, "identifier", full.slice(hash + 1));
  });
  rest = sweep(rest, PATH_RE, (match) => collect(collector, "path", match[0]));
  rest = sweep(rest, PACKAGE_RE, (match) =>
    collect(collector, "package", match[0])
  );
  rest = sweep(rest, ERROR_CODE_RE, (match) =>
    collect(collector, "error", match[0])
  );
  rest = sweep(rest, ERROR_NUMERIC_RE, (match) =>
    collect(collector, "error", match[0])
  );
  rest = sweep(rest, QUOTED_RE, (match) =>
    collect(collector, "quoted", match[1] ?? match[2] ?? match[3] ?? "")
  );
  rest = sweep(rest, IDENTIFIER_RE, (match) =>
    collect(collector, "identifier", match[0])
  );
  sweep(rest, TERM_RE, (match) => {
    const words = match[0].split(/\s+/);
    const trimmed = TERM_LEAD_STOPWORDS.has(words[0]!.toLowerCase())
      ? words.slice(1)
      : words;
    if (trimmed.length >= 1) {
      collect(collector, "term", trimmed.join(" "));
    }
  });

  return collector.out.slice(0, Math.max(0, limit));
}

// ---- the path predicate, shared with the COORDINATE layer (D15) -------------
//
// D15 (`docs/design/memory-index-decisions.md` §D15, option B) promotes a
// path-shaped token in a note's own prose into a MODULE ANCHOR whenever the
// tracked-file set confirms it. That promotion, and the health harness's rows 18
// and 22, must ask "is this path-shaped?" with the SAME predicate the entity
// namespace asks with — otherwise the coordinate layer and the entity layer
// disagree about which tokens are coordinates, which is precisely the
// two-indexes-one-question shape §D15 rejected option C to avoid.
//
// These two functions are that seam. Both derive everything they answer from
// `SYMBOL_RE` / `PATH_RE` above; neither restates a pattern.

/**
 * The path-shaped tokens `text` names — extraction order, deduped, **with their
 * original case**.
 *
 * THE CASE IS THE WHOLE REASON this is not `extractEntities(…).filter(path)`. An
 * entity key is LOWERCASED (`normalizeEntity`) while the tracked-file set is keyed
 * by the repository's own spelling, so a lowercased key cannot be compared against
 * it without either losing the case assertion (`apps/cli/readme.md` looks correct
 * on a case-insensitive volume, which is why D1 resolves against `git ls-files`
 * and never against `stat`) or bolting a reverse lookup onto the extractor. The
 * SURFACE form is what a coordinate consumer needs; normalising it is the
 * consumer's business, and D15's promoter does exactly that, deliberately.
 *
 * A SYMBOL ID CONTRIBUTES ITS MODULE PREFIX, matching `extractEntities`' symbol
 * arm: a note naming `mod.ts#fn` names `mod.ts`. Measured caveat — 0 live entities
 * contain `#`, so that arm has never fired on real data.
 *
 * `scanChars` defaults to the entity namespace's OWN scan bound, because note text
 * is untrusted and `PATH_RE`'s `(?:segment/)+` can be made to backtrack. The health
 * harness opts out explicitly (it measures the whole note and runs on no request
 * path); nothing on a write path may.
 */
export function pathShapedTokens(
  text: string,
  scanChars = MAX_ENTITY_SCAN_CHARS
): string[] {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const keep = (value: string): void => {
    if (value.length === 0 || seen.has(value)) {
      return;
    }
    seen.add(value);
    out.push(value);
  };
  // Symbol ids first and MASKED, in the same order `extractEntities` sweeps them,
  // so both functions consume the same spans and can never disagree about which
  // token a `<module>#<name>` run contains.
  const rest = sweep(
    text.slice(0, Math.max(0, scanChars)),
    SYMBOL_RE,
    (match) => {
      const [full] = match;
      keep(full.slice(0, full.indexOf("#")));
    }
  );
  sweep(rest, PATH_RE, (match) => keep(match[0]));
  return out;
}

/** Whether the WHOLE of `value` is one path-shaped token. This is row 18's
 *  question ("is this `Entity` key a path?") asked with the production pattern
 *  instead of with an `extractEntities` round trip, which additionally applies the
 *  key-length bounds and the stopword lists and therefore answers a slightly
 *  different question. A symbol id is deliberately NOT path-shaped: it contains a
 *  path, and row 18 counts `#`-bearing keys separately. */
export function isPathShaped(value: string): boolean {
  const tokens = pathShapedTokens(value, value.length);
  return tokens.length === 1 && tokens[0] === value;
}

/**
 * Entities to use from a SEARCH QUERY. Same extractor, then re-ordered by class
 * priority and capped at 8 (mem0 §5.3), so a long query spends its budget on
 * coordinates rather than on whatever happened to appear first. Stable sort:
 * equal-priority entities keep extraction order, so the result is deterministic.
 */
export function extractQueryEntities(
  query: string,
  limit = MAX_QUERY_ENTITIES
): MemoryEntity[] {
  // Extract generously, then let the priority sort decide what survives the cap —
  // truncating at extraction order first would drop a symbol id that appears late.
  const all = extractEntities(query, MAX_ENTITIES_PER_NOTE * 2);
  return all
    .map((entity, index) => ({ entity, index }))
    .sort(
      (a, b) =>
        KIND_PRIORITY.indexOf(a.entity.kind) -
          KIND_PRIORITY.indexOf(b.entity.kind) || a.index - b.index
    )
    .slice(0, Math.max(0, limit))
    .map((row) => row.entity);
}

// ---- ranking (pure; the store and the eval harness share it) ---------------

export type EntityMention = {
  noteId: string;
  entityKey: string;
  /** Newest-first tiebreak, mirroring `searchMemoryLexical`. */
  createdAt: string;
};

/**
 * How common each query entity is in the corpus, and how big that corpus is.
 *
 * `df` is the number of ACTIVE notes mentioning a key; `activeNotes` is N. Both
 * are measured, never assumed — an absent key means "this key was not counted",
 * which {@link entityIdf} treats as df 0 (maximally rare) because a key nothing
 * mentions cannot be common.
 */
export type EntityCorpusStats = {
  readonly df: ReadonlyMap<string, number>;
  readonly activeNotes: number;
};

/**
 * INVERSE DOCUMENT FREQUENCY, `log((N + 1) / (df + 1))` — decision D-mem0-1.
 *
 * WHY IT EXISTS, measured rather than argued: on the founder's live brain the
 * entity keys `gitnexus` and `apps/cli/readme.md` each appear on 30 of 212 active
 * notes — 14% of the corpus apiece — and scored exactly like a key that appears
 * once. An entity arm without this term ranks by how COMMON a word is, which is
 * the opposite of what it is for. `npm run health:memory` row 19 alarms on
 * precisely this ("any key above ~10% of the active corpus with no IDF term").
 *
 * NOT mem0's curve. mem0 damps by `1/(1 + 0.001*(n-1)^2)`
 * (`Memory._compute_entity_boosts`), whose constants are tuned against an
 * ADDITIVE similarity score in [0, 0.5]. MUON's entity arm emits a RANK into RRF,
 * not a score, so those constants do not transfer; IDF is the principled version
 * of the same intuition and needs no tuning. Recorded in
 * `docs/design/memory-index-decisions.md` §5.
 *
 * The `+1`s are Laplace smoothing: they keep the ratio finite for df 0 and keep
 * the result non-negative for df = N (a key on EVERY note scores exactly 0, which
 * is the honest weight for a word that distinguishes nothing).
 */
export function entityIdf(key: string, corpus: EntityCorpusStats): number {
  // NO CORPUS ⇒ NO DISCOUNT, weight 1. This returned `log(1/1)` = exactly 0
  // before, which is not "a constant factor" — it is annihilation: every key's
  // weight became `kindWeight × 0`, every note scored 0, and the arm collapsed to
  // `createdAt DESC`. An adversarial review reproduced it: a note carrying all
  // three query entities including the exact symbol ranked BELOW a newer note
  // carrying one. That is the opposite of what the arm is for, and it is what the
  // failure path fed into RRF.
  //
  // 1 is the identity for the multiplication in `rankByEntityMentions`, so an
  // uncountable corpus now genuinely leaves the pre-IDF ranking — summed kind
  // weight over distinct matched entities — exactly as it was.
  if (corpus.activeNotes <= 0) {
    return 1;
  }
  const df = corpus.df.get(key) ?? 0;
  // A df larger than N would make the log negative and flip the sort. It should be
  // impossible (df counts distinct active notes), so clamp rather than trust it:
  // a miscounted corpus must degrade to "no discount", never to an inverted one.
  const bounded = Math.min(Math.max(df, 0), Math.max(corpus.activeNotes, 0));
  return Math.log((corpus.activeNotes + 1) / (bounded + 1));
}

/**
 * Rank notes by the entities they mention. A note scores the summed weight of the
 * DISTINCT query entities it carries, so mentioning one symbol id beats
 * mentioning three vague terms, and repeating an entity buys nothing. Ties break
 * on newest-first then id, so the list is totally ordered and deterministic.
 *
 * D-mem0-1: each entity's kind weight is scaled by its {@link entityIdf}, so a
 * corpus-wide key contributes almost nothing and a rare one dominates. This
 * changes the ORDER WITHIN the entity list, which is the only thing RRF consumes
 * from this arm — the right place for a popularity discount.
 *
 * `corpus` is REQUIRED rather than optional on purpose. An optional stats bag
 * would let a call site silently fall back to the un-discounted ranking that this
 * function existed with for two releases; required makes every caller a compile
 * error until it supplies real counts.
 *
 * This produces a RANKED LIST, not a score boost. That is the whole difference
 * from mem0 §5.2: the list joins `reciprocalRankFusion` as a peer retriever, so a
 * note with a bullseye entity match and a poor embedding still enters the
 * candidate set.
 */
export function rankByEntityMentions(
  mentions: EntityMention[],
  queryEntities: MemoryEntity[],
  limit: number,
  corpus: EntityCorpusStats
): string[] {
  const weightByKey = new Map(
    queryEntities.map((entity) => [
      entity.key,
      entityKindWeight(entity.kind) * entityIdf(entity.key, corpus),
    ])
  );
  const scores = new Map<
    string,
    { score: number; createdAt: string; keys: Set<string> }
  >();
  for (const mention of mentions) {
    const weight = weightByKey.get(mention.entityKey);
    if (weight === undefined) {
      continue;
    }
    const row = scores.get(mention.noteId) ?? {
      score: 0,
      createdAt: mention.createdAt,
      keys: new Set<string>(),
    };
    if (!row.keys.has(mention.entityKey)) {
      row.keys.add(mention.entityKey);
      row.score += weight;
    }
    if (mention.createdAt > row.createdAt) {
      row.createdAt = mention.createdAt;
    }
    scores.set(mention.noteId, row);
  }
  return [...scores.entries()]
    .sort(
      (a, b) =>
        b[1].score - a[1].score ||
        b[1].createdAt.localeCompare(a[1].createdAt) ||
        a[0].localeCompare(b[0])
    )
    .slice(0, Math.max(0, limit))
    .map(([noteId]) => noteId);
}
