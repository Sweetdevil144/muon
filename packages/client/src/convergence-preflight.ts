import type {
  PreEditActivityView,
  PreEditDuplicateWorkView,
  PreEditMemoryView,
  PreEditProposalView,
  PreEditView,
  PreEditWarningView,
} from "./preedit-view.js";

export type ConvergencePosture =
  | "clear"
  | "coordinate"
  | "human-review"
  | "degraded";

export type ConvergenceSeverity =
  | "neutral"
  | "info"
  | "attention"
  | "warning";

export type ConvergenceRow = {
  id: string;
  label: string;
  detail?: string;
  severity: ConvergenceSeverity;
  trustedText: boolean;
};

export type ConvergenceSection = {
  key: "intent" | "evidence" | "coordination" | "authority";
  title: string;
  summary: string;
  severity: ConvergenceSeverity;
  count: number;
  chips: string[];
  rows: ConvergenceRow[];
};

export type ConvergenceAction = {
  kind: "proceed" | "coordinate" | "review" | "narrow";
  label: string;
  reason: string;
};

export type ConvergencePreflightInput = {
  view: PreEditView;
  intent?: {
    taskId?: string;
    taskTitle?: string;
    workspacePath?: string;
    vendor?: string;
    action?: string;
    briefLabel?: string;
  };
  authority?: {
    principal?: "human" | "agent" | "system";
    runnerPhase?: string;
    sandboxed?: boolean | null;
    pendingApprovalCount?: number;
  };
};

export type ConvergencePreflight = {
  version: 1;
  posture: ConvergencePosture;
  headline: string;
  intent: ConvergenceSection;
  evidence: ConvergenceSection;
  coordination: ConvergenceSection;
  authority: ConvergenceSection;
  nextActions: ConvergenceAction[];
  invariants: {
    confirmedMemoryOnly: true;
    untrustedTextWithheld: true;
    coordinatesOnlyCollaboration: true;
    authorityIsAdvisory: true;
  };
};

const MAX_INTENT_IDENTIFIER_LENGTH = 64;
const INTENT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function cleanChip(value: string | null | undefined): string | undefined {
  const clean = value?.trim();
  return clean && clean.length <= 256 && !/[\r\n]/.test(clean)
    ? clean
    : undefined;
}

function normalizeIdentifier(
  value: string | null | undefined
): string | undefined {
  const clean = cleanChip(value);
  return clean &&
    clean.length <= MAX_INTENT_IDENTIFIER_LENGTH &&
    INTENT_IDENTIFIER.test(clean)
    ? clean
    : undefined;
}

function normalizeAction(action: string | undefined): string | undefined {
  const name = normalizeIdentifier(action?.trim().replace(/^\/+/, ""));
  return name ? `/${name}` : undefined;
}

function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function postureOf(
  view: PreEditView,
  activity: PreEditActivityView[],
  duplicateWork: PreEditDuplicateWorkView[],
  warnings: PreEditWarningView[],
  pendingProposals: PreEditProposalView[]
): ConvergencePosture {
  if (pendingProposals.length > 0 || warnings.length > 0) {
    return "human-review";
  }
  if (activity.some((entry) => entry.onTarget) || duplicateWork.length > 0) {
    return "coordinate";
  }
  if (view.blastRadius.source === "target-only" || view.blastRadius.degraded) {
    return "degraded";
  }
  return "clear";
}

function memoryRow(memory: PreEditMemoryView): ConvergenceRow {
  return {
    id: memory.note.id,
    label: `${memory.kindLabel} · ${memory.proximityLabel}${
      memory.note.stale ? " · stale" : ""
    }`,
    detail: memory.note.text,
    severity: memory.note.stale ? "attention" : "info",
    trustedText: true,
  };
}

function activityRow(entry: PreEditActivityView): ConvergenceRow {
  return {
    id: `activity:${entry.jobId}:${entry.anchor}:${entry.state}`,
    label: entry.summary,
    severity: entry.onTarget ? "warning" : "info",
    trustedText: false,
  };
}

function duplicateWorkRow(entry: PreEditDuplicateWorkView): ConvergenceRow {
  return {
    id: `duplicate:${entry.jobId}`,
    label: entry.summary,
    severity: "warning",
    trustedText: false,
  };
}

function warningRow(
  warning: PreEditWarningView | PreEditProposalView
): ConvergenceRow {
  if ("proposalNoteId" in warning) {
    return {
      id: `proposal:${warning.proposalNoteId}`,
      label: warning.summary,
      detail: warning.detail,
      severity: "warning",
      trustedText: false,
    };
  }
  return {
    id: `warning:${warning.noteId}:${warning.relatedNoteId}`,
    label: warning.label,
    detail: warning.detail,
    severity: "warning",
    trustedText: false,
  };
}

function intentChips(
  intent: ConvergencePreflightInput["intent"]
): string[] {
  if (!intent) {
    return [];
  }
  const taskId = normalizeIdentifier(intent.taskId);
  const taskTitle = cleanChip(intent.taskTitle);
  const task =
    taskTitle && taskId ? `${taskTitle} (${taskId})` : taskTitle ?? taskId;
  return [
    task,
    cleanChip(intent.briefLabel),
    cleanChip(intent.workspacePath),
    normalizeIdentifier(intent.vendor),
    normalizeAction(intent.action),
  ].filter((value): value is string => value !== undefined);
}

function authorityChips(
  authority: ConvergencePreflightInput["authority"]
): string[] {
  const runnerPhase = cleanChip(authority?.runnerPhase);
  const chips: Array<string | undefined> = [
    authority?.principal
      ? `principal:${authority.principal}`
      : "principal:not-supplied",
    runnerPhase ? `runner:${runnerPhase}` : "runner:not-supplied",
  ];
  if (authority?.sandboxed === true) {
    chips.push("sandboxed");
  } else if (authority?.sandboxed === false) {
    chips.push("unsandboxed");
  } else if (authority?.sandboxed === null) {
    chips.push("sandbox:unknown");
  } else {
    chips.push("sandbox:not-supplied");
  }
  if (authority?.pendingApprovalCount !== undefined) {
    const count = Math.max(0, Math.trunc(authority.pendingApprovalCount));
    chips.push(`${count} approval${count === 1 ? "" : "s"} pending`);
  }
  return chips.filter((value): value is string => value !== undefined);
}

function nextActionsFor(posture: ConvergencePosture): ConvergenceAction[] {
  switch (posture) {
    case "human-review":
      return [
        {
          kind: "review",
          label: "Review before editing",
          reason:
            "A warning or pending proposal needs your decision.",
        },
      ];
    case "coordinate":
      return [
        {
          kind: "coordinate",
          label: "Coordinate before editing",
          reason:
            "Another crew member is working on the same code or similar work.",
        },
      ];
    case "degraded":
      return [
        {
          kind: "narrow",
          label: "Narrow or confirm the target",
          reason:
            "Only the selected target is known. Open better impact evidence before broad edits.",
        },
      ];
    case "clear":
      return [
        {
          kind: "proceed",
          label: "Proceed with the edit",
          reason:
            "No overlapping work or pending review was found, and impact evidence is available.",
        },
      ];
  }
}

export function buildConvergencePreflight(
  input: ConvergencePreflightInput
): ConvergencePreflight {
  const { view } = input;
  const modules = view.blastRadius.modules ?? [];
  const symbols = view.blastRadius.symbols ?? [];
  const memories = (view.memories ?? []).filter(
    (memory) => memory.note.confirmed
  );
  const activity = view.activity ?? [];
  const duplicateWork = view.duplicateWork ?? [];
  const warnings = view.warnings ?? [];
  const pendingProposals = view.pendingProposals ?? [];
  const posture = postureOf(
    view,
    activity,
    duplicateWork,
    warnings,
    pendingProposals
  );

  const staleCount = memories.filter((memory) => memory.note.stale).length;
  const evidenceChips = [
    view.blastRadius.sourceLabel,
    countLabel(modules.length, "module"),
    countLabel(symbols.length, "symbol"),
    view.blastRadius.depth === undefined
      ? undefined
      : `depth:${view.blastRadius.depth}`,
    staleCount > 0 ? countLabel(staleCount, "stale", "stale") : undefined,
  ].filter((value): value is string => value !== undefined);

  const activityRows = activity.map(activityRow);
  const duplicateRows = duplicateWork.map(duplicateWorkRow);
  const coordinationRows = [...activityRows, ...duplicateRows];
  const exactTargetCount = activity.filter((entry) => entry.onTarget).length;
  const neighbourCount = activity.length - exactTargetCount;
  const coordinationChips = [
    view.activeLaneCount > 0
      ? countLabel(view.activeLaneCount, "live lane")
      : undefined,
    view.recentLaneCount > 0
      ? countLabel(view.recentLaneCount, "recent lane")
      : undefined,
    exactTargetCount > 0
      ? countLabel(
          exactTargetCount,
          "exact-target activity",
          "exact-target activities"
        )
      : undefined,
    neighbourCount > 0
      ? countLabel(
          neighbourCount,
          "blast-radius activity",
          "blast-radius activities"
        )
      : undefined,
    duplicateWork.length > 0
      ? countLabel(duplicateWork.length, "duplicate-work signal")
      : undefined,
  ].filter((value): value is string => value !== undefined);

  const authorityRows = [
    ...warnings.map(warningRow),
    ...pendingProposals.map(warningRow),
  ];
  const pendingApprovalCount = Math.max(
    0,
    Math.trunc(input.authority?.pendingApprovalCount ?? 0)
  );

  return {
    version: 1,
    posture,
    headline: {
      clear: "Preflight clear",
      coordinate: "Coordinate before editing",
      "human-review": "Review needed",
      degraded: "Impact evidence degraded",
    }[posture],
    intent: {
      key: "intent",
      title: "Intent",
      summary: view.targetLabel,
      severity: "info",
      count: modules.length + symbols.length,
      chips: intentChips(input.intent),
      rows: [],
    },
    evidence: {
      key: "evidence",
      title: "Evidence",
      summary: `${countLabel(
        memories.length,
        "memory note",
        "memory notes"
      )} · ${countLabel(modules.length, "module")} · ${countLabel(
        symbols.length,
        "symbol"
      )}`,
      severity:
        view.blastRadius.degraded || staleCount > 0 ? "attention" : "info",
      count: memories.length,
      chips: evidenceChips,
      rows: memories.map(memoryRow),
    },
    coordination: {
      key: "coordination",
      title: "Coordination",
      summary:
        coordinationRows.length === 0
          ? "No overlapping work detected."
          : `${countLabel(
              activity.length,
              "activity coordinate"
            )} · ${countLabel(
              duplicateWork.length,
              "duplicate-work coordinate"
            )}`,
      severity:
        exactTargetCount > 0 || duplicateWork.length > 0
          ? "warning"
          : coordinationRows.length > 0
            ? "info"
            : "neutral",
      count: coordinationRows.length,
      chips: coordinationChips,
      rows: coordinationRows,
    },
    authority: {
      key: "authority",
      title: "Control",
      summary:
        "Final approval stays with you. This view cannot expand access.",
      severity:
        authorityRows.length > 0
          ? "warning"
          : pendingApprovalCount > 0
            ? "attention"
            : "neutral",
      count: authorityRows.length,
      chips: authorityChips(input.authority),
      rows: authorityRows,
    },
    nextActions: nextActionsFor(posture),
    invariants: {
      confirmedMemoryOnly: true,
      untrustedTextWithheld: true,
      coordinatesOnlyCollaboration: true,
      authorityIsAdvisory: true,
    },
  };
}
