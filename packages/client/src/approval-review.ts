import {
  APPROVAL_GRANT_DURATION_TTL_MS,
  RECEIPT_ALLOWED_CLASSES,
  classifyToolAction,
  isGrantableApprovalKind,
  parseGateTag,
  vendorLabel,
} from "@muon/protocol";
import { terminalSafe } from "./terminal-safe.js";
import type { ApprovalRequest } from "./types.js";

/**
 * Re-exported so a SURFACE never has to reach into `@muon/protocol` for the
 * grade vocabulary. The desktop's standing decision (apps/desktop/src/shared/
 * ipc.ts) is that the app depends on `@muon/client` only; this subpath is how
 * the ADR-0056 grades cross that line.
 */
export type { ApprovalGrantDuration } from "@muon/protocol";

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

// ── ADR-0056: the `always` grade ─────────────────────────────────────────────
//
// The third grade of the SAME opt-in the receipt already implements. A surface
// sends a GRADE, never a number: the 7-day expiry is computed server-side from
// `APPROVAL_GRANT_DURATION_TTL_MS`, so nothing crossing the wire from a click
// carries an authority-bearing quantity. `session` (the receipt) and `always`
// (the grant) are mutually exclusive on one decision, which is why every
// surface below models the choice as ONE value, never two optional ones.

/**
 * The grade the "always" affordance sends. Named rather than inlined so a
 * surface cannot invent a fourth spelling of it.
 */
export const ALWAYS_ACTION_GRANT_DURATION = "always" as const;

/** Days the `always` grade buys, READ OFF the protocol's own TTL table so the
 *  sentence below can never drift from what the server actually mints. */
const ALWAYS_ACTION_DAYS = Math.round(
  APPROVAL_GRANT_DURATION_TTL_MS.always / (24 * 60 * 60 * 1_000)
);

/**
 * What "always in this chat" ACTUALLY buys, in one sentence, on screen. Every
 * clause matches ADR-0056 D2/D3/D5:
 *  - "this exact action" — tool + payload digest + operator-visible target
 *  - "in this chat"      — the taskId, NOT the workspace and NOT the agent
 *  - "for the next 7 days" — a server-computed absolute expiry
 *  - "revoke it any time"  — one-way operator revocation, effective next call
 * It deliberately never says "always" unqualified: the whole point of the grade
 * is that it is a sentence about an action, not a blanket auto-approve.
 */
export const ALWAYS_ACTION_SCOPE_SENTENCE = `Auto-approves this exact action, in this chat only, for the next ${ALWAYS_ACTION_DAYS} days. Revoke it any time.`;

/**
 * The honest reason the `always` affordance is unavailable, true for BOTH ways
 * it can be blocked: the approval kind is not on `GRANTABLE_APPROVAL_KINDS`
 * (merge, deploy, dangerous_action, gate — authority-shaped, nothing to bind),
 * or the action's class is not one a receipt could cover either.
 *
 * Worded so it does NOT restate `REMEMBER_ACTION_INELIGIBLE_SENTENCE`: on a
 * merge both sentences are on screen at once, and saying the same thing twice
 * is how a decision surface gets crowded.
 */
export const ALWAYS_ACTION_INELIGIBLE_SENTENCE =
  "No chat-wide grant here — merges, releases, capability changes and anything MUON cannot classify are decided by a human every time.";

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
  /**
   * ADR-0056: whether the "Approve, always in this chat" (durable grant)
   * affordance may be OFFERED.
   *
   * Derived from the PROTOCOL'S OWN POSITIVE SET (`isGrantableApprovalKind`),
   * never from a per-surface list and never as "everything except merge" — a
   * kind added tomorrow is ineligible by default because it is not on the
   * list. The receipt clause rides on top unchanged, so `always` can never
   * cover something `session` could not (the server derives both eligibilities
   * through the one `deriveReceiptBinding`).
   *
   * This matters more than the receipt's flag does: a merge carrying a durable
   * grade is a hard 400 that leaves the approval PENDING, so offering the
   * button there would teach the operator the app is broken. Surfaces disable
   * it and say why (`ALWAYS_ACTION_INELIGIBLE_SENTENCE`) rather than hiding it.
   */
  grantEligible: boolean;
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
      const receiptEligible = isReceiptEligible(approval.evidence);
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
        receiptEligible,
        // ADR-0056 D6, stated positively: the kind must be ON the protocol's
        // allow-list AND the action must be one a receipt could already cover.
        // `isGrantableApprovalKind` is asked even here, where the branch has
        // already proved `kind === "command"`, on purpose — the day that list
        // changes, this line changes with it instead of silently disagreeing.
        grantEligible:
          receiptEligible && isGrantableApprovalKind(approval.kind),
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
      // ADR-0056 D6: not a `command` kind (or no bindable content), so there is
      // nothing a durable grant could be a sentence ABOUT.
      grantEligible: false,
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
      // ADR-0056 D6: not a `command` kind (or no bindable content), so there is
      // nothing a durable grant could be a sentence ABOUT.
      grantEligible: false,
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
      // ADR-0056 D6: not a `command` kind (or no bindable content), so there is
      // nothing a durable grant could be a sentence ABOUT.
      grantEligible: false,
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
      // ADR-0056 D6: not a `command` kind (or no bindable content), so there is
      // nothing a durable grant could be a sentence ABOUT.
      grantEligible: false,
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
      // ADR-0056 D6: not a `command` kind (or no bindable content), so there is
      // nothing a durable grant could be a sentence ABOUT.
      grantEligible: false,
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
      // ADR-0056 D6: not a `command` kind (or no bindable content), so there is
      // nothing a durable grant could be a sentence ABOUT.
      grantEligible: false,
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
    // ADR-0056 D6: not a `command` kind (or no bindable content), so there is
    // nothing a durable grant could be a sentence ABOUT.
    grantEligible: false,
  };
}
