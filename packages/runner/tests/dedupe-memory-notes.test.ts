import { describe, expect, it } from "vitest";
import { dedupeMemoryNotes } from "../src/execute.js";

// ── TODO 4.2: the brief slice dedups by CONTENT, not just id ─────────────────
//
// The regression: `dedupeMemoryNotes` keyed on `note.id`, so the same fact under
// two ids — a clone, or identical text learned in two chats and fused from
// taskNotes + objectiveNotes — repeated verbatim in one slice, spending two of
// the slice's `k` lines on one statement.

type Note = { id: string; text: string; confirmed?: boolean };

describe("dedupeMemoryNotes", () => {
  it("drops an exact id repeat (the original behaviour, preserved)", () => {
    const notes: Note[] = [
      { id: "a", text: "prefer RRF over additive scoring" },
      { id: "a", text: "prefer RRF over additive scoring" },
    ];
    expect(dedupeMemoryNotes(notes).map((n) => n.id)).toEqual(["a"]);
  });

  it("collapses the SAME text under different ids to one slice line", () => {
    const notes: Note[] = [
      { id: "chat1", text: "Rank fused memory with RRF, not additive scoring." },
      { id: "chat2", text: "Rank fused memory with RRF, not additive scoring." },
    ];
    const out = dedupeMemoryNotes(notes);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("chat1"); // first occurrence holds the slot
  });

  it("normalizes whitespace and case before comparing (the ranking match rule)", () => {
    const notes: Note[] = [
      { id: "a", text: "Prefer RRF over additive scoring" },
      { id: "b", text: "  prefer   rrf over ADDITIVE scoring  " },
    ];
    expect(dedupeMemoryNotes(notes)).toHaveLength(1);
  });

  it("does NOT collapse genuinely different statements", () => {
    const notes: Note[] = [
      { id: "a", text: "prefer RRF over additive scoring" },
      { id: "b", text: "the embedder is loopback-only" },
    ];
    expect(dedupeMemoryNotes(notes).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("a confirmed note UPGRADES an unconfirmed twin, keeping the earlier slot", () => {
    const notes: Note[] = [
      { id: "unconf", text: "constraint: never custody vendor tokens", confirmed: false },
      { id: "conf", text: "constraint: never custody vendor tokens", confirmed: true },
    ];
    const out = dedupeMemoryNotes(notes);
    expect(out).toHaveLength(1);
    // The confirmed representative wins, at the FIRST position.
    expect(out[0].id).toBe("conf");
  });

  it("an unconfirmed clone NEVER demotes a confirmed representative", () => {
    const notes: Note[] = [
      { id: "conf", text: "constraint: never custody vendor tokens", confirmed: true },
      { id: "unconf", text: "constraint: never custody vendor tokens", confirmed: false },
    ];
    const out = dedupeMemoryNotes(notes);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("conf");
  });

  it("preserves fusion order for distinct notes and is stable", () => {
    const notes: Note[] = [
      { id: "task1", text: "alpha" },
      { id: "task2", text: "beta" },
      { id: "obj1", text: "alpha" }, // dup of task1 by content
      { id: "obj2", text: "gamma" },
    ];
    expect(dedupeMemoryNotes(notes).map((n) => n.id)).toEqual([
      "task1",
      "task2",
      "obj2",
    ]);
  });

  it("is a no-op on an empty list", () => {
    expect(dedupeMemoryNotes([])).toEqual([]);
  });
});
