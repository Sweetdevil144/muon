import { describe, expect, it } from "vitest";
import {
  preEditCoverageEmptyReason,
  preEditCoverageSchema,
} from "../src/preedit-coverage.js";

describe("an anchor that resolved to nothing is not evidence of absence", () => {
  // "only modules carry notes" is shorthand for the LOOKUP: notes can be
  // anchored to symbols too, but the gate's candidate query fans out over
  // module anchors, so a target with no module resolves nothing.
  // Measured on a live ledger: `muon context resolveDataDir` (a bare symbol,
  // no module) reported "nothing is recorded here yet, not even unconfirmed"
  // while two decision notes sat on that symbol's module. The gate resolved no
  // anchor, looked up nothing, and reported an empty brain — the one lie a
  // pre-edit gate must never tell.
  // PARSED THROUGH THE REAL SCHEMA, not cast into it. The first version of
  // this fixture put `admittedBy` inside `notes` and omitted it at the top
  // level, and an `as` cast hid the mismatch — so the tests would have pinned
  // behaviour against a shape the type does not have. Parsing fails loudly
  // instead.
  const coverage = (over: Record<string, unknown> = {}) =>
    preEditCoverageSchema.parse({
      anchors: {
        modules: { requested: 0, resolved: 0 },
        symbols: { requested: 1, resolved: 0 },
        unreadable: 0,
      },
      notes: { considered: 0, admitted: 0, surfaced: 0 },
      admittedBy: { humanConfirmed: 0, crewVouched: 0, trustFloor: 0 },
      crewChat: false,
      ...over,
    });

  it("a BARE SYMBOL with no module gets its OWN reason — the lookup needs one", () => {
    // Not `no_anchors`: that one means no candidate query ran at all, and this
    // one ran a symbol query. Folding them would fire the same telemetry alarm
    // for two different states and tell the agent the wrong remedy.
    expect(preEditCoverageEmptyReason(coverage())).toBe("no_module_anchor");
  });

  it("still reports index_unavailable when a probe was unreadable", () => {
    // Zero is unknown, not empty — an unreadable probe outranks both.
    const withUnreadable = coverage({
      anchors: {
        modules: { requested: 0, resolved: 0 },
        symbols: { requested: 1, resolved: 0 },
        unreadable: 1,
      },
    });
    expect(preEditCoverageEmptyReason(withUnreadable)).toBe("index_unavailable");
  });

  it("keeps no_notes_on_anchors for a REAL BUT BARREN module", () => {
    // The honest empty: the gate did look, at a real module, and found none.
    // This is `requested 1, resolved 0` too — which is why the discriminator
    // cannot be `resolved`, and why the first version of this fix broke it.
    const resolvedButEmpty = coverage({
      anchors: {
        modules: { requested: 1, resolved: 0 },
        symbols: { requested: 0, resolved: 0 },
        unreadable: 0,
      },
    });
    expect(preEditCoverageEmptyReason(resolvedButEmpty)).toBe(
      "no_notes_on_anchors"
    );
  });

  it("does not shadow the withheld reasons when notes WERE considered", () => {
    const withheld = coverage({
      anchors: {
        modules: { requested: 1, resolved: 1 },
        symbols: { requested: 0, resolved: 0 },
        unreadable: 0,
      },
      notes: { considered: 5, admitted: 0, surfaced: 0 },
    });
    expect(preEditCoverageEmptyReason(withheld)).toBe("withheld_no_crew_chat");
  });
});
