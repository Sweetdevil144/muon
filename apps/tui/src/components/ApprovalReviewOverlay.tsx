import { Box, Text } from "ink";
import {
  buildApprovalReview,
  REMEMBER_ACTION_INELIGIBLE_SENTENCE,
  REMEMBER_ACTION_SCOPE_SENTENCE,
  type ApprovalRequest,
  type ReviewCoverageCertification,
} from "@muon/client";
import { hub, panelBorder } from "../lib/theme.js";
import { terminalSafe } from "@muon/client";

// Parity with the desktop gate: THREE actions, same words, same governed call.
//   a  approve                  → resolveApproval(approved)
//   A  approve, don't ask again → resolveApproval(approved, REMEMBER_ACTION_TTL_MS)
//   r  reject                   → resolveApproval(rejected)
// `m` is not a fourth action — it is the REVIEW BLIND attestation a merge needs
// before its approve is legal at all, and it exists only on that one gate kind.
const THREE_ACTIONS = "a approve · A approve, don't ask again · r reject";
const APPROVE_AND_REJECT = "a approve · r reject";

export function ApprovalReviewOverlay(props: {
  approval: ApprovalRequest;
  certification?: ReviewCoverageCertification | null;
  certificationError?: string | null;
  resolving?: boolean;
  width: number;
}) {
  const review = buildApprovalReview(props.approval);
  return (
    <Box
      flexDirection="column"
      borderStyle={panelBorder}
      borderColor={review.degraded ? "red" : hub.warn}
      paddingX={2}
      paddingY={1}
      width={Math.min(props.width, 88)}
    >
      <Text bold color={review.degraded ? "red" : hub.warn}>
        NEEDS YOUR APPROVAL · {review.risk?.toUpperCase() ?? "BOUND"}
      </Text>
      <Text bold>{review.action}</Text>
      <Text>
        <Text dimColor>Scope: </Text>
        {review.scope}
      </Text>
      <Text>
        <Text dimColor>Consequence: </Text>
        {review.consequence}
      </Text>
      <Text>
        <Text dimColor>Authority: </Text>
        {review.authority}
      </Text>
      <Text>
        <Text dimColor>Binding: </Text>
        {terminalSafe(review.binding)}
      </Text>
      {review.details?.map((detail) => (
        <Text key={detail.label}>
          <Text dimColor>{detail.label}: </Text>
          {detail.value}
        </Text>
      ))}
      {review.degradationReason ? (
        <Text color="red">Cannot approve: {terminalSafe(review.degradationReason)}</Text>
      ) : null}
      {props.approval.kind === "merge" ? (
        props.certificationError ? (
          <Text color="red">
            Cannot approve: {terminalSafe(props.certificationError)}
          </Text>
        ) : !props.certification ? (
          <Text color={hub.warn}>Checking exact worktree review…</Text>
        ) : props.certification.status === "certified" ? (
          <Text color="green">
            {props.certification.verdict === "no-op"
              ? "Merge review: no changes to land"
              : `Merge review: graph covers ${props.certification.changedFiles.length} changed file(s)`}
          </Text>
        ) : props.certification.blockCode === "review-blind" ? (
          <>
            <Text color={hub.warn}>{terminalSafe(props.certification.reason)}</Text>
            {(props.certification.blindFiles ?? []).slice(0, 12).map((file) => (
              <Text key={file}>  • {terminalSafe(file)}</Text>
            ))}
            {(props.certification.blindFiles?.length ?? 0) > 12 ? (
              <Text bold color="red">
                {(props.certification.blindFiles?.length ?? 0) - 12} more blind
                files are hidden by the terminal viewport. Use Desktop or
                `muon approve review`; TUI attestation is disabled.
              </Text>
            ) : (
              <Text bold color={hub.warn}>
                Review every blind file, then press m to attest this exact
                artifact and approve.
              </Text>
            )}
          </>
        ) : (
          <Text color="red">
            Cannot approve: {terminalSafe(props.certification.reason)}
          </Text>
        )
      ) : null}
      <Text bold>
        {props.resolving
          ? "Applying decision…"
          : review.approvable && props.approval.kind === "merge"
          ? props.certification?.status === "certified"
            ? `${APPROVE_AND_REJECT} · Esc close`
            : props.certification?.status === "blocked" &&
                props.certification.blockCode === "review-blind" &&
                (props.certification.blindFiles?.length ?? 0) <= 12
              ? "m attest reviewed blind files + approve · r reject · Esc close"
              : "r reject · Esc close"
          : review.approvable
          ? review.receiptEligible
            ? `${THREE_ACTIONS} · Esc close`
            : `${APPROVE_AND_REJECT} · Esc close`
          : "r reject malformed request · Esc close"}
      </Text>
      {/* The same one sentence the desktop button carries — say exactly how far
          "don't ask again" reaches, or why it cannot apply here. */}
      <Text dimColor>
        {review.receiptEligible
          ? REMEMBER_ACTION_SCOPE_SENTENCE
          : REMEMBER_ACTION_INELIGIBLE_SENTENCE}
      </Text>
    </Box>
  );
}
