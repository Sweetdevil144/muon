import { NO_PRINTABLE_TEXT, terminalSafe, type HarnessRecord } from "@muon/client";
import { describePaletteCommand } from "./command-visibility.js";
import { PALETTE_COMMANDS, type PaletteCommand } from "./palette.js";

/**
 * ADR-0042 D6 — one catalogue of everything you can invoke.
 *
 * MUON models four kinds of "a thing you can run" in four separate registries,
 * and surfaces them in four different places (or, for two of them, nowhere):
 *
 *   commands      `PALETTE_COMMANDS`      — the palette
 *   harnesses     `listHarnesses()`       — a CLI flag, no TUI surface
 *   custom agents `listCustomAgents()`    — desktop only
 *   workflows     propose/apply           — a command, not a listing
 *
 * A user should not have to know which of MUON's internal registries a thing
 * lives in to run it, and today they do: `/ship` is discoverable and the
 * `security-audit` harness is not, for no reason a user could state.
 *
 * This is the ONE list, with one filter and one shape. Deliberately pure and
 * renderer-agnostic — it is data, not a widget — so it survives the Ink→pi
 * substrate change (ADR-0042 D1) rather than being rewritten with it.
 *
 * AUTHORITY IS NOT DECORATION. Every entry carries what it can do, from
 * `command-visibility.ts` where that already exists. A catalogue that lists a
 * governed act beside a read with no visible difference is how someone runs
 * `ship` looking for `status`.
 */

export type CatalogueKind =
  | "command"
  | "harness"
  | "agent"
  | "workflow";

export type CatalogueEntry = {
  readonly id: string;
  /**
   * The sanitized name a human would TYPE to find this. Never the id.
   *
   * Matching and ranking used to read `id` directly, which contradicted this
   * file's own rule that what you read is what you match: a harness keyed
   * `deploy-prod` but labelled "Read-only lint" was returned and ranked for
   * the query `deploy`, on identity text the reader could not see, and — for
   * a stored source — text that was never sanitized (pass 11 F8). The id is
   * identity and stays raw; this is the match surface and is sanitized like
   * everything else a query touches.
   */
  readonly matchKey: string;
  readonly kind: CatalogueKind;
  readonly label: string;
  /** One line. What it does — never a paragraph (ADR-0042 D7). */
  readonly effect: string;
  /**
   * What running it can do. Absent means MUON does not KNOW, which is shown as
   * unknown rather than as "safe" — the same posture as every other MUON
   * surface that cannot attest something.
   */
  readonly authority?: string;
  /** Terms the filter matches beyond the label. */
  readonly keywords: readonly string[];
  /** False when the thing exists but cannot be run right now. */
  readonly enabled: boolean;
  /** A short badge, e.g. a vendor name for a vendor action. */
  readonly badge?: string;
};

/** Kind order in the rendered list. Commands first: they are what `/` is for. */
const KIND_ORDER: Record<CatalogueKind, number> = {
  command: 0,
  workflow: 1,
  harness: 2,
  agent: 3,
};

export const KIND_LABEL: Record<CatalogueKind, string> = {
  command: "command",
  workflow: "workflow",
  harness: "harness",
  agent: "agent",
};

/**
 * THE TRUST BOUNDARY OF THIS FILE.
 *
 * Commands are static and in-repo. Harnesses and custom agents are NOT: their
 * names, descriptions, overlay values and tool lists are stored rows that a
 * vendor, an agent, or a corrupted write authored, and this catalogue is the
 * first thing that puts them on a terminal. `terminalSafe` is the ONE
 * sanitizer for that text everywhere else in MUON; it was missing here, so a
 * harness named with a CSI run could repaint the palette — the surface whose
 * Enter executes — and a bidi override in a tool name could reorder the
 * PRE-AUTHORIZES sentence, which is the single highest-stakes line this
 * catalogue renders.
 *
 * Sanitizing HERE rather than at the render site is deliberate: the entry is
 * also what the filter matches and what `band()` ranks, so a payload that
 * survived into those would win ordering with characters the human cannot
 * see. What you read is what you match is what you press.
 *
 * The id is deliberately NOT sanitized — it is identity, not text, it reaches
 * no screen (the `elsewhere` reasons interpolate only a static constant), and
 * flattening it could collide two distinct harnesses into one row.
 */
const safe = (value: string): string => terminalSafe(value);

/** Sanitize match terms, dropping any that carried no printable text. */
const safeKeywords = (values: readonly string[]): string[] =>
  values
    .map((value) => terminalSafe(value))
    .filter((value) => value !== "" && value !== NO_PRINTABLE_TEXT);

function fromCommand(command: PaletteCommand): CatalogueEntry {
  const visibility = describePaletteCommand(command);
  return {
    id: `command:${command.id}`,
    matchKey: command.id,
    kind: "command",
    label: command.label,
    effect: visibility.effect,
    authority: visibility.authority,
    keywords: command.keywords,
    enabled: command.enabled,
    ...(command.badge ? { badge: command.badge } : {}),
  };
}

/**
 * A harness is a named execution-constraint bundle: a profile overlay, checks,
 * a budget, and — since feature #10 — the tools its work requires. What a user
 * needs to see is what it CONSTRAINS, because that is the reason to pick one.
 */
function fromHarness(harness: HarnessRecord): CatalogueEntry {
  const config = harness.config;
  const applies: string[] = [];
  // Typed as enums, but they arrive as JSON from a stored row — a value the
  // type says is impossible is exactly the value worth sanitizing.
  if (config.profileOverlay?.sandbox) {
    applies.push(safe(config.profileOverlay.sandbox));
  }
  if (config.profileOverlay?.permissionMode) {
    applies.push(safe(config.profileOverlay.permissionMode));
  }
  if (config.checks?.length) {
    applies.push(`${config.checks.length} check(s)`);
  }
  const preauthorized = (config.preauthorizedTools ?? []).map(safe);
  return {
    id: `harness:${harness.key}`,
    matchKey: safe(harness.key),
    kind: "harness",
    label: safe(harness.name),
    // The fallback is chosen BEFORE sanitizing: terminalSafe("") returns the
    // "(no printable text)" marker, so sanitizing first would turn an absent
    // description into a hostile-looking one.
    effect: safe(
      config.description ||
        (applies.length > 0
          ? `applies: ${applies.join(" · ")}`
          : "a named execution-constraint bundle")
    ),
    // CORRECTED, and the correction is the point. This said "Narrows the lane
    // it runs on … it can never widen one", cited ADR-0022, and a test pinned
    // it — the exact anti-pattern the observatory fix had condemned two commits
    // earlier ("a test that locks in a false statement is worse than no test").
    //
    // A harness is NOT narrowing-only. `applyHarnessToProfile`
    // (packages/core/src/harness.ts:225) unions `preauthorizedTools` into
    // `allowedTools`, and pre-authorization removes a human gate — that is a
    // widening by definition, and the protocol says so: "the only pre-auth
    // path, everything outside it stays must-ask through the approvals inbox".
    // `mergeHarnessOverlay` also lets the overlay REPLACE `permissionMode` and
    // `sandbox` with any value, so an overlay can set a wider mode than the
    // lane had. (The ADR-0022 citation was wrong too: that is the vendor
    // registry ADR and says nothing about harness overlays.)
    //
    // So this reports what the harness DOES, and names the pre-authorized
    // tools explicitly — the single field that grants authority was the single
    // field this surface omitted.
    authority:
      (applies.length > 0
        ? `Sets ${applies.join(" · ")} on the lane it runs on.`
        : "Applies a named constraint bundle to the lane it runs on.") +
      (preauthorized.length > 0
        ? ` PRE-AUTHORIZES ${preauthorized.join(", ")} — those run WITHOUT asking you.`
        : " Pre-authorizes nothing; everything else stays must-ask."),
    keywords: safeKeywords([harness.key, "harness", ...applies, ...preauthorized]),
    enabled: true,
  };
}

/**
 * A custom agent is UNGOVERNED by construction — that is the whole point of
 * the separate id namespace — so the catalogue says so rather than letting it
 * sit beside governed lanes looking identical.
 */
export type CustomAgentLike = {
  readonly id: string;
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string;
};

function fromCustomAgent(agent: CustomAgentLike): CatalogueEntry {
  // A name of only zero-width characters is TRUTHY, so it wins the fallback
  // chain and then sanitizes to the marker. That is the honest outcome: the
  // row is named something unrenderable, and falling through to the slug
  // would hide that fact behind a plausible-looking label.
  const label = safe(agent.name || agent.slug || agent.id);
  return {
    id: `agent:${agent.id}`,
    matchKey: safe(agent.slug ?? agent.id),
    kind: "agent",
    label,
    effect: safe(agent.description || "a custom agent you registered"),
    authority:
      "UNGOVERNED — MUON did not spawn it, so MUON's gates do not apply to what it does to your filesystem.",
    keywords: safeKeywords([agent.slug ?? "", "custom", "agent"]),
    enabled: true,
    badge: "ungoverned",
  };
}

export type CatalogueSources = {
  readonly commands?: readonly PaletteCommand[];
  readonly harnesses?: readonly HarnessRecord[];
  readonly customAgents?: readonly CustomAgentLike[];
};

/**
 * Build the catalogue from whatever the caller could load.
 *
 * A source that failed to load is simply ABSENT, never a fabricated empty
 * category: "you have no harnesses" and "MUON could not read your harnesses"
 * are different facts, and the caller owns which it reports.
 */
export function buildCatalogue(sources: CatalogueSources): CatalogueEntry[] {
  const entries: CatalogueEntry[] = [
    ...(sources.commands ?? PALETTE_COMMANDS).map(fromCommand),
    ...(sources.harnesses ?? []).map(fromHarness),
    ...(sources.customAgents ?? []).map(fromCustomAgent),
  ];
  return entries.sort((left, right) => {
    const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    return byKind !== 0 ? byKind : left.label.localeCompare(right.label);
  });
}

/**
 * Filter by a typed query.
 *
 * A `kind:` prefix narrows to one category (`harness:audit`), because with four
 * kinds in one list "show me only harnesses" is the first thing anyone wants.
 * Matching is substring and case-insensitive — no fuzzy scoring, because a
 * catalogue that reorders itself unpredictably as you type is harder to use
 * than one that simply shrinks.
 */
export function filterCatalogue(
  entries: readonly CatalogueEntry[],
  query: string
): CatalogueEntry[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return [...entries];

  let kind: CatalogueKind | null = null;
  let term = trimmed;
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const head = trimmed.slice(0, colon);
    const match = (Object.keys(KIND_LABEL) as CatalogueKind[]).find(
      (candidate) => candidate === head
    );
    if (match) {
      kind = match;
      term = trimmed.slice(colon + 1).trim();
    }
  }

  const matched = entries.filter((entry) => {
    if (kind && entry.kind !== kind) return false;
    if (term === "") return true;
    // The KEY matches too: a user who knows the exact command name
    // ("task-new") must find it — the classic palette always matched ids,
    // and losing that made the fastest path find NOTHING. `matchKey`, not
    // `id`: same reach, but sanitized and free of the `kind:` prefix that
    // made every entry match its own category name (pass 11 F8).
    if (entry.matchKey.toLowerCase().includes(term)) return true;
    if (entry.label.toLowerCase().includes(term)) return true;
    if (entry.effect.toLowerCase().includes(term)) return true;
    return entry.keywords.some((keyword) =>
      keyword.toLowerCase().includes(term)
    );
  });
  if (term === "") return matched;

  // RANK by match quality, not just kind+label. Filtering alone put
  // "Quickstart: run your first task…" above "Run task on lane" for the query
  // `run`, because Q sorts before R — so the fastest path to a command
  // highlighted a DIFFERENT command, on a list whose Enter executes. The
  // classic palette has always scored matches; this is the same idea kept
  // COARSE (four bands) so the list shrinks predictably as you type instead
  // of reshuffling under the cursor.
  const band = (entry: CatalogueEntry): number => {
    const bare = entry.matchKey.toLowerCase();
    const label = entry.label.toLowerCase();
    if (bare === term || label === term) return 0;
    if (bare.startsWith(term) || label.startsWith(term)) return 1;
    if (entry.keywords.some((keyword) => keyword.toLowerCase() === term)) {
      return 2;
    }
    return 3;
  };
  return matched.sort((left, right) => {
    const byBand = band(left) - band(right);
    if (byBand !== 0) return byBand;
    const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    return byKind !== 0 ? byKind : left.label.localeCompare(right.label);
  });
}
