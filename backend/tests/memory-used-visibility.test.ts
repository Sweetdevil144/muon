import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// ── L3: REINFORCEMENT FOLLOWS VISIBILITY ─────────────────────────────────────
//
// `POST /api/memory/used` used to reinforce any note in the caller's partition,
// including one already past its R3 deadline. The old judgement was that this is
// inert because an expired note is hidden from recall anyway — but `accessCount`
// is not inert: it feeds `usageNorm` in the calibrated ranker. A note could
// therefore accumulate ranking weight for weeks while NOBODY could see it, and
// then land PRE-BOOSTED the instant a human confirmed it (confirming clears the
// expiry). That turns confirmation from a neutral act into a rewarded one.
//
// The chosen behaviour is to REFUSE the bump rather than record it without
// effect: nothing is stored, the `buffered` count says so, and the signal is
// legitimate again the moment the note is confirmed — the same redemption path
// every other memory gate uses.
//
// The corollary runs the other way too, and is the reason this file also covers
// a model-mined note: reinforcement must follow visibility UP as well as down.
// A mined note is now crew-visible under the operator's `autoConfirmAgentMemory`
// posture like any other agent note, so refusing its bump would mean the ranker
// never learns that the one note the crew actually used was useful. What decides
// is the posture, never the author.
//
// Real SQLite ledger + real graph + real routes: an accounting rule that only
// holds against a mock is not a rule.

const OPERATOR = "operator-token-used-visibility";
const AGENT = "agent-token-used-visibility";
const JOB_TOKEN = `job-used-visibility-${"u".repeat(44)}`;
const CHAT = "chat-used-visibility";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;

const LIVE_ID = "mem-used-live";
const EXPIRED_ID = "mem-used-expired";
const MINED_ID = "mem-used-mined";
const CONFIRMED_ID = "mem-used-confirmed";
const PAST = new Date("2020-01-01T00:00:00.000Z");

async function seedNote(input: {
  id: string;
  createdBy: string;
  expiresAt?: Date;
}) {
  await db.prisma.memoryNote.create({
    data: {
      id: input.id,
      kind: "attempt",
      text: `used-visibility fixture ${input.id}`,
      textHash: `used-visibility-${input.id}`,
      scope: "project",
      trust: "medium",
      status: "active",
      createdBy: input.createdBy,
      chatId: CHAT,
      modules: ["src/used/visibility.ts"],
      topics: [],
      symbols: [],
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    },
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-used-visibility-"));
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

  await db.prisma.dispatchJob.create({
    data: {
      id: "job-used-visibility",
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-used-visibility",
      chatId: CHAT,
      brief: "reinforcement work",
      status: "running",
      dispatchedBy: "human",
    },
  });
  await db.prisma.delegationGrant.create({
    data: {
      jobId: "job-used-visibility",
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();

  await seedNote({ id: LIVE_ID, createdBy: "agent:codex" });
  await seedNote({
    id: EXPIRED_ID,
    createdBy: "agent:codex",
    expiresAt: PAST,
  });
  await seedNote({ id: MINED_ID, createdBy: "muon-extractor" });
  await seedNote({ id: CONFIRMED_ID, createdBy: "agent:codex" });
  await db.prisma.confirmation.create({
    data: { noteId: CONFIRMED_ID, principal: "human", decision: "confirm" },
  });
  await db.prisma.confirmation.createMany({
    data: [LIVE_ID, EXPIRED_ID, MINED_ID].map((noteId) => ({
      noteId,
      principal: `agent:orchestrator:corroborated:${CHAT}`,
      decision: "confirm",
    })),
  });
  await ledger.projectLedgerToGraph();

  // Crew visibility ON — the widest agent posture, so every refusal below is the
  // narrowing under test and not the crew toggle doing the work.
  const on = await app.inject({
    method: "PUT",
    url: "/api/memory/settings/auto-confirm-agent-memory",
    headers: auth(OPERATOR),
    payload: { enabled: true },
  });
  expect(on.statusCode).toBe(200);
});

afterAll(async () => {
  // Let the confirm PATCH's fire-and-forget graph mirror land before the store
  // closes; the ledger is authoritative either way, this only keeps teardown quiet.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await app.close();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function markUsed(
  token: string,
  noteIds: string[],
  accessType?: "brief_injection" | "explicit_recall" | "preedit_gate"
): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/api/memory/used",
    headers: auth(token),
    payload: { noteIds, ...(accessType ? { accessType } : {}) },
  });
  expect(res.statusCode).toBe(202);
  return res.json().buffered as number;
}

/** The durable ledger's count — what the ranker will eventually read. */
async function accessCountOf(id: string): Promise<number> {
  const row = await db.prisma.memoryNote.findUniqueOrThrow({ where: { id } });
  return row.accessCount;
}

describe("L3 — an expired note cannot accrue hidden reinforcement", () => {
  it("REFUSES the bump for an expired note and accepts it for a live one", async () => {
    expect(await markUsed(JOB_TOKEN, [EXPIRED_ID])).toBe(0);
    // The control: same chat, same author, same trust — only the deadline
    // differs — so the refusal is expiry and nothing else.
    expect(await markUsed(JOB_TOKEN, [LIVE_ID], "preedit_gate")).toBe(1);
    expect(
      await db.prisma.memoryAccess.findFirst({
        where: { noteId: EXPIRED_ID },
      })
    ).toBeNull();
    expect(
      await db.prisma.memoryAccess.findFirstOrThrow({
        where: { noteId: LIVE_ID, accessType: "preedit_gate" },
      })
    ).toMatchObject({
      principal: "agent:job:job-used-visibility",
      taskId: "task-used-visibility",
      jobId: "job-used-visibility",
      missionId: CHAT,
    });
  });

  it("does not silently store the refused signal (the ledger never sees it)", async () => {
    await markUsed(JOB_TOKEN, [EXPIRED_ID, LIVE_ID]);
    await ledger.flushMemoryReinforcement();
    expect(await accessCountOf(EXPIRED_ID)).toBe(0);
    expect(await accessCountOf(LIVE_ID)).toBeGreaterThan(0);
  });

  it("CONFIRMING redeems it: the note stops being expired and reinforcement counts again", async () => {
    // The redemption path, and the reason refusing is not data loss. Note that
    // the count starts from zero — confirmation is neutral, not pre-boosted,
    // which is the property the whole change exists to protect.
    expect(await accessCountOf(EXPIRED_ID)).toBe(0);
    const confirm = await app.inject({
      method: "PATCH",
      url: `/api/memory/${EXPIRED_ID}`,
      headers: auth(OPERATOR),
      payload: { confirmed: true },
    });
    expect(confirm.statusCode).toBe(200);

    expect(await markUsed(JOB_TOKEN, [EXPIRED_ID])).toBe(1);
    await ledger.flushMemoryReinforcement();
    expect(await accessCountOf(EXPIRED_ID)).toBeGreaterThan(0);
  });
});

describe("L3 — reinforcement tracks the crew POSTURE, not the author", () => {
  it("ACCEPTS the bump for a mined note with crew visibility ON", async () => {
    // The agent could read this note's text on every gate surface under this
    // posture, so a bump on it is an honest usage signal — refusing it would
    // hide the ranker from the one note the crew actually used.
    expect(await markUsed(JOB_TOKEN, [MINED_ID])).toBe(1);
    await ledger.flushMemoryReinforcement();
    expect(await accessCountOf(MINED_ID)).toBeGreaterThan(0);
  });

  it("REFUSES it with the posture OFF — for the mined note AND its ordinary peer", async () => {
    // The narrowing that matters is the posture, and it must bite uniformly:
    // under OFF an agent can read neither, so it may reinforce neither.
    const off = await app.inject({
      method: "PUT",
      url: "/api/memory/settings/auto-confirm-agent-memory",
      headers: auth(OPERATOR),
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    try {
      const before = await accessCountOf(MINED_ID);
      expect(await markUsed(JOB_TOKEN, [MINED_ID, LIVE_ID])).toBe(0);
      await ledger.flushMemoryReinforcement();
      expect(await accessCountOf(MINED_ID)).toBe(before);
      // …but a human-CONFIRMED note is readable under every posture, so its
      // bump still counts. Without this the refusal above could be the route
      // failing closed on everything.
      expect(await markUsed(JOB_TOKEN, [CONFIRMED_ID])).toBe(1);
    } finally {
      await app.inject({
        method: "PUT",
        url: "/api/memory/settings/auto-confirm-agent-memory",
        headers: auth(OPERATOR),
        payload: { enabled: true },
      });
    }
  });

  it("still accepts a confirmed note and an ordinary crew note (no over-narrowing)", async () => {
    expect(await markUsed(JOB_TOKEN, [CONFIRMED_ID, LIVE_ID])).toBe(2);
  });
});

describe("TODO 4.12 access analytics governance", () => {
  it("keeps text-free cohorts operator-only and workspace-fenced", async () => {
    const denied = await app.inject({
      method: "GET",
      url: "/api/memory/analytics/access-types?unscoped=true",
      headers: auth(JOB_TOKEN),
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/memory/analytics/access-types?unscoped=true",
      headers: auth(OPERATOR),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      retainedPerNote: 128,
      interpretation: "association_not_causation",
    });
    expect(JSON.stringify(allowed.json())).not.toContain(
      "used-visibility fixture"
    );
  });
});
