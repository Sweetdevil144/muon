import { describe, expect, it } from "vitest";
import {
  dispatchableIds,
  keyToken,
  resolveKeyAction,
  type KeyScope,
} from "../src/lib/key-dispatch.js";
import { KEYMAP } from "../src/lib/keymap.js";

// ADR-0042 D2. The bug this architecture removes, in the founder's words:
// "pressing tab for cycling stops working when we press /". It did, because
// every input mode in App.tsx's cascade returned without checking Tab, and the
// single tab handler sat unreachable below all of them.
//
// The fix is not "remember to check Tab in each mode" — that is the same bug
// waiting for the next mode. It is that falling through to a parent scope is
// the DEFAULT, so a mode cannot swallow a key it never named.

const MODAL: KeyScope[] = ["command-bar", "palette", "help"];

describe("the Tab-after-/ class cannot recur", () => {
  it("cycles panes from every modal scope, not just the cockpit", () => {
    for (const scope of ["cockpit", ...MODAL] as KeyScope[]) {
      expect(
        resolveKeyAction(scope, { tab: true }, "")?.id,
        scope
      ).toBe("cycle-zone");
    }
  });

  it("cycles backwards on shift+tab from every modal scope too", () => {
    for (const scope of ["cockpit", ...MODAL] as KeyScope[]) {
      expect(
        resolveKeyAction(scope, { tab: true, shift: true }, "")?.id,
        scope
      ).toBe("cycle-zone");
    }
  });
});

describe("inheritance is POSITIVE — a text field keeps its letters", () => {
  it("does not fire cockpit letter bindings inside the command bar", () => {
    // `j` moves down on the desk. In a text field it is the letter j, and a
    // scope chain that inherited everything would eat it. This is why the
    // inherited set is a list of ids rather than a list of exclusions.
    expect(resolveKeyAction("cockpit", {}, "j")?.id).toBe("move-down");
    for (const scope of MODAL) {
      expect(resolveKeyAction(scope, {}, "j"), scope).toBeNull();
    }
  });

  it("does not fire `/` or `?` inside a text field", () => {
    for (const scope of MODAL) {
      expect(resolveKeyAction(scope, {}, "/"), scope).toBeNull();
      expect(resolveKeyAction(scope, {}, "?"), scope).toBeNull();
    }
  });

  it("inherits nothing at all into a form field", () => {
    // A form takes free text in every field; even Tab belongs to it (it moves
    // between fields), so `form` inherits nothing.
    expect(resolveKeyAction("form", { tab: true }, "")).toBeNull();
  });
});

describe("zone-scoped bindings only fire in their zone", () => {
  it("keeps `r` as reject in approvals and nowhere else", () => {
    const inApprovals = resolveKeyAction("cockpit", {}, "r", "approvals");
    expect(inApprovals?.id).toBe("reject");
    // The table has recorded this scoping all along; nothing enforced it.
    expect(resolveKeyAction("cockpit", {}, "r", "lanes")?.id).not.toBe("reject");
  });
});

describe("key tokens", () => {
  it("spells the modified keys the table uses", () => {
    expect(keyToken({ tab: true }, "")).toBe("tab");
    expect(keyToken({ tab: true, shift: true }, "")).toBe("shift+tab");
    expect(keyToken({ ctrl: true }, "k")).toBe("ctrl+k");
    expect(keyToken({ upArrow: true }, "")).toBe("↑");
    expect(keyToken({}, "j")).toBe("j");
  });

  it("resolves any digit to the shared tab-ordinal entry", () => {
    // Declared as ["1", "…", "9"] — the ellipsis is display. A literal match
    // would have bound 1 and 9 and silently missed 2 through 8.
    for (const digit of ["1", "4", "9"]) {
      expect(resolveKeyAction("cockpit", {}, digit)?.id, digit).toBe(
        "tab-ordinal"
      );
    }
  });
});

describe("the table is the source, not a second description", () => {
  it("resolves EVERY cockpit binding to its own id", () => {
    // The property `keymap.ts` claimed and did not have: if an entry cannot be
    // resolved from the table, the table is documentation rather than
    // dispatch, which is how the Tab bug survived being "documented".
    const unreachable: string[] = [];
    for (const entry of KEYMAP) {
      if (entry.owner !== "cockpit") continue;
      const hit = entry.keys.some((spelling) => {
        if (spelling === "…") return false;
        const key = {
          tab: spelling === "tab" || spelling === "shift+tab",
          shift: spelling === "shift+tab",
          ctrl: spelling.startsWith("ctrl+"),
          upArrow: spelling === "↑",
          downArrow: spelling === "↓",
          escape: spelling === "esc",
          return: spelling === "enter",
        };
        // Any single printable character is the input, punctuation included —
        // `]`, `[` and `!` are real bindings and an alphanumeric-only guard
        // reported them unreachable when they were fine.
        const input = spelling.startsWith("ctrl+")
          ? spelling.slice(5)
          : spelling.length === 1
            ? spelling
            : "";
        return (
          resolveKeyAction("cockpit", key, input, entry.zone)?.id === entry.id
        );
      });
      if (!hit) unreachable.push(entry.id);
    }
    expect(unreachable).toEqual([]);
  });

  it("dispatchableIds covers every cockpit entry and no panel entry", () => {
    const ids = dispatchableIds();
    expect(ids.length).toBe(
      KEYMAP.filter((entry) => entry.owner === "cockpit").length
    );
    for (const entry of KEYMAP) {
      if (entry.owner === "panel") expect(ids).not.toContain(entry.id);
    }
  });
});
