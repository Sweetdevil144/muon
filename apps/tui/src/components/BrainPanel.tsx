import { Box, Text } from "ink";
import {
  buildConvergencePreflight,
  type ConvergencePosture,
  type ConvergencePreflight,
  type ConvergenceRow,
  type ConvergenceSection,
  type ConvergenceSeverity,
  type PreEditView,
} from "@muon/client";
import { hub, panelBorder } from "../lib/theme.js";
import { terminalSafe } from "@muon/client";

const SECTION_ROW_LIMIT = 6;
const EVIDENCE_COORDINATE_LIMIT = 6;

type Props = {
  view: PreEditView;
  preflight?: ConvergencePreflight;
  /** Index into view.pendingProposals of the selected (adjudicable) proposal. */
  selectedProposalIndex: number;
  /** Proposal text fetched ON DEMAND, keyed by proposalNoteId. "…" = loading. */
  proposalText: Record<string, string | undefined>;
  busy?: boolean;
};

function postureColor(posture: ConvergencePosture) {
  // Posture is a status, not a success event: clear renders plain,
  // attention stays yellow.
  return posture === "clear" ? undefined : hub.warn;
}

function severityColor(severity: ConvergenceSeverity) {
  switch (severity) {
    case "warning":
    case "attention":
      return hub.warn;
    case "info":
    case "neutral":
      return undefined;
  }
}

function Section({
  title,
  section,
  rows,
  prioritizeWarnings = false,
}: {
  title: string;
  section: ConvergenceSection;
  rows?: ConvergenceRow[];
  prioritizeWarnings?: boolean;
}) {
  const sourceRows = rows ?? section.rows;
  const orderedRows = prioritizeWarnings
    ? [
        ...sourceRows.filter((row) => row.severity === "warning"),
        ...sourceRows.filter((row) => row.severity !== "warning"),
      ]
    : sourceRows;
  const visibleRows = orderedRows.slice(0, SECTION_ROW_LIMIT);
  const omittedCount = orderedRows.length - visibleRows.length;

  return (
    <>
      <Text
        color={severityColor(section.severity)}
        dimColor={severityColor(section.severity) === undefined}
      >
        {title} ({section.count}), {section.summary}
      </Text>
      {section.chips.length > 0 ? (
        <Text dimColor wrap="truncate">
          {"  "}
          {section.chips.map((chip) => `[${chip}]`).join(" ")}
        </Text>
      ) : null}
      {visibleRows.map((row) => (
        <Text
          key={row.id}
          color={severityColor(row.severity)}
          wrap="truncate"
        >
          {"  · "}
          {row.label}
          {row.detail ? `, ${row.detail}` : ""}
        </Text>
      ))}
      {omittedCount > 0 ? (
        <Text dimColor>
          {"  … "}
          {omittedCount} more {section.key} rows omitted
        </Text>
      ) : null}
    </>
  );
}

function EvidenceCoordinates({ view }: { view: PreEditView }) {
  const visibleModules = view.blastRadius.modules.slice(
    0,
    EVIDENCE_COORDINATE_LIMIT
  );
  const omittedModuleCount =
    view.blastRadius.modules.length - visibleModules.length;
  const targetSymbol = view.target.symbol;
  const orderedSymbols = targetSymbol
    ? [
        targetSymbol,
        ...view.blastRadius.symbols.filter(
          (symbol) => symbol !== targetSymbol
        ),
      ]
    : view.blastRadius.symbols;
  const visibleSymbols = orderedSymbols.slice(0, EVIDENCE_COORDINATE_LIMIT);
  const omittedSymbolCount = orderedSymbols.length - visibleSymbols.length;

  return (
    <>
      {visibleModules.map((module) => (
        <Text key={`module:${module}`} wrap="truncate">
          {"  · "}
          module: {module}
        </Text>
      ))}
      {omittedModuleCount > 0 ? (
        <Text dimColor>
          {"  … "}
          {omittedModuleCount} more module{" "}
          {omittedModuleCount === 1 ? "coordinate" : "coordinates"} omitted
        </Text>
      ) : null}
      {visibleSymbols.map((symbol) => (
        <Text key={`symbol:${symbol}`} wrap="truncate">
          {"  · "}
          symbol: {symbol}
        </Text>
      ))}
      {omittedSymbolCount > 0 ? (
        <Text dimColor>
          {"  … "}
          {omittedSymbolCount} more symbol{" "}
          {omittedSymbolCount === 1 ? "coordinate" : "coordinates"} omitted
        </Text>
      ) : null}
    </>
  );
}

/**
 * P6a, the human pre-edit ("Brain") panel (the hero's human-facing arm).
 *
 * Renders the shared view-model: the code blast-radius, the GOVERNED
 * (confirmed, trusted) memory ranked on-target-first WITH its text, contradiction
 * warnings, and pending PROPOSES_SUPERSEDE proposals as ACTIONABLE items. A
 * proposal shows existence only (ids + a generic summary) until the human presses
 * `v` to fetch its (untrusted) text on demand via the operator note-by-id path,
 * never auto-injected. `c`/`x` confirm/reject through the operator-tier KG-6 route.
 */
export function BrainPanel({
  view,
  preflight,
  selectedProposalIndex,
  proposalText,
  busy,
}: Props) {
  const resolvedPreflight =
    preflight ??
    buildConvergencePreflight({
      view,
      authority: { principal: "human" },
    });
  const nextAction = resolvedPreflight.nextActions[0];
  const authorityRows = resolvedPreflight.authority.rows.filter(
    (row) => !row.id.startsWith("proposal:")
  );
  const exactSymbolMemoryIds = new Set(
    view.target.symbol
      ? view.memories
          .filter((memory) => memory.note.onSymbol)
          .map((memory) => memory.note.id)
      : []
  );
  const evidenceRows = [
    ...resolvedPreflight.evidence.rows.filter((row) =>
      exactSymbolMemoryIds.has(row.id)
    ),
    ...resolvedPreflight.evidence.rows.filter(
      (row) => !exactSymbolMemoryIds.has(row.id)
    ),
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle={panelBorder}
      borderColor={hub.border}
      borderDimColor
      paddingX={1}
      width="86%"
    >
      <Text bold>
        MEMORY REVIEW · {view.targetLabel}
        {busy ? " · refreshing…" : ""}
      </Text>

      {view.phase === "empty" ? (
        <Text dimColor>{view.notices[0]}</Text>
      ) : (
        <>
          <Text color={postureColor(resolvedPreflight.posture)}>
            {resolvedPreflight.headline}
          </Text>
          {nextAction ? (
            <>
              <Text>Next: {nextAction.label}</Text>
              <Text dimColor wrap="wrap">
                {"  "}
                {nextAction.reason}
              </Text>
            </>
          ) : null}

          <Section title="INTENT" section={resolvedPreflight.intent} />
          <Section
            title="EVIDENCE"
            section={resolvedPreflight.evidence}
            rows={evidenceRows}
          />
          <EvidenceCoordinates view={view} />
          <Section
            title="COORDINATION"
            section={resolvedPreflight.coordination}
            prioritizeWarnings
          />
          <Section
            title="AUTHORITY"
            section={resolvedPreflight.authority}
            rows={authorityRows}
          />

          <Text>
            Pending proposals ({view.pendingCount}), you adjudicate
          </Text>
          {view.pendingCount === 0 ? (
            <Text dimColor>  none, nothing to confirm</Text>
          ) : (
            view.pendingProposals.map((proposal, index) => {
              const selected = index === selectedProposalIndex;
              const text = proposalText[proposal.proposalNoteId];
              return (
                <Box key={proposal.proposalNoteId} flexDirection="column">
                  <Text
                    color={selected ? hub.focus : undefined}
                    bold={selected}
                    wrap="truncate"
                  >
                    {selected ? "› " : "  "}
                    {proposal.proposalNoteId} contests {proposal.victimNoteId},{" "}
                    {terminalSafe(proposal.summary)}
                  </Text>
                  {text !== undefined ? (
                    <Text wrap="truncate" dimColor>
                      {"      text: "}
                      {terminalSafe(text)}
                    </Text>
                  ) : selected ? (
                    <Text wrap="truncate" dimColor>
                      {"      text: press v to view before confirm/reject"}
                    </Text>
                  ) : null}
                </Box>
              );
            })
          )}

          {view.notices.map((notice) => (
            <Text key={notice} dimColor>
              {notice}
            </Text>
          ))}
        </>
      )}

      <Text dimColor>
        j/k select · v view text first · c confirm after view · x reject after view
      </Text>
      <Text dimColor>r refresh · Esc close</Text>
    </Box>
  );
}
