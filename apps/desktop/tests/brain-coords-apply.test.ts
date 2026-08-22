import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  decideBrainCoordsApply,
  type BrainCoordinates,
  type DesktopSettings,
} from "../src/lib/settings.js";

// ── WHETHER A BRAIN HANDOVER MAY BE APPLIED AT ALL ───────────────────────────
//
// Applying one is destructive. `applyBrainCoords` ends in a runner restart, and
// the runner's children are the vendor sessions — a live coordinator has already
// been killed that way (exit 143). It also rewrites settings.json. So the two
// "don't" answers below are as load-bearing as the apply itself, and both were
// missing:
//
//  - PINNED: the API base is an editable field in the shipped Settings UI, and
//    `rebaseFromLockfile` honours the pin. `applyBrainCoords` overrode it AND
//    cleared it on disk, so the next launch could not restore it either: an
//    operator's explicit "talk to THIS brain" was silently, durably undone while
//    their live work was killed to do it.
//  - UNCHANGED: two producers now deliver coordinates (the supervisor's
//    late-readiness watch and `rebaseFromLockfile`'s scheduled apply) and they
//    can deliver the SAME ones. `rebaseFromLockfile` compares before applying;
//    the handover path did not, so a redundant re-apply was a free session kill.

const ADOPTED: DesktopSettings = {
  ...DEFAULT_SETTINGS,
  apiBase: "http://127.0.0.1:10777",
  apiBaseExplicit: false,
  apiToken: "op-tok",
  agentToken: "ag-tok",
};

const SAME: BrainCoordinates = {
  base: "http://127.0.0.1:10777",
  token: "op-tok",
  agentToken: "ag-tok",
};

describe("an operator-pinned base is never overridden by a brain handover", () => {
  it("skips, naming the pin, when the human typed the base", () => {
    expect(
      decideBrainCoordsApply({
        current: { ...ADOPTED, apiBase: "http://127.0.0.1:4000", apiBaseExplicit: true },
        coords: SAME,
      })
    ).toEqual({ action: "skip", reason: "pinned" });
  });

  it("still says PINNED when the coordinates happen to match", () => {
    // The reason is the one worth reporting: MUON found a brain and is not using
    // it because it was told where to talk.
    expect(
      decideBrainCoordsApply({
        current: { ...ADOPTED, apiBaseExplicit: true },
        coords: SAME,
      })
    ).toEqual({ action: "skip", reason: "pinned" });
  });

  it("a pin also blocks a token-only handover, tokens included", () => {
    expect(
      decideBrainCoordsApply({
        current: { ...ADOPTED, apiBaseExplicit: true },
        coords: { ...SAME, token: "fresh", agentToken: "fresh-agent" },
      })
    ).toEqual({ action: "skip", reason: "pinned" });
  });

  it("applies once the pin is gone", () => {
    expect(
      decideBrainCoordsApply({
        current: { ...ADOPTED, apiBaseExplicit: undefined },
        coords: { ...SAME, base: "http://127.0.0.1:20999" },
      })
    ).toEqual({ action: "apply" });
  });
});

describe("identical coordinates are a no-op, not a runner restart", () => {
  it("skips when the base and BOTH tokens are unchanged", () => {
    expect(decideBrainCoordsApply({ current: ADOPTED, coords: SAME })).toEqual({
      action: "skip",
      reason: "unchanged",
    });
  });

  it("treats an absent token as 'keep what is there' — the caller merges it that way", () => {
    expect(
      decideBrainCoordsApply({
        current: ADOPTED,
        coords: { base: ADOPTED.apiBase },
      })
    ).toEqual({ action: "skip", reason: "unchanged" });
  });

  it("APPLIES a token-only handover on the same base — the late-readiness case", () => {
    // This is exactly what the supervisor's late watch delivers when a slow boot
    // finally publishes its lockfile on the port settings already name: skipping
    // it would strand the desktop tokenless, which is the bug the watch exists
    // for.
    expect(
      decideBrainCoordsApply({
        current: { ...ADOPTED, apiToken: undefined, agentToken: undefined },
        coords: SAME,
      })
    ).toEqual({ action: "apply" });
  });

  it("APPLIES when only the agent token moved", () => {
    // It is injected into the orchestrator and the runner; a stale one is a lane
    // that cannot talk to the brain.
    expect(
      decideBrainCoordsApply({
        current: ADOPTED,
        coords: { ...SAME, agentToken: "rotated" },
      })
    ).toEqual({ action: "apply" });
  });

  it("APPLIES when the brain moved to a new port", () => {
    expect(
      decideBrainCoordsApply({
        current: ADOPTED,
        coords: { ...SAME, base: "http://127.0.0.1:20999" },
      })
    ).toEqual({ action: "apply" });
  });
});
