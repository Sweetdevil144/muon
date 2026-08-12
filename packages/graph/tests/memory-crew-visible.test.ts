import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MuonGraph } from "../src/muon-graph.js";
import {
  normalizeAnchorSet,
  noteMatchesAnchors,
} from "../src/memory-anchors.js";

// ── #133 CREW-VISIBLE admission (governedConditions + passesGate) ─────────────
//
// The crew-visible admission widens the KG-6 confirmed-only gate MINIMALLY: an
// UNCONFIRMED agent note becomes gate-visible ONLY within its OWN chat (crewChatId).
// It is DISTINCT from human confirmation and NEVER mutates the human-only
// `confirmed` flag. These tests exercise the OR branch in ISOLATION — no chatId
// hard-partition (visibilityClauses) — so they prove the gate predicate ITSELF
// cannot leak a cross-chat or NULL/''-chat note, independent of the outer #126
// partition that also bounds every real request. LOCKSTEP is proven end-to-end:
// the same recallForGate path drives both the cypher (governedConditions) and the
// TS net (passesGate).

let graph: MuonGraph;
let dir: string;

const MOD = "src/pay/charge.ts";
const CHAT_A = "chat-a";
const CHAT_B = "chat-b";

let inChatAId: string; // unconfirmed, medium, chat A (the crew note)
let inChatBId: string; // unconfirmed, medium, chat B (cross-chat)
let nullChatId: string; // unconfirmed, medium, NULL/''-chat (legacy/global)
let confirmedGlobalId: string; // confirmed, NULL-chat (control: always governed)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-crew-visible-"));
  graph = new MuonGraph(join(dir, "test.lbug"));
  await graph.init();

  const inChatA = await graph.addMemoryNote({
    kind: "decision",
    text: "Charges are idempotent by request key (chat A)",
    modules: [MOD],
    trust: "medium",
    createdBy: "agent:codex",
    chatId: CHAT_A,
  });
  inChatAId = inChatA.id;

  const inChatB = await graph.addMemoryNote({
    kind: "decision",
    text: "Charges use a different key derivation (chat B)",
    modules: [MOD],
    trust: "medium",
    createdBy: "agent:claude",
    chatId: CHAT_B,
  });
  inChatBId = inChatB.id;

  const nullChat = await graph.addMemoryNote({
    kind: "constraint",
    text: "Legacy note with no chat",
    modules: [MOD],
    trust: "medium",
    createdBy: "agent:codex",
  });
  nullChatId = nullChat.id;

  const confirmedGlobal = await graph.addMemoryNote({
    kind: "constraint",
    text: "A human-confirmed global constraint",
    modules: [MOD],
    trust: "high",
    createdBy: "human",
  });
  confirmedGlobalId = confirmedGlobal.id;
  await graph.updateMemoryNote(confirmedGlobalId, { confirmed: true });
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("#133 crew-visible gate admission", () => {
  it("(a) ADMITS a same-chat UNCONFIRMED agent note when crewChatId matches", async () => {
    const gated = await graph.recallForGate({ module: MOD, crewChatId: CHAT_A });
    const ids = gated.map((n) => n.id);
    expect(ids).toContain(inChatAId);
    // The confirmed control is always governed, regardless of the crew branch.
    expect(ids).toContain(confirmedGlobalId);
  });

  it("(b) EXCLUDES a cross-chat unconfirmed note (crew predicate keys on the chat)", async () => {
    const gated = await graph.recallForGate({ module: MOD, crewChatId: CHAT_A });
    expect(gated.map((n) => n.id)).not.toContain(inChatBId);
  });

  it("(c) EXCLUDES a NULL/''-chat note (n.chatId <> '' keeps legacy/global human-gated)", async () => {
    const gated = await graph.recallForGate({ module: MOD, crewChatId: CHAT_A });
    expect(gated.map((n) => n.id)).not.toContain(nullChatId);
  });

  it("base gate (no crewChatId) EXCLUDES the same-chat unconfirmed note — crew is the ONLY thing admitting it", async () => {
    const gated = await graph.recallForGate({ module: MOD });
    const ids = gated.map((n) => n.id);
    expect(ids).not.toContain(inChatAId);
    expect(ids).not.toContain(inChatBId);
    expect(ids).not.toContain(nullChatId);
    // The confirmed note still surfaces (confirmed-only base is intact).
    expect(ids).toContain(confirmedGlobalId);
  });

  it("(d) trustFloor:'high' with crew OFF still EXCLUDES the 'medium' agent note (kill switch); trust is untouched", async () => {
    // Killing the crew admission (no crewChatId) with a high trust floor keeps the
    // agent note out — its trust was never elevated by being crew-visible.
    const gated = await graph.recallForGate(
      { module: MOD },
      { trustFloor: "high" }
    );
    expect(gated.map((n) => n.id)).not.toContain(inChatAId);

    const persisted = await graph.getMemoryNote(inChatAId);
    expect(persisted?.trust).toBe("medium");
  });

  it("(e) crew admission NEVER mutates the human-only `confirmed` flag", async () => {
    // Surface it through the crew branch, then re-read: still unconfirmed.
    const gated = await graph.recallForGate({ module: MOD, crewChatId: CHAT_A });
    expect(gated.find((n) => n.id === inChatAId)?.confirmed).toBe(false);

    const persisted = await graph.getMemoryNote(inChatAId);
    expect(persisted?.confirmed).toBe(false);
  });

  it("cypher and TS net stay in LOCKSTEP: recallForGate (query gate) matches recallMemory→applyGate (JS net)", async () => {
    // recallForGate runs governedConditions IN the query; recallMemory + the
    // applyGate JS net must agree on the admitted set for the same crew request.
    const viaQuery = (
      await graph.recallForGate({ module: MOD, crewChatId: CHAT_A })
    )
      .map((n) => n.id)
      .sort();
    const viaNet = (
      await graph.recallMemory({
        module: MOD,
        governedOnly: true,
        crewChatId: CHAT_A,
      })
    )
      .map((n) => n.id)
      .sort();
    expect(viaQuery).toEqual(viaNet);
  });

  // ── D4 + D6: the SAME lockstep property, extended to the new ANCHOR term ─────
  //
  // §7's invariant flag for D4/D6 is this file. The anchor term is now a second
  // predicate stated in two languages — a Cypher arm over `ANCHORED_TO` /
  // `ABOUT_SYMBOL` (the ACCESS PATH) and a JS net over `n.modules` / `n.symbols`
  // (the AUTHORITY) — so it needs the property `governedConditions` already has:
  // the two must admit EXACTLY the same set. A drift here is not a ranking bug, it
  // is one arm of a hybrid read seeing a note another arm cannot.
  describe("D4/D6 anchor term — cypher arm and JS net admit exactly the same set", () => {
    const SECOND_MOD = "src/pay/refund.ts";
    const SYMBOL = `${MOD}#charge`;

    beforeAll(async () => {
      // A note on a SECOND module (so a batched two-anchor read is a real union),
      // and a symbol-anchored one (so the second namespace is exercised).
      const onSecond = await graph.addMemoryNote({
        kind: "decision",
        text: "Refunds reverse the original charge key",
        modules: [SECOND_MOD],
        trust: "medium",
        createdBy: "agent:codex",
        chatId: CHAT_A,
      });
      await graph.updateMemoryNote(onSecond.id, { confirmed: true });
      const onSymbol = await graph.addMemoryNote({
        kind: "constraint",
        text: "charge() must be called with an explicit request key",
        modules: [MOD],
        symbols: [SYMBOL],
        trust: "medium",
        createdBy: "agent:codex",
        chatId: CHAT_A,
      });
      await graph.updateMemoryNote(onSymbol.id, { confirmed: true });
    });

    /** The JS net's answer: take the UNANCHORED governed set and apply the pure
     *  anchor predicate to it. Independent of the edge, so a drift between the
     *  access path and the authority shows up here as a set difference. */
    async function viaJsNet(request: {
      modules?: string[];
      symbols?: string[];
      crewChatId?: string;
    }): Promise<string[]> {
      const all = await graph.recallForGate(
        { crewChatId: request.crewChatId },
        { limit: 200 }
      );
      const anchors = normalizeAnchorSet(request);
      return all
        .filter((note) => noteMatchesAnchors(note, anchors))
        .map((note) => note.id)
        .sort();
    }

    const viaCypher = async (request: {
      modules?: string[];
      symbols?: string[];
      crewChatId?: string;
    }): Promise<string[]> =>
      (await graph.recallForGate(request, { limit: 200 }))
        .map((note) => note.id)
        .sort();

    const cases: {
      label: string;
      request: { modules?: string[]; symbols?: string[]; crewChatId?: string };
    }[] = [
      { label: "one module, strict gate", request: { modules: [MOD] } },
      {
        label: "one module, crew widening",
        request: { modules: [MOD], crewChatId: CHAT_A },
      },
      {
        label: "two modules (a batched union)",
        request: { modules: [MOD, SECOND_MOD], crewChatId: CHAT_A },
      },
      { label: "one symbol", request: { symbols: [SYMBOL], crewChatId: CHAT_A } },
      {
        label: "both namespaces at once",
        request: {
          modules: [MOD, SECOND_MOD],
          symbols: [SYMBOL],
          crewChatId: CHAT_A,
        },
      },
      {
        label: "an anchor nothing carries",
        request: { modules: ["src/nope/none.ts"], crewChatId: CHAT_A },
      },
      {
        label: "a fence the caller supplied EMPTY (must admit nothing)",
        request: { modules: [], crewChatId: CHAT_A },
      },
    ];

    for (const { label, request } of cases) {
      it(`${label}`, async () => {
        const cypher = await viaCypher(request);
        expect(cypher).toEqual(await viaJsNet(request));
      });
    }

    it("the union is non-empty for the cases that should be, so the equalities above are not vacuous", async () => {
      expect(
        (await viaCypher({ modules: [MOD, SECOND_MOD], crewChatId: CHAT_A }))
          .length
      ).toBeGreaterThan(1);
      expect(
        (await viaCypher({ symbols: [SYMBOL], crewChatId: CHAT_A })).length
      ).toBe(1);
      expect(await viaCypher({ modules: [], crewChatId: CHAT_A })).toEqual([]);
    });
  });
});
