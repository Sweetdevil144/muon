import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-0061 — the route-side withheld classifier, unit-pinned.
 *
 * The whole risk is disclosing the WRONG thing, so the pins are the silence
 * rules first: fence-class candidates (agent tier, unvouched) never stub,
 * dead lifecycle rows never stub, caller-filtered rows never stub — and an
 * unreadable ledger yields NOTHING (applyMemoryExpiry's neutral rows carry
 * no `live` verdict, and no verdict must mean no claim, never an
 * accusation). Then the disclosures: ledger-expired stubs win over the
 * graph's own reason, paused stubs, stale stubs, and the cap count.
 */

const ledgerMock = vi.hoisted(() => ({
  applyMemoryExpiry: vi.fn(),
}));
vi.mock("../src/lib/memory-ledger.js", () => ({
  applyMemoryExpiry: ledgerMock.applyMemoryExpiry,
}));
const dbMock = vi.hoisted(() => ({
  prisma: {
    memoryNote: { findMany: vi.fn() },
  },
}));
vi.mock("../src/lib/db.js", () => dbMock);

import {
  classifyWithheldDisclosure,
  withheldResponseFields,
} from "../src/lib/memory-withheld.js";

type Reason = "cap" | "stale" | "expired" | "paused";

function candidate(
  id: string,
  reason: Reason,
  patch: Record<string, unknown> = {}
) {
  return {
    note: {
      id,
      kind: "decision",
      status: "active",
      confirmed: true,
      chatId: "chat-a",
      scope: "project",
      ...patch,
    },
    reason,
  };
}

/** Ledger truth: live + human-confirmed unless the test says otherwise. */
function annotate(
  overrides: Record<string, Partial<Record<string, unknown>>> = {}
) {
  ledgerMock.applyMemoryExpiry.mockImplementation(
    async (notes: { id: string }[]) =>
      notes.map((note) => ({
        ...note,
        live: true,
        expired: false,
        confirmedBy: "human",
        pinned: false,
        expiresAt: null,
        ...(overrides[note.id] ?? {}),
      }))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Canary default: the ledger holds a REAL row per pooled id, mirroring the
  // candidate's own status. Tests that need divergence override.
  dbMock.prisma.memoryNote.findMany.mockImplementation(
    async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({
        id,
        status: id.includes("paused") ? "paused" : "active",
      }))
  );
});

describe("classifyWithheldDisclosure", () => {
  it("counts cap, stubs stale/paused, and lets the LEDGER's expired verdict win over the graph's reason", async () => {
    annotate({ "mem-led-exp": { expired: true } });
    const result = await classifyWithheldDisclosure({
      candidates: [
        candidate("mem-cap-1", "cap"),
        candidate("mem-cap-2", "cap"),
        candidate("mem-stale", "stale"),
        candidate("mem-paused", "paused", { status: "paused" }),
        // The graph thought this was mere cap overflow; the ledger says
        // expired — the authority stubs it.
        candidate("mem-led-exp", "cap"),
      ],
      tier: "operator",
      crewVisible: false,
      showExpiredView: false,
    });
    expect(result.suppressedCount).toBe(2);
    expect(result.withheld).toEqual([
      { id: "mem-stale", kind: "decision", reason: "stale" },
      { id: "mem-paused", kind: "decision", reason: "paused" },
      { id: "mem-led-exp", kind: "decision", reason: "expired" },
    ]);
  });

  it("FENCE silence: an agent-tier candidate without a human confirm (and no crew admission) discloses nothing", async () => {
    annotate({ "mem-unvouched": { confirmedBy: null } });
    const result = await classifyWithheldDisclosure({
      candidates: [
        candidate("mem-unvouched", "paused", {
          status: "paused",
          confirmed: false,
        }),
      ],
      tier: "agent",
      chatId: "chat-a",
      crewVisible: false,
      showExpiredView: false,
    });
    expect(result).toEqual({ suppressedCount: 0, withheld: [] });
  });

  it("crew-visible admission mirrors the serve rule: a same-chat unvouched candidate MAY stub", async () => {
    annotate({ "mem-crew": { confirmedBy: null } });
    // The ledger row itself is paused (the canary default keys off the id;
    // this id doesn't, so state it explicitly — the LEDGER is what stubs).
    dbMock.prisma.memoryNote.findMany.mockResolvedValueOnce([
      { id: "mem-crew", status: "paused" },
    ]);
    const result = await classifyWithheldDisclosure({
      candidates: [
        candidate("mem-crew", "paused", { status: "paused", chatId: "chat-a" }),
      ],
      tier: "agent",
      chatId: "chat-a",
      crewVisible: true,
      showExpiredView: false,
    });
    expect(result.withheld).toEqual([
      { id: "mem-crew", kind: "decision", reason: "paused" },
    ]);
  });

  it("dead lifecycle rows and NO-VERDICT rows are silent — an unreadable ledger must not accuse", async () => {
    // applyMemoryExpiry's degradation path returns NEUTRAL rows (live: true
    // but confirmedBy null etc.) — but a row with live: false, and a row the
    // annotation never resolved, must both vanish.
    ledgerMock.applyMemoryExpiry.mockImplementation(
      async (notes: { id: string }[]) =>
        notes
          .filter((note) => note.id !== "mem-vanished")
          .map((note) => ({
            ...note,
            live: note.id !== "mem-dead",
            expired: false,
            confirmedBy: "human",
            pinned: false,
            expiresAt: null,
          }))
    );
    const result = await classifyWithheldDisclosure({
      candidates: [
        candidate("mem-dead", "paused", { status: "paused" }),
        candidate("mem-vanished", "cap"),
      ],
      tier: "operator",
      crewVisible: false,
      showExpiredView: false,
    });
    expect(result).toEqual({ suppressedCount: 0, withheld: [] });
  });

  it("the operator's showExpired view never stubs expired — those rows are ordinary suppression there", async () => {
    annotate({ "mem-exp": { expired: true } });
    const result = await classifyWithheldDisclosure({
      candidates: [candidate("mem-exp", "cap")],
      tier: "operator",
      crewVisible: false,
      showExpiredView: true,
    });
    expect(result.suppressedCount).toBe(1);
    expect(result.withheld).toEqual([]);
  });

  it("caller-requested filter narrowing is silent — an un-asked-for note was never withheld", async () => {
    annotate();
    const result = await classifyWithheldDisclosure({
      candidates: [candidate("mem-filtered", "cap", { kind: "attempt" })],
      tier: "operator",
      crewVisible: false,
      memoryFilter: { field: "kind", op: "eq", value: "decision" } as never,
      showExpiredView: false,
    });
    expect(result).toEqual({ suppressedCount: 0, withheld: [] });
  });
});

describe("withheldResponseFields (D2)", () => {
  it("absent fields mean nothing suppressed — zero never manufactures reassurance", () => {
    expect(
      withheldResponseFields({ suppressedCount: 0, withheld: [] })
    ).toEqual({});
    expect(
      withheldResponseFields({
        suppressedCount: 3,
        withheld: [{ id: "mem-1", kind: "decision", reason: "paused" }],
      })
    ).toEqual({
      suppressed_count: 3,
      withheld: [{ id: "mem-1", kind: "decision", reason: "paused" }],
    });
  });
});
