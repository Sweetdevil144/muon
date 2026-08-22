import type {
  ManualReviewAttestation,
  ReviewCoverageCertification,
} from "@muon/client";

/**
 * Merge-gate certification evidence (matrix rows I4/I5/I6). Owned HERE —
 * the policy module — so a surface adopting the policy constructs a domain
 * type, not a pane's rendering state (review finding). "loading" is a real
 * state a decision must WAIT on: approving a merge while its coverage
 * evidence is in flight is the review-blind hole.
 */
export type ReviewCertificationState =
  | { readonly phase: "loading" }
  | { readonly phase: "error"; readonly message: string }
  | { readonly phase: "loaded"; readonly value: ReviewCoverageCertification };

/**
 * The DOMAIN input (review finding: taking the whole `ReviewState` coupled
 * reusable policy to one pane's rendering model). Structurally narrower
 * than `ReviewState`, so the desk passes its state unchanged while another
 * surface constructs exactly these two facts.
 */
export type MergeReviewInput = {
  readonly approval: { readonly kind: string };
  readonly certification: ReviewCertificationState | null;
};

/**
 * ADR-0087 D3 — the merge-review POLICY, extracted from the desk
 * switchboard (the D62-named controller). Pure functions over
 * `ReviewState`: the desk owns the certification FETCH lifecycle (a
 * per-opening race guard is wiring, not policy) and these own every
 * eligibility question, so the guards exist exactly once and a second
 * surface can adopt them without re-deriving the classic desk's rules.
 */

/**
 * The classic desk's merge guard (I6): a merge may be APPROVED only
 * against loaded, non-blocked coverage evidence — or through the explicit
 * attest press, which supplies the attestation. Returns the refusal to
 * show, or null when the approve may proceed. Never called for rejects:
 * reject stays live in every state.
 */
export function mergeApproveRefusal(state: MergeReviewInput): string | null {
  if (state.approval.kind !== "merge") return null;
  const certification = state.certification;
  if (!certification || certification.phase === "loading") {
    return "merge review evidence is still loading";
  }
  if (certification.phase === "error") return certification.message;
  if (certification.value.status === "blocked") {
    return certification.value.blockCode === "review-blind"
      ? "review every blind file, then press m to attest and approve"
      : certification.value.reason;
  }
  return null;
}

/** How many blind files this desk will attest to — past this, the list
 *  cannot be inspected here and the resolution names where it can. */
export const MAX_ATTESTABLE_BLIND_FILES = 12;

export type AttestResolution =
  | { readonly ok: false; readonly refusal: string }
  | { readonly ok: true; readonly manualReview: ManualReviewAttestation };

/**
 * The attest press (I5), resolved against the SAME state the pane renders.
 * Every refusal is the classic desk's, verbatim, so the two surfaces
 * refuse identically.
 */
export function resolveAttest(state: MergeReviewInput): AttestResolution {
  if (state.approval.kind !== "merge") {
    return {
      ok: false,
      refusal: "✗ manual attestation applies to merge gates only",
    };
  }
  const certification = state.certification;
  if (!certification || certification.phase === "loading") {
    return { ok: false, refusal: "… merge review evidence is still loading" };
  }
  if (certification.phase === "error") {
    return { ok: false, refusal: `✗ ${certification.message}` };
  }
  if (certification.value.status !== "blocked") {
    return {
      ok: false,
      refusal: "✗ manual attestation is not needed; press a to approve",
    };
  }
  if (certification.value.blockCode !== "review-blind") {
    return { ok: false, refusal: `✗ ${certification.value.reason}` };
  }
  const blind = certification.value.blindFiles ?? [];
  if (blind.length > MAX_ATTESTABLE_BLIND_FILES) {
    return {
      ok: false,
      refusal:
        "✗ this review has more than 12 blind files; use Desktop or `muon approve review` to inspect the complete set",
    };
  }
  return {
    ok: true,
    manualReview: {
      acknowledged: true,
      artifactDigest: certification.value.artifactDigest,
      blindFiles: blind,
    },
  };
}
