/**
 * THE brief contract — one list, every consumer that TEACHES it or COUNTS it.
 *
 * A child brief is the only artifact that crosses from the coordinator to a
 * worker, and MUON judges it twice: something tells the coordinator which
 * headings to write, and the dispatch-contract verifier counts them. When those
 * two lists are written separately they drift, and a coordinator that followed
 * its instructions verbatim is failed for obeying them. That has now happened
 * five times:
 *
 *   1. the prompt said `SCOPE:` while the verifier demanded `OWNED SCOPE:`;
 *   2. the prompt said "GOAL, MODE, SCOPE" while the verifier demanded
 *      `ROLE:`/`OWNED SCOPE:` (commit 20656b7);
 *   3. the verifier demanded DELIVERABLES + CHECKS while the prompt buried them
 *      inside a 200-word parenthetical the coordinator read past — two correct,
 *      live dispatches were convicted for a formatting counter;
 *   4. the `dispatch` MCP tool description — the ONE artifact an externally
 *      launched coordinator reads, since it never sees the system prompt — named
 *      ten of the twelve headings in hand-written prose, omitting COORDINATION
 *      and FINAL REPORT. A session that followed it verbatim wrote ten, and
 *      `childBriefDeficiency` refused to count its child;
 *   5. the `delegate` MCP tool description said "copy GOAL, SCOPE, CHECKS, and
 *      AUTHORITY" — three of twelve plus an alias. Found by the lock below
 *      rather than by a mission, which is the whole point of writing it.
 *
 * Instance 4 is why this module lives in `@muon/protocol` rather than in
 * `@muon/orchestrator`, where it started. `@muon/mcp` does not depend on
 * `@muon/orchestrator` and cannot, so the MCP boundary had no way to import the
 * list and restated it in prose — the drift was structurally guaranteed.
 * `@muon/protocol` is the package every surface already depends on, so every
 * teacher and the one counter now read the SAME array.
 *
 * So the list lives HERE, once. `ORCHESTRATOR_SYSTEM_PROMPT` renders its mandate
 * from {@link briefHeadingMandate}; the `dispatch`, `create_task` and `delegate`
 * MCP tool descriptions render theirs from {@link briefHeadingMandate} /
 * {@link briefHeadingList} / {@link taskHeadingList} /
 * {@link childBriefSkeleton}; `childBriefDeficiency`
 * counts exactly {@link CHILD_BRIEF_HEADINGS}; and drift-lock tests parse the
 * RENDERED prompt (`packages/orchestrator/tests/brief-contract.test.ts`) and the
 * RENDERED tool descriptions (`packages/mcp/tests/brief-contract-drift-lock.test.ts`)
 * and assert the headings each names are exactly the set the verifier enforces.
 * The next drift is a red test, not a live mission failure.
 *
 * Deliberately dependency-free — no zod, no sibling module — so every consumer
 * can import it without a cycle and without pulling a schema runtime into a
 * tool-description renderer.
 */

/**
 * Every heading a governed child brief MUST declare, in the order a brief
 * writes them. The verifier requires a NON-EMPTY declaration for each.
 *
 * This is a contract about DECLARATIONS, not prose: each heading is one
 * question the worker cannot ask a follow-up about, so a brief that omits one
 * ships an under-specified worker. `ROLE`/`OWNED SCOPE` additionally have to
 * match the filed ledger task (the verifier compares them); the rest only have
 * to be present and non-empty — MUON never grades their content.
 */
export const CHILD_BRIEF_HEADINGS = [
  "ROLE",
  "OWNED SCOPE",
  "GOAL",
  "MODE",
  "CONTEXT",
  "GRAPH DISCIPLINE",
  "COORDINATION",
  "DELIVERABLES",
  "CHECKS",
  "AUTHORITY",
  "STOP CONDITION",
  "FINAL REPORT",
] as const;

export type ChildBriefHeading = (typeof CHILD_BRIEF_HEADINGS)[number];

/**
 * The headings a filed CREW TASK description must declare. A subset of the
 * brief contract on purpose: the ledger row records who owns what and how they
 * coordinate, while the brief carries the whole one-shot contract.
 */
export const CREW_TASK_HEADINGS = [
  "ROLE",
  "OWNED SCOPE",
  "COORDINATION",
] as const;

/**
 * The headings one required declaration may legally arrive under.
 *
 * An alias may only be a heading that makes the SAME declaration under another
 * name: `SCOPE` still names the ground the worker owns. It may never be a
 * heading that declares something ELSE — `GOAL:` is not a role, so a brief that
 * states a goal and no role declares no role and still fails. That is the
 * requirement; the wording never was.
 *
 * Ordered, canonical first, so a text carrying both reads the canonical one.
 */
export const HEADING_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ROLE: ["ROLE", "CREW ROLE", "AGENT ROLE", "WORKER ROLE"],
  "OWNED SCOPE": ["OWNED SCOPE", "SCOPE", "OWNED PATHS", "OWNED FILES"],
  MODE: ["MODE", "BRIEF MODE"],
  "GRAPH DISCIPLINE": ["GRAPH DISCIPLINE", "GRAPH-DISCIPLINE"],
  DELIVERABLES: ["DELIVERABLES", "DELIVERABLE"],
  CHECKS: ["CHECKS", "CHECK", "VERIFICATION"],
  "STOP CONDITION": ["STOP CONDITION", "STOP CONDITIONS"],
  "FINAL REPORT": ["FINAL REPORT", "FINAL REPORT SECTIONS"],
};

/**
 * One parsed heading line: the heading it declares and whatever followed the
 * colon ON THAT LINE. An empty `inline` is not an empty declaration — the value
 * may be the block underneath, which {@link headingValues} resolves.
 *
 * `boundary` is what separates a heading from a colon-bearing SENTENCE. Only a
 * boundary ends the block above it (see {@link headingValues}); everything else
 * is content that happens to contain a colon.
 */
type ParsedHeading = {
  heading: string;
  inline: string;
  line: number;
  boundary: boolean;
};

/**
 * Every heading name the contract knows, canonical and aliased. A colon-line is
 * a section boundary only if it names one of these — or was explicitly
 * decorated as a heading (`## X`, `**X**`).
 */
const KNOWN_HEADINGS = new Set<string>(
  [
    ...CHILD_BRIEF_HEADINGS,
    ...CREW_TASK_HEADINGS,
    ...Object.values(HEADING_ALIASES).flat(),
  ].map((heading) => heading.replace(/[\s_-]+/g, " ").trim().toUpperCase())
);

/**
 * Parse ONE line as a heading declaration, tolerating the markdown vendors
 * actually emit (`**ROLE:** x`, `**ROLE**: x`, `## ROLE`, `> ROLE: x`).
 *
 * A LIST MARKER is deliberately NOT decoration. `- tests: packages/x/y.test.ts`
 * is content belonging to the heading above it, and reading it as a heading of
 * its own would truncate that heading's block to nothing — turning a perfectly
 * good `DELIVERABLES:` + bullet list into "declares no DELIVERABLES", which is
 * the exact failure mode this module exists to end.
 *
 * The heading NAME is de-decorated; the VALUE is left byte-exact apart from a
 * leading bold wrapper, because `**` inside a scope declaration is a glob
 * (`packages/core/**`) and stripping it would silently rewrite the authority
 * half of the line.
 */
function parseHeadingLine(raw: string): Omit<ParsedHeading, "line"> | undefined {
  const stripped = raw.replace(/^[\s>#]+/, "").replace(/^\*\*/, "").trimEnd();
  // Decorated = the author MARKED this as a heading, so it is a boundary even
  // when the name is one the contract does not know (`## APPENDIX`).
  const decorated = /^\s*(?:#{1,6}\s|\*\*)/.test(raw);
  const withColon = /^([A-Za-z][A-Za-z0-9 /_-]{0,40}?)\s*\*{0,2}\s*:\s*(.*)$/.exec(
    stripped
  );
  if (withColon) {
    const heading = normalizeHeading(withColon[1]!);
    return {
      heading,
      inline: withColon[2]!.replace(/^\*{0,2}\s*/, "").trim(),
      boundary: decorated || KNOWN_HEADINGS.has(heading),
    };
  }
  // A colon-LESS heading counts only when the line was DECORATED as one (`##
  // DELIVERABLES`, `**CHECKS**`). Without that evidence any sentence would read
  // as a heading, so this stays narrow on purpose.
  const decoratedOnly = /^\s*(?:#{1,6}\s+(.+?)|\*\*(.+?)\*\*)\s*$/.exec(raw);
  const name = decoratedOnly?.[1] ?? decoratedOnly?.[2];
  if (name && /^[A-Za-z][A-Za-z0-9 /_-]{0,40}$/.test(name.trim())) {
    return { heading: normalizeHeading(name), inline: "", boundary: true };
  }
  return undefined;
}

function normalizeHeading(value: string): string {
  return value.replace(/[\s_-]+/g, " ").trim().toUpperCase();
}

/**
 * Every heading a text declares, mapped to its non-empty value.
 *
 * BLOCK FORM COUNTS. `DELIVERABLES:` on its own line with the list underneath
 * is how a competent engineer writes a list, and the check that only read the
 * REST OF THE SAME LINE convicted exactly that brief. A declaration is present
 * when it has content on its line OR in the lines before the next heading.
 */
export function headingValues(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const parsed = parseHeadings(lines);
  // ONLY a boundary ends the section above it. A colon-bearing SENTENCE inside a
  // block — `see https://internal/doc`, `Note: the patch and tests`,
  // `docs/adr/0022: the vendor ledger` — is content, and treating it as a
  // heading emptied the block above it and reported that heading MISSING.
  // CONTEXT is exactly where the prompt tells the coordinator to quote URLs and
  // evidence, so this was a guaranteed false conviction.
  const sections = parsed.filter((entry) => entry.boundary);
  const values = new Map<string, string>();
  sections.forEach((entry, index) => {
    const value =
      entry.inline ||
      lines
        .slice(entry.line + 1, sections[index + 1]?.line ?? lines.length)
        .join("\n")
        .trim();
    // First declaration wins: a brief that repeats a heading (an outline plus
    // the real section) is read at the point it first declared it.
    if (value && !values.has(entry.heading)) values.set(entry.heading, value);
  });
  return values;
}

function parseHeadings(lines: string[]): ParsedHeading[] {
  const parsed: ParsedHeading[] = [];
  lines.forEach((raw, line) => {
    const heading = parseHeadingLine(raw);
    if (heading) parsed.push({ ...heading, line });
  });
  return parsed;
}

/** The value a text declares for one required heading, alias-aware. */
export function headingValue(text: string, heading: string): string | undefined {
  const values = headingValues(text);
  for (const alias of HEADING_ALIASES[heading] ?? [heading]) {
    const value = values.get(normalizeHeading(alias));
    if (value) return value;
  }
  return undefined;
}

/**
 * The headings a text ACTUALLY declares, so a contract failure can show the
 * coordinator what it wrote instead of only restating what was required. A
 * verdict it cannot act on costs a whole corrective round; naming the headings
 * it did write is what lets it repair the brief on the first try. Bounded, and
 * best-effort by construction — evidence for a human and a hint for the next
 * turn, never an authority decision.
 */
export function declaredHeadings(text: string): string[] {
  // Deliberately LOOSER than `headingValues`: this answers "what did you
  // write", not "where does a section end". A coordinator that wrote
  // `OBJECTIVE:` where the contract wanted `GOAL:` needs to SEE `OBJECTIVE` in
  // the verdict — reporting "no headings at all" would hide the near-miss that
  // explains the failure.
  const seen: string[] = [];
  for (const entry of parseHeadings(text.split(/\r?\n/))) {
    if (!seen.includes(entry.heading)) seen.push(entry.heading);
    if (seen.length >= CHILD_BRIEF_HEADINGS.length + 4) break;
  }
  return seen;
}

/** The required brief headings a text does NOT declare, in contract order. */
export function missingBriefHeadings(text: string): string[] {
  return CHILD_BRIEF_HEADINGS.filter((heading) => !headingValue(text, heading));
}

/** The required task headings a filed description does NOT declare. */
export function missingTaskHeadings(description: string): string[] {
  return CREW_TASK_HEADINGS.filter(
    (heading) => !headingValue(description, heading)
  );
}

/** `ROLE:, OWNED SCOPE:, …` — the mandate as the prompt and the contract state it. */
export function briefHeadingList(): string {
  return CHILD_BRIEF_HEADINGS.map((heading) => `${heading}:`).join(" ");
}

/** `ROLE:, OWNED SCOPE:, and COORDINATION:` — the filed-task mandate. */
export function taskHeadingList(): string {
  const headings = CREW_TASK_HEADINGS.map((heading) => `${heading}:`);
  return `${headings.slice(0, -1).join(", ")}, and ${headings.at(-1)}`;
}

/**
 * The mandate sentence the system prompt renders. The drift-lock test parses
 * THIS text back out of the rendered prompt and asserts the headings it names
 * are exactly {@link CHILD_BRIEF_HEADINGS} — so a hand-edit to the prompt that
 * adds or drops a heading fails the suite instead of a live mission.
 */
export function briefHeadingMandate(): string {
  return (
    `Write these ${CHILD_BRIEF_HEADINGS.length} headings, each on its own line and each with content, in this order — ` +
    `MUON verifies EVERY one of them and does not count a child dispatch whose brief is missing any: ${briefHeadingList()}`
  );
}

/**
 * One compliant brief, quoted verbatim wherever a contract failure is reported.
 * A verdict that names what is missing still costs a round trip if the
 * coordinator has to guess the shape; the remedy is quoted so the repair is
 * mechanical. The drift-lock feeds this skeleton back through the verifier, so
 * the example MUON hands out is provably one MUON accepts.
 */
export function childBriefSkeleton(): string {
  const value: Record<string, string> = {
    ROLE: "<the filed task's ROLE, verbatim>",
    "OWNED SCOPE": "<the filed task's OWNED SCOPE paths, verbatim; everything else read-only>",
    GOAL: "<the outcome, one sentence>",
    MODE: "implement | research | review",
    CONTEXT: "<confirmed memory + graph evidence, quoted; the worker cannot see this chat>",
    "GRAPH DISCIPLINE":
      "code_query the flows, code_context every symbol named here, code_impact + preflight_edit before any edit; STOP on HIGH/CRITICAL, stale, or unavailable evidence",
    COORDINATION: "<paths to claim, who to send review_request to, when to check peer_inbox>",
    DELIVERABLES: "<the artifacts/edits that prove this unit is done>",
    CHECKS: "<exact verification commands>",
    AUTHORITY: "no commit, push, merge, deploy, dependency install, or migration without approval",
    "STOP CONDITION": "<when to stop and hand off>",
    "FINAL REPORT":
      "what changed | checks run + results | graph queries run | uncertainties | recommended next action",
  };
  return CHILD_BRIEF_HEADINGS.map(
    (heading) => `${heading}: ${value[heading] ?? "<…>"}`
  ).join("\n");
}
