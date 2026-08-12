import type { EvalNote, EvalQuery, GraphValueEvalSet } from "../graph-value-eval.js";
import { DEFAULT_GRAPH_VALUE_EVAL_SET } from "./graph-value-eval-set.js";

/**
 * R2 ENTITY SLICE — an ADDITIVE extension of the KG-12 corpus.
 *
 * WHY A SEPARATE SLICE INSTEAD OF EDITING THE CORPUS. The KG-12 corpus was
 * authored to answer "does N-hop traversal beat flat search", and its notes
 * deliberately paraphrase engineering facts in plain prose while keeping every
 * coordinate in the STRUCTURED `modules`/`symbols` fields. Measured on it, this
 * extractor finds 0.27 entities per note — there is almost nothing in the TEXT to
 * index. Rewriting those notes to carry inline identifiers would have silently
 * moved the traversal verdict's ground under it. So the base corpus is FROZEN,
 * byte-for-byte, and every traversal/centrality number stays directly comparable;
 * this slice is appended to make a second, disjoint measurement.
 *
 * WHAT THIS SLICE IS FOR. The hole R2 exists to close (§5.3): a note whose
 * durable nouns live in its PROSE and which anchors to NO module or symbol — "the
 * Stripe webhook retry policy needs idempotency keys". Under the shipped
 * retrievers such a note is reachable only if FTS or the substring scan happens
 * to hit it; it has no anchor at all. That class is genuinely common in agent
 * work-memory (vendor CLIs, third-party APIs, error codes, package versions) and
 * genuinely absent from the base corpus.
 *
 * HOW IT WAS BUILT — the SAME rules as the base fixture, plus two more:
 *  1. Facts are repo-derived or third-party-derived, never invented user data.
 *  2. Anchors are real where a note has one. Notes about a third-party surface
 *     carry NO module, because that is the honest shape — not because stripping
 *     the anchor would flatter the entity signal.
 *  3. Concept vectors describe SUBJECT MATTER only, never graph position.
 *  4. NEW: entity-bearing NOISE. Six of these notes carry identifiers/proper
 *     nouns and are gold for NO query. An entity retriever that simply fires
 *     on everything is therefore punished by precision, not rewarded.
 *  5. NEW: the queries are written as an agent would type them, then checked
 *     against the extractor — never the reverse. Three of them exercise a
 *     specific, REAL defect in the flat retrievers:
 *       - `q-ent-retry-policy` writes the identifier in a different case and
 *         separator (`RETRY_POLICY`) than the note (`retryPolicy`). BM25
 *         tokenizes `retry_policy` and `retrypolicy` as different terms and the
 *         substring scan matches neither, but they normalise to one entity.
 *       - `q-ent-long-tail` is 14 whitespace tokens long. `searchMemoryLexical`
 *         truncates to the FIRST 8, so its identifier is dropped entirely;
 *         entity extraction ranks by class and keeps it.
 *       - `q-ent-symbol-bare` names a full `<module>#<name>` symbol id where the
 *         note only ever writes the bare name.
 *     The other three are ordinary prose queries with no such trick, so the
 *     aggregate is not four defects wearing a trenchcoat.
 *
 * WHAT THIS SLICE CANNOT TELL YOU: how often the anchor-less class occurs in real
 * traffic. It is reported as its own profile for exactly that reason.
 */

const WEBHOOKS = "backend/src/routes/webhooks.ts";
const RUNNER = "packages/runner/src/execute.ts";
const CHAT_INT = "chat-integrations";

const ENTITY_NOTES: EvalNote[] = [
  // ── the motivating class: durable nouns in prose, NO code anchor ──────────
  {
    id: "n-ent-stripe-idempotency",
    kind: "constraint",
    text: "The Stripe webhook retry policy needs idempotency keys: without an Idempotency-Key header a retried charge double-bills the customer.",
    modules: [],
    topics: ["payments"],
    principal: "agent:claude",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_INT,
    ageDays: 9,
    concepts: { vendor: 0.6, storage: 0.2 },
  },
  {
    id: "n-ent-retry-policy",
    kind: "decision",
    text: "Outbound calls share one retryPolicy with exponential backoff; a handler that needs different behaviour overrides it rather than writing its own loop.",
    modules: [WEBHOOKS],
    topics: ["retry"],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_INT,
    ageDays: 14,
    concepts: { vendor: 0.5, dispatch: 0.4 },
  },
  {
    id: "n-ent-enotfound",
    kind: "attempt",
    text: "A cold container throws ENOENT on the first probe because the socket is not bound yet; retry once before reporting the vendor unavailable.",
    modules: [],
    topics: ["vendor"],
    principal: "agent:codex",
    trust: "medium",
    confirmed: false,
    chatId: CHAT_INT,
    ageDays: 6,
    concepts: { vendor: 1 },
  },
  {
    id: "n-ent-rate-limit",
    kind: "constraint",
    text: "A vendor returning HTTP 429 must back off on the Retry-After header; hammering it trips a longer ban than the header asks for.",
    modules: [],
    topics: ["vendor", "retry"],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_INT,
    ageDays: 18,
    concepts: { vendor: 1 },
  },
  {
    id: "n-ent-ollama-model",
    kind: "attempt",
    text: "Ollama silently downloads a missing default model, so a preflight that only checks the daemon is up reports ready when the first call will still stall.",
    modules: [],
    topics: ["vendor", "embeddings"],
    principal: "agent:codex",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_INT,
    ageDays: 11,
    concepts: { vendor: 1 },
  },
  {
    id: "n-ent-sigkill",
    kind: "attempt",
    text: "A runner child killed by SIGKILL reports exit 137, which reads as an application failure unless the signal is recorded alongside the code.",
    modules: [RUNNER],
    topics: ["runner"],
    principal: "agent:claude",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_INT,
    ageDays: 21,
    concepts: { streaming: 0.5, dispatch: 0.4 },
  },
  // ── the symbol-id ↔ bare-name link ────────────────────────────────────────
  {
    id: "n-ent-execute-cwd",
    kind: "convention",
    text: "Always pass an absolute cwd to runCommand; a relative one resolves against the daemon's working directory, not the task's worktree.",
    modules: [RUNNER],
    symbols: [`${RUNNER}#runCommand`],
    topics: ["runner"],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_INT,
    ageDays: 16,
    concepts: { dispatch: 0.6, storage: 0.2 },
  },

  // ── entity-bearing NOISE: gold for nothing, so precision has teeth ────────
  {
    id: "n-ent-noise-postgres",
    kind: "decision",
    text: "Postgres stays the hosted ledger while the embedded install keeps SQLite, so every query has to survive both planners.",
    modules: [],
    topics: ["storage"],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_INT,
    ageDays: 30,
    concepts: { storage: 1 },
  },
  {
    id: "n-ent-noise-railway",
    kind: "convention",
    text: "Railway deploys go through the CLI, never the dashboard, so the deployed commit is always the one in the branch history.",
    modules: [],
    topics: ["deploy"],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_INT,
    ageDays: 34,
    concepts: { packaging: 1 },
  },
  {
    id: "n-ent-noise-mermaid",
    kind: "convention",
    text: "Architecture answers are drawn as a Mermaid diagram before they are written as prose.",
    modules: [],
    topics: ["docs"],
    principal: "human:founder",
    trust: "high",
    confirmed: true,
    chatId: CHAT_INT,
    ageDays: 40,
    concepts: { ui: 0.6 },
  },
  {
    id: "n-ent-noise-webhook-order",
    kind: "attempt",
    text: "Webhook deliveries arrive out of order often enough that the handler sorts on the event timestamp instead of trusting arrival order.",
    modules: [WEBHOOKS],
    topics: ["payments"],
    principal: "agent:cursor",
    trust: "medium",
    confirmed: false,
    chatId: CHAT_INT,
    ageDays: 13,
    concepts: { storage: 0.4, vendor: 0.3 },
  },
  {
    id: "n-ent-noise-backoff-jitter",
    kind: "convention",
    text: "Every backoff carries jitter; a fleet that retries on the same schedule reconverges into the thundering herd it was meant to avoid.",
    modules: [],
    topics: ["retry"],
    principal: "agent:claude",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_INT,
    ageDays: 26,
    concepts: { dispatch: 0.5 },
  },
  {
    id: "n-ent-noise-runner-stdio",
    kind: "attempt",
    text: "The runner keeps stdout and stderr on separate pipes; merging them reorders interleaved lines under load and corrupts the transcript.",
    modules: [RUNNER],
    topics: ["runner"],
    principal: "agent:codex",
    trust: "medium",
    confirmed: true,
    chatId: CHAT_INT,
    ageDays: 19,
    concepts: { streaming: 1 },
  },
];

const ENTITY_QUERIES: EvalQuery[] = [
  {
    id: "q-ent-stripe",
    capability: "anchor-named",
    text: "Stripe webhook idempotency",
    concepts: { vendor: 0.6, storage: 0.2 },
    labels: {
      "n-ent-stripe-idempotency": 3,
      "n-ent-noise-webhook-order": 1,
    },
    rationale:
      "The exact class R2 exists for: the answer note has NO module or symbol anchor, so anchor-aware retrieval cannot see it at all and only its prose can. The out-of-order webhook note is same-subsystem context (1).",
  },
  {
    id: "q-ent-retry-policy",
    capability: "lexical",
    text: "where is RETRY_POLICY configured",
    concepts: { vendor: 0.5, dispatch: 0.4 },
    labels: {
      "n-ent-retry-policy": 3,
      "n-ent-rate-limit": 2,
      "n-ent-noise-backoff-jitter": 1,
    },
    rationale:
      "Written in the casing an agent actually types when it half-remembers a name. BM25 tokenizes `retry_policy` and the note's `retrypolicy` as different terms and the substring scan matches neither; entity normalisation makes them one key. The 429 rule changes what the agent does (2); jitter is adjacent (1).",
  },
  {
    id: "q-ent-symbol-bare",
    capability: "anchor-named",
    text: "packages/runner/src/execute.ts#runCommand",
    concepts: { dispatch: 0.6, storage: 0.2 },
    labels: {
      "n-ent-execute-cwd": 3,
      "n-ent-noise-runner-stdio": 1,
      "n-ent-sigkill": 1,
    },
    rationale:
      "A symbol id, where the answering note writes only the bare name `runCommand` in its prose. The other notes on that module are context (1).",
  },
  {
    id: "q-ent-long-tail",
    capability: "edit-intent",
    text: "I keep seeing the vendor daemon report success and then stall on the very first call, is this Ollama",
    concepts: { vendor: 1 },
    labels: {
      "n-ent-ollama-model": 3,
      "n-ent-enotfound": 2,
    },
    rationale:
      "Fourteen whitespace tokens, with the only discriminating noun LAST. `searchMemoryLexical` keeps the first 8 and throws `Ollama` away; entity extraction ranks by class, not position, so it survives. The cold-probe note is the other explanation an agent should see (2).",
  },
  {
    id: "q-ent-backoff",
    capability: "paraphrase",
    text: "what should a client do when a provider says it is being called too often",
    concepts: { vendor: 1 },
    labels: {
      "n-ent-rate-limit": 3,
      "n-ent-noise-backoff-jitter": 2,
    },
    rationale:
      "An ordinary paraphrase with NO extractor trick — it shares no identifier with the answer, so entity should add nothing here and the aggregate is not built only from favourable queries.",
  },
  {
    id: "q-ent-exit-code",
    capability: "lexical",
    text: "runner exit 137 what happened",
    concepts: { streaming: 0.5, dispatch: 0.4 },
    labels: {
      "n-ent-sigkill": 3,
      "n-ent-noise-runner-stdio": 1,
    },
    rationale:
      "An exit code pasted verbatim — the class a stemmer destroys and a term index never carries. The stdio note is same-module context (1).",
  },
];

/**
 * The base KG-12 corpus PLUS the entity slice. The base set is spread in
 * unchanged, so a report run on `DEFAULT_GRAPH_VALUE_EVAL_SET` and one run on
 * this set differ only by the appended notes/queries, and any entity gain is
 * attributable to them rather than to a corpus rewrite.
 */
export const ENTITY_GRAPH_VALUE_EVAL_SET: GraphValueEvalSet = {
  ...DEFAULT_GRAPH_VALUE_EVAL_SET,
  notes: [...DEFAULT_GRAPH_VALUE_EVAL_SET.notes, ...ENTITY_NOTES],
  queries: [...DEFAULT_GRAPH_VALUE_EVAL_SET.queries, ...ENTITY_QUERIES],
};

export { ENTITY_NOTES, ENTITY_QUERIES };
