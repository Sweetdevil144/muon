/**
 * U3 — the Evidence tab's DEFAULT content.
 *
 * The tab used to render a search box and the sentence "Enter a symbol or file
 * to review its evidence." That makes the human pay an entry fee to see
 * something they already own: this mission's own record. Search is a filter
 * over evidence, not a precondition for having any.
 *
 * This is a pure projection of what MUON already holds in the renderer — the
 * mission's dispatch jobs and its ledger events. It invents nothing, fetches
 * nothing, and adds no IPC: every line here is something MUON recorded.
 *
 * Four questions, in the order a human asks them:
 *   worked   — which agents ran, on what, under what authority
 *   cited    — what the crew handed off / proposed / applied as evidence
 *   produced — the artifacts and checks a job left behind
 *   decided  — the governance decisions that were asked for or taken
 *
 * All body text is UNTRUSTED agent/vendor prose. It is bounded here and
 * rendered as text nodes; nothing on this path is ever an instruction.
 */

export type MissionEvidenceKind = "worked" | "cited" | "produced" | "decided";

export type MissionEvidenceItem = {
  id: string;
  kind: MissionEvidenceKind;
  /** Short, MUON-authored heading. Never more specific than the record. */
  title: string;
  /** The recorded text itself, bounded. Untrusted. */
  body: string;
  /** Coordinates: status, authority, workspace, time. MUON-authored. */
  meta: string;
  timestamp?: string;
  /** Lowercased haystack the filter searches. */
  haystack: string;
};

export type MissionEvidence = {
  items: MissionEvidenceItem[];
  counts: Record<MissionEvidenceKind, number>;
  /** True when the mission genuinely recorded nothing yet. */
  empty: boolean;
  /** Items dropped by the cap, so the surface can say so instead of implying all. */
  omitted: number;
};

export const MISSION_EVIDENCE_SECTIONS: ReadonlyArray<{
  kind: MissionEvidenceKind;
  label: string;
  /** What this section is, in the operator's language. */
  note: string;
}> = [
  {
    kind: "worked",
    label: "Worked",
    note: "Every agent this mission dispatched, and the brief it was given.",
  },
  {
    kind: "cited",
    label: "Cited",
    note: "Handoffs and workflow evidence the crew passed between each other.",
  },
  {
    kind: "produced",
    label: "Produced",
    note: "Artifacts and checks the crew left behind.",
  },
  {
    kind: "decided",
    label: "Decided",
    note: "Governance decisions asked for, or taken under a standing policy.",
  },
];

const MAX_ITEMS = 300;
const MAX_TITLE = 120;
const MAX_BODY = 600;
const MAX_META = 200;

type EvidenceJob = {
  id: string;
  taskId: string;
  vendor: string;
  status?: string | null;
  kind?: string | null;
  brief?: string | null;
  capabilityMode?: string | null;
  workspacePath?: string | null;
  result?: string | null;
  action?: string | null;
  checks?: ReadonlyArray<{ name: string }> | null;
  createdAt?: string | null;
};

type EvidenceEvent = {
  id: string;
  taskId: string;
  kind: string;
  message: string;
  timestamp: string;
};

function clamp(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(1, max - 1))}…`;
}

/** Ledger kinds that are EVIDENCE the crew cited, not lifecycle noise. */
const CITED_KINDS = new Set([
  "handoff.created",
  "workflow.proposed",
  "workflow.applied",
  "workflow.step.completed",
  "loop.escalated",
]);

/** Ledger kinds that are a governance DECISION (asked for, or auto-taken). */
const DECIDED_KINDS = new Set(["approval.requested", "approval.auto"]);

function jobMeta(job: EvidenceJob, statusLabel: (s?: string | null) => string) {
  const parts = [statusLabel(job.status)];
  if (job.capabilityMode) parts.push(job.capabilityMode);
  if (job.workspacePath) parts.push(job.workspacePath);
  return clamp(parts.join(" · "), MAX_META);
}

export function buildMissionEvidence(input: {
  jobs: readonly EvidenceJob[];
  events: readonly EvidenceEvent[];
  /** taskId → human title. Missing ids fall back to the raw id. */
  taskTitles?: ReadonlyMap<string, string>;
  /** Presentation name for a vendor id. */
  vendorLabel: (vendor: string) => string;
  /** Presentation name for a job status. */
  statusLabel: (status?: string | null) => string;
}): MissionEvidence {
  const items: MissionEvidenceItem[] = [];
  const titleFor = (taskId: string) =>
    input.taskTitles?.get(taskId) ?? taskId;

  for (const job of input.jobs) {
    items.push({
      id: `job:${job.id}`,
      kind: "worked",
      title: clamp(
        `${input.vendorLabel(job.vendor)} · ${titleFor(job.taskId)}`,
        MAX_TITLE
      ),
      body: job.brief
        ? clamp(job.brief, MAX_BODY)
        : "No brief was recorded for this dispatch.",
      meta: jobMeta(job, input.statusLabel),
      ...(job.createdAt ? { timestamp: job.createdAt } : {}),
      haystack: [
        job.id,
        job.vendor,
        job.taskId,
        titleFor(job.taskId),
        job.brief ?? "",
        job.workspacePath ?? "",
        job.status ?? "",
      ]
        .join(" ")
        .toLowerCase(),
    });

    // A job's artifact + its checks are what it PRODUCED. Both are recorded
    // fields; neither is inferred from the stream.
    if (job.result || job.action || job.checks?.length) {
      const producedParts: string[] = [];
      if (job.action) producedParts.push(`Resolved action: ${job.action}`);
      if (job.checks?.length) {
        producedParts.push(
          `Checks: ${job.checks.map((check) => check.name).join(" · ")}`
        );
      }
      if (job.result) producedParts.push(job.result);
      items.push({
        id: `produced:${job.id}`,
        kind: "produced",
        // Deliberately NOT the same title as the "worked" row for this job:
        // two rows with one name reads as a duplicate rather than as the work
        // and the thing the work left behind.
        title: clamp(`Artifacts · ${titleFor(job.taskId)}`, MAX_TITLE),
        body: clamp(producedParts.join("\n"), MAX_BODY),
        meta: jobMeta(job, input.statusLabel),
        ...(job.createdAt ? { timestamp: job.createdAt } : {}),
        haystack: producedParts.join(" ").toLowerCase(),
      });
    }
  }

  for (const event of input.events) {
    const kind: MissionEvidenceKind | null = DECIDED_KINDS.has(event.kind)
      ? "decided"
      : CITED_KINDS.has(event.kind)
        ? "cited"
        : null;
    if (!kind) continue;
    items.push({
      id: `event:${event.id}`,
      kind,
      title: clamp(`${event.kind} · ${titleFor(event.taskId)}`, MAX_TITLE),
      body: clamp(event.message, MAX_BODY),
      meta: clamp(event.timestamp, MAX_META),
      timestamp: event.timestamp,
      haystack: [event.kind, event.message, titleFor(event.taskId)]
        .join(" ")
        .toLowerCase(),
    });
  }

  // Newest first — a mission's evidence is read from what just happened back.
  items.sort((left, right) => {
    const a = left.timestamp ? Date.parse(left.timestamp) : 0;
    const b = right.timestamp ? Date.parse(right.timestamp) : 0;
    return (Number.isFinite(b) ? b : 0) - (Number.isFinite(a) ? a : 0);
  });

  const omitted = Math.max(0, items.length - MAX_ITEMS);
  const bounded = omitted > 0 ? items.slice(0, MAX_ITEMS) : items;
  const counts: Record<MissionEvidenceKind, number> = {
    worked: 0,
    cited: 0,
    produced: 0,
    decided: 0,
  };
  for (const item of bounded) counts[item.kind] += 1;

  return {
    items: bounded,
    counts,
    empty: bounded.length === 0,
    omitted,
  };
}

/**
 * The search box is a FILTER over the evidence above, never a gate in front of
 * it. An empty query returns everything; every whitespace-separated term must
 * match, so "codex parser" narrows rather than widens.
 */
export function filterMissionEvidence(
  items: readonly MissionEvidenceItem[],
  query: string
): MissionEvidenceItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];
  return items.filter((item) => terms.every((term) => item.haystack.includes(term)));
}
