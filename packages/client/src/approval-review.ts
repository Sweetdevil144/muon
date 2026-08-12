import {
  RECEIPT_ALLOWED_CLASSES,
  classifyToolAction,
  parseGateTag,
  vendorLabel,
} from "@muon/protocol";
import { terminalSafe } from "./terminal-safe.js";
import type { ApprovalRequest } from "./types.js";

/**
 * The ONE standing-consent lifetime every MUON surface offers behind "don't
 * ask again". It is deliberately a single number, not a picker: the operator
 * is choosing "remember this" or "ask me again", never negotiating a duration.
 *
 * There is no second consent path — this rides the EXISTING content-bound
 * receipt (`resolveApproval({ receipt: { ttlMs } })`), which the server clamps
 * to 60s–60min and binds to the exact tool + payload digest + resolved target
 * + workspace + run. Desktop and TUI must send this same value so a remembered
 * action means the same thing on both.
 */
export const REMEMBER_ACTION_TTL_MS = 900_000;

/**
 * What "don't ask again" ACTUALLY buys, in one sentence, on screen. Every word
 * is load-bearing and matches the server's mint:
 *  - "this exact action" — tool + payload digest + operator-visible target
 *  - "in this run"       — one workspace, one dispatch job
 *  - "for 15 minutes"    — REMEMBER_ACTION_TTL_MS, then it expires on its own
 * The button says "don't ask again"; this says how far that promise reaches.
 */
export const REMEMBER_ACTION_SCOPE_SENTENCE =
  "Auto-approves this exact action, in this run, for the next 15 minutes.";

/**
 * The honest reason the affordance is unavailable. network / merge / ship —
 * and anything MUON cannot classify — always ask, by design.
 */
export const REMEMBER_ACTION_INELIGIBLE_SENTENCE =
  "This one always asks — only file reads, edits inside the task radius, and configured checks can be remembered.";

export type ApprovalReview = {
  action: string;
  scope: string;
  consequence: string;
  binding: string;
  authority: string;
  risk?: string;
  payloadDigest?: string;
  details?: { label: string; value: string }[];
  approvable: boolean;
  degraded: boolean;
  degradationReason: string | null;
  /**
   * P0.4: whether the "Approve, don't ask again" (receipt) affordance may be
   * OFFERED. True only for digest-bound `command` evidence whose action
   * classifies into a receipt-allowed class — or plain Bash, where the client
   * cannot prove test-class without the job's checks, so the affordance shows
   * and the server mint stays the final authority. An ineligible mint is a
   * SOFT SKIP (BUG-1): the approval decision always lands (200), the receipt is
   * silently not minted, and the response carries `receiptSkipped` + a reason —
   * never a 400. Never eligible for gate kinds, degraded requests, or always-ask
   * classes.
   */
  receiptEligible: boolean;
};

/** Client-side gate for SHOWING the receipt affordance; the server mint rules. */
function isReceiptEligible(
  evidence: NonNullable<ApprovalRequest["evidence"]>
): boolean {
  if (!evidence.payloadDigest) {
    return false;
  }
  const details = evidence.details ?? {};
  const classified = classifyToolAction({
    toolName: evidence.action,
    command: details.command,
    path: details.path,
  });
  if (
    classified !== null &&
    (RECEIPT_ALLOWED_CLASSES as readonly string[]).includes(classified.class)
  ) {
    return true;
  }
  // Bash: only the server (with the job's check commands) can prove test-class.
  return evidence.action === "Bash" && typeof details.command === "string";
}

function requestLabel(kind: string): string {
  return `${kind.replaceAll("_", " ")} request`.replace(/^./, (char) =>
    char.toUpperCase()
  );
}

function detailLabel(key: string): string {
  if (key === "sessionId") return "Session ID";
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (char) => char.toUpperCase());
}

/** Human-facing projection of the exact server-stored approval binding.
 *
 * Every AGENT-ADJACENT field (action/scope/consequence/details — evidence is
 * written by whatever the agent asked to run) passes through `terminalSafe`
 * HERE, at the one projection boundary, not per surface. The protocol only
 * LENGTH-bounds these strings, and the TUI renders them into a real terminal:
 * a bare CR or SGR sequence in `details.command` could repaint the very line
 * the operator approves ("rm -rf ~\r  npm test" draws as npm test). The
 * desktop renders the same projection into the DOM, where the stripped
 * control characters were inert anyway — sanitizing centrally costs it
 * nothing and means no surface can forget. */
export function buildApprovalReview(
  approval: ApprovalRequest
): ApprovalReview {
  if (!approval.gateTag) {
    if (approval.kind === "command" && approval.evidence) {
      return {
        action: terminalSafe(approval.evidence.action),
        scope: terminalSafe(approval.evidence.scope),
        consequence: terminalSafe(approval.evidence.impactIfApproved),
        binding: approval.evidence.payloadDigest
          ? `Session-scoped request · payload SHA-256 ${approval.evidence.payloadDigest}`
          : "Session-scoped request · exact structured action and scope",
        authority:
          "Your decision applies only to this request; it cannot approve merges, releases, or child work",
        risk: approval.evidence.riskLevel,
        payloadDigest: approval.evidence.payloadDigest,
        details: Object.entries(approval.evidence.details).map(([key, value]) => ({
          label: detailLabel(key),
          value: terminalSafe(value),
        })),
        approvable: true,
        degraded: false,
        degradationReason: null,
        receiptEligible: isReceiptEligible(approval.evidence),
      };
    }

    const missingCommandEvidence = approval.kind === "command";
    return {
      action: requestLabel(approval.kind),
      scope: `Task ${approval.taskId}`,
      consequence:
        missingCommandEvidence
          ? "MUON cannot prove the exact tool input, risk, or impact for this legacy command request."
          : "Approving records this decision only; it does not grant broader access.",
      binding: "No structured approval binding is attached.",
      authority: missingCommandEvidence
        ? "Unknown command scope; approval disabled"
        : "Your decision only",
      approvable: !missingCommandEvidence,
      degraded: missingCommandEvidence,
      degradationReason: missingCommandEvidence
        ? "This command request has no structured evidence. Reject it and let the agent file a fresh request."
        : null,
      receiptEligible: false,
    };
  }

  const parsed = parseGateTag(approval.gateTag);
  if (!parsed || parsed.action === "other") {
    return {
      action: "Unrecognized action",
      scope: `Task ${approval.taskId}`,
      consequence:
        "MUON cannot prove which route action this approval would authorize.",
      binding: terminalSafe(approval.gateTag),
      authority: "Unknown; approval disabled",
      approvable: false,
      degraded: true,
      degradationReason:
        "The stored approval binding is malformed or unsupported. Reject it and file a fresh request.",
      receiptEligible: false,
    };
  }

  if (parsed.action === "set_fleet") {
    const counts = ["claude-code", "codex", "cursor"]
      .filter((vendor) => parsed.counts[vendor] !== undefined)
      .map(
        (vendor) => `${vendorLabel(vendor)} ${parsed.counts[vendor] as number}`
      )
      .join(" · ");
    return {
      action: "Resize local agent fleet",
      scope: counts || "No fleet-count change",
      consequence:
        "MUON will add or remove local agent slots to match these exact counts.",
      binding: terminalSafe(approval.gateTag),
      authority: "One-use approval",
      approvable: true,
      degraded: false,
      degradationReason: null,
      receiptEligible: false,
    };
  }

  if (parsed.action === "apply_workflow") {
    return {
      action: "Apply workflow proposal",
      scope: `Workflow ${parsed.runId}${
        parsed.proposalHash ? ` · proposal ${parsed.proposalHash.slice(0, 12)}` : ""
      }`,
      consequence:
        "MUON will materialize the hash-bound workflow steps and make them eligible for dispatch.",
      binding: terminalSafe(approval.gateTag),
      authority: "One-use approval tied to this exact plan",
      approvable: true,
      degraded: false,
      degradationReason: null,
      receiptEligible: false,
    };
  }

  if (parsed.action === "amend_workflow") {
    return {
      action: "Append steps to a running workflow",
      scope: `Workflow ${parsed.runId} · amendment ${parsed.amendmentId.slice(0, 8)}${
        parsed.stepsHash ? ` · steps ${parsed.stepsHash.slice(0, 12)}` : ""
      }`,
      consequence:
        "MUON will append the hash-bound steps to a run that is already executing and make them eligible for dispatch. No existing step, budget, or status changes.",
      binding: terminalSafe(approval.gateTag),
      authority: "One-use approval tied to this exact amendment",
      approvable: true,
      degraded: false,
      degradationReason: null,
      receiptEligible: false,
    };
  }

  if (parsed.action === "raise_budget") {
    return {
      action: "Raise delegation budget",
      scope: `Job ${parsed.jobId.slice(0, 8)} · pool ${parsed.poolMs} ms`,
      consequence:
        "MUON will raise this mission's descendant wall-clock pool to the bound amount, so more delegated work can run this turn.",
      binding: terminalSafe(approval.gateTag),
      authority: "One-use approval tied to this exact job + pool",
      approvable: true,
      degraded: false,
      degradationReason: null,
      receiptEligible: false,
    };
  }

  return {
    action: "Run full-auto vendor action",
    scope: `${vendorLabel(parsed.vendor)} · ${parsed.verb}`,
    consequence:
      "The selected vendor may modify the selected workspace without incremental permission prompts for this one-shot action.",
    binding: terminalSafe(approval.gateTag),
    authority: "One-use approval tied to this exact action",
    approvable: true,
    degraded: false,
    degradationReason: null,
    receiptEligible: false,
  };
}
