import { VENDOR_IDS, isVendorId, vendorLabel } from "@muon/protocol";
import type { RecordedEvent } from "./types.js";

export type AuditTone = "active" | "attention" | "complete" | "neutral";

export type AuditEntry = {
  id: string;
  taskId: string;
  actor: string;
  headline: string;
  detail: string;
  timestamp: string;
  tone: AuditTone;
  payloadTrust: "data-only";
};

const HEADLINES: Record<string, { label: string; tone: AuditTone }> = {
  "task.started": { label: "Started work", tone: "active" },
  "task.progress": { label: "Reported progress", tone: "active" },
  "task.blocked": { label: "Reported a blocker", tone: "attention" },
  "task.completed": { label: "Completed work", tone: "complete" },
  "approval.requested": {
    label: "Requested a human decision",
    tone: "attention",
  },
  // P0.4: every policy/receipt auto-allow is visible on the audit spine.
  "approval.auto": {
    label: "Auto-approved a policy-bound action",
    tone: "neutral",
  },
  "handoff.created": { label: "Created a handoff", tone: "neutral" },
  "workflow.proposed": { label: "Proposed a workflow", tone: "attention" },
  "workflow.applied": { label: "Applied a workflow", tone: "active" },
  "loop.started": { label: "Started a loop", tone: "active" },
  "loop.iteration": { label: "Completed a loop iteration", tone: "active" },
  "loop.stopped": { label: "Stopped a loop", tone: "neutral" },
  "fleet.updated": { label: "Updated the local fleet", tone: "neutral" },
};

/**
 * WAVE D: one label source, plus the ORDINAL suffix a fleet lane id carries
 * (`codex-2` → "Codex 2"). The suffix handling used to exist for two vendors by
 * name; it now works for every registered vendor, which is what the fleet
 * actually produces.
 */
function actorLabel(laneId: string): string {
  const normalized = laneId.replaceAll("_", "-");
  if (isVendorId(normalized)) {
    return vendorLabel(normalized);
  }
  for (const id of VENDOR_IDS) {
    if (normalized.startsWith(`${id}-`)) {
      return `${vendorLabel(id)} ${normalized.slice(id.length + 1)}`;
    }
  }
  if (normalized === "muon-orchestrator" || normalized === "muon-chat") {
    return "MUON";
  }
  return laneId;
}

function boundedDetail(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}…`;
}

/** Projects untrusted event text into a bounded, explicitly data-only audit row. */
export function buildAuditTrail(events: RecordedEvent[]): AuditEntry[] {
  return events.slice(0, 50).map((event) => {
    const mapped = HEADLINES[event.kind] ?? {
      label: event.kind.replaceAll(".", " "),
      tone: "neutral" as const,
    };
    return {
      id: event.id,
      taskId: event.taskId,
      actor: actorLabel(event.laneId),
      headline: mapped.label,
      detail: boundedDetail(event.message),
      timestamp: event.timestamp,
      tone: mapped.tone,
      payloadTrust: "data-only",
    };
  });
}
