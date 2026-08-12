import { pathToFileURL } from "node:url";
import { analyzeMemoryGraph } from "./memory-analytics.js";
import {
  extractEntities,
  extractQueryEntities,
  rankByEntityMentions,
  type EntityMention,
  type MemoryEntity,
} from "./memory-entities.js";
import {
  CENTRALITY_PRIOR_WEIGHT,
  DEFAULT_CALIBRATED_WEIGHTS,
  cosine,
  reciprocalRankFusion,
  rerankCalibrated,
  tokenize,
  type CalibratedWeights,
  type RankInput,
} from "./memory-ranking.js";
import { dcg, precisionAtK, reciprocalRank } from "./retrieval-eval.js";
import { deriveModulesFromSymbols, moduleOfSymbol } from "./symbol-id.js";
import type {
  MemoryGraphRelation,
  MemoryKind,
  MemoryNoteRecord,
  MemoryTrust,
} from "./types.js";

/**
 * KG-12 GRAPH-VALUE ablation: does GRAPH STRUCTURE measurably beat flat hybrid
 * search on the SAME memory corpus?
 *
 * WHY THIS EXISTS. mem0 shipped a graph-memory subsystem, kept it for a year, and
 * deleted it (PR #4805) in favour of flat hybrid scoring. MUON carries the same
 * bet (`memoryNeighbors` N-hop traversal, a centrality ranking prior, provenance
 * paths), so before investing further we measure each signal's MARGINAL
 * contribution and its COST, per signal, on one corpus, with the ablation visible.
 *
 * WHAT IS ABLATED (each arm ADDS one signal to the arm above it):
 *   1. `fts`            BM25 over note TEXT only — mirrors the store's FTS index,
 *                       which is created over `['text']` and nothing else.
 *   2. `fts+lex`        + the always-on lexical scan, which matches over
 *                       text+kind+topics+MODULES. This arm is the honest control
 *                       for traversal: MUON already reads its anchors as TEXT.
 *   3. `+dense`         + semantic cosine candidates (the optional embeddings tier).
 *   4. `+entity`        + the R2 entity retriever (mem0 §5.3's signal, fused
 *                       through OUR RRF rather than their additive boost). A
 *                       FLAT signal: it adds candidates, so unlike the two arms
 *                       below it can move recall, not just order.
 *   5. `+centrality`    + the note↔module PageRank prior fed to the calibrated
 *                       ranker (CENTRALITY_PRIOR_WEIGHT). Candidates unchanged —
 *                       this arm can only REORDER, so it isolates the prior.
 *   6. `+centrality-tiebreak`  the same prior narrowed to a LAST-RESORT tie-break
 *                       (it may only separate exactly-equal calibrated totals).
 *                       The steelman for keeping centrality at all.
 *   7. `+graph-1hop`    + candidates discovered by bounded traversal from the flat
 *                       top-3 seeds (the `memoryNeighbors` edge vocabulary).
 *   8. `+graph-2hop`    + the same at two hops. This is the SHIPPED default
 *                       contract: no relFilter, so all twelve relations, and
 *                       note→anchor→note is only reachable at hop 2.
 *   9. `+graph-2hop-anchors`  the STEELMAN: hop 2 restricted to anchor edges, so
 *                       the principal fan-out ("every note this author wrote")
 *                       is excluded and only the defensible path remains.
 *  10. `+graph-2hop-backfill` the SAFEST POSSIBLE traversal: anchors only, and
 *                       appended AFTER every flat result so it can never displace
 *                       one. If traversal shows no gain here, no fusion weighting
 *                       can rescue it — the two arms bracket every design between
 *                       "competes with flat results" and "cannot touch them".
 *
 * AND AT THREE WIDTHS, so a negative result cannot hide behind one setting:
 *   WIDE      shipped `searchMemory` defaults (pool 30, k 10);
 *   TIGHT     pool 10, k 5 — flat retrieval has to actually choose;
 *   DENSE-OFF no embedder at all, which is the DEFAULT local-first install and
 *             also the hedge against this harness's biggest bias (see below).
 *
 * FAITHFUL, NOT THE STORE ITSELF — the same arrangement `retrieval-eval` and
 * `activity-eval` use. The retrievers here mirror the shipped ones
 * (`searchMemoryFts` → BM25 over text, `searchMemoryLexical` → substring hits over
 * the text+kind+topics+modules haystack, `semanticCandidates` → cosine, then
 * `reciprocalRankFusion` → `rerankCalibrated`, all REUSED, not re-implemented) and
 * the traversal expander mirrors `traverseMemoryGraph`'s BFS over the SAME twelve
 * relations with the same hop/node caps. The store needs LadybugDB + a real FTS
 * extension, so the arms run against a pure in-memory mirror; the companion test
 * loads the SAME corpus into a REAL `MuonGraph` and probes real latency.
 *
 * THE TEXT GATE IS NOT WEAKENED HERE. The traversal expander consumes a
 * COORDINATE-ONLY projection (`TraversalNode` has no text field, by type), exactly
 * like the shipped traversal, which emits prose only for a confirmed or same-chat
 * crew-visible node. Traversal therefore contributes note IDENTITY to the fusion,
 * never note prose — and the gated view drops unconfirmed notes at the end, as
 * `applyGate` does.
 *
 * HONEST SCOPE (say it plainly, up front). The corpus is DESIGNER-AUTHORED from
 * facts that are visible in this repository, anchored to REAL module and symbol
 * coordinates. It is NOT a sample of the founder's actual brain (that store is
 * private local data and was deliberately not read), so it cannot claim
 * distributional fidelity to real usage — only structural realism. The labels are
 * ours. A corpus can be built that makes traversal look free (omit the notes a hot
 * module accumulates) or useless (make every answer share the query's words), so
 * the harness publishes a REACHABILITY AUDIT before any arm runs — how many gold
 * notes each retriever can even see — and reports metrics PER CAPABILITY CLASS, so
 * a reader can reweight the mix instead of trusting ours.
 *
 * THE BIGGEST KNOWN BIAS, stated so it is not discovered later: the stand-in dense
 * space is a small hand-assigned concept mixture, which is CLEANER than any real
 * embedding model. That makes the dense arm close to a topic oracle, which
 * SUPPRESSES the headroom left for traversal and therefore biases this eval
 * AGAINST the graph. The DENSE-OFF profile removes that bias entirely; read it
 * before accepting any conclusion about traversal.
 *
 * TWO STRUCTURAL FACTS that shape every number here, both verified in the
 * companion test rather than assumed:
 *   - A superseded note is `status:'rejected'`, so it is not in the active set any
 *     flat retriever queries. SUPERSEDES traversal therefore cannot add
 *     CURRENT-SET recall at all; it serves history, as-of reads and provenance.
 *   - A contradicted note is demoted to a strictly lower tier by `rankTier`. So
 *     CONTRADICTS traversal surfaces notes the ranker is designed to push down.
 *   That leaves note→anchor→note as the only relation family with any recall
 *   upside — and `searchMemoryLexical` already matches those same anchors as text.
 */

export const GRAPH_VALUE_EVAL_HONESTY =
  "Ablation of MUON's graph retrieval signals over one designer-authored corpus " +
  "anchored to real repo coordinates. It measures the MARGINAL recall/precision/" +
  "nDCG/MRR of each signal and its per-query store-round-trip cost. It is NOT a " +
  "large-corpus generalization benchmark and NOT a sample of real user memory " +
  "(the private local brain was deliberately not read). Labels are ours; the " +
  "reachability audit and the per-capability breakdown are published so the mix " +
  "can be reweighted rather than trusted.";

// ── corpus shapes (coordinates + labels; the fixture supplies the data) ──────

/** A note in the eval corpus. `concepts` is the SUBJECT-MATTER mixture that
 *  stands in for a dense embedding; it is assigned from what the note is ABOUT
 *  and never from the note's graph position or its labels (the rule that keeps
 *  the dense arm from being rigged for or against traversal). */
export type EvalNote = {
  id: string;
  kind: MemoryKind;
  text: string;
  modules: string[];
  symbols?: string[];
  topics?: string[];
  taskId?: string;
  laneId?: string;
  /** Authoring principal id, e.g. "human:founder" / "agent:codex". */
  principal: string;
  trust: MemoryTrust;
  confirmed: boolean;
  chatId: string;
  /** Age in days before `EVAL_NOW`; the recency signal is threaded, never clocked. */
  ageDays: number;
  concepts: Record<string, number>;
  /** Retired by a successor (status 'rejected'): out of the current active set,
   *  reachable only through SUPERSEDES / an as-of read. */
  supersededBy?: string;
  /** This note contradicts that one (both stay active; the ranker demotes both). */
  contradicts?: string;
  stale?: boolean;
};

export type EvalCapability =
  | "lexical"
  | "paraphrase"
  | "anchor-named"
  | "edit-intent"
  | "lineage"
  | "contradiction";

export type EvalQuery = {
  id: string;
  capability: EvalCapability;
  text: string;
  concepts: Record<string, number>;
  /** Graded relevance by note id; an unlisted note is 0. 3 = answers it,
   *  2 = would change the agent's action, 1 = useful context, 0 = irrelevant. */
  labels: Record<string, number>;
  /** Why these labels — the rubric applied, recorded so a reviewer can contest it. */
  rationale: string;
};

/** A task/lane/approval layer, so the traversal fan-out (and its cost) is the
 *  REAL fan-out, not a note-only toy. */
export type EvalTask = {
  id: string;
  modules: string[];
  laneId?: string;
  approvalId?: string;
};

export type GraphValueEvalSet = {
  /** Fixed instant; nothing in the eval reads the wall clock. */
  now: string;
  /** Ordered concept basis for the stand-in dense space. */
  basis: string[];
  notes: EvalNote[];
  tasks: EvalTask[];
  queries: EvalQuery[];
};

// ── projection helpers ──────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Normalized dense vector over the fixed concept basis. */
export function conceptVector(
  basis: string[],
  mix: Record<string, number>
): number[] {
  const raw = basis.map((concept) => Math.max(0, mix[concept] ?? 0));
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? raw : raw.map((value) => value / norm);
}

/** Corpus note → the real `MemoryNoteRecord` the shipped ranker consumes, so the
 *  arms rank through `rerankCalibrated` verbatim rather than a look-alike. */
export function toNoteRecord(note: EvalNote, nowMs: number): MemoryNoteRecord {
  const createdAt = new Date(nowMs - note.ageDays * DAY_MS).toISOString();
  const modules = [
    ...new Set([...note.modules, ...deriveModulesFromSymbols(note.symbols ?? [])]),
  ];
  return {
    id: note.id,
    kind: note.kind,
    text: note.text,
    taskId: note.taskId ?? null,
    laneId: note.laneId ?? null,
    chatId: note.chatId,
    modules,
    topics: note.topics ?? [],
    symbols: note.symbols ?? [],
    trust: note.trust,
    confirmed: note.confirmed,
    stale: Boolean(note.stale),
    status: note.supersededBy ? "rejected" : "active",
    createdBy: note.principal,
    createdAt,
    updatedAt: createdAt,
    validFrom: createdAt,
    validTo: note.supersededBy ? createdAt : null,
    invalidatedAt: note.supersededBy ? createdAt : null,
    invalidatedBy: note.supersededBy ? "superseded" : null,
    scope: "project",
    staleSince: note.stale ? createdAt : null,
    supersededBy: note.supersededBy ?? null,
    accessCount: 0,
    lastAccessedAt: null,
    conflictsWith: note.contradicts ?? null,
  };
}

// ── retrievers (faithful mirrors of the shipped candidate queries) ───────────

/** BM25 over note TEXT only — the store's FTS index is `CREATE_FTS_INDEX(...,
 *  ['text'], ...)`, so anchors are invisible to this retriever by construction.
 *  Canonical k1/b; ranked ids, best first. Only ACTIVE notes, mirroring
 *  `searchMemoryFts`'s `status === 'active'` filter. */
export function bm25Rank(
  query: string,
  notes: MemoryNoteRecord[],
  limit: number
): string[] {
  const K1 = 1.2;
  const B = 0.75;
  const docs = notes.map((note) => ({ id: note.id, tokens: tokenize(note.text) }));
  if (docs.length === 0) {
    return [];
  }
  const avgLen =
    docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / docs.length || 1;
  const queryTokens = [...new Set(tokenize(query))];
  const df = new Map<string, number>();
  for (const token of queryTokens) {
    df.set(token, docs.filter((doc) => doc.tokens.includes(token)).length);
  }
  return docs
    .map((doc) => {
      let score = 0;
      for (const token of queryTokens) {
        const frequency = doc.tokens.filter((t) => t === token).length;
        if (frequency === 0) {
          continue;
        }
        const n = df.get(token) ?? 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score +=
          (idf * (frequency * (K1 + 1))) /
          (frequency + K1 * (1 - B + (B * doc.tokens.length) / avgLen));
      }
      return { id: doc.id, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((entry) => entry.id);
}

/** The always-on lexical scan — mirrors `searchMemoryLexical` exactly: up to 8
 *  whitespace tokens, counted as SUBSTRING hits over the
 *  text+kind+topics+modules haystack, ties broken by newest first. This is the
 *  retriever that already reads MUON's anchors, so it is the control any graph
 *  expansion has to beat. */
export function lexicalRank(
  query: string,
  notes: MemoryNoteRecord[],
  limit: number
): string[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (tokens.length === 0) {
    return [];
  }
  return notes
    .map((note) => {
      const haystack = [note.text, note.kind, ...note.topics, ...note.modules]
        .join(" ")
        .toLowerCase();
      return {
        note,
        hits: tokens.filter((token) => haystack.includes(token)).length,
      };
    })
    .filter((entry) => entry.hits > 0)
    .sort(
      (a, b) =>
        b.hits - a.hits || b.note.createdAt.localeCompare(a.note.createdAt)
    )
    .slice(0, limit)
    .map((entry) => entry.note.id);
}

/** Dense semantic candidates — mirrors `semanticCandidates`: cosine against every
 *  active note's vector, positive scores only, top-k. Uses the REAL `cosine`. */
export function denseRank(
  queryVector: number[],
  vectors: Map<string, number[]>,
  notes: MemoryNoteRecord[],
  limit: number
): string[] {
  return notes
    .map((note) => ({
      id: note.id,
      score: cosine(queryVector, vectors.get(note.id) ?? []),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((entry) => entry.id);
}

/**
 * Entity candidates (R2) — mirrors the store's `entityCandidates`: extract the
 * query's entities (capped at 8, mem0 §5.3), find every ACTIVE note that MENTIONS
 * one, and rank by the summed class weight of the DISTINCT entities matched.
 *
 * The mirror is faithful in the two ways that matter. First, it consumes the same
 * `extractQueryEntities` / `rankByEntityMentions` the store consumes, so ranking
 * logic cannot drift between harness and production. Second, it reads only from
 * `notes` — the already-visibility-filtered active set — which is the
 * harness-side expression of the store applying the IDENTICAL visibility +
 * governed WHERE clause to the entity join. An entity match can therefore never
 * reach a note the caller could not already have retrieved lexically.
 */
export function entityRank(
  query: string,
  notes: MemoryNoteRecord[],
  mentions: Map<string, MemoryEntity[]>,
  limit: number
): string[] {
  const queryEntities = extractQueryEntities(query);
  if (queryEntities.length === 0) {
    return [];
  }
  const rows: EntityMention[] = [];
  // D-mem0-1: the eval computes the SAME corpus statistics the store queries for,
  // over its own fixture corpus — `df` per key and N — so the ablation measures the
  // IDF-weighted arm the product actually ships. Deriving them here rather than
  // hard-coding them keeps the harness honest when the fixture grows.
  const df = new Map<string, number>();
  for (const note of notes) {
    for (const entity of mentions.get(note.id) ?? []) {
      rows.push({
        noteId: note.id,
        entityKey: entity.key,
        createdAt: note.createdAt,
      });
    }
    // Distinct keys per note, matching the store's `count(DISTINCT n.id)`.
    for (const key of new Set(
      (mentions.get(note.id) ?? []).map((entity) => entity.key)
    )) {
      df.set(key, (df.get(key) ?? 0) + 1);
    }
  }
  return rankByEntityMentions(rows, queryEntities, limit, {
    df,
    activeNotes: notes.length,
  });
}

// ── traversal expansion (coordinate-only, mirrors traverseMemoryGraph) ───────

/**
 * A traversal node. COORDINATES ONLY, BY TYPE — there is deliberately no `text`
 * field here, so the expander cannot read note prose even for a confirmed note,
 * let alone an unconfirmed one. This is the harness-side expression of the
 * shipped `MemoryGraphNode` text policy (`MEMORY_TRAVERSAL_TEXT_POLICY`).
 */
export type TraversalNode = {
  id: string;
  type: "note" | "principal" | "module" | "symbol" | "task" | "lane" | "approval";
  entityId: string;
};

export type TraversalEdge = {
  from: string;
  to: string;
  relation: MemoryGraphRelation;
};

export type TraversalIndex = {
  nodes: Map<string, TraversalNode>;
  /** Adjacency in BOTH directions, tagged with the relation that was walked. */
  out: Map<string, Array<{ to: string; relation: MemoryGraphRelation }>>;
};

const nodeKey = (type: TraversalNode["type"], entityId: string): string =>
  `${type}:${entityId}`;

/**
 * Build the coordinate-only traversal index from the corpus, mirroring the
 * relationships `memoryTraversalNeighbors` walks: ANCHORED_TO, ABOUT_SYMBOL,
 * ABOUT_TASK, BY_LANE, AUTHORED_BY, CONFIRMED_BY, SUPERSEDES, CONTRADICTS,
 * TOUCHED, WORKED_ON, GATED_BY (CLONED_FROM has no corpus instance). Every edge
 * is stored in both directions because the shipped BFS also walks each
 * relationship's `in` branch.
 */
export function buildTraversalIndex(set: GraphValueEvalSet): TraversalIndex {
  const nodes = new Map<string, TraversalNode>();
  const out = new Map<string, Array<{ to: string; relation: MemoryGraphRelation }>>();
  const ensure = (type: TraversalNode["type"], entityId: string): string => {
    const id = nodeKey(type, entityId);
    if (!nodes.has(id)) {
      nodes.set(id, { id, type, entityId });
      out.set(id, []);
    }
    return id;
  };
  const link = (from: string, to: string, relation: MemoryGraphRelation) => {
    out.get(from)!.push({ to, relation });
    out.get(to)!.push({ to: from, relation });
  };

  for (const note of set.notes) {
    const n = ensure("note", note.id);
    const modules = [
      ...new Set([
        ...note.modules,
        ...(note.symbols ?? [])
          .map((symbol) => moduleOfSymbol(symbol))
          .filter((module): module is string => Boolean(module)),
      ]),
    ];
    for (const module of modules) {
      link(n, ensure("module", module), "ANCHORED_TO");
    }
    for (const symbol of note.symbols ?? []) {
      link(n, ensure("symbol", symbol), "ABOUT_SYMBOL");
    }
    if (note.taskId) {
      link(n, ensure("task", note.taskId), "ABOUT_TASK");
    }
    if (note.laneId) {
      link(n, ensure("lane", note.laneId), "BY_LANE");
    }
    link(n, ensure("principal", note.principal), "AUTHORED_BY");
    if (note.confirmed) {
      link(n, ensure("principal", "human:founder"), "CONFIRMED_BY");
    }
  }
  for (const note of set.notes) {
    if (note.supersededBy) {
      link(
        ensure("note", note.supersededBy),
        ensure("note", note.id),
        "SUPERSEDES"
      );
    }
    if (note.contradicts) {
      link(ensure("note", note.id), ensure("note", note.contradicts), "CONTRADICTS");
    }
  }
  for (const task of set.tasks) {
    const t = ensure("task", task.id);
    for (const module of task.modules) {
      link(t, ensure("module", module), "TOUCHED");
    }
    if (task.laneId) {
      link(ensure("lane", task.laneId), t, "WORKED_ON");
    }
    if (task.approvalId) {
      link(t, ensure("approval", task.approvalId), "GATED_BY");
    }
  }
  return { nodes, out };
}

/**
 * Store round-trips the SHIPPED traversal issues, per node type, per relation —
 * the real cost, not a guess. `memoryTraversalNode` is one query per visited
 * node; `memoryTraversalNeighbors` issues ONE query per relationship BRANCH of
 * the node's type, and a branch whose relation is filtered out returns before
 * querying. A note has twelve branches (SUPERSEDES and CONTRADICTS and
 * CLONED_FROM are walked in BOTH directions, hence 2 each), which is why a
 * `relFilter` has to be modelled per relation rather than as a flat cap: a
 * flat cap would OVERCHARGE the anchors-only arm and bias the comparison
 * against it.
 */
const EXPANSION_BRANCHES: Record<
  TraversalNode["type"],
  Partial<Record<MemoryGraphRelation, number>>
> = {
  note: {
    SUPERSEDES: 2,
    CONTRADICTS: 2,
    CLONED_FROM: 2,
    AUTHORED_BY: 1,
    CONFIRMED_BY: 1,
    ANCHORED_TO: 1,
    ABOUT_SYMBOL: 1,
    ABOUT_TASK: 1,
    BY_LANE: 1,
  },
  principal: { AUTHORED_BY: 1, CONFIRMED_BY: 1 },
  module: { ANCHORED_TO: 1, TOUCHED: 1 },
  symbol: { ABOUT_SYMBOL: 1 },
  task: { ABOUT_TASK: 1, TOUCHED: 1, GATED_BY: 1, WORKED_ON: 1 },
  lane: { BY_LANE: 1, WORKED_ON: 1 },
  approval: { GATED_BY: 1 },
};

/** Queries one expansion of `type` costs under `allowed` (all relations when
 *  null). Sums only the branches that would actually run. */
export function expansionQueryCost(
  type: TraversalNode["type"],
  allowed: ReadonlySet<MemoryGraphRelation> | null
): number {
  let total = 0;
  for (const [relation, branches] of Object.entries(EXPANSION_BRANCHES[type])) {
    if (!allowed || allowed.has(relation as MemoryGraphRelation)) {
      total += branches;
    }
  }
  return total;
}

export type ExpansionHit = {
  noteId: string;
  hops: number;
  /** The relation walked on the FINAL hop into this note (what "found" it). */
  relation: MemoryGraphRelation;
};

export type ExpansionResult = {
  /** Discovered note ids in BFS order (seeds excluded), best-first by hop. */
  hits: ExpansionHit[];
  /** Store round-trips the real traversal would have issued for this expansion. */
  storeQueries: number;
  truncated: boolean;
};

/** The relation subset a caller can pass as `memoryNeighbors`' `relFilter`.
 *  Anchors only — the STEELMAN configuration for retrieval, which drops the
 *  principal edges whose fan-out is every note the same author ever wrote. */
export const ANCHOR_ONLY_RELATIONS: MemoryGraphRelation[] = [
  "ANCHORED_TO",
  "ABOUT_SYMBOL",
  "ABOUT_TASK",
];

/**
 * Bounded BFS over the coordinate index, mirroring `traverseMemoryGraph`: a hop
 * cap, a node cap, breadth-first order, visited-set dedup, and the same
 * `relFilter` semantics (an unlisted relation is simply never walked, which also
 * removes its per-branch query from the cost). Seeds are the flat retrieval's
 * top ids — a graph has no query entry point of its own, so this is the only
 * honest way to give traversal a starting position.
 */
export function graphExpand(
  index: TraversalIndex,
  seedNoteIds: string[],
  hops: number,
  relations?: MemoryGraphRelation[],
  nodeLimit = 100
): ExpansionResult {
  const allowed = relations ? new Set(relations) : null;
  const seeds = new Set(seedNoteIds.map((id) => nodeKey("note", id)));
  const visited = new Set<string>(seeds);
  const hits: ExpansionHit[] = [];
  let storeQueries = 0;
  let truncated = false;
  let frontier = [...seeds].filter((id) => index.nodes.has(id));
  storeQueries += frontier.length; // one node load per seed

  for (let hop = 1; hop <= hops; hop += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      const node = index.nodes.get(current);
      if (!node) {
        continue;
      }
      // A filtered-out relation costs nothing: the shipped `connect()` returns
      // before issuing its query when the relation is not in the allowed set.
      storeQueries += expansionQueryCost(node.type, allowed);
      for (const step of index.out.get(current) ?? []) {
        if (allowed && !allowed.has(step.relation)) {
          continue;
        }
        if (visited.has(step.to)) {
          continue;
        }
        if (visited.size >= nodeLimit) {
          truncated = true;
          break;
        }
        visited.add(step.to);
        storeQueries += 1; // memoryTraversalNode load for the newly seen node
        const neighbor = index.nodes.get(step.to)!;
        if (neighbor.type === "note") {
          hits.push({ noteId: neighbor.entityId, hops: hop, relation: step.relation });
        }
        next.push(step.to);
      }
    }
    frontier = next;
  }
  return { hits, storeQueries, truncated };
}

// ── metrics ─────────────────────────────────────────────────────────────────

/** Recall@k against the FULL gold set (not just what was retrieved). */
export function recallAtK(
  rankedIds: string[],
  labels: Record<string, number>,
  k: number,
  threshold = 2
): number {
  const gold = Object.entries(labels).filter(([, label]) => label >= threshold);
  if (gold.length === 0) {
    return 1;
  }
  const top = new Set(rankedIds.slice(0, k));
  return gold.filter(([id]) => top.has(id)).length / gold.length;
}

/**
 * nDCG@k against the IDEAL ordering of the FULL gold set. The reranking harness
 * in `retrieval-eval` divides by the ideal over the RETRIEVED labels, which is
 * correct when every candidate is handed to the ranker but would let an arm that
 * retrieves nothing relevant score 1.0 here — this is a RETRIEVAL eval, so the
 * ideal must come from the labels, not from the result list. Reuses `dcg`.
 */
export function ndcgFull(
  rankedIds: string[],
  labels: Record<string, number>,
  k: number
): number {
  const ranked = rankedIds.map((id) => labels[id] ?? 0);
  const ideal = Object.values(labels).sort((a, b) => b - a);
  const idcg = dcg(ideal, k);
  return idcg === 0 ? 0 : dcg(ranked, k) / idcg;
}

// ── the arms ────────────────────────────────────────────────────────────────

export type ArmId =
  | "fts"
  | "fts+lex"
  | "fts+lex+dense"
  | "+entity"
  | "+centrality"
  | "+centrality-tiebreak"
  | "+graph-1hop"
  | "+graph-2hop"
  | "+graph-2hop-anchors"
  | "+graph-2hop-backfill";

export const ARM_IDS: ArmId[] = [
  "fts",
  "fts+lex",
  "fts+lex+dense",
  "+entity",
  "+centrality",
  "+centrality-tiebreak",
  "+graph-1hop",
  "+graph-2hop",
  "+graph-2hop-anchors",
  "+graph-2hop-backfill",
];

/**
 * How an arm applies the note↔module centrality prior.
 *  - `off`      : ignored entirely. THE SHIPPED DEFAULT since KG-12.
 *  - `score`    : added to the calibrated total at CENTRALITY_PRIOR_WEIGHT — the
 *                 pre-KG-12 behaviour, kept so the disqualifying measurement stays
 *                 reproducible.
 *  - `tiebreak` : allowed only to separate EXACTLY-equal calibrated totals. The
 *                 steelman: in this position the prior cannot overturn any
 *                 relevance or governance decision, so it is non-negative by
 *                 construction — the only question is whether it ever fires.
 */
export type CentralityMode = "off" | "score" | "tiebreak";

export type ArmConfig = {
  fts: boolean;
  lexical: boolean;
  dense: boolean;
  /** R2: the entity retriever as a peer RRF list. */
  entity: boolean;
  centrality: CentralityMode;
  /** 0 = no traversal expansion. */
  graphHops: number;
  /** `relFilter` for the expansion; absent = the shipped default (all twelve). */
  relations?: MemoryGraphRelation[];
  /**
   * How expanded candidates enter the result.
   *  - `fuse`     : as a peer RRF list, the way `searchMemory` fuses its
   *                 retrievers. Expanded notes compete with, and can displace,
   *                 flat results.
   *  - `backfill` : appended AFTER every flat result, ordered by hop. Cannot
   *                 displace anything, so it can only fill slots the flat
   *                 retrievers left empty. This is the STRICTLY SAFEST way to
   *                 spend traversal, and the fair test of whether the notes it
   *                 uniquely reaches are worth anything at all.
   */
  graphMode?: "fuse" | "backfill";
};

export const ARM_CONFIGS: Record<ArmId, ArmConfig> = {
  fts: { fts: true, lexical: false, dense: false, entity: false, centrality: "off", graphHops: 0 },
  "fts+lex": { fts: true, lexical: true, dense: false, entity: false, centrality: "off", graphHops: 0 },
  "fts+lex+dense": { fts: true, lexical: true, dense: true, entity: false, centrality: "off", graphHops: 0 },
  // R2: the entity retriever as a FOURTH peer list into the SAME RRF. Compare it
  // against `fts+lex+dense`, which is identical minus the entity list — the delta
  // is the entity signal and nothing else.
  "+entity": { fts: true, lexical: true, dense: true, entity: true, centrality: "off", graphHops: 0 },
  // The prior as a score term (the pre-KG-12 shipped behaviour).
  "+centrality": { fts: true, lexical: true, dense: true, entity: false, centrality: "score", graphHops: 0 },
  // The prior narrowed to a last-resort tie-break — the only variant that could
  // survive, since it cannot overturn a decision the score already made.
  "+centrality-tiebreak": { fts: true, lexical: true, dense: true, entity: false, centrality: "tiebreak", graphHops: 0 },
  // The traversal arms keep `centrality: "score"`, the configuration they were
  // MEASURED in when the KG-12 verdict was reached. Re-baselining them onto the
  // post-cut ranker would silently change the numbers the traversal conclusion
  // rests on, so they are deliberately left as they were.
  "+graph-1hop": { fts: true, lexical: true, dense: true, entity: false, centrality: "score", graphHops: 1 },
  // The DEFAULT traversal contract: `memoryNeighbors(id, {hops:2})` with no
  // relFilter walks all twelve relations, including AUTHORED_BY/CONFIRMED_BY.
  "+graph-2hop": { fts: true, lexical: true, dense: true, entity: false, centrality: "score", graphHops: 2 },
  // The STEELMAN: the same traversal restricted to anchor edges, i.e. the
  // note→module/symbol/task→note path that is the only one with any retrieval
  // rationale. If traversal cannot earn its keep HERE it cannot earn it anywhere.
  "+graph-2hop-anchors": {
    fts: true,
    lexical: true,
    dense: true,
    entity: false,
    centrality: "score",
    graphHops: 2,
    relations: ANCHOR_ONLY_RELATIONS,
  },
  // The SAFEST possible traversal: anchors only, appended after every flat
  // result so it can never displace one. If traversal cannot show a gain here it
  // has no retrieval-side case left to make.
  "+graph-2hop-backfill": {
    fts: true,
    lexical: true,
    dense: true,
    entity: false,
    centrality: "score",
    graphHops: 2,
    relations: ANCHOR_ONLY_RELATIONS,
    graphMode: "backfill",
  },
};

export type ArmRunOptions = {
  k: number;
  /** Candidate pool per retriever, mirroring `searchMemory`'s `max(limit*3, 30)`. */
  pool: number;
  /** GATE view: keep only human-confirmed notes, mirroring `applyGate` with
   *  `governedOnly` and no trust floor (the hero's strictest read). */
  gated: boolean;
  /** How many flat results seed the traversal expansion. */
  seeds: number;
  /**
   * Force the dense tier OFF in every arm. This is not a hypothetical: MUON is
   * local-first and `semanticCandidates` returns [] whenever no embedder is
   * configured, which is the DEFAULT install. It is also the honest hedge against
   * this harness's biggest bias — the stand-in concept vectors are a cleaner
   * semantic space than a real embedding model, so the dense arm here is closer
   * to an oracle than to Ollama, which SUPPRESSES the headroom left for
   * traversal. Turning dense off removes that bias entirely and asks the
   * decision-relevant question: in the shipped default configuration, does
   * traversal earn its keep?
   */
  denseOff?: boolean;
};

/**
 * The WIDE profile mirrors the shipped `searchMemory` defaults for a limit-10
 * read (`pool = max(limit*3, 30)`).
 *
 * NOTE THE ARTEFACT, it matters for how the reachability audit reads: a pool of
 * 30 over a 43-note corpus means a flat retriever may legitimately return ~70% of
 * the brain, which flatters flat recall and starves traversal of headroom. That
 * ratio is NOT what a real brain looks like, so every number is also reported at
 * the TIGHT profile below, where the pool is a quarter of the corpus and flat
 * retrieval has to actually choose. If traversal adds nothing at BOTH, the
 * finding is not a pool-size artefact.
 */
export const DEFAULT_ARM_RUN_OPTIONS: ArmRunOptions = {
  k: 10,
  pool: 30,
  gated: false,
  seeds: 3,
};

/** The stress profile: a pool a quarter the size of the corpus and k=5. */
export const TIGHT_ARM_RUN_OPTIONS: ArmRunOptions = {
  k: 5,
  pool: 10,
  gated: false,
  seeds: 3,
};

/** The DEFAULT INSTALL profile: local-first with no embedder configured, so the
 *  dense tier is absent and retrieval is FTS + lexical + whatever the graph adds.
 *  This is the configuration most MUON users actually run. */
export const DENSE_OFF_ARM_RUN_OPTIONS: ArmRunOptions = {
  k: 10,
  pool: 30,
  gated: false,
  seeds: 3,
  denseOff: true,
};

export type QueryRun = {
  queryId: string;
  capability: EvalCapability;
  rankedIds: string[];
  /** Candidate pool size handed to the ranker. */
  candidates: number;
  storeQueries: number;
  /** Notes only the traversal expansion contributed, with the relation that found them. */
  graphOnly: ExpansionHit[];
  /** Notes ONLY the entity retriever put into the candidate pool — the R2
   *  equivalent of `graphOnly`, and the number that decides whether the entity
   *  signal retrieves anything the flat retrievers could not already see. */
  entityOnly: string[];
  /** Entities extracted from THIS query (0 ⇒ the arm is inert for it). */
  queryEntities: number;
  /** The traversal hit its node cap (the shipped BFS would report the same). */
  truncated: boolean;
  recall: number;
  precision: number;
  ndcg: number;
  mrr: number;
};

type Prepared = {
  nowMs: number;
  /** Active notes only — the current-set view every non-as-of read sees. */
  active: MemoryNoteRecord[];
  byId: Map<string, MemoryNoteRecord>;
  vectors: Map<string, number[]>;
  centrality: Map<string, number>;
  /** R2: note id → the entities its TEXT mentions, the harness's mirror of the
   *  `MENTIONS` edges the store writes at ingest. */
  entities: Map<string, MemoryEntity[]>;
  index: TraversalIndex;
};

/** Shared, arm-independent preparation, so the arms differ ONLY in their signals. */
export function prepareGraphValueEval(set: GraphValueEvalSet): Prepared {
  const nowMs = Date.parse(set.now);
  const records = set.notes.map((note) => toNoteRecord(note, nowMs));
  const byId = new Map(records.map((record) => [record.id, record]));
  const vectors = new Map(
    set.notes.map((note) => [note.id, conceptVector(set.basis, note.concepts)])
  );
  const active = records.filter((record) => record.status === "active");
  // Mirrors `centralityByNote` → `memoryAnalytics` → `analyzeMemoryGraph`:
  // coordinates only (id + modules), never text.
  const analytics = analyzeMemoryGraph(
    active.map((record) => ({ id: record.id, modules: record.modules }))
  );
  const centrality = new Map(
    analytics.noteScores.map((row) => [row.noteId, row.score])
  );
  // R2: entities come from the note's TEXT ONLY. The structured `modules` /
  // `symbols` anchors are DELIBERATELY excluded — indexing them here would make
  // the entity retriever a partial re-run of `searchMemoryLexical` (which already
  // matches modules in its haystack) and the measured "gain" would be double
  // counting. Text-only is also what the store does, so the mirror is exact.
  const entities = new Map(
    set.notes.map((note) => [note.id, extractEntities(note.text)])
  );
  return {
    nowMs,
    active,
    byId,
    vectors,
    centrality,
    entities,
    index: buildTraversalIndex(set),
  };
}

/**
 * Run one query through one arm. Mirrors `searchMemory`'s pipeline: gather each
 * enabled retriever's ranked list, fuse with RRF, normalize to a 0..1 relevance,
 * rerank with the SHIPPED calibrated ranker, then apply the gate. Store
 * round-trips are counted the way the store would issue them (one per candidate
 * query, one per hydrated id, plus the traversal's BFS fan-out).
 */
export function runQueryArm(
  set: GraphValueEvalSet,
  prepared: Prepared,
  query: EvalQuery,
  armConfig: ArmConfig,
  options: ArmRunOptions
): QueryRun {
  const { active, byId, vectors, centrality, entities, index } = prepared;
  const config = options.denseOff ? { ...armConfig, dense: false } : armConfig;
  const lists: string[][] = [];
  let storeQueries = 0;

  const ftsIds = config.fts ? bm25Rank(query.text, active, options.pool) : [];
  if (config.fts) {
    storeQueries += 1;
    if (ftsIds.length > 0) {
      lists.push(ftsIds);
    }
  }
  const lexIds = config.lexical ? lexicalRank(query.text, active, options.pool) : [];
  if (config.lexical) {
    storeQueries += 1;
    if (lexIds.length > 0) {
      lists.push(lexIds);
    }
  }
  if (config.dense) {
    // One scan query for the embedding column (the embed call itself is an
    // out-of-store cost and is reported separately by the latency probe).
    storeQueries += 1;
    const denseIds = denseRank(
      conceptVector(set.basis, query.concepts),
      vectors,
      active,
      options.pool
    );
    if (denseIds.length > 0) {
      lists.push(denseIds);
    }
  }
  // R2: ONE extra store round-trip — a single indexed join over the `MENTIONS`
  // edges for up to 8 query entities. Compare that with traversal's 30x.
  const flatOnly = new Set(lists.flat());
  let entityOnly: string[] = [];
  let queryEntities = 0;
  if (config.entity) {
    storeQueries += 1;
    queryEntities = extractQueryEntities(query.text).length;
    const entityIds = entityRank(query.text, active, entities, options.pool);
    entityOnly = entityIds.filter((id) => !flatOnly.has(id));
    if (entityIds.length > 0) {
      lists.push(entityIds);
    }
  }
  if (config.centrality !== "off") {
    storeQueries += 1; // the memoryAnalytics coordinate scan
  }

  // Traversal is seeded from the FLAT result, the only honest entry point: a
  // graph has no query surface of its own.
  let graphOnly: ExpansionHit[] = [];
  let truncated = false;
  let backfillIds: string[] = [];
  if (config.graphHops > 0) {
    const flatFused = reciprocalRankFusion(lists);
    const seedIds = [...flatFused.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, options.seeds)
      .map(([id]) => id);
    const expansion = graphExpand(
      index,
      seedIds,
      config.graphHops,
      config.relations
    );
    storeQueries += expansion.storeQueries;
    truncated = expansion.truncated;
    const alreadyKnown = new Set(lists.flat());
    const expandedIds: string[] = [];
    for (const hit of expansion.hits) {
      const note = byId.get(hit.noteId);
      // A retired (superseded) note is not in the current active set; the store
      // would surface it as a traversal COORDINATE but never as a search result.
      if (!note || note.status !== "active" || expandedIds.includes(hit.noteId)) {
        continue;
      }
      expandedIds.push(hit.noteId);
      if (!alreadyKnown.has(hit.noteId)) {
        graphOnly.push(hit);
        storeQueries += 1; // hydration of an id the flat pool never saw
      }
    }
    if (expandedIds.length > 0) {
      if (config.graphMode === "backfill") {
        // Backfill: kept OUT of the fusion entirely, so it cannot move a flat
        // result; appended below in BFS (hop) order.
        backfillIds = expandedIds.filter((id) => !alreadyKnown.has(id));
      } else {
        lists.push(expandedIds);
      }
    }
  }

  const fused = reciprocalRankFusion(lists);
  const maxFused = Math.max(...fused.values(), 1e-9);
  const inputs: RankInput[] = [];
  for (const [id, score] of fused) {
    const note = byId.get(id);
    if (note && note.status === "active") {
      inputs.push({
        note,
        relevance: score / maxFused,
        ...(config.centrality !== "off"
          ? { centrality: centrality.get(id) }
          : {}),
      });
    }
  }
  // KG-12: the prior is OFF in the shipped weights, so an arm that wants it has
  // to ask for it explicitly. `off` therefore ranks through exactly the weights
  // production ships.
  const weights: CalibratedWeights = {
    ...DEFAULT_CALIBRATED_WEIGHTS,
    ...(config.centrality === "score"
      ? { centralityPrior: CENTRALITY_PRIOR_WEIGHT }
      : {}),
    ...(config.centrality === "tiebreak" ? { centralityTieBreak: true } : {}),
  };
  const ranked = rerankCalibrated(inputs, weights, prepared.nowMs);
  const gatedRanked = options.gated
    ? ranked.filter((note) => note.confirmed)
    : ranked;
  const rankedIds = gatedRanked.map((note) => note.id);
  for (const id of backfillIds) {
    const note = byId.get(id);
    if (note && note.status === "active" && !(options.gated && !note.confirmed)) {
      rankedIds.push(id);
    }
  }
  // A gated run cannot be credited for gold it is designed to withhold: the
  // labels are restricted to the notes the gate admits, so the gated numbers
  // measure ranking inside the gate rather than punishing the gate for existing.
  const labels = options.gated
    ? Object.fromEntries(
        Object.entries(query.labels).filter(([id]) => byId.get(id)?.confirmed)
      )
    : query.labels;
  const rankedLabels = rankedIds.map((id) => labels[id] ?? 0);
  graphOnly = graphOnly.filter((hit) => byId.get(hit.noteId)?.status === "active");

  return {
    queryId: query.id,
    capability: query.capability,
    rankedIds,
    candidates: inputs.length,
    storeQueries,
    graphOnly,
    entityOnly: entityOnly.filter(
      (id) => byId.get(id)?.status === "active"
    ),
    queryEntities,
    truncated,
    recall: recallAtK(rankedIds, labels, options.k),
    precision: precisionAtK(rankedLabels, options.k),
    ndcg: ndcgFull(rankedIds, labels, options.k),
    mrr: reciprocalRank(rankedLabels),
  };
}

// ── reachability audit (published BEFORE any arm, so the corpus is auditable) ─

export type ReachabilityAudit = {
  goldTotal: number;
  /** Gold notes the BM25 (text-only) pool can see. */
  byFts: number;
  /** Gold notes the lexical (text+kind+topics+MODULES) pool can see. */
  byLexical: number;
  /** Gold notes the dense pool can see. */
  byDense: number;
  /** Gold notes the R2 entity pool can see. */
  byEntity: number;
  /** Gold notes ANY flat retriever can see — the ceiling traversal must beat. */
  byAnyFlat: number;
  /** Gold notes NO other flat retriever sees but the ENTITY pool reaches. This is
   *  the entity signal's entire recall headroom, the direct analogue of
   *  `graphOnlyHeadroom`; if it is 0, no fusion weighting can make entity add
   *  recall (it could still reorder). */
  entityOnlyHeadroom: number;
  /** Gold notes NO flat retriever sees but a 2-hop expansion reaches. This is
   *  the ONLY headroom traversal has; if it is 0, no traversal arm can add recall. */
  graphOnlyHeadroom: number;
  /** Gold notes no retriever, flat or graph, can reach at all. */
  unreachable: number;
};

export function auditReachability(
  set: GraphValueEvalSet,
  prepared: Prepared,
  options: ArmRunOptions = DEFAULT_ARM_RUN_OPTIONS
): ReachabilityAudit {
  let goldTotal = 0;
  let byFts = 0;
  let byLexical = 0;
  let byDense = 0;
  let byEntity = 0;
  let byAnyFlat = 0;
  let entityOnlyHeadroom = 0;
  let graphOnlyHeadroom = 0;
  let unreachable = 0;

  for (const query of set.queries) {
    const gold = Object.entries(query.labels)
      .filter(([, label]) => label >= 2)
      .map(([id]) => id)
      .filter((id) => prepared.byId.get(id)?.status === "active");
    const fts = new Set(bm25Rank(query.text, prepared.active, options.pool));
    const lex = new Set(lexicalRank(query.text, prepared.active, options.pool));
    const dense = new Set(
      options.denseOff
        ? []
        : denseRank(
            conceptVector(set.basis, query.concepts),
            prepared.vectors,
            prepared.active,
            options.pool
          )
    );
    const entity = new Set(
      entityRank(query.text, prepared.active, prepared.entities, options.pool)
    );
    const flatFused = reciprocalRankFusion([[...fts], [...lex], [...dense]]);
    const seedIds = [...flatFused.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, options.seeds)
      .map(([id]) => id);
    const expanded = new Set(
      graphExpand(prepared.index, seedIds, 2).hits.map((hit) => hit.noteId)
    );

    for (const id of gold) {
      goldTotal += 1;
      const inFts = fts.has(id);
      const inLex = lex.has(id);
      const inDense = dense.has(id);
      const inEntity = entity.has(id);
      if (inFts) byFts += 1;
      if (inLex) byLexical += 1;
      if (inDense) byDense += 1;
      if (inEntity) byEntity += 1;
      // `byAnyFlat` deliberately keeps its ORIGINAL meaning — FTS ∪ lexical ∪
      // dense — so the traversal headroom number stays exactly comparable to the
      // committed KG-12 verdict. Entity is scored as its own increment on top.
      if (inFts || inLex || inDense) {
        byAnyFlat += 1;
      } else if (inEntity) {
        entityOnlyHeadroom += 1;
      } else if (expanded.has(id)) {
        graphOnlyHeadroom += 1;
      } else {
        unreachable += 1;
      }
    }
  }
  return {
    goldTotal,
    byFts,
    byLexical,
    byDense,
    byEntity,
    byAnyFlat,
    entityOnlyHeadroom,
    graphOnlyHeadroom,
    unreachable,
  };
}

// ── provenance capability matrix (b/c: judged structurally, NOT by recall) ────

/**
 * Provenance is a GOVERNANCE surface, so a recall benchmark is the wrong
 * instrument and we do not fake one. What CAN be stated as a fact is a type-level
 * argument: a ranked-list retriever returns `MemoryNoteRecord[]`, whose fields are
 * scalars on ONE note. Any question whose answer is an EDGE (who confirmed it,
 * what it replaced, what disagrees with it, which approval gated the task it came
 * from) is not expressible in that return type at ANY ranking quality. The
 * `answerableByFlatSearch` flag below is therefore a structural claim about the
 * return type, not a measured score; `corpusInstances` is the one honest NUMBER —
 * how many notes in this corpus actually carry that edge.
 */
export type ProvenanceQuestion = {
  id: string;
  question: string;
  /** The relation whose presence answers it. */
  relation: MemoryGraphRelation | "none";
  answerableByFlatSearch: boolean;
  why: string;
};

export const PROVENANCE_QUESTIONS: ProvenanceQuestion[] = [
  {
    id: "who-confirmed",
    question: "Which human confirmed this note, and is that principal trusted?",
    relation: "CONFIRMED_BY",
    answerableByFlatSearch: false,
    why: "The note record carries a boolean `confirmed`, not the confirming principal. The identity lives on an edge.",
  },
  {
    id: "what-did-it-replace",
    question: "What did this note replace, and what did the brain believe before?",
    relation: "SUPERSEDES",
    answerableByFlatSearch: false,
    why: "The predecessor is status 'rejected', so it is outside the current active set every flat retriever queries; only the edge (or an as-of read) reaches it.",
  },
  {
    id: "what-disagrees",
    question: "What active note contradicts this one?",
    relation: "CONTRADICTS",
    answerableByFlatSearch: false,
    why: "`conflictsWith` names one id; enumerating the contradiction set and its direction requires the edge. Flat search would have to rank the peer independently and hope.",
  },
  {
    id: "which-approval",
    question: "Which human approval gated the task this note came from?",
    relation: "GATED_BY",
    answerableByFlatSearch: false,
    why: "Two hops away (note→task→approval). No field on the note encodes it.",
  },
  {
    id: "which-anchor",
    question: "Which module or symbol is this note about?",
    relation: "ANCHORED_TO",
    answerableByFlatSearch: true,
    why: "`modules`/`symbols` are scalars ON the note; the edge is redundant for this question.",
  },
];

export type ProvenanceCoverage = ProvenanceQuestion & {
  /** How many corpus notes actually carry the relation (0 ⇒ the capability is
   *  unexercised by real data, which is itself the finding). */
  corpusInstances: number;
};

export function measureProvenanceCoverage(
  set: GraphValueEvalSet
): ProvenanceCoverage[] {
  const counts: Record<string, number> = {
    CONFIRMED_BY: set.notes.filter((note) => note.confirmed).length,
    SUPERSEDES: set.notes.filter((note) => note.supersededBy).length,
    CONTRADICTS: set.notes.filter((note) => note.contradicts).length,
    GATED_BY: set.notes.filter((note) => {
      const task = set.tasks.find((candidate) => candidate.id === note.taskId);
      return Boolean(task?.approvalId);
    }).length,
    ANCHORED_TO: set.notes.filter((note) => note.modules.length > 0).length,
  };
  return PROVENANCE_QUESTIONS.map((question) => ({
    ...question,
    corpusInstances: counts[question.relation] ?? 0,
  }));
}

// ── code surface (the other half of "does it earn its keep") ─────────────────

/**
 * Lines of implementation carried by each signal, COUNTED from the shipped
 * sources at the commit this eval landed on, not estimated. Reproduce by
 * summing these spans:
 *   shared traversal core  muon-graph.ts DEFAULT_MEMORY_GRAPH_RELATIONS (14) +
 *     traversal ref/step/result types (13) + id/coordinate helpers (36) +
 *     `memoryTraversalNode` (152) + `memoryTraversalNeighbors` (213) +
 *     `traverseMemoryGraph` (112) + types.ts traversal block (82) = 622
 *   memoryNeighbors        16   (the public 3-hop wrapper)
 *   memoryExplain          160  (BFS + shortest-path + contradiction channel)
 *   centrality PRIOR       ~34  (the prior itself + `centralityByNote` + the
 *                          searchMemory wiring + the RankInput/breakdown fields)
 *   dense tier             ~74  (`embedText` 37 + `semanticCandidates` 37)
 *
 * ATTRIBUTION HONESTY, this matters for the verdict: `memory-analytics.ts` (313
 * lines) is NOT counted against the centrality prior. `memoryAnalytics` is its
 * own product surface (hot modules, communities, exposed over the API, the CLI
 * and MCP), so dropping the ranking prior would delete ~34 lines of wiring and
 * leave the analytics module standing. Counting all 313 against the prior would
 * have inflated the case for cutting it.
 *
 * `downstreamSourceFiles` / `downstreamTestFiles` count the OTHER files that
 * reference the signal and would need to change if it were removed, from a
 * repo-wide grep (route, client, MCP handler, CLI, desktop main/preload/renderer/
 * ipc, and their tests).
 */
export type CodeSurface = {
  signal: string;
  graphPackageLines: number;
  downstreamSourceFiles: number;
  downstreamTestFiles: number;
  note?: string;
};

export const CODE_SURFACE: CodeSurface[] = [
  {
    signal: "traversal BFS core (shared)",
    graphPackageLines: 622,
    downstreamSourceFiles: 0,
    downstreamTestFiles: 2,
    note: "shared by memoryNeighbors AND memoryExplain; only removable if BOTH go",
  },
  {
    signal: "memoryNeighbors (N-hop recall)",
    graphPackageLines: 16,
    downstreamSourceFiles: 8,
    downstreamTestFiles: 8,
    note: "route + client + MCP + CLI + desktop main/preload/renderer/ipc",
  },
  {
    signal: "memoryExplain (provenance path)",
    graphPackageLines: 160,
    downstreamSourceFiles: 8,
    downstreamTestFiles: 8,
    note: "same downstream surface as memoryNeighbors",
  },
  {
    signal: "centrality ranking prior",
    graphPackageLines: 34,
    downstreamSourceFiles: 0,
    downstreamTestFiles: 1,
    note: "memory-analytics.ts (313 lines) survives a prior cut — separate product surface",
  },
  {
    signal: "dense/embeddings tier",
    graphPackageLines: 74,
    downstreamSourceFiles: 4,
    downstreamTestFiles: 2,
  },
];

// ── the runnable eval ───────────────────────────────────────────────────────

export type ArmReport = {
  arm: ArmId;
  recall: number;
  precision: number;
  ndcg: number;
  mrr: number;
  /** Mean store round-trips per query. */
  storeQueries: number;
  /** Mean candidate-pool size handed to the ranker. */
  candidates: number;
  /** Gold notes (label ≥ 2) that ONLY the traversal expansion contributed. */
  graphOnlyGoldHits: number;
  /** Non-gold notes the traversal expansion injected into the pool (noise). */
  graphOnlyNoise: number;
  /** 1-based final ranks of the gold notes ONLY traversal reached. The decisive
   *  number for (a): a graph-only gold note that lands at rank 30 has not been
   *  retrieved in any sense a user experiences, however true it is that the graph
   *  "found" it. */
  graphOnlyGoldRanks: number[];
  /** Gold notes (label ≥ 2) that ONLY the entity retriever put into the pool. */
  entityOnlyGoldHits: number;
  /** Non-gold notes the entity retriever injected into the pool (noise). */
  entityOnlyNoise: number;
  /** 1-based final ranks of the gold notes only entity reached. Same standard the
   *  traversal verdict was held to: reaching a note is worthless if it lands
   *  below k. */
  entityOnlyGoldRanks: number[];
  /** Queries that produced at least one entity (the arm is inert for the rest). */
  queriesWithEntities: number;
  /** Queries whose traversal hit the 100-node cap (the shipped `truncated` flag). */
  truncatedQueries: number;
  perQuery: QueryRun[];
};

/**
 * Did the centrality prior DO anything? nDCG deltas alone cannot distinguish
 * "inert" from "helps as often as it hurts", so the prior is also measured
 * directly: how many queries it reorders at all, and how often it changes the
 * top result. A prior that never fires is dead weight; one that fires and loses
 * is worse.
 */
export type CentralityImpact = {
  queries: number;
  reordered: number;
  top1Changed: number;
  ndcgDelta: number;
  mrrDelta: number;
};

/**
 * Did the R2 entity signal EARN its round-trip? Held to the identical standard
 * the traversal verdict was held to, and for the same reason: "the signal found
 * something" is not a result, "the caller's top-k changed for the better" is.
 *  - `queriesWithEntities` — how often the arm fires at all. A signal that never
 *    fires is dead weight regardless of its deltas.
 *  - `entityOnlyGoldHits` / `Noise` — what it uniquely ADDED to the pool, split
 *    by whether the label says it was worth adding.
 *  - the three deltas — measured against `fts+lex+dense`, which is the identical
 *    pipeline minus the entity list.
 */
export type EntityImpact = {
  queries: number;
  queriesWithEntities: number;
  reordered: number;
  entityOnlyGoldHits: number;
  entityOnlyNoise: number;
  /** Where the uniquely-reached gold actually landed (1-based, ascending). */
  entityOnlyGoldRanks: number[];
  recallDelta: number;
  ndcgDelta: number;
  mrrDelta: number;
  precisionDelta: number;
};

export type GraphValueEvalReport = {
  honesty: string;
  corpus: {
    notes: number;
    activeNotes: number;
    confirmed: number;
    modules: number;
    supersedeChains: number;
    contradictions: number;
    chats: number;
    queries: number;
    byCapability: Record<string, number>;
  };
  options: ArmRunOptions;
  reachability: ReachabilityAudit;
  arms: ArmReport[];
  /** Same ablation restricted to the confirmed-only gate view (the hero's read). */
  gatedArms: ArmReport[];
  centrality: CentralityImpact;
  /** The steelman variant: the prior demoted to a last-resort tie-break. */
  centralityTieBreak: CentralityImpact;
  /** R2. */
  entity: EntityImpact;
  byCapability: Record<EvalCapability, ArmReport[]>;
  /** Which relation actually found each graph-only candidate, and whether it was gold. */
  traversalByRelation: Array<{
    relation: MemoryGraphRelation;
    candidates: number;
    goldHits: number;
  }>;
  provenance: ProvenanceCoverage[];
  codeSurface: CodeSurface[];
};

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

function summarizeArm(
  arm: ArmId,
  runs: QueryRun[],
  labelsById: Map<string, Record<string, number>>
): ArmReport {
  let graphOnlyGoldHits = 0;
  let graphOnlyNoise = 0;
  const graphOnlyGoldRanks: number[] = [];
  let entityOnlyGoldHits = 0;
  let entityOnlyNoise = 0;
  const entityOnlyGoldRanks: number[] = [];
  for (const run of runs) {
    const labels = labelsById.get(run.queryId) ?? {};
    for (const hit of run.graphOnly) {
      if ((labels[hit.noteId] ?? 0) >= 2) {
        graphOnlyGoldHits += 1;
        const rank = run.rankedIds.indexOf(hit.noteId);
        if (rank >= 0) {
          graphOnlyGoldRanks.push(rank + 1);
        }
      } else {
        graphOnlyNoise += 1;
      }
    }
    // Same accounting for entity, so the new signal is judged by the bar that
    // cut traversal rather than by a friendlier one.
    for (const noteId of run.entityOnly) {
      if ((labels[noteId] ?? 0) >= 2) {
        entityOnlyGoldHits += 1;
        const rank = run.rankedIds.indexOf(noteId);
        if (rank >= 0) {
          entityOnlyGoldRanks.push(rank + 1);
        }
      } else {
        entityOnlyNoise += 1;
      }
    }
  }
  graphOnlyGoldRanks.sort((a, b) => a - b);
  entityOnlyGoldRanks.sort((a, b) => a - b);
  return {
    arm,
    recall: mean(runs.map((run) => run.recall)),
    precision: mean(runs.map((run) => run.precision)),
    ndcg: mean(runs.map((run) => run.ndcg)),
    mrr: mean(runs.map((run) => run.mrr)),
    storeQueries: mean(runs.map((run) => run.storeQueries)),
    candidates: mean(runs.map((run) => run.candidates)),
    graphOnlyGoldHits,
    graphOnlyNoise,
    graphOnlyGoldRanks,
    entityOnlyGoldHits,
    entityOnlyNoise,
    entityOnlyGoldRanks,
    queriesWithEntities: runs.filter((run) => run.queryEntities > 0).length,
    truncatedQueries: runs.filter((run) => run.truncated).length,
    perQuery: runs,
  };
}

function centralityImpact(
  withoutPrior: ArmReport,
  withPrior: ArmReport
): CentralityImpact {
  let reordered = 0;
  let top1Changed = 0;
  for (const [index, run] of withPrior.perQuery.entries()) {
    const base = withoutPrior.perQuery[index]!;
    if (run.rankedIds.join("|") !== base.rankedIds.join("|")) {
      reordered += 1;
    }
    if (run.rankedIds[0] !== base.rankedIds[0]) {
      top1Changed += 1;
    }
  }
  return {
    queries: withPrior.perQuery.length,
    reordered,
    top1Changed,
    ndcgDelta: withPrior.ndcg - withoutPrior.ndcg,
    mrrDelta: withPrior.mrr - withoutPrior.mrr,
  };
}

function entityImpact(
  withoutEntity: ArmReport,
  withEntity: ArmReport
): EntityImpact {
  let reordered = 0;
  for (const [index, run] of withEntity.perQuery.entries()) {
    const base = withoutEntity.perQuery[index]!;
    if (run.rankedIds.join("|") !== base.rankedIds.join("|")) {
      reordered += 1;
    }
  }
  return {
    queries: withEntity.perQuery.length,
    queriesWithEntities: withEntity.queriesWithEntities,
    reordered,
    entityOnlyGoldHits: withEntity.entityOnlyGoldHits,
    entityOnlyNoise: withEntity.entityOnlyNoise,
    entityOnlyGoldRanks: withEntity.entityOnlyGoldRanks,
    recallDelta: withEntity.recall - withoutEntity.recall,
    ndcgDelta: withEntity.ndcg - withoutEntity.ndcg,
    mrrDelta: withEntity.mrr - withoutEntity.mrr,
    precisionDelta: withEntity.precision - withoutEntity.precision,
  };
}

export function runGraphValueEval(
  set: GraphValueEvalSet,
  options: ArmRunOptions = DEFAULT_ARM_RUN_OPTIONS
): GraphValueEvalReport {
  const prepared = prepareGraphValueEval(set);
  const labelsById = new Map(set.queries.map((query) => [query.id, query.labels]));

  const runArms = (gated: boolean): ArmReport[] =>
    ARM_IDS.map((arm) =>
      summarizeArm(
        arm,
        set.queries.map((query) =>
          runQueryArm(set, prepared, query, ARM_CONFIGS[arm], { ...options, gated })
        ),
        labelsById
      )
    );

  const arms = runArms(false);
  const gatedArms = runArms(true);

  const capabilities = [
    ...new Set(set.queries.map((query) => query.capability)),
  ] as EvalCapability[];
  const byCapability = Object.fromEntries(
    capabilities.map((capability) => [
      capability,
      ARM_IDS.map((arm) =>
        summarizeArm(
          arm,
          set.queries
            .filter((query) => query.capability === capability)
            .map((query) =>
              runQueryArm(set, prepared, query, ARM_CONFIGS[arm], options)
            ),
          labelsById
        )
      ),
    ])
  ) as Record<EvalCapability, ArmReport[]>;

  // Attribution: which relation actually did the work in the widest arm.
  const relationCounts = new Map<
    MemoryGraphRelation,
    { candidates: number; goldHits: number }
  >();
  const widest = arms.find((report) => report.arm === "+graph-2hop")!;
  for (const run of widest.perQuery) {
    const labels = labelsById.get(run.queryId) ?? {};
    for (const hit of run.graphOnly) {
      const row = relationCounts.get(hit.relation) ?? { candidates: 0, goldHits: 0 };
      row.candidates += 1;
      if ((labels[hit.noteId] ?? 0) >= 2) {
        row.goldHits += 1;
      }
      relationCounts.set(hit.relation, row);
    }
  }

  const modules = new Set(set.notes.flatMap((note) => note.modules));
  const byCapabilityCount: Record<string, number> = {};
  for (const query of set.queries) {
    byCapabilityCount[query.capability] =
      (byCapabilityCount[query.capability] ?? 0) + 1;
  }

  return {
    honesty: GRAPH_VALUE_EVAL_HONESTY,
    corpus: {
      notes: set.notes.length,
      activeNotes: prepared.active.length,
      confirmed: set.notes.filter((note) => note.confirmed).length,
      modules: modules.size,
      supersedeChains: set.notes.filter((note) => note.supersededBy).length,
      contradictions: set.notes.filter((note) => note.contradicts).length,
      chats: new Set(set.notes.map((note) => note.chatId)).size,
      queries: set.queries.length,
      byCapability: byCapabilityCount,
    },
    options,
    reachability: auditReachability(set, prepared, options),
    arms,
    gatedArms,
    centrality: centralityImpact(
      arms.find((report) => report.arm === "fts+lex+dense")!,
      arms.find((report) => report.arm === "+centrality")!
    ),
    centralityTieBreak: centralityImpact(
      arms.find((report) => report.arm === "fts+lex+dense")!,
      arms.find((report) => report.arm === "+centrality-tiebreak")!
    ),
    entity: entityImpact(
      arms.find((report) => report.arm === "fts+lex+dense")!,
      arms.find((report) => report.arm === "+entity")!
    ),
    byCapability,
    traversalByRelation: [...relationCounts.entries()]
      .map(([relation, row]) => ({ relation, ...row }))
      .sort((a, b) => b.candidates - a.candidates || a.relation.localeCompare(b.relation)),
    provenance: measureProvenanceCoverage(set),
    codeSurface: CODE_SURFACE,
  };
}

const pct = (value: number): string => value.toFixed(4);

function armTable(rows: ArmReport[], k: number): string[] {
  const header = `  ${"arm".padEnd(22)} ${`recall@${k}`.padEnd(9)} ${`P@${k}`.padEnd(8)} ${`nDCG@${k}`.padEnd(9)} ${"MRR".padEnd(8)} ${"queries".padEnd(8)} ${"cands".padEnd(7)} ${"ent-only(g/n)".padEnd(14)} graph-only(g/n)`;
  const body = rows.map(
    (row) =>
      `  ${row.arm.padEnd(22)} ${pct(row.recall).padEnd(9)} ${pct(row.precision).padEnd(8)} ${pct(
        row.ndcg
      ).padEnd(9)} ${pct(row.mrr).padEnd(8)} ${row.storeQueries.toFixed(1).padEnd(8)} ${row.candidates
        .toFixed(1)
        .padEnd(7)} ${`${row.entityOnlyGoldHits}/${row.entityOnlyNoise}`.padEnd(
        14
      )} ${row.graphOnlyGoldHits}/${row.graphOnlyNoise}`
  );
  return [header, ...body];
}

export function formatGraphValueEvalReport(
  report: GraphValueEvalReport,
  options?: { header?: string; corpus?: boolean }
): string {
  const k = report.options.k;
  const reach = report.reachability;
  const lines: string[] = [
    options?.header ??
      "[KG-12 graph-value ablation: does graph structure beat flat hybrid search?]",
  ];
  if (options?.corpus !== false) {
    lines.push(
      report.honesty,
      "",
      `  corpus: ${report.corpus.notes} notes (${report.corpus.activeNotes} active, ${report.corpus.confirmed} confirmed) over ${report.corpus.modules} real module anchors,`,
      `          ${report.corpus.supersedeChains} superseded, ${report.corpus.contradictions} contradictions, ${report.corpus.chats} chats, ${report.corpus.queries} labeled queries`,
      `          capability mix: ${Object.entries(report.corpus.byCapability)
        .map(([capability, count]) => `${capability}=${count}`)
        .join(" ")}`
    );
  }
  lines.push(
    "",
    `  PROFILE: k=${k}, candidate pool=${report.options.pool} per retriever, ${report.options.seeds} traversal seeds`,
    "",
    "  REACHABILITY AUDIT (before any arm runs — the ceiling each signal can reach):"
  );
  lines.push(
    `    gold labels (≥2, active): ${reach.goldTotal}`,
    `    seen by BM25/text-only pool: ${reach.byFts}   by lexical(+modules) pool: ${reach.byLexical}   by dense pool: ${reach.byDense}   by entity pool: ${reach.byEntity}`,
    `    seen by ANY flat retriever (fts∪lex∪dense): ${reach.byAnyFlat}/${reach.goldTotal}`,
    `    reachable ONLY via ENTITY (entity's entire headroom): ${reach.entityOnlyHeadroom}`,
    `    reachable ONLY via 2-hop traversal (traversal's entire headroom): ${reach.graphOnlyHeadroom}`,
    `    reachable by nothing: ${reach.unreachable}`,
    "",
    "  ABLATION (open view — every active note visible):",
    ...armTable(report.arms, k),
    "",
    "  ABLATION (confirmed-only GATE view — the hero's read):",
    ...armTable(report.gatedArms, k),
    "",
    "  TRAVERSAL ATTRIBUTION (what the default 2-hop expansion actually pulled in):"
  );
  if (report.traversalByRelation.length === 0) {
    lines.push("    (nothing — every expanded candidate was already in the flat pool)");
  } else {
    for (const row of report.traversalByRelation) {
      lines.push(
        `    ${row.relation.padEnd(14)} candidates=${String(row.candidates).padEnd(4)} of which gold=${row.goldHits}`
      );
    }
  }
  const ent = report.entity;
  const signed = (value: number): string =>
    `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;
  lines.push(
    "",
    "  R2 ENTITY SIGNAL (vs fts+lex+dense — the identical pipeline minus the entity list):",
    `    fired on ${ent.queriesWithEntities}/${ent.queries} queries, reordered ${ent.reordered};` +
      ` uniquely added gold=${ent.entityOnlyGoldHits} noise=${ent.entityOnlyNoise}`,
    `    recall delta ${signed(ent.recallDelta)}   nDCG delta ${signed(
      ent.ndcgDelta
    )}   MRR delta ${signed(ent.mrrDelta)}   P@${k} delta ${signed(
      ent.precisionDelta
    )}`,
    ent.entityOnlyGoldRanks.length === 0
      ? "    no gold was reachable by entity alone"
      : `    entity-only gold landed at final ranks ${ent.entityOnlyGoldRanks.join(
          ", "
        )} (k=${k})`
  );
  const impact = report.centrality;
  const tie = report.centralityTieBreak;
  lines.push(
    "",
    "  CENTRALITY PRIOR, did it fire at all?",
    `    as a SCORE term: reordered ${impact.reordered}/${impact.queries} queries, changed the top result on ${impact.top1Changed};` +
      ` nDCG delta ${signed(impact.ndcgDelta)},` +
      ` MRR delta ${signed(impact.mrrDelta)}`,
    `    as a TIE-BREAK:  reordered ${tie.reordered}/${tie.queries} queries, changed the top result on ${tie.top1Changed};` +
      ` nDCG delta ${signed(tie.ndcgDelta)},` +
      ` MRR delta ${signed(tie.mrrDelta)}`
  );
  const truncatedArm = report.arms.find((row) => row.truncatedQueries > 0);
  if (truncatedArm) {
    lines.push(
      `    traversal hit its 100-node cap on ${truncatedArm.truncatedQueries}/${impact.queries} queries (${truncatedArm.arm})`
    );
  }
  const backfill = report.arms.find(
    (row) => row.arm === "+graph-2hop-backfill"
  );
  if (backfill) {
    lines.push(
      "",
      "  WHERE DOES GRAPH-ONLY GOLD LAND? (backfill arm — traversal cannot displace anything):",
      backfill.graphOnlyGoldRanks.length === 0
        ? "    no gold was reachable by traversal alone"
        : `    final ranks ${backfill.graphOnlyGoldRanks.join(", ")} — a note at rank ${
            backfill.graphOnlyGoldRanks[0]
          }+ is not retrieved in any sense a caller at k=${k} experiences`
    );
  }
  lines.push("", "  PER-CAPABILITY nDCG@" + k + " (reweight the mix yourself):");
  for (const [capability, rows] of Object.entries(report.byCapability)) {
    lines.push(
      `    ${capability.padEnd(14)} ${rows
        .map((row) => `${row.arm}=${pct(row.ndcg)}`)
        .join("  ")}`
    );
  }
  lines.push(
    "",
    "  PROVENANCE (governance capability, NOT a retrieval metric — see the module docs):"
  );
  for (const row of report.provenance) {
    lines.push(
      `    ${row.id.padEnd(20)} flat-search-answerable=${String(row.answerableByFlatSearch).padEnd(
        5
      )} corpus instances=${row.corpusInstances}`
    );
  }
  lines.push("", "  CODE SURFACE carried per signal:");
  for (const row of report.codeSurface) {
    lines.push(
      `    ${row.signal.padEnd(32)} ${String(row.graphPackageLines).padStart(4)} lines in @muon/graph, ` +
        `${row.downstreamSourceFiles} downstream src + ${row.downstreamTestFiles} test files` +
        (row.note ? `\n      (${row.note})` : "")
    );
  }
  return lines.join("\n");
}

export type GraphValueEvalProfiles = {
  /** Shipped-default retrieval width (`pool = max(limit*3, 30)`, k=10). */
  wide: GraphValueEvalReport;
  /** Stress width: pool a quarter of the corpus, k=5, so flat retrieval has to
   *  choose and traversal gets its best shot at supplying something missing. */
  tight: GraphValueEvalReport;
  /** Default local-first install: no embedder, so no dense tier at all. */
  denseOff: GraphValueEvalReport;
};

/** Run the ablation at all three profiles. A signal that pays off at NONE of them
 *  is not a victim of the pool size or of an over-clean stand-in embedder; a
 *  signal that pays off at only one is a tuning question, and the report says
 *  which one. */
export function runGraphValueEvalProfiles(
  set: GraphValueEvalSet
): GraphValueEvalProfiles {
  return {
    wide: runGraphValueEval(set, DEFAULT_ARM_RUN_OPTIONS),
    tight: runGraphValueEval(set, TIGHT_ARM_RUN_OPTIONS),
    denseOff: runGraphValueEval(set, DENSE_OFF_ARM_RUN_OPTIONS),
  };
}

export function formatGraphValueEvalProfiles(
  profiles: GraphValueEvalProfiles
): string {
  return [
    formatGraphValueEvalReport(profiles.wide, {
      header:
        "[KG-12 graph-value ablation: does graph structure beat flat hybrid search?]\n=== PROFILE 1/3: WIDE (shipped searchMemory defaults) ===",
    }),
    "",
    formatGraphValueEvalReport(profiles.tight, {
      header: "=== PROFILE 2/3: TIGHT (stress: small pool, k=5) ===",
      corpus: false,
    }),
    "",
    formatGraphValueEvalReport(profiles.denseOff, {
      header:
        "=== PROFILE 3/3: DENSE-OFF (the default local-first install: no embedder) ===",
      corpus: false,
    }),
  ].join("\n");
}

// Runnable: `node dist/graph-value-eval.js` prints the ablation from the shipped
// corpus AND from the corpus extended with the R2 entity slice. Guarded so
// importing this module never triggers it.
//
// BOTH are printed on purpose. The frozen KG-12 corpus keeps every traversal and
// centrality number exactly comparable to the committed verdict, and it is also
// the honest worst case for entity: its notes hold their coordinates in the
// STRUCTURED anchor fields and paraphrase everything else, so there is almost
// nothing in their TEXT to index. The entity slice adds the class R2 exists to
// serve — notes whose durable nouns live in the prose and which anchor to no
// module at all. A reader who only trusts the frozen corpus can stop after
// section 1 and will reach the correct conclusion for it.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { DEFAULT_GRAPH_VALUE_EVAL_SET } = await import(
    "./fixtures/graph-value-eval-set.js"
  );
  const { ENTITY_GRAPH_VALUE_EVAL_SET } = await import(
    "./fixtures/graph-value-entity-set.js"
  );
  // eslint-disable-next-line no-console
  console.log(
    [
      "############ CORPUS 1/2: FROZEN KG-12 CORPUS (traversal + centrality verdict) ############",
      formatGraphValueEvalProfiles(
        runGraphValueEvalProfiles(DEFAULT_GRAPH_VALUE_EVAL_SET)
      ),
      "",
      "############ CORPUS 2/2: + R2 ENTITY SLICE (anchor-less, prose-noun notes) ############",
      formatGraphValueEvalProfiles(
        runGraphValueEvalProfiles(ENTITY_GRAPH_VALUE_EVAL_SET)
      ),
    ].join("\n")
  );
}
