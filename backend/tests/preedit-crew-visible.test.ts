import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MuonGraph } from "@muon/graph";
import { preEditContext } from "../src/lib/preedit.js";

// ── #133 CREW-VISIBLE admission through preEditContext (the hero gate) ─────────
//
// With the operator setting ON (`crewVisibleMemory: true`), the gate ADMITS
// same-chat UNCONFIRMED agent notes into `memories` (verbatim), so an agent's
// observation reaches the next agent in the SAME chat automatically. The blast
// radius is HARD-WIRED: crewChatId is ALWAYS the request's own chatId, so it can
// only widen WITHIN the chat — a cross-chat unconfirmed note's TEXT never leaks
// out (invariant), and the human-only `confirmed` flag is never mutated. A real
// MuonGraph in a temp dir; no ledger, no embedder, deterministic.

let graph: MuonGraph;
let dir: string;

const MOD = "src/pay/charge.ts";
const CHAT_A = "chat-a";
const CHAT_B = "chat-b";
const CREW_TEXT = "Charges are idempotent by request key alpha-crew";
const OUT_OF_CHAT_PAYLOAD =
  "OUT_OF_CHAT_UNCONFIRMED_TEXT_MUST_NEVER_LEAK_ZZZ";

let crewNoteId: string; // chat A, UNCONFIRMED, agent, on MOD
let confirmedAId: string; // chat A, CONFIRMED, human, on MOD (control)
let otherChatNoteId: string; // chat B, UNCONFIRMED, agent, on MOD (must never leak)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-preedit-crew-"));
  graph = new MuonGraph(join(dir, "test.lbug"), { disableFts: true });
  await graph.init();

  const crewNote = await graph.addMemoryNote({
    kind: "attempt",
    text: CREW_TEXT,
    modules: [MOD],
    trust: "medium",
    createdBy: "agent:codex",
    chatId: CHAT_A,
  });
  crewNoteId = crewNote.id;

  const confirmedA = await graph.addMemoryNote({
    kind: "decision",
    text: "Chat A confirmed decision",
    modules: [MOD],
    trust: "high",
    createdBy: "human",
    chatId: CHAT_A,
  });
  confirmedAId = confirmedA.id;
  await graph.updateMemoryNote(confirmedAId, { confirmed: true });

  const otherChatNote = await graph.addMemoryNote({
    kind: "attempt",
    text: OUT_OF_CHAT_PAYLOAD,
    modules: [MOD],
    trust: "medium",
    createdBy: "agent:intruder",
    chatId: CHAT_B,
  });
  otherChatNoteId = otherChatNote.id;
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("#133 preEditContext crew-visible admission", () => {
  it("(a) crew ON: a same-chat UNCONFIRMED agent note is ADMITTED into memories (verbatim), alongside the confirmed control", async () => {
    const ctx = await preEditContext(
      graph,
      { module: MOD },
      { chatId: CHAT_A, crewVisibleMemory: true, now: Date.now() }
    );
    const ids = ctx.memories.map((m) => m.id);
    expect(ids).toContain(crewNoteId);
    expect(ids).toContain(confirmedAId);
    // Crew-visible means the TEXT flows to the next agent (this is the point).
    expect(JSON.stringify(ctx.memories)).toContain(CREW_TEXT);
    // The admitted note is still UNCONFIRMED on the surface — admission is DISTINCT
    // from human confirmation.
    expect(ctx.memories.find((m) => m.id === crewNoteId)?.confirmed).toBe(false);
  });

  it("crew OFF (setting off / omitted): the same-chat unconfirmed note is EXCLUDED — the strict confirmed-only gate", async () => {
    const ctx = await preEditContext(
      graph,
      { module: MOD },
      { chatId: CHAT_A, now: Date.now() }
    );
    const ids = ctx.memories.map((m) => m.id);
    expect(ids).not.toContain(crewNoteId);
    // The confirmed control still surfaces (gate is intact, just not widened).
    expect(ids).toContain(confirmedAId);
    expect(JSON.stringify(ctx.memories)).not.toContain(CREW_TEXT);
  });

  it("blast radius is HARD-WIRED to the chat: crew ON WITHOUT a chatId (operator/global gate) does NOT admit the unconfirmed note", async () => {
    const ctx = await preEditContext(
      graph,
      { module: MOD },
      { crewVisibleMemory: true, now: Date.now() }
    );
    // No chatId → crewChatId is undefined → strict confirmed-only, unconfirmed out.
    expect(ctx.memories.map((m) => m.id)).not.toContain(crewNoteId);
    expect(ctx.memories.map((m) => m.id)).not.toContain(otherChatNoteId);
  });

  it("(f) out-of-chat unconfirmed text NEVER appears verbatim, even with crew ON in another chat", async () => {
    const ctx = await preEditContext(
      graph,
      { module: MOD },
      { chatId: CHAT_A, crewVisibleMemory: true, now: Date.now() }
    );
    // The chat-B note is neither surfaced as a memory nor leaked in ANY field.
    expect(ctx.memories.map((m) => m.id)).not.toContain(otherChatNoteId);
    expect(JSON.stringify(ctx)).not.toContain(OUT_OF_CHAT_PAYLOAD);
  });

  it("crew admission NEVER mutates the human-only `confirmed` flag (persisted note stays unconfirmed)", async () => {
    await preEditContext(
      graph,
      { module: MOD },
      { chatId: CHAT_A, crewVisibleMemory: true, now: Date.now() }
    );
    const persisted = await graph.getMemoryNote(crewNoteId);
    expect(persisted?.confirmed).toBe(false);
    expect(persisted?.trust).toBe("medium");
  });
});
