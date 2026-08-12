import { describe, expect, it } from "vitest";
import {
  renderMemorySlice,
  renderStandingMemory,
  selectMemorySliceNotes,
  selectStandingNotes,
  withMemorySlice,
  withStandingMemory,
} from "../src/memory-slice.js";

type Note = {
  id: string;
  kind: string;
  text: string;
  confirmed: boolean;
  stale: boolean;
  confirmedBy?: "human" | "orchestrator" | null;
  status?: "active" | "paused" | "rejected";
};

const note = (over: Partial<Note>): Note => ({
  id: "mem-x",
  kind: "decision",
  text: "a note",
  confirmed: true,
  stale: false,
  ...over,
});

describe("memory slice selection (KG-2 reinforcement producer)", () => {
  it("selects vouched notes, demotes stale (D9-ii), caps at k", () => {
    const notes = [
      note({ id: "a", confirmed: true, stale: false }),
      note({ id: "b", confirmed: false, stale: false }), // unconfirmed → dropped
      note({ id: "c", confirmed: true, stale: true }), // stale → demoted, not dropped
      note({ id: "d", confirmed: true, stale: false }),
      note({ id: "e", confirmed: true, stale: false }),
    ];
    const surfaced = selectMemorySliceNotes(notes, 2);
    // Fresh vouched fill k first; stale never crowds them out.
    expect(surfaced.map((n) => n.id)).toEqual(["a", "d"]);
    // With room, a stale vouched note appears after fresh ones.
    expect(selectMemorySliceNotes(notes, 5).map((n) => n.id)).toEqual([
      "a",
      "d",
      "e",
      "c",
    ]);
  });

  it("preserves the concrete note type so ids reach the used-signal producer", () => {
    const surfaced = selectMemorySliceNotes([note({ id: "keep" })], 5);
    expect(surfaced[0]!.id).toBe("keep"); // id survives the generic selector
  });

  it("the selector is the SAME set the brief actually renders (no drift)", () => {
    const notes = [
      note({ id: "in", text: "surfaced", confirmed: true, stale: false }),
      note({ id: "out", text: "dropped", confirmed: false, stale: false }),
    ];
    const surfaced = selectMemorySliceNotes(notes, 5);
    const brief = withMemorySlice("do the work", notes, 5);
    // Every surfaced note's text is in the rendered brief; dropped ones are not.
    for (const n of surfaced) {
      expect(brief).toContain(n.text);
    }
    expect(brief).not.toContain("dropped");
    // And render agrees the surfaced set is non-empty here.
    expect(renderMemorySlice(notes, 5)).toContain("surfaced");
  });

  it("surfaces nothing when no note is vouched → no used-signal", () => {
    const notes = [
      note({ id: "u", confirmed: false, stale: false }),
      note({ id: "s", confirmed: false, stale: true }),
    ];
    expect(selectMemorySliceNotes(notes, 5)).toEqual([]);
    expect(renderMemorySlice(notes, 5)).toBe("");
  });

  it("never puts paused or rejected memory into a slice or standing canon", () => {
    const states = ["paused", "rejected"] as const;
    for (const status of states) {
      const human = note({
        id: `human-${status}`,
        kind: "constraint",
        confirmed: true,
        status,
      });
      const vouched = note({
        id: `vouched-${status}`,
        confirmed: false,
        confirmedBy: "orchestrator",
        status,
      });
      expect(selectMemorySliceNotes([human, vouched], 5)).toEqual([]);
      expect(selectStandingNotes([human]).selected).toEqual([]);
    }
  });

  it("D9-ii: a stale vouched note is labelled, not dropped from the brief", () => {
    const notes = [note({ id: "s", text: "old rule", confirmed: true, stale: true })];
    expect(selectMemorySliceNotes(notes, 5).map((n) => n.id)).toEqual(["s"]);
    const rendered = renderMemorySlice(notes, 5);
    expect(rendered).toContain("[decision|STALE]");
    expect(rendered).toContain("old rule");
    expect(rendered).toContain("|STALE and demoted");
  });

  // F14b — the heading is read BY THE AGENT, so it is a provenance claim. It
  // said "confirmed" while the filter below it admits orchestrator-vouched
  // notes, i.e. it told every worker a person had signed off on facts no person
  // had seen — the same lie in the model's context that keeping `confirmed`
  // human-only prevents in the ledger.
  it("names BOTH tiers in the heading it renders over them", () => {
    const slice = renderMemorySlice(
      [note({ id: "v", confirmed: false, confirmedBy: "orchestrator" })],
      5
    );
    expect(slice).toContain("vouched by MUON");
    // It must not claim a human confirmed a note the orchestrator vouched for.
    expect(slice).not.toMatch(/^Shared memory \(confirmed, current/);
  });
});

// ── ADR-0026 §9 — the preamble states its PARTITION ──────────────────────────
//
// The heading is READ BY THE AGENT, so it is a claim — and after ADR-0026 it is a
// SCOPE claim as well as a provenance one. An agent that believes the brain is
// global will read "nothing here about repo B" as "nothing was ever learned about
// repo B" and may confidently re-derive a decision that already exists.
describe("ADR-0026: the memory slice says WHICH repository it is", () => {
  const notes = [note({ id: "a", text: "Charges are idempotent by request key" })];

  it("names the workspace in the heading when the job has one", () => {
    const rendered = renderMemorySlice(notes, 5, {
      workspacePath: "/Users/dev/SWE/repo-a",
    });
    expect(rendered).toContain("scoped to /Users/dev/SWE/repo-a");
    // The provenance half of the claim is untouched.
    expect(rendered).toContain("confirmed by a human or vouched by MUON");
  });

  it("is byte-for-byte the old heading when there is no workspace", () => {
    // §5 monotonicity, at the preamble: a job with no bound workspace writes its
    // notes to the §8 residue and gets today's brief exactly.
    expect(renderMemorySlice(notes, 5)).toBe(
      renderMemorySlice(notes, 5, { workspacePath: null })
    );
    expect(renderMemorySlice(notes, 5)).not.toContain("scoped to");
  });

  it("threads through withMemorySlice, which is what the runner actually calls", () => {
    const brief = "Fix the failing charge test.";
    const full = withMemorySlice(brief, notes, 5, {
      workspacePath: "/Users/dev/SWE/repo-a",
    });
    expect(full).toContain("scoped to /Users/dev/SWE/repo-a");
    expect(full.endsWith(brief)).toBe(true);
  });

  it("adds nothing when the slice is empty, workspace or not", () => {
    // No vouched notes → no slice → no heading, so an empty brain never grows a
    // "Shared memory (…scoped to …):" header with nothing under it.
    const unvouched = [note({ id: "u", confirmed: false })];
    expect(
      renderMemorySlice(unvouched, 5, { workspacePath: "/Users/dev/SWE/repo-a" })
    ).toBe("");
  });
});

// ── TODO 4.1 + 4.3: the standing arm, budgeted in characters ────────────────

describe("selectStandingNotes — the char budget (4.3)", () => {
  const standing = (over: Partial<Note>): Note =>
    note({ kind: "constraint", ...over });

  it("re-applies the posture: policy kinds plus explicitly pinned decisions only", () => {
    const notes = [
      standing({ id: "in-constraint" }),
      note({ id: "in-convention", kind: "convention" }),
      { ...note({ id: "in-decision", kind: "decision" }), pinned: true },
      note({ id: "out-unpinned-decision", kind: "decision" }),
      standing({ id: "out-unconfirmed", confirmed: false }),
      {
        ...note({ id: "out-unconfirmed-decision", kind: "decision", confirmed: false }),
        pinned: true,
      },
      standing({ id: "out-stale", stale: true }),
    ];
    const { selected, omitted } = selectStandingNotes(notes);
    expect(selected.map((n) => n.id)).toEqual([
      "in-constraint",
      "in-convention",
      "in-decision",
    ]);
    expect(omitted).toBe(0);
  });

  it("HUMAN-confirmed only — an orchestrator vouch is NOT standing canon (4.1's boundary)", () => {
    const vouched = {
      ...standing({ id: "vouched", confirmed: false }),
      confirmedBy: "orchestrator" as const,
    };
    // The slice arm would admit this (vouchedForCrew); the standing arm must not.
    expect(selectMemorySliceNotes([vouched], 5)).toHaveLength(1);
    expect(selectStandingNotes([vouched]).selected).toHaveLength(0);
  });

  it("budgets in CHARACTERS: a long note that would burst the budget is skipped whole, and the omission is counted", () => {
    const notes = [
      standing({ id: "short-1", text: "a".repeat(100) }),
      standing({ id: "long", text: "b".repeat(10_000) }), // bursts any default budget
      standing({ id: "short-2", text: "c".repeat(100) }),
    ];
    const { selected, omitted } = selectStandingNotes(notes, 400);
    // The long note is skipped WHOLE (half a constraint is not a constraint),
    // and the later short note still fits — the budget is chars, not a prefix.
    expect(selected.map((n) => n.id)).toEqual(["short-1", "short-2"]);
    expect(omitted).toBe(1);
  });

  it("caps the COUNT too, so a corpus of one-liners cannot become a wall of bullets", () => {
    const notes = Array.from({ length: 40 }, (_, i) =>
      standing({ id: `n${i}`, text: `rule ${i}` })
    );
    const { selected, omitted } = selectStandingNotes(notes, 100_000);
    expect(selected).toHaveLength(16);
    expect(omitted).toBe(24);
  });
});

describe("renderStandingMemory / withStandingMemory", () => {
  const canon = [
    note({ id: "c1", kind: "constraint", text: "Never custody vendor tokens" }),
    note({ id: "c2", kind: "convention", text: "State the fix, not just the failure" }),
    {
      ...note({ id: "c3", kind: "decision", text: "Use flat memory retrieval" }),
      pinned: true,
    },
  ];

  it("renders the canon under a heading that states provenance and scope", () => {
    const section = renderStandingMemory(canon, {
      scope: { workspacePath: "/Users/dev/SWE/repo-a" },
    });
    expect(section).toContain("Standing workspace memory");
    expect(section).toContain("human-confirmed");
    expect(section).toContain("for /Users/dev/SWE/repo-a");
    expect(section).toContain("- [constraint] Never custody vendor tokens");
    expect(section).toContain("- [convention] State the fix, not just the failure");
    expect(section).toContain("- [decision] Use flat memory retrieval");
    // No truncation → no truncation claim.
    expect(section).not.toContain("did not fit");
  });

  it("SAYS it truncated — a silently-shortened canon reads as the whole canon", () => {
    const many = [
      ...canon,
      note({ id: "big", kind: "constraint", text: "x".repeat(10_000) }),
    ];
    const section = renderStandingMemory(many, { budgetChars: 200 });
    expect(section).toContain("1 more standing note(s)");
    expect(section).toContain("did not fit");
  });

  it("prepends to the brief, and an empty canon leaves the brief byte-identical", () => {
    expect(withStandingMemory("do the task", canon)).toMatch(
      /^Standing workspace memory[\s\S]*do the task$/
    );
    expect(withStandingMemory("do the task", [])).toBe("do the task");
    expect(
      withStandingMemory("do the task", [note({ id: "u", confirmed: false })])
    ).toBe("do the task");
  });
});
