/**
 * ADR-0033 — a refusal explains itself.
 *
 * MUON refuses constantly and on purpose; fail-closed IS the product. What a
 * refusal SAYS had not kept up: the CLI reconstructs a generic sentence from an
 * HTTP status (it knows the shape of the failure and none of its substance),
 * and the agent-facing path carries a flat `error: string`. An agent that
 * cannot tell a permanent boundary from a missing precondition does the same
 * wrong thing twice, or escalates to a human who then reads MUON's source.
 *
 * A refusal is therefore a typed value produced WHERE THE RULE IS ENFORCED and
 * rendered by every surface, carrying three things: the rule that fired, the
 * evidence that rule saw, and the lawful next action (or an honest absence).
 *
 * The security property that shapes the whole module: **an explanation is a
 * disclosure.** The enforcement site knows things the refused caller must not
 * learn. Disclosure is therefore allowlisted PER RULE PER AUDIENCE, positively
 * — never "build everything, then strip the sensitive bits", which is
 * derivation by subtraction and has broken this codebase three times
 * (ADR-0022 rule 2).
 */

/** Who is being refused. Drives what evidence may be disclosed. */
export type RefusalAudience = "agent" | "operator";

/**
 * The closed set of rules that can refuse. A client branches on this; free-text
 * reasons are unmatchable and drift, so they are not an option here.
 *
 * Naming is `<domain>.<rule>` so a surface can group without parsing prose.
 */
export type RefusalRule =
  // — ship / merge gates ————————————————————————————
  | "ship.review_blind"
  | "ship.review_unavailable"
  // — roles ————————————————————————————————————————
  | "role.ceiling"
  | "role.profile_exceeds"
  // — capability + tier ————————————————————————————
  | "capability.tier"
  | "capability.job_mismatch"
  | "capability.expired"
  // — partition ————————————————————————————————————
  | "partition.mismatch"
  // — MCP ——————————————————————————————————————————
  | "mcp.tool_not_in_tier"
  | "mcp.server_denied"
  // — budget + delegation ——————————————————————————
  | "budget.exhausted"
  | "delegation.depth"
  | "delegation.children"
  | "delegation.descendants"
  // — workflow ——————————————————————————————————————
  | "workflow.not_amendable"
  // — pre-edit ——————————————————————————————————————
  | "preedit.impact_high"
  | "preedit.index_stale"
  // — protocol ——————————————————————————————————————
  | "protocol.version_skew";

/** One disclosed fact. Label/value pairs, never prose. */
export type RefusalFact = {
  readonly label: string;
  readonly value: string | number | boolean;
};

/**
 * The lawful way forward. `kind: "none"` is a first-class answer — a permanent
 * boundary has no next action, and saying so is more useful than inventing a
 * suggestion the caller will waste a turn on.
 */
export type RefusalAction =
  | { readonly kind: "none"; readonly because: string }
  | { readonly kind: "operator"; readonly action: string }
  | { readonly kind: "command"; readonly command: string; readonly action: string }
  | { readonly kind: "retry"; readonly after: string };

export type Refusal = {
  readonly rule: RefusalRule;
  /** One sentence, human-first. Never contains disclosed values (see D2). */
  readonly summary: string;
  readonly evidence: readonly RefusalFact[];
  readonly nextAction?: RefusalAction;
  /** Where it was enforced, for the operator's benefit. */
  readonly surface: string;
  /**
   * Whether this refusal is telling the caller everything it knows.
   *
   * `"withheld"` marks a refusal that is DELIBERATELY less informative than the
   * enforcement site could be. MUON has several of these on purpose — the
   * memory partition fence answers two different causes ("that path is not in
   * the allowlist" and "that workspace exists but is not yours") with one
   * identical message, because telling them apart is how an agent maps which
   * repositories exist on the machine.
   *
   * Marking it makes the collapse legible AS a collapse. Without this an
   * explain surface reads a terse refusal as a lazy one and someone
   * "improves" it, which is a security regression that looks like polish.
   */
  readonly disclosure: "full" | "withheld";
};

/**
 * Per-rule disclosure policy.
 *
 * `disclose` names the evidence labels each audience may see. A fact whose
 * label is not listed for an audience is DROPPED for that audience — so adding
 * a new evidence field to an enforcement site does not leak it until someone
 * publishes it here deliberately.
 */
type RuleSpec = {
  /** Short human title, for grouping in a help/explain surface. */
  readonly title: string;
  readonly disclose: {
    readonly agent: readonly string[];
    readonly operator: readonly string[];
  };
};

/**
 * NEVER disclosed to anyone, at any site: token/capability material, the
 * existence or identity of another partition's chat/workspace/task/lane, an
 * operator-only setting's value, another principal's identity. These labels are
 * refused centrally as a backstop even if a rule spec lists them by mistake.
 */
const NEVER_DISCLOSE = [
  "token",
  "bearer",
  "secret",
  "capability",
  "apiKey",
  "password",
  "credential",
] as const;

function isNeverDisclosed(label: string): boolean {
  const lowered = label.toLowerCase();
  return NEVER_DISCLOSE.some((banned) => lowered.includes(banned));
}

export const REFUSAL_RULES: Readonly<Record<RefusalRule, RuleSpec>> = {
  "ship.review_blind": {
    title: "Merge blocked — review blind",
    // The operator is deciding the merge and needs the file list; the agent
    // needs only the counts, because a blind-file list is a workspace path set.
    disclose: {
      agent: ["blindFiles", "changedFiles", "verdict"],
      // `note` is review_diff's own honesty rail ("1/2 changed file(s) are not
      // in the graph"). Operator-only: it names files.
      operator: [
        "note",
        "blindFiles",
        "changedFiles",
        "verdict",
        "firstBlindFile",
        "indexAgeMinutes",
      ],
    },
  },
  "ship.review_unavailable": {
    title: "Merge blocked — review evidence unavailable",
    disclose: {
      agent: ["reason"],
      operator: ["reason", "indexAgeMinutes"],
    },
  },
  "role.ceiling": {
    title: "Role refused — outside this lane's ceiling",
    disclose: {
      agent: ["vendor", "requestedRole", "allowedRoles"],
      operator: ["vendor", "requestedRole", "allowedRoles"],
    },
  },
  "role.profile_exceeds": {
    title: "Launch refused — composed profile exceeds the role",
    disclose: {
      agent: ["role", "field", "requested", "ceiling"],
      operator: ["role", "field", "requested", "ceiling", "vendor"],
    },
  },
  "capability.tier": {
    title: "Refused — this verb is operator-tier",
    // The agent learns the tier it holds and the tier required, never what an
    // operator token would additionally reach.
    disclose: {
      agent: ["heldTier", "requiredTier"],
      operator: ["heldTier", "requiredTier", "verb"],
    },
  },
  "capability.job_mismatch": {
    title: "Refused — capability is bound to a different job",
    // Deliberately NO ids to the agent: naming the bound job would disclose the
    // existence of work it is not part of.
    disclose: { agent: [], operator: ["boundJobId", "requestedJobId"] },
  },
  "capability.expired": {
    title: "Refused — capability lapsed",
    disclose: {
      agent: ["expiredAt"],
      operator: ["expiredAt", "leaseKey"],
    },
  },
  "partition.mismatch": {
    title: "Refused — outside this workspace partition",
    // The agent is told ONLY that it crossed a boundary. Naming the other side
    // discloses that another workspace/chat exists, which is the leak.
    disclose: { agent: [], operator: ["callerPartition", "targetPartition"] },
  },
  "mcp.tool_not_in_tier": {
    title: "Tool refused — not in this tier",
    disclose: {
      agent: ["tool", "tier"],
      operator: ["tool", "tier", "availableIn"],
    },
  },
  "mcp.server_denied": {
    title: "MCP server refused — deny-first",
    disclose: {
      agent: ["server"],
      operator: ["server", "reason"],
    },
  },
  "budget.exhausted": {
    title: "Refused — budget exhausted",
    disclose: {
      agent: ["remainingMs", "requestedMs"],
      operator: ["remainingMs", "requestedMs", "budgetOwner"],
    },
  },
  "delegation.depth": {
    title: "Delegation refused — depth cap",
    disclose: {
      agent: ["depth", "cap"],
      operator: ["depth", "cap", "rootJobId"],
    },
  },
  "delegation.children": {
    title: "Delegation refused — per-parent child cap",
    disclose: {
      agent: ["children", "cap"],
      operator: ["children", "cap", "parentJobId"],
    },
  },
  "delegation.descendants": {
    title: "Delegation refused — aggregate descendant cap",
    disclose: {
      agent: ["descendants", "cap"],
      operator: ["descendants", "cap", "rootJobId"],
    },
  },
  "workflow.not_amendable": {
    // ADR-0045 D5: appending to a run that has stopped produces work no
    // executor will ever pick up — a silently dropped instruction, the worst
    // failure shape available here. The refusal names the run's ACTUAL status
    // because the caller already holds the run id it just addressed, so a
    // status discloses nothing it could not read from the run itself.
    title: "Amendment refused — this run's status cannot gain a step",
    disclose: {
      agent: ["status", "amendable"],
      operator: ["status", "amendable", "runId"],
    },
  },
  "preedit.impact_high": {
    title: "Edit refused — blast radius",
    disclose: {
      agent: ["risk", "directCallers", "symbol"],
      operator: ["risk", "directCallers", "symbol", "affectedProcesses"],
    },
  },
  "preedit.index_stale": {
    title: "Edit refused — code index is stale",
    disclose: {
      agent: ["indexCommit", "headCommit"],
      operator: ["indexCommit", "headCommit", "indexAgeMinutes"],
    },
  },
  "protocol.version_skew": {
    // Round-3 #4: four surfaces ride one embedded backend, and a staged swap
    // can replace one of them independently. A skewed envelope used to die as
    // a generic parse error; the honest answer names both versions and which
    // side to update. Versions are coordinates, not secrets — both audiences
    // see the same three facts.
    title: "Refused — protocol version skew",
    disclose: {
      agent: ["surface", "expected", "received"],
      operator: ["surface", "expected", "received"],
    },
  },
};

export function refusalTitle(rule: RefusalRule): string {
  return REFUSAL_RULES[rule].title;
}

/**
 * Rules whose refusal is deliberately collapsed: the enforcement site knows
 * more than it says, and saying more would be an oracle. Declared here so a
 * site cannot accidentally mark one `"full"`.
 */
const ALWAYS_WITHHELD: readonly RefusalRule[] = [
  // Distinguishing "not in the allowlist" from "exists but not yours" maps the
  // machine's repositories.
  "partition.mismatch",
  // Naming the bound job discloses the existence of work the caller is not in.
  "capability.job_mismatch",
];

/** Build a refusal at an enforcement site. */
export function buildRefusal(input: {
  rule: RefusalRule;
  summary: string;
  surface: string;
  evidence?: readonly RefusalFact[];
  nextAction?: RefusalAction;
  /** Defaults to `"full"`; forced to `"withheld"` for the rules above. */
  disclosure?: "full" | "withheld";
}): Refusal {
  const disclosure = ALWAYS_WITHHELD.includes(input.rule)
    ? "withheld"
    : (input.disclosure ?? "full");
  return {
    rule: input.rule,
    summary: input.summary,
    surface: input.surface,
    evidence: input.evidence ?? [],
    nextAction: input.nextAction,
    disclosure,
  };
}

export function isDeliberatelyWithheld(rule: RefusalRule): boolean {
  return ALWAYS_WITHHELD.includes(rule);
}

/**
 * The evidence one audience may see: the rule's allowlist for that audience,
 * minus the central never-disclose backstop. Order follows the allowlist, so a
 * surface renders the most important fact first regardless of the order the
 * enforcement site happened to supply.
 */
export function disclosedEvidence(
  refusal: Refusal,
  audience: RefusalAudience
): RefusalFact[] {
  const allowed = REFUSAL_RULES[refusal.rule]?.disclose[audience] ?? [];
  const out: RefusalFact[] = [];
  for (const label of allowed) {
    if (isNeverDisclosed(label)) continue;
    const fact = refusal.evidence.find((item) => item.label === label);
    if (fact) out.push(fact);
  }
  return out;
}

/**
 * The audience-safe projection sent over the wire. The summary and next action
 * are authored at the enforcement site and must already be audience-safe; the
 * evidence is filtered here.
 */
export function projectRefusal(
  refusal: Refusal,
  audience: RefusalAudience
): Refusal {
  return {
    ...refusal,
    evidence: disclosedEvidence(refusal, audience),
  };
}

/** One-line rendering for a terminal surface. */
export function renderRefusalLine(
  refusal: Refusal,
  audience: RefusalAudience
): string {
  const facts = disclosedEvidence(refusal, audience)
    .map((fact) => `${fact.label}=${String(fact.value)}`)
    .join(" · ");
  const next = refusal.nextAction
    ? ` → ${describeAction(refusal.nextAction)}`
    : "";
  // A withheld refusal says so, so a terse message is not mistaken for a lazy
  // one by the next person who reads it.
  const withheld =
    refusal.disclosure === "withheld" && audience === "agent"
      ? " (details deliberately withheld)"
      : "";
  return facts
    ? `${refusal.summary} [${facts}]${next}${withheld}`
    : `${refusal.summary}${next}${withheld}`;
}

export function describeAction(action: RefusalAction): string {
  switch (action.kind) {
    case "none":
      return `no way forward: ${action.because}`;
    case "operator":
      return `an operator must ${action.action}`;
    case "command":
      return `${action.action} — \`${action.command}\``;
    case "retry":
      return `retry ${action.after}`;
  }
}
