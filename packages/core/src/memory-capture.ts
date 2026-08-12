import type { MemoryCandidate, MemoryLaneKind } from "./memory-extract-lane.js";
import type { WorkerMemoryProposal } from "./worker-final-report.js";
import type { AttemptOutcome } from "@muon/protocol";

/**
 * The always-on deterministic tier of the self-filling brain (R4). Where
 * `extractMemoriesViaLane` mines raw text with a model, this turns MUON's
 * already-structured work signals, a review verdict, a loop that could not
 * converge, a handoff's open question, into candidate notes with NO model in
 * the loop and zero extra cost. It only PROPOSES; ingestion stays dedup-aware
 * and unconfirmed-until-reviewed. (Ports the pure logic of @muon/graph's
 * `extractFromSignal` into @muon/core so client-side surfaces like the runner
 * can capture without pulling in the graph DB.)
 */

export type CaptureSignal =
  | { type: "second_opinion"; verdict: string }
  | { type: "loop_escalation"; stopReason: string }
  | { type: "open_question"; question: string }
  | {
      type: "execution_attempt";
      summary: string;
      outcome: AttemptOutcome;
    };

export type CaptureContext = {
  taskId?: string;
  laneId?: string;
  modules?: string[];
  /** Explicitly-declared edited symbols (ADR-0012): `<module>#<name>` ids the
   *  caller already knows it is editing → the candidate's symbol anchors. Absent →
   *  capture stays module-level (v1 has no range extraction), unchanged from today. */
  symbols?: string[];
  createdBy?: string;
};

const TEXT_LIMIT = 280;

function clamp(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > TEXT_LIMIT
    ? `${trimmed.slice(0, TEXT_LIMIT - 3)}...`
    : trimmed;
}

/**
 * Extract candidate notes from one structured signal. Returns [] when there is
 * nothing durable (a clean APPROVE, an empty stop reason), the brain records
 * only what future work would want to recall.
 */
export function captureFromSignal(
  signal: CaptureSignal,
  context: CaptureContext = {}
): MemoryCandidate[] {
  const base = {
    modules: context.modules ?? [],
    symbols: context.symbols,
    taskId: context.taskId,
    laneId: context.laneId,
    // Auto-captured notes are provisional: low trust, unconfirmed on ingest.
    trust: "low" as const,
    createdBy: context.createdBy ?? "muon-capture",
  };

  if (signal.type === "second_opinion") {
    // Only CONCERNS carry a lasting lesson; a clean APPROVE is not memory.
    if (!/VERDICT:\s*CONCERNS/i.test(signal.verdict)) {
      return [];
    }
    const body = signal.verdict.replace(/VERDICT:\s*CONCERNS/i, "").trim();
    if (body.length < 8) {
      return [];
    }
    return [
      {
        ...base,
        kind: "attempt" as MemoryLaneKind,
        text: clamp(`Review raised concerns: ${body}`),
        topics: ["review"],
      },
    ];
  }

  if (signal.type === "loop_escalation") {
    if (signal.stopReason.trim().length < 4) {
      return [];
    }
    return [
      {
        ...base,
        kind: "attempt" as MemoryLaneKind,
        text: clamp(`Fix loop could not converge: ${signal.stopReason}`),
        topics: ["loop", "repair"],
      },
    ];
  }

  if (signal.type === "execution_attempt") {
    if (signal.summary.trim().length < 3) {
      return [];
    }
    return [
      {
        ...base,
        kind: "attempt" as MemoryLaneKind,
        text: clamp(`Execution ${signal.outcome}: ${signal.summary}`),
        topics: ["mission", "attempt"],
        outcome: signal.outcome,
      },
    ];
  }

  const question = signal.question.trim();
  if (question.length < 6) {
    return [];
  }
  return [
    {
      ...base,
      kind: "question" as MemoryLaneKind,
      text: clamp(question.endsWith("?") ? question : `${question}?`),
      topics: ["handoff"],
    },
  ];
}

/**
 * Convert explicitly structured worker/handoff proposals into provisional
 * memory. Module anchors must come from caller-supplied worktree evidence;
 * model-claimed changed-file prose is deliberately not accepted here.
 */
export function captureFromMemoryProposals(
  proposals: WorkerMemoryProposal[],
  context: CaptureContext = {}
): MemoryCandidate[] {
  return proposals
    .filter((proposal) => proposal.text.trim().length >= 3)
    .slice(0, 10)
    .map((proposal) => ({
      kind: proposal.kind,
      text: clamp(proposal.text),
      // Substrate §3.4: carry the worker's DECLARED outcome through to the
      // ledger. Absent stays absent — the row's null means "nobody said", and
      // guessing here is what would make "already tried this?" untrustworthy.
      ...(proposal.outcome ? { outcome: proposal.outcome } : {}),
      topics: ["handoff", "proposal"],
      modules: context.modules ?? [],
      symbols: context.symbols,
      taskId: context.taskId,
      laneId: context.laneId,
      trust: "low" as const,
      createdBy: context.createdBy ?? "muon-capture",
    }));
}

/** Minimal sink so core can ingest without depending on @muon/client. */
export type MemoryIngestSink = {
  addMemoryNoteWithAction(input: {
    kind: MemoryLaneKind;
    text: string;
    taskId?: string;
    laneId?: string;
    modules?: string[];
    topics?: string[];
    symbols?: string[];
    outcome?: AttemptOutcome;
    trust?: "low" | "medium" | "high";
    createdBy: string;
  }): Promise<{ action: string }>;
};

export type IngestSummary = {
  proposed: number;
  ingested: number;
  actions: Record<string, number>;
};

/**
 * Ingest candidate notes through the dedup-aware brain, tallying how each write
 * resolved (inserted / duplicate / superseded / conflict). Best-effort by
 * design: capturing memory must NEVER fail the work that produced it, so a
 * failed write is counted and swallowed.
 */
export async function ingestCandidates(
  sink: MemoryIngestSink,
  candidates: MemoryCandidate[]
): Promise<IngestSummary> {
  const actions: Record<string, number> = {};
  let ingested = 0;
  for (const candidate of candidates) {
    try {
      const result = await sink.addMemoryNoteWithAction({
        kind: candidate.kind,
        text: candidate.text,
        taskId: candidate.taskId,
        laneId: candidate.laneId,
        modules: candidate.modules,
        topics: candidate.topics,
        symbols: candidate.symbols,
        outcome: candidate.outcome,
        trust: candidate.trust,
        createdBy: candidate.createdBy,
      });
      ingested += 1;
      actions[result.action] = (actions[result.action] ?? 0) + 1;
    } catch {
      // Swallow: an unreachable brain must not fail the job.
    }
  }
  return { proposed: candidates.length, ingested, actions };
}
