import { describe, expect, it } from "vitest";
import {
  memoryGateTier,
  memoryPassesGate,
  type MemoryGateTier,
} from "../src/memory-gate.js";
import type { MemoryNoteRecord, MemoryTrust } from "../src/types.js";

// ── D14: the gate rule keeps its VERDICT, and the boolean is its projection ────
//
// Coverage has to report WHICH tier admitted a note ("all 32 were crew-vouched,
// none confirmed" is §2.1's whole point). Computing that beside `memoryPassesGate`
// would have made a FOURTH statement of the gate rule — the cypher in
// `governedConditions`, `passesGate`, the route's ledger pass, and a tally — and a
// tally that disagreed with the predicate is the drift this file exists to
// foreclose. So `memoryGateTier` IS the rule and `memoryPassesGate` delegates.
//
// These tests are the lockstep proof: over the full cross-product of the inputs
// the gate takes, the boolean must equal `tier !== null`. If someone later
// re-implements the boolean independently, or adds a tier to one and not the
// other, this fails.

type GateNote = Pick<MemoryNoteRecord, "confirmed" | "trust"> & {
  chatId?: string | null;
  status?: MemoryNoteRecord["status"];
};

const CHAT = "chat-a";
const OTHER = "chat-b";

const notes: GateNote[] = [];
for (const confirmed of [true, false]) {
  for (const trust of ["low", "medium", "high"] as MemoryTrust[]) {
    for (const chatId of [CHAT, OTHER, "", null, undefined]) {
      for (const status of ["active", "paused", "rejected"] as const) {
        notes.push({ confirmed, trust, chatId, status });
      }
    }
  }
}

const options = [
  undefined,
  {},
  { governedOnly: true },
  { governedOnly: true, crewChatId: CHAT },
  { governedOnly: true, crewChatId: "" },
  { governedOnly: true, trustFloor: "low" as MemoryTrust },
  { governedOnly: true, trustFloor: "medium" as MemoryTrust },
  { governedOnly: true, trustFloor: "high" as MemoryTrust },
  {
    governedOnly: true,
    crewChatId: CHAT,
    trustFloor: "high" as MemoryTrust,
  },
  { crewChatId: CHAT, trustFloor: "low" as MemoryTrust },
];

describe("memoryGateTier / memoryPassesGate lockstep", () => {
  it("the boolean is EXACTLY `tier !== null` across every note × option combination", () => {
    let checked = 0;
    for (const note of notes) {
      for (const opts of options) {
        const tier = memoryGateTier(note, opts);
        expect(memoryPassesGate(note, opts)).toBe(tier !== null);
        checked += 1;
      }
    }
    // Guard against a vacuous pass if the fixtures are ever gutted.
    expect(checked).toBe(notes.length * options.length);
    expect(checked).toBeGreaterThan(250);
  });

  it("names the tier in the gate's own precedence order: confirmed > crew > floor", () => {
    // A confirmed note is human-confirmed even when the crew branch and the floor
    // would ALSO admit it — the reported tier must be the strongest claim, or
    // coverage would under-count human confirmation.
    expect(
      memoryGateTier(
        { confirmed: true, trust: "high", chatId: CHAT },
        { governedOnly: true, crewChatId: CHAT, trustFloor: "low" }
      )
    ).toBe("human_confirmed");
    // Unconfirmed + same chat = vouched, NOT confirmed, and not the floor even
    // when the floor would also let it through.
    expect(
      memoryGateTier(
        { confirmed: false, trust: "high", chatId: CHAT },
        { governedOnly: true, crewChatId: CHAT, trustFloor: "low" }
      )
    ).toBe("crew_vouched");
    // Only the floor is left.
    expect(
      memoryGateTier(
        { confirmed: false, trust: "high", chatId: OTHER },
        { governedOnly: true, crewChatId: CHAT, trustFloor: "high" }
      )
    ).toBe("trust_floor");
    // Nothing admits it.
    expect(
      memoryGateTier(
        { confirmed: false, trust: "medium", chatId: OTHER },
        { governedOnly: true, crewChatId: CHAT, trustFloor: "high" }
      )
    ).toBeNull();
  });

  it("`ungated` is NOT an admission tier — an ungated read consulted no tier", () => {
    const note: GateNote = { confirmed: false, trust: "low", chatId: OTHER };
    // No governedOnly → the caller never asked for the gate.
    expect(memoryGateTier(note, {})).toBe("ungated");
    expect(memoryGateTier(note, undefined)).toBe("ungated");
    expect(memoryPassesGate(note, {})).toBe(true);
    // Coverage counts human_confirmed / crew_vouched / trust_floor only, so an
    // ungated verdict can never inflate an admission bucket.
    const admitting: MemoryGateTier[] = [
      "human_confirmed",
      "crew_vouched",
      "trust_floor",
    ];
    expect(admitting).not.toContain(memoryGateTier(note, {}));
  });

  it("lets operator pause dominate human, crew, floor, and ungated admission", () => {
    const note: GateNote = {
      confirmed: true,
      trust: "high",
      chatId: CHAT,
      status: "paused",
    };
    expect(memoryGateTier(note, undefined)).toBeNull();
    expect(
      memoryGateTier(note, {
        governedOnly: true,
        crewChatId: CHAT,
        trustFloor: "low",
      })
    ).toBeNull();
    expect(memoryPassesGate(note, { governedOnly: true })).toBe(false);
  });

  it("a NULL/''-chat note is never crew-vouched (lockstep with the cypher's `n.chatId <> ''`)", () => {
    for (const chatId of ["", null, undefined]) {
      expect(
        memoryGateTier(
          { confirmed: false, trust: "medium", chatId },
          { governedOnly: true, crewChatId: "" }
        )
      ).toBeNull();
    }
    // And an empty crewChatId cannot vouch for a real chat either.
    expect(
      memoryGateTier(
        { confirmed: false, trust: "medium", chatId: CHAT },
        { governedOnly: true, crewChatId: "" }
      )
    ).toBeNull();
  });
});
