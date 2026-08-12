# @muon/graph

MUON's embedded memory graph, built on [LadybugDB](https://ladybugdb.com/) (`@ladybugdb/core`), the MIT-licensed successor of KùzuDB. In-process, Cypher-queryable, no separate server.

The Postgres ledger stays the source of truth. This graph is a queryable mirror plus the home of **memory notes** (ROADMAP Phase 7 / WIKI M2) and **routing signals** (Phase 8).

## Schema (v2)

Node tables: `LaneNode`, `TaskNode`, `Module`, `MemoryNote`, `ApprovalNode`, `WorkflowRunNode`
Rel tables:

- `WORKED_ON` (lane→task, outcome stats)
- `HANDED_TO` (lane→lane)
- `ANCHORED_TO` (note→module), `ABOUT_TASK` (note→task), `BY_LANE` (note→lane)
- `GATED_BY` (task→approval), "why is this task blocked" is a graph query
- `TOUCHED` (task→module, at), fed by worktree diffs / event `metadata.modules`
- `SUPERSEDES` (note→note), edit history; text edits create a successor note
- `STEP_OF` (task→workflow run, stepKey), a workflow step IS a task

## Behavior

- **Memory notes**: decision / constraint / convention / attempt / question, with trust level, human confirmation, and provenance (`createdBy`). Temporal validity (Graphiti-inspired): `validFrom` / `invalidatedAt` / `invalidatedBy`; rejection keeps the row (traceable removal) but hides it from recall; edits supersede rather than overwrite.
- **Staleness**: notes anchored to a module become `stale` (with `staleSince`) when that module is touched by a later event, suspect, never destroyed. Human confirmation clears suspicion.
- **Expiry (R3 TTL, mirrored)**: an unconfirmed, low/medium-trust, agent-authored note carries the ledger's `expiresAt` deadline and stops being recalled once it passes; **confirmed, human-authored, and high-trust notes never expire**, and confirming a note redeems it. The ledger (`backend/src/lib/memory-ledger.ts`) is the source of truth and still post-filters every route; this graph enforces the same rule in its own candidate queries and read paths (`memory-expiry.ts`, one predicate + the Cypher clause it pairs with) so a direct graph read cannot serve what the ledger hides. `expired` is **derived, never stored** — one clock. `showExpired` is a server-owned operator opt-in; traversal (`memoryNeighbors` / `memoryExplain`) never drops an expired node but withholds its `text`.
- **Search (v3, hybrid + reranked)**: candidates from FTS/BM25 + lexical + optional semantic embeddings, fused with **Reciprocal Rank Fusion** (k=60), then reranked by a composite **salience score** (relevance + recency-decay + trust + confirmed + usage − stale-penalty; Generative-Agents style). See `memory-ranking.ts` and `docs/research/memory-graph-v3.md`.
- **Recall**: filter recall by task/lane/module/topic, plus `relatedToTask()` traversal with **node-distance reranking** (about-task > module-anchored > lane-authored) and access reinforcement.
- **Write hygiene (v3)**: `ingestMemoryNote()` dedups (`classifyIncomingNote`): near-duplicates NOOP, refinements supersede (history kept), contradicting decisions/constraints on the same anchor are flagged (`conflictsWith`) for human reconciliation, mem0's op-vocabulary made deterministic + human-governed.
- **Reinforcement**: recalled-and-used notes bump `accessCount`/`lastAccessedAt`, lifting them in ranking.
- **Optional embeddings (KG-3, local-first)**: pluggable `Embedder`. Lexical-first is the default + fallback (D3). Dense is **local, opt-in, auto-detected**: the backend probes a loopback Ollama (`http://127.0.0.1:11434`, model `nomic-embed-text`, override `MUON_EMBED_MODEL`; `MUON_EMBED_DISABLE=1` hard-off), no cloud API, no data egress (`redirect: "error"`). No Ollama running → silently lexical, nothing required on first run. Vectors are cached in the ledger's `EmbeddingCache` (keyed by text+model), survive a store wipe, and feed dense recall (fused via RRF) + `max(jaccard, cosine)` dedup, where a dense-only match keeps both notes for human review rather than dropping one.
- **Auto-ingestion**: `extractFromSignal()` mines memories from work signals (review concerns, non-converging loops, handoff questions) with no LLM.
- **Routing**: `suggestLanes(taskId?, text?)` ranks lanes from `WORKED_ON` outcome history (completions, blocked count, cycle time), module familiarity (`TOUCHED` overlap), recency decay, and, when request `text` is given (pre-task planning), capped note-topic overlap. Human-readable reason on every suggestion. It recommends; it never assigns.
- **Workflow mirror**: `recordWorkflowRun()` / `linkTaskToWorkflowRun()` mirror workflow runs and their step tasks (`STEP_OF`), so "which run does this task belong to" is graph-queryable.

## Evals (committed, runnable, deterministic)

Three harnesses live here. All are pure, clock-threaded and network-free, so every number is reproducible rather than a vibe.

| Eval | Question | Run |
|---|---|---|
| `retrieval-eval.ts` | Do the calibrated ranking weights + dedup thresholds beat the baseline, on a held-out split? | `npx vitest run tests/retrieval-eval.test.ts` |
| `activity-eval.ts` | Do the collision / duplicate-work knobs hold up on a disjoint TEST split? | `npm run eval:activity` |
| `graph-value-eval.ts` | **Does graph structure measurably beat flat hybrid search?** Ablates BM25 → +lexical(anchors) → +dense → **+entity** → +centrality prior → +centrality tie-break → +1-hop → +2-hop → +2-hop steelman → +2-hop backfill, at three widths (shipped / tight / no-embedder), reporting recall@k, P@k, nDCG@k, MRR **and** per-query store round-trips and code surface. | `npm run eval:graph-value` |

`graph-value-eval` exists because mem0 deleted its graph-memory subsystem in favour of flat hybrid search, and the same question had to be asked of ours. It publishes a **reachability audit** (how many gold notes each retriever can even see) *before* any arm runs, and reports **per capability class**, so the conclusion does not rest on the corpus mix. Re-run it after any change to `searchMemory`, `memory-ranking.ts`, the entity path, or the traversal path.

Two things it has already decided, both against code we had written:

- **N-hop traversal is not wired into retrieval.** At shipped defaults it surfaced 0 gold a flat retriever could not already reach, for ~30x the store round-trips. `memoryNeighbors` / `memoryExplain` stay as **provenance** surfaces, judged structurally rather than by recall.
- **The centrality ranking prior is cut** (KG-12). It reordered 11/16 queries and lost at every width profile (nDCG −0.0141, MRR −0.0313 at shipped defaults) while never adding a candidate. `CENTRALITY_PRIOR_WEIGHT` survives as an **opt-in** weight so the ablation stays reproducible; `memory-analytics.ts` is a separate product surface and is untouched.

Corpora, both committed:

- `src/fixtures/graph-value-eval-set.ts` — the frozen KG-12 corpus the traversal and centrality verdicts rest on, anchored to real repo module/symbol coordinates.
- `src/fixtures/graph-value-entity-set.ts` — that corpus **plus** an additive R2 slice: notes whose durable nouns live in their prose and which anchor to no module at all (the class entity linking exists to reach). The base set is spread in unchanged so every earlier number stays comparable.

The founder's private local brain is deliberately **not** read; see the fixture headers for what that costs in realism.

## Storage

One database directory per brain: `MUON_GRAPH_DIR` (backend env) or `.muon/graph/` by default. On Railway this is a mounted volume (`/data/graph`).
