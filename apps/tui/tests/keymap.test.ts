import { describe, expect, it } from "vitest";
import {
  cockpitBindings,
  filterKeymap,
  formatKeys,
  KEYMAP,
  KEYMAP_GROUP_LABEL,
  KEYMAP_GROUP_ORDER,
  keymapByGroup,
  renderKeymapMarkdown,
  type KeymapEntry,
} from "../src/lib/keymap.js";

// ADR-0032 D6. These tests are the drift-lock: the table must stay complete,
// unambiguous, and in sync with what the cockpit actually dispatches.

describe("table integrity", () => {
  it("has a unique id per entry", () => {
    const ids = KEYMAP.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every entry keys and a real description", () => {
    for (const entry of KEYMAP) {
      expect(entry.keys.length, entry.id).toBeGreaterThan(0);
      // Guards against an empty or untrimmed description, not against
      // terseness: "quit" is the right description for `q`, and any length
      // floor here just invites padded prose.
      expect(entry.description.trim(), entry.id).toBe(entry.description);
      expect(entry.description, entry.id).not.toBe("");
    }
  });

  it("places every entry in a known, rendered group", () => {
    for (const entry of KEYMAP) {
      expect(KEYMAP_GROUP_ORDER, entry.id).toContain(entry.group);
      expect(KEYMAP_GROUP_LABEL[entry.group]).toBeTruthy();
    }
  });

  it("marks panel-owned entries with the panel that dispatches them", () => {
    // The honesty marker: a binding this table does not dispatch must say who
    // does, so "declared but not wired" can never look like "wired".
    for (const entry of KEYMAP.filter((e) => e.owner === "panel")) {
      expect(entry.panel, entry.id).toBeTruthy();
    }
  });

  it("never claims a zone for a panel-owned entry", () => {
    for (const entry of KEYMAP.filter((e) => e.owner === "panel")) {
      expect(entry.zone, entry.id).toBeUndefined();
    }
  });
});

describe("no ambiguous cockpit bindings", () => {
  it("never binds the same key twice in the same scope", () => {
    // This is the defect the table exists to prevent: `r` meaning reject in one
    // context and refresh in three others, with nothing able to notice.
    const seen = new Map<string, string>();
    for (const entry of cockpitBindings()) {
      for (const key of entry.keys) {
        const scope = `${entry.zone ?? "*"}:${key}`;
        const previous = seen.get(scope);
        expect(
          previous,
          `${key} in ${entry.zone ?? "global"} is bound by both ${previous} and ${entry.id}`
        ).toBeUndefined();
        seen.set(scope, entry.id);
      }
    }
  });

  it("allows the same key in different zones, which is the point of zones", () => {
    const enterEntries = cockpitBindings().filter((e) =>
      e.keys.includes("enter")
    );
    expect(enterEntries.length).toBeGreaterThan(1);
    expect(new Set(enterEntries.map((e) => e.zone)).size).toBe(
      enterEntries.length
    );
  });
});

describe("the decide group keeps its safety properties", () => {
  it("documents approve/reject as two-press, evidence first", () => {
    const approve = KEYMAP.find((e) => e.id === "approve");
    const reject = KEYMAP.find((e) => e.id === "reject");
    expect(approve?.description).toMatch(/evidence/i);
    expect(reject?.description).toMatch(/evidence/i);
  });

  it("scopes every cockpit decide binding to the approvals zone", () => {
    // A decision key that fires from any focus is how the wrong thing gets
    // approved.
    for (const entry of KEYMAP.filter(
      (e) => e.group === "decide" && e.owner === "cockpit"
    )) {
      expect(entry.zone, entry.id).toBe("approvals");
    }
  });

  it("keeps REVIEW BLIND attestation on the evidence panel, not the rail", () => {
    const attest = KEYMAP.find((e) => e.id === "attest-review-blind");
    expect(attest?.owner).toBe("panel");
    expect(attest?.description).toMatch(/merge/i);
  });
});

describe("help rendering", () => {
  it("groups in declared order and drops empty groups", () => {
    const groups = keymapByGroup().map((s) => s.group);
    expect(groups).toEqual(
      KEYMAP_GROUP_ORDER.filter((g) => KEYMAP.some((e) => e.group === g))
    );
  });

  it("shows every entry exactly once across all groups", () => {
    const rendered = keymapByGroup().flatMap((s) => s.entries);
    expect(rendered).toHaveLength(KEYMAP.length);
    expect(new Set(rendered.map((e) => e.id)).size).toBe(KEYMAP.length);
  });

  it("filters by key, description and group", () => {
    expect(filterKeymap("tab").length).toBeGreaterThan(0);
    expect(filterKeymap("approve").map((e) => e.id)).toContain("approve");
    expect(filterKeymap("tabs").map((e) => e.id)).toContain("tab-next");
    expect(filterKeymap("")).toHaveLength(KEYMAP.length);
    expect(filterKeymap("zzzznope")).toHaveLength(0);
  });

  it("formats multi-key entries readably", () => {
    const ordinal = KEYMAP.find((e) => e.id === "tab-ordinal")!;
    expect(formatKeys(ordinal)).toBe("1 … 9");
  });
});

describe("generated README table", () => {
  it("renders every entry, with scope where it applies", () => {
    const markdown = renderKeymapMarkdown();
    for (const entry of KEYMAP) {
      expect(markdown, entry.id).toContain(entry.description);
    }
    expect(markdown).toContain("_(approvals)_");
    expect(markdown).toContain("### Tabs");
  });

  it("emits one table row per entry", () => {
    const rows = renderKeymapMarkdown()
      .split("\n")
      .filter((line) => line.startsWith("| `"));
    expect(rows).toHaveLength(KEYMAP.length);
  });
});

describe("coverage of what the desk promises", () => {
  const ids = new Set(KEYMAP.map((e: KeymapEntry) => e.id));

  it("binds the tab model ADR-0032 D2 requires", () => {
    for (const id of ["tab-ordinal", "tab-next", "tab-prev", "tab-close"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("binds the attention jump the rail promises", () => {
    expect(ids).toContain("needs-you");
  });

  it("binds a discoverable help key", () => {
    expect(ids).toContain("help");
  });
});
