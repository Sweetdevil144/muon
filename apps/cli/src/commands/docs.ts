import type { Command } from "commander";
import {
  DOCS_MAX_BACKLINKS,
  DOCS_MAX_RESULTS,
  DocsRefusal,
  TIER_PRIOR,
  createDocsGraph,
  provenanceOf,
  type DocsContextResult,
  type DocsImpactResult,
  type DocsProvenance,
  type DocsQueryResult,
  type DocsStatusResult,
  type DocTier,
} from "@muon/docgraph";
import { failCommand } from "../lib/refusal.js";
import { printJson } from "../lib/output.js";

/**
 * ADR-0053 — the repository's own prose, from the terminal.
 *
 * In-process and client-free, like `muon project` and `muon question`: there is
 * nothing to persist, no governance decision to make, and no brain round trip to
 * take. The corpus is the working tree's own markdown and the index is rebuilt on
 * demand in ~250 ms, so this command answers on a machine with no MUON server
 * running at all.
 *
 * CROSS-SURFACE PARITY IS THE POINT. Every verb calls the SAME
 * `@muon/docgraph` assembler the MCP tools call (`packages/mcp/src/docs-tools.ts`),
 * and `--json` prints that payload verbatim — so a defect reproduces identically
 * on both surfaces and neither can drift into its own dialect. The human
 * rendering below is composed FROM the payload, never assembled beside it: this
 * repository has been bitten by a governed op whose CLI and TUI call sites
 * disagreed, and a read surface earns the same discipline.
 *
 * `muon docs status` carries one thing the agent tier deliberately does not: the
 * DRIFT REPORT (unresolved and ambiguous citations, unclassified documents). It
 * is a hygiene report for a person, not a fourth agent tool.
 */

type SharedOptions = { workspace?: string; json?: boolean };

/** Bound to the resolved repository root by the core, from this start directory. */
function graphFor(options: SharedOptions) {
  return createDocsGraph(options.workspace ?? process.cwd());
}

function write(lines: string[]): void {
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * A typed refusal, rendered. `nextActions` is the near-miss list — for a stale
 * citation the likeliest cause is a renamed heading, so the recovery is a
 * coordinate rather than "check your input".
 */
function failRefusal(error: unknown, fallback: string, json: boolean): void {
  if (!(error instanceof DocsRefusal)) {
    failCommand(error, fallback);
    return;
  }
  if (json) {
    printJson({
      refusal: {
        code: error.code,
        reason: error.reason,
        action: error.action,
        nextActions: error.nextActions,
      },
    });
    process.exitCode = 1;
    return;
  }
  failCommand(
    new Error(
      [
        error.reason,
        error.action,
        ...(error.nextActions.length > 0
          ? [`nearest: ${error.nextActions.join("  ·  ")}`]
          : []),
      ].join("\n  ")
    ),
    fallback
  );
}

/** One provenance block, the same fields every payload carries. */
function renderProvenance(provenance: DocsProvenance): string[] {
  return [
    `repository: ${provenance.root}`,
    // `null` is not "unknown-ish": it is the explicit statement that git could
    // not be read and the corpus came off the filesystem. Never a stale commit.
    `commit: ${provenance.builtAtCommit ?? "unknown (corpus read from the filesystem, not from a commit)"}`,
    `worktree: ${
      provenance.worktreeDirty === null
        ? "unknown"
        : provenance.worktreeDirty
          ? "dirty"
          : "clean"
    }`,
    `corpus: ${provenance.files} files · ${provenance.sections} sections · ${provenance.excluded} excluded`,
    `tier source: ${provenance.tierSource} · corpus source: ${provenance.corpusSource}`,
    `built at: ${provenance.builtAt}`,
  ];
}

/** Every standing degradation, one line each. Silence means nothing degraded. */
function renderDegradation(degradation: {
  active: boolean;
  entries: { code: string; reason: string; action: string }[];
}): string[] {
  if (!degradation.active) {
    return [];
  }
  return [
    "",
    "degradations:",
    ...degradation.entries.flatMap((entry) => [
      `  ${entry.code}: ${entry.reason}`,
      `    → ${entry.action}`,
    ]),
  ];
}

function renderEvidence(
  evidence: { kind: string; included: number; omitted: number; limit: number }[]
): string[] {
  const bounded = evidence.filter((entry) => entry.omitted > 0);
  return bounded.length === 0
    ? []
    : [
        "",
        ...bounded.map(
          (entry) =>
            `bounded: ${entry.kind} — ${entry.included} shown of ${entry.included + entry.omitted} (cap ${entry.limit})`
        ),
      ];
}

function renderQuery(payload: DocsQueryResult): string[] {
  if (payload.results.length === 0) {
    return [
      "no section in this corpus matches that query.",
      ...renderDegradation(payload.degradation),
    ];
  }
  return [
    ...payload.results.flatMap((hit) => [
      `${hit.sectionId}`,
      `  ${hit.headingPath.join(" › ") || "(preamble)"}`,
      `  ${hit.tier}${hit.adrStatus ? `/${hit.adrStatus}` : ""}${hit.historical ? " · HISTORICAL" : ""} · lines ${hit.lines.start}-${hit.lines.end} · score ${hit.score.toFixed(3)}${hit.fenceLangs.length > 0 ? ` · fences: ${hit.fenceLangs.join(", ")}` : ""}`,
      `  ${hit.excerpt.split("\n").join(" ").slice(0, 240)}${hit.excerptTruncated ? " …" : ""}`,
      "",
    ]),
    `precedence: ${payload.precedence}`,
    ...renderEvidence(payload.evidence),
    ...renderDegradation(payload.degradation),
  ];
}

function renderContext(payload: DocsContextResult): string[] {
  if (payload.kind === "document") {
    return [
      `${payload.docPath}${payload.title ? ` — ${payload.title}` : ""}`,
      `${payload.tier}${payload.adrStatus ? `/${payload.adrStatus}` : ""} · ${payload.bytes} bytes · ${payload.lines} lines · ${payload.tracked === false ? "UNTRACKED (exists, not yet committed)" : payload.tracked === null ? "tracked: unknown" : "tracked"}`,
      "",
      "outline:",
      ...payload.outline.map(
        (entry) =>
          `  ${"  ".repeat(Math.max(0, entry.depth - 1))}${entry.headingPath.at(-1) ?? "(preamble)"}  [${entry.lines.start}-${entry.lines.end}]  ${entry.sectionId}`
      ),
      ...(payload.backlinks.length > 0
        ? ["", "linked from:", ...payload.backlinks.map((id) => `  ${id}`)]
        : []),
      ...renderEvidence(payload.evidence),
      ...renderDegradation(payload.degradation),
    ];
  }
  return [
    `${payload.sectionId}`,
    `  ${payload.headingPath.join(" › ") || "(preamble)"}`,
    `  ${payload.tier}${payload.adrStatus ? `/${payload.adrStatus}` : ""}${payload.historical ? " · HISTORICAL" : ""} · lines ${payload.lines.start}-${payload.lines.end} · ${payload.bytes} bytes`,
    ...(payload.fences.length > 0
      ? [
          "",
          "fences:",
          ...payload.fences.map(
            (fence) =>
              `  ${fence.lang ?? "(none)"}  [${fence.lines.start}-${fence.lines.end}]  ${fence.id}`
          ),
        ]
      : []),
    ...(payload.links.length > 0
      ? [
          "",
          "links:",
          ...payload.links.map(
            (link) =>
              `  ${resolutionLabel(link.resolution)} ${link.target}${link.resolvedPath ? ` → ${link.resolvedPath}` : ""}`
          ),
        ]
      : []),
    ...(payload.codeAnchors.length > 0
      ? [
          "",
          "code citations:",
          ...payload.codeAnchors.map(
            (anchor) =>
              `  ${resolutionLabel(anchor.resolution)} ${anchor.path}${anchor.inferred ? " (inferred)" : ""}${anchor.tracked === false ? " (untracked)" : ""}${anchor.resolution === "ambiguous" ? ` — ${anchor.candidates} candidates, never resolved by picking` : ""}`
          ),
        ]
      : []),
    ...(payload.backlinks.length > 0
      ? ["", "linked from:", ...payload.backlinks.map((id) => `  ${id}`)]
      : []),
    ...(payload.text !== null
      ? ["", payload.text, ...(payload.textTruncated ? ["…"] : [])]
      : []),
    ...renderEvidence(payload.evidence),
    ...renderDegradation(payload.degradation),
  ];
}

function renderImpact(payload: DocsImpactResult): string[] {
  if (payload.citedBy.length === 0) {
    return [
      `${payload.path}: ${payload.reason ?? "no documentation cites this path"}.`,
      ...renderDegradation(payload.degradation),
    ];
  }
  return [
    `${payload.path} is cited by ${payload.totals.sections} section(s) across ${payload.totals.documents} document(s) — ${payload.totals.canon} canon, ${payload.totals.historical} historical.`,
    "",
    ...payload.citedBy.map(
      (citation) =>
        `  ${resolutionLabel(citation.resolution)} ${citation.sectionId}${citation.inferred ? " (inferred)" : ""}  [${citation.lines.start}-${citation.lines.end}] via ${citation.via}${citation.mentionLines.length > 0 ? ` → named lines ${citation.mentionLines.join(",")}` : ""}`
    ),
    "",
    // The line that keeps this from reading as a verdict. A doc may be
    // describing intent (ADR-0052 named a file before it was committed), and a
    // tool that called that "drift" would be confidently wrong.
    "these are citations, not a verdict: an unresolved citation may describe intent rather than shipped behaviour.",
    ...renderEvidence(payload.evidence),
    ...renderDegradation(payload.degradation),
  ];
}

function renderStatus(payload: DocsStatusResult): string[] {
  const tiers = (Object.entries(payload.tiers) as [DocTier, number][])
    .map(([tier, count]) => `${tier} ${count}`)
    .join(" · ");
  const adrStatuses = Object.entries(payload.adrStatuses)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status} ${count}`)
    .join(" · ");
  return [
    ...renderProvenance(payload.provenance),
    "",
    `selector: ${payload.corpus.selector} markdown files · corpus: ${payload.corpus.corpus} · sections: ${payload.corpus.sections} · fences: ${payload.corpus.fences}`,
    `tiers: ${tiers}`,
    ...(adrStatuses.length > 0 ? [`ADR status: ${adrStatuses}`] : []),
    `code citations: ${payload.anchors.resolved} resolved · ${payload.anchors.suffixResolved} suffix-resolved · ${payload.anchors.ambiguous} ambiguous · ${payload.anchors.unresolved} unresolved · ${payload.anchors.unknown} unknown (of ${payload.anchors.total})`,
    `links: ${payload.links.resolved} resolved · ${payload.links.unresolved} unresolved · ${payload.links.external} external · ${payload.links.unknown} unknown`,
    `precedence: ${payload.precedence}`,
    // Exclusions are REPORTED, never silent: an agent-persona prompt is an
    // instruction authored for a model, and ranking it as documentation is the
    // one thing this index must not do.
    ...(payload.corpus.excluded.length > 0
      ? [
          "",
          `excluded (${payload.corpus.excluded.length}):`,
          ...summarize(
            payload.corpus.excluded.map(
              (entry) => `  ${entry.path} — ${entry.reason}`
            )
          ),
        ]
      : []),
    ...(payload.corpus.skipped.length > 0
      ? [
          "",
          `skipped (${payload.corpus.skipped.length}):`,
          ...payload.corpus.skipped.map(
            (entry) => `  ${entry.path} — ${entry.reason}`
          ),
        ]
      : []),
    "",
    "drift report (this surface only — a hygiene report for a human, not an agent tool):",
    ...(payload.drift.unresolvedAnchors.length === 0
      ? ["  no unresolved code citations."]
      : [
          `  unresolved citations (${payload.drift.unresolvedAnchors.length}):`,
          ...summarize(
            payload.drift.unresolvedAnchors.map(
              (entry) => `    ${entry.path}  cited by ${entry.sectionId}`
            )
          ),
        ]),
    ...(payload.drift.ambiguousAnchors.length === 0
      ? ["  no ambiguous code citations."]
      : [
          `  ambiguous citations (${payload.drift.ambiguousAnchors.length}):`,
          ...payload.drift.ambiguousAnchors.map(
            (entry) =>
              `    ${entry.path}  ${entry.candidates} candidates  cited by ${entry.sectionId}`
          ),
        ]),
    ...(payload.drift.unclassifiedDocs.length === 0
      ? ["  every document under docs/ carries a tier."]
      : [
          `  unclassified under docs/ (${payload.drift.unclassifiedDocs.length}) — list them in docs/README.md to give them a tier:`,
          ...summarize(
            payload.drift.unclassifiedDocs.map((path) => `    ${path}`)
          ),
        ]),
    ...renderEvidence(payload.evidence),
    ...renderDegradation(payload.degradation),
  ];
}

/**
 * `null` is a REAL resolution state, not a missing one: it means the known-file
 * set could not be obtained, so nothing may be asserted about the repository.
 * It must never render as `unresolved`, which is a claim we did not earn.
 */
function resolutionLabel(resolution: string | null): string {
  return (resolution ?? "unknown").padEnd(16);
}

/** Terminal-kind: show the first 20 and say how many were held back. */
function summarize(lines: string[]): string[] {
  return lines.length <= 20
    ? lines
    : [...lines.slice(0, 20), `    … and ${lines.length - 20} more (--json for all)`];
}

// ── Arguments are VALIDATED, never cast ──────────────────────────────────────
//
// The MCP sibling refuses a bad `tier` or `limit` by name
// (`packages/mcp/src/docs-tools.ts`); this surface accepted both and then
// answered as if the corpus were empty:
//
//  - `--limit 1O` was `Number("1O")` → NaN, which survived the core's
//    `Math.max(1, Math.min(NaN, cap))` clamp untouched, and `slice(0, NaN)`
//    returns NOTHING. `docs impact` then printed "no documentation cites this
//    path" — with exit 0 — while the totals in the same payload said otherwise.
//  - `--tier ADR` was a `as DocTier` CAST applied as a HARD FILTER, so a
//    wrong-case or misspelled tier matched no section and printed "no section in
//    this corpus matches that query."
//
// Both are the same failure: a read surface answering an honest-looking EMPTY to
// a question it never actually asked. Parity is the rule this file opens with,
// so the refusal is by name, before the core is called.

/**
 * The tier enum, DERIVED rather than retyped.
 *
 * `TIER_PRIOR` is typed `Record<DocTier, number>`, so a new tier cannot be added
 * to `DocTier` without adding a key here — which means this list follows the
 * enum by construction instead of by somebody remembering. A hand-written copy
 * is how the MCP schema and its own check came to state the list twice.
 */
const DOC_TIERS = Object.keys(TIER_PRIOR) as DocTier[];

function isDocTier(value: string): value is DocTier {
  return (DOC_TIERS as string[]).includes(value);
}

/**
 * A CLI-argument refusal, rendered like every other refusal on this surface:
 * the reason, the recovery, exit 1 — and under `--json`, the same envelope
 * `failRefusal` prints, so a script gets a typed answer instead of an empty
 * result it would read as "nothing matched".
 */
function failArgument(reason: string, action: string, json: boolean): void {
  if (json) {
    printJson({
      refusal: { code: "invalid-argument", reason, action, nextActions: [] },
    });
    process.exitCode = 1;
    return;
  }
  failCommand(new Error([reason, action].join("\n  ")), "Docs read failed.");
}

/** `undefined` when absent, a number when valid, `null` when the caller must be
 *  refused (the refusal is already printed). */
function parseLimit(
  raw: string | undefined,
  max: number,
  json: boolean
): number | undefined | null {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    failArgument(
      `--limit must be an integer from 1 to ${max}; got '${raw}'.`,
      `Re-run with a value in that range, or drop --limit to use the cap (${max}).`,
      json
    );
    return null;
  }
  return parsed;
}

export function registerDocsCommands(program: Command) {
  const docs = program
    .command("docs")
    .description(
      "Query this repository's own markdown corpus as a graph (ADR-0053): search it, open a section, or find the docs that cite a path"
    );

  const shared = <T extends Command>(command: T): T => {
    command.option("--workspace <dir>", "Repository (default: cwd)");
    command.option("--json", "Print the payload the MCP tools return, verbatim");
    return command;
  };

  shared(
    docs
      .command("status")
      .description(
        "Corpus counts, tier distribution, citation histogram, provenance, and the drift report"
      )
  ).action(async (options: SharedOptions) => {
    try {
      const payload = await graphFor(options).status();
      if (options.json) {
        printJson(payload);
        return;
      }
      write(renderStatus(payload));
    } catch (error) {
      failRefusal(error, "Failed to read the docs graph.", options.json === true);
    }
  });

  shared(
    docs
      .command("index")
      .description("Force a full rebuild of the docs index and report what it cost")
  ).action(async (options: SharedOptions) => {
    try {
      const startedAt = Date.now();
      const index = await graphFor(options).rebuild();
      const elapsedMs = Date.now() - startedAt;
      const provenance = provenanceOf(index);
      if (options.json) {
        printJson({ provenance, elapsedMs });
        return;
      }
      write([...renderProvenance(provenance), "", `rebuilt in ${elapsedMs} ms`]);
    } catch (error) {
      failRefusal(error, "Failed to rebuild the docs graph.", options.json === true);
    }
  });

  shared(
    docs
      .command("query")
      .description("Search the corpus's sections, ranked, with their precedence tier")
      .argument("<text>", "What to search for")
      .option("--tier <tier>", `Hard filter: ${DOC_TIERS.join("|")}`)
      .option("--path <prefix>", "Only sections whose document path starts with this")
      .option("--fence <lang>", "Only sections containing a fenced block of this language")
      .option("--limit <n>", `Maximum sections to return (1-${DOCS_MAX_RESULTS})`)
  ).action(
    async (
      text: string,
      options: SharedOptions & {
        tier?: string;
        path?: string;
        fence?: string;
        limit?: string;
      }
    ) => {
      const json = options.json === true;
      const limit = parseLimit(options.limit, DOCS_MAX_RESULTS, json);
      if (limit === null) return;
      // A HARD FILTER is the one argument where guessing silently changes the
      // corpus the caller asked about, so an unknown tier is refused by name
      // rather than passed through as a filter nothing can match.
      if (options.tier !== undefined && !isDocTier(options.tier)) {
        failArgument(
          `--tier must be one of ${DOC_TIERS.join(", ")}; got '${options.tier}'.`,
          "Tiers are lower-case. Re-run with one of those, or drop --tier to search every tier.",
          json
        );
        return;
      }
      const tier = options.tier;
      try {
        const payload = await graphFor(options).query(text, {
          ...(tier !== undefined ? { tier } : {}),
          ...(options.path ? { pathPrefix: options.path } : {}),
          ...(options.fence ? { fenceLang: options.fence } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        if (options.json) {
          printJson(payload);
          return;
        }
        write(renderQuery(payload));
      } catch (error) {
        failRefusal(error, "Docs query failed.", json);
      }
    }
  );

  shared(
    docs
      .command("context")
      .description("Open one document path or one docPath#slug section, 360 degrees")
      .argument("<target>", "A document path or a docPath#slug section id")
      .option("--text", "Include the section body")
      .option("--no-backlinks", "Skip the sections that link here")
  ).action(
    async (
      target: string,
      options: SharedOptions & { text?: boolean; backlinks?: boolean }
    ) => {
      try {
        const payload = await graphFor(options).context(target, {
          includeText: options.text === true,
          includeBacklinks: options.backlinks !== false,
        });
        if (options.json) {
          printJson(payload);
          return;
        }
        write(renderContext(payload));
      } catch (error) {
        failRefusal(error, "Docs context failed.", options.json === true);
      }
    }
  );

  shared(
    docs
      .command("impact")
      .description(
        "Which doc sections cite this repository path (citations, never a drift verdict)"
      )
      .argument("<path>", "A repository-relative file path")
      .option(
        "--limit <n>",
        `Maximum citing sections to return (1-${DOCS_MAX_BACKLINKS})`
      )
  ).action(
    async (filePath: string, options: SharedOptions & { limit?: string }) => {
      const json = options.json === true;
      const limit = parseLimit(options.limit, DOCS_MAX_BACKLINKS, json);
      if (limit === null) return;
      try {
        const payload = await graphFor(options).impact(filePath, {
          ...(limit !== undefined ? { limit } : {}),
        });
        if (options.json) {
          printJson(payload);
          return;
        }
        write(renderImpact(payload));
      } catch (error) {
        failRefusal(error, "Docs impact failed.", json);
      }
    }
  );
}
