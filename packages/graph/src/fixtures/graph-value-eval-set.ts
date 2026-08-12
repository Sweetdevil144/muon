import type {
  EvalNote,
  EvalQuery,
  EvalTask,
  GraphValueEvalSet,
} from "../graph-value-eval.js";

/**
 * KG-12 graph-value corpus. Committed, deterministic, network-free.
 *
 * HOW IT WAS BUILT (read this before trusting any number below):
 *  1. ANCHORS ARE REAL. Every `modules`/`symbols` value is a path or `<module>#
 *     <name>` id that exists in this repository. Nothing is invented, so the
 *     note↔module graph has the shape MUON actually produces.
 *  2. CONTENT IS REPO-DERIVED, NOT USER DATA. Each note paraphrases an
 *     engineering fact that is visible in this repo (CLAUDE.md invariants, the
 *     consumer-readiness plan, the KG-3..KG-6 comments in muon-graph.ts /
 *     memory-ranking.ts, adapter gotchas). The founder's real local brain
 *     (~/Library/Application Support/MUON) was DELIBERATELY NOT READ: it is
 *     private local data, and copying it into a committed fixture would be an
 *     egress of exactly the kind MUON's invariants forbid. The consequence is
 *     stated plainly in the honesty string: this corpus has structural realism,
 *     NOT distributional fidelity to real usage.
 *  3. HOT MODULES CARRY NOISE ON PURPOSE. Real memory piles up on a few files.
 *     `muon-graph.ts` carries seven notes and `preedit.ts` six, most of which are
 *     IRRELEVANT to any given query about them. Omitting that pile-up is the
 *     single easiest way to make traversal look free, so it is not omitted.
 *  4. CONCEPT VECTORS ARE ASSIGNED FROM SUBJECT MATTER ONLY. The `concepts`
 *     mixture (the stand-in for a dense embedding) describes what a note is
 *     ABOUT. It is never adjusted to make a graph neighbour close (which would
 *     hand traversal's win to the dense arm) or far (which would manufacture
 *     traversal headroom).
 *  5. LABELS ARE GRADED BY CONTENT, NOT BY GRAPH POSITION. 3 = answers the
 *     question, 2 = would change what the agent does, 1 = useful context, 0 =
 *     irrelevant. The one deliberate exception is the `edit-intent` class, where
 *     the task itself is "what must I know before touching file X" — there the
 *     ground truth genuinely IS the notes anchored to X. That class therefore
 *     rewards anchor-aware retrieval BY DEFINITION, which is why it is reported
 *     as its own capability row rather than blended into one headline number.
 *
 * WHAT THIS CORPUS CANNOT TELL YOU: how often each capability class occurs in
 * real agent traffic. The mix here (6 lexical/paraphrase, 2 anchor-named, 3
 * edit-intent, 1 lineage, 1 contradiction) is a judgement call, so the harness
 * reports per-class numbers and the aggregate side by side.
 */

// ---- real repo coordinates ------------------------------------------------

const PREEDIT = "backend/src/lib/preedit.ts";
const GRAPH = "packages/graph/src/muon-graph.ts";
const RANKING = "packages/graph/src/memory-ranking.ts";
const ROLE = "backend/src/lib/dispatch-role.ts";
const DISPATCH = "backend/src/routes/dispatch.ts";
const CURSOR = "packages/adapters/src/cursor-adapter.ts";
const CODEX = "packages/adapters/src/codex-adapter.ts";
const READINESS = "packages/adapters/src/vendor-readiness.ts";
const RECORDER = "packages/core/src/stream-recorder.ts";
const DB = "backend/src/lib/db.ts";
const MEMORY_UI = "apps/desktop/src/renderer/memory-workspace.tsx";
const CODEGRAPH = "backend/src/lib/codegraph.ts";
const BUILDER = "apps/desktop/electron-builder.yml";

const SYM_RERANK = `${RANKING}#rerankCalibrated`;
const SYM_DEDUP = `${RANKING}#classifyIncomingNote`;
const SYM_NEIGHBORS = `${GRAPH}#memoryNeighbors`;
const SYM_PREEDIT = `${PREEDIT}#preEditContext`;

const CHAT_BRAIN = "chat-brain";
const CHAT_FLEET = "chat-fleet";
const CHAT_SHIP = "chat-ship";

/** Concept basis for the stand-in dense space. Fixed order. */
export const GRAPH_VALUE_CONCEPTS = [
  "gate",
  "memory",
  "dispatch",
  "vendor",
  "packaging",
  "streaming",
  "codegraph",
  "budget",
  "storage",
  "ui",
];

export const GRAPH_VALUE_EVAL_NOW = "2026-07-25T00:00:00.000Z";

const TASKS: EvalTask[] = [
  {
    id: "task-brain",
    modules: [GRAPH, RANKING, PREEDIT],
    laneId: "lane-claude",
    approvalId: "approval-brain",
  },
  {
    id: "task-fleet",
    modules: [ROLE, DISPATCH],
    laneId: "lane-codex",
    approvalId: "approval-fleet",
  },
  { id: "task-ship", modules: [BUILDER, DB], laneId: "lane-cursor" },
];

// ---- the notes ------------------------------------------------------------

const NOTES: EvalNote[] = [
  // ── gate / governance (chat-brain, anchored on preedit.ts) ───────────────
  {
    id: "n-gate-confirmed-only",
    kind: "decision",
    text: "The pre-edit gate returns confirmed-only memory: an unconfirmed agent note never enters the governed slice a lane receives.",
    modules: [PREEDIT],
    symbols: [SYM_PREEDIT],
    taskId: "task-brain",
    laneId: "lane-claude",
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 12,
    concepts: { gate: 1, memory: 0.5 },
  },
  {
    id: "n-gate-crew-visible",
    kind: "decision",
    text: "Crew-visible admission lets a same-chat unconfirmed note reach the next agent in that chat without ever setting the human confirmed flag.",
    modules: [PREEDIT, GRAPH],
    taskId: "task-brain",
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 9,
    concepts: { gate: 1, memory: 0.5 },
  },
  {
    id: "n-gate-sidechannel",
    kind: "constraint",
    text: "Every content-bearing field on an agent surface has to sit behind the same governed gate; a proposal field slipped prose past it twice.",
    modules: [PREEDIT],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 30,
    concepts: { gate: 1, memory: 0.3 },
  },
  {
    id: "n-gate-fails-closed",
    kind: "constraint",
    text: "Human gates fail closed: an unreachable approval blocks the merge instead of letting it through.",
    modules: [PREEDIT],
    taskId: "task-brain",
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 45,
    concepts: { gate: 1 },
  },
  {
    id: "n-trust-floor",
    kind: "decision",
    text: "A high trust floor still excludes medium-trust agent notes from a gate view even while crew visibility is switched on: that is the operator kill switch.",
    modules: [PREEDIT, GRAPH],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 8,
    concepts: { gate: 0.9, memory: 0.4 },
  },
  {
    id: "n-preedit-anchor-fanout",
    kind: "decision",
    text: "The gate fans out one governed recall per anchor module and per exact symbol, capped by a maximum anchor count so a huge blast radius cannot stall it.",
    modules: [PREEDIT, CODEGRAPH],
    symbols: [SYM_PREEDIT],
    taskId: "task-brain",
    principal: "agent:claude",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 6,
    concepts: { gate: 0.8, codegraph: 0.7, memory: 0.5 },
  },

  // ── the contradiction pair (both stay active, ranker demotes both) ────────
  {
    id: "n-autoconfirm-on",
    kind: "decision",
    text: "Agent memory ought to be auto confirmed so the following lane picks it up with no human step in between.",
    modules: [PREEDIT],
    principal: "agent:codex",
    trust: "medium",
    confirmed: false,
    chatId: CHAT_BRAIN,
    ageDays: 4,
    concepts: { gate: 1, memory: 0.6 },
    contradicts: "n-autoconfirm-never",
  },
  {
    id: "n-autoconfirm-never",
    kind: "constraint",
    text: "Never auto confirm agent memory: confirmation is a human act, and the operator switch stays off by default.",
    modules: [PREEDIT],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 20,
    concepts: { gate: 1, memory: 0.6 },
  },

  // ── memory graph internals (chat-brain, anchored on muon-graph.ts) ───────
  {
    id: "n-traversal-coordinates",
    kind: "constraint",
    text: "Bounded traversal exposes coordinates only; note prose appears solely for a confirmed node or a same-chat crew-visible one.",
    modules: [GRAPH],
    symbols: [SYM_NEIGHBORS],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 14,
    concepts: { memory: 1, gate: 0.8 },
  },
  {
    id: "n-fts-text-only",
    kind: "attempt",
    text: "The full text index covers the note text column and nothing else, so module and topic anchors are matched by the lexical scan instead.",
    modules: [GRAPH],
    principal: "agent:claude",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 11,
    concepts: { memory: 1 },
  },
  {
    id: "n-bitemporal-asof",
    kind: "decision",
    text: "An as-of read uses the temporal lexical scan alone, because both the text index and the dense tier only ever see the current active set.",
    modules: [GRAPH],
    principal: "agent:claude",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 16,
    concepts: { memory: 0.9, storage: 0.3 },
  },
  {
    id: "n-graph-boot-probe",
    kind: "attempt",
    text: "Probe the embedded store in a child process at boot; a segfaulting database used to crash loop the whole desktop app.",
    modules: [GRAPH],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 50,
    concepts: { memory: 0.5, storage: 0.7 },
  },
  {
    id: "n-reinforce-off-read",
    kind: "constraint",
    text: "Reads never turn into writes: a search may read the access count for ranking, but only an explicit used signal increments it.",
    modules: [GRAPH, RANKING],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 22,
    concepts: { memory: 1 },
  },
  {
    id: "n-analytics-coordinates",
    kind: "constraint",
    text: "Memory analytics consumes note ids and module paths only; no note prose enters the centrality surface.",
    modules: [GRAPH],
    principal: "agent:claude",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 13,
    concepts: { memory: 1, gate: 0.4 },
  },
  {
    id: "n-schema-migrate-besteffort",
    kind: "attempt",
    text: "Migrations run best effort at init: a failed migration statement must never block startup of the local brain.",
    modules: [GRAPH],
    principal: "agent:codex",
    trust: "medium",
    confirmed: false,
    chatId: CHAT_BRAIN,
    ageDays: 7,
    concepts: { memory: 0.5, storage: 0.7 },
  },
  {
    id: "n-note-id-prefix",
    kind: "convention",
    text: "Every note identifier carries a mem prefix followed by a random uuid.",
    modules: [GRAPH],
    principal: "agent:codex",
    trust: "low",
    confirmed: false,
    chatId: CHAT_BRAIN,
    ageDays: 40,
    concepts: { memory: 0.8, storage: 0.2 },
  },

  // ── ranking / dedup (chat-brain, anchored on memory-ranking.ts) ──────────
  {
    id: "n-rank-governance-cap",
    kind: "decision",
    text: "Governance is a bounded bonus capped at 0.55, so a confirmed decision can win a near tie but can never overturn a clear relevance gap.",
    modules: [RANKING],
    symbols: [SYM_RERANK],
    taskId: "task-brain",
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 18,
    concepts: { memory: 1 },
  },
  {
    id: "n-rank-demotion-tier",
    kind: "decision",
    text: "Contradicted and suspect notes form a strictly lower band: they surface as warnings underneath every clean note rather than being hidden.",
    modules: [RANKING],
    symbols: [SYM_RERANK],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 18,
    concepts: { memory: 1 },
  },
  {
    id: "n-dedup-lexical-floor",
    kind: "constraint",
    text: "A destructive merge needs lexical corroboration: dense cosine on its own must never retire an existing note.",
    modules: [RANKING],
    symbols: [SYM_DEDUP],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 25,
    concepts: { memory: 1 },
  },
  {
    id: "n-usage-decay",
    kind: "decision",
    text: "Reinforcement decays on a thirty day half life so lifetime popularity stops outranking recent usefulness.",
    modules: [RANKING],
    principal: "agent:claude",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 21,
    concepts: { memory: 1 },
  },

  // ── dispatch / roles (chat-fleet) ────────────────────────────────────────
  {
    id: "n-tier-subtraction",
    kind: "attempt",
    text: "Never define a forbidden capability tier as the superset minus the allowed set: adding one more tier silently turns it into a forbidden one.",
    modules: [ROLE],
    taskId: "task-fleet",
    laneId: "lane-codex",
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_FLEET,
    ageDays: 3,
    concepts: { dispatch: 1 },
  },
  {
    id: "n-delegate-launch-broke",
    kind: "attempt",
    text: "The delegate role stopped launching entirely once a fresh tier landed in the shared capability enum.",
    modules: [ROLE],
    taskId: "task-fleet",
    principal: "agent:codex",
    trust: "medium",
    confirmed: false,
    chatId: CHAT_FLEET,
    ageDays: 3,
    concepts: { dispatch: 1 },
  },
  {
    id: "n-role-allowlist",
    kind: "decision",
    text: "Dispatch roles are an explicit allowlist: each new role is added deliberately and never derived from another set.",
    modules: [ROLE],
    taskId: "task-fleet",
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_FLEET,
    ageDays: 5,
    concepts: { dispatch: 1 },
  },
  {
    id: "n-budget-cap-spread",
    kind: "attempt",
    text: "A spread of the wider options object quietly re-widened the reconcile ceiling; a bounded surface has to constrain every authority field it copies.",
    modules: [DISPATCH],
    taskId: "task-fleet",
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_FLEET,
    ageDays: 4,
    concepts: { budget: 1, dispatch: 0.8 },
  },
  {
    id: "n-permission-mode-leak",
    kind: "attempt",
    text: "The orchestrator permission mode leaked through an object spread and widened what a worker was allowed to do.",
    modules: [DISPATCH],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_FLEET,
    ageDays: 4,
    concepts: { budget: 0.5, dispatch: 0.9 },
  },
  {
    id: "n-superagent-no-lane",
    kind: "decision",
    text: "The root orchestrator sits above the fleet and never consumes a lane or a budget of its own.",
    modules: [DISPATCH],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_FLEET,
    ageDays: 10,
    concepts: { dispatch: 1, budget: 0.5 },
  },
  {
    id: "n-governed-parity",
    kind: "constraint",
    text: "A governed write has to send the identical governed payload from the terminal, the text interface and the desktop; one surface drifted to an ungoverned call.",
    modules: [DISPATCH, MEMORY_UI],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_FLEET,
    ageDays: 2,
    concepts: { dispatch: 0.6, gate: 0.8, ui: 0.5 },
  },
  {
    id: "n-stale-port",
    kind: "convention",
    text: "The local brain listens on port 4177 during development.",
    modules: [DISPATCH],
    principal: "agent:codex",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_FLEET,
    ageDays: 200,
    stale: true,
    concepts: { dispatch: 0.4, storage: 0.4 },
  },

  // ── vendor adapters (chat-fleet), incl. a real supersede chain ───────────
  {
    id: "n-readiness-installed",
    kind: "decision",
    text: "Vendor readiness means the command line binary is present on the machine.",
    modules: [READINESS],
    principal: "agent:codex",
    trust: "medium",
    confirmed: false,
    chatId: CHAT_FLEET,
    ageDays: 60,
    concepts: { vendor: 1 },
    supersededBy: "n-readiness-auth",
  },
  {
    id: "n-readiness-auth",
    kind: "decision",
    text: "Vendor readiness means the binary is present and the user is logged in: probe each vendor with its own auth check.",
    modules: [READINESS],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_FLEET,
    ageDays: 28,
    concepts: { vendor: 1 },
  },
  {
    id: "n-cursor-rc0",
    kind: "attempt",
    text: "cursor-agent returns exit code zero while logged out, so readiness can never be inferred from the exit status alone.",
    modules: [CURSOR, READINESS],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_FLEET,
    ageDays: 15,
    concepts: { vendor: 1 },
  },
  {
    id: "n-codex-oss-leak",
    kind: "attempt",
    text: "The codex oss flag inherits ambient configuration and will silently download a missing default model.",
    modules: [CODEX],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_FLEET,
    ageDays: 15,
    concepts: { vendor: 1 },
  },
  {
    id: "n-byo-auth",
    kind: "constraint",
    text: "Never custody a vendor token: drive the binary the user already installed, and fall back only to a key the user supplies.",
    modules: [CURSOR, CODEX],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_FLEET,
    ageDays: 35,
    concepts: { vendor: 1, gate: 0.3 },
  },
  {
    id: "n-vendor-breadth-hedge",
    kind: "decision",
    text: "Multi vendor breadth is a hedge: any single vendor can ban subscription auth without warning.",
    modules: [READINESS],
    principal: "agent:claude",
    trust: "medium",
    confirmed: false,
    chatId: CHAT_FLEET,
    ageDays: 33,
    concepts: { vendor: 1 },
  },

  // ── streaming (chat-fleet) ───────────────────────────────────────────────
  {
    id: "n-stream-truncate",
    kind: "decision",
    text: "Stream chunks are truncated at a fixed ceiling and the overflow is recorded as a counter, never dropped in silence.",
    modules: [RECORDER],
    principal: "agent:claude",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_FLEET,
    ageDays: 17,
    concepts: { streaming: 1 },
  },
  {
    id: "n-stream-backpressure",
    kind: "attempt",
    text: "A slow consumer used to stall the recorder, so the writer now buffers and flushes on an interval.",
    modules: [RECORDER],
    principal: "agent:claude",
    trust: "medium",
    confirmed: false,
    chatId: CHAT_FLEET,
    ageDays: 17,
    concepts: { streaming: 1 },
  },

  // ── storage + packaging + ui (chat-ship) ─────────────────────────────────
  {
    id: "n-sqlite-json",
    kind: "attempt",
    text: "The embedded provider has no native json column, so each such field is persisted as text and parsed at the boundary.",
    modules: [DB],
    taskId: "task-ship",
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_SHIP,
    ageDays: 26,
    concepts: { storage: 1 },
  },
  {
    id: "n-updatemany-atomic",
    kind: "constraint",
    text: "Conditional updateMany is the atomic primitive here; a read then write race double applied a spend limit once.",
    modules: [DB],
    taskId: "task-ship",
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_SHIP,
    ageDays: 24,
    concepts: { storage: 1, budget: 0.4 },
  },
  {
    id: "n-unsigned-dmg",
    kind: "decision",
    text: "Ship an unsigned disk image plus a Homebrew cask for the first release; notarization is wired but switched off.",
    modules: [BUILDER],
    taskId: "task-ship",
    laneId: "lane-cursor",
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_SHIP,
    ageDays: 19,
    concepts: { packaging: 1 },
  },
  {
    id: "n-universal-build",
    kind: "decision",
    text: "The disk image is a universal build so it runs on both Apple silicon and Intel hardware.",
    modules: [BUILDER],
    taskId: "task-ship",
    principal: "agent:cursor",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_SHIP,
    ageDays: 19,
    concepts: { packaging: 1 },
  },
  {
    id: "n-memory-workspace-explain",
    kind: "decision",
    text: "The desktop memory workspace shows the provenance path and the contradiction list beside every note it renders.",
    modules: [MEMORY_UI],
    principal: "agent:cursor",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_SHIP,
    ageDays: 12,
    concepts: { ui: 1, memory: 0.6 },
  },
  {
    id: "n-empty-states",
    kind: "convention",
    text: "Every panel needs an explicit empty, loading and error state before it is allowed to ship.",
    modules: [MEMORY_UI],
    principal: "agent:cursor",
    trust: "medium",
    confirmed: false,
    chatId: CHAT_SHIP,
    ageDays: 23,
    concepts: { ui: 1 },
  },

  // ── code graph (chat-brain) ──────────────────────────────────────────────
  {
    id: "n-impact-before-edit",
    kind: "constraint",
    text: "Run impact analysis before editing an exported symbol and report the blast radius; a high risk verdict is never ignored.",
    modules: [CODEGRAPH],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 29,
    concepts: { codegraph: 1 },
  },
  {
    id: "n-local-provider-default",
    kind: "decision",
    text: "The code graph provider defaults to a local implementation with no egress at all.",
    modules: [CODEGRAPH],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_BRAIN,
    ageDays: 27,
    concepts: { codegraph: 1, gate: 0.3 },
  },
];

// ---- the labeled queries --------------------------------------------------

const QUERIES: EvalQuery[] = [
  {
    id: "q-lex-gate",
    capability: "lexical",
    text: "confirmed only gate unconfirmed agent note",
    concepts: { gate: 1, memory: 0.4 },
    labels: {
      "n-gate-confirmed-only": 3,
      "n-gate-crew-visible": 2,
      "n-trust-floor": 2,
      "n-autoconfirm-never": 2,
      "n-gate-sidechannel": 1,
      "n-traversal-coordinates": 1,
    },
    rationale:
      "Direct question about the gate's admission rule. The crew-visible and trust-floor notes change what an agent would do about it (2); the side-channel and traversal notes are adjacent context (1).",
  },
  {
    id: "q-lex-governance-cap",
    capability: "lexical",
    text: "governance bonus cap in the calibrated ranker",
    concepts: { memory: 1 },
    labels: {
      "n-rank-governance-cap": 3,
      "n-rank-demotion-tier": 2,
      "n-usage-decay": 1,
    },
    rationale:
      "The cap note answers it. The demotion tier is the other half of the same ranking contract (2); usage decay is a neighbouring knob (1).",
  },
  {
    id: "q-lex-cursor-exit",
    capability: "lexical",
    text: "cursor-agent exit code while logged out",
    concepts: { vendor: 1 },
    labels: {
      "n-cursor-rc0": 3,
      "n-readiness-auth": 2,
      "n-byo-auth": 1,
    },
    rationale:
      "The gotcha answers it; the readiness rule is what an agent must apply instead (2); BYO-auth is background (1).",
  },
  {
    id: "q-lex-stream-truncate",
    capability: "lexical",
    text: "stream chunk truncation ceiling overflow",
    concepts: { streaming: 1 },
    labels: { "n-stream-truncate": 3, "n-stream-backpressure": 1 },
    rationale:
      "Direct match; the backpressure note is the same subsystem but a different failure (1).",
  },
  {
    id: "q-para-tier",
    capability: "paraphrase",
    text: "why did introducing an extra permission level quietly block a delegated worker",
    concepts: { dispatch: 1 },
    labels: {
      "n-tier-subtraction": 3,
      "n-delegate-launch-broke": 2,
      "n-role-allowlist": 2,
    },
    rationale:
      "Wording deliberately shares no content token with the answer. The subtraction gotcha is the cause (3); the observed breakage and the allowlist rule both change what the agent does (2).",
  },
  {
    id: "q-para-budget",
    capability: "paraphrase",
    text: "how do we keep one worker from spending beyond its share",
    concepts: { budget: 1, dispatch: 0.6 },
    labels: {
      "n-budget-cap-spread": 3,
      "n-superagent-no-lane": 2,
      "n-updatemany-atomic": 1,
    },
    rationale:
      "The cap-widening gotcha is the live hazard (3); the orchestrator-consumes-no-budget rule bounds the design (2); the atomic-update note is how a limit is enforced safely (1).",
  },
  {
    id: "q-para-packaging",
    capability: "paraphrase",
    text: "distributing a mac application without paying for a developer certificate",
    concepts: { packaging: 1 },
    labels: { "n-unsigned-dmg": 3, "n-universal-build": 2 },
    rationale:
      "Paraphrase of the unsigned-image decision (3); the universal-build decision is part of the same shipping shape (2).",
  },
  {
    id: "q-para-sqlite",
    capability: "paraphrase",
    text: "keeping structured blobs in an engine lacking a dedicated field type",
    concepts: { storage: 1 },
    labels: { "n-sqlite-json": 3, "n-updatemany-atomic": 1 },
    rationale:
      "Paraphrase of the json-as-text gotcha (3); the atomicity constraint is the other portability lesson on the same file (1).",
  },
  {
    id: "q-para-crossvendor",
    capability: "paraphrase",
    text: "should we hold the credentials a coding tool needs to sign in",
    concepts: { vendor: 1, gate: 0.4 },
    labels: { "n-byo-auth": 3, "n-readiness-auth": 2 },
    rationale:
      "The BYO constraint answers it (3); readiness-by-auth-probe is the mechanism that follows from it (2).",
  },
  {
    id: "q-anchor-role",
    capability: "anchor-named",
    text: "backend/src/lib/dispatch-role.ts",
    concepts: { dispatch: 1 },
    labels: {
      "n-tier-subtraction": 3,
      "n-role-allowlist": 3,
      "n-delegate-launch-broke": 2,
    },
    rationale:
      "A bare module path — the shape an agent uses when it is about to touch a file. Ground truth is the notes about that file.",
  },
  {
    id: "q-anchor-symbol",
    capability: "anchor-named",
    text: "packages/graph/src/memory-ranking.ts#rerankCalibrated",
    concepts: { memory: 1 },
    labels: {
      "n-rank-governance-cap": 3,
      "n-rank-demotion-tier": 3,
      "n-dedup-lexical-floor": 1,
      "n-usage-decay": 1,
    },
    rationale:
      "A symbol id. The two symbol-anchored notes describe that function's contract (3); the other notes on the same module are context (1).",
  },
  {
    id: "q-edit-graph",
    capability: "edit-intent",
    text: "about to edit packages/graph/src/muon-graph.ts what should I know",
    concepts: { memory: 1 },
    labels: {
      "n-traversal-coordinates": 3,
      "n-fts-text-only": 3,
      "n-bitemporal-asof": 3,
      "n-graph-boot-probe": 3,
      "n-reinforce-off-read": 3,
      "n-analytics-coordinates": 3,
      "n-schema-migrate-besteffort": 2,
      "n-note-id-prefix": 2,
      "n-gate-crew-visible": 2,
      "n-trust-floor": 2,
    },
    rationale:
      "Edit-intent: the ground truth IS everything anchored to that file (the pre-edit gate's own contract). Weakly-relevant/unconfirmed notes on the file are 2. This class rewards anchor-aware retrieval by definition, which is why it is reported separately.",
  },
  {
    id: "q-edit-preedit",
    capability: "edit-intent",
    text: "about to edit backend/src/lib/preedit.ts what should I know",
    concepts: { gate: 1 },
    labels: {
      "n-gate-confirmed-only": 3,
      "n-gate-crew-visible": 3,
      "n-gate-sidechannel": 3,
      "n-gate-fails-closed": 3,
      "n-trust-floor": 3,
      "n-preedit-anchor-fanout": 3,
      "n-autoconfirm-never": 2,
      "n-autoconfirm-on": 2,
    },
    rationale:
      "Same rubric as the other edit-intent query; the contradiction pair anchored to the file is included at 2 because a contradicted note still has to be shown as a warning.",
  },
  {
    id: "q-edit-dispatch",
    capability: "edit-intent",
    text: "about to edit backend/src/routes/dispatch.ts what should I know",
    concepts: { dispatch: 1, budget: 0.5 },
    labels: {
      "n-budget-cap-spread": 3,
      "n-permission-mode-leak": 3,
      "n-superagent-no-lane": 3,
      "n-governed-parity": 3,
      "n-stale-port": 1,
    },
    rationale:
      "Edit-intent on a dispatch file. The stale port fact is anchored there but is flagged stale, so it is context only (1) and must not lead.",
  },
  {
    id: "q-lineage-readiness",
    capability: "lineage",
    text: "what is the current rule for deciding a vendor is ready",
    concepts: { vendor: 1 },
    labels: {
      "n-readiness-auth": 3,
      "n-cursor-rc0": 2,
      "n-vendor-breadth-hedge": 1,
    },
    rationale:
      "The successor note is the only correct answer; its retired predecessor must NOT surface (it is status rejected and therefore outside the active set entirely — the point of the class).",
  },
  {
    id: "q-contradiction-autoconfirm",
    capability: "contradiction",
    text: "should agent memory be auto confirmed",
    concepts: { gate: 1, memory: 0.6 },
    labels: {
      "n-autoconfirm-never": 3,
      "n-gate-confirmed-only": 2,
      "n-autoconfirm-on": 1,
    },
    rationale:
      "The confirmed constraint is the answer; the contradicting note is deliberately labelled 1 — it must be visible as a warning but must never lead, which is what the ranker's demotion tier guarantees.",
  },
];

export const DEFAULT_GRAPH_VALUE_EVAL_SET: GraphValueEvalSet = {
  now: GRAPH_VALUE_EVAL_NOW,
  basis: GRAPH_VALUE_CONCEPTS,
  notes: NOTES,
  tasks: TASKS,
  queries: QUERIES,
};
