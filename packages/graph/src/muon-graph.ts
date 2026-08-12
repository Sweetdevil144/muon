import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import lbug from "@ladybugdb/core";
import {
  classifyIncomingNote,
  cosine,
  decayAccessCount,
  reciprocalRankFusion,
  rerankCalibrated,
  trustRank,
  type RankInput,
} from "./memory-ranking.js";
import {
  analyzeMemoryGraph,
  type MemoryAnalyticsSnapshot,
} from "./memory-analytics.js";
import {
  isMemoryNoteExpired,
  memoryNotExpiredClause,
  resolveExpiryNow,
} from "./memory-expiry.js";
import {
  anchorFenceIsEmpty,
  anchorSetSize,
  memoryAnchorArms,
  normalizeAnchorSet,
  noteMatchesAnchors,
  type MemoryAnchorArm,
  type MemoryAnchorSet,
} from "./memory-anchors.js";
import { memoryPassesGate } from "./memory-gate.js";
import {
  MAX_QUERY_ENTITIES,
  extractEntities,
  extractQueryEntities,
  rankByEntityMentions,
  type EntityCorpusStats,
  type MemoryEntity,
} from "./memory-entities.js";
import { rankLanes } from "./routing.js";
import {
  deriveModulesFromSymbols,
  moduleOfSymbol,
  symbolNameOf,
} from "./symbol-id.js";
import { MEMORY_TRAVERSAL_TEXT_POLICY } from "./types.js";
import type {
  Embedder,
  EmbeddingCacheStore,
  LaneOutcomeStats,
  LaneSuggestion,
  MemoryIngestResult,
  MemoryExplainResult,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphNodeType,
  MemoryGraphRelation,
  MemoryNeighborsOptions,
  MemoryNeighborsResult,
  MemoryKind,
  MemoryNoteInput,
  MemoryNoteRecord,
  MemoryNoteUpdate,
  MemoryRecallFilter,
  MemoryRetrievalRequest,
  MemoryTrust,
  PreEditActivity,
  PrincipalRecord,
} from "./types.js";

const SCHEMA_STATEMENTS = [
  `CREATE NODE TABLE IF NOT EXISTS LaneNode(
    id STRING PRIMARY KEY, laneKey STRING, name STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS TaskNode(
    id STRING PRIMARY KEY, title STRING, status STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS Module(
    path STRING PRIMARY KEY, lastTouchedAt STRING
  )`,
  // Symbol anchor (ADR-0012 / ADR-0009's reserved model): a thin mirror of a
  // `<module>#<name>` symbol id, id is the identity; module/name are the split
  // parts. `symbolUid`/`symbolUidAt` are D2 option B
  // (docs/design/memory-index-decisions.md): a commit-stamped CACHE of the
  // GitNexus uid, NOT a foreign key — nothing joins on it. `symbolUidAt` holds
  // the `graphCommit` the uid was resolved against; a READER (never a
  // background job) treats a mismatch against the live `graphCommit` as a
  // cache miss and re-resolves. Both start '' (unpopulated) at the two ledger
  // ON CREATE sites; only `cacheSymbolUid` ever sets them. A rebuildable
  // projection of the durable `MemoryNote.symbols` column + the
  // `{kind:"symbol"}` MemoryAnchor rows, mirroring `Module`/`ANCHORED_TO`.
  `CREATE NODE TABLE IF NOT EXISTS Symbol(
    id STRING PRIMARY KEY, module STRING, name STRING, kind STRING,
    symbolUid STRING, symbolUidAt STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS MemoryNote(
    id STRING PRIMARY KEY,
    kind STRING,
    text STRING,
    taskId STRING,
    laneId STRING,
    chatId STRING,
    workspacePath STRING,
    modules STRING[],
    topics STRING[],
    symbols STRING[],
    trust STRING,
    confirmed BOOLEAN,
    crewVouched BOOLEAN,
    stale BOOLEAN,
    status STRING,
    scope STRING,
    createdBy STRING,
    createdAt STRING,
    updatedAt STRING,
    validFrom STRING,
    validTo STRING,
    invalidatedAt STRING,
    invalidatedBy STRING,
    staleSince STRING,
    supersededBy STRING,
    accessCount INT64,
    lastAccessedAt STRING,
    conflictsWith STRING,
    expiresAt STRING,
    embedding DOUBLE[],
    embeddingSpace STRING
  )`,
  // Provenance principal (KG-5): the human/agent that authored/confirmed a note.
  // A rebuildable projection of the durable Principal ledger table.
  `CREATE NODE TABLE IF NOT EXISTS Principal(
    id STRING PRIMARY KEY,
    kind STRING,
    displayName STRING,
    vendor STRING,
    trust STRING,
    createdAt STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS ApprovalNode(
    id STRING PRIMARY KEY,
    taskId STRING,
    kind STRING,
    status STRING,
    createdAt STRING,
    decidedAt STRING
  )`,
  `CREATE REL TABLE IF NOT EXISTS WORKED_ON(
    FROM LaneNode TO TaskNode,
    assignmentId STRING,
    state STRING,
    startedAt STRING,
    completedAt STRING,
    durationMs INT64,
    blockedCount INT64
  )`,
  `CREATE REL TABLE IF NOT EXISTS HANDED_TO(
    FROM LaneNode TO LaneNode,
    handoffId STRING,
    taskId STRING,
    status STRING,
    createdAt STRING
  )`,
  `CREATE REL TABLE IF NOT EXISTS ANCHORED_TO(FROM MemoryNote TO Module)`,
  // Symbol anchor edge (ADR-0012), mirroring ANCHORED_TO. `relation`/`weight` are
  // reserved for the typed-anchor follow-on (defines/mentions/tests); v1 is flat.
  `CREATE REL TABLE IF NOT EXISTS ABOUT_SYMBOL(FROM MemoryNote TO Symbol, relation STRING, weight DOUBLE)`,
  `CREATE REL TABLE IF NOT EXISTS ABOUT_TASK(FROM MemoryNote TO TaskNode)`,
  `CREATE REL TABLE IF NOT EXISTS BY_LANE(FROM MemoryNote TO LaneNode)`,
  `CREATE NODE TABLE IF NOT EXISTS WorkflowRunNode(
    id STRING PRIMARY KEY,
    templateKey STRING,
    status STRING,
    createdAt STRING
  )`,
  `CREATE REL TABLE IF NOT EXISTS GATED_BY(FROM TaskNode TO ApprovalNode)`,
  `CREATE REL TABLE IF NOT EXISTS TOUCHED(FROM TaskNode TO Module, at STRING)`,
  // KG-8 (ADR-0014), the REBUILDABLE recent-activity projection (past tense), a
  // parallel to TOUCHED that carries the cross-agent COORDINATE columns the hero
  // surfaces (never content). Deliberately SEPARATE from TOUCHED, which is a pure
  // staleness edge: (task,module)+`at`, `ON MATCH` clobbering `at`, with no lane/
  // vendor/job/kind, reusing it would either couple activity coordinates to
  // staleness (a re-touch would overwrite them) or lose the laneId/kind the
  // coordinate row needs. `ACTED_ON` anchors on the FINEST namespace (Symbol,
  // ADR-0012); `ACTED_ON_MODULE` on the module. Both restore wipe-survivably from
  // the append-only Event log (+ the trusted DispatchJob claim-state) inside
  // `projectLedgerToGraph`, exactly as memory replays from MemoryNote. COORDINATES
  // ONLY: jobId/vendor/laneId/kind/at, NEVER Event.message, DispatchJob.brief, or
  // any free-form text.
  `CREATE REL TABLE IF NOT EXISTS ACTED_ON(FROM TaskNode TO Symbol, jobId STRING, vendor STRING, laneId STRING, kind STRING, at STRING)`,
  `CREATE REL TABLE IF NOT EXISTS ACTED_ON_MODULE(FROM TaskNode TO Module, jobId STRING, vendor STRING, laneId STRING, kind STRING, at STRING)`,
  // Note→note edge vocabulary (KG-5/KG-6): SUPERSEDES (a refinement retires the
  // old), EXTENDS (adds detail; both stay active), CONTRADICTS (both stay active,
  // human reconciles), RELATED (dense-only
  // match, both kept), PROPOSES_SUPERSEDE (KG-6: a governed, contested destructive
  // write, both notes stay active until a human/peer confirms it), CLONED_FROM
  // (fresh unconfirmed proposal → source coordinate). All persisted MemoryEdge
  // rows in the ledger, projected here.
  `CREATE REL TABLE IF NOT EXISTS SUPERSEDES(FROM MemoryNote TO MemoryNote)`,
  `CREATE REL TABLE IF NOT EXISTS EXTENDS(FROM MemoryNote TO MemoryNote)`,
  `CREATE REL TABLE IF NOT EXISTS CONTRADICTS(FROM MemoryNote TO MemoryNote)`,
  `CREATE REL TABLE IF NOT EXISTS RELATED(FROM MemoryNote TO MemoryNote)`,
  `CREATE REL TABLE IF NOT EXISTS PROPOSES_SUPERSEDE(FROM MemoryNote TO MemoryNote)`,
  `CREATE REL TABLE IF NOT EXISTS CLONED_FROM(FROM MemoryNote TO MemoryNote)`,
  // Provenance edges (KG-5): who authored / confirmed a note.
  `CREATE REL TABLE IF NOT EXISTS AUTHORED_BY(FROM MemoryNote TO Principal)`,
  `CREATE REL TABLE IF NOT EXISTS CONFIRMED_BY(FROM MemoryNote TO Principal)`,
  `CREATE REL TABLE IF NOT EXISTS STEP_OF(FROM TaskNode TO WorkflowRunNode, stepKey STRING)`,
];

/**
 * R2 entity linking (mem0 §5.3), kept in its OWN statement list rather than in
 * SCHEMA_STATEMENTS so it can fail independently — see `tryEnableEntities`.
 *
 * The node is DELIBERATELY just its key. The normalized join key IS the identity,
 * and nothing else is stored: no surface form, no class, no note back-reference
 * beyond the edge. The class that minted an entity is only ever needed on the
 * QUERY side (to weight a match), where it is recomputed from the query text for
 * free, so persisting it would be storing a fragment of note text that nothing
 * reads. Least content at rest is also the cheapest thing to reason about for the
 * text gate.
 */
const ENTITY_SCHEMA_STATEMENTS = [
  `CREATE NODE TABLE IF NOT EXISTS Entity(id STRING PRIMARY KEY)`,
  `CREATE REL TABLE IF NOT EXISTS MENTIONS(FROM MemoryNote TO Entity)`,
];

// Best-effort column migrations for graphs created before v2. Each ALTER
// fails harmlessly when the column already exists.
const MIGRATION_STATEMENTS = [
  `ALTER TABLE MemoryNote ADD validFrom STRING DEFAULT ''`,
  `ALTER TABLE MemoryNote ADD invalidatedAt STRING DEFAULT ''`,
  `ALTER TABLE MemoryNote ADD invalidatedBy STRING DEFAULT ''`,
  `ALTER TABLE MemoryNote ADD staleSince STRING DEFAULT ''`,
  `ALTER TABLE MemoryNote ADD supersededBy STRING DEFAULT ''`,
  // v3: usage reinforcement + conflict provenance + optional embeddings.
  `ALTER TABLE MemoryNote ADD accessCount INT64 DEFAULT 0`,
  `ALTER TABLE MemoryNote ADD lastAccessedAt STRING DEFAULT ''`,
  `ALTER TABLE MemoryNote ADD conflictsWith STRING DEFAULT ''`,
  `ALTER TABLE MemoryNote ADD embedding DOUBLE[] DEFAULT []`,
  // TODO 4.4: stamp which embedding SPACE produced `embedding` so the dense arm
  // can gate on equality (exact, not a coverage threshold). Default '' = no
  // space → excluded from dense candidates until reprojected under a live model.
  `ALTER TABLE MemoryNote ADD embeddingSpace STRING DEFAULT ''`,
  // KG-5: bitemporal valid-time end + visibility scope on pre-existing stores.
  `ALTER TABLE MemoryNote ADD validTo STRING DEFAULT ''`,
  `ALTER TABLE MemoryNote ADD scope STRING DEFAULT 'project'`,
  // ADR-0012: the scalar symbol-anchor array for cheap `list_contains` recall.
  `ALTER TABLE MemoryNote ADD symbols STRING[] DEFAULT []`,
  // #126: the per-chat partition key on pre-existing stores. Default '' so a
  // legacy note is a NULL-chat note (chat-private to nobody). A chat-scoped read
  // admits it only after explicit human-confirmed `scope:"global"` promotion.
  `ALTER TABLE MemoryNote ADD chatId STRING DEFAULT ''`,
  // ADR-0026: the per-workspace partition key on pre-existing stores. Default ''
  // (the `chatId` precedent) so a legacy note is UNASSIGNED rather than assigned
  // to a wrong repo, and the durable ledger's own backfill is what supplies the
  // real value on the next reprojection.
  `ALTER TABLE MemoryNote ADD workspacePath STRING DEFAULT ''`,
  // R3: the TTL deadline on pre-existing stores. Default '' = never expires, so a
  // graph created before TTL keeps every note visible until the ledger reprojects
  // the real deadlines — a migration can only ever be non-destructive here.
  `ALTER TABLE MemoryNote ADD expiresAt STRING DEFAULT ''`,
  // Substrate §3.4: structured attempt outcome. Default '' = legacy / unset.
  `ALTER TABLE MemoryNote ADD outcome STRING DEFAULT ''`,
  // ADR-0027 D12-C: rebuildable trust-tier projection. False on old stores until
  // the ledger reprojects; coordinate analytics therefore fail closed rather
  // than treating a historical one-writer note as corroborated.
  `ALTER TABLE MemoryNote ADD crewVouched BOOLEAN DEFAULT false`,
  // D2 option B: the commit stamp for the `symbolUid` cache on pre-existing
  // stores. Default '' so an old Symbol node reads as an unresolved cache
  // (never a wrong-commit hit), matching `symbolUid`'s own '' default.
  `ALTER TABLE Symbol ADD symbolUidAt STRING DEFAULT ''`,
];

const NOTE_RETURN = `n.id, n.kind, n.text, n.taskId, n.laneId, n.chatId,
       n.workspacePath,
       n.modules, n.topics,
       n.symbols,
       n.trust, n.confirmed, n.stale, n.status, n.scope, n.createdBy,
       n.createdAt, n.updatedAt, n.validFrom, n.validTo, n.invalidatedAt,
       n.invalidatedBy, n.staleSince, n.supersededBy,
       n.accessCount, n.lastAccessedAt, n.conflictsWith, n.expiresAt, n.outcome`;

/**
 * D6: the row ceiling for a BATCHED (multi-anchor) recall, and the number that
 * decides whether batching is a silent truncation.
 *
 * The fan-out this replaces asked for `limit` rows PER ANCHOR and merged by id, so
 * its union could be `limit × anchors` wide. A batched caller therefore states the
 * AGGREGATE it wants (`preEditContext` passes `limit × anchorCount`), and this
 * ceiling must not bind before that aggregate would — otherwise the two shapes
 * return different sets and the "byte-identical governed row set" exit condition is
 * only true on small corpora. MEASURED: at 10 000 notes / 128 anchors a 2 000-row
 * ceiling returned 2 000 rows where the fan-out returned 2 176. That ceiling was
 * wrong, and the differential run at scale is what caught it.
 *
 * 25 600 = `MAX_ANCHOR_MODULES` (128, the gate's own radius cap) × 200 (the
 * single-anchor row clamp) — the widest union the per-anchor fan-out could ever
 * have produced within the product's own bounds. So for every gate read this
 * ceiling is provably slack and the caller's own `limit × anchors` is what binds.
 * A DIRECT library caller that asks for more than the gate can (512 anchors × 200)
 * is still bounded here, deliberately: an unbounded anchored scan is the same
 * materialize-the-table hazard the lexical arm still carries.
 *
 * Single-anchor and unanchored recalls keep the pre-D4 clamp of 200 untouched,
 * which is what makes every existing request byte-identical.
 */
const MAX_ANCHORED_ROWS = 25_600;

/**
 * D6: the candidate-query shapes an anchored read runs — one per non-empty anchor
 * namespace, or the single UNANCHORED shape when the caller stated no anchor.
 *
 * `distinct` is on only for an anchor arm: a note carrying three of the requested
 * anchors matches the join three times, and without `RETURN DISTINCT` an enclosing
 * `LIMIT` would count (note, anchor) pairs. The unanchored shape has no join and
 * must NOT be `DISTINCT` — it is the pre-D4 query, byte for byte.
 */
type AnchorQueryShape = {
  pattern: string;
  conditions: string[];
  params: Params;
  distinct: boolean;
};

const UNANCHORED_SHAPE: AnchorQueryShape = {
  pattern: "",
  conditions: [],
  params: {},
  distinct: false,
};

/**
 * The shapes to run, or `[]` when the caller fenced the read to NOTHING (see
 * `anchorFenceIsEmpty`). `[]` means "run no query and return no rows", and every
 * caller must handle it — falling through to `UNANCHORED_SHAPE` there would turn a
 * fence into a full-corpus read, which is why the empty case is a distinct return
 * value rather than an absent clause.
 */
function anchorQueryShapes(anchors: MemoryAnchorSet): AnchorQueryShape[] {
  if (anchorFenceIsEmpty(anchors)) {
    return [];
  }
  const arms: MemoryAnchorArm[] = memoryAnchorArms(anchors);
  if (arms.length === 0) {
    return [UNANCHORED_SHAPE];
  }
  return arms.map((arm) => ({
    pattern: arm.pattern,
    conditions: [arm.condition],
    params: arm.params as Params,
    distinct: true,
  }));
}

type Row = Record<string, unknown>;
type Params = Record<string, string | number | boolean | string[] | number[]>;

const DEFAULT_MEMORY_GRAPH_RELATIONS: MemoryGraphRelation[] = [
  "SUPERSEDES",
  "CONTRADICTS",
  "AUTHORED_BY",
  "CONFIRMED_BY",
  "ANCHORED_TO",
  "ABOUT_SYMBOL",
  "ABOUT_TASK",
  "BY_LANE",
  "TOUCHED",
  "WORKED_ON",
  "GATED_BY",
  "CLONED_FROM",
];

// Explicit neighborhood reads may inspect a derived EXTENDS edge. The default
// explanation walk deliberately omits it until a human approves the relation,
// so an unconfirmed detail cannot borrow its predecessor's provenance.
const ALLOWED_MEMORY_GRAPH_RELATIONS: MemoryGraphRelation[] = [
  ...DEFAULT_MEMORY_GRAPH_RELATIONS,
  "EXTENDS",
];

type MemoryTraversalRef = {
  type: MemoryGraphNodeType;
  entityId: string;
};

type MemoryTraversalStep = {
  node: MemoryTraversalRef;
  edge: MemoryGraphEdge;
};

type MemoryTraversalResult = MemoryNeighborsResult & {
  depths: Map<string, number>;
};

function memoryTraversalId(ref: MemoryTraversalRef): string {
  return `${ref.type}:${ref.entityId}`;
}

const MEMORY_TRAVERSAL_COORDINATE = /^[A-Za-z0-9@._~:+#$%/-]+$/;
const MEMORY_TRAVERSAL_TEXT_LIMIT = 4_000;

function safeMemoryTraversalCoordinate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.length > 0 &&
    value.length <= 512 &&
    MEMORY_TRAVERSAL_COORDINATE.test(value)
    ? value
    : undefined;
}

function parseMemoryTraversalId(value: string): MemoryTraversalRef {
  const separator = value.indexOf(":");
  if (separator > 0) {
    const type = value.slice(0, separator) as MemoryGraphNodeType;
    if (
      type === "note" ||
      type === "principal" ||
      type === "module" ||
      type === "symbol" ||
      type === "task" ||
      type === "lane" ||
      type === "approval"
    ) {
      return { type, entityId: value.slice(separator + 1) };
    }
  }
  return { type: "note", entityId: value };
}

/** Map a ledger MemoryEdge.kind → its graph relationship-table name (KG-5/KG-6),
 *  or null for an unknown kind (skip). Single source of truth for the note→note
 *  edge vocabulary used by project/delete/clear so they can never drift. */
function memoryEdgeRel(kind: string): string | null {
  switch (kind) {
    case "supersedes":
      return "SUPERSEDES";
    case "extends":
      return "EXTENDS";
    case "contradicts":
      return "CONTRADICTS";
    case "related":
      return "RELATED";
    case "proposes_supersede":
      return "PROPOSES_SUPERSEDE";
    case "cloned_from":
      return "CLONED_FROM";
    default:
      return null;
  }
}

/**
 * Canonical millisecond-precision UTC-Z ISO string for an as-of instant, or
 * undefined when unparseable (F1). Bitemporal comparisons are raw lexicographic
 * string compares against stored `Date.toISOString()` values, so the as-of side
 * MUST be the same format/precision/zone or the wrong active set is returned
 * (e.g. second-precision `...:00Z`, offset `...+05:30`, or date-only inputs). The
 * route normalizes + rejects too; this is the defensive net for direct graph
 * callers (tests, CLI) that bypass it, an unparseable value falls back to the
 * current active set rather than throwing.
 */
function normalizeInstant(value: string): string | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function noteFromRow(row: Row): MemoryNoteRecord {
  const value = (key: string) => row[`n.${key}`] ?? row[key];
  return {
    id: String(value("id")),
    kind: String(value("kind")) as MemoryKind,
    text: String(value("text")),
    taskId: (value("taskId") as string | null) || null,
    laneId: (value("laneId") as string | null) || null,
    // #126: '' (the store default for a legacy / non-chat note) → null, so a
    // chat-scoped read's `(chatId ?? '') === $chatId` post-filter never matches it.
    chatId: (value("chatId") as string | null) || null,
    // ADR-0026: '' (the store default for a pre-partition / unassigned note) →
    // null, exactly as chatId does, so an unassigned note is never mistaken for a
    // note assigned to the empty-string workspace.
    workspacePath: (value("workspacePath") as string | null) || null,
    modules: (value("modules") as string[]) ?? [],
    topics: (value("topics") as string[]) ?? [],
    symbols: (value("symbols") as string[]) ?? [],
    trust: String(value("trust")) as MemoryTrust,
    confirmed: Boolean(value("confirmed")),
    stale: Boolean(value("stale")),
    status: String(value("status")) as MemoryNoteRecord["status"],
    scope: (value("scope") as string) || "project",
    createdBy: String(value("createdBy")),
    createdAt: String(value("createdAt")),
    updatedAt: String(value("updatedAt")),
    validFrom: String(value("validFrom") ?? "") || String(value("createdAt")),
    validTo: (value("validTo") as string) || null,
    invalidatedAt: (value("invalidatedAt") as string) || null,
    invalidatedBy: (value("invalidatedBy") as string) || null,
    staleSince: (value("staleSince") as string) || null,
    supersededBy: (value("supersededBy") as string) || null,
    accessCount: Number(value("accessCount") ?? 0) || 0,
    lastAccessedAt: (value("lastAccessedAt") as string) || null,
    conflictsWith: (value("conflictsWith") as string) || null,
    // R3: '' (never stamped) and NULL (a graph-native note that predates the
    // column) both mean "never expires". `expired` is derived, never stored.
    expiresAt: (value("expiresAt") as string) || null,
    outcome: (() => {
      const raw = (value("outcome") as string) || "";
      if (
        raw === "worked" ||
        raw === "abandoned" ||
        raw === "superseded" ||
        raw === "unknown"
      ) {
        return raw;
      }
      return null;
    })(),
  };
}

async function getAllRows(result: unknown): Promise<Row[]> {
  const single = Array.isArray(result) ? result[result.length - 1] : result;
  return (await (single as { getAll: () => Promise<Row[]> }).getAll()) ?? [];
}

/**
 * Embedded LadybugDB store for MUON's memory graph and routing signals.
 * The relational ledger (Postgres) stays the source of truth; this graph is
 * a queryable mirror plus the home of memory notes.
 */
/**
 * The BM25 index's name in the store. ONE spelling: `tryEnableFts` creates it,
 * `hasFtsIndex` adopts it, and `searchMemoryFts` queries it — three sites that
 * must agree or the arm silently answers nothing.
 */
const MEMORY_FTS_INDEX = "memory_note_fts";

export class MuonGraph {
  private db: InstanceType<typeof lbug.Database>;
  private conn: InstanceType<typeof lbug.Connection>;
  private ready: Promise<void> | null = null;
  private ftsEnabled = false;
  /** R2: whether the Entity/MENTIONS tables exist. False ⇒ entity extraction is
   *  never written and `entityCandidates` returns [], i.e. the pre-R2 behaviour. */
  private entitiesEnabled = false;
  private readonly embedder?: Embedder;
  private readonly embeddingCache?: EmbeddingCacheStore;
  private readonly disableFts: boolean;
  // Reinforcement OFF the read path (ADR-0009 §2.4 / KG-2). Explicit "used"
  // signals (a note actually cited/applied, NOT merely retrieved) accumulate
  // here in memory; nothing is written on a search/recall. A timer/shutdown
  // flush (driven by the durable ledger layer) drains this into the graph with
  // time-decay and persists the result, so reads never amplify into writes.
  private readonly usageBuffer = new Map<
    string,
    { count: number; lastUsedAt: string }
  >();

  constructor(
    private readonly databasePath: string,
    options?: {
      embedder?: Embedder;
      embeddingCache?: EmbeddingCacheStore;
      disableFts?: boolean;
    }
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new lbug.Database(databasePath);
    this.conn = new lbug.Connection(this.db);
    this.embedder = options?.embedder;
    this.embeddingCache = options?.embeddingCache;
    // Some hosts (e.g. minimal containers) cannot load the Ladybug FTS
    // native extension; when disabled, retrieval uses lexical + salience
    // (and optional embeddings) with no loss of correctness, and crucially
    // no FTS index is created, so writes never depend on the extension.
    this.disableFts = options?.disableFts ?? false;
  }

  async init(): Promise<void> {
    this.ready ??= (async () => {
      for (const statement of SCHEMA_STATEMENTS) {
        await this.conn.query(statement);
      }
      for (const statement of MIGRATION_STATEMENTS) {
        await this.conn.query(statement).catch(() => undefined);
      }
      await this.tryEnableFts();
      await this.tryEnableEntities();
    })();
    return this.ready;
  }

  /**
   * R2: create the entity tables, mirroring `tryEnableFts`'s posture exactly —
   * TRY, and on any failure clear the flag and degrade silently. Retrieval then
   * runs FTS + lexical (+ dense) with no loss of correctness, and, crucially, no
   * write path ever depends on the tables existing. mem0 ships its entity tier as
   * an optional extra (`pip install mem0ai[nlp]`) with documented graceful
   * degradation; this is the same contract, expressed in the mechanism this
   * codebase already uses.
   */
  private async tryEnableEntities(): Promise<void> {
    try {
      for (const statement of ENTITY_SCHEMA_STATEMENTS) {
        await this.conn.query(statement);
      }
      this.entitiesEnabled = true;
    } catch {
      this.entitiesEnabled = false;
    }
  }

  /**
   * Arm the BM25 arm of `searchMemory`, ONCE PER STORE rather than once per
   * process.
   *
   * The index is durable — it lives in the store file and auto-updates on
   * insert — so only the FIRST process to open a given store may create it.
   * Every later process must ADOPT it. Creating it unconditionally throws
   * `Binder exception: Index memory_note_fts already exists`, and because the
   * whole block was one try/catch that set `ftsEnabled = false`, that threw away
   * lexical retrieval for the entire process lifetime.
   *
   * Measured before this fix, three consecutive `node` processes against one
   * store path: boot 1 `true`, boot 2 `false`, boot 3 `false`. Every install
   * past its first launch was therefore running memory recall on the dense +
   * entity arms alone — ADR-0021's ablation puts the lexical arm at recall@10
   * .4219 standalone, and it is the arm that still answers when no embedder is
   * running, which is the common local case.
   *
   * It survived review because it degrades QUALITY, not availability (recall
   * still returns rows, just worse ones), and because no test opened a
   * persisted store twice — every `new MuonGraph(...)` in the suite roots at a
   * fresh `mkdtempSync` dir, so only the first-boot path was ever exercised.
   * `tests/memory-fts-persistence.test.ts` now opens the same path twice.
   *
   * Still fail-safe: any genuine failure (extension missing, store unwritable)
   * leaves `ftsEnabled = false` and `searchMemory` simply skips that arm.
   */
  private async tryEnableFts(): Promise<void> {
    if (this.disableFts) {
      this.ftsEnabled = false;
      return;
    }
    try {
      await this.conn.query("LOAD EXTENSION FTS;");
      if (!(await this.hasFtsIndex())) {
        await this.conn.query(
          `CALL CREATE_FTS_INDEX(
            'MemoryNote',
            'memory_note_fts',
            ['text'],
            stemmer := 'english'
          );`
        );
      }
      this.ftsEnabled = true;
    } catch {
      this.ftsEnabled = false;
    }
  }

  /**
   * Does this store already carry the FTS index? Asked of the store itself
   * rather than inferred from a thrown error message — an error string is a
   * vendor detail that can change under us, whereas the index either is or is
   * not in `SHOW_INDEXES()`. A failure to ask is reported as "absent", so the
   * caller attempts the create and its own catch decides.
   */
  private async hasFtsIndex(): Promise<boolean> {
    try {
      const result = await this.conn.query("CALL SHOW_INDEXES() RETURN *;");
      const rows = await getAllRows(result);
      return rows.some(
        (row) =>
          (row as { index_name?: unknown }).index_name === MEMORY_FTS_INDEX
      );
    } catch {
      return false;
    }
  }

  private async query(statement: string): Promise<Row[]> {
    await this.init();
    const result = await this.conn.query(statement);
    return getAllRows(result);
  }

  async close(): Promise<void> {
    await this.conn.close();
    await this.db.close();
  }

  private async execute(statement: string, params: Params): Promise<Row[]> {
    await this.init();
    const prepared = await this.conn.prepare(statement);
    const result = await this.conn.execute(
      prepared,
      params as Parameters<typeof this.conn.execute>[1]
    );
    return getAllRows(result);
  }

  // ---- ledger mirror writers (best-effort callers) ----

  async upsertLane(lane: { id: string; key: string; name: string }): Promise<void> {
    await this.execute(
      `MERGE (l:LaneNode {id: $id})
       ON CREATE SET l.laneKey = $laneKey, l.name = $name
       ON MATCH SET l.laneKey = $laneKey, l.name = $name`,
      { id: lane.id, laneKey: lane.key, name: lane.name }
    );
  }

  async upsertTask(task: { id: string; title: string; status: string }): Promise<void> {
    await this.execute(
      `MERGE (t:TaskNode {id: $id})
       ON CREATE SET t.title = $title, t.status = $status
       ON MATCH SET t.title = $title, t.status = $status`,
      { id: task.id, title: task.title, status: task.status }
    );
  }

  async recordAssignment(input: {
    assignmentId: string;
    laneId: string;
    taskId: string;
    createdAt: string;
  }): Promise<void> {
    await this.execute(
      `MATCH (l:LaneNode {id: $laneId}), (t:TaskNode {id: $taskId})
       MERGE (l)-[w:WORKED_ON {assignmentId: $assignmentId}]->(t)
       ON CREATE SET w.state = 'queued', w.startedAt = $createdAt,
                     w.blockedCount = 0, w.durationMs = 0`,
      {
        laneId: input.laneId,
        taskId: input.taskId,
        assignmentId: input.assignmentId,
        createdAt: input.createdAt,
      }
    );
  }

  async recordHandoff(input: {
    handoffId: string;
    taskId: string;
    fromLaneId: string;
    toLaneId: string;
    status: string;
    createdAt: string;
  }): Promise<void> {
    await this.execute(
      `MATCH (a:LaneNode {id: $fromLaneId}), (b:LaneNode {id: $toLaneId})
       MERGE (a)-[h:HANDED_TO {handoffId: $handoffId}]->(b)
       ON CREATE SET h.taskId = $taskId, h.status = $status, h.createdAt = $createdAt`,
      {
        fromLaneId: input.fromLaneId,
        toLaneId: input.toLaneId,
        handoffId: input.handoffId,
        taskId: input.taskId,
        status: input.status,
        createdAt: input.createdAt,
      }
    );
  }

  /**
   * Milestone events update WORKED_ON outcome stats used by routing.
   */
  async recordEvent(input: {
    laneId: string;
    taskId: string;
    kind: string;
    timestamp: string;
  }): Promise<void> {
    if (input.kind === "task.completed") {
      await this.execute(
        `MATCH (l:LaneNode {id: $laneId})-[w:WORKED_ON]->(t:TaskNode {id: $taskId})
         SET w.state = 'completed', w.completedAt = $timestamp`,
        { laneId: input.laneId, taskId: input.taskId, timestamp: input.timestamp }
      );
      return;
    }
    if (input.kind === "task.blocked") {
      await this.execute(
        `MATCH (l:LaneNode {id: $laneId})-[w:WORKED_ON]->(t:TaskNode {id: $taskId})
         SET w.blockedCount = w.blockedCount + 1, w.state = 'blocked'`,
        { laneId: input.laneId, taskId: input.taskId }
      );
    }
  }

  /**
   * Marks modules as touched. Anchored notes older than the touch become
   * suspect (`stale` + `staleSince`), never destroyed, temporal semantics
   * per docs/research/memory-graph-architecture.md. When a task id is given,
   * a TOUCHED edge records which task changed the module (module familiarity
   * + staleness provenance).
   */
  async touchModules(
    modules: string[],
    timestamp: string,
    taskId?: string
  ): Promise<void> {
    for (const path of modules) {
      await this.execute(
        `MERGE (m:Module {path: $path})
         ON CREATE SET m.lastTouchedAt = $timestamp
         ON MATCH SET m.lastTouchedAt = $timestamp`,
        { path, timestamp }
      );
      await this.execute(
        // staleSince is SET-ONCE (KG-2 / F4): only the notes not already stale
        // are touched, so the timestamp records WHEN suspicion first arose and
        // never drifts on re-touch, matching the ledger's markModulesStale
        // (`staleSince: null` filter), so live graph and ledger agree and a
        // wipe+reproject restores the same timestamp.
        //
        // The touching task's OWN notes are exempt, in LOCKSTEP with the
        // ledger's markModulesStale: staleness is OR'd across the two
        // witnesses (`resolveStale`), so an exemption held by only one of
        // them is no exemption at all. A note a task writes about the change
        // it is making is described by that change, not contradicted by it.
        taskId
          ? `MATCH (n:MemoryNote)-[:ANCHORED_TO]->(m:Module {path: $path})
             WHERE n.validFrom < $timestamp AND n.status = 'active'
               AND (n.staleSince IS NULL OR n.staleSince = '')
               AND n.taskId <> $exemptTaskId
             SET n.stale = true, n.staleSince = $timestamp, n.updatedAt = $timestamp`
          : `MATCH (n:MemoryNote)-[:ANCHORED_TO]->(m:Module {path: $path})
             WHERE n.validFrom < $timestamp AND n.status = 'active'
               AND (n.staleSince IS NULL OR n.staleSince = '')
             SET n.stale = true, n.staleSince = $timestamp, n.updatedAt = $timestamp`,
        taskId
          ? { path, timestamp, exemptTaskId: taskId }
          : { path, timestamp }
      );
      if (taskId) {
        await this.execute(
          `MATCH (t:TaskNode {id: $taskId}), (m:Module {path: $path})
           MERGE (t)-[e:TOUCHED]->(m)
           ON CREATE SET e.at = $timestamp
           ON MATCH SET e.at = $timestamp`,
          { taskId, path, timestamp }
        ).catch(() => undefined);
      }
    }
  }

  /**
   * KG-8 (ADR-0014), MERGE the REBUILDABLE recent-activity projection for a task's
   * append-only Event: one `ACTED_ON` edge per declared symbol (kind:"editing", the
   * finest ADR-0012 anchor) and one `ACTED_ON_MODULE` edge per touched module
   * (kind:"running"). Idempotent + monotonic-latest (ON CREATE/ON MATCH both SET the
   * coordinates + `at`), mirroring `touchModules`, so the same event replayed over
   * an intact or freshly-wiped store yields the identical edge with zero
   * duplication, and a re-touch advances `at`/job to the latest.
   *
   * COORDINATES, NEVER CONTENT (the load-bearing invariant): the edge carries only
   * the FROM task id, the TO anchor id, and jobId/vendor/laneId/kind/at. No
   * `Event.message`, `DispatchJob.brief`, `Task.title`, or note text is read into or
   * stored on it. `jobId`/`vendor` are the TRUSTED, bounded `DispatchJob` claim-state
   * threaded in by the caller (the events route / `projectLedgerToGraph`), never a
   * free-form `metadata` value, and `laneId` is the Event's already-machine-bounded
   * lane id (KG-7 ingestion). An absent coordinate degrades to "".
   */
  async recordActivity(input: {
    taskId: string;
    laneId: string;
    vendor: string;
    jobId: string;
    at: string;
    symbols?: string[];
    modules?: string[];
  }): Promise<void> {
    await this.execute(`MERGE (t:TaskNode {id: $taskId})`, {
      taskId: input.taskId,
    });
    const setCoords = `e.jobId = $jobId, e.vendor = $vendor,
                       e.laneId = $laneId, e.kind = $kind, e.at = $at`;
    for (const id of input.symbols ?? []) {
      await this.execute(
        `MERGE (s:Symbol {id: $id})
         ON CREATE SET s.module = $module, s.name = $name, s.kind = '', s.symbolUid = ''`,
        { id, module: moduleOfSymbol(id), name: symbolNameOf(id) }
      );
      await this.execute(
        `MATCH (t:TaskNode {id: $taskId}), (s:Symbol {id: $id})
         MERGE (t)-[e:ACTED_ON]->(s)
         ON CREATE SET ${setCoords}
         ON MATCH SET ${setCoords}`,
        {
          taskId: input.taskId,
          id,
          jobId: input.jobId,
          vendor: input.vendor,
          laneId: input.laneId,
          kind: "editing",
          at: input.at,
        }
      ).catch(() => undefined);
    }
    for (const path of input.modules ?? []) {
      // MERGE the Module without touching `lastTouchedAt` (that is staleness, owned
      // by `touchModules`); an existing node is left untouched, a new one seeds ''.
      await this.execute(
        `MERGE (m:Module {path: $path}) ON CREATE SET m.lastTouchedAt = ''`,
        { path }
      );
      await this.execute(
        `MATCH (t:TaskNode {id: $taskId}), (m:Module {path: $path})
         MERGE (t)-[e:ACTED_ON_MODULE]->(m)
         ON CREATE SET ${setCoords}
         ON MATCH SET ${setCoords}`,
        {
          taskId: input.taskId,
          path,
          jobId: input.jobId,
          vendor: input.vendor,
          laneId: input.laneId,
          kind: "running",
          at: input.at,
        }
      ).catch(() => undefined);
    }
  }

  /**
   * D2 option B (docs/design/memory-index-decisions.md): MERGE the Symbol node
   * and stamp the GitNexus uid it resolved to, alongside the `graphCommit` that
   * resolution is only valid against. This is a MEMOIZED LOOKUP, not a foreign
   * key — nothing in this codebase joins on `symbolUid`. The caller (a reader,
   * e.g. an MCP tool composing `code_impact`) is the one who decided the uid is
   * correct RIGHT NOW; this method only records that decision and when it was
   * made. Idempotent (MERGE + unconditional SET on both branches), so caching
   * the same pair twice, or a later resolution overwriting an earlier one, is
   * always safe.
   */
  async cacheSymbolUid(
    localId: string,
    gitnexusUid: string,
    graphCommit: string
  ): Promise<void> {
    await this.execute(
      `MERGE (s:Symbol {id: $id})
       ON CREATE SET s.module = $module, s.name = $name, s.kind = '',
                     s.symbolUid = $symbolUid, s.symbolUidAt = $symbolUidAt
       ON MATCH SET s.symbolUid = $symbolUid, s.symbolUidAt = $symbolUidAt`,
      {
        id: localId,
        module: moduleOfSymbol(localId),
        name: symbolNameOf(localId),
        symbolUid: gitnexusUid,
        symbolUidAt: graphCommit,
      }
    );
  }

  /**
   * D2 option B: the reader-owned lazy cache READ. A `graphCommit` mismatch
   * against the cached `symbolUidAt` is a CACHE MISS, not a stale hit —
   * byte-for-byte the posture `preflight_edit` already enforces on its own
   * `graphCommit == headCommit` freshness check. No Symbol row, an empty
   * `symbolUid`, or a stamp from a different commit all return `undefined`;
   * the caller re-resolves through GitNexus and re-caches. Never throws: a
   * store read failure degrades to "no cache entry", exactly like an absent
   * row.
   */
  async readSymbolUidCache(
    localId: string,
    graphCommit: string
  ): Promise<string | undefined> {
    try {
      const rows = await this.execute(
        `MATCH (s:Symbol {id: $id})
         RETURN s.symbolUid AS symbolUid, s.symbolUidAt AS symbolUidAt`,
        { id: localId }
      );
      const row = rows[0] as
        | { symbolUid?: unknown; symbolUidAt?: unknown }
        | undefined;
      const symbolUid =
        typeof row?.symbolUid === "string" ? row.symbolUid : "";
      const symbolUidAt =
        typeof row?.symbolUidAt === "string" ? row.symbolUidAt : "";
      if (!symbolUid || !symbolUidAt || symbolUidAt !== graphCommit) {
        return undefined;
      }
      return symbolUid;
    } catch {
      return undefined;
    }
  }

  /** Shape a raw ACTED_ON(_MODULE) row into a coordinate-only `PreEditActivity`
   *  (`state:"recent"`). Reads ONLY the aliased coordinate columns the recent query
   *  RETURNs, there is no content column on the projection to leak. */
  private recentRow(row: Row, anchorKind: "symbol" | "module"): PreEditActivity {
    const value = (key: string) => String(row[key] ?? "");
    return {
      laneId: value("laneId"),
      vendor: value("vendor"),
      taskId: value("taskId"),
      jobId: value("jobId"),
      kind: anchorKind === "symbol" ? "editing" : "running",
      anchor: value("anchor"),
      anchorKind,
      at: value("at"),
      state: "recent",
    };
  }

  /**
   * KG-8 (ADR-0014), the hero's RECENT-activity read (past tense): which OTHER task
   * recently touched the edit target's symbol/module, within a bounded window
   * (`sinceIso` floor, a lexicographic compare on the ms-UTC-Z `at`, same discipline
   * as the bitemporal as-of). Returns coordinate-only `PreEditActivity` rows with
   * `state:"recent"`, the SAME shape the live reader returns, so the hero fuses both
   * on one channel. Per task it prefers a SYMBOL collision (the finer ADR-0012
   * anchor) over a MODULE one and keeps the most-recent touch, mirroring the live
   * reader's one-row-per-peer surface. Self-exclusion (`exclude.taskId`/`.jobId`)
   * is enforced IN the query so the querying lane never sees ITSELF as recent.
   *
   * COORDINATES ONLY: every RETURNed field is an ACTED_ON edge/anchor coordinate,
   * the projection has no content column, so nothing to withhold. Degrade: empty
   * anchors / no edges → []. Anchors are the QUERYING lane's own resolved anchors,
   * so a recent touch on a non-matching anchor is never surfaced.
   */
  async recentActivityOn(
    anchors: { symbols: string[]; modules: string[] },
    sinceIso: string,
    exclude?: { taskId?: string; jobId?: string },
    /**
     * Substrate §3.1: when set, only these task ids may appear. Empty array →
     * [] (fail-closed). Null/undefined → legacy unscoped (operator / tests).
     */
    allowedTaskIds?: readonly string[] | null
  ): Promise<PreEditActivity[]> {
    if (anchors.symbols.length === 0 && anchors.modules.length === 0) {
      return [];
    }
    if (allowedTaskIds && allowedTaskIds.length === 0) {
      return [];
    }
    const excludeTask = exclude?.taskId ?? "";
    const excludeJob = exclude?.jobId ?? "";
    const allowed = allowedTaskIds ? [...allowedTaskIds] : [];
    const restrictTasks = allowed.length > 0;
    const rows: PreEditActivity[] = [];
    if (anchors.symbols.length > 0) {
      const symbolRows = await this.execute(
        `MATCH (t:TaskNode)-[e:ACTED_ON]->(s:Symbol)
         WHERE list_contains($anchors, s.id) AND e.at >= $since
           AND ($excludeTask = '' OR t.id <> $excludeTask)
           AND ($excludeJob = '' OR e.jobId <> $excludeJob)
           AND ($restrictTasks = false OR list_contains($allowedTaskIds, t.id))
         RETURN t.id AS taskId, e.laneId AS laneId, e.vendor AS vendor,
                e.jobId AS jobId, s.id AS anchor, e.at AS at
         ORDER BY e.at DESC
         LIMIT 256`,
        {
          anchors: anchors.symbols,
          since: sinceIso,
          excludeTask,
          excludeJob,
          restrictTasks,
          allowedTaskIds: allowed,
        }
      );
      for (const row of symbolRows) {
        rows.push(this.recentRow(row, "symbol"));
      }
    }
    if (anchors.modules.length > 0) {
      const moduleRows = await this.execute(
        `MATCH (t:TaskNode)-[e:ACTED_ON_MODULE]->(m:Module)
         WHERE list_contains($anchors, m.path) AND e.at >= $since
           AND ($excludeTask = '' OR t.id <> $excludeTask)
           AND ($excludeJob = '' OR e.jobId <> $excludeJob)
           AND ($restrictTasks = false OR list_contains($allowedTaskIds, t.id))
         RETURN t.id AS taskId, e.laneId AS laneId, e.vendor AS vendor,
                e.jobId AS jobId, m.path AS anchor, e.at AS at
         ORDER BY e.at DESC
         LIMIT 256`,
        {
          anchors: anchors.modules,
          since: sinceIso,
          excludeTask,
          excludeJob,
          restrictTasks,
          allowedTaskIds: allowed,
        }
      );
      for (const row of moduleRows) {
        rows.push(this.recentRow(row, "module"));
      }
    }
    // One row per task, the finest, most-recent collision: a symbol row beats a
    // module row, ties break on `at` DESC (each per-kind list is already at-desc).
    const bestByTask = new Map<string, PreEditActivity>();
    for (const row of rows) {
      const prior = bestByTask.get(row.taskId);
      if (
        !prior ||
        (row.anchorKind === "symbol" && prior.anchorKind === "module") ||
        (row.anchorKind === prior.anchorKind && row.at > prior.at)
      ) {
        bestByTask.set(row.taskId, row);
      }
    }
    return [...bestByTask.values()];
  }

  /** Mirrors an approval into the graph so gating is graph-queryable. */
  async recordApproval(input: {
    approvalId: string;
    taskId: string;
    kind: string;
    status: string;
    createdAt: string;
    decidedAt?: string | null;
  }): Promise<void> {
    await this.execute(
      `MERGE (a:ApprovalNode {id: $id})
       ON CREATE SET a.taskId = $taskId, a.kind = $kind, a.status = $status,
                     a.createdAt = $createdAt, a.decidedAt = $decidedAt
       ON MATCH SET a.status = $status, a.decidedAt = $decidedAt`,
      {
        id: input.approvalId,
        taskId: input.taskId,
        kind: input.kind,
        status: input.status,
        createdAt: input.createdAt,
        decidedAt: input.decidedAt ?? "",
      }
    );
    await this.execute(
      `MATCH (t:TaskNode {id: $taskId}), (a:ApprovalNode {id: $id})
       MERGE (t)-[:GATED_BY]->(a)`,
      { taskId: input.taskId, id: input.approvalId }
    ).catch(() => undefined);
  }

  /** Mirrors a workflow run so step membership is graph-queryable. */
  async recordWorkflowRun(input: {
    runId: string;
    templateKey?: string | null;
    status: string;
    createdAt: string;
  }): Promise<void> {
    await this.execute(
      `MERGE (w:WorkflowRunNode {id: $id})
       ON CREATE SET w.templateKey = $templateKey, w.status = $status,
                     w.createdAt = $createdAt
       ON MATCH SET w.status = $status`,
      {
        id: input.runId,
        templateKey: input.templateKey ?? "",
        status: input.status,
        createdAt: input.createdAt,
      }
    );
  }

  /** A workflow step IS a task: STEP_OF links the task to its run. */
  async linkTaskToWorkflowRun(input: {
    taskId: string;
    runId: string;
    stepKey: string;
  }): Promise<void> {
    await this.execute(
      `MATCH (t:TaskNode {id: $taskId}), (w:WorkflowRunNode {id: $runId})
       MERGE (t)-[s:STEP_OF]->(w)
       ON CREATE SET s.stepKey = $stepKey
       ON MATCH SET s.stepKey = $stepKey`,
      { taskId: input.taskId, runId: input.runId, stepKey: input.stepKey }
    );
  }

  // ---- memory notes ----

  /**
   * Best-effort dense vector for a text via the optional embedder (KG-3).
   * Returns [] when no embedder is configured, or the embed fails / yields
   * nothing, so every caller silently stays lexical (the local-first default,
   * no external service required). LOCAL-ONLY: the injected embedder is the only
   * network surface and it is loopback-only (see backend lib/embedder.ts).
   *
   * KG-3 F6c: when the host supplies an `EmbeddingCacheStore`, graph-local note
   * and query vectors use the same durable model-keyed cache as ledger ingest.
   * Any cache/model failure remains a silent lexical fallback.
   */
  private async embedText(text: string): Promise<number[]> {
    if (!this.embedder) {
      return [];
    }
    const model = this.embedder.id;
    const cached = await this.embeddingCache
      ?.get(text, model)
      .catch(() => undefined);
    if (
      cached &&
      cached.length > 0 &&
      cached.every((value) => Number.isFinite(value))
    ) {
      return cached;
    }
    if (
      this.embedder.isAvailable &&
      !(await this.embedder.isAvailable().catch(() => false))
    ) {
      return [];
    }
    try {
      const [vec] = await this.embedder.embed([text]);
      if (
        !vec ||
        vec.length === 0 ||
        !vec.every((value) => Number.isFinite(value))
      ) {
        return [];
      }
      await this.embeddingCache?.put(text, model, vec).catch(() => undefined);
      return vec;
    } catch {
      return [];
    }
  }

  async addMemoryNote(input: MemoryNoteInput): Promise<MemoryNoteRecord> {
    const now = new Date().toISOString();
    // ADR-0012 module auto-derivation (the degrade guarantee): a symbol-anchored
    // note is ALWAYS also module-anchored, union each symbol id's module prefix
    // into the module set (idempotent), so a module-precise edit still finds it.
    const symbols = [...new Set(input.symbols ?? [])];
    const modules = [
      ...new Set([...(input.modules ?? []), ...deriveModulesFromSymbols(symbols)]),
    ];
    const note: MemoryNoteRecord = {
      id: `mem-${randomUUID()}`,
      kind: input.kind,
      text: input.text,
      taskId: input.taskId ?? null,
      laneId: input.laneId ?? null,
      chatId: input.chatId ?? null,
      workspacePath: input.workspacePath ?? null,
      modules,
      topics: input.topics ?? [],
      symbols,
      trust: input.trust ?? "medium",
      confirmed: false,
      stale: false,
      status: "active",
      scope: input.scope ?? "project",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      validFrom: now,
      validTo: null,
      invalidatedAt: null,
      invalidatedBy: null,
      staleSince: null,
      supersededBy: null,
      accessCount: 0,
      lastAccessedAt: null,
      conflictsWith: null,
      // R3: the LEDGER owns TTL policy and stamps the deadline at ingest, a
      // graph-native write never expires on its own.
      expiresAt: null,
      outcome: input.outcome ?? null,
    };

    // Dense vector via the optional embedder (KG-3). Empty when dense is off →
    // inline `[]` literal (an empty typed-list PARAM is ambiguous to Ladybug),
    // a real vector goes through a bound `$embedding` param. TODO 4.4: every
    // real vector is stamped with the embedder's space id so a model switch
    // cannot cosine-compare across spaces.
    const embedding = await this.embedText(note.text);
    const embeddingSpace =
      embedding.length > 0 ? (this.embedder?.id ?? "").trim() : "";
    const hasVec = embedding.length > 0 && embeddingSpace.length > 0;
    const params: Params = {
      id: note.id,
      kind: note.kind,
      text: note.text,
      taskId: note.taskId ?? "",
      laneId: note.laneId ?? "",
      chatId: note.chatId ?? "",
      workspacePath: note.workspacePath ?? "",
      modules: note.modules,
      topics: note.topics,
      symbols: note.symbols,
      trust: note.trust,
      confirmed: note.confirmed,
      stale: note.stale,
      status: note.status,
      scope: note.scope ?? "project",
      createdBy: note.createdBy,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      validFrom: note.createdAt,
      embeddingSpace: hasVec ? embeddingSpace : "",
      outcome: note.outcome ?? "",
    };
    if (hasVec) {
      params.embedding = embedding;
    }
    await this.execute(
      `CREATE (n:MemoryNote {
        id: $id, kind: $kind, text: $text, taskId: $taskId, laneId: $laneId,
        chatId: $chatId, workspacePath: $workspacePath,
        modules: $modules, topics: $topics, symbols: $symbols, trust: $trust,
        confirmed: $confirmed, stale: $stale, status: $status, scope: $scope,
        createdBy: $createdBy, createdAt: $createdAt, updatedAt: $updatedAt,
        validFrom: $validFrom, validTo: '', invalidatedAt: '', invalidatedBy: '',
        staleSince: '', supersededBy: '',
        accessCount: 0, lastAccessedAt: '', conflictsWith: '',
        expiresAt: '',
        outcome: $outcome,
        embedding: ${hasVec ? "$embedding" : "[]"},
        embeddingSpace: $embeddingSpace
      })`,
      params
    );

    for (const path of note.modules) {
      await this.execute(
        `MERGE (m:Module {path: $path})
         ON CREATE SET m.lastTouchedAt = ''`,
        { path }
      );
      await this.execute(
        `MATCH (n:MemoryNote {id: $id}), (m:Module {path: $path})
         CREATE (n)-[:ANCHORED_TO]->(m)`,
        { id: note.id, path }
      );
    }
    // ADR-0012: the Symbol node + ABOUT_SYMBOL edge per symbol anchor, mirroring
    // the Module/ANCHORED_TO loop above (unlocks later graph traversal; the scalar
    // `n.symbols` drives cheap recall).
    await this.projectSymbolAnchors(note.id, note.symbols, "create");
    // R2: entity linking from the note's TEXT (mem0 §5.3). Best-effort by design.
    await this.projectNoteEntities(note.id, note.text, "create");
    if (note.taskId) {
      await this.execute(
        `MATCH (n:MemoryNote {id: $id}), (t:TaskNode {id: $taskId})
         CREATE (n)-[:ABOUT_TASK]->(t)`,
        { id: note.id, taskId: note.taskId }
      ).catch(() => undefined);
    }
    if (note.laneId) {
      await this.execute(
        `MATCH (n:MemoryNote {id: $id}), (l:LaneNode {id: $laneId})
         CREATE (n)-[:BY_LANE]->(l)`,
        { id: note.id, laneId: note.laneId }
      ).catch(() => undefined);
    }

    return note;
  }

  /**
   * Active notes that share an anchor with the incoming note, the dedup
   * comparison set (kept small, like Graphiti's same-entity-pair scoping).
   */
  private async anchorCandidates(input: {
    taskId?: string;
    laneId?: string;
    modules?: string[];
    topics?: string[];
  }): Promise<MemoryNoteRecord[]> {
    const clauses: string[] = [];
    const params: Params = {};
    if (input.taskId) {
      clauses.push("n.taskId = $taskId");
      params.taskId = input.taskId;
    }
    if (input.laneId) {
      clauses.push("n.laneId = $laneId");
      params.laneId = input.laneId;
    }
    (input.modules ?? []).forEach((module, i) => {
      clauses.push(`list_contains(n.modules, $m${i})`);
      params[`m${i}`] = module;
    });
    (input.topics ?? []).forEach((topic, i) => {
      clauses.push(`list_contains(n.topics, $t${i})`);
      params[`t${i}`] = topic;
    });
    if (clauses.length === 0) {
      return [];
    }
    const rows = await this.execute(
      `MATCH (n:MemoryNote)
       WHERE n.status = 'active' AND (${clauses.join(" OR ")})
       RETURN ${NOTE_RETURN}
       LIMIT 100`,
      params
    );
    return rows.map((row) => noteFromRow(row));
  }

  /**
   * Dedup-aware write (v3, mem0-inspired but human-governed): before adding a
   * note, compare it to existing anchored notes and decide ADD / duplicate /
   * supersede / conflict deterministically (docs/research/memory-graph-v3.md).
   * - duplicate: return the existing note, nothing added (NOOP).
   * - supersede: create the new note and invalidate the old (temporal history
   *   preserved via SUPERSEDES).
   * - conflict: create the new note but link it to the contradicted one and
   *   leave BOTH active, the human reconciles (never silently pick).
   * The old addMemoryNote stays as the raw insert used internally.
   */
  async ingestMemoryNote(input: MemoryNoteInput): Promise<MemoryIngestResult> {
    const candidates = await this.anchorCandidates({
      taskId: input.taskId,
      laneId: input.laneId,
      modules: input.modules,
      topics: input.topics,
    });
    const verdict = classifyIncomingNote(
      {
        kind: input.kind,
        text: input.text,
        taskId: input.taskId,
        laneId: input.laneId,
        modules: input.modules,
        topics: input.topics,
      },
      candidates
    );

    if (verdict.action === "duplicate") {
      const existing = candidates.find((n) => n.id === verdict.ofNoteId)!;
      return { note: existing, action: "duplicate", relatedNoteId: existing.id };
    }

    const note = await this.addMemoryNote(input);

    if (verdict.action === "supersede") {
      const now = new Date().toISOString();
      await this.execute(
        `MATCH (n:MemoryNote {id: $id})
         SET n.invalidatedAt = $now, n.invalidatedBy = 'superseded',
             n.supersededBy = $successorId, n.status = 'rejected',
             n.updatedAt = $now`,
        { id: verdict.ofNoteId, now, successorId: note.id }
      );
      await this.execute(
        `MATCH (a:MemoryNote {id: $successorId}), (b:MemoryNote {id: $id})
         CREATE (a)-[:SUPERSEDES]->(b)`,
        { successorId: note.id, id: verdict.ofNoteId }
      ).catch(() => undefined);
      return { note, action: "superseded", relatedNoteId: verdict.ofNoteId };
    }

    if (verdict.action === "extends") {
      await this.execute(
        `MATCH (a:MemoryNote {id: $successorId}), (b:MemoryNote {id: $id})
         CREATE (a)-[:EXTENDS]->(b)`,
        { successorId: note.id, id: verdict.ofNoteId }
      ).catch(() => undefined);
      return { note, action: "extended", relatedNoteId: verdict.ofNoteId };
    }

    if (verdict.action === "conflict") {
      // Both stay active; the note records what it contradicts so surfaces
      // can flag it for human reconciliation.
      await this.execute(
        `MATCH (n:MemoryNote {id: $id}) SET n.conflictsWith = $other`,
        { id: note.id, other: verdict.withNoteId }
      );
      return {
        note: { ...note, conflictsWith: verdict.withNoteId },
        action: "conflict",
        relatedNoteId: verdict.withNoteId,
      };
    }

    if (verdict.action === "related") {
      // KG-3 F1: a dense-only (lexically-unsupported) high-similarity match,
      // keep BOTH notes active for human reconciliation, NEVER a silent drop.
      // (This graph-local ingest passes no vectors, so this branch is defensive
      //, the durable dense path is the ledger's ingestMemoryNote.)
      return { note, action: "related", relatedNoteId: verdict.withNoteId };
    }

    return { note, action: "inserted" };
  }

  // ---- projection (ledger → graph, KG-1) ----

  /**
   * Idempotent projection of ONE ledger note into the graph (ADR-0009 Slice 1).
   * MERGE by id, the relational ledger is the source of truth and this graph is
   * a REBUILDABLE index, so re-running the projector (or a dual-write mirror)
   * never duplicates a node. The id is the ledger id, so a wipe→reproject
   * preserves note ids (recall keeps finding the same notes). A single MERGE with
   * ON CREATE/ON MATCH so a projected node is never left half-populated.
   */
  /**
   * Project the Symbol node + ABOUT_SYMBOL edge for each `<module>#<name>` anchor
   * (ADR-0012), mirroring the Module/ANCHORED_TO projection. Idempotent MERGE on
   * the node so a wipe→reproject restores it with zero duplication; `edge` is a
   * plain CREATE on the direct-insert path (brand-new node) and a MERGE on the
   * reprojection path. Best-effort per edge (a transient match failure never
   * fails the whole note projection). The scalar `n.symbols` drives recall; these
   * unlock later graph traversal ("all notes about symbols in file X").
   */
  /**
   * R2: project the `Entity` nodes + `MENTIONS` edges for one note's TEXT.
   *
   * COST IS THE POINT OF THE SHAPE. Naively this is two statements per entity —
   * up to 24 extra round-trips on a 12-entity note — which would make ingest
   * materially slower for a signal worth one round-trip at read time. A first cut
   * that batched per entity CLASS still measured +53% on the eval corpus. So both
   * the node MERGE and the edge MERGE are folded into ONE `UNWIND` statement:
   * entity linking costs exactly ONE extra write per note regardless of how many
   * entities the note carries, and ZERO for a note whose text yields none.
   *
   * On the `merge` (re-projection) path the note's existing MENTIONS are deleted
   * first, so an edited note's entity set REPLACES rather than accumulates —
   * otherwise a note whose text changed would keep matching its old entities
   * forever. Best-effort throughout: entity linking is an optional retrieval
   * accelerator and must never fail a note write.
   */
  private async projectNoteEntities(
    noteId: string,
    text: string,
    edge: "create" | "merge"
  ): Promise<void> {
    if (!this.entitiesEnabled) {
      return;
    }
    try {
      if (edge === "merge") {
        await this.execute(
          `MATCH (n:MemoryNote {id: $noteId})-[m:MENTIONS]->(:Entity) DELETE m`,
          { noteId }
        );
      }
      const entities = extractEntities(text);
      if (entities.length === 0) {
        return;
      }
      // One statement: MERGE each entity node and its edge in the same UNWIND.
      // Idempotent (MERGE on both), and entity nodes are shared across notes.
      await this.execute(
        `MATCH (n:MemoryNote {id: $noteId})
         UNWIND $keys AS key
         MERGE (e:Entity {id: key})
         MERGE (n)-[:MENTIONS]->(e)`,
        { noteId, keys: entities.map((entity) => entity.key) }
      );
    } catch {
      // Degrade to no entity edges for this note; retrieval still works.
    }
  }

  private async projectSymbolAnchors(
    noteId: string,
    symbols: string[],
    edge: "create" | "merge"
  ): Promise<void> {
    for (const id of symbols) {
      await this.execute(
        `MERGE (s:Symbol {id: $id})
         ON CREATE SET s.module = $module, s.name = $name, s.kind = '', s.symbolUid = ''`,
        { id, module: moduleOfSymbol(id), name: symbolNameOf(id) }
      );
      const link =
        edge === "create"
          ? `CREATE (n)-[:ABOUT_SYMBOL]->(s)`
          : `MERGE (n)-[:ABOUT_SYMBOL]->(s)`;
      // D6: NO LONGER SWALLOWED. Under D6 this edge is the symbol anchor's ACCESS
      // PATH — a dropped write used to cost a decoration and now costs a LOST
      // MEMORY, so it propagates to `mirrorToGraph`, which already raises a
      // coalesced `memory.graph_mirror_failed` Event. See the ANCHORED_TO loop in
      // `projectMemoryNote` for why the failure is deferred rather than immediate.
      await this.execute(
        `MATCH (n:MemoryNote {id: $noteId}), (s:Symbol {id: $id})
         ${link}`,
        { noteId, id }
      );
    }
  }

  async projectMemoryNote(
    note: MemoryNoteRecord & {
      /** Ledger-only provenance used to project the crew trust tier. Graph-native
       * callers omit it and therefore fail closed to an unvouched note. */
      confirmedBy?: "human" | "orchestrator" | null;
    },
    embedding?: number[],
    author?: PrincipalRecord,
    /** TODO 4.4: embedding SPACE id (usually `embedder.id`). Required to stamp a vector. */
    embeddingSpace?: string
  ): Promise<void> {
    // Durable facts from the ledger, projected on both create and re-projection.
    const coreSet = `n.kind = $kind, n.text = $text, n.taskId = $taskId,
        n.laneId = $laneId, n.chatId = $chatId,
        n.workspacePath = $workspacePath,
        n.modules = $modules, n.topics = $topics,
        n.symbols = $symbols,
        n.trust = $trust, n.confirmed = $confirmed,
        n.crewVouched = $crewVouched, n.status = $status,
        n.scope = $scope, n.createdBy = $createdBy, n.createdAt = $createdAt,
        n.updatedAt = $updatedAt, n.validFrom = $validFrom, n.validTo = $validTo,
        n.invalidatedAt = $invalidatedAt, n.invalidatedBy = $invalidatedBy,
        n.supersededBy = $supersededBy, n.conflictsWith = $conflictsWith,
        n.expiresAt = $expiresAt, n.outcome = $outcome`;
    // SOFT signals (reinforcement accessCount/lastUsedAt + module-touch
    // staleness) are now DURABLE in the ledger (KG-2 closes F3): reinforcement
    // flush persists accessCount/lastUsedAt and module touches persist
    // staleSince. They are restored ON CREATE, so rebuilding a fresh/wiped
    // store repopulates them from the ledger. On MATCH (a re-projection over an
    // intact store) they are left untouched: the live node already carries the
    // authoritative values and the buffered-flush owns in-flight updates.
    const softSet = `n.accessCount = $accessCount,
        n.lastAccessedAt = $lastAccessedAt, n.stale = $stale,
        n.staleSince = $staleSince`;
    // F5: when the LEDGER row is no longer stale (e.g. a human confirm cleared
    // staleSince), also clear the LIVE node's stale pair on re-projection,
    // otherwise the read path keeps demoting a confirmed note until the next
    // wipe. Deliberately NARROW: accessCount/lastAccessedAt are NOT overwritten
    // on match (that would clobber accrued reinforcement); only the stale pair
    // is cleared, and only when the incoming ledger row is fresh.
    const clearStaleOnMatch =
      note.staleSince == null && !note.stale
        ? `, n.stale = false, n.staleSince = ''`
        : ``;
    // Dense tier (KG-3 + TODO 4.4): the vector is supplied by the ledger
    // (computed once at ingest, cached in EmbeddingCache, restored from that
    // cache on reproject, NEVER recomputed here). A real vector MUST carry an
    // EXPLICIT space id from the caller — we deliberately do NOT fall back to
    // `this.embedder.id`, which would quietly claim an unknown-origin vector
    // lives in the live space (the exact class of bug the stamp exists to
    // prevent). Without a space, refuse the vector and stay lexical. ON CREATE
    // seeds embedding + embeddingSpace; ON MATCH only overwrites when both
    // are provided, so a bare re-projection never clobbers either with [].
    const space = (embeddingSpace ?? "").trim();
    const hasVec =
      Array.isArray(embedding) && embedding.length > 0 && space.length > 0;
    const embOnCreate = hasVec ? "$embedding" : "[]";
    const embOnMatch = hasVec
      ? ", n.embedding = $embedding, n.embeddingSpace = $embeddingSpace"
      : "";
    // Defensive `?? []`: a hand-built or pre-0012 MemoryNoteRecord may omit
    // symbols/modules at runtime, degrade to no anchors rather than crash.
    const noteSymbols = note.symbols ?? [];
    const params: Params = {
      id: note.id,
      kind: note.kind,
      text: note.text,
      taskId: note.taskId ?? "",
      laneId: note.laneId ?? "",
      chatId: note.chatId ?? "",
      workspacePath: note.workspacePath ?? "",
      modules: note.modules ?? [],
      topics: note.topics ?? [],
      symbols: noteSymbols,
      trust: note.trust,
      confirmed: note.confirmed,
      crewVouched: note.confirmedBy === "orchestrator",
      stale: note.stale,
      status: note.status,
      scope: note.scope ?? "project",
      createdBy: note.createdBy,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      validFrom: note.validFrom,
      validTo: note.validTo ?? "",
      invalidatedAt: note.invalidatedAt ?? "",
      invalidatedBy: note.invalidatedBy ?? "",
      staleSince: note.staleSince ?? "",
      supersededBy: note.supersededBy ?? "",
      accessCount: note.accessCount,
      lastAccessedAt: note.lastAccessedAt ?? "",
      conflictsWith: note.conflictsWith ?? "",
      // R3: the ledger's TTL deadline is DURABLE there and projected on BOTH
      // create and re-projection (part of coreSet), so a wipe → reproject restores
      // it and cannot silently resurrect every expired note. Canonicalized to
      // ms-UTC-Z because the read clause compares it lexicographically against
      // $now; an unreadable value degrades to '' (never expires), never to a
      // deadline the comparison would get wrong.
      expiresAt: normalizeInstant(note.expiresAt ?? "") ?? "",
      outcome: note.outcome ?? "",
      // Always bind: ON CREATE seeds '' when dense is off; ON MATCH only
      // overwrites when hasVec (via embOnMatch).
      embeddingSpace: hasVec ? space : "",
    };
    if (hasVec) {
      params.embedding = embedding as number[];
    }
    await this.execute(
      `MERGE (n:MemoryNote {id: $id})
       ON CREATE SET n.embedding = ${embOnCreate}, n.embeddingSpace = $embeddingSpace, ${coreSet}, ${softSet}
       ON MATCH SET ${coreSet}${clearStaleOnMatch}${embOnMatch}`,
      params
    );

    // D6: the ANCHORED_TO write is NO LONGER SWALLOWED.
    //
    // Before D6 this edge was decoration — recall read `n.modules` — so a dropped
    // write was invisible and cost nothing. D6 makes the edge the ACCESS PATH for
    // every anchored read, which turns the same dropped write into a LOST MEMORY:
    // the note keeps its `modules` array, the reconciler will notice, but until it
    // runs the gate simply does not see the note. So the failure must be loud.
    //
    // It is SURFACED, not reported here: the error propagates out of
    // `projectMemoryNote` into `mirrorToGraph`, which already logs a line and
    // raises a coalesced `memory.graph_mirror_failed` Event
    // (`backend/src/lib/graph.ts`). Deliberately NOT a second reporting
    // convention — one degraded-projection signal, and the operator surfaces that
    // read the event log already show it.
    //
    // DEFERRED to the end of the loop rather than thrown at once, so one bad
    // anchor cannot cost the note its remaining anchors, its symbol edges, its
    // entity links or its provenance. The message carries COUNTS and the driver
    // reason ONLY — no note id, no path, nothing content-bearing — matching
    // `reportMirrorFailure`'s own coordinates-only contract.
    const notePaths = note.modules ?? [];
    let anchorEdgeFailures = 0;
    let firstAnchorEdgeError: unknown;
    for (const path of notePaths) {
      await this.execute(
        `MERGE (m:Module {path: $path}) ON CREATE SET m.lastTouchedAt = ''`,
        { path }
      );
      try {
        await this.execute(
          `MATCH (n:MemoryNote {id: $id}), (m:Module {path: $path})
           MERGE (n)-[:ANCHORED_TO]->(m)`,
          { id: note.id, path }
        );
      } catch (error) {
        anchorEdgeFailures += 1;
        firstAnchorEdgeError ??= error;
      }
    }
    // ADR-0012: restore the Symbol node + ABOUT_SYMBOL edge per anchor on every
    // reprojection (wipe-survivable, the symbols live on the ledger note column).
    await this.projectSymbolAnchors(note.id, noteSymbols, "merge");
    // R2: rebuild the entity links from the ledger's text on every reprojection,
    // so a wipe→reproject restores them and an edited note replaces (not
    // accumulates) its entity set.
    await this.projectNoteEntities(note.id, note.text, "merge");
    if (note.taskId) {
      await this.execute(
        `MATCH (n:MemoryNote {id: $id}), (t:TaskNode {id: $taskId})
         MERGE (n)-[:ABOUT_TASK]->(t)`,
        { id: note.id, taskId: note.taskId }
      ).catch(() => undefined);
    }
    if (note.laneId) {
      await this.execute(
        `MATCH (n:MemoryNote {id: $id}), (l:LaneNode {id: $laneId})
         MERGE (n)-[:BY_LANE]->(l)`,
        { id: note.id, laneId: note.laneId }
      ).catch(() => undefined);
    }
    // Provenance (KG-5): project the authoring principal node + AUTHORED_BY edge
    // so the note→author link rebuilds from the ledger on every reprojection.
    if (author) {
      await this.projectPrincipal(author);
      await this.projectAuthoredBy(note.id, author.id);
    }
    // D6: the deferred anchor-edge failure, raised LAST so everything above it
    // still landed. Counts only — see the loop's comment.
    if (anchorEdgeFailures > 0) {
      const reason =
        firstAnchorEdgeError instanceof Error
          ? firstAnchorEdgeError.message
          : String(firstAnchorEdgeError);
      throw new Error(
        `anchor edge projection failed for ${anchorEdgeFailures} of ${notePaths.length} module anchor(s): ${reason}`
      );
    }
  }

  /**
   * D6's COMPLETENESS RECONCILER — the price of making the anchor edge the access
   * path, paid in the decision's stated order of preference (mitigation 1).
   *
   * THE INVARIANT: `count(ANCHORED_TO) == Σ size(n.modules)` and
   * `count(ABOUT_SYMBOL) == Σ size(n.symbols)`, with zero divergence in either
   * direction. `n.modules`/`n.symbols` remain the AUTHORITY (projected from the
   * durable ledger); the edges are the ACCESS PATH, so an edge the array does not
   * justify is as wrong as an array entry with no edge. Measured on the live brain
   * before this landed: 37 == 37 and 0 == 0 both ways, so the invariant already
   * held and could be pinned BEFORE anything depended on it.
   *
   * CHEAP WHEN HEALTHY. The check is four scalar queries (the two counts plus the
   * two divergence counts from memory-index-validation.md §1.3 row 23); it only
   * materializes note→anchor pairs when one of those four numbers disagrees. That
   * is what lets it run on EVERY boot (at the tail of `projectLedgerToGraph`,
   * right after the projector wrote every edge) as well as on demand
   * (`POST /api/memory/reconcile-anchors`).
   *
   * `repair` REPROJECTS rather than patches: for each divergent note it drops that
   * note's anchor edges and rebuilds them from the note's own arrays. It can
   * therefore only ever make the edge set agree with the authority — never invent
   * an anchor, never touch a note's arrays, and never touch the ledger.
   */
  async reconcileAnchorEdges(opts?: { repair?: boolean }): Promise<{
    modules: { edges: number; expected: number; notesMissingEdges: number; orphanEdges: number };
    symbols: { edges: number; expected: number; notesMissingEdges: number; orphanEdges: number };
    complete: boolean;
    repairedNotes: number;
  }> {
    const scalar = async (statement: string): Promise<number> => {
      const rows = await this.execute(statement, {});
      const value = rows[0]?.c;
      // A `sum()` over zero rows is NULL, not 0 — coerced here rather than at
      // three call sites, because `Number(null)` is 0 and `Number(undefined)` is
      // NaN, and a NaN would make every comparison below read as a mismatch.
      return typeof value === "number" || typeof value === "bigint"
        ? Number(value)
        : 0;
    };
    const [
      moduleEdges,
      moduleExpected,
      moduleNotesMissing,
      moduleOrphans,
      symbolEdges,
      symbolExpected,
      symbolNotesMissing,
      symbolOrphans,
    ] = await Promise.all([
      scalar(`MATCH ()-[r:ANCHORED_TO]->() RETURN count(r) AS c`),
      scalar(`MATCH (n:MemoryNote) RETURN sum(size(n.modules)) AS c`),
      scalar(
        `MATCH (n:MemoryNote) WHERE size(n.modules) > 0
           AND NOT EXISTS { MATCH (n)-[:ANCHORED_TO]->(:Module) }
         RETURN count(n) AS c`
      ),
      scalar(
        `MATCH (n:MemoryNote)-[:ANCHORED_TO]->(m:Module)
         WHERE NOT list_contains(n.modules, m.path)
         RETURN count(n) AS c`
      ),
      scalar(`MATCH ()-[r:ABOUT_SYMBOL]->() RETURN count(r) AS c`),
      scalar(`MATCH (n:MemoryNote) RETURN sum(size(n.symbols)) AS c`),
      scalar(
        `MATCH (n:MemoryNote) WHERE size(n.symbols) > 0
           AND NOT EXISTS { MATCH (n)-[:ABOUT_SYMBOL]->(:Symbol) }
         RETURN count(n) AS c`
      ),
      scalar(
        `MATCH (n:MemoryNote)-[:ABOUT_SYMBOL]->(s:Symbol)
         WHERE NOT list_contains(n.symbols, s.id)
         RETURN count(n) AS c`
      ),
    ]);
    const report = {
      modules: {
        edges: moduleEdges,
        expected: moduleExpected,
        notesMissingEdges: moduleNotesMissing,
        orphanEdges: moduleOrphans,
      },
      symbols: {
        edges: symbolEdges,
        expected: symbolExpected,
        notesMissingEdges: symbolNotesMissing,
        orphanEdges: symbolOrphans,
      },
      complete:
        moduleEdges === moduleExpected &&
        symbolEdges === symbolExpected &&
        moduleNotesMissing === 0 &&
        moduleOrphans === 0 &&
        symbolNotesMissing === 0 &&
        symbolOrphans === 0,
      repairedNotes: 0,
    };
    if (report.complete || !opts?.repair) {
      return report;
    }
    report.repairedNotes = await this.reprojectDivergentAnchorEdges();
    return report;
  }

  /**
   * The repair half of `reconcileAnchorEdges`. Materializes note→anchor pairs
   * ONLY on the mismatch path (see that method), finds every note whose edge set
   * disagrees with its own arrays in EITHER direction, and reprojects that note's
   * anchor edges from the arrays.
   *
   * Returns the number of notes reprojected. Per-note failures are counted, not
   * thrown: this runs at the tail of boot and on an operator's explicit request,
   * and a store that cannot take one repair write must still report the other
   * numbers rather than aborting the reconcile that found them.
   */
  private async reprojectDivergentAnchorEdges(): Promise<number> {
    const [moduleEdgeRows, moduleArrayRows, symbolEdgeRows, symbolArrayRows] =
      await Promise.all([
        this.execute(
          `MATCH (n:MemoryNote)-[:ANCHORED_TO]->(m:Module)
           RETURN n.id AS id, m.path AS value`,
          {}
        ),
        this.execute(
          `MATCH (n:MemoryNote) WHERE size(n.modules) > 0
           RETURN n.id AS id, n.modules AS values`,
          {}
        ),
        this.execute(
          `MATCH (n:MemoryNote)-[:ABOUT_SYMBOL]->(s:Symbol)
           RETURN n.id AS id, s.id AS value`,
          {}
        ),
        this.execute(
          `MATCH (n:MemoryNote) WHERE size(n.symbols) > 0
           RETURN n.id AS id, n.symbols AS values`,
          {}
        ),
      ]);
    const divergent = (
      edgeRows: Row[],
      arrayRows: Row[]
    ): Map<string, string[]> => {
      const edgesByNote = new Map<string, Set<string>>();
      for (const row of edgeRows) {
        const id = String(row.id ?? "");
        const value = String(row.value ?? "");
        const set = edgesByNote.get(id) ?? new Set<string>();
        set.add(value);
        edgesByNote.set(id, set);
      }
      const wanted = new Map<string, string[]>();
      for (const row of arrayRows) {
        const id = String(row.id ?? "");
        const values = Array.isArray(row.values)
          ? [...new Set(row.values.map((value) => String(value)))]
          : [];
        wanted.set(id, values);
      }
      const out = new Map<string, string[]>();
      for (const [id, values] of wanted) {
        const edges = edgesByNote.get(id) ?? new Set<string>();
        if (values.length !== edges.size || values.some((v) => !edges.has(v))) {
          out.set(id, values);
        }
      }
      // The other direction: an edge on a note whose array is EMPTY (so the note
      // never appeared in `wanted` at all). Reprojecting it to the empty array is
      // the correct repair — the array is the authority.
      for (const [id, edges] of edgesByNote) {
        if (!wanted.has(id) && edges.size > 0) {
          out.set(id, []);
        }
      }
      return out;
    };
    const moduleFixes = divergent(moduleEdgeRows, moduleArrayRows);
    const symbolFixes = divergent(symbolEdgeRows, symbolArrayRows);
    const repaired = new Set<string>();
    for (const [noteId, modules] of moduleFixes) {
      try {
        await this.execute(
          `MATCH (n:MemoryNote {id: $noteId})-[r:ANCHORED_TO]->(:Module) DELETE r`,
          { noteId }
        );
        if (modules.length > 0) {
          // One statement for the node and the edge, the shape
          // `projectNoteEntities` already uses for exactly this reason.
          await this.execute(
            `MATCH (n:MemoryNote {id: $noteId})
             UNWIND $paths AS path
             MERGE (m:Module {path: path})
             MERGE (n)-[:ANCHORED_TO]->(m)`,
            { noteId, paths: modules }
          );
        }
        repaired.add(noteId);
      } catch {
        // Counted by omission: the note stays divergent and the next reconcile
        // (boot, or the operator route) reports it again.
      }
    }
    for (const [noteId, symbols] of symbolFixes) {
      try {
        await this.execute(
          `MATCH (n:MemoryNote {id: $noteId})-[r:ABOUT_SYMBOL]->(:Symbol) DELETE r`,
          { noteId }
        );
        if (symbols.length > 0) {
          // Delegated, not restated: the Symbol node carries a derived
          // module/name split that only `projectSymbolAnchors` knows how to set.
          await this.projectSymbolAnchors(noteId, symbols, "merge");
        }
        repaired.add(noteId);
      } catch {
        // See above.
      }
    }
    return repaired.size;
  }

  /**
   * Idempotent projection of a provenance Principal (KG-5). MERGE by id, the
   * relational Principal table is the source of truth and this node is a
   * rebuildable projection, so re-running never duplicates. A note's author
   * principal carries the authoritative trust the reranker (and KG-6's governed
   * writes) key on, so it is set on both create and match.
   */
  async projectPrincipal(principal: PrincipalRecord): Promise<void> {
    await this.execute(
      `MERGE (p:Principal {id: $id})
       ON CREATE SET p.kind = $kind, p.displayName = $displayName,
                     p.vendor = $vendor, p.trust = $trust, p.createdAt = $createdAt
       ON MATCH SET p.kind = $kind, p.displayName = $displayName,
                    p.vendor = $vendor, p.trust = $trust`,
      {
        id: principal.id,
        kind: principal.kind,
        displayName: principal.displayName,
        vendor: principal.vendor ?? "",
        trust: principal.trust,
        createdAt: principal.createdAt,
      }
    );
  }

  /** Idempotent AUTHORED_BY edge (note→principal). Best-effort on missing nodes. */
  async projectAuthoredBy(noteId: string, principalId: string): Promise<void> {
    await this.execute(
      `MATCH (n:MemoryNote {id: $noteId}), (p:Principal {id: $principalId})
       MERGE (n)-[:AUTHORED_BY]->(p)`,
      { noteId, principalId }
    ).catch(() => undefined);
  }

  /** Idempotent CONFIRMED_BY edge (note→confirming principal). Sourced from the
   *  append-only Confirmation ledger rows. Best-effort on missing nodes. */
  async projectConfirmedBy(noteId: string, principalId: string): Promise<void> {
    await this.execute(
      `MATCH (n:MemoryNote {id: $noteId}), (p:Principal {id: $principalId})
       MERGE (n)-[:CONFIRMED_BY]->(p)`,
      { noteId, principalId }
    ).catch(() => undefined);
  }

  /** Principal ids that AUTHORED a note (provenance read, KG-5/KG-6). */
  async authorsOf(noteId: string): Promise<string[]> {
    const rows = await this.execute(
      `MATCH (n:MemoryNote {id: $noteId})-[:AUTHORED_BY]->(p:Principal)
       RETURN p.id AS id`,
      { noteId }
    );
    return rows.map((row) => String(row.id ?? row["p.id"]));
  }

  /** Principal ids that CONFIRMED a note (provenance read, KG-5/KG-6). */
  async confirmersOf(noteId: string): Promise<string[]> {
    const rows = await this.execute(
      `MATCH (n:MemoryNote {id: $noteId})-[:CONFIRMED_BY]->(p:Principal)
       RETURN p.id AS id`,
      { noteId }
    );
    return rows.map((row) => String(row.id ?? row["p.id"]));
  }

  /** Note ids this note CONTRADICTS (both stay active; human reconciles, KG-5). */
  async contradictionsOf(noteId: string): Promise<string[]> {
    const rows = await this.execute(
      `MATCH (n:MemoryNote {id: $noteId})-[:CONTRADICTS]->(m:MemoryNote)
       RETURN m.id AS id`,
      { noteId }
    );
    return rows.map((row) => String(row.id ?? row["m.id"]));
  }

  /** Read a projected Principal node (tests / introspection). */
  async getPrincipal(id: string): Promise<PrincipalRecord | null> {
    const rows = await this.execute(
      `MATCH (p:Principal {id: $id})
       RETURN p.id, p.kind, p.displayName, p.vendor, p.trust, p.createdAt`,
      { id }
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const v = (key: string) => row[`p.${key}`] ?? row[key];
    return {
      id: String(v("id")),
      kind: String(v("kind")) as PrincipalRecord["kind"],
      displayName: String(v("displayName")),
      vendor: (v("vendor") as string) || null,
      trust: String(v("trust")) as MemoryTrust,
      createdAt: String(v("createdAt")),
    };
  }

  /**
   * B1/B2 bounded-surface serializer. This is the ONLY place traversal nodes
   * acquire fields, so text gating is complete by construction rather than a
   * caller-by-caller redaction pass. Free-form task/approval/principal/lane
   * fields are never selected from the graph at all.
   */
  private async memoryTraversalNode(
    ref: MemoryTraversalRef,
    options: Pick<
      MemoryNeighborsOptions,
      "chatId" | "workspacePath" | "unscopedWorkspace" | "crewVisible"
    >
  ): Promise<MemoryGraphNode | null> {
    const entityId = safeMemoryTraversalCoordinate(ref.entityId);
    if (!entityId) {
      return null;
    }
    const id = memoryTraversalId({ ...ref, entityId });
    if (ref.type === "note") {
      const note = await this.getMemoryNote(entityId);
      if (!note) {
        return null;
      }
      // ADR-0026: the WORKSPACE fence, checked BEFORE the chat clause and therefore
      // outside its `scope:"global"` admission — a promoted global note crosses
      // MISSIONS, never REPOS (§6). A provenance walk is a read: a foreign-workspace
      // note reveals not just its coordinates but its EXISTENCE, so it is dropped
      // entirely here rather than degraded to coordinates-only the way an expired
      // note is. Expiry is recall hygiene; this is a partition.
      if (options.unscopedWorkspace) {
        if ((note.workspacePath ?? "") !== "") {
          return null;
        }
      } else if (
        options.workspacePath &&
        (note.workspacePath ?? "") !== options.workspacePath
      ) {
        return null;
      }
      // #126 + B6: a chat-scoped traversal sees its own partition plus a
      // deliberately promoted, human-confirmed global note. Ordinary cross-chat,
      // NULL-chat, and unconfirmed-global notes reveal no coordinates.
      if (
        options.chatId &&
        (note.chatId ?? "") !== options.chatId &&
        !((note.scope ?? "project") === "global" && note.confirmed)
      ) {
        return null;
      }
      // R3 on the TRAVERSAL surfaces: an expired note is never REMOVED here (that
      // would break the very path the caller asked to be explained) — its `text`
      // is withheld and it degrades to coordinates-only, the same treatment an
      // ungoverned note already gets. Completeness is the point: the crew-visible
      // tier can carry an UNCONFIRMED agent note's verbatim text, and a TTL that
      // covered recall but left that text reachable one hop away would be a
      // bounded surface with a hole. Mirrors `redactExpiredNodes` in
      // backend/src/routes/memory.ts. (A confirmed note can never be expired, so
      // this only ever narrows the crew-visible branch.)
      // Model-mined notes are NOT narrowed here. They are agent memory, so the
      // one operator posture that decides whether unconfirmed agent memory
      // reaches the crew (`autoConfirmAgentMemory` → `options.crewVisible`)
      // decides for them too: ON and same-chat → text, OFF → confirmed-only.
      // A mined-only exception at this one surface would be a second posture
      // nobody can read off the toggle.
      // The predicate below IS `MEMORY_TRAVERSAL_TEXT_POLICY`, which the
      // provenance block reports verbatim — the label and the rule are edited
      // together or the label is a lie (it was one until this pair was named).
      const textVisible =
        note.status === "active" &&
        !isMemoryNoteExpired(note) &&
        (note.confirmed ||
          Boolean(
            options.crewVisible &&
              options.chatId &&
              (note.chatId ?? "") === options.chatId
          ));
      return {
        id,
        entityId: note.id,
        type: "note",
        kind: note.kind,
        trust: note.trust,
        confirmed: note.confirmed,
        status: note.status,
        ...(textVisible
          ? {
              text: note.text.slice(0, MEMORY_TRAVERSAL_TEXT_LIMIT),
              textTruncated: note.text.length > MEMORY_TRAVERSAL_TEXT_LIMIT,
            }
          : {}),
      };
    }
    if (ref.type === "principal") {
      const principal = await this.getPrincipal(entityId);
      return principal
        ? {
            id,
            entityId: principal.id,
            type: "principal",
            kind: principal.kind,
            trust: principal.trust,
            ...(safeMemoryTraversalCoordinate(principal.vendor)
              ? { vendor: principal.vendor }
              : {}),
          }
        : null;
    }
    if (ref.type === "module") {
      const rows = await this.execute(
        `MATCH (m:Module {path: $id}) RETURN m.path AS entityId`,
        { id: entityId }
      );
      return rows[0]
        ? { id, entityId: String(rows[0].entityId), type: "module" }
        : null;
    }
    if (ref.type === "symbol") {
      const rows = await this.execute(
        `MATCH (s:Symbol {id: $id})
         RETURN s.id AS entityId, s.module AS module, s.name AS name,
                s.kind AS kind`,
        { id: entityId }
      );
      const row = rows[0];
      return row
        ? {
            id,
            entityId: String(row.entityId),
            type: "symbol",
            ...(safeMemoryTraversalCoordinate(row.module)
              ? { module: String(row.module) }
              : {}),
            ...(safeMemoryTraversalCoordinate(row.name)
              ? { name: String(row.name) }
              : {}),
            ...(safeMemoryTraversalCoordinate(row.kind)
              ? { kind: String(row.kind) }
              : {}),
          }
        : null;
    }
    if (ref.type === "task") {
      const rows = await this.execute(
        `MATCH (t:TaskNode {id: $id})
         RETURN t.id AS entityId, t.status AS status`,
        { id: entityId }
      );
      const row = rows[0];
      return row
        ? {
            id,
            entityId: String(row.entityId),
            type: "task",
            ...(safeMemoryTraversalCoordinate(row.status)
              ? { status: String(row.status) }
              : {}),
          }
        : null;
    }
    if (ref.type === "lane") {
      const rows = await this.execute(
        `MATCH (l:LaneNode {id: $id})
         RETURN l.id AS entityId, l.laneKey AS vendor`,
        { id: entityId }
      );
      const row = rows[0];
      return row
        ? {
            id,
            entityId: String(row.entityId),
            type: "lane",
            ...(safeMemoryTraversalCoordinate(row.vendor)
              ? { vendor: String(row.vendor) }
              : {}),
          }
        : null;
    }
    const rows = await this.execute(
      `MATCH (a:ApprovalNode {id: $id})
       RETURN a.id AS entityId, a.kind AS kind, a.status AS status`,
      { id: entityId }
    );
    const row = rows[0];
    return row
      ? {
          id,
          entityId: String(row.entityId),
          type: "approval",
          ...(safeMemoryTraversalCoordinate(row.kind)
            ? { kind: String(row.kind) }
            : {}),
          ...(safeMemoryTraversalCoordinate(row.status)
            ? { status: String(row.status) }
            : {}),
        }
      : null;
  }

  /** One safe graph hop. Every relationship name below is a fixed literal;
   * `relFilter` only decides which branch runs and is never interpolated. */
  private async memoryTraversalNeighbors(
    ref: MemoryTraversalRef,
    allowed: ReadonlySet<MemoryGraphRelation>
  ): Promise<MemoryTraversalStep[]> {
    const current = memoryTraversalId(ref);
    const steps: MemoryTraversalStep[] = [];
    const connect = async (
      relation: MemoryGraphRelation,
      neighborType: MemoryGraphNodeType,
      direction: "out" | "in",
      statement: string
    ) => {
      if (!allowed.has(relation)) {
        return;
      }
      const rows = await this.execute(statement, { id: ref.entityId });
      for (const row of rows) {
        const entityId = String(row.entityId ?? "");
        if (!entityId) {
          continue;
        }
        const node = { type: neighborType, entityId };
        const neighbor = memoryTraversalId(node);
        steps.push({
          node,
          edge:
            direction === "out"
              ? { from: current, to: neighbor, relation }
              : { from: neighbor, to: current, relation },
        });
      }
    };

    if (ref.type === "note") {
      await connect(
        "SUPERSEDES",
        "note",
        "out",
        `MATCH (a:MemoryNote {id: $id})-[:SUPERSEDES]->(b:MemoryNote)
         RETURN b.id AS entityId ORDER BY b.id`
      );
      await connect(
        "SUPERSEDES",
        "note",
        "in",
        `MATCH (a:MemoryNote)-[:SUPERSEDES]->(b:MemoryNote {id: $id})
         RETURN a.id AS entityId ORDER BY a.id`
      );
      await connect(
        "EXTENDS",
        "note",
        "out",
        `MATCH (a:MemoryNote {id: $id})-[:EXTENDS]->(b:MemoryNote)
         RETURN b.id AS entityId ORDER BY b.id`
      );
      await connect(
        "EXTENDS",
        "note",
        "in",
        `MATCH (a:MemoryNote)-[:EXTENDS]->(b:MemoryNote {id: $id})
         RETURN a.id AS entityId ORDER BY a.id`
      );
      await connect(
        "CONTRADICTS",
        "note",
        "out",
        `MATCH (a:MemoryNote {id: $id})-[:CONTRADICTS]->(b:MemoryNote)
         RETURN b.id AS entityId ORDER BY b.id`
      );
      await connect(
        "CONTRADICTS",
        "note",
        "in",
        `MATCH (a:MemoryNote)-[:CONTRADICTS]->(b:MemoryNote {id: $id})
         RETURN a.id AS entityId ORDER BY a.id`
      );
      await connect(
        "AUTHORED_BY",
        "principal",
        "out",
        `MATCH (n:MemoryNote {id: $id})-[:AUTHORED_BY]->(p:Principal)
         RETURN p.id AS entityId ORDER BY p.id`
      );
      await connect(
        "CONFIRMED_BY",
        "principal",
        "out",
        `MATCH (n:MemoryNote {id: $id})-[:CONFIRMED_BY]->(p:Principal)
         RETURN p.id AS entityId ORDER BY p.id`
      );
      await connect(
        "ANCHORED_TO",
        "module",
        "out",
        `MATCH (n:MemoryNote {id: $id})-[:ANCHORED_TO]->(m:Module)
         RETURN m.path AS entityId ORDER BY m.path`
      );
      await connect(
        "ABOUT_SYMBOL",
        "symbol",
        "out",
        `MATCH (n:MemoryNote {id: $id})-[:ABOUT_SYMBOL]->(s:Symbol)
         RETURN s.id AS entityId ORDER BY s.id`
      );
      await connect(
        "ABOUT_TASK",
        "task",
        "out",
        `MATCH (n:MemoryNote {id: $id})-[:ABOUT_TASK]->(t:TaskNode)
         RETURN t.id AS entityId ORDER BY t.id`
      );
      await connect(
        "BY_LANE",
        "lane",
        "out",
        `MATCH (n:MemoryNote {id: $id})-[:BY_LANE]->(l:LaneNode)
         RETURN l.id AS entityId ORDER BY l.id`
      );
      await connect(
        "CLONED_FROM",
        "note",
        "out",
        `MATCH (a:MemoryNote {id: $id})-[:CLONED_FROM]->(b:MemoryNote)
         RETURN b.id AS entityId ORDER BY b.id`
      );
      await connect(
        "CLONED_FROM",
        "note",
        "in",
        `MATCH (a:MemoryNote)-[:CLONED_FROM]->(b:MemoryNote {id: $id})
         RETURN a.id AS entityId ORDER BY a.id`
      );
    } else if (ref.type === "principal") {
      await connect(
        "AUTHORED_BY",
        "note",
        "in",
        `MATCH (n:MemoryNote)-[:AUTHORED_BY]->(p:Principal {id: $id})
         RETURN n.id AS entityId ORDER BY n.id`
      );
      await connect(
        "CONFIRMED_BY",
        "note",
        "in",
        `MATCH (n:MemoryNote)-[:CONFIRMED_BY]->(p:Principal {id: $id})
         RETURN n.id AS entityId ORDER BY n.id`
      );
    } else if (ref.type === "module") {
      await connect(
        "ANCHORED_TO",
        "note",
        "in",
        `MATCH (n:MemoryNote)-[:ANCHORED_TO]->(m:Module {path: $id})
         RETURN n.id AS entityId ORDER BY n.id`
      );
      await connect(
        "TOUCHED",
        "task",
        "in",
        `MATCH (t:TaskNode)-[:TOUCHED]->(m:Module {path: $id})
         RETURN t.id AS entityId ORDER BY t.id`
      );
    } else if (ref.type === "symbol") {
      await connect(
        "ABOUT_SYMBOL",
        "note",
        "in",
        `MATCH (n:MemoryNote)-[:ABOUT_SYMBOL]->(s:Symbol {id: $id})
         RETURN n.id AS entityId ORDER BY n.id`
      );
    } else if (ref.type === "task") {
      await connect(
        "ABOUT_TASK",
        "note",
        "in",
        `MATCH (n:MemoryNote)-[:ABOUT_TASK]->(t:TaskNode {id: $id})
         RETURN n.id AS entityId ORDER BY n.id`
      );
      await connect(
        "TOUCHED",
        "module",
        "out",
        `MATCH (t:TaskNode {id: $id})-[:TOUCHED]->(m:Module)
         RETURN m.path AS entityId ORDER BY m.path`
      );
      await connect(
        "GATED_BY",
        "approval",
        "out",
        `MATCH (t:TaskNode {id: $id})-[:GATED_BY]->(a:ApprovalNode)
         RETURN a.id AS entityId ORDER BY a.id`
      );
      await connect(
        "WORKED_ON",
        "lane",
        "in",
        `MATCH (l:LaneNode)-[:WORKED_ON]->(t:TaskNode {id: $id})
         RETURN l.id AS entityId ORDER BY l.id`
      );
    } else if (ref.type === "lane") {
      await connect(
        "BY_LANE",
        "note",
        "in",
        `MATCH (n:MemoryNote)-[:BY_LANE]->(l:LaneNode {id: $id})
         RETURN n.id AS entityId ORDER BY n.id`
      );
      await connect(
        "WORKED_ON",
        "task",
        "out",
        `MATCH (l:LaneNode {id: $id})-[:WORKED_ON]->(t:TaskNode)
         RETURN t.id AS entityId ORDER BY t.id`
      );
    } else if (ref.type === "approval") {
      await connect(
        "GATED_BY",
        "task",
        "in",
        `MATCH (t:TaskNode)-[:GATED_BY]->(a:ApprovalNode {id: $id})
         RETURN t.id AS entityId ORDER BY t.id`
      );
    }
    return steps;
  }

  private async traverseMemoryGraph(
    rootId: string,
    options: MemoryNeighborsOptions,
    maximumHops: number
  ): Promise<MemoryTraversalResult> {
    const hops = Math.max(
      0,
      Math.min(maximumHops, Math.trunc(options.hops ?? 1))
    );
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 40)));
    const relations = [
      ...new Set(
        (options.relFilter ?? DEFAULT_MEMORY_GRAPH_RELATIONS).filter((relation) =>
          ALLOWED_MEMORY_GRAPH_RELATIONS.includes(relation)
        )
      ),
    ];
    const allowed = new Set(relations);
    const parsedRoot = parseMemoryTraversalId(rootId);
    const rootCoordinate = safeMemoryTraversalCoordinate(parsedRoot.entityId);
    const rootRef: MemoryTraversalRef = {
      type: parsedRoot.type,
      entityId: rootCoordinate ?? "invalid",
    };
    const root = memoryTraversalId(rootRef);
    const nodes = new Map<string, MemoryGraphNode>();
    const edges = new Map<string, MemoryGraphEdge>();
    const depths = new Map<string, number>();
    let truncated = false;

    const rootNode = rootCoordinate
      ? await this.memoryTraversalNode(rootRef, options)
      : null;
    if (!rootNode) {
      return {
        nodes: [],
        edges: [],
        provenance: {
          root,
          hops,
          relations,
          truncated: false,
          textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
        },
        depths,
      };
    }

    nodes.set(root, rootNode);
    depths.set(root, 0);
    const queue: Array<{ ref: MemoryTraversalRef; depth: number }> = [
      { ref: rootRef, depth: 0 },
    ];
    const edgeLimit = limit * 4;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= hops) {
        continue;
      }
      const steps = await this.memoryTraversalNeighbors(current.ref, allowed);
      for (const step of steps) {
        const nextId = memoryTraversalId(step.node);
        let nextNode = nodes.get(nextId);
        const isNew = !nextNode;
        if (isNew) {
          if (nodes.size >= limit) {
            truncated = true;
            continue;
          }
          const loadedNode = await this.memoryTraversalNode(step.node, options);
          if (!loadedNode) {
            continue;
          }
          nextNode = loadedNode;
          nodes.set(nextId, nextNode);
          depths.set(nextId, current.depth + 1);
          queue.push({ ref: step.node, depth: current.depth + 1 });
        }
        const edgeKey = `${step.edge.relation}:${step.edge.from}->${step.edge.to}`;
        if (!edges.has(edgeKey)) {
          if (edges.size >= edgeLimit) {
            truncated = true;
            continue;
          }
          edges.set(edgeKey, step.edge);
        }
      }
    }

    return {
      nodes: [...nodes.values()].sort(
        (left, right) =>
          (depths.get(left.id) ?? 0) - (depths.get(right.id) ?? 0) ||
          left.id.localeCompare(right.id)
      ),
      edges: [...edges.values()].sort(
        (left, right) =>
          left.relation.localeCompare(right.relation) ||
          left.from.localeCompare(right.from) ||
          left.to.localeCompare(right.to)
      ),
      provenance: {
        root,
        hops,
        relations,
        truncated,
        textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
      },
      depths,
    };
  }

  /**
   * B1: bounded N-hop neighborhood. The public contract hard-caps traversal at
   * three hops and 100 nodes; an untrusted relationship filter can only select
   * from the fixed enum above.
   */
  async memoryNeighbors(
    nodeId: string,
    options: MemoryNeighborsOptions = {}
  ): Promise<MemoryNeighborsResult> {
    const result = await this.traverseMemoryGraph(nodeId, options, 3);
    return {
      nodes: result.nodes,
      edges: result.edges,
      provenance: result.provenance,
    };
  }

  /**
   * B2: shortest governed provenance path. Approval evidence is preferred; if
   * no approval is connected within the bounded six-hop/100-node search, the
   * nearest principal, task, or anchor is returned instead. CONTRADICTS peers
   * are surfaced separately through the exact same text gate.
   */
  async memoryExplain(
    noteId: string,
    options: Pick<
      MemoryNeighborsOptions,
      "chatId" | "workspacePath" | "unscopedWorkspace" | "crewVisible" | "limit"
    > = {}
  ): Promise<MemoryExplainResult> {
    const noteCoordinate = safeMemoryTraversalCoordinate(
      parseMemoryTraversalId(noteId).entityId
    );
    const rootRef: MemoryTraversalRef = {
      type: "note",
      entityId: noteCoordinate ?? "invalid",
    };
    const root = memoryTraversalId(rootRef);
    const traversal = await this.traverseMemoryGraph(
      root,
      {
        ...options,
        hops: 6,
        relFilter: DEFAULT_MEMORY_GRAPH_RELATIONS,
        limit: options.limit ?? 100,
      },
      6
    );
    const nodesById = new Map(traversal.nodes.map((node) => [node.id, node]));
    if (!nodesById.has(root)) {
      return {
        noteId: rootRef.entityId,
        path: { nodes: [], edges: [], goal: "missing" },
        contradictions: [],
        provenance: traversal.provenance,
      };
    }

    const adjacency = new Map<
      string,
      Array<{ next: string; edge: MemoryGraphEdge }>
    >();
    const addPathStep = (
      from: string,
      to: string,
      edge: MemoryGraphEdge
    ) => {
      const rows = adjacency.get(from) ?? [];
      rows.push({ next: to, edge });
      adjacency.set(from, rows);
    };
    for (const edge of traversal.edges) {
      // Contradictions are a sibling warning channel, never evidence that
      // explains the source note. Keep them out of the provenance path so an
      // attacker-controlled conflicting note cannot become a bridge to some
      // unrelated task/approval.
      if (edge.relation === "CONTRADICTS") {
        continue;
      }
      if (edge.relation === "SUPERSEDES" || edge.relation === "EXTENDS") {
        // A current note may need to walk backwards through its lineage, or an
        // old note forwards to its successor, before reaching the surviving
        // anchors.
        addPathStep(edge.from, edge.to, edge);
        addPathStep(edge.to, edge.from, edge);
      } else if (edge.relation === "TOUCHED") {
        // Stored Task→Module; provenance walks Note→Module→Task.
        addPathStep(edge.to, edge.from, edge);
      } else {
        // Every other provenance edge is followed in its authoritative
        // direction: Note→anchor/principal, Lane→Task, Task→Approval. This
        // deliberately prevents a shared module from walking backwards into an
        // unrelated note and borrowing that note's task/approval.
        addPathStep(edge.from, edge.to, edge);
      }
    }
    for (const rows of adjacency.values()) {
      rows.sort((left, right) => left.next.localeCompare(right.next));
    }

    const distance = new Map<string, number>([[root, 0]]);
    const parent = new Map<string, { previous: string; edge: MemoryGraphEdge }>();
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const row of adjacency.get(current) ?? []) {
        if (distance.has(row.next)) {
          continue;
        }
        distance.set(row.next, (distance.get(current) ?? 0) + 1);
        parent.set(row.next, { previous: current, edge: row.edge });
        queue.push(row.next);
      }
    }

    const nearest = (types: MemoryGraphNodeType[]): MemoryGraphNode | undefined =>
      traversal.nodes
        .filter((node) => types.includes(node.type) && distance.has(node.id))
        .sort(
          (left, right) =>
            (distance.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
              (distance.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
            left.id.localeCompare(right.id)
        )[0];
    const goalNode =
      nearest(["approval"]) ??
      nearest(["principal"]) ??
      nearest(["task"]) ??
      nearest(["module", "symbol"]) ??
      nodesById.get(root)!;
    const goal: MemoryExplainResult["path"]["goal"] =
      goalNode.type === "approval"
        ? "approval"
        : goalNode.type === "principal"
          ? "principal"
          : goalNode.type === "task"
            ? "task"
            : goalNode.type === "module" || goalNode.type === "symbol"
              ? "anchor"
              : "note";

    const pathIds = [goalNode.id];
    const pathEdges: MemoryGraphEdge[] = [];
    let cursor = goalNode.id;
    while (cursor !== root) {
      const row = parent.get(cursor);
      if (!row) {
        break;
      }
      pathEdges.push(row.edge);
      cursor = row.previous;
      pathIds.push(cursor);
    }
    pathIds.reverse();
    pathEdges.reverse();

    const contradictions = traversal.edges
      .filter(
        (edge) =>
          edge.relation === "CONTRADICTS" &&
          (edge.from === root || edge.to === root)
      )
      .map((edge) => (edge.from === root ? edge.to : edge.from))
      .filter((id, index, all) => all.indexOf(id) === index)
      .map((id) => nodesById.get(id))
      .filter(
        (node): node is MemoryGraphNode => node?.type === "note"
      );

    return {
      noteId: rootRef.entityId,
      path: {
        nodes: pathIds.map((id) => nodesById.get(id)!).filter(Boolean),
        edges: pathEdges,
        goal,
      },
      contradictions,
      provenance: traversal.provenance,
    };
  }

  /**
   * Idempotent projection of a ledger MemoryEdge into the note→note edge
   * vocabulary (KG-5/KG-6): supersedes → SUPERSEDES (history/traversal),
   * extends → EXTENDS (additive detail; both notes stay active), contradicts →
   * CONTRADICTS (both notes stay active, human reconciles), related
   * → RELATED (dense-only match, both kept), proposes_supersede →
   * PROPOSES_SUPERSEDE (KG-6: a governed, contested destructive write, both notes
   * stay ACTIVE until a human/peer confirms it). All are persisted MemoryEdge rows
   * in the ledger; contradictions ALSO carry a `conflictsWith` scalar on the note
   * (set in projectMemoryNote) for cheap read-side flagging.
   *
   * Best-effort, and it NEVER throws — but it now REPORTS. The `MATCH ... MERGE`
   * shape writes nothing when either endpoint node is absent, and it does so
   * SILENTLY and PERMANENTLY: the edge is not retried when the endpoint arrives a
   * moment later, so a mirror that projects an edge on a DIFFERENT async chain
   * than its endpoints (the backend's fire-and-forget `mirrorToGraph`) can drop it
   * until the next full reproject. `RETURN 1 AS ok` makes the miss visible at zero
   * cost — zero rows means the MATCH bound nothing — so a caller can react.
   *
   * `awaitEndpoints` is the opt-in for exactly that cross-chain case: a short,
   * bounded re-attempt. It is OFF by default because a legitimately absent
   * endpoint (an edge pointing at a note the ledger tombstoned and the projector
   * deleted) must stay free — `projectLedgerToGraph` writes every edge in the
   * brain and can never pay a retry for each of those.
   *
   * @returns whether the edge is now projected.
   */
  async projectMemoryEdge(
    fromId: string,
    toId: string,
    kind: string,
    options?: { awaitEndpoints?: boolean }
  ): Promise<boolean> {
    const rel = memoryEdgeRel(kind);
    if (!rel) {
      return false;
    }
    // Immediate attempt, then (opt-in only) two bounded re-attempts, enough for an
    // endpoint whose own projection is queued just behind this one on the shared
    // connection. The ledger row stays authoritative, so giving up loses nothing
    // a reproject cannot restore.
    const backoffMs = options?.awaitEndpoints ? [0, 25, 75] : [0];
    for (const wait of backoffMs) {
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      const rows = await this.execute(
        `MATCH (a:MemoryNote {id: $fromId}), (b:MemoryNote {id: $toId})
         MERGE (a)-[:${rel}]->(b)
         RETURN 1 AS ok`,
        { fromId, toId }
      ).catch(() => []);
      if (rows.length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Remove one projected note and every attached edge. The durable ledger keeps
   * the coordinate-only tombstone; this graph is rebuildable and must not retain
   * the deleted note's text or provenance edges after a hard delete/compaction.
   */
  async deleteMemoryNote(noteId: string): Promise<void> {
    await this.execute(
      `MATCH (n:MemoryNote {id: $noteId}) DETACH DELETE n`,
      { noteId }
    );
  }

  /** Note ids this note PROPOSES_SUPERSEDE (KG-6: contested destructive writes
   *  pending human/peer confirmation; both notes stay active). */
  async proposedSupersedesOf(noteId: string): Promise<string[]> {
    const rows = await this.execute(
      `MATCH (n:MemoryNote {id: $noteId})-[:PROPOSES_SUPERSEDE]->(m:MemoryNote)
       RETURN m.id AS id`,
      { noteId }
    );
    return rows.map((row) => String(row.id ?? row["m.id"]));
  }

  /**
   * Delete ALL projected note→note edges of a kind (KG-6). PROPOSES_SUPERSEDE is
   * the one TRANSIENT edge type, a reject drops it and an apply swaps it for
   * SUPERSEDES, so, unlike the additive supersedes/contradicts/related edges, its
   * ledger rows can DISAPPEAR. The projector clears this kind before re-MERGEing
   * the current ledger rows, making a reproject AUTHORITATIVE for it (a resolved
   * proposal never lingers as a stale graph edge, and the best-effort live-mirror
   * delete can never lose a race). Best-effort.
   */
  async clearMemoryEdges(kind: string): Promise<void> {
    const rel = memoryEdgeRel(kind);
    if (!rel) {
      return;
    }
    await this.execute(
      `MATCH (:MemoryNote)-[r:${rel}]->(:MemoryNote) DELETE r`,
      {}
    ).catch(() => undefined);
  }

  /**
   * Delete a projected note→note edge (KG-6). Used when a PROPOSES_SUPERSEDE is
   * RESOLVED: a reject drops the proposal edge, and an APPLY swaps it for a real
   * SUPERSEDES, the ledger row is gone either way, so the live projection must
   * lose the stale edge without waiting for a full wipe+reproject. Best-effort.
   */
  async deleteMemoryEdge(
    fromId: string,
    toId: string,
    kind: string
  ): Promise<void> {
    const rel = memoryEdgeRel(kind);
    if (!rel) {
      return;
    }
    await this.execute(
      `MATCH (a:MemoryNote {id: $fromId})-[r:${rel}]->(b:MemoryNote {id: $toId})
       DELETE r`,
      { fromId, toId }
    ).catch(() => undefined);
  }

  /**
   * Record an EXPLICIT used-signal (a note was cited/applied, not merely
   * retrieved). Buffered in memory only, this is deliberately NOT a write, so
   * it can be called on the hot path without read-amplification. The durable
   * ledger layer flushes the buffer on a timer/shutdown (`flushReinforcement`).
   */
  markMemoryUsed(noteIds: string[]): void {
    if (noteIds.length === 0) {
      return;
    }
    const now = new Date().toISOString();
    for (const id of noteIds) {
      const entry = this.usageBuffer.get(id);
      if (entry) {
        entry.count += 1;
        entry.lastUsedAt = now;
      } else {
        this.usageBuffer.set(id, { count: 1, lastUsedAt: now });
      }
    }
  }

  /** Number of notes with pending (un-flushed) used-signals. */
  pendingReinforcementCount(): number {
    return this.usageBuffer.size;
  }

  /**
   * Drain the used-signal buffer into the graph nodes. For each buffered note
   * the stored `accessCount` is FIRST time-decayed over the interval since it
   * was last used, THEN the new used-count is added (recent usefulness beats
   * stale lifetime popularity, the v3 counter never decayed). Returns the new
   * authoritative `accessCount`/`lastUsedAt` per note so the durable ledger
   * persists them (they then survive a store wipe, KG-1 finding F3). Called
   * off the read path (timer/shutdown), never from search/recall.
   */
  async flushReinforcement(): Promise<
    { noteId: string; accessCount: number; lastUsedAt: string }[]
  > {
    if (this.usageBuffer.size === 0) {
      return [];
    }
    const buffered = [...this.usageBuffer.entries()];
    this.usageBuffer.clear();
    const applied: { noteId: string; accessCount: number; lastUsedAt: string }[] =
      [];
    for (const [id, signal] of buffered) {
      const node = await this.getMemoryNote(id);
      if (!node) {
        continue; // note vanished (e.g. store rebuilt), drop the soft signal
      }
      const decayed = decayAccessCount(
        node.accessCount,
        node.lastAccessedAt,
        Date.parse(signal.lastUsedAt)
      );
      const accessCount = Math.round(decayed) + signal.count;
      await this.execute(
        `MATCH (n:MemoryNote {id: $id})
         SET n.accessCount = $accessCount, n.lastAccessedAt = $lastUsedAt`,
        { id, accessCount, lastUsedAt: signal.lastUsedAt }
      ).catch(() => undefined);
      applied.push({ noteId: id, accessCount, lastUsedAt: signal.lastUsedAt });
    }
    return applied;
  }

  /**
   * B4 bounded note↔module analytics. Every returned field is a coordinate or
   * scalar; note text never enters the query or the pure algorithm. Agent callers
   * combine the chat visibility predicate with the same confirmed/crew-visible
   * gate used by memory recall.
   */
  async memoryAnalytics(options?: {
    chatId?: string;
    /** ADR-0026: the workspace partition. Coordinate-only analytics still answer
     *  a question ABOUT a corpus, so a cross-repo count is a cross-repo answer. */
    workspacePath?: string;
    unscopedWorkspace?: boolean;
    governedOnly?: boolean;
    trustFloor?: MemoryTrust;
    crewChatId?: string;
    /** Require the crew-visible branch to carry a durable D12-C vouch. This is
     * analytics-only: ordinary retrieval may widen graph candidates and let the
     * authoritative ledger narrow them, while this coordinate-only query has no
     * ledger reconciliation pass. */
    crewVouchedOnly?: boolean;
    limit?: number;
  }): Promise<MemoryAnalyticsSnapshot> {
    const limit = Math.max(1, Math.min(options?.limit ?? 2_000, 5_000));
    // Enumerated rather than spread: `limit` is not a visibility coordinate and
    // must never become one by riding an options object into the predicate.
    const visibility = this.visibilityClauses({
      chatId: options?.chatId,
      workspacePath: options?.workspacePath,
      unscopedWorkspace: options?.unscopedWorkspace,
    });
    const governed = this.governedConditions(options);
    const conditions = [...visibility.conditions, ...governed.conditions];
    if (options?.crewVouchedOnly && options.crewChatId) {
      conditions.push(`(n.confirmed = true OR n.crewVouched = true)`);
    }
    const rows = await this.execute(
      `MATCH (n:MemoryNote)
       WHERE ${conditions.join(" AND ")}
       RETURN n.id AS id, n.modules AS modules
       ORDER BY n.id ASC
       LIMIT ${limit + 1}`,
      { ...visibility.params, ...governed.params }
    );
    const truncated = rows.length > limit;
    return analyzeMemoryGraph(
      rows.slice(0, limit).map((row) => ({
        id: String(row.id ?? ""),
        modules: Array.isArray(row.modules)
          ? row.modules.map((module) => String(module))
          : [],
      })),
      { truncated }
    );
  }

  private async centralityByNote(options?: {
    chatId?: string;
    workspacePath?: string;
    unscopedWorkspace?: boolean;
    governedOnly?: boolean;
    trustFloor?: MemoryTrust;
    crewChatId?: string;
  }): Promise<Map<string, number>> {
    try {
      const analytics = await this.memoryAnalytics(options);
      return new Map(
        analytics.noteScores.map((row) => [row.noteId, row.score])
      );
    } catch {
      return new Map();
    }
  }

  /**
   * Semantic candidates from the optional embeddings tier. Returns note ids
   * ranked by cosine similarity to the query. No embedder configured (the
   * local-first default) → empty, and retrieval stays purely lexical/graph.
   *
   * TODO 4.4: the dense arm also requires `n.embeddingSpace = embedder.id`.
   * A vector from another model (or a legacy unstamped `''` space) is
   * excluded — the arm degrades to empty rather than comparing across spaces
   * or becoming a silent recency bias after a mid-life model switch. Strictly
   * better than D5's coverage-threshold recommendation: exact, no moving
   * target, and never a refuse-to-boot.
   */
  private async semanticCandidates(
    query: string,
    limit: number
  ): Promise<string[]> {
    if (!this.embedder) {
      return [];
    }
    const space = this.embedder.id.trim();
    if (!space) {
      return [];
    }
    try {
      const queryVec = await this.embedText(query);
      if (queryVec.length === 0) {
        return [];
      }
      const rows = await this.execute(
        `MATCH (n:MemoryNote)
         WHERE n.status = 'active'
           AND size(n.embedding) > 0
           AND n.embeddingSpace = $space
         RETURN n.id AS id, n.embedding AS embedding
         LIMIT 2000`,
        { space }
      );
      return rows
        .map((row) => ({
          id: String(row.id),
          score: cosine(queryVec, (row.embedding as number[]) ?? []),
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => entry.id);
    } catch {
      return [];
    }
  }

  /**
   * R2 entity candidates (mem0 §5.3's signal, MUON's fusion). Extract the query's
   * entities (capped at 8, deduped, normalized), then find every visible note
   * that MENTIONS one and rank by the summed class weight of the DISTINCT
   * entities matched.
   *
   * WHAT MAKES THIS SAFE. The join carries the caller's FULL predicate — the same
   * `visibilityClauses` (bitemporal / scope / #126 chat partition) and
   * `governedConditions` (KG-6 gate) that `searchMemoryLexical` uses. So an
   * entity match can only ever return a note the caller could already have
   * retrieved lexically; it can never reveal the text OR the existence of a note
   * behind the gate, and it can never become a cross-chat OR cross-WORKSPACE join
   * (ADR-0026), because the partition is applied to `n`, not to `e` — one `Entity`
   * mentioned by two repos' notes still only ever yields the caller's own repo's.
   * The `Entity` node itself is never
   * returned to a caller and is deliberately absent from the traversal
   * vocabulary, so it adds no new read surface at all.
   *
   * WHAT WE DID NOT PORT. mem0 boosts an ADDITIVE score on candidates that their
   * SEMANTIC search already returned (§5.2), so a perfect entity match that
   * embeds poorly can never enter their result set, and their threshold gates the
   * semantic score before the boost applies. This returns a ranked LIST that
   * enters RRF as a peer of FTS/lexical/dense and has neither defect — an
   * entity-only hit competes on equal terms, and with no embedder configured
   * (the default local-first install) it is one of only three signals present.
   */
  /**
   * D-mem0-1 — the corpus counts the entity arm's IDF needs: how many ACTIVE
   * notes mention each query key (`df`), and how many active notes there are (N).
   *
   * TWO bounded aggregates, and they are deliberately NOT the caller's filtered
   * set. IDF asks "how common is this word IN THE CORPUS", which is a property of
   * the brain rather than of one caller's visibility — computing it from the
   * already-fetched candidate rows would be free, but those rows carry the
   * caller's chat/workspace/gate predicates AND a `LIMIT`, so the same key would
   * score as rare for a narrow reader and common for a wide one, and a truncated
   * fetch would silently understate df. A ranking term that changes with who is
   * asking is not a document frequency.
   *
   * COST, stated: +2 store round trips, FLAT in entity count (the keys are one
   * bound `OR` list, exactly as the mention query binds them). This is the hybrid
   * `q`-bearing path only — `entityCandidates` is not reached by the anchored gate
   * recall, which returns before the four arms fan out, so D6's "one round trip
   * per gate read" is untouched. Verified structurally, not assumed.
   *
   * DEGRADES TO NO DISCOUNT, never to a wrong one: any failure yields an empty
   * `df` map with `activeNotes: 0`, so every key gets `log(1/1) = 0`… which would
   * zero every weight and destroy the ordering. So the failure path returns N = 0
   * AND an empty map, and {@link entityIdf}'s smoothing makes that a CONSTANT
   * factor across every key — the ranking degrades to the pre-IDF order rather
   * than to noise. That constant-factor property is what makes this safe to fail.
   */
  private async entityCorpusStats(
    queryEntities: MemoryEntity[]
  ): Promise<EntityCorpusStats> {
    const df = new Map<string, number>();
    if (queryEntities.length === 0) {
      return { df, activeNotes: 0 };
    }
    try {
      const params: Params = {};
      const keyClauses = queryEntities.map((entity, index) => {
        params[`dfEnt${index}`] = entity.key;
        return `e.id = $dfEnt${index}`;
      });
      const [dfRows, totalRows] = await Promise.all([
        this.execute(
          `MATCH (n:MemoryNote)-[:MENTIONS]->(e:Entity)
           WHERE n.status = 'active' AND (${keyClauses.join(" OR ")})
           RETURN e.id AS key, count(DISTINCT n.id) AS df`,
          params
        ),
        this.execute(
          `MATCH (n:MemoryNote) WHERE n.status = 'active'
           RETURN count(n) AS total`,
          {}
        ),
      ]);
      for (const row of dfRows) {
        df.set(String(row.key ?? ""), Number(row.df ?? 0));
      }
      return { df, activeNotes: Number(totalRows[0]?.total ?? 0) };
    } catch {
      return { df: new Map(), activeNotes: 0 };
    }
  }

  private async entityCandidates(
    query: string,
    limit: number,
    options?: {
      asOf?: string;
      scope?: string;
      chatId?: string;
      workspacePath?: string;
      unscopedWorkspace?: boolean;
      governedOnly?: boolean;
      trustFloor?: MemoryTrust;
      crewChatId?: string;
      showExpired?: boolean;
      now?: string;
    },
    /** D4: the anchor narrowing, pushed INTO this candidate query for the same
     *  reason the gate is (`LIMIT` must apply to the set the caller asked for).
     *  Empty set → no clause, i.e. this arm unchanged. */
    anchors: MemoryAnchorSet = { modules: [], symbols: [], requested: false }
  ): Promise<string[]> {
    if (!this.entitiesEnabled) {
      return [];
    }
    const queryEntities = extractQueryEntities(query);
    if (queryEntities.length === 0) {
      return [];
    }
    try {
      const visibility = this.visibilityClauses(options);
      const governed = this.governedConditions(options);
      const params: Params = {
        ...visibility.params,
        ...governed.params,
      };
      // Bound, explicitly-enumerated equality clauses (≤ MAX_QUERY_ENTITIES) — the
      // keys are normalized extractor output, but they are still bound as params
      // rather than interpolated, so untrusted note text can never reach Cypher.
      const keyClauses = queryEntities.map((entity, index) => {
        params[`ent${index}`] = entity.key;
        return `e.id = $ent${index}`;
      });
      // D6: the anchor hop joins the SAME `n`, as a second comma-separated pattern,
      // and the projection becomes DISTINCT so the anchor multiplicity of a note
      // carrying several requested anchors cannot eat the row budget. One query per
      // namespace, merged by (note, entity) pair below.
      const shapes = anchorQueryShapes(anchors);
      const rowsByArm = await Promise.all(
        shapes.map((shape) =>
          this.execute(
            `MATCH (n:MemoryNote)-[:MENTIONS]->(e:Entity)${
              shape.pattern ? `, (n)${shape.pattern}` : ""
            }
             WHERE ${[
               ...visibility.conditions,
               ...governed.conditions,
               ...shape.conditions,
               `(${keyClauses.join(" OR ")})`,
             ].join(" AND ")}
             RETURN ${
               shape.distinct ? "DISTINCT " : ""
             }n.id AS id, e.id AS entityKey, n.createdAt AS createdAt
             LIMIT ${MAX_QUERY_ENTITIES * 100}`,
            { ...params, ...shape.params }
          )
        )
      );
      const mentions = new Map<
        string,
        { noteId: string; entityKey: string; createdAt: string }
      >();
      for (const rows of rowsByArm) {
        for (const row of rows) {
          const mention = {
            noteId: String(row.id ?? ""),
            entityKey: String(row.entityKey ?? ""),
            createdAt: String(row.createdAt ?? ""),
          };
          // Keyed on the PAIR, not the note: `rankByEntityMentions` scores by the
          // number of DISTINCT entities a note matched, so collapsing two arms by
          // note id would lose exactly the signal it ranks on.
          mentions.set(`${mention.noteId}\u0000${mention.entityKey}`, mention);
        }
      }
      return rankByEntityMentions(
        [...mentions.values()],
        queryEntities,
        limit,
        await this.entityCorpusStats(queryEntities)
      );
    } catch {
      return [];
    }
  }

  /**
   * Hybrid retrieval (v3): gather candidates from FTS (BM25), the lexical
   * scorer, the R2 entity index, and, when embeddings are enabled, semantic
   * cosine; fuse their rankings with Reciprocal Rank Fusion (k=60); then rerank
   * with the calibrated ranker. See docs/research/memory-graph-v3.md and
   * mem0-capability-reference.md §5.3.
   *
   * D4: a THIN FAÇADE over `retrieveMemory` since the conjunctive entry point
   * landed. Called with no anchors (every pre-D4 caller) it is this method
   * unchanged; called WITH anchors the arms rank inside the anchored set.
   */
  async searchMemory(
    query: string,
    limit = 20,
    options?: {
      /** D4: the anchor coordinates, when a caller composes text WITH anchors.
       *  Absent (every pre-D4 caller, and `GET /api/memory/search`) → no anchor
       *  term at all, i.e. this method byte for byte. */
      modules?: string[];
      symbols?: string[];
      module?: string;
      symbol?: string;
      asOf?: string;
      scope?: string;
      // #126 per-chat partition: restrict to this chat's notes. Threaded into the
      // lexical/as-of candidate query (visibilityClauses) AND enforced as a
      // post-fusion HARD filter below, so an FTS/semantic candidate that never
      // hit the chatId-scoped WHERE can still not leak across chats.
      chatId?: string;
      // ADR-0026 per-WORKSPACE partition: the canonical repo root this read
      // belongs to. Threaded into the lexical/entity candidate queries
      // (visibilityClauses) AND enforced as a post-fusion HARD filter below, for
      // exactly the reason chatId is: FTS and semantic candidates never see the
      // scoped WHERE. Absent → today's behaviour (§5, monotonic).
      workspacePath?: string;
      // §8 residue view: ONLY the notes with no workspace, each one labelled by
      // the surface that asked. Operator-tier only; the route refuses it for an
      // agent, and it is mutually exclusive with `workspacePath`.
      unscopedWorkspace?: boolean;
      // GATE view (KG-6): restrict to governed (confirmed / trust-floored) notes.
      governedOnly?: boolean;
      trustFloor?: MemoryTrust;
      crewChatId?: string;
      // R3 TTL: include expired notes (server-owned opt-in), and the instant they
      // are measured against. Absent → expired notes are hidden, real clock.
      showExpired?: boolean;
      now?: string;
    }
  ): Promise<MemoryNoteRecord[]> {
    return this.retrieveMemory({ ...options, q: query }, limit);
  }

  /**
   * The hybrid TEXT branch of `retrieveMemory` — this is the pre-D4 `searchMemory`
   * body, with the anchor set threaded through every arm.
   *
   * `anchors` is a HARD narrowing and enters by two routes, exactly as `chatId`
   * and `workspacePath` do and for exactly the same reason:
   *   • pushed INTO the lexical + entity candidate queries, so their `LIMIT`
   *     applies to the anchored (and governed) set — completeness, not merely
   *     leak-free;
   *   • enforced as a post-fusion JS net (`anchorFilter`), because
   *     `QUERY_FTS_INDEX` accepts no `WHERE` predicate and the dense arm ranks
   *     vectors in JS, so neither arm can carry the term itself.
   */
  private async hybridSearch(
    query: string,
    limit: number,
    anchors: MemoryAnchorSet,
    options?: MemoryRetrievalRequest
  ): Promise<MemoryNoteRecord[]> {
    const pool = Math.max(limit * 3, 30);
    // R3: resolve the expiry instant ONCE per search so the candidate queries and
    // the post-fusion net cannot straddle a deadline mid-request.
    const opts = { ...options, now: resolveExpiryNow(options?.now) };
    // As-of view (KG-5): FTS + semantic candidates only surface the CURRENT active
    // set, so a BITEMPORAL view uses the temporal-aware lexical scan alone,
    // deterministic and correct for "what did the brain believe about X at time T"
    // (FTS is also off in container/CI hosts). scope is threaded here too.
    if (options?.asOf) {
      const notes = await this.searchMemoryLexical(query, pool, opts, anchors);
      const inputs: RankInput[] = notes.map((note, index) => ({
        note,
        relevance: 1 - index / Math.max(notes.length, 1),
      }));
      // KG-4: the as-of view uses the SAME calibrated re-rank as the current-set
      // path, no quality cliff between "now" and a bitemporal query (F3).
      const ranked = rerankCalibrated(inputs);
      // #126 + ADR-0026: the as-of lexical scan is already chat- AND
      // workspace-scoped via visibilityClauses; the post-filter is
      // defense-in-depth, keeping every search path uniform.
      const partitioned = this.partitionFilter(ranked, options);
      // D4: and already anchor-scoped in the same query. Same defense-in-depth
      // posture — one net, every search path, so no arm is ever the one that
      // forgot a term.
      const anchored = this.anchorFilter(partitioned, anchors);
      // KG-6 gate: a governed read excludes any note that is not confirmed / not
      // trust-floored, so a hostile low-trust write can never surface in a gate.
      // R3: applyGate also drops expired notes, on this path and every other.
      return this.applyGate(anchored, opts).slice(0, limit);
    }
    const [ftsNotes, lexicalNotes, semanticIds, entityIds] = await Promise.all([
      // D4: the FTS arm takes NO anchor predicate (`QUERY_FTS_INDEX` accepts no
      // WHERE) and its `top` is deliberately NOT widened to compensate — the
      // anchor filter is applied as a SET INTERSECTION below (`anchorFilter`).
      this.ftsEnabled ? this.searchMemoryFts(query, pool) : Promise.resolve([]),
      this.searchMemoryLexical(query, pool, opts, anchors),
      this.semanticCandidates(query, pool),
      // R2: ONE extra store round-trip, and it carries the caller's full
      // visibility + gate predicate (see entityCandidates).
      this.entityCandidates(query, pool, opts, anchors),
    ]);

    // Assemble the id → note map and per-retriever ranked lists.
    const byId = new Map<string, MemoryNoteRecord>();
    for (const note of [...ftsNotes, ...lexicalNotes]) {
      byId.set(note.id, note);
    }
    // Semantic + entity ids may not be in the lexical pool, hydrate them.
    const missing = [...new Set([...semanticIds, ...entityIds])].filter(
      (id) => !byId.has(id)
    );
    if (missing.length > 0) {
      for (const id of missing) {
        const note = await this.getMemoryNote(id);
        if (note && note.status === "active") {
          byId.set(id, note);
        }
      }
    }

    const lists = [
      ftsNotes.map((n) => n.id),
      lexicalNotes.map((n) => n.id),
      semanticIds.filter((id) => byId.has(id)),
      entityIds.filter((id) => byId.has(id)),
    ].filter((list) => list.length > 0);

    if (lists.length === 0) {
      return [];
    }

    const fused = reciprocalRankFusion(lists);
    const maxFused = Math.max(...fused.values(), 1e-9);
    const inputs: RankInput[] = [];
    for (const [id, score] of fused) {
      const note = byId.get(id);
      if (note) {
        // KG-12: no `centrality` here any more. The prior was measured by the
        // graph-value ablation and lost at every width profile (nDCG −0.0141 /
        // MRR −0.0313 at the shipped defaults) while never adding a candidate, so
        // the whole `centralityByNote` round-trip is gone from the read path.
        // `memoryAnalytics` itself is untouched — it is its own product surface.
        inputs.push({ note, relevance: score / maxFused });
      }
    }

    // Reinforcement is OFF the read path (ADR-0009 §2.4 / KG-2): a search reads
    // accessCount for ranking but NEVER writes it. Callers that actually USE a
    // note signal it explicitly via markMemoryUsed → flushReinforcement.
    // KG-4: the calibrated ranker (bounded governance + demotion gate) replaces
    // the ad-hoc additive salience, proven to beat it on the labeled eval set.
    const ranked = rerankCalibrated(inputs);
    // Scope-aware search (KG-5 / D5 / F3): a scope-ONLY query keeps the FULL
    // FTS+semantic+lexical hybrid (no recall-quality cliff) and SOFT-filters by
    // scope AFTER fusion, so ranking is undisturbed and hosted mode can later
    // hard-gate. Absent scope = all scopes (unchanged).
    const scoped = options?.scope
      ? ranked.filter((note) => (note.scope ?? "project") === options.scope)
      : ranked;
    // #126 + B6 + ADR-0026 partition net: FTS + semantic candidates are neither
    // chat- nor workspace-scoped in their candidate queries, so the post-fusion
    // filter drops every ordinary cross-chat/NULL-chat note (admitting only
    // confirmed promoted-global memory) and every foreign-workspace note.
    const partitioned = this.partitionFilter(scoped, options);
    // D4 ANCHOR INTERSECTION: the FTS and semantic arms could not carry the anchor
    // term either, so their candidates are intersected with the anchor set HERE,
    // BEFORE the `slice(0, limit)` below. Order is load-bearing: filtering AFTER
    // the slice would silently truncate the visible answer, which is the exact
    // completeness failure `governedConditions`' in-query gate exists to prevent.
    const anchored = this.anchorFilter(partitioned, anchors);
    // KG-6 gate: after scope, drop anything not governed (confirmed / trust ≥
    // floor) when the caller asked for the gate view. Absent → unchanged.
    // R3: and, gate or no gate, drop every expired note the FTS/semantic
    // candidate queries could not filter themselves.
    return this.applyGate(anchored, opts).slice(0, limit);
  }

  /**
   * D4 post-fusion ANCHOR net — `partitionFilter`'s sibling, and the JS half of
   * `memoryAnchorClause`.
   *
   * It exists for the same reason `partitionFilter` does: two of the four arms
   * (FTS, dense) never pass through a `WHERE` at all, so a term that is not
   * mirrored in JS is a term those arms ignore. It reads `n.modules`/`n.symbols`,
   * the AUTHORITY arrays (D6 keeps the array the authority and the edge the access
   * path), through the ONE shared predicate in `memory-anchors.ts`.
   *
   * Empty anchor set → returns the input untouched, so every pre-D4 call site is
   * byte-for-byte unchanged.
   */
  private anchorFilter(
    notes: MemoryNoteRecord[],
    anchors: MemoryAnchorSet
  ): MemoryNoteRecord[] {
    if (anchorSetSize(anchors) === 0 && !anchorFenceIsEmpty(anchors)) {
      return notes;
    }
    return notes.filter((note) => noteMatchesAnchors(note, anchors));
  }

  /**
   * #126 + B6 + ADR-0026 post-fusion partition net. FTS and semantic candidates
   * never pass through `visibilityClauses`, so this is the only thing standing
   * between them and the caller on those two paths.
   *
   * TWO axes now, which is why it is no longer called `chatFilter`: a filter that
   * enforces chat AND workspace must not keep a one-axis name (ADR-0026 §9).
   *
   * The two terms compose as `workspace AND chat`, never as one predicate: a chat
   * sees its own notes plus a deliberately promoted note only when it is
   * human-confirmed and global, and the workspace term is applied OUTSIDE that
   * global admission (§6) — so promotion widens a note across MISSIONS and never
   * across REPOS. Written in this order for the same reason `visibilityClauses`
   * pushes its terms in this order: each clause is an independent narrowing, and
   * neither can admit a row the other rejected.
   *
   * Mirrors `workspaceCondition` + the chat clause in `visibilityClauses` term
   * for term. Absent coordinate = unchanged behaviour, on both axes.
   */
  private partitionFilter(
    notes: MemoryNoteRecord[],
    opts?: { chatId?: string; workspacePath?: string; unscopedWorkspace?: boolean }
  ): MemoryNoteRecord[] {
    let visible = notes;
    // ADR-0026 §8: the residue view is the notes with NO workspace, and nothing
    // else. It is operator-tier only (the route refuses it for an agent), and it
    // is a NARROWER like every other term here — it removes every assigned row.
    if (opts?.unscopedWorkspace) {
      visible = visible.filter((note) => (note.workspacePath ?? "") === "");
    } else if (opts?.workspacePath) {
      const workspacePath = opts.workspacePath;
      visible = visible.filter(
        (note) => (note.workspacePath ?? "") === workspacePath
      );
    }
    if (!opts?.chatId) {
      return visible;
    }
    const chatId = opts.chatId;
    return visible.filter(
      (note) =>
        (note.chatId ?? "") === chatId ||
        ((note.scope ?? "project") === "global" && note.confirmed)
    );
  }

  /**
   * The GATE predicate (KG-6), applied to the MIRROR's copies while candidates
   * are built. The rule itself lives in `memoryPassesGate` (memory-gate.ts) so
   * the backend can re-apply the SAME rule to the LEDGER's copies at the route —
   * `confirmed` is derived from the Confirmation ledger, and one dropped mirror
   * write leaves this method reading `confirmed: true` about a note a human
   * un-blessed. Two evaluators, one rule; delegate, never re-state.
   */
  private passesGate(
    note: MemoryNoteRecord,
    opts?: { governedOnly?: boolean; trustFloor?: MemoryTrust; crewChatId?: string }
  ): boolean {
    return memoryPassesGate(note, opts);
  }

  private applyGate(
    notes: MemoryNoteRecord[],
    opts?: {
      governedOnly?: boolean;
      trustFloor?: MemoryTrust;
      crewChatId?: string;
      showExpired?: boolean;
      now?: string;
    }
  ): MemoryNoteRecord[] {
    // R3 expiry is NOT part of the gate and runs on EVERY read, gated or not:
    // FTS and semantic candidates never pass through `visibilityClauses`, so this
    // net is the only thing that hides an expired note on those paths. One clock
    // per call, shared by every note (`resolveExpiryNow`), mirroring the cypher
    // clause term for term (memory-expiry.ts).
    const notPaused = notes.filter((note) => note.status !== "paused");
    const visible = opts?.showExpired
      ? notPaused
      : (() => {
          const now = resolveExpiryNow(opts?.now);
          return notPaused.filter((note) => !isMemoryNoteExpired(note, now));
        })();
    if (!opts?.governedOnly) {
      return visible;
    }
    return visible.filter((note) => this.passesGate(note, opts));
  }

  /**
   * Cypher WHERE clause(s) enforcing the gate IN the candidate query (KG-6 F4), so
   * a LIMIT never drops an OLD governed note in favour of newer ungoverned rows,
   * the gate is COMPLETE, not merely leak-free. `n.confirmed` is the projected
   * HUMAN-confirmed flag (KG-6 F1). Mirrors `passesGate` exactly. Empty when the
   * caller did not ask for the gate. */
  private governedConditions(opts?: {
    governedOnly?: boolean;
    trustFloor?: MemoryTrust;
    crewChatId?: string;
  }): { conditions: string[]; params: Params } {
    const conditions: string[] = [];
    const params: Params = {};
    if (!opts?.governedOnly) {
      return { conditions, params };
    }
    // A paused note is operator-inspectable provenance, never gate input. Keep
    // this IN the candidate query so LIMIT applies to the eligible set.
    // Rejected notes can still be the correct answer to an as-of read from
    // before their verdict; `visibilityClauses` owns that bitemporal decision.
    // Pause alone is current suppression and must dominate time travel.
    conditions.push("n.status <> 'paused'");
    const ors = ["n.confirmed = true"];
    // #133 CREW-VISIBLE admission, enforced IN the candidate query so LIMIT applies
    // to the widened set (completeness, not merely leak-free). `n.chatId <> ''`
    // keeps NULL-chat / legacy + global notes HUMAN-gated; trust is untouched so a
    // `trustFloor:'high'` gate still excludes 'medium' agent notes. LOCKSTEP with
    // passesGate. crewChatId is ALWAYS the request's OWN chat (see preEditContext),
    // and the outer chatId HARD-partition (visibilityClauses) still bounds every row
    // to that chat, so this can only widen WITHIN a single chat, never across chats.
    // Authorship is deliberately absent from this branch, exactly as it is from
    // passesGate's — a note admitted by one and not the other is the drift these
    // two comments have always warned about, and a single test pins them together.
    if (opts.crewChatId) {
      params.crewChatId = opts.crewChatId;
      ors.push(`(n.chatId = $crewChatId AND n.chatId <> '')`);
    }
    if (opts.trustFloor != null) {
      const floor = opts.trustFloor;
      const allowed = (["low", "medium", "high"] as MemoryTrust[]).filter(
        (t) => trustRank(t) >= trustRank(floor)
      );
      allowed.forEach((t, i) => {
        params[`govTrust${i}`] = t;
        ors.push(`n.trust = $govTrust${i}`);
      });
    }
    conditions.push(`(${ors.join(" OR ")})`);
    return { conditions, params };
  }

  private async searchMemoryFts(
    query: string,
    limit: number
  ): Promise<MemoryNoteRecord[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    // L2 fix: the search string is agent-tier reachable (GET /api/memory/search?q=),
    // so it is UNTRUSTED. Bind it as a $param on the prepared-statement path instead
    // of interpolating a hand-escaped literal. Manual `'`→`''` doubling is UNSOUND for
    // the Ladybug/Kuzu dialect: a backslash-bearing query (e.g. `quote\'mix`) survives
    // the doubling and still breaks the string literal, throwing a parser error, and a
    // hostile input can never be proven safe by hand. A bound param neutralizes every
    // quote / backslash / statement-terminator: the value is FTS search text, never
    // Cypher, so `' RETURN 1 //` is matched as literal tokens, never a second statement.
    // Verified against the real store: QUERY_FTS_INDEX accepts bound params for both the
    // query-string and `top` args and returns identical hits/scores to the old literal.
    try {
      const rows = await this.execute(
        `CALL QUERY_FTS_INDEX(
          'MemoryNote',
          'memory_note_fts',
          $ftsQuery,
          top := $ftsTop
        )
        RETURN node, score
        ORDER BY score DESC`,
        { ftsQuery: trimmed, ftsTop: Math.max(1, limit) }
      );
      return rows
        .map((row) => {
          const node = (row.node ?? row["node"]) as Row | undefined;
          if (!node) {
            return null;
          }
          return noteFromRow(node);
        })
        .filter((note): note is MemoryNoteRecord => note !== null)
        .filter((note) => note.status === "active")
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /** Lexical fallback: case-insensitive substring/token match. Honors the
   *  bitemporal/scope visibility predicate (KG-5) so an as-of search is correct. */
  private async searchMemoryLexical(
    query: string,
    limit = 20,
    options?: {
      asOf?: string;
      scope?: string;
      chatId?: string;
      workspacePath?: string;
      unscopedWorkspace?: boolean;
      governedOnly?: boolean;
      trustFloor?: MemoryTrust;
      crewChatId?: string;
      showExpired?: boolean;
      now?: string;
    },
    /** D4: the anchor narrowing. THIS is the arm that carries the completeness
     *  guarantee under an anchor filter — its candidate query holds the anchor,
     *  gate and visibility terms together, so no anchored governed note can be
     *  excluded by the intersection the FTS/dense arms need. Empty set → no
     *  clause, i.e. this arm unchanged. */
    anchors: MemoryAnchorSet = { modules: [], symbols: [], requested: false }
  ): Promise<MemoryNoteRecord[]> {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8);
    if (tokens.length === 0) {
      return [];
    }

    const visibility = this.visibilityClauses(options);
    const governed = this.governedConditions(options);
    // D6: one query per anchor namespace (or the single unanchored query), merged
    // by note id. Flat in ANCHOR COUNT, which is the decision; ≤2 round trips
    // because there are two namespaces, and 1 for every pre-D4 caller.
    const shapes = anchorQueryShapes(anchors);
    const rowsByArm = await Promise.all(
      shapes.map((shape) =>
        this.execute(
          `MATCH (n:MemoryNote)${shape.pattern}
           WHERE ${[
             ...visibility.conditions,
             ...governed.conditions,
             ...shape.conditions,
           ].join(" AND ")}
           RETURN ${shape.distinct ? "DISTINCT " : ""}${NOTE_RETURN}`,
          { ...visibility.params, ...governed.params, ...shape.params }
        )
      )
    );
    const byId = new Map<string, Row>();
    for (const rows of rowsByArm) {
      for (const row of rows) {
        const id = String(row["n.id"] ?? "");
        if (!byId.has(id)) {
          byId.set(id, row);
        }
      }
    }

    const scored = [...byId.values()]
      .map((row) => noteFromRow(row))
      .map((note) => {
        const haystack = [
          note.text,
          note.kind,
          ...note.topics,
          ...note.modules,
        ]
          .join(" ")
          .toLowerCase();
        const hits = tokens.filter((token) => haystack.includes(token)).length;
        return { note, hits };
      })
      .filter((entry) => entry.hits > 0)
      .sort(
        (a, b) =>
          b.hits - a.hits || b.note.createdAt.localeCompare(a.note.createdAt)
      );

    return scored.slice(0, limit).map((entry) => entry.note);
  }

  /**
   * ADR-0026 §5 — THE WORKSPACE FENCE, and the only place it is stated in Cypher.
   *
   * A memory note belongs to exactly ONE workspace, and that workspace is a
   * canonical absolute repo root DERIVED from authenticated server-side state (an
   * `AgentJobCapability` for an agent, an explicit validated param for the
   * operator). This method turns that coordinate into a `WHERE` term; every
   * candidate query reaches it through `visibilityClauses`, and the one query that
   * cannot (`relatedToTask`, which builds three of its own traversal `WHERE`s)
   * calls it directly rather than restating the rule. Two evaluators of one
   * partition rule is precisely how the chat fence grew its `scope:"global"` hole.
   *
   * It is a NARROWER and can only ever be one:
   *  • ABSENT coordinate → no clause at all, i.e. byte-for-byte today's behaviour.
   *    That is what makes the rollout monotonic (§5) and is why a surface that
   *    forgets the predicate is an unclosed hole rather than a new leak.
   *  • A workspace → `n.workspacePath = $ws`. NULL-workspace notes (the §8
   *    residue) are excluded by construction, because `''` (the mirror's NULL
   *    sentinel) never equals a real absolute path.
   *  • `unscopedWorkspace` → `n.workspacePath = ''`, the §8 residue view and
   *    NOTHING else. Operator-tier only; the route refuses it for an agent.
   *
   * The two powers are SEPARATE FIELDS on purpose. A single field with a reserved
   * `"unscoped"` token would be one value carrying two different authorities — the
   * exact overload §6 rejects for `scope:"global"` — and a path that happened to
   * be spelled that way would silently change meaning.
   *
   * The decision is made HERE, in the candidate query, and nowhere else (§11): it
   * is never re-derived, never relabelled, and never repaired downstream. In
   * particular it must never move into `applyMemoryExpiry`, whose degradation path
   * drops nothing when the ledger is unreadable — safe only because this gate
   * already ran.
   */
  private workspaceCondition(opts?: {
    workspacePath?: string;
    unscopedWorkspace?: boolean;
  }): { conditions: string[]; params: Params } {
    if (opts?.unscopedWorkspace) {
      return { conditions: ["n.workspacePath = ''"], params: {} };
    }
    if (opts?.workspacePath) {
      return {
        conditions: ["n.workspacePath = $workspacePath"],
        params: { workspacePath: opts.workspacePath },
      };
    }
    return { conditions: [], params: {} };
  }

  /**
   * Visibility predicate for retrieval (KG-5). Default (no `asOf`) = the current
   * active set, unchanged from before. With `asOf`, BITEMPORAL travel: a note is
   * visible as-of T iff it was valid AND transaction-recorded at T,
   *   validFrom <= T < (validTo | ∞)  AND  recordedAt(createdAt) <= T
   *                                   AND  retiredAt(invalidatedAt) > T | ∞.
   * ISO-8601 UTC strings compare lexicographically in chronological order, so the
   * comparisons are correct string comparisons; '' encodes an open (null) bound.
   * `scope` is a SOFT filter (D5): when set it restricts to that scope; hosted
   * mode can later hard-gate on it. Returns clauses joined by the caller.
   *
   * R3 TTL: an EXPIRED note (stamped deadline, past, and not redeemed by
   * confirmation / human authorship / high trust) is excluded here, IN the
   * candidate query, so LIMIT applies to the visible set. The ledger remains the
   * source of truth and still post-filters, this is the graph refusing to serve
   * what the ledger would hide.
   *
   * ADR-0026: the WORKSPACE fence is ANDed here too, via `workspaceCondition`.
   * This is the chokepoint the ADR chose deliberately — it is the single term
   * whose addition propagates to all four candidate queries (`memoryAnalytics`,
   * `entityCandidates`, `searchMemoryLexical`, `recallMemory`) at once, which is
   * why the predicate belongs here and is stated exactly once.
   */
  private visibilityClauses(opts?: {
    asOf?: string;
    scope?: string;
    chatId?: string;
    workspacePath?: string;
    unscopedWorkspace?: boolean;
    showExpired?: boolean;
    now?: string;
  }): {
    conditions: string[];
    params: Params;
  } {
    const conditions: string[] = [];
    const params: Params = {};
    // R3 runs BEFORE the as-of branch and is deliberately NOT keyed on it: expiry
    // is measured against the real clock (or an explicit, server-owned `now`), so
    // a bitemporal read can never become a way to see expired memory.
    if (!opts?.showExpired) {
      // The condition and its `$now` binding arrive together and cannot be
      // separated — an unbound `$now` would read every not-yet-due note as
      // expired, which is exactly the silent failure this shape forecloses.
      const expiry = memoryNotExpiredClause(opts?.now);
      conditions.push(expiry.condition);
      Object.assign(params, expiry.params);
    }
    // Defensive normalize (F1): canonical ms-UTC-Z, or fall back to the current
    // active set if the instant is unparseable (the route already rejects those).
    const asOf = opts?.asOf ? normalizeInstant(opts.asOf) : undefined;
    if (asOf) {
      // Pause is a current operator suppression, not a historical fact verdict:
      // time travel may reconstruct a later-rejected note, but never bypass a
      // present pause to put its text back in an agent read.
      conditions.push("n.status <> 'paused'");
      conditions.push("n.validFrom <= $asOf");
      conditions.push("n.createdAt <= $asOf");
      conditions.push("(n.validTo = '' OR n.validTo > $asOf)");
      conditions.push("(n.invalidatedAt = '' OR n.invalidatedAt > $asOf)");
      params.asOf = asOf;
    } else {
      conditions.push("n.status = 'active'");
    }
    if (opts?.scope) {
      conditions.push("n.scope = $scope");
      params.scope = opts.scope;
    }
    // ADR-0026 §5: the WORKSPACE fence, ANDed in FIRST and OUTSIDE the chat
    // clause below, which is what makes `scope:"global"` mean global-across-CHATS
    // within ONE workspace (§6) rather than a cross-repo grant.
    const workspace = this.workspaceCondition(opts);
    conditions.push(...workspace.conditions);
    Object.assign(params, workspace.params);
    // #126 + B6: enforce the partition IN the candidate query so LIMIT applies to
    // the complete visible set. The only cross-chat escape hatch is BOTH
    // scope:"global" AND human-confirmed; an agent-authored unconfirmed global
    // write cannot widen its visibility.
    if (opts?.chatId) {
      // Scope promotion is not yet bitemporal. Keep historical reads strict to
      // the original chat rather than retroactively exposing a note at instants
      // before its promotion.
      conditions.push(
        asOf
          ? "n.chatId = $chatId"
          : "(n.chatId = $chatId OR (n.scope = 'global' AND n.confirmed = true))"
      );
      params.chatId = opts.chatId;
    }
    return { conditions, params };
  }

  /**
   * D4, THE ONE CONJUNCTIVE ENTRY POINT. Every memory read in the product resolves
   * here: `recallMemory`, `recallForGate` and `searchMemory` are thin façades over
   * it, and `GET /api/memory/recall` + `GET /api/memory/search` are thin façades
   * over those.
   *
   * `q` optional × anchors optional, and they COMPOSE:
   *   • anchors are a HARD FILTER on the candidate query (never a rerank input);
   *   • `q` RANKS within that filter.
   * So the four states are all reachable through one function, and the fourth —
   * "what do we know about this file that is relevant to THIS edit" — is the query
   * the dual-graph gate is about and the one that had no expressible form before.
   *
   * PRECISELY WHAT `q` DOES, because the phrase "orders within it" admits a
   * stronger reading than what this does: the four retrieval arms GENERATE
   * candidates from `q` and the anchor set BOUNDS them, so an anchored `q` read is
   * (arms ∩ anchors) ranked by fusion. A note on the anchor that no arm can see for
   * this `q` is not a candidate — exactly as it is not one for an unanchored search.
   * Making the anchored set itself a fifth RRF arm (so every anchored note is a
   * candidate that `q` merely orders) is a NEW RETRIEVAL ARM and would require
   * re-running ADR-0021's ablation; it is deliberately not done here, and D4's own
   * cost column ("the anchor predicate must be pushed into EVERY arm's candidate
   * query") describes the intersection semantics rather than the other reading.
   * `memory-conjunctive-retrieval.test.ts` pins the difference.
   *
   * D6 lives here too: the anchor term is a BATCHED query over
   * `ANCHORED_TO`/`ABOUT_SYMBOL` with a LIST-VALUED parameter — one per anchor
   * NAMESPACE, so a gate read costs the same number of store round trips whether it
   * fences on 1 anchor or 128. It replaced a per-anchor fan-out (`preEditContext`
   * spent ≥257 round trips on a 128-module radius; measured 531 ms → 53 ms at
   * 10 000 notes / 128 anchors).
   *
   * WHAT DOES NOT CHANGE, and it is the point of the façade shape: with no anchors
   * and no `q` this is the pre-D4 `recallMemory` body byte for byte; with one
   * `module` it is the same one-anchor question — `{ module: X }` normalizes to
   * `{ modules: [X] }` — and with a `q` and no anchors it is the pre-D4
   * `searchMemory`. No existing request can change its answer.
   */
  async retrieveMemory(
    request: MemoryRetrievalRequest,
    limit?: number
  ): Promise<MemoryNoteRecord[]> {
    // Singular + plural anchors fold into ONE normalized, deduped, capped set.
    const anchors = normalizeAnchorSet(request);
    // FAIL CLOSED, before any arm runs: a caller that asked for an anchor fence and
    // named none is fenced to NOTHING. Answered here, once, so neither branch below
    // can fall back to an unanchored candidate query — a gate asked about a target
    // with no resolvable module must return nothing, never the whole corpus.
    if (anchorFenceIsEmpty(anchors)) {
      return [];
    }
    const q = (request.q ?? "").trim();
    if (q !== "") {
      // The two branches keep their OWN historical default limit, so a façade that
      // omits it lands exactly where it always did (search 20, recall 50).
      return this.hybridSearch(q, limit ?? 20, anchors, request);
    }
    return this.recallAnchored(request, anchors, limit ?? 50);
  }

  /**
   * The ANCHOR/COORDINATE branch of `retrieveMemory` — the pre-D4 `recallMemory`
   * body, with the single `list_contains` anchor predicate replaced by D6's one
   * batched edge query.
   *
   * THE `LIMIT` IS STILL THE GOVERNED SET'S. Every term (bitemporal `asOf`, TTL
   * expiry, the workspace fence, the chat partition, the trust floor, the
   * confirmed-only gate, and now the anchor set) is evaluated IN this one query,
   * exactly once each, BEFORE `ORDER BY … LIMIT`. Nothing is filtered afterwards
   * except the defence-in-depth `applyGate` net, which can only remove rows the
   * query already admitted.
   */
  private async recallAnchored(
    filter: MemoryRetrievalRequest,
    anchors: MemoryAnchorSet,
    limit: number
  ): Promise<MemoryNoteRecord[]> {
    // R3: one clock for both the query clause and the JS net below.
    const now = resolveExpiryNow(filter.now);
    const visibility = this.visibilityClauses({
      asOf: filter.asOf,
      scope: filter.scope,
      // #126 + B6: chat recall includes its partition plus confirmed global notes.
      chatId: filter.chatId,
      // ADR-0026: and the workspace fence, ANDed outside that global admission.
      // This is the recall that `module`/`symbol` anchors ride, so it is the exact
      // read the ADR was written for — repo A's `src/index.ts` and repo B's were the
      // same anchor predicate and nothing else told them apart. D6 changed the
      // anchor's ACCESS PATH from the array to the edge and this is unaffected:
      // a batched query is a new candidate query, and it reaches the SAME single
      // evaluator through `visibilityClauses` rather than restating the rule.
      workspacePath: filter.workspacePath,
      unscopedWorkspace: filter.unscopedWorkspace,
      showExpired: filter.showExpired,
      now,
    });
    const conditions: string[] = [...visibility.conditions];
    const params: Params = { ...visibility.params };
    if (filter.taskId) {
      conditions.push("n.taskId = $taskId");
      params.taskId = filter.taskId;
    }
    if (filter.laneId) {
      conditions.push("n.laneId = $laneId");
      params.laneId = filter.laneId;
    }
    if (filter.kind) {
      conditions.push("n.kind = $kind");
      params.kind = filter.kind;
    }
    if (filter.outcome) {
      conditions.push("n.outcome = $outcome");
      params.outcome = filter.outcome;
    }
    if (filter.topic) {
      // Topics stay an ARRAY predicate: unlike a module or a symbol, a topic has
      // no primary-keyed node and no edge, so there is no access path to batch.
      conditions.push("list_contains(n.topics, $topic)");
      params.topic = filter.topic;
    }

    // KG-6 gate view (F4): enforce the gate IN the query so LIMIT applies to the
    // governed set, an OLD confirmed note is never dropped in favour of newer
    // ungoverned rows (a completeness fix, not just leak-free). applyGate stays as
    // a defense-in-depth JS net. Absent → unchanged (general recall).
    const governed = this.governedConditions(filter);
    conditions.push(...governed.conditions);
    Object.assign(params, governed.params);

    // The row ceiling. A SINGLE-anchor (or unanchored) recall keeps the pre-D4
    // clamp of 200 exactly, so no existing request can change its answer. A
    // BATCHED anchor request replaces N separate `LIMIT limit` queries with one per
    // namespace, so its ceiling is raised to MAX_ANCHORED_ROWS — the aggregate the
    // fan-out could already return — and the caller states the aggregate it wants
    // (see `preEditContext`). Deliberately NOT unbounded: an unbounded anchored scan
    // is the same materialize-the-table hazard the lexical arm still carries.
    const ceiling = anchorSetSize(anchors) > 1 ? MAX_ANCHORED_ROWS : 200;
    const cap = Math.max(1, Math.min(limit, ceiling));
    // D4 + D6: ONE query per anchor NAMESPACE (or the single unanchored query),
    // each carrying the FULL predicate — every term above, evaluated exactly once,
    // BEFORE its own `ORDER BY … LIMIT`. So each arm's `LIMIT` applies to its own
    // governed, visible, anchored set: nothing ungoverned ever enters the pool for a
    // later filter to remove, which is the completeness property `governedConditions`
    // exists to hold. The arms are then merged by note id and re-ordered, exactly as
    // the per-anchor fan-out this replaces merged its results.
    const shapes = anchorQueryShapes(anchors);
    const rowsByArm = await Promise.all(
      shapes.map((shape) =>
        this.execute(
          `MATCH (n:MemoryNote)${shape.pattern}
           WHERE ${[...conditions, ...shape.conditions].join(" AND ")}
           RETURN ${shape.distinct ? "DISTINCT " : ""}${NOTE_RETURN}
           ORDER BY n.createdAt DESC, n.id ASC
           LIMIT ${cap}`,
          { ...params, ...shape.params }
        )
      )
    );
    const byId = new Map<string, MemoryNoteRecord>();
    for (const rows of rowsByArm) {
      for (const row of rows) {
        const note = noteFromRow(row);
        if (!byId.has(note.id)) {
          byId.set(note.id, note);
        }
      }
    }
    // One arm → already ordered by the store; two arms → re-order the union, so a
    // two-namespace request returns the same newest-first list a one-namespace
    // request does. `localeCompare` on canonical ISO-8601 mirrors the store's
    // lexicographic `ORDER BY n.createdAt DESC, n.id ASC` term for term, tiebreak
    // included — a JS merge that ordered ties differently from the store would make
    // a two-arm answer un-diffable against a one-arm one.
    const notes =
      rowsByArm.length > 1
        ? [...byId.values()].sort(
            (a, b) =>
              b.createdAt.localeCompare(a.createdAt) ||
              a.id.localeCompare(b.id)
          )
        : [...byId.values()];
    return this.applyGate(notes, { ...filter, now }).slice(0, cap);
  }

  /**
   * Coordinate recall: the notes carrying a given anchor / task / lane / topic,
   * newest first. D4: a thin façade over `retrieveMemory` with no `q`.
   */
  async recallMemory(
    filter: MemoryRetrievalRequest,
    limit = 50
  ): Promise<MemoryNoteRecord[]> {
    // `q` is stripped rather than forwarded: this façade's contract is coordinate
    // recall, and a caller that wants text ordering asks `retrieveMemory` (or
    // `searchMemory`) for it. Accepting `q` here silently would give one name two
    // orderings.
    const { q: _q, ...coordinates } = filter;
    return this.retrieveMemory(coordinates, limit);
  }

  /**
   * TODO 4.1 — the STANDING-MEMORY arm: the notes a worker must know
   * regardless of what it is doing, so they ride into every brief
   * unconditionally, independent of any query or anchor. Semantic search
   * structurally cannot retrieve "facts that should be known regardless of
   * what is being asked", and standing memory needs no anchor — which is why
   * this is its own selection (kind × human-confirmed × active), NOT a
   * re-weighting of any retrieval arm and NOT a `retrieveMemory` mode (that
   * façade's anchor fence and hybrid ranking answer a different question).
   *
   * THE POSTURE IS FIXED, not parameterized:
   *  - HUMAN-CONFIRMED ONLY. `governedConditions({governedOnly: true})` with
   *    no crew widening and no trust floor = `n.confirmed = true`, the
   *    human-only flag. An orchestrator vouch here would be a cross-chat
   *    widening of the confirmed-only boundary and needs an ADR first
   *    (TODO 4.1's own constraint) — so there is deliberately no `crewChatId`
   *    parameter to pass.
   *  - CROSSES CHATS ONLY THROUGH THE EXISTING RULE. Standing memory rides
   *    into every chat's brief, so it must cross the chat partition — but it
   *    reuses the ONE cross-chat rule `visibilityClauses` already states
   *    (`scope = 'global' AND confirmed = true`), it does not invent a second
   *    one. That is why `n.scope = 'global'` is ANDed below: a project-scope
   *    confirmed note stays in its chat exactly as it does on every other
   *    read; only a note a human both CONFIRMED and PROMOTED to global is
   *    workspace canon. Widening standing memory to project-scope confirmed
   *    notes would be a real cross-chat authority change and needs an ADR
   *    (it does NOT ship here). No chat coordinate is passed, so the query is
   *    chat-agnostic within that global-confirmed set.
   *  - WORKSPACE-FENCED IN THE CANDIDATE QUERY (ADR-0026 §9): the fence
   *    reaches this new read path through the same single evaluator every
   *    other candidate query uses (`visibilityClauses` → `workspaceCondition`),
   *    never a restatement.
   *  - CURRENT ONLY: active (visibility), not stale, not expired.
   *
   * Kinds default to `constraint` + `convention` — the standing kinds by
   * definition (a decision or an attempt is about something; a constraint or a
   * convention binds everything). Newest-first, bounded; the caller (the
   * route → the runner's brief seeding) applies the char budget (TODO 4.3).
   */
  async standingMemory(options?: {
    workspacePath?: string;
    unscopedWorkspace?: boolean;
    kinds?: readonly string[];
    limit?: number;
  }): Promise<MemoryNoteRecord[]> {
    const limit = Math.max(1, Math.min(options?.limit ?? 64, 256));
    const visibility = this.visibilityClauses({
      workspacePath: options?.workspacePath,
      unscopedWorkspace: options?.unscopedWorkspace,
    });
    const governed = this.governedConditions({ governedOnly: true });
    const kinds = [...(options?.kinds ?? ["constraint", "convention"])];
    const conditions = [
      ...visibility.conditions,
      ...governed.conditions,
      // The existing cross-chat rule, not a new one: canon is the
      // promoted-global confirmed tier. `governedConditions` already added
      // `confirmed = true`; this adds the `scope = 'global'` half.
      "n.scope = 'global'",
      "list_contains($standingKinds, n.kind)",
      "n.stale = false",
    ];
    const rows = await this.execute(
      `MATCH (n:MemoryNote)
       WHERE ${conditions.join(" AND ")}
       RETURN ${NOTE_RETURN}
       ORDER BY n.createdAt DESC
       LIMIT ${limit}`,
      { ...visibility.params, ...governed.params, standingKinds: kinds }
    );
    return rows.map((row) => noteFromRow(row));
  }

  /**
   * Substrate §3.3 — PATH-TRIGGERED standing notes for edit-boundary injection.
   *
   * Distinct from {@link standingMemory}: that arm is anchor-free workspace canon
   * for briefs (`scope = 'global'`). This arm is the PathTrigger shape — human-
   * confirmed (or same-gate-tier) `constraint`/`convention` notes whose
   * module/symbol anchors intersect the preflight radius — so a standing rule
   * about THIS file reaches the preflight result even when the ordinary gate
   * recall's LIMIT starved it. Own selection + own budget; does NOT widen
   * `recallAnchored` / `retrieveMemory`.
   *
   * Gate posture matches the preflight caller's: `governedOnly` via
   * `governedConditions`, optional `crewChatId` / `trustFloor`, workspace fence
   * through `visibilityClauses`. Never invents a second cross-chat rule.
   */
  async pathTriggeredStanding(
    filter: {
      modules: string[];
      symbols?: string[];
      asOf?: string;
      scope?: string;
      chatId?: string;
      workspacePath?: string;
      unscopedWorkspace?: boolean;
      crewChatId?: string;
      trustFloor?: MemoryTrust;
      showExpired?: boolean;
      now?: string;
    },
    options?: { kinds?: readonly string[]; limit?: number }
  ): Promise<MemoryNoteRecord[]> {
    const anchors = normalizeAnchorSet({
      modules: filter.modules,
      symbols: filter.symbols ?? [],
    });
    if (anchorFenceIsEmpty(anchors) || anchorSetSize(anchors) === 0) {
      return [];
    }
    const limit = Math.max(1, Math.min(options?.limit ?? 16, 64));
    const kinds = [...(options?.kinds ?? ["constraint", "convention"])];
    const now = resolveExpiryNow(filter.now);
    const visibility = this.visibilityClauses({
      asOf: filter.asOf,
      scope: filter.scope,
      chatId: filter.chatId,
      workspacePath: filter.workspacePath,
      unscopedWorkspace: filter.unscopedWorkspace,
      showExpired: filter.showExpired,
      now,
    });
    const governed = this.governedConditions({
      governedOnly: true,
      trustFloor: filter.trustFloor,
      crewChatId: filter.crewChatId,
    });
    const conditions = [
      ...visibility.conditions,
      ...governed.conditions,
      "list_contains($pathStandingKinds, n.kind)",
    ];
    const params: Params = {
      ...visibility.params,
      ...governed.params,
      pathStandingKinds: kinds,
    };
    const shapes = anchorQueryShapes(anchors);
    const rowsByArm = await Promise.all(
      shapes.map((shape) =>
        this.execute(
          `MATCH (n:MemoryNote)${shape.pattern}
           WHERE ${[...conditions, ...shape.conditions].join(" AND ")}
           RETURN ${shape.distinct ? "DISTINCT " : ""}${NOTE_RETURN}
           ORDER BY n.createdAt DESC, n.id ASC
           LIMIT ${limit}`,
          { ...params, ...shape.params }
        )
      )
    );
    const byId = new Map<string, MemoryNoteRecord>();
    for (const rows of rowsByArm) {
      for (const row of rows) {
        const note = noteFromRow(row);
        if (!byId.has(note.id)) {
          byId.set(note.id, note);
        }
      }
    }
    const notes =
      rowsByArm.length > 1
        ? [...byId.values()].sort(
            (a, b) =>
              b.createdAt.localeCompare(a.createdAt) ||
              a.id.localeCompare(b.id)
          )
        : [...byId.values()];
    return this.applyGate(notes, {
      governedOnly: true,
      trustFloor: filter.trustFloor,
      crewChatId: filter.crewChatId,
      showExpired: filter.showExpired,
      now: filter.now,
    }).slice(0, limit);
  }

  /**
   * The hero's GATE-READ (KG-6 / P2.5 `preEditContext`): recall restricted to
   * GOVERNED notes only, human-confirmed, or (with a `trustFloor`) trust ≥ floor.
   * A thin, self-documenting wrapper over `retrieveMemory({ ..., governedOnly })`
   * so the gate can call it directly; a hostile low-trust unconfirmed write can
   * never enter this view. Defaults to confirmed-only (the strictest gate).
   *
   * D4/D6: it takes the FULL retrieval request, so the gate can hand it a whole
   * blast radius (`modules: [...]`) — and a `q` — and still get exactly this gate.
   * The gate posture is applied AFTER the spread, so no field of a wider caller
   * object can turn `governedOnly` off by riding in.
   */
  async recallForGate(
    filter: MemoryRetrievalRequest,
    opts?: { trustFloor?: MemoryTrust; limit?: number }
  ): Promise<MemoryNoteRecord[]> {
    return this.retrieveMemory(
      { ...filter, governedOnly: true, trustFloor: opts?.trustFloor },
      opts?.limit ?? 50
    );
  }

  async getMemoryNote(noteId: string): Promise<MemoryNoteRecord | null> {
    const rows = await this.execute(
      `MATCH (n:MemoryNote {id: $id})
       RETURN ${NOTE_RETURN}`,
      { id: noteId }
    );
    return rows.length > 0 ? noteFromRow(rows[0]!) : null;
  }

  async updateMemoryNote(
    noteId: string,
    update: MemoryNoteUpdate
  ): Promise<MemoryNoteRecord | null> {
    const existing = await this.getMemoryNote(noteId);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();

    // Text edits create history: a new note supersedes the old one, the old
    // note is invalidated but kept (Graphiti-style temporal validity).
    if (update.text !== undefined && update.text !== existing.text) {
      const successor = await this.addMemoryNote({
        kind: existing.kind,
        text: update.text,
        taskId: existing.taskId ?? undefined,
        laneId: existing.laneId ?? undefined,
        modules: existing.modules,
        topics: existing.topics,
        symbols: existing.symbols,
        trust: update.trust ?? existing.trust,
        createdBy: existing.createdBy,
      });
      if (update.confirmed !== undefined) {
        await this.execute(
          `MATCH (n:MemoryNote {id: $id}) SET n.confirmed = $confirmed`,
          { id: successor.id, confirmed: update.confirmed }
        );
      }
      await this.execute(
        `MATCH (n:MemoryNote {id: $id})
         SET n.invalidatedAt = $now, n.invalidatedBy = 'superseded',
             n.supersededBy = $successorId, n.status = 'rejected',
             n.updatedAt = $now`,
        { id: noteId, now, successorId: successor.id }
      );
      await this.execute(
        `MATCH (a:MemoryNote {id: $successorId}), (b:MemoryNote {id: $id})
         CREATE (a)-[:SUPERSEDES]->(b)`,
        { successorId: successor.id, id: noteId }
      ).catch(() => undefined);
      return this.getMemoryNote(successor.id);
    }

    const sets: string[] = ["n.updatedAt = $updatedAt"];
    const params: Params = { id: noteId, updatedAt: now };

    if (update.confirmed !== undefined) {
      sets.push("n.confirmed = $confirmed");
      params.confirmed = update.confirmed;
      if (update.confirmed) {
        // Human confirmation clears suspicion.
        sets.push("n.stale = false", "n.staleSince = ''");
      }
    }
    if (update.trust !== undefined) {
      sets.push("n.trust = $trust");
      params.trust = update.trust;
    }
    if (update.status !== undefined) {
      // Rejection keeps the row (traceable removal) but hides it from recall.
      sets.push("n.status = $status");
      params.status = update.status;
      if (update.status === "rejected") {
        sets.push("n.invalidatedAt = $updatedAt", "n.invalidatedBy = 'human'");
      } else {
        sets.push("n.invalidatedAt = ''", "n.invalidatedBy = ''");
      }
    }

    await this.execute(
      `MATCH (n:MemoryNote {id: $id}) SET ${sets.join(", ")}`,
      params
    );
    return this.getMemoryNote(noteId);
  }

  /**
   * Traversal recall: everything the brain knows around a task, notes about
   * the task itself, notes anchored to modules the task touched, and notes
   * written by lanes that worked on it.
   *
   * KG-6 F3: takes the SAME gate options as recall/search, so P2.5's
   * `preEditContext` can compose task-traversal INTO the gate. With
   * `governedOnly`, a hostile low-trust note reachable via traversal is excluded
   * from the final list (the gate applies AFTER fusion, like every other path).
   */
  async relatedToTask(
    taskId: string,
    limit = 50,
    opts?: {
      governedOnly?: boolean;
      trustFloor?: MemoryTrust;
      chatId?: string;
      // ADR-0026: the workspace fence. NOT optional-in-spirit — this traversal is
      // what seeds every worker's brief (`recallRelatedToTask` in the runner
      // preamble), so a forgotten term here puts another repo's memory into an
      // agent's opening context.
      workspacePath?: string;
      unscopedWorkspace?: boolean;
      crewChatId?: string;
      // R3 TTL: expired notes are dropped by the applyGate net below (this query
      // builds its own WHERE and never sees `visibilityClauses`), so the opt-in
      // has to travel here too or an operator's "show expired" would be a no-op
      // on the traversal recall path.
      showExpired?: boolean;
      now?: string;
    }
  ): Promise<MemoryNoteRecord[]> {
    // #126 + B6: each hop stays in-chat, except for an explicitly promoted,
    // human-confirmed global note. Unconfirmed-global and ordinary cross-chat
    // notes remain outside the traversal.
    const chatClause = opts?.chatId
      ? " AND (n.chatId = $chatId OR (n.scope = 'global' AND n.confirmed = true))"
      : "";
    // ADR-0026: this query cannot use `visibilityClauses` (three traversal MATCHes,
    // each with its own WHERE), so it CALLS the one workspace evaluator rather than
    // restating the rule — the same delegate-never-restate posture `passesGate`
    // takes towards `memoryPassesGate`. ANDed outside `chatClause`, so a promoted
    // global note still cannot cross a repo boundary here either.
    const workspace = this.workspaceCondition(opts);
    const workspaceClause = workspace.conditions
      .map((condition) => ` AND ${condition}`)
      .join("");
    const params: Params = { taskId, ...workspace.params };
    if (opts?.chatId) {
      params.chatId = opts.chatId;
    }
    // KG-12: the `centralityByNote` round-trip is gone here too — the prior it
    // fed is no longer read by the calibrated ranker.
    const [aboutTask, viaModules, viaLanes] = await Promise.all([
      this.execute(
        `MATCH (n:MemoryNote)-[:ABOUT_TASK]->(t:TaskNode {id: $taskId})
         WHERE n.status = 'active'${workspaceClause}${chatClause}
         RETURN ${NOTE_RETURN}`,
        params
      ),
      this.execute(
        `MATCH (t:TaskNode {id: $taskId})-[:TOUCHED]->(m:Module)<-[:ANCHORED_TO]-(n:MemoryNote)
         WHERE n.status = 'active'${workspaceClause}${chatClause}
         RETURN ${NOTE_RETURN}`,
        params
      ),
      this.execute(
        `MATCH (l:LaneNode)-[:WORKED_ON]->(t:TaskNode {id: $taskId}),
               (n:MemoryNote)-[:BY_LANE]->(l)
         WHERE n.status = 'active'${workspaceClause}${chatClause}
         RETURN ${NOTE_RETURN}`,
        params
      ),
    ]);

    // Anchor proximity (Graphiti node-distance rerank, lite): a note ABOUT
    // the task is closest, anchored to a touched module is mid, written by a
    // lane that worked here is furthest. Closer anchors → higher relevance.
    const proximity = new Map<string, number>();
    const bump = (rows: Row[], score: number) => {
      for (const row of rows) {
        const id = String(row["n.id"] ?? row["id"]);
        proximity.set(id, Math.max(proximity.get(id) ?? 0, score));
      }
    };
    bump(viaLanes, 0.5);
    bump(viaModules, 0.8);
    bump(aboutTask, 1);

    const seen = new Set<string>();
    const inputs: RankInput[] = [];
    for (const row of [...aboutTask, ...viaModules, ...viaLanes]) {
      const note = noteFromRow(row);
      if (!seen.has(note.id)) {
        seen.add(note.id);
        inputs.push({ note, relevance: proximity.get(note.id) ?? 0.5 });
      }
    }

    // KG-4 calibrated re-rank: graph-proximity relevance fused with bounded
    // governance (recency/trust/confirmed/usage) + suspect/contradiction demotion
    //, the notes that most matter for THIS task first. Reinforcement is OFF the
    // read path (KG-2): recall reads accessCount but never writes it; explicit use
    // is signalled via markMemoryUsed. KG-6 F3: gate the FINAL list when requested.
    return this.applyGate(rerankCalibrated(inputs), opts).slice(0, limit);
  }

  // ---- routing ----

  async laneOutcomeStats(
    taskId?: string,
    text?: string
  ): Promise<LaneOutcomeStats[]> {
    const lanes = await this.query(
      `MATCH (l:LaneNode) RETURN l.id, l.laneKey, l.name`
    );

    // Modules the target task touches, for familiarity scoring.
    const taskModules = new Set<string>();
    if (taskId) {
      const rows = await this.execute(
        `MATCH (t:TaskNode {id: $taskId})-[:TOUCHED]->(m:Module)
         RETURN m.path AS path`,
        { taskId }
      ).catch(() => [] as Row[]);
      for (const row of rows) {
        taskModules.add(String(row.path));
      }
    }

    // Topic overlap (routing v2): before a task exists (planning), the
    // request text can still be matched against note topics per lane.
    const loweredText = text?.toLowerCase() ?? "";

    const stats: LaneOutcomeStats[] = [];
    for (const laneRow of lanes) {
      const laneId = String(laneRow["l.id"]);
      const rows = await this.execute(
        `MATCH (l:LaneNode {id: $laneId})-[w:WORKED_ON]->(t:TaskNode)
         RETURN w.state AS state, w.startedAt AS startedAt,
                w.completedAt AS completedAt, w.blockedCount AS blockedCount`,
        { laneId }
      );

      // Module familiarity: distinct modules this lane's tasks touched, and
      // overlap with the target task's modules when known.
      const touchedRows = await this.execute(
        `MATCH (l:LaneNode {id: $laneId})-[:WORKED_ON]->(t:TaskNode)-[:TOUCHED]->(m:Module)
         RETURN DISTINCT m.path AS path`,
        { laneId }
      ).catch(() => [] as Row[]);
      const laneModules = touchedRows.map((row) => String(row.path));
      const familiarModules =
        taskModules.size > 0
          ? laneModules.filter((path) => taskModules.has(path)).length
          : 0;

      let topicMatches = 0;
      if (loweredText.length >= 3) {
        const topicRows = await this.execute(
          `MATCH (n:MemoryNote)-[:BY_LANE]->(l:LaneNode {id: $laneId})
           WHERE n.status = 'active'
           RETURN n.topics AS topics`,
          { laneId }
        ).catch(() => [] as Row[]);
        const matched = new Set<string>();
        for (const row of topicRows) {
          for (const topic of (row.topics as string[]) ?? []) {
            const lowered = topic.toLowerCase();
            if (lowered.length >= 3 && loweredText.includes(lowered)) {
              matched.add(lowered);
            }
          }
        }
        topicMatches = matched.size;
      }

      let completions = 0;
      let blocked = 0;
      let durationTotal = 0;
      let durationSamples = 0;
      let lastActivityAt: string | null = null;

      for (const row of rows) {
        const state = String(row.state ?? "");
        const startedAt = String(row.startedAt ?? "");
        const completedAt = String(row.completedAt ?? "");
        blocked += Number(row.blockedCount ?? 0);
        if (state === "completed") {
          completions += 1;
          if (startedAt && completedAt) {
            const duration =
              new Date(completedAt).getTime() - new Date(startedAt).getTime();
            if (Number.isFinite(duration) && duration >= 0) {
              durationTotal += duration;
              durationSamples += 1;
            }
          }
        }
        const activity = completedAt || startedAt;
        if (activity && (!lastActivityAt || activity > lastActivityAt)) {
          lastActivityAt = activity;
        }
      }

      stats.push({
        laneId,
        laneKey: String(laneRow["l.laneKey"]),
        laneName: String(laneRow["l.name"]),
        assignments: rows.length,
        completions,
        blocked,
        averageDurationMs:
          durationSamples > 0 ? durationTotal / durationSamples : null,
        lastActivityAt,
        modulesTouched: laneModules.length,
        familiarModules,
        topicMatches,
      });
    }

    return stats;
  }

  async suggestLanes(taskId?: string, text?: string): Promise<LaneSuggestion[]> {
    return rankLanes(await this.laneOutcomeStats(taskId, text));
  }
}
