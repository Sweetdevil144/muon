import type { MemoryKind, MemoryNoteInput } from "./types.js";

/**
 * Deterministic memory extraction (v3 ingestion). The research (mem0/Graphiti)
 * uses an LLM to mine memories from raw conversation; that's the "take
 * inspiration" tier and needs a lane call. This module is the offline,
 * zero-LLM complement: it turns MUON's already-structured work signals,
 * second-opinion verdicts, loop escalations, handoff open questions, into
 * candidate memory notes with no model in the loop. Extracted notes go
 * through the same dedup-aware ingest and stay unconfirmed until a human
 * confirms, so the brain fills itself from real work without bloating.
 *
 * Docs: docs/research/memory-graph-v3.md.
 */

export type WorkSignal =
  | {
      type: "second_opinion";
      verdict: string;
      taskId?: string;
      laneId?: string;
      modules?: string[];
    }
  | {
      type: "loop_escalation";
      stopReason: string;
      taskId?: string;
      laneId?: string;
      modules?: string[];
    }
  | {
      type: "open_question";
      question: string;
      taskId?: string;
      laneId?: string;
      modules?: string[];
    };

function clamp(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 280 ? `${trimmed.slice(0, 277)}...` : trimmed;
}

/**
 * Extract candidate notes from one work signal. Returns [] when there is
 * nothing durable to remember (e.g. a clean APPROVE verdict), the brain
 * only records what future work would want to recall.
 */
export function extractFromSignal(
  signal: WorkSignal,
  createdBy = "muon"
): MemoryNoteInput[] {
  const anchor = {
    taskId: signal.taskId,
    laneId: signal.laneId,
    modules: signal.modules ?? [],
    createdBy,
  };

  if (signal.type === "second_opinion") {
    // Only CONCERNS carry a lasting lesson; a clean APPROVE is not memory.
    const isConcern = /VERDICT:\s*CONCERNS/i.test(signal.verdict);
    if (!isConcern) {
      return [];
    }
    const body = signal.verdict.replace(/VERDICT:\s*CONCERNS/i, "").trim();
    if (body.length < 8) {
      return [];
    }
    return [
      {
        ...anchor,
        kind: "attempt" as MemoryKind,
        text: `Review raised concerns: ${clamp(body)}`,
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
        ...anchor,
        kind: "attempt" as MemoryKind,
        text: `Fix loop could not converge: ${clamp(signal.stopReason)}`,
        topics: ["loop", "repair"],
      },
    ];
  }

  // open_question
  const q = signal.question.trim();
  if (q.length < 6) {
    return [];
  }
  return [
    {
      ...anchor,
      kind: "question" as MemoryKind,
      text: clamp(q.endsWith("?") ? q : `${q}?`),
      topics: ["handoff"],
    },
  ];
}
