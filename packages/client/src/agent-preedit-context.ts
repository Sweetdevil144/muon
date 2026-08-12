import { VENDOR_IDS, preEditCoverageForSurface } from "@muon/protocol";
import type {
  EditTarget,
  PreEditActivity,
  PreEditContext,
  PreEditCrewFinding,
  PreEditDuplicateWork,
  PreEditMemory,
  PreEditPendingProposal,
  PreEditWarning,
} from "./types.js";

const MAX_COORDINATE_LENGTH = 512;
const COORDINATE_PATTERN = /^[A-Za-z0-9@._~:+#$%/\\-]+$/;
const MEMORY_ID_PATTERN =
  /^mem-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * WAVE D: the registry, not a fifth hand-written copy. This one had the
 * missing-vendor bug the drift-lock recorded — it omitted a managed lane, so
 * that lane's workers had their pre-edit context rejected as malformed.
 *
 * A SHAPE CHECK, never an authority gate: it validates what an agent claims
 * about its own edit. Naming every vendor here grants nothing.
 */
const AGENT_VENDORS = new Set<string>(VENDOR_IDS);
const MEMORY_KINDS = new Set([
  "decision",
  "constraint",
  "convention",
  "attempt",
  "question",
]);
const MEMORY_TRUST = new Set(["low", "medium", "high"]);
const MEMORY_STATUS = new Set(["active", "rejected"]);

const WARNING_DETAIL: Record<PreEditWarning["kind"], string> = {
  contradicts:
    "A memory relationship on the current edit radius requires review.",
  proposes_supersede:
    "A pending supersede relationship on the current edit radius requires review.",
};

const PROPOSAL_DETAIL =
  "An unconfirmed proposal on the current edit radius requires human review.";

function coordinate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const clean = value.trim();
  return clean.length > 0 &&
    clean.length <= MAX_COORDINATE_LENGTH &&
    COORDINATE_PATTERN.test(clean)
    ? clean
    : undefined;
}

function coordinates(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of value) {
    const clean = coordinate(entry);
    if (clean) {
      seen.add(clean);
    }
  }
  return [...seen];
}

function stableFingerprint(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export type CoordinateKind =
  | "job"
  | "lane"
  | "memory"
  | "module"
  | "symbol"
  | "task";

/**
 * Aliases an agent-facing coordinate. Injected into buildAgentPreEditContext so a
 * PRODUCTION caller can supply a per-process KEYED alias (HMAC) — see #95: the
 * default below is an unsalted, public FNV whose only safety comes from
 * allowlist ⊆ agent-supplied coords + high-entropy peer ids; a keyed function
 * makes the aliases per-process unpredictable and non-linkable across restarts,
 * so even a low-entropy id routed through it cannot be reversed offline.
 */
export type FingerprintFn = (kind: CoordinateKind, value: unknown) => string;

export function fingerprintAgentCoordinate(
  kind: CoordinateKind,
  value: unknown
): string {
  return `${kind}-${stableFingerprint(value)}`;
}

function memoryCoordinate(value: unknown): string | undefined {
  const clean = coordinate(value);
  return clean && MEMORY_ID_PATTERN.test(clean) ? clean : undefined;
}

function optionalOpaqueCoordinate(
  kind: "lane" | "task",
  value: unknown,
  fingerprint: FingerprintFn
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return value === undefined ? undefined : fingerprint(kind, value);
}

function principalKind(value: unknown): string {
  const kind =
    typeof value === "string" ? value.trim().split(":", 1)[0] : undefined;
  return kind === "human" || kind === "agent" || kind === "system"
    ? kind
    : "system";
}

function safeVendor(value: unknown): string | undefined {
  return typeof value === "string" && AGENT_VENDORS.has(value)
    ? value
    : undefined;
}

function safeInstant(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}

function safeTarget(target: EditTarget): EditTarget {
  const symbol = coordinate(target.symbol);
  const modulePath = coordinate(target.module);
  return {
    ...(symbol ? { symbol } : {}),
    ...(modulePath ? { module: modulePath } : {}),
  };
}

function safeMemory(
  memory: PreEditMemory,
  allowedModules: ReadonlySet<string>,
  allowedSymbols: ReadonlySet<string>,
  exposeRawCoordinates: boolean,
  fingerprint: FingerprintFn
): PreEditMemory | undefined {
  const id = memoryCoordinate(memory.id);
  const createdAt = safeInstant(memory.createdAt);
  const updatedAt = safeInstant(memory.updatedAt);
  if (
    !id ||
    typeof memory.text !== "string" ||
    !MEMORY_KINDS.has(memory.kind) ||
    !MEMORY_TRUST.has(memory.trust) ||
    !MEMORY_STATUS.has(memory.status) ||
    memory.confirmed !== true ||
    typeof memory.stale !== "boolean" ||
    typeof memory.onTarget !== "boolean" ||
    typeof memory.onSymbol !== "boolean" ||
    typeof memory.proximity !== "number" ||
    !Number.isFinite(memory.proximity) ||
    memory.proximity < 0 ||
    memory.proximity > 1 ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }
  const rawModules = coordinates(memory.modules).filter((modulePath) =>
    allowedModules.has(modulePath)
  );
  const rawSymbols = coordinates(memory.symbols).filter((symbol) =>
    allowedSymbols.has(symbol)
  );
  if (rawModules.length === 0 && rawSymbols.length === 0) {
    return undefined;
  }
  const modules = rawModules.map((modulePath) =>
    exposeRawCoordinates ? modulePath : fingerprint("module", modulePath)
  );
  const symbols = rawSymbols.map((symbol) =>
    exposeRawCoordinates ? symbol : fingerprint("symbol", symbol)
  );
  const taskId = optionalOpaqueCoordinate("task", memory.taskId, fingerprint);
  const laneId = optionalOpaqueCoordinate("lane", memory.laneId, fingerprint);
  return {
    id,
    kind: memory.kind,
    text: memory.text,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(laneId !== undefined ? { laneId } : {}),
    modules,
    topics: [],
    symbols,
    trust: memory.trust,
    confirmed: true,
    stale: memory.stale,
    status: memory.status,
    createdBy: principalKind(memory.createdBy),
    createdAt,
    updatedAt,
    proximity: memory.proximity,
    onTarget: memory.onTarget,
    onSymbol: memory.onSymbol,
  };
}

function safeCrewFinding(
  memory: PreEditCrewFinding,
  allowedModules: ReadonlySet<string>,
  allowedSymbols: ReadonlySet<string>,
  exposeRawCoordinates: boolean,
  fingerprint: FingerprintFn
): PreEditCrewFinding | undefined {
  // confirmedBy: "orchestrator" (the D12-C vouch) OR null (posture-admitted
  // same-mission finding) — the 2026-08-06 widening's whole point. This guard
  // was the one hop that kept demanding the vouch after the wire, the schema,
  // and the mapper below were all widened, silently dropping every unvouched
  // finding before it reached the agent.
  if (
    memory.confirmed !== false ||
    (memory.confirmedBy !== "orchestrator" && memory.confirmedBy !== null) ||
    memory.tier !== "crew_vouched" ||
    memory.authority !== "inform"
  ) {
    return undefined;
  }
  // Reuse the exact prose/coordinate sanitizer used by governed memory. The
  // temporary `confirmed:true` is internal to validation; the returned object
  // restores the literal non-authority fields below.
  const sanitized = safeMemory(
    { ...memory, confirmed: true },
    allowedModules,
    allowedSymbols,
    exposeRawCoordinates,
    fingerprint
  );
  return sanitized
    ? {
        ...sanitized,
        confirmed: false,
        // Preserved, never re-stamped: a posture-admitted finding carries
        // null (nobody vouched), and claiming "orchestrator" here would put
        // a vouch in the agent's context that no one made.
        confirmedBy:
          memory.confirmedBy === "orchestrator" ? "orchestrator" : null,
        tier: "crew_vouched",
        authority: "inform",
      }
    : undefined;
}

function safeWarning(
  warning: PreEditWarning
): PreEditWarning | undefined {
  const noteId = memoryCoordinate(warning.noteId);
  const relatedNoteId = memoryCoordinate(warning.relatedNoteId);
  if (
    !noteId ||
    !relatedNoteId ||
    (warning.kind !== "contradicts" &&
      warning.kind !== "proposes_supersede")
  ) {
    return undefined;
  }
  return {
    kind: warning.kind,
    noteId,
    relatedNoteId,
    detail: WARNING_DETAIL[warning.kind],
  };
}

function safeProposal(
  proposal: PreEditPendingProposal,
  allowedModules: ReadonlySet<string>,
  exposeRawCoordinates: boolean,
  fingerprint: FingerprintFn
): PreEditPendingProposal | undefined {
  const proposalNoteId = memoryCoordinate(proposal.proposalNoteId);
  const victimNoteId = memoryCoordinate(proposal.victimNoteId);
  if (!proposalNoteId || !victimNoteId) {
    return undefined;
  }
  const modules = coordinates(proposal.modules).filter((module) =>
    allowedModules.has(module)
  );
  return {
    proposalNoteId,
    victimNoteId,
    modules: modules.map((modulePath) =>
      exposeRawCoordinates ? modulePath : fingerprint("module", modulePath)
    ),
    detail: PROPOSAL_DETAIL,
  };
}

function safeActivity(
  activity: PreEditActivity,
  allowedModules: ReadonlySet<string>,
  allowedSymbols: ReadonlySet<string>,
  exposeRawCoordinates: boolean,
  fingerprint: FingerprintFn
): PreEditActivity | undefined {
  const anchor = coordinate(activity.anchor);
  const vendor = safeVendor(activity.vendor);
  const at = Date.parse(activity.at);
  const allowed =
    anchor !== undefined &&
    ((activity.anchorKind === "module" && allowedModules.has(anchor)) ||
      (activity.anchorKind === "symbol" && allowedSymbols.has(anchor)));
  if (
    !anchor ||
    !allowed ||
    !vendor ||
    !Number.isFinite(at) ||
    (activity.kind !== "running" && activity.kind !== "editing") ||
    (activity.state !== "live" && activity.state !== "recent")
  ) {
    return undefined;
  }
  return {
    laneId: fingerprint("lane", activity.laneId),
    vendor,
    taskId: fingerprint("task", activity.taskId),
    jobId: fingerprint("job", activity.jobId),
    kind: activity.kind,
    anchor: exposeRawCoordinates
      ? anchor
      : fingerprint(activity.anchorKind, anchor),
    anchorKind: activity.anchorKind,
    at: new Date(at).toISOString(),
    state: activity.state,
    ...(typeof activity.onSymbol === "boolean"
      ? { onSymbol: activity.onSymbol }
      : {}),
    ...(typeof activity.onTarget === "boolean"
      ? { onTarget: activity.onTarget }
      : {}),
    ...(typeof activity.proximity === "number" &&
    Number.isFinite(activity.proximity) &&
    activity.proximity >= 0 &&
    activity.proximity <= 1
      ? { proximity: activity.proximity }
      : {}),
  };
}

function safeDuplicateWork(
  duplicate: PreEditDuplicateWork,
  fingerprint: FingerprintFn
): PreEditDuplicateWork | undefined {
  const vendor = safeVendor(duplicate.vendor);
  if (
    !vendor ||
    duplicate.state !== "live" ||
    !Number.isFinite(duplicate.similarity) ||
    duplicate.similarity < 0 ||
    duplicate.similarity > 1
  ) {
    return undefined;
  }
  return {
    jobId: fingerprint("job", duplicate.jobId),
    taskId: fingerprint("task", duplicate.taskId),
    vendor,
    similarity: duplicate.similarity,
    state: duplicate.state,
  };
}

/**
 * Produce the agent-facing pre-edit wire context from the human/backend context.
 * This is a pure, browser-safe allowlist projection: only confirmed memories may
 * carry text, warning/proposal prose is generic, and collaboration/proposal
 * anchors must belong to the currently resolved target or blast radius.
 */
export function buildAgentPreEditContext(
  context: PreEditContext,
  // #95: a PRODUCTION caller injects a per-process KEYED alias (HMAC); the default
  // is the unsalted FNV, adequate for tests + the human path. Every coordinate
  // alias in this projection goes through this ONE function.
  fingerprint: FingerprintFn = fingerprintAgentCoordinate
): PreEditContext {
  const rawTarget = safeTarget(context.target);
  const radiusIsTrusted = context.blastRadius.source === "codegraph";
  const target: EditTarget = {
    ...(rawTarget.symbol
      ? {
          symbol: radiusIsTrusted
            ? rawTarget.symbol
            : fingerprint("symbol", rawTarget.symbol),
        }
      : {}),
    ...(rawTarget.module
      ? {
          module: radiusIsTrusted
            ? rawTarget.module
            : fingerprint("module", rawTarget.module),
        }
      : {}),
  };
  // P0 (memory-graph eval): the caller's blast radius (from `code_impact` on the
  // MANDATED code_impact → blastRadiusModules → memory_preedit flow) defines
  // WHICH memories/proposals/warnings to SURFACE. Include it in the allowlist
  // regardless of `source` — otherwise, on the exact path agents are told to use
  // (source: "provided"), the entire neighbour tier, all pending proposals, and
  // all contradiction/supersede warnings are silently dropped, so a doc-following
  // agent gets a WORSE briefing than one that ignores the docs.
  //
  // The SECURITY boundary is unchanged: raw-coordinate EXPOSURE stays gated to a
  // codegraph-VERIFIED radius (`radiusIsTrusted` → `exposeRawCoordinates` below),
  // so for an agent-PROVIDED radius the memories surface with their TEXT but
  // FINGERPRINTED module/symbol coordinates. WHY exposing those fingerprints is
  // safe here is NOT the hash — `stableFingerprint` is unsalted and public, and
  // the `kind-` prefix is cosmetic (same input → same 16-hex body across kinds),
  // so any fingerprint is recomputable offline. The real invariants are:
  //   (1) on the untrusted path the allowlist ⊆ the coordinates the AGENT ITSELF
  //       supplied (target + provided radius), so reversing a module/symbol
  //       fingerprint reveals only a value the agent already knew;
  //   (2) peer identity (lane/task/job) is aliased in the safe* helpers AND those
  //       raw ids are high-entropy (cuid/uuid) → not brute-forceable, so the alias
  //       is non-reversible in practice, not because the hash hides them.
  // The residual fragility (a low-entropy id — sequential key, workspace path,
  // session id — would be reversible offline under the default unsalted FNV) is
  // now REMOVED for the production caller: #95 injects a per-process KEYED alias
  // (HMAC-SHA256 seeded by a server-only random secret; see the MCP handler), so
  // fingerprints are unpredictable without the secret and non-linkable across
  // restarts. The default FNV remains only for tests + the human path. A
  // fabricated module simply matches no stored memory. Surfacing confirmed,
  // workspace-scoped, human-gated memories for a module the agent named is the
  // tool's whole purpose.
  //
  // NOTE (LOW coupling): surfaced `mem-<uuid>` note ids pass through RAW. That is
  // safe ONLY because the note-by-id read route (GET /api/memory/:noteId) is
  // operator-tier (requireOperator → agent-tier 403). If that route were ever
  // opened to agent tier, every surfaced note id becomes a text-exfil handle.
  const radiusModules = coordinates(context.blastRadius.modules);
  const radiusSymbols = coordinates(context.blastRadius.symbols);
  const blastRadiusModules = coordinates([
    ...(rawTarget.module ? [rawTarget.module] : []),
  ]);
  for (const modulePath of radiusModules) {
    if (!blastRadiusModules.includes(modulePath)) {
      blastRadiusModules.push(modulePath);
    }
  }
  const blastRadiusSymbols = coordinates([
    ...(rawTarget.symbol ? [rawTarget.symbol] : []),
  ]);
  for (const symbol of radiusSymbols) {
    if (!blastRadiusSymbols.includes(symbol)) {
      blastRadiusSymbols.push(symbol);
    }
  }
  const allowedModules = new Set(blastRadiusModules);
  const allowedSymbols = new Set(blastRadiusSymbols);
  // Peer ACTIVITY location stays gated to a codegraph-VERIFIED radius (the
  // deliberate 90c55c3 tightening) PLUS the agent's own target: an agent must
  // not be able to map WHERE other agents are working by naming arbitrary
  // modules it isn't editing. (Memories/proposals above surface GOVERNED
  // knowledge and so use the wider provided radius; peer *location* is a
  // different, more sensitive signal.) Peer identity is aliased regardless.
  const activityAllowedModules = radiusIsTrusted
    ? allowedModules
    : new Set(rawTarget.module ? coordinates([rawTarget.module]) : []);
  const activityAllowedSymbols = radiusIsTrusted
    ? allowedSymbols
    : new Set(rawTarget.symbol ? coordinates([rawTarget.symbol]) : []);
  const activity = (context.activity ?? [])
    .map((entry) =>
      safeActivity(
        entry,
        activityAllowedModules,
        activityAllowedSymbols,
        radiusIsTrusted,
        fingerprint
      )
    )
    .filter((entry): entry is PreEditActivity => entry !== undefined);
  const memories = context.memories
    .filter((memory) => memory.confirmed === true)
    .map((memory) =>
      safeMemory(
        memory,
        allowedModules,
        allowedSymbols,
        radiusIsTrusted,
        fingerprint
      )
    )
    .filter((memory): memory is PreEditMemory => memory !== undefined);
  const crewFindings = (context.crewFindings ?? [])
    .map((memory) =>
      safeCrewFinding(
        memory,
        allowedModules,
        allowedSymbols,
        radiusIsTrusted,
        fingerprint
      )
    )
    .filter(
      (memory): memory is PreEditCrewFinding => memory !== undefined
    );
  const pendingProposals = context.pendingProposals
    .map((proposal) =>
      safeProposal(proposal, allowedModules, radiusIsTrusted, fingerprint)
    )
    .filter(
      (proposal): proposal is PreEditPendingProposal =>
        proposal !== undefined
    )
    .filter((proposal) => proposal.modules.length > 0);
  // safeWarning fully sanitizes (strict mem-<uuid> noteIds + a hardcoded detail
  // string, NO raw coordinates), so a contradiction/supersede warning carries
  // ZERO injection risk and is the single most safety-relevant pre-edit signal
  // (a confirmed decision the edit would violate). Never gate it on radius trust.
  const warnings = context.warnings
    .map(safeWarning)
    .filter((warning): warning is PreEditWarning => warning !== undefined);
  const duplicateWork = (context.duplicateWork ?? [])
    .map((duplicate) => safeDuplicateWork(duplicate, fingerprint))
    .filter(
      (duplicate): duplicate is PreEditDuplicateWork => duplicate !== undefined
    );

  return {
    target,
    blastRadius: {
      modules: blastRadiusModules.map((modulePath) =>
        radiusIsTrusted ? modulePath : fingerprint("module", modulePath)
      ),
      ...(context.blastRadius.symbols !== undefined
        ? {
            symbols: blastRadiusSymbols.map((symbol) =>
              radiusIsTrusted ? symbol : fingerprint("symbol", symbol)
            ),
          }
        : {}),
      ...(radiusIsTrusted && context.blastRadius.depth !== undefined
        ? { depth: context.blastRadius.depth }
        : {}),
      source: radiusIsTrusted ? context.blastRadius.source : "target-only",
    },
    memories,
    crewFindings,
    warnings,
    pendingProposals,
    activity,
    duplicateWork,
    // D14 measures the edit gate only. ADR-0027 crew findings are visible above,
    // but remain outside this tally because they cannot authorize the edit.
    ...(context.coverage
      ? {
          coverage: preEditCoverageForSurface(
            context.coverage,
            memories.length
          ),
        }
      : {}),
  };
}
