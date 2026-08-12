import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// R5 FILTER GRAMMAR + R3 `show_expired` over the REAL routes, the REAL SQLite
// ledger and the REAL LadybugDB graph (no store mocks), modelled on
// memory-chat-scope.test.ts.
//
// The claim under test is not "the operators work" (that is unit-tested in
// packages/protocol). It is the governance claim: a filter is a NARROWER inside
// the caller's existing visibility scope and can never become a side channel —
// it must not reveal the existence, the content, or even the count of a note the
// caller could not already read. Every leak attempt below is written to FAIL if
// the filter were ever applied before the chat partition / confirmed-only gate.

const OPERATOR = "operator-token-memory-filter";
const AGENT = "agent-token-memory-filter";
const JOB_A_TOKEN = `job-fa-${"a".repeat(57)}`;
const JOB_B_TOKEN = `job-fb-${"b".repeat(57)}`;
const MOD = "src/billing/invoice.ts";
// The exact string a chat-B caller must never be able to confirm the existence
// of by any combination of predicates.
const CHAT_A_SECRET = "quebec-sierra-private-charge-window";
const CHAT_B_TEXT = "bravo-visible invoice rounding rule";
const CHAT_B_EXPIRED_TEXT = "bravo-expired stale guess about retries";
const CHAT_B_PENDING_TEXT = "bravo-pending unreviewed romeo-tango claim";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const DAY_MS = 24 * 60 * 60 * 1_000;

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;

const NOTE_A = "mem-filter-chat-a";
const NOTE_B = "mem-filter-chat-b";
const NOTE_B_EXPIRED = "mem-filter-chat-b-expired";
const NOTE_B_PENDING = "mem-filter-chat-b-pending";

/** GET a memory read with an optional filter/showExpired, returning note ids. */
async function readNoteIds(
  route: "recall" | "search",
  token: string,
  params: Record<string, string>
): Promise<{ status: number; ids: string[]; body: Record<string, unknown> }> {
  const query = new URLSearchParams(params).toString();
  const response = await app.inject({
    method: "GET",
    url: `/api/memory/${route}?${query}`,
    headers: auth(token),
  });
  const body = response.json();
  return {
    status: response.statusCode,
    ids: Array.isArray(body.notes)
      ? body.notes.map((note: { id: string }) => note.id)
      : [],
    body,
  };
}

const filterParam = (filter: unknown) => JSON.stringify(filter);

async function setCrewVisible(enabled: boolean) {
  await db.prisma.operatorSetting.upsert({
    where: { key: "autoConfirmAgentMemory" },
    create: { key: "autoConfirmAgentMemory", value: String(enabled) },
    update: { value: String(enabled) },
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-memory-filter-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();

  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-filter-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-filter-a",
        chatId: "chat-A",
        brief: "chat A filter job",
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-filter-b",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-filter-b",
        chatId: "chat-B",
        brief: "chat B filter job",
        status: "running",
        dispatchedBy: "human",
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      {
        jobId: "job-filter-a",
        tokenHash: createHash("sha256").update(JOB_A_TOKEN).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
      {
        jobId: "job-filter-b",
        tokenHash: createHash("sha256").update(JOB_B_TOKEN).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
    ],
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();

  // Seed the authoritative ledger directly, then await the real projector — the
  // production recovery path — so no assertion races the fire-and-forget mirror.
  await db.prisma.$transaction([
    db.prisma.memoryNote.create({
      data: {
        id: NOTE_A,
        kind: "decision",
        text: CHAT_A_SECRET,
        textHash: "filter-a",
        scope: "project",
        trust: "high",
        status: "active",
        createdBy: "human",
        chatId: "chat-A",
        modules: [MOD],
        topics: ["alpha"],
        symbols: [],
        accessCount: 7,
      },
    }),
    db.prisma.confirmation.create({
      data: { noteId: NOTE_A, principal: "human", decision: "confirm" },
    }),
    db.prisma.memoryNote.create({
      data: {
        id: NOTE_B,
        kind: "constraint",
        text: CHAT_B_TEXT,
        textHash: "filter-b",
        scope: "project",
        trust: "high",
        status: "active",
        createdBy: "human",
        chatId: "chat-B",
        modules: [MOD],
        topics: ["bravo"],
        symbols: [],
        accessCount: 2,
      },
    }),
    db.prisma.confirmation.create({
      data: { noteId: NOTE_B, principal: "human", decision: "confirm" },
    }),
    // An UNCONFIRMED agent note in chat B, past its TTL. Crew-visible admits it
    // to chat B's reads, so it is the note R3 must hide.
    db.prisma.memoryNote.create({
      data: {
        id: NOTE_B_EXPIRED,
        kind: "attempt",
        text: CHAT_B_EXPIRED_TEXT,
        textHash: "filter-b-expired",
        scope: "project",
        trust: "medium",
        status: "active",
        createdBy: "agent:codex",
        chatId: "chat-B",
        modules: [MOD],
        topics: ["bravo"],
        symbols: [],
        expiresAt: new Date(Date.now() - DAY_MS),
      },
    }),
    db.prisma.confirmation.create({
      data: {
        noteId: NOTE_B_EXPIRED,
        principal: "agent:orchestrator:corroborated:chat-B",
        decision: "confirm",
      },
    }),
    // An UNCONFIRMED agent note in chat B with NO expiry, used to prove that a
    // filter cannot see it once crew-visible is switched off.
    db.prisma.memoryNote.create({
      data: {
        id: NOTE_B_PENDING,
        kind: "question",
        text: CHAT_B_PENDING_TEXT,
        textHash: "filter-b-pending",
        scope: "project",
        trust: "medium",
        status: "active",
        createdBy: "agent:codex",
        chatId: "chat-B",
        modules: [MOD],
        topics: ["bravo"],
        symbols: [],
      },
    }),
    db.prisma.confirmation.create({
      data: {
        noteId: NOTE_B_PENDING,
        principal: "agent:orchestrator:corroborated:chat-B",
        decision: "confirm",
      },
    }),
  ]);
  await ledger.projectLedgerToGraph();
});

afterAll(async () => {
  await app.close();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await setCrewVisible(true);
});

describe("R5 filter grammar over the route (operator scope)", () => {
  it("narrows an operator recall with every operator family", async () => {
    const all = await readNoteIds("recall", OPERATOR, { module: MOD });
    // Expired notes are hidden by default even for the operator.
    expect(all.ids.sort()).toEqual([NOTE_A, NOTE_B, NOTE_B_PENDING].sort());

    const cases: { filter: unknown; expect: string[] }[] = [
      { filter: { field: "kind", op: "eq", value: "decision" }, expect: [NOTE_A] },
      {
        filter: { field: "kind", op: "ne", value: "decision" },
        expect: [NOTE_B, NOTE_B_PENDING],
      },
      {
        filter: { field: "kind", op: "in", value: ["decision", "constraint"] },
        expect: [NOTE_A, NOTE_B],
      },
      {
        filter: { field: "kind", op: "nin", value: ["decision", "constraint"] },
        expect: [NOTE_B_PENDING],
      },
      { filter: { field: "accessCount", op: "gt", value: 5 }, expect: [NOTE_A] },
      { filter: { field: "accessCount", op: "gte", value: 7 }, expect: [NOTE_A] },
      {
        filter: { field: "accessCount", op: "lt", value: 7 },
        expect: [NOTE_B, NOTE_B_PENDING],
      },
      {
        filter: { field: "accessCount", op: "lte", value: 2 },
        expect: [NOTE_B, NOTE_B_PENDING],
      },
      {
        filter: { field: "text", op: "contains", value: "bravo-visible" },
        expect: [NOTE_B],
      },
      {
        filter: { field: "text", op: "icontains", value: "BRAVO-VISIBLE" },
        expect: [NOTE_B],
      },
      { filter: { field: "confirmed", op: "eq", value: true }, expect: [NOTE_A, NOTE_B] },
      { filter: { field: "topics", op: "in", value: ["alpha"] }, expect: [NOTE_A] },
      {
        filter: { field: "modules", op: "contains", value: "billing" },
        expect: [NOTE_A, NOTE_B, NOTE_B_PENDING],
      },
      {
        filter: {
          and: [
            { field: "confirmed", op: "eq", value: true },
            { field: "trust", op: "eq", value: "high" },
            { not: { field: "kind", op: "eq", value: "decision" } },
          ],
        },
        expect: [NOTE_B],
      },
      {
        filter: {
          or: [
            { field: "kind", op: "eq", value: "decision" },
            { field: "kind", op: "eq", value: "question" },
          ],
        },
        expect: [NOTE_A, NOTE_B_PENDING],
      },
      {
        filter: { field: "createdAt", op: "gt", value: "2000-01-01T00:00:00Z" },
        expect: [NOTE_A, NOTE_B, NOTE_B_PENDING],
      },
      {
        filter: { field: "createdAt", op: "lt", value: "2000-01-01T00:00:00Z" },
        expect: [],
      },
    ];
    for (const testCase of cases) {
      const result = await readNoteIds("recall", OPERATOR, {
        module: MOD,
        filter: filterParam(testCase.filter),
      });
      expect(result.status).toBe(200);
      expect(result.ids.sort()).toEqual([...testCase.expect].sort());
    }
  });

  it("refuses a malformed, out-of-grammar, or oversized filter with 400", async () => {
    const refusals = [
      filterParam({ field: "textHash", op: "eq", value: "x" }),
      filterParam({ field: "kind", op: "regex", value: ".*" }),
      filterParam({ field: "kind", op: "gt", value: "a" }),
      filterParam({ not: { not: { not: { not: { field: "kind", op: "eq", value: "x" } } } } }),
      "not-json",
      "x".repeat(5_000),
    ];
    for (const filter of refusals) {
      const result = await readNoteIds("recall", OPERATOR, {
        module: MOD,
        filter,
      });
      expect(result.status).toBe(400);
    }
  });

  it("also narrows the library and the search route", async () => {
    const library = await app.inject({
      method: "GET",
      url: `/api/memory/library?filter=${encodeURIComponent(
        filterParam({ field: "kind", op: "eq", value: "constraint" })
      )}`,
      headers: auth(OPERATOR),
    });
    expect(library.statusCode).toBe(200);
    expect(
      library.json().notes.map((note: { id: string }) => note.id)
    ).toEqual([NOTE_B]);

    const search = await readNoteIds("search", OPERATOR, {
      q: "bravo visible invoice rounding",
      filter: filterParam({ field: "kind", op: "eq", value: "constraint" }),
    });
    expect(search.status).toBe(200);
    expect(search.ids).toContain(NOTE_B);
    expect(search.ids).not.toContain(NOTE_A);
  });
});

describe("R5 filter grammar — hostile values", () => {
  it("treats SQL / Cypher injection payloads as inert literals", async () => {
    const payloads = [
      "' OR 1=1 --",
      "'; DROP TABLE MemoryNote; --",
      "\") RETURN n MATCH (m:MemoryNote) RETURN m.text //",
      // SQL LIKE wildcards and a regex wildcard: literal characters here, so
      // each matches nothing rather than everything.
      "%",
      "_",
      ".*",
    ];
    for (const payload of payloads) {
      const result = await readNoteIds("recall", OPERATOR, {
        module: MOD,
        filter: filterParam({ field: "text", op: "contains", value: payload }),
      });
      expect(result.status).toBe(200);
      // No payload matches anything, and none widens the result set: SQL
      // wildcards are literal characters here, and no query string is built.
      expect(result.ids).toEqual([]);
    }
    // The control: a payload that IS a literal substring of the seeded text
    // does match. That is what proves the wildcards above were inert rather
    // than merely unlucky — comparison is String.includes, nothing else.
    const literal = await readNoteIds("recall", OPERATOR, {
      module: MOD,
      filter: filterParam({
        field: "text",
        op: "contains",
        value: "invoice rounding",
      }),
    });
    expect(literal.ids).toEqual([NOTE_B]);
    // The ledger survived every payload intact.
    expect(await db.prisma.memoryNote.count()).toBeGreaterThanOrEqual(4);
  });
});

describe("R5 filter grammar — cross-scope leak attempts", () => {
  it("cannot confirm a foreign chat's note through ANY predicate", async () => {
    const probes: unknown[] = [
      { field: "text", op: "contains", value: CHAT_A_SECRET },
      { field: "text", op: "icontains", value: "quebec-sierra" },
      { field: "text", op: "ne", value: CHAT_A_SECRET },
      { field: "chatId", op: "eq", value: "chat-A" },
      { field: "chatId", op: "ne", value: "chat-B" },
      { field: "topics", op: "in", value: ["alpha"] },
      { field: "accessCount", op: "gte", value: 7 },
      { not: { field: "chatId", op: "eq", value: "chat-B" } },
      { or: [{ field: "chatId", op: "eq", value: "chat-A" }, { field: "kind", op: "eq", value: "decision" }] },
    ];
    for (const filter of probes) {
      const result = await readNoteIds("recall", JOB_B_TOKEN, {
        module: MOD,
        chatId: "chat-B",
        filter: filterParam(filter),
      });
      expect(result.status).toBe(200);
      // Chat A's note is never returned, and no probe distinguishes it: the
      // filter runs on a set the chat-B caller was already handed.
      expect(result.ids).not.toContain(NOTE_A);
      for (const id of result.ids) {
        expect([NOTE_B, NOTE_B_PENDING]).toContain(id);
      }
    }
  });

  it("cannot confirm a foreign chat's note through /search either", async () => {
    // Same probe, different route: the narrowing helper is shared, so the
    // guarantee must be observable on every read surface, not just recall.
    const bySecret = await readNoteIds("search", JOB_B_TOKEN, {
      q: "quebec sierra private charge window",
      chatId: "chat-B",
      filter: filterParam({
        field: "text",
        op: "contains",
        value: CHAT_A_SECRET,
      }),
    });
    const byNonsense = await readNoteIds("search", JOB_B_TOKEN, {
      q: "quebec sierra private charge window",
      chatId: "chat-B",
      filter: filterParam({
        field: "text",
        op: "contains",
        value: "no-such-string-was-ever-written",
      }),
    });
    expect(bySecret.ids).not.toContain(NOTE_A);
    expect(bySecret.body).toEqual(byNonsense.body);
  });

  it("cannot use a text predicate to probe a note whose text is gated", async () => {
    // Crew-visible OFF ⇒ chat B's UNCONFIRMED note is outside the caller's
    // governed scope entirely. A predicate naming its exact text must be
    // indistinguishable from a predicate naming a string nobody ever wrote.
    await setCrewVisible(false);
    const baseline = await readNoteIds("recall", JOB_B_TOKEN, {
      module: MOD,
      chatId: "chat-B",
    });
    expect(baseline.ids).toEqual([NOTE_B]);

    const onGatedText = await readNoteIds("recall", JOB_B_TOKEN, {
      module: MOD,
      chatId: "chat-B",
      filter: filterParam({
        field: "text",
        op: "contains",
        value: "romeo-tango",
      }),
    });
    const onNonsense = await readNoteIds("recall", JOB_B_TOKEN, {
      module: MOD,
      chatId: "chat-B",
      filter: filterParam({
        field: "text",
        op: "contains",
        value: "no-such-string-was-ever-written",
      }),
    });
    expect(onGatedText.ids).toEqual([]);
    expect(onGatedText.ids).toEqual(onNonsense.ids);
    expect(onGatedText.body).toEqual(onNonsense.body);
  });

  it("cannot widen an agent read with a negated or always-true predicate", async () => {
    const alwaysTrue = await readNoteIds("recall", JOB_B_TOKEN, {
      module: MOD,
      chatId: "chat-B",
      filter: filterParam({
        not: { field: "kind", op: "eq", value: "no-such-kind" },
      }),
    });
    const unfiltered = await readNoteIds("recall", JOB_B_TOKEN, {
      module: MOD,
      chatId: "chat-B",
    });
    // A tautology returns exactly the caller's own governed set — never more.
    expect(alwaysTrue.ids.sort()).toEqual(unfiltered.ids.sort());
    expect(alwaysTrue.ids).not.toContain(NOTE_A);
  });

  it("keeps the partition check ahead of the filter for a forged chatId", async () => {
    const forged = await app.inject({
      method: "GET",
      url: `/api/memory/recall?module=${encodeURIComponent(
        MOD
      )}&chatId=chat-A&filter=${encodeURIComponent(
        filterParam({ field: "text", op: "contains", value: CHAT_A_SECRET })
      )}`,
      headers: auth(JOB_B_TOKEN),
    });
    // The capability check refuses before any filter work happens.
    expect(forged.statusCode).toBe(403);
  });
});

describe("R3 TTL policy + sweep are operator-governed", () => {
  it("refuses the policy read, the policy write, and the sweep to the agent tier", async () => {
    for (const call of [
      { method: "GET" as const, url: "/api/memory/settings/memory-ttl" },
      {
        method: "PUT" as const,
        url: "/api/memory/settings/memory-ttl",
        payload: { days: 0, trustCeiling: "medium" },
      },
      { method: "POST" as const, url: "/api/memory/sweep-expired" },
    ]) {
      const response = await app.inject({ ...call, headers: auth(JOB_B_TOKEN) });
      expect(response.statusCode).toBe(403);
    }
  });

  it("lets the operator read and set a bounded policy and refuses an illegal one", async () => {
    const read = await app.inject({
      method: "GET",
      url: "/api/memory/settings/memory-ttl",
      headers: auth(OPERATOR),
    });
    expect(read.json()).toEqual({ days: 30, trustCeiling: "medium" });

    const set = await app.inject({
      method: "PUT",
      url: "/api/memory/settings/memory-ttl",
      headers: auth(OPERATOR),
      payload: { days: 14, trustCeiling: "low" },
    });
    expect(set.json()).toEqual({ days: 14, trustCeiling: "low" });

    for (const payload of [
      { days: -1 },
      { days: 3_651 },
      { days: 1.5 },
      // "high" is not a legal ceiling: a high-trust note never auto-expires.
      { days: 10, trustCeiling: "high" },
    ]) {
      const bad = await app.inject({
        method: "PUT",
        url: "/api/memory/settings/memory-ttl",
        headers: auth(OPERATOR),
        payload,
      });
      expect(bad.statusCode).toBe(400);
    }

    // Restore the default so the expiry assertions below are unaffected.
    await app.inject({
      method: "PUT",
      url: "/api/memory/settings/memory-ttl",
      headers: auth(OPERATOR),
      payload: { days: 30, trustCeiling: "medium" },
    });
  });
});

describe("R3 show_expired over the route", () => {
  it("hides an expired crew-visible note from an agent and ignores its opt-in", async () => {
    const plain = await readNoteIds("recall", JOB_B_TOKEN, {
      module: MOD,
      chatId: "chat-B",
    });
    expect(plain.ids.sort()).toEqual([NOTE_B, NOTE_B_PENDING].sort());
    expect(plain.ids).not.toContain(NOTE_B_EXPIRED);

    // An agent asking to see expired memory is silently downgraded, exactly like
    // `trustFloor` on the hero gate: the knob is a human review affordance.
    const optIn = await readNoteIds("recall", JOB_B_TOKEN, {
      module: MOD,
      chatId: "chat-B",
      showExpired: "true",
    });
    expect(optIn.ids).toEqual(plain.ids);
  });

  it("returns the expired note to the operator on explicit opt-in only", async () => {
    const hidden = await readNoteIds("recall", OPERATOR, { module: MOD });
    expect(hidden.ids).not.toContain(NOTE_B_EXPIRED);

    // A non-"true" value never opts in (`z.coerce.boolean("false")` would).
    const falsy = await readNoteIds("recall", OPERATOR, {
      module: MOD,
      showExpired: "false",
    });
    expect(falsy.ids).not.toContain(NOTE_B_EXPIRED);

    const shown = await readNoteIds("recall", OPERATOR, {
      module: MOD,
      showExpired: "true",
    });
    expect(shown.ids).toContain(NOTE_B_EXPIRED);
    const expired = (shown.body.notes as { id: string; expired: boolean }[]).find(
      (note) => note.id === NOTE_B_EXPIRED
    );
    expect(expired?.expired).toBe(true);
  });

  it("keeps an expired crew-visible note out of the hero pre-edit gate", async () => {
    const gate = await app.inject({
      method: "POST",
      url: "/api/memory/preedit",
      headers: auth(JOB_B_TOKEN),
      payload: { module: MOD, chatId: "chat-B" },
    });
    expect(gate.statusCode).toBe(200);
    const ids = gate
      .json()
      .memories.map((note: { id: string }) => note.id) as string[];
    expect(ids).not.toContain(NOTE_B_EXPIRED);
    expect(ids).not.toContain(NOTE_A);
    expect(ids).toContain(NOTE_B);
  });

  it("withholds an expired note's TEXT one hop away on the traversal surfaces", async () => {
    const neighbors = await app.inject({
      method: "GET",
      url: `/api/memory/neighbors/${encodeURIComponent(
        `note:${NOTE_B_EXPIRED}`
      )}?hops=1&chatId=chat-B`,
      headers: auth(JOB_B_TOKEN),
    });
    expect(neighbors.statusCode).toBe(200);
    const node = (
      neighbors.json().nodes as {
        entityId: string;
        type: string;
        text?: string;
      }[]
    ).find((entry) => entry.entityId === NOTE_B_EXPIRED);
    // Coordinates survive (the path stays walkable); the prose does not.
    expect(node).toBeDefined();
    expect(node?.text).toBeUndefined();

    // The control: an identically-governed but NON-expired unconfirmed note in
    // the same chat DOES carry its text here, so the assertion above is about
    // expiry rather than about the crew-visible gate already withholding it.
    const control = await app.inject({
      method: "GET",
      url: `/api/memory/neighbors/${encodeURIComponent(
        `note:${NOTE_B_PENDING}`
      )}?hops=1&chatId=chat-B`,
      headers: auth(JOB_B_TOKEN),
    });
    const controlNode = (
      control.json().nodes as { entityId: string; text?: string }[]
    ).find((entry) => entry.entityId === NOTE_B_PENDING);
    expect(controlNode?.text).toBe(CHAT_B_PENDING_TEXT);

    const explain = await app.inject({
      method: "GET",
      url: `/api/memory/explain/${encodeURIComponent(
        NOTE_B_EXPIRED
      )}?chatId=chat-B`,
      headers: auth(JOB_B_TOKEN),
    });
    expect(explain.statusCode).toBe(200);
    const onPath = (
      explain.json().path.nodes as {
        entityId: string;
        text?: string;
      }[]
    ).find((entry) => entry.entityId === NOTE_B_EXPIRED);
    expect(onPath?.text).toBeUndefined();
  });

  it("restores the note to recall the moment a human confirms it", async () => {
    await ledger.updateMemoryNote(NOTE_B_EXPIRED, {
      confirmed: true,
      principal: "human:alice",
    });
    await ledger.projectLedgerToGraph();
    const after = await readNoteIds("recall", JOB_B_TOKEN, {
      module: MOD,
      chatId: "chat-B",
    });
    expect(after.ids).toContain(NOTE_B_EXPIRED);
    const row = await db.prisma.memoryNote.findUniqueOrThrow({
      where: { id: NOTE_B_EXPIRED },
    });
    expect(row.expiresAt).toBeNull();
  });
});
