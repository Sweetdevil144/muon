import { describe, expect, it } from "vitest";
import {
  MAX_ATTESTABLE_BLIND_FILES,
  mergeApproveRefusal,
  resolveAttest,
} from "../src/shell/merge-review.js";
import type { MergeReviewInput } from "../src/shell/merge-review.js";

// ── ADR-0087 D3 — the merge-review policy, pinned at the module ─────────────
//
// These guards used to live inline in the desk switchboard; the extraction
// makes them directly testable against the NARROW domain input (no pane
// state, no casts), and every refusal is the classic desk's verbatim
// (governed-op cross-surface parity).

function state(over: Partial<MergeReviewInput> = {}): MergeReviewInput {
  return {
    approval: { kind: "merge" },
    certification: { phase: "loading" },
    ...over,
  };
}

const CERTIFIED = {
  phase: "loaded",
  value: {
    status: "certified",
    verdict: "graph-certified",
    changedFiles: ["a.ts"],
    artifactDigest: "b".repeat(64),
  },
} as const;

const BLIND = {
  phase: "loaded",
  value: {
    status: "blocked",
    blockCode: "review-blind",
    reason: "1 changed file has no review coverage",
    blindFiles: ["src/a.ts"],
    changedFiles: ["src/a.ts"],
    artifactDigest: "c".repeat(64),
  },
} as const;

describe("mergeApproveRefusal", () => {
  it("non-merge gates never consult the certification", () => {
    expect(
      mergeApproveRefusal(state({ approval: { kind: "command" } }))
    ).toBeNull();
  });

  it("loading refuses, error surfaces its message, blocked names the way out, certified clears", () => {
    expect(mergeApproveRefusal(state())).toContain("still loading");
    expect(
      mergeApproveRefusal(
        state({ certification: { phase: "error", message: "boom" } })
      )
    ).toBe("boom");
    expect(mergeApproveRefusal(state({ certification: BLIND }))).toContain(
      "press m to attest"
    );
    expect(
      mergeApproveRefusal(state({ certification: CERTIFIED }))
    ).toBeNull();
  });
});

describe("resolveAttest", () => {
  it("attests a review-blind merge with the digest and the COMPLETE blind list", () => {
    const resolution = resolveAttest(state({ certification: BLIND }));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.manualReview).toEqual({
      acknowledged: true,
      artifactDigest: "c".repeat(64),
      blindFiles: ["src/a.ts"],
    });
  });

  it("refuses: non-merge, loading, error, not-needed, non-review-blind, and past the blind-file cap", () => {
    const cases: Array<[MergeReviewInput, string]> = [
      [state({ approval: { kind: "command" } }), "merge gates only"],
      [state(), "still loading"],
      [state({ certification: { phase: "error", message: "boom" } }), "boom"],
      [state({ certification: CERTIFIED }), "not needed"],
      [
        state({
          certification: {
            phase: "loaded",
            value: { ...BLIND.value, blockCode: "stale", reason: "index moved" },
          } as never,
        }),
        "index moved",
      ],
      [
        state({
          certification: {
            phase: "loaded",
            value: {
              ...BLIND.value,
              blindFiles: Array.from(
                { length: MAX_ATTESTABLE_BLIND_FILES + 1 },
                (_, i) => `f${i}.ts`
              ),
            },
          } as never,
        }),
        "more than 12 blind files",
      ],
    ];
    for (const [input, needle] of cases) {
      const resolution = resolveAttest(input);
      expect(resolution.ok).toBe(false);
      if (resolution.ok) continue;
      expect(resolution.refusal).toContain(needle);
    }
  });
});
