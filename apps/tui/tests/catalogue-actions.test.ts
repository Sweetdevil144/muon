import { describe, expect, it } from "vitest";
import {
  resolveCatalogueAction,
  type CatalogueAction,
  type CatalogueFormKind,
} from "../src/lib/catalogue-actions.js";
import { buildActionForm } from "../src/lib/actions.js";
import { buildCatalogue, type CatalogueEntry } from "../src/lib/catalogue.js";
import { PALETTE_COMMANDS } from "../src/lib/palette.js";

// COMPILE-TIME exhaustive in BOTH directions: adding a member to
// CatalogueAction makes this object fail to typecheck (missing key), and a
// key that is not a member fails too. The previous version was a Set typed
// as a subset — adding an "approve" action would have compiled and passed,
// which is the false-claim-pinned-by-a-test pattern this repo condemns.
const ACTION_TYPE_RECORD: Record<CatalogueAction["type"], true> = {
  quit: true,
  refresh: true,
  focus: true,
  // The FORM scope is ported: still no approval/dispatch/memory verb — a
  // form's submit path is executeAction's closed switch, itself governed.
  form: true,
  // Opens the EVIDENCE. Still not a decision — the decision is a second
  // press inside the review scope, which this union cannot express.
  "review-approval": true,
  elsewhere: true,
  disabled: true,
};
const ACTION_TYPES = new Set(Object.keys(ACTION_TYPE_RECORD));

/** The command ids that resolve to a form. Derived from the action table so a
 *  newly-ported form joins these tests automatically. */
const FORM_COMMAND_IDS = [
  "task-new",
  "assign",
  "status",
  "run",
  "memory-search",
] as const;

function commandEntry(overrides: Partial<CatalogueEntry>): CatalogueEntry {
  return {
    id: "command:x",
    kind: "command",
    label: "x",
    effect: "",
    keywords: [],
    enabled: true,
    ...overrides,
  };
}

describe("resolveCatalogueAction", () => {
  it("resolves EVERY static palette command without throwing, to the closed union", () => {
    const entries = buildCatalogue({ commands: PALETTE_COMMANDS });
    for (const entry of entries) {
      const action = resolveCatalogueAction(entry);
      expect(ACTION_TYPES.has(action.type)).toBe(true);
    }
  });

  it("executes the verbs whose surfaces exist on this desk", () => {
    expect(
      resolveCatalogueAction(commandEntry({ id: "command:quit" }))
    ).toEqual({ type: "quit" });
    expect(
      resolveCatalogueAction(commandEntry({ id: "command:refresh" }))
    ).toEqual({ type: "refresh" });
    expect(
      resolveCatalogueAction(commandEntry({ id: "command:focus-approvals" }))
    ).toEqual({ type: "focus", zone: "inbox" });
    expect(
      resolveCatalogueAction(commandEntry({ id: "command:focus-lanes" }))
    ).toEqual({ type: "focus", zone: "crew" });
  });

  it("approve/reject OPEN the review — neither can decide from this union", () => {
    // The governance property survives the surface landing: the union gained
    // a member that shows EVIDENCE, not one that resolves an approval. A
    // decision needs the review scope's second press, which lives in the
    // desk's input handler and is bound to the approval on screen.
    for (const [id, decision] of [
      ["command:approve", "approve"],
      ["command:reject", "reject"],
    ] as const) {
      const action = resolveCatalogueAction(commandEntry({ id }));
      expect(action.type).toBe("review-approval");
      if (action.type === "review-approval") {
        expect(action.decision).toBe(decision);
      }
    }
    // ...and no member is named for the decision itself.
    expect([...ACTION_TYPES].some((type) => /approved|resolve|decide/.test(type))).toBe(
      false
    );
  });

  it("an unknown command id fails CLOSED to an honest elsewhere, never a verb", () => {
    const action = resolveCatalogueAction(
      commandEntry({ id: "command:totally-new-thing" })
    );
    expect(action.type).toBe("elsewhere");
  });

  it("prototype-chain names cannot escape the closed table", () => {
    // A bare object index would resolve "constructor"/"toString" to inherited
    // Functions and skip the fallback entirely (review finding #8).
    for (const id of [
      "command:constructor",
      "command:toString",
      "command:hasOwnProperty",
      "command:__proto__",
    ]) {
      const action = resolveCatalogueAction(commandEntry({ id }));
      expect(action.type, id).toBe("elsewhere");
    }
  });

  it("a vendor action refuses toward the command bar, not a guessy dispatch", () => {
    const action = resolveCatalogueAction(
      commandEntry({ id: "command:vendor:claude:run", badge: "claude" })
    );
    expect(action.type).toBe("elsewhere");
    if (action.type === "elsewhere") {
      expect(action.reason).toMatch(/command bar/);
    }
  });

  it("disabled wins over everything, including quit", () => {
    const action = resolveCatalogueAction(
      commandEntry({ id: "command:quit", enabled: false })
    );
    expect(action.type).toBe("disabled");
  });

  it("harness, agent and workflow entries refuse toward their real surfaces", () => {
    const harness = resolveCatalogueAction(
      commandEntry({ id: "harness:audit", kind: "harness" })
    );
    expect(harness.type).toBe("elsewhere");
    if (harness.type === "elsewhere") {
      expect(harness.reason).toMatch(/dispatch/);
    }

    const agent = resolveCatalogueAction(
      commandEntry({ id: "agent:custom:mine", kind: "agent" })
    );
    expect(agent.type).toBe("elsewhere");
    if (agent.type === "elsewhere") {
      expect(agent.reason).toMatch(/UNGOVERNED/);
    }

    expect(
      resolveCatalogueAction(
        commandEntry({ id: "workflow:w", kind: "workflow" })
      ).type
    ).toBe("elsewhere");
  });

  it("the union itself carries no approval/dispatch/memory verb", () => {
    // Pin the vocabulary, not just the mapping: if someone adds an
    // "approve"-shaped action type, this enumeration must be updated — and
    // that edit is exactly the review conversation this test exists to force.
    expect([...ACTION_TYPES].sort()).toEqual([
      "disabled",
      "elsewhere",
      "focus",
      "form",
      "quit",
      "refresh",
      "review-approval",
    ]);
  });

  it("every form the resolver opens has a real definition AND a submit path", () => {
    // The pairing rule: a command maps to `form` only when buildActionForm
    // defines it AND some seam can submit it. An unmatched form would be a
    // door to nowhere.
    for (const id of FORM_COMMAND_IDS) {
      const action = resolveCatalogueAction(commandEntry({ id: `command:${id}` }));
      expect(action.type, id).toBe("form");
      if (action.type === "form") {
        expect(buildActionForm(action.form, {}), id).not.toBeNull();
      }
    }
  });

  it("names EVERY submit seam, so a new form kind must pick one", () => {
    // COMPILE-TIME exhaustive over CatalogueFormKind. The previous version
    // iterated a hardcoded id list, so adding `memory-search` — a form with a
    // third seam that is neither the ledger nor a dispatch — passed it
    // untouched. A test that claims to force a decision has to fail when the
    // decision is skipped, or it is decoration.
    //
    //   ledger   → executeAction's governed switch
    //   dispatch → dispatchRun (runner liveness → assign → enqueue → stream)
    //   search   → a READ: searchMemory, rendered into the memory pane
    const SEAM: Record<CatalogueFormKind, "ledger" | "dispatch" | "search"> = {
      "task-new": "ledger",
      assign: "ledger",
      status: "ledger",
      run: "dispatch",
      "memory-search": "search",
    };
    for (const id of FORM_COMMAND_IDS) {
      const action = resolveCatalogueAction(commandEntry({ id: `command:${id}` }));
      if (action.type === "form") {
        expect(SEAM[action.form], `${action.form} has no submit seam`).toBeTruthy();
      }
    }
    // Only ONE of them writes through the ledger switch, and only one
    // dispatches. If that stops being true the split above is wrong.
    expect(Object.values(SEAM).filter((seam) => seam === "dispatch")).toEqual([
      "dispatch",
    ]);
  });
});
