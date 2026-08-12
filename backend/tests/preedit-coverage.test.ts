import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MuonGraph, type MemoryNoteRecord } from "@muon/graph";
import { preEditContext } from "../src/lib/preedit.js";
import { tallyGateCoverage } from "../src/lib/preedit-coverage.js";

// ── D14: coverage is a first-class output of a gate read ──────────────────────
//
// The bug this closes is not a crash: `preEditContext` returned `memories: []`
// and every surface read that as "there is nothing to know". On the founder's
// install the truth was the opposite — memory WAS anchored to the radius, and the
// human simply could not be shown any of it, because the only tier that admits
// anything for a chat-less read is human confirmation and nothing had been
// confirmed. Two different facts, one silence, for weeks.
//
// So these tests are about the DISTINCTION, not the plumbing:
//   - "0 because nothing is anchored"        → no_notes_on_anchors
//   - "0 because you are not in a crew chat" → withheld_no_crew_chat
//   - "0 because the index could not be read"→ index_unavailable
// plus the non-negotiable: coverage REPORTS, it never ADMITS. The admitted set
// must be identical to what the gate returns on its own, under every posture.
//
// A real MuonGraph in a temp dir; no ledger, no embedder, a pinned clock.

let graph: MuonGraph;
let dir: string;

const MOD = "src/pay/charge.ts";
const NEIGHBOUR = "src/pay/refund.ts";
const BARREN = "src/pay/never-anchored.ts";
const SYMBOL = "src/pay/charge.ts#chargeCard";
// A module that holds NOTHING but one symbol-anchored vouched note, so a
// symbol-only read cannot be rescued by a confirmed neighbour on the same module.
const QUIET_MODULE = "src/pay/quiet.ts";
const QUIET_SYMBOL = `${QUIET_MODULE}#quietPath`;
const CHAT_A = "chat-a";

let confirmedId: string; // human-confirmed on MOD
let crewId: string; // chat A, UNCONFIRMED agent note on MOD
let symbolCrewId: string; // chat A, UNCONFIRMED, anchored to SYMBOL
let quietNoteId: string; // chat A, UNCONFIRMED, anchored to QUIET_SYMBOL only

const NOW = Date.UTC(2026, 6, 30);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-preedit-coverage-"));
  graph = new MuonGraph(join(dir, "test.lbug"), { disableFts: true });
  await graph.init();

  const confirmed = await graph.addMemoryNote({
    kind: "decision",
    text: "Charges are idempotent by request key",
    modules: [MOD],
    trust: "high",
    createdBy: "human",
    chatId: CHAT_A,
  });
  confirmedId = confirmed.id;
  await graph.updateMemoryNote(confirmedId, { confirmed: true });

  const crew = await graph.addMemoryNote({
    kind: "attempt",
    text: "Retry budget seems to be three",
    modules: [MOD],
    trust: "medium",
    createdBy: "agent:codex",
    chatId: CHAT_A,
  });
  crewId = crew.id;

  const symbolCrew = await graph.addMemoryNote({
    kind: "attempt",
    text: "chargeCard swallows the 402",
    modules: [MOD],
    symbols: [SYMBOL],
    trust: "medium",
    createdBy: "agent:codex",
    chatId: CHAT_A,
  });
  symbolCrewId = symbolCrew.id;

  const quiet = await graph.addMemoryNote({
    kind: "attempt",
    text: "quietPath returns early on a null customer",
    modules: [QUIET_MODULE],
    symbols: [QUIET_SYMBOL],
    trust: "medium",
    createdBy: "agent:codex",
    chatId: CHAT_A,
  });
  quietNoteId = quiet.id;
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("D14 coverage — the counts", () => {
  it("reports anchors asked/resolved, notes considered/admitted, and the ADMITTING TIER", async () => {
    const ctx = await preEditContext(
      graph,
      { module: MOD },
      { chatId: CHAT_A, crewVisibleMemory: true, now: NOW }
    );
    const { coverage } = ctx;
    expect(coverage.anchors.modules).toEqual({ requested: 1, resolved: 1 });
    expect(coverage.anchors.symbols).toEqual({ requested: 0, resolved: 0 });
    expect(coverage.anchors.unreadable).toBe(0);
    // Three notes sit on MOD; with the crew tier engaged all three are admitted.
    expect(coverage.notes.considered).toBe(3);
    expect(coverage.notes.admitted).toBe(3);
    expect(coverage.notes.surfaced).toBe(ctx.memories.length);
    // The tier split is the whole point: one confirmed, two merely vouched.
    expect(coverage.admittedBy).toEqual({
      humanConfirmed: 1,
      crewVouched: 2,
      trustFloor: 0,
    });
    expect(coverage.crewChat).toBe(true);
    expect(coverage.emptyReason).toBeUndefined();
  });

  it("admittedBy SUMS to notes.admitted — a note the tally cannot place would mean the gate's two evaluators disagree", async () => {
    for (const opts of [
      { chatId: CHAT_A, crewVisibleMemory: true },
      { chatId: CHAT_A },
      {},
      { trustFloor: "medium" as const },
    ]) {
      const ctx = await preEditContext(
        graph,
        { module: MOD, symbol: SYMBOL },
        { ...opts, now: NOW }
      );
      const { admittedBy, notes } = ctx.coverage;
      expect(
        admittedBy.humanConfirmed + admittedBy.crewVouched + admittedBy.trustFloor
      ).toBe(notes.admitted);
      expect(notes.admitted).toBe(ctx.memories.length);
      expect(notes.admitted).toBeLessThanOrEqual(notes.considered);
      expect(notes.surfaced).toBeLessThanOrEqual(notes.admitted);
    }
  });

  it("counts a NEIGHBOUR anchor that resolves to nothing separately from one that does", async () => {
    const ctx = await preEditContext(
      graph,
      { module: MOD },
      {
        blastRadius: { modules: [NEIGHBOUR, BARREN], source: "provided" },
        chatId: CHAT_A,
        crewVisibleMemory: true,
        now: NOW,
      }
    );
    // MOD + two supplied neighbours were asked about; only MOD carries anything.
    expect(ctx.coverage.anchors.modules.requested).toBe(3);
    expect(ctx.coverage.anchors.modules.resolved).toBe(1);
  });
});

describe("D14 coverage — the closed-enum empty reason", () => {
  it("'0 because you are NOT IN A CREW CHAT' is a DIFFERENT fact from '0 because nothing is anchored' (§2.1)", async () => {
    // THE MEASURED BUG. A human/operator read has no chatId, so the crew tier is
    // never engaged and only human confirmation can admit. Point it at a module
    // whose notes are all merely vouched: the gate returns nothing, and coverage
    // has to say WHY.
    const vouchedOnly = await graph.addMemoryNote({
      kind: "attempt",
      text: "Refunds are best-effort",
      modules: [NEIGHBOUR],
      trust: "medium",
      createdBy: "agent:codex",
      chatId: CHAT_A,
    });

    const human = await preEditContext(graph, { module: NEIGHBOUR }, { now: NOW });
    expect(human.memories).toEqual([]);
    expect(human.coverage.crewChat).toBe(false);
    expect(human.coverage.notes.considered).toBeGreaterThan(0);
    expect(human.coverage.notes.admitted).toBe(0);
    expect(human.coverage.emptyReason).toBe("withheld_no_crew_chat");
    // The anchor RESOLVED — that is the fact the old empty array destroyed.
    expect(human.coverage.anchors.modules.resolved).toBe(1);

    // Same anchor, same instant, an agent inside the chat: the gate admits it and
    // coverage names the tier. Nothing about the DATA changed between these two
    // reads; only who was asking.
    const agent = await preEditContext(
      graph,
      { module: NEIGHBOUR },
      { chatId: CHAT_A, crewVisibleMemory: true, now: NOW }
    );
    expect(agent.memories.map((m) => m.id)).toContain(vouchedOnly.id);
    expect(agent.coverage.emptyReason).toBeUndefined();
    expect(agent.coverage.admittedBy.crewVouched).toBeGreaterThan(0);
    expect(agent.coverage.admittedBy.humanConfirmed).toBe(0);
  });

  it("no_notes_on_anchors: the gate looked at a real anchor and the index carries nothing under it", async () => {
    const ctx = await preEditContext(graph, { module: BARREN }, { now: NOW });
    expect(ctx.coverage.anchors.modules).toEqual({ requested: 1, resolved: 0 });
    expect(ctx.coverage.notes.considered).toBe(0);
    expect(ctx.coverage.emptyReason).toBe("no_notes_on_anchors");
  });

  it("no_anchors: an empty target means the gate never looked at all", async () => {
    const ctx = await preEditContext(graph, {}, { now: NOW });
    expect(ctx.coverage.anchors.modules.requested).toBe(0);
    expect(ctx.coverage.anchors.symbols.requested).toBe(0);
    expect(ctx.coverage.emptyReason).toBe("no_anchors");
  });

  it("a NULL-chat note invisible to the #126 partition is reported as NOT CONSIDERED, not as gate-withheld", async () => {
    // Worth pinning because it is the subtle case. A legacy/NULL-chat note is
    // filtered out by the chat PARTITION (`visibilityClauses`), which runs before
    // the gate, so it was never a candidate for this read at all. Reporting it as
    // "the gate withheld things" would be a different (wrong) fact.
    //
    // Note what this implies inside `preEditContext`: with the crew tier engaged,
    // every candidate the partition admits is either same-chat (crew-vouched) or
    // global-and-confirmed (human-confirmed), so considered > 0 always implies
    // admitted > 0 and `withheld_by_gate` is unreachable HERE. It becomes
    // reachable at POST /preedit, where the ledger re-gate can drop the whole
    // admitted set — which is exactly what the tallyGateCoverage cases below
    // exercise.
    const nullChat = await graph.addMemoryNote({
      kind: "attempt",
      text: "Legacy note, no chat",
      modules: ["src/legacy/only.ts"],
      trust: "medium",
      createdBy: "agent:codex",
    });
    const ctx = await preEditContext(
      graph,
      { module: "src/legacy/only.ts" },
      { chatId: CHAT_A, crewVisibleMemory: true, now: NOW }
    );
    expect(ctx.memories.map((m) => m.id)).not.toContain(nullChat.id);
    expect(ctx.coverage.crewChat).toBe(true);
    expect(ctx.coverage.notes.considered).toBe(0);
    expect(ctx.coverage.emptyReason).toBe("no_notes_on_anchors");

    // …and the SAME note is both considered and admitted for a chat-less read,
    // which is what proves the partition (not the gate) was the filter above.
    const global = await preEditContext(
      graph,
      { module: "src/legacy/only.ts" },
      { trustFloor: "medium", now: NOW }
    );
    expect(global.coverage.notes.considered).toBe(1);
    expect(global.memories.map((m) => m.id)).toContain(nullChat.id);
    expect(global.coverage.admittedBy.trustFloor).toBe(1);
  });

  it("SYMBOL anchors: 'asked and nothing carries it' is distinguished from 'asked, found, withheld' (§0's finest tier)", async () => {
    // Nothing anywhere carries this symbol → resolved 0. This is the §0 headline
    // made observable: the finest tier of ADR-0012 has never held a row.
    const missing = await preEditContext(
      graph,
      { symbol: "src/pay/charge.ts#neverIndexed" },
      { chatId: CHAT_A, crewVisibleMemory: true, now: NOW }
    );
    expect(missing.coverage.anchors.symbols).toEqual({
      requested: 1,
      resolved: 0,
    });

    // A note IS anchored to QUIET_SYMBOL but is only vouched. For a chat-less
    // human read the gate returns nothing — yet the anchor RESOLVED, so coverage
    // must not report it as an empty coordinate layer. (The symbol's own module is
    // derived into the module fan-out, so QUIET_MODULE deliberately holds nothing
    // else; otherwise a confirmed neighbour would make the read non-empty and this
    // distinction untestable.)
    const human = await preEditContext(graph, { symbol: QUIET_SYMBOL }, { now: NOW });
    expect(human.coverage.anchors.symbols).toEqual({
      requested: 1,
      resolved: 1,
    });
    expect(human.coverage.notes.considered).toBeGreaterThan(0);
    expect(human.memories.map((m) => m.id)).not.toContain(quietNoteId);
    expect(human.coverage.emptyReason).toBe("withheld_no_crew_chat");

    // The same read inside the chat admits it, and reports the vouched tier.
    const agent = await preEditContext(
      graph,
      { symbol: QUIET_SYMBOL },
      { chatId: CHAT_A, crewVisibleMemory: true, now: NOW }
    );
    expect(agent.memories.map((m) => m.id)).toContain(quietNoteId);
    expect(agent.coverage.admittedBy.crewVouched).toBe(1);
  });

  it("index_unavailable: an unreadable probe is UNKNOWN, never reported as 'nothing to know'", async () => {
    // Break ONLY the coverage probe (the ungated symbol recall) and leave the gate
    // untouched, so this proves the reason AND that a probe failure cannot fail
    // the gate read.
    const real = graph.recallMemory.bind(graph);
    const spy = async (
      filter: Parameters<MuonGraph["recallMemory"]>[0],
      limit?: number
    ) => {
      // D6: the ungated SYMBOL coverage probe is now ONE batched query over a
      // `symbols` LIST rather than one `symbol` per anchor, so the predicate that
      // identifies it has to match both shapes. Keying on the old shape alone would
      // leave this spy silently inert and the test vacuously green.
      if ((filter.symbol || filter.symbols?.length) && !filter.governedOnly) {
        throw new Error("mirror unavailable");
      }
      return real(filter, limit);
    };
    (graph as unknown as { recallMemory: typeof spy }).recallMemory = spy;
    try {
      // The symbol's own module is derived into the fan-out, so use a symbol whose
      // module is ALSO barren — otherwise `considered` picks up the neighbours and
      // the "zero is unknown" case cannot be isolated.
      const ctx = await preEditContext(
        graph,
        { symbol: `${BARREN}#nope`, module: BARREN },
        { now: NOW }
      );
      expect(ctx.coverage.anchors.unreadable).toBe(1);
      expect(ctx.coverage.notes.considered).toBe(0);
      expect(ctx.coverage.emptyReason).toBe("index_unavailable");
    } finally {
      (graph as unknown as { recallMemory: typeof real }).recallMemory = real;
    }
  });
});

describe("D14-C IS REJECTED — coverage reports, it never admits", () => {
  // The strongest available evidence that this change moved no admission: for
  // every posture, rebuild the admitted set the way the gate itself defines it
  // (recallForGate over the same anchors, KG-6, nothing to do with coverage) and
  // require `memories` to be byte-identical to it. If any coverage code path ever
  // widened or narrowed the gate — the D14-C failure mode — this diverges.
  const postures = [
    { label: "human / no chat (strict confirmed-only)", opts: {} },
    { label: "agent in chat, crew OFF", opts: { chatId: CHAT_A } },
    {
      label: "agent in chat, crew ON",
      opts: { chatId: CHAT_A, crewVisibleMemory: true },
    },
    { label: "operator trustFloor medium", opts: { trustFloor: "medium" as const } },
  ];

  for (const posture of postures) {
    it(`admitted set is byte-identical to the gate's own answer — ${posture.label}`, async () => {
      const opts = { ...posture.opts, now: NOW };
      const ctx = await preEditContext(
        graph,
        { module: MOD, symbol: SYMBOL },
        opts
      );

      // Independently reconstruct the gate's answer, exactly as preEditContext's
      // predecessor did: one recallForGate per anchor, merged by id.
      const crewChatId =
        opts.crewVisibleMemory && opts.chatId ? opts.chatId : undefined;
      const expected = new Map<string, MemoryNoteRecord>();
      for (const mod of ctx.blastRadius.modules) {
        for (const note of await graph.recallForGate(
          { module: mod, chatId: opts.chatId, crewChatId },
          { trustFloor: opts.trustFloor, limit: 50 }
        )) {
          if (!expected.has(note.id)) expected.set(note.id, note);
        }
      }
      for (const note of await graph.recallForGate(
        { symbol: SYMBOL, chatId: opts.chatId, crewChatId },
        { trustFloor: opts.trustFloor, limit: 50 }
      )) {
        if (!expected.has(note.id)) expected.set(note.id, note);
      }

      expect(ctx.memories.map((m) => m.id).sort()).toEqual(
        [...expected.keys()].sort()
      );
      // And the text of every admitted note is byte-identical to the store's.
      for (const memory of ctx.memories) {
        expect(memory.text).toBe(expected.get(memory.id)!.text);
      }
      expect(ctx.coverage.notes.admitted).toBe(expected.size);
    });
  }

  it("a broken coverage probe does not change the admitted set by a single note", async () => {
    const before = await preEditContext(
      graph,
      { module: MOD, symbol: SYMBOL },
      { chatId: CHAT_A, crewVisibleMemory: true, now: NOW }
    );
    const real = graph.recallMemory.bind(graph);
    const spy = async (
      filter: Parameters<MuonGraph["recallMemory"]>[0],
      limit?: number
    ) => {
      // D6: the ungated SYMBOL coverage probe is now ONE batched query over a
      // `symbols` LIST rather than one `symbol` per anchor, so the predicate that
      // identifies it has to match both shapes. Keying on the old shape alone would
      // leave this spy silently inert and the test vacuously green.
      if ((filter.symbol || filter.symbols?.length) && !filter.governedOnly) {
        throw new Error("mirror unavailable");
      }
      return real(filter, limit);
    };
    (graph as unknown as { recallMemory: typeof spy }).recallMemory = spy;
    try {
      const after = await preEditContext(
        graph,
        { module: MOD, symbol: SYMBOL },
        { chatId: CHAT_A, crewVisibleMemory: true, now: NOW }
      );
      expect(JSON.stringify(after.memories)).toBe(
        JSON.stringify(before.memories)
      );
      expect(after.coverage.anchors.unreadable).toBe(1);
      // …and the symbol anchor is honestly reported as UNRESOLVED-because-unknown,
      // never as resolved.
      expect(after.coverage.anchors.symbols.requested).toBe(1);
    } finally {
      (graph as unknown as { recallMemory: typeof real }).recallMemory = real;
    }
  });

  it("carries NO note id, note text, or coordinate into the coverage block", async () => {
    const ctx = await preEditContext(
      graph,
      { module: MOD, symbol: SYMBOL },
      { chatId: CHAT_A, crewVisibleMemory: true, now: NOW }
    );
    const serialized = JSON.stringify(ctx.coverage);
    expect(serialized).not.toContain(confirmedId);
    expect(serialized).not.toContain(crewId);
    expect(serialized).not.toContain(symbolCrewId);
    expect(serialized).not.toContain(MOD);
    expect(serialized).not.toContain(SYMBOL);
    expect(serialized).not.toContain(CHAT_A);
    expect(serialized).not.toContain("idempotent");
  });
});

describe("tallyGateCoverage (the shared re-tally the route reuses)", () => {
  const base = {
    anchors: {
      modules: { requested: 2, resolved: 2 },
      symbols: { requested: 0, resolved: 0 },
      unreadable: 0,
    },
    notes: { considered: 5, admitted: 5, surfaced: 5 },
    admittedBy: { humanConfirmed: 3, crewVouched: 2, trustFloor: 0 },
    crewChat: true,
  } as const;

  it("re-tallies to the notes that SURVIVED a narrower second pass, and re-derives the reason", () => {
    // The route's ledger re-gate dropped everything. Reporting the library's
    // tally here would claim 5 admitted on a response with zero memories — and
    // would carry NO emptyReason at all, which is the exact silence D14 removes.
    const dropped = tallyGateCoverage({ ...base }, [], { crewChatId: CHAT_A });
    expect(dropped.notes.admitted).toBe(0);
    expect(dropped.notes.surfaced).toBe(0);
    expect(dropped.admittedBy).toEqual({
      humanConfirmed: 0,
      crewVouched: 0,
      trustFloor: 0,
    });
    expect(dropped.emptyReason).toBe("withheld_by_gate");
    // The LOOKUP half is untouched: what was asked and considered still stands.
    expect(dropped.anchors).toEqual(base.anchors);
    expect(dropped.notes.considered).toBe(5);
  });

  it("classifies each surviving note by the tier that admitted it, under the posture actually used", () => {
    const notes = [
      { confirmed: true, trust: "high" as const, chatId: CHAT_A },
      { confirmed: false, trust: "medium" as const, chatId: CHAT_A },
      { confirmed: false, trust: "high" as const, chatId: "other" },
    ];
    const withCrew = tallyGateCoverage({ ...base }, notes, {
      crewChatId: CHAT_A,
      trustFloor: "high",
    });
    expect(withCrew.admittedBy).toEqual({
      humanConfirmed: 1,
      crewVouched: 1,
      // The cross-chat note is not crew-vouched here; only the floor admits it.
      trustFloor: 1,
    });

    // Drop the crew posture and the SAME notes tally differently — the tally is
    // meaningless except against the posture the gate actually ran with. Note the
    // medium-trust note now matches NO tier under a 'high' floor, so it is counted
    // NOWHERE and the buckets no longer sum to the note count. That can only
    // happen if a caller hands this function a note the gate did not admit, and
    // the deliberate under-count is how such a lockstep break stays visible
    // instead of being absorbed into a bucket.
    const noCrew = tallyGateCoverage({ ...base }, notes, { trustFloor: "high" });
    expect(noCrew.admittedBy).toEqual({
      humanConfirmed: 1,
      crewVouched: 0,
      trustFloor: 1,
    });
    expect(
      noCrew.admittedBy.humanConfirmed +
        noCrew.admittedBy.crewVouched +
        noCrew.admittedBy.trustFloor
    ).toBeLessThan(noCrew.notes.admitted);
  });

  it("clears a stale emptyReason when the re-tally is NOT empty", () => {
    const stale = tallyGateCoverage(
      { ...base, emptyReason: "no_anchors" as const },
      [{ confirmed: true, trust: "high" as const, chatId: null }],
      {}
    );
    expect(stale.emptyReason).toBeUndefined();
  });
});
