import { describe, expect, it } from "vitest";
import {
  coordinationPartitionReady,
  coordinationUnscoped,
  dispatchJobPartitionWhere,
} from "../src/lib/coordination-partition.js";

/**
 * OMISSION IS NOT PERMISSION.
 *
 * Both functions here used to treat an ABSENT partition as "scan everything":
 * `coordinationPartitionReady(undefined)` returned `true`, and
 * `dispatchJobPartitionWhere(undefined)` returned `{}` — no predicate at all.
 * The reason was written down honestly in the source: "legacy callers that omit
 * `partition` keep prior behaviour (tests)". That is production safety weakened
 * for test convenience, and it is the shape ADR-0022 rule 2 exists for — a rule
 * a new caller opts out of by not knowing it exists.
 *
 * Nothing in production changed when this flipped: every route caller already
 * passes a partition. What changed is what the NEXT caller inherits, and what
 * the sixteen tests that relied on the old default were really exercising —
 * an unfenced machine-wide read no route performs.
 */

describe("an omitted partition is fail-CLOSED", () => {
  it("is not ready", () => {
    expect(coordinationPartitionReady(undefined)).toBe(false);
    expect(coordinationPartitionReady(null)).toBe(false);
  });

  it("and its query matches nothing, rather than everything", () => {
    // Defence in depth: a future caller that builds a query WITHOUT checking
    // the gate first gets an empty result, not every workspace on the machine.
    expect(dispatchJobPartitionWhere(undefined)).toEqual({ id: { in: [] } });
    expect(dispatchJobPartitionWhere(null)).toEqual({ id: { in: [] } });
  });

  it("the unsatisfiable predicate cannot be satisfied by a row", () => {
    // `id` is a cuid and never empty, so `{ id: { in: [] } }` is unsatisfiable
    // by construction — not by a sentinel value someone could insert.
    const where = dispatchJobPartitionWhere(undefined) as {
      id: { in: string[] };
    };
    expect(where.id.in).toEqual([]);
  });
});

describe("a partition without a workspace is also fail-closed", () => {
  it("an empty object is not ready", () => {
    expect(coordinationPartitionReady({})).toBe(false);
  });

  it("a chat alone is not enough — the workspace is the fence", () => {
    // ADR-0026: memory is scoped to a WORKSPACE. A chat id narrows within one;
    // it cannot substitute for one, or two repos with the same relative paths
    // would collide.
    expect(coordinationPartitionReady({ chatId: "chat-a" })).toBe(false);
  });

  it("a workspace alone is ready", () => {
    expect(coordinationPartitionReady({ workspacePath: "/repo" })).toBe(true);
  });
});

describe("the operator escape hatch stays explicit", () => {
  it("allowGlobal is ready with no workspace, and scans everything", () => {
    expect(coordinationPartitionReady({ allowGlobal: true })).toBe(true);
    expect(coordinationUnscoped({ allowGlobal: true })).toBe(true);
    expect(dispatchJobPartitionWhere({ allowGlobal: true })).toEqual({});
  });

  it("but is never implied by an absent partition", () => {
    // The distinction that matters: "the operator asked to see everything" and
    // "nobody said" must not be the same state.
    expect(coordinationUnscoped(undefined)).toBe(false);
    expect(coordinationPartitionReady(undefined)).toBe(false);
  });
});

describe("a supplied partition becomes the query", () => {
  it("carries workspace and chat into the predicate", () => {
    expect(
      dispatchJobPartitionWhere({ workspacePath: "/repo", chatId: "chat-a" })
    ).toEqual({ workspacePath: "/repo", chatId: "chat-a" });
  });

  it("omits a coordinate that was not given, rather than inventing one", () => {
    expect(dispatchJobPartitionWhere({ workspacePath: "/repo" })).toEqual({
      workspacePath: "/repo",
    });
  });
});
