import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// ── D14's producer: a gate read leaves a record ──────────────────────────────
//
// D14 shipped the coverage OUTPUT — an operator staring at one empty gate learns
// whether nothing is KNOWN about this code or nothing was even SEARCHED. What it
// did not ship is a producer, so the DISTRIBUTION was unobservable and
// `memory-index-validation.md` §1.2 row 25 ("gate reads in the last N days by
// empty-reason enum") could never become a number. §6 puts D14 first because
// "without it nothing else is measurable in production, and the §0 number can
// recur silently"; half of that was still open.
//
// The three properties that matter, and each has a test below:
//   1. EVERY read is recorded, not only the empty ones — the alarm is a RATE, and
//      a producer that fired only on empties would hide its own denominator.
//   2. COUNTS AND THE ENUM ONLY. `Event` has no workspace fence, so no note text,
//      no note ids, and no anchor VALUES (which are workspace-relative paths).
//   3. It NEVER fails the gate. Telemetry that can 500 the hero read is worse
//      than no telemetry.

const OPERATOR = "operator-token-telemetry";
const AGENT = "agent-token-telemetry";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let app: FastifyInstance;

/** The gate-read rows, newest first. */
async function gateReads(): Promise<
  { message: string; metadata: Record<string, unknown> }[]
> {
  const rows = await db.prisma.event.findMany({
    where: { kind: "memory.gate_read" },
    orderBy: { timestamp: "desc" },
  });
  return rows.map((row) => ({
    message: row.message,
    metadata: row.metadata as Record<string, unknown>,
  }));
}

/**
 * Wait until at least `n` gate-read rows exist.
 *
 * The producer is deliberately NOT awaited by the route — that is the property
 * the last test pins — so a row lands shortly AFTER the response returns. Polling
 * models the real contract; forcing the write to be synchronous in tests would
 * verify a producer the product does not ship.
 */
async function gateReadsAtLeast(
  n: number,
  timeoutMs = 5_000
): Promise<{ message: string; metadata: Record<string, unknown> }[]> {
  const deadline = Date.now() + timeoutMs;
  let rows = await gateReads();
  while (rows.length < n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    rows = await gateReads();
  }
  return rows;
}

async function preedit(body: Record<string, unknown>, token = OPERATOR) {
  const response = await app.inject({
    method: "POST",
    url: "/api/memory/preedit",
    headers: auth(token),
    payload: body,
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-gate-telemetry-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  await db.ensureSchema();
  app = (await import("../src/app.js")).buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("D14 row 25: a gate read is durable, so its distribution is measurable", () => {
  it("records an EMPTY read with its reason, and a NON-EMPTY read without one", async () => {
    // An empty read: nothing is anchored to this module at all.
    await preedit({ module: "src/nothing/here.ts" });
    const afterEmpty = await gateReadsAtLeast(1);
    expect(afterEmpty).toHaveLength(1);
    expect(afterEmpty[0]!.metadata.emptyReason).toBeTruthy();
    expect(afterEmpty[0]!.metadata.surfaced).toBe(0);

    // A non-empty read. The note is human-confirmed so the strict gate admits it.
    const note = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Charges are idempotent by request key, tango-uniform.",
      modules: ["src/pay/charge.ts"],
      createdBy: "human",
    });
    await ledger.updateMemoryNote(note.note.id, {
      confirmed: true,
      principal: "human:tester",
    });
    const gate = await preedit({ module: "src/pay/charge.ts" });
    expect(gate.memories.length).toBeGreaterThan(0);

    const afterHit = await gateReadsAtLeast(2);
    expect(afterHit).toHaveLength(2);
    // ABSENT, not "none"/"ok"/null — absence IS the signal that the read
    // succeeded, and coercing it to a string would put a non-member of the closed
    // enum into the very column row 25 groups by.
    expect(afterHit[0]!.metadata).not.toHaveProperty("emptyReason");
    expect(afterHit[0]!.metadata.surfaced).toBeGreaterThan(0);
  });

  it("records EVERY read, so the alarm's denominator exists", async () => {
    // "`no_anchors` dominating" is a rate. A producer that only fired on empty
    // reads would make the denominator unobservable — the alarm would be
    // unevaluable in exactly the situation it exists for.
    const before = (await gateReads()).length;
    await preedit({ module: "src/pay/charge.ts" });
    await preedit({ module: "src/nothing/here.ts" });
    expect((await gateReadsAtLeast(before + 2)).length).toBe(before + 2);
  });

  it("carries COUNTS and the enum only — no prose, no ids, no anchor values", async () => {
    // `Event` has no workspace fence and no redaction, so a row must be safe to
    // read from any surface. Anchor VALUES are workspace-relative paths, which is
    // exactly the coordinate ADR-0026 partitions; they must not ride here.
    const secret = "zulu-victor-secret-decision-text";
    const note = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: `A confirmed constraint containing ${secret}.`,
      modules: ["src/telemetry/leak.ts"],
      createdBy: "human",
    });
    await ledger.updateMemoryNote(note.note.id, {
      confirmed: true,
      principal: "human:tester",
    });
    const expected = (await gateReads()).length + 1;
    await preedit({ module: "src/telemetry/leak.ts" });

    const [latest] = await gateReadsAtLeast(expected);
    const serialized = JSON.stringify(latest);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(note.note.id);
    expect(serialized).not.toContain("src/telemetry/leak.ts");
    // Every metadata value is a number, a boolean, or the closed enum member.
    for (const [key, value] of Object.entries(latest!.metadata)) {
      if (key === "emptyReason" || key === "tier") {
        expect(typeof value).toBe("string");
        continue;
      }
      expect(["number", "boolean"]).toContain(typeof value);
    }
  });

  it("TODO 4.3: carries contextChars — the SIZE of what entered the context, beside the count", async () => {
    // Every cap in the pipeline is a count while the longest live note is
    // 3,172 chars and counts as one — so "5 surfaced" cannot distinguish 200
    // chars of context from 15,000, and nothing could tell whether the
    // standing arm helped or just cost.
    const text =
      "A confirmed constraint sized exactly for the telemetry check xray-yankee.";
    const note = await ledger.ingestMemoryNote({
      kind: "constraint",
      text,
      modules: ["src/telemetry/chars.ts"],
      createdBy: "human",
    });
    await ledger.updateMemoryNote(note.note.id, {
      confirmed: true,
      principal: "human:tester",
    });
    const expected = (await gateReads()).length + 1;
    const gate = await preedit({ module: "src/telemetry/chars.ts" });
    const surfacedChars = (gate.memories as { text: string }[]).reduce(
      (total, memory) => total + memory.text.length,
      0
    );
    expect(surfacedChars).toBeGreaterThan(0);

    const [latest] = await gateReadsAtLeast(expected);
    // The recorded size is Σ text length of exactly the surfaced notes — the
    // same notes the response carries, never the mirror's wider pre-gate set.
    expect(latest!.metadata.contextChars).toBe(surfacedChars);

    // And an EMPTY read records zero — measured, not absent (absent means an
    // older producer that did not measure).
    const expectedEmpty = (await gateReads()).length + 1;
    await preedit({ module: "src/nothing/at-all.ts" });
    const [empty] = await gateReadsAtLeast(expectedEmpty);
    expect(empty!.metadata.contextChars).toBe(0);
  });

  it("NEVER fails the gate when the write throws", async () => {
    // Telemetry that can 500 the hero read is worse than no telemetry. The
    // producer swallows and is not awaited, so a broken Event table costs the
    // operator a metric and never an answer.
    const original = db.prisma.event.create;
    (db.prisma as unknown as { event: { create: unknown } }).event.create = () => {
      throw new Error("event table is wedged");
    };
    try {
      const gate = await preedit({ module: "src/pay/charge.ts" });
      expect(gate.memories.length).toBeGreaterThan(0);
      expect(gate.coverage).toBeTruthy();
    } finally {
      (db.prisma as unknown as { event: { create: unknown } }).event.create =
        original;
    }
  });
});
