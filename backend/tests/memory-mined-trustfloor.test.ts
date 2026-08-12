import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// ── ONE POSTURE DECIDES, END TO END ──────────────────────────────────────────
//
// `autoConfirmAgentMemory` is the single operator switch for "may unconfirmed
// agent memory reach the crew". Model-mined notes (`muon-extractor`) used to be
// carved out of it by F9 and are not any more, so this file's job is to prove —
// against the REAL ledger, the REAL graph and the REAL routes — that:
//
//   • ON  → a mined note and an ordinary agent note behave IDENTICALLY in an
//           agent's gate view. Neither is confirmed; both are readable.
//   • OFF → both disappear. The strict confirmed-only gate is genuinely strict,
//           not "strict except for the author we happened to allow".
//   • `trustFloor` never carries either of them to an agent under ANY posture.
//     The floor lowers the gate to admit lower-trust text, so it is a HUMAN
//     review affordance; the route honours it for the operator tier only, and
//     the two credentials are separate (backend/src/lib/auth.ts) — a dispatched
//     agent holds a job capability that can never resolve to operator.
//
// Written to FAIL if any of that is opened: if the route stops downgrading an
// agent's `trustFloor`, the agent cases start returning prose; if the floor
// stops admitting ordinary low-trust notes, the operator control goes empty and
// the agent assertions turn vacuous — the failure mode a bare "agent sees
// nothing" test would have hidden.

const OPERATOR = "operator-token-mined-floor";
const AGENT = "agent-token-mined-floor";
const JOB_TOKEN = `job-mined-floor-${"f".repeat(48)}`;
const MOD = "src/billing/refund.ts";
const CHAT = "chat-mined-floor";
const OTHER_CHAT = "chat-mined-floor-other";
const MINED_TEXT = "Refunds are keyed by charge id sierra-tango";
const AGENT_TEXT = "Refund retries need a backoff victor-november";
const FOREIGN_TEXT = "Refunds settle nightly in another chat whiskey-xray";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;

const MINED_ID = "mem-floor-mined";
const AGENT_ID = "mem-floor-agent";
const FOREIGN_ID = "mem-floor-foreign";

async function setCrewVisible(enabled: boolean): Promise<void> {
  const res = await app.inject({
    method: "PUT",
    url: "/api/memory/settings/auto-confirm-agent-memory",
    headers: auth(OPERATOR),
    payload: { enabled },
  });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-mined-floor-"));
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
      id: "job-mined-floor",
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-mined-floor",
      chatId: CHAT,
      brief: "refund work",
      status: "running",
      dispatchedBy: "human",
    },
  });
  await db.prisma.delegationGrant.create({
    data: {
      jobId: "job-mined-floor",
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();

  // Two UNCONFIRMED, LOW-trust, same-chat notes on the same anchor differing in
  // exactly one field — the AUTHOR — plus a third that differs only by CHAT.
  // Every assertion below is therefore about authorship or partition and nothing
  // else.
  await db.prisma.$transaction([
    db.prisma.memoryNote.create({
      data: {
        id: MINED_ID,
        kind: "decision",
        text: MINED_TEXT,
        textHash: "mined-floor-1",
        scope: "project",
        trust: "low",
        status: "active",
        createdBy: "muon-extractor",
        chatId: CHAT,
        modules: [MOD],
        topics: [],
        symbols: [],
      },
    }),
    db.prisma.memoryNote.create({
      data: {
        id: AGENT_ID,
        kind: "attempt",
        text: AGENT_TEXT,
        textHash: "mined-floor-2",
        scope: "project",
        trust: "low",
        status: "active",
        createdBy: "agent:codex",
        chatId: CHAT,
        modules: [MOD],
        topics: [],
        symbols: [],
      },
    }),
    db.prisma.memoryNote.create({
      data: {
        id: FOREIGN_ID,
        kind: "decision",
        text: FOREIGN_TEXT,
        textHash: "mined-floor-3",
        scope: "project",
        trust: "low",
        status: "active",
        createdBy: "muon-extractor",
        chatId: OTHER_CHAT,
        modules: [MOD],
        topics: [],
        symbols: [],
      },
    }),
    db.prisma.confirmation.createMany({
      data: [MINED_ID, AGENT_ID].map((noteId) => ({
        noteId,
        principal: `agent:orchestrator:corroborated:${CHAT}`,
        decision: "confirm",
      })),
    }),
    db.prisma.confirmation.create({
      data: {
        noteId: FOREIGN_ID,
        principal: `agent:orchestrator:corroborated:${OTHER_CHAT}`,
        decision: "confirm",
      },
    }),
  ]);
  await ledger.projectLedgerToGraph();

  await setCrewVisible(false);
});

afterAll(async () => {
  await app.close();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function preedit(
  token: string,
  payload: Record<string, unknown>
): Promise<{
  ids: string[];
  findingIds: string[];
  body: string;
  memories: { id: string; confirmed?: boolean }[];
  crewFindings: { id: string; confirmed?: boolean; authority?: string }[];
}> {
  const res = await app.inject({
    method: "POST",
    url: "/api/memory/preedit",
    headers: auth(token),
    payload,
  });
  expect(res.statusCode).toBe(200);
  const memories = res.json().memories as { id: string; confirmed?: boolean }[];
  const crewFindings = res.json().crewFindings as {
    id: string;
    confirmed?: boolean;
    authority?: string;
  }[];
  return {
    ids: memories.map((note) => note.id),
    findingIds: crewFindings.map((note) => note.id),
    body: res.body,
    memories,
    crewFindings,
  };
}

describe("crew posture ON — a mined note reaches the agent like any other", () => {
  beforeAll(() => setCrewVisible(true));
  afterAll(() => setCrewVisible(false));

  it("surfaces BOTH same-chat notes as information, never edit-gate memory", async () => {
    const { ids, findingIds, body, crewFindings } = await preedit(JOB_TOKEN, {
      module: MOD,
      chatId: CHAT,
    });
    expect(ids).toEqual([]);
    expect(findingIds).toContain(MINED_ID);
    expect(findingIds).toContain(AGENT_ID);
    expect(body).toContain(MINED_TEXT);
    expect(body).toContain(AGENT_TEXT);
    // The founder's ask was "stop making me review every note before it is
    // usable" — NOT "treat it as reviewed". `confirmed` still requires a human.
    for (const note of crewFindings.filter((row) =>
      [MINED_ID, AGENT_ID].includes(row.id)
    )) {
      expect(note.confirmed).toBe(false);
      expect(note.authority).toBe("inform");
    }
  });

  it("records only attributed orchestrator vouches, never human confirmation", async () => {
    await preedit(JOB_TOKEN, { module: MOD, chatId: CHAT });
    const confirmations = await db.prisma.confirmation.findMany({
      where: { noteId: { in: [MINED_ID, AGENT_ID] } },
    });
    expect(confirmations).toHaveLength(2);
    expect(
      confirmations.every((row) =>
        row.principal.startsWith("agent:orchestrator:corroborated:")
      )
    ).toBe(true);
  });

  it("does NOT cross the chat partition, mined or not", async () => {
    const { ids, findingIds, body } = await preedit(JOB_TOKEN, {
      module: MOD,
      chatId: CHAT,
    });
    expect(ids).not.toContain(FOREIGN_ID);
    expect(findingIds).not.toContain(FOREIGN_ID);
    expect(body).not.toContain(FOREIGN_TEXT);
  });

  it("reaches the agent through /search and /recall too, not just the gate", async () => {
    // The hero gate is one surface; an agent's ordinary lookups are the ones it
    // makes all day. All three resolve the posture independently, so all three
    // are asserted.
    for (const url of [
      `/api/memory/search?q=${encodeURIComponent("refund")}`,
      `/api/memory/recall?module=${encodeURIComponent(MOD)}`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: auth(JOB_TOKEN) });
      expect(res.statusCode).toBe(200);
      const notes = res.json().notes as { id: string; confirmed: boolean }[];
      const ids = notes.map((note) => note.id);
      expect(ids).toContain(MINED_ID);
      expect(ids).toContain(AGENT_ID);
      // Same two invariants as the gate: unconfirmed, and in-chat only.
      expect(notes.find((note) => note.id === MINED_ID)?.confirmed).toBe(false);
      expect(ids).not.toContain(FOREIGN_ID);
      expect(res.body).not.toContain(FOREIGN_TEXT);
    }
  });

  it("still ignores an agent-supplied trustFloor (it is a human affordance)", async () => {
    // The crew branch is what admits these notes; the floor must contribute
    // nothing. If it were ever honoured, the OFF case below would stop failing
    // closed.
    const { ids, findingIds } = await preedit(JOB_TOKEN, {
      module: MOD,
      chatId: CHAT,
      trustFloor: "low",
    });
    expect(ids).toEqual([]);
    expect(findingIds).toContain(MINED_ID);
    expect(findingIds).toContain(AGENT_ID);
    expect(findingIds).not.toContain(FOREIGN_ID);
  });
});

describe("crew posture OFF — the strict gate returns for EVERY agent author", () => {
  it("gives the agent NEITHER note, mined or ordinary", async () => {
    const { ids, findingIds, body } = await preedit(JOB_TOKEN, {
      module: MOD,
      chatId: CHAT,
    });
    expect(ids).toEqual([]);
    expect(findingIds).toEqual([]);
    expect(body).not.toContain(MINED_TEXT);
    expect(body).not.toContain(AGENT_TEXT);
  });

  it("AGENT + trustFloor:'low' still gets neither — the floor never reaches the gate", async () => {
    const { ids, findingIds, body } = await preedit(JOB_TOKEN, {
      module: MOD,
      chatId: CHAT,
      trustFloor: "low",
    });
    expect(ids).not.toContain(MINED_ID);
    expect(ids).not.toContain(AGENT_ID);
    expect(findingIds).toEqual([]);
    expect(body).not.toContain(MINED_TEXT);
    expect(body).not.toContain(AGENT_TEXT);
  });

  it("AGENT + trustFloor:'high' is likewise inert (no floor value is honoured)", async () => {
    const { ids, findingIds } = await preedit(JOB_TOKEN, {
      module: MOD,
      chatId: CHAT,
      trustFloor: "high",
    });
    expect(ids).toEqual([]);
    expect(findingIds).toEqual([]);
  });

  it("closes /search and /recall as well — the strict posture is not gate-only", async () => {
    for (const url of [
      `/api/memory/search?q=${encodeURIComponent("refund")}`,
      `/api/memory/recall?module=${encodeURIComponent(MOD)}`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: auth(JOB_TOKEN) });
      expect(res.statusCode).toBe(200);
      const ids = (res.json().notes as { id: string }[]).map((note) => note.id);
      expect(ids).not.toContain(MINED_ID);
      expect(ids).not.toContain(AGENT_ID);
      expect(ids).not.toContain(FOREIGN_ID);
      expect(res.body).not.toContain(MINED_TEXT);
      expect(res.body).not.toContain(AGENT_TEXT);
    }
  });
});

describe("the OPERATOR keeps the review view under both postures", () => {
  it("OPERATOR + trustFloor:'low' admits BOTH notes with text (the control)", async () => {
    // Mining exists so a HUMAN can review the prose. A floor that hid it from
    // the operator would make the review queue useless — and would make every
    // "the agent sees nothing" assertion above vacuous.
    const { ids, body } = await preedit(OPERATOR, {
      module: MOD,
      chatId: CHAT,
      trustFloor: "low",
    });
    expect(ids).toContain(MINED_ID);
    expect(ids).toContain(AGENT_ID);
    expect(body).toContain(MINED_TEXT);
    expect(body).toContain(AGENT_TEXT);
  });

  it("OPERATOR without a floor gets neither — so the floor, not the tier, admitted them", async () => {
    const { ids } = await preedit(OPERATOR, { module: MOD, chatId: CHAT });
    expect(ids).not.toContain(MINED_ID);
    expect(ids).not.toContain(AGENT_ID);
  });
});
