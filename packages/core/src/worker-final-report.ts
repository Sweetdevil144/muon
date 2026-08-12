import { isAttemptOutcome, type AttemptOutcome } from "@muon/protocol";

const MAX_REPORT_INPUT_CHARS = 64_000;
const MAX_LIST_ENTRIES = 25;
const MAX_LIST_ENTRY_CHARS = 500;
const MAX_MEMORY_PROPOSALS = 10;
const MAX_MEMORY_PROPOSAL_CHARS = 1_000;
const MAX_NEXT_ACTION_CHARS = 1_000;

const SECTION_LABELS = [
  "GOAL",
  "CHANGED",
  "FAILED",
  "COMMANDS RUN",
  "CHECKS",
  "CHANGED FILES",
  "OPEN QUESTIONS",
  "UNCERTAINTIES",
  "NEXT ACTION",
  "MEMORY PROPOSALS",
] as const;

type SectionLabel = (typeof SECTION_LABELS)[number];

export type WorkerMemoryProposal = {
  kind: "decision" | "constraint" | "convention" | "attempt" | "question";
  text: string;
  /**
   * Substrate §3.4 — how an ATTEMPT turned out, when the worker said so.
   *
   * NEVER INFERRED. A report that does not declare an outcome yields
   * `undefined`, which the ledger stores as unknown. Deriving it from, say, an
   * empty FAILED: section would be wrong as often as right — a job can succeed
   * overall while the attempt it is describing was abandoned, which is exactly
   * the case "has anyone already tried this?" most needs to answer correctly.
   */
  outcome?: AttemptOutcome;
};

export type WorkerFinalReport = {
  openQuestions: string[];
  uncertainties: string[];
  nextAction?: string;
  memoryProposals: WorkerMemoryProposal[];
};

function redactSecrets(text: string): string {
  return text
    .replace(
      /([A-Za-z0-9_-]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY)[A-Za-z0-9_-]{0,64})(\s*[=:]\s*)(\S+)/gi,
      "$1$2[redacted]"
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
}

function isEmptyMarker(text: string): boolean {
  return /^(?:none|nothing|n\/a|na|no(?:ne)?\s+captured|no\s+(?:open questions|uncertainties|proposals))\b/i.test(
    text.trim()
  );
}

function listEntries(lines: string[], maxChars = MAX_LIST_ENTRY_CHARS): string[] {
  return lines
    .map((line) =>
      line
        .trim()
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim()
    )
    .filter((line) => line.length > 0 && !isEmptyMarker(line))
    .map((line) => redactSecrets(line).slice(0, maxChars))
    .slice(0, MAX_LIST_ENTRIES);
}

function parseMemoryProposals(lines: string[]): WorkerMemoryProposal[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0 || isEmptyMarker(line)) {
        return false;
      }
      return (
        /^[-*]\s+/.test(line) ||
        /^\d+[.)]\s+/.test(line) ||
        /^(?:\[)?(?:decision|constraint|convention|attempt|question)(?:\])?\s*:/i.test(
          line
        )
      );
    })
    .map((line) =>
      redactSecrets(
        line
          .replace(/^[-*]\s+/, "")
          .replace(/^\d+[.)]\s+/, "")
          .trim()
      ).slice(0, MAX_MEMORY_PROPOSAL_CHARS)
    )
    .map((entry): WorkerMemoryProposal | undefined => {
      // `[attempt:worked] …` / `attempt:abandoned: …` — the outcome suffix is
      // optional everywhere, so every pre-existing report still parses byte
      // for byte.
      const typed =
        entry.match(
          /^\[(decision|constraint|convention|attempt|question)(?::(worked|abandoned|superseded|unknown))?\]\s*(.+)$/i
        ) ??
        entry.match(
          /^(decision|constraint|convention|attempt|question)(?::(worked|abandoned|superseded|unknown))?\s*:\s*(.+)$/i
        );
      const kind = typed?.[1]?.toLowerCase() ?? "attempt";
      const declaredOutcome = typed?.[2]?.toLowerCase();
      // Only an ATTEMPT has an outcome; a decision that declares one is
      // ignoring the vocabulary, and silently honouring it would invent a
      // field on a kind that has no such concept.
      const outcome =
        kind === "attempt" && declaredOutcome && isAttemptOutcome(declaredOutcome)
          ? declaredOutcome
          : undefined;
      const text = (typed?.[3] ?? entry).trim();
      if (text.length < 3) {
        return undefined;
      }
      return {
        kind: kind as WorkerMemoryProposal["kind"],
        ...(outcome ? { outcome } : {}),
        text: text.slice(0, MAX_MEMORY_PROPOSAL_CHARS),
      };
    })
    .filter((proposal): proposal is WorkerMemoryProposal => proposal !== undefined)
    .slice(0, MAX_MEMORY_PROPOSALS);
}

function parseCandidate(lines: string[], start: number): WorkerFinalReport | undefined {
  const sections = new Map<SectionLabel, string[]>();
  let expectedIndex = 0;
  let current: SectionLabel | undefined;

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(
      /^(GOAL|CHANGED|FAILED|COMMANDS RUN|CHECKS|CHANGED FILES|OPEN QUESTIONS|UNCERTAINTIES|NEXT ACTION|MEMORY PROPOSALS):(?:\s*(.*))?$/
    );
    if (match) {
      const label = match[1] as SectionLabel;
      if (label !== SECTION_LABELS[expectedIndex]) {
        return undefined;
      }
      current = label;
      expectedIndex += 1;
      sections.set(label, match[2] ? [match[2]] : []);
      continue;
    }
    if (current) {
      sections.get(current)!.push(line);
    }
  }

  if (expectedIndex !== SECTION_LABELS.length) {
    return undefined;
  }

  const nextActionParts = listEntries(
    sections.get("NEXT ACTION") ?? [],
    MAX_NEXT_ACTION_CHARS
  );
  const nextAction = nextActionParts.join(" ").slice(0, MAX_NEXT_ACTION_CHARS);

  return {
    openQuestions: listEntries(sections.get("OPEN QUESTIONS") ?? []),
    uncertainties: listEntries(sections.get("UNCERTAINTIES") ?? []),
    ...(nextAction.length > 0 ? { nextAction } : {}),
    memoryProposals: parseMemoryProposals(
      sections.get("MEMORY PROPOSALS") ?? []
    ),
  };
}

/**
 * Parse only the last complete, exact worker final-report suffix requested by
 * WORKER_PREAMBLE. Worker prose is untrusted: this function grants no authority,
 * ignores claimed files/checks, redacts common secret shapes, and returns only
 * bounded coordination fields that remain proposals until human confirmation.
 */
export function parseWorkerFinalReport(
  output: string
): WorkerFinalReport | undefined {
  const lines = output
    .slice(-MAX_REPORT_INPUT_CHARS)
    .replace(/\r\n?/g, "\n")
    .split("\n");

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^GOAL:(?:\s|$)/.test(lines[index] ?? "")) {
      const parsed = parseCandidate(lines, index);
      if (parsed) {
        return parsed;
      }
    }
  }
  return undefined;
}

/**
 * Recover only the explicitly-labelled final memory-proposal section when a
 * vendor omits another required report label. This intentionally does not
 * relax the full handoff parser: arbitrary prose remains ignored, while
 * bounded proposals still stay low-trust and unconfirmed at ingestion.
 */
export function parseWorkerMemoryProposals(
  output: string
): WorkerMemoryProposal[] {
  const lines = output
    .slice(-MAX_REPORT_INPUT_CHARS)
    .replace(/\r\n?/g, "\n")
    .split("\n");

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = (lines[index] ?? "").match(
      /^MEMORY PROPOSALS:(?:\s*(.*))?$/
    );
    if (!match) continue;
    return parseMemoryProposals([
      ...(match[1] ? [match[1]] : []),
      ...lines.slice(index + 1),
    ]);
  }
  return [];
}
