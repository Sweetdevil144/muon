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
  kind: "decision" | "constraint" | "convention" | "attempt" | "question" | "ownership";
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
  /** ADR-0062: the answer to "did you update the brain?" — parsed from the
   *  OPTIONAL eleventh section so every ten-label legacy report still
   *  parses. Absent = the worker did not answer (the server stamps that as
   *  the `no_brain_receipt` degradation; a malformed answer reads as no
   *  answer, never as either value). */
  brainReceipt?: "context_updated" | "no_update_required";
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
        /^(?:\[)?(?:decision|constraint|convention|attempt|question|ownership)(?:\])?\s*:/i.test(
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
          /^\[(decision|constraint|convention|attempt|question|ownership)(?::(worked|abandoned|superseded|unknown))?\]\s*(.+)$/i
        ) ??
        entry.match(
          /^(decision|constraint|convention|attempt|question|ownership)(?::(worked|abandoned|superseded|unknown))?\s*:\s*(.+)$/i
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

function parseBrainReceipt(
  entries: string[]
): WorkerFinalReport["brainReceipt"] {
  const value = entries
    .join(" ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z_]/g, "");
  if (value === "context_updated") return "context_updated";
  if (value === "no_update_required") return "no_update_required";
  // A malformed answer is NO answer — the closed vocabulary is the contract,
  // and guessing which side a typo meant would put words in the worker's
  // mouth that the server then audits as the worker's claim.
  return undefined;
}

function parseCandidate(lines: string[], start: number): WorkerFinalReport | undefined {
  const sections = new Map<SectionLabel, string[]>();
  // ADR-0062: the OPTIONAL eleventh section. Tracked outside the required
  // sequence so a ten-label legacy report parses exactly as before.
  let brainReceiptLines: string[] | undefined;
  let expectedIndex = 0;
  let current: SectionLabel | undefined;

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(
      /^(GOAL|CHANGED|FAILED|COMMANDS RUN|CHECKS|CHANGED FILES|OPEN QUESTIONS|UNCERTAINTIES|NEXT ACTION|MEMORY PROPOSALS|BRAIN RECEIPT):(?:\s*(.*))?$/
    );
    if (match) {
      const label = match[1] as SectionLabel | "BRAIN RECEIPT";
      if (label === "BRAIN RECEIPT") {
        // Only lawful AFTER the ten required sections, exactly once.
        if (expectedIndex !== SECTION_LABELS.length || brainReceiptLines) {
          return undefined;
        }
        // The receipt is a ONE-LINE scalar (review finding: folding later
        // lines into it let harmless trailing output — a renderer
        // diagnostic, a farewell — invalidate a valid answer). Inline value
        // wins; otherwise the first following line may carry it; everything
        // after stays OUTSIDE the report grammar, exactly as trailing text
        // after the ten sections always has.
        current = undefined;
        if (match[2]) {
          brainReceiptLines = [match[2]];
        } else {
          const next = lines
            .slice(index + 1)
            .find((candidate) => candidate.trim() !== "");
          brainReceiptLines = next ? [next] : [];
        }
        continue;
      }
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
  const brainReceipt = brainReceiptLines
    ? parseBrainReceipt(brainReceiptLines)
    : undefined;

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
    ...(brainReceipt ? { brainReceipt } : {}),
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
