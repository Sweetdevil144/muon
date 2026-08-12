import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import {
  describeCoverage,
  fetchProposalNote,
  loadPreEditView,
  parseEditTarget,
  type PreEditTargetInput,
  type PreEditView,
} from "@muon/client";
import { MuonApiClient } from "../lib/api-client.js";
import { printJson } from "../lib/output.js";

/**
 * `muon context <symbol|path>`, the pre-edit ("Brain") gate for the terminal
 * (P6a, the hero's human arm). Before editing a target, fuse its code
 * blast-radius with the GOVERNED (human-confirmed) memory anchored to it and
 * print prior decisions ranked by proximity (on-target first), contradiction
 * warnings, and a count of pending proposals a human must adjudicate.
 *
 * TRUST DISCIPLINE: governed decisions are confirmed/trusted, so their TEXT is
 * printed. Pending proposals are shown existence-only (ids + a generic summary,
 * never their untrusted text); `--view-proposal <id>` fetches ONE proposal's
 * text ON DEMAND via the operator-tier note-by-id path so a human can read it
 * before confirming/rejecting with `muon memory confirm|reject`.
 */

/** Render the shared view-model to plain terminal lines (pure, unit-tested). */
export function formatContextLines(view: PreEditView): string[] {
  if (view.phase === "empty") {
    return view.notices;
  }
  const lines: string[] = [];
  lines.push(`Pre-edit context for ${view.targetLabel}`);
  const depth =
    view.blastRadius.depth != null ? ` · depth ${view.blastRadius.depth}` : "";
  lines.push(
    `  blast-radius: ${
      view.blastRadius.modules.length > 0
        ? view.blastRadius.modules.join(", ")
        : "(none)"
    } [${view.blastRadius.sourceLabel}${depth}]`
  );

  // KG-7 + KG-9 (ADR-0014): cross-agent activity, coordinates only (who/where/when
  // + proximity tier), surfaced FIRST because a collision is the most time-sensitive
  // pre-edit signal. KG-9 shouts the EXACT-target collision above blast-radius work.
  if (view.hasLiveActivity || view.hasRecentActivity) {
    lines.push("");
    if (view.hasOnTargetActivity) {
      lines.push(
        `⚠ Activity on your EXACT target: ${view.onTargetLaneCount} other lane(s)` +
          (view.neighbourLaneCount > 0
            ? ` (+${view.neighbourLaneCount} in your blast radius)`
            : "") +
          `, ${view.activeLaneCount} live, ${view.recentLaneCount} recent, coordinate to avoid a collision:`
      );
    } else {
      lines.push(
        `⚠ Cross-agent activity: ${view.neighbourLaneCount} other lane(s) in your blast radius` +
          `, ${view.activeLaneCount} live, ${view.recentLaneCount} recent:`
      );
    }
    for (const entry of view.activity) {
      const tier = entry.onSymbol
        ? "EXACT symbol"
        : entry.onTarget
        ? "exact target"
        : "blast radius";
      lines.push(`  - [${tier}] ${entry.summary} [job ${entry.jobId}]`);
    }
  }

  // KG-10 (ADR-0014 §5): duplicate-work, another LIVE lane doing semantically the
  // same work (brief paraphrase). Coordinates only (a similarity scalar + ids,
  // never the brief text). A DISTINCT channel from the anchor-based activity above.
  if (view.hasDuplicateWork) {
    lines.push("");
    lines.push(
      `⚠ ${view.duplicateWorkCount} lane(s) may be doing the SAME work (semantic brief overlap), coordinate to avoid duplicating effort:`
    );
    for (const dup of view.duplicateWork) {
      lines.push(
        `  - ${dup.vendor} lane [job ${dup.jobId}, task ${dup.taskId}] ~${dup.similarityPct}% similar`
      );
    }
  }

  lines.push("");
  lines.push(
    `Governed decisions (${view.memories.length}), confirmed, trusted:`
  );
  // D14: "(none)" alone is the ambiguity this whole decision exists to remove —
  // it read identically whether nothing was anchored or the gate refused
  // everything it found. Print the counts right where the emptiness appears; the
  // reason SENTENCE still lands in `notices` below (that list is what the TUI and
  // desktop panels render, so it has to carry the counts for them too), and the
  // footer skips this exact line rather than repeating it.
  const coverageLine = view.coverage ? describeCoverage(view.coverage) : null;
  if (view.memories.length === 0) {
    lines.push("  (none)");
    if (coverageLine) {
      lines.push(`  ${coverageLine}`);
    }
  } else {
    for (const memory of view.memories) {
      const flags = [
        memory.proximityLabel,
        memory.note.trust,
        ...(memory.note.stale ? ["STALE"] : []),
      ].join(",");
      lines.push(
        `  - [${memory.kindLabel} · ${flags}] ${memory.note.text}`
      );
    }
  }

  if (view.warnings.length > 0) {
    lines.push("");
    lines.push(`Warnings (${view.warnings.length}):`);
    for (const warning of view.warnings) {
      lines.push(`  ! ${warning.label}: ${warning.detail}`);
    }
  }

  lines.push("");
  if (view.pendingCount === 0) {
    lines.push("Pending proposals: 0");
  } else {
    lines.push(
      `Pending proposals: ${view.pendingCount}, a human must confirm or reject each:`
    );
    for (const proposal of view.pendingProposals) {
      lines.push(
        `  ? ${proposal.proposalNoteId} contests ${proposal.victimNoteId}, ${proposal.summary}`
      );
    }
    lines.push(
      "  View a proposal's text: `muon context <target> --view-proposal <id>`"
    );
    lines.push(
      "  Then adjudicate: `muon memory confirm --note-id <id>` (apply) or `muon memory reject --note-id <id>`"
    );
  }

  for (const notice of view.notices) {
    // Skip the counts line already printed beside "(none)". Compared against the
    // SAME `describeCoverage` output, not a pattern, so this can never silently
    // start swallowing a different notice.
    if (coverageLine !== null && notice === coverageLine) {
      continue;
    }
    lines.push("");
    lines.push(notice);
  }
  return lines;
}

export function registerContextCommand(
  program: Command,
  createClient: () => MuonApiClient
) {
  program
    .command("context")
    .description(
      "Pre-edit gate: fuse a target's blast-radius with governed memory + pending proposals"
    )
    .argument("<target>", "A symbol name or a file/module path to edit")
    .option("--module <module>", "Anchor as a module/file path (overrides target)")
    .option("--file <file...>", "Extra file/module anchors")
    .option(
      "--blast-module <module...>",
      "Blast-radius modules from your code-graph impact call"
    )
    .option("--as-of <iso>", "Read memory as of this ISO timestamp — what MUON knew then, not now")
    .option("--scope <scope>", "Scope filter")
    .option("--trust-floor <trust>", "Gate trust floor: low | medium | high")
    .option(
      "--view-proposal <noteId>",
      "Fetch ONE pending proposal's text on demand (operator-tier)"
    )
    .option("--json", "Print as JSON")
    .action(
      async (
        target: string,
        options: {
          module?: string;
          file?: string[];
          blastModule?: string[];
          asOf?: string;
          scope?: string;
          trustFloor?: string;
          viewProposal?: string;
          json?: boolean;
        }
      ) => {
        try {
          const client = createClient();
          const parsed = parseEditTarget(target);
          const input: PreEditTargetInput = {
            symbol: parsed.symbol,
            module: options.module ?? parsed.module,
            files: options.file,
            blastRadiusModules: options.blastModule,
            asOf: options.asOf,
            scope: options.scope,
            trustFloor: options.trustFloor as PreEditTargetInput["trustFloor"],
          };
          const view = await loadPreEditView(client, input);

          // On demand ONLY: pull one proposal's (untrusted) text via the
          // operator-tier note-by-id path so a human can read it to adjudicate.
          const proposalNote = options.viewProposal
            ? await fetchProposalNote(client, options.viewProposal)
            : null;

          if (options.json) {
            printJson({ view, proposalNote });
            return;
          }
          for (const line of formatContextLines(view)) {
            process.stdout.write(`${line}\n`);
          }
          if (proposalNote) {
            process.stdout.write(
              `\nProposal ${proposalNote.id} [${proposalNote.kind} · ${proposalNote.trust}, ${
                proposalNote.confirmed ? "confirmed" : "unconfirmed"
              }] text:\n  ${proposalNote.text}\n`
            );
          }
        } catch (error) {
          failCommand(error, "Pre-edit context failed.");
        }
      }
    );
}
