import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VENDOR_IDS, VENDOR_REGISTRY } from "@muon/protocol";
import type { FastifyInstance } from "fastify";

// ── S7: chat delete = operator-gated SOFT archive ────────────────────────────
//
// End-to-end against a REAL temp-SQLite brain (graph mocked, no network). The
// founder ask is "delete a chat", but hard delete is architecturally
// destructive (FD-2): ApprovalRequest FK-cascades on the chat's shadow Task,
// and StreamChunks are conversation provenance. So delete is a SOFT archive:
//   • DELETE /:chatId is OPERATOR-tier (an agent-tier caller is 403'd) and only
//     flips status→"archived"; it never removes a row.
//   • the audit ledger (shadow Task, StreamChunks, Events, ApprovalRequests)
//     SURVIVES the archive untouched.
//   • archived chats drop out of the default list but stay fetchable by id and
//     via ?status=archived|all.
//   • a shared agent bearer cannot write coordinator continuity; only the exact
//     active root capability may persist a provider-bound resume handle.

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const OPERATOR = "operator-token-chats-s7";
const AGENT = "agent-token-chats-s7";

type Db = typeof import("../src/lib/db.js");

let app: FastifyInstance;
let prisma: Db["prisma"];
let dataDir: string;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function makeChat(title: string, workspacePath = "/tmp/ws") {
  const res = await app.inject({
    method: "POST",
    url: "/api/chats",
    headers: auth(OPERATOR),
    payload: { title, workspacePath },
  });
  expect(res.statusCode).toBe(201);
  return res.json().chat as {
    id: string;
    taskId: string | null;
    status: string;
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-chats-s7-"));
  process.env.DATABASE_URL = `file:${path.join(dataDir, "muon.db")}`;
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  const { buildApp } = await import("../src/app.js");
  app = buildApp();
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("S7: DELETE /api/chats/:chatId is operator-gated soft archive", () => {
  it("agent tier → 403; the chat is NOT mutated (stays active)", async () => {
    const chat = await makeChat("agent cannot delete");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
      headers: auth(AGENT),
    });
    expect(res.statusCode).toBe(403);
    const after = await prisma.orchestratorChat.findUnique({
      where: { id: chat.id },
    });
    expect(after?.status).toBe("active");
  });

  it("operator tier → 200 and the chat flips to archived (row survives)", async () => {
    const chat = await makeChat("operator archives");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().chat.status).toBe("archived");
    // The row is still there, just archived, never deleted.
    const after = await prisma.orchestratorChat.findUnique({
      where: { id: chat.id },
    });
    expect(after).not.toBeNull();
    expect(after?.status).toBe("archived");
  });

  it("DELETE on an unknown chat id → 404 (never a silent 200)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/chats/does-not-exist",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses to hide active work and permanently closes dispatch after archive", async () => {
    const chat = await makeChat("archive lifecycle", process.cwd());
    const dispatched = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: auth(OPERATOR),
      payload: {
        kind: "session",
        vendor: "claude-code",
        taskId: chat.taskId,
        brief: "orchestrate this chat",
        chatId: chat.id,
        workspacePath: process.cwd(),
      },
    });
    expect(dispatched.statusCode).toBe(201);
    const jobId = dispatched.json().job.id as string;

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
      headers: auth(OPERATOR),
    });
    expect(blocked.statusCode).toBe(409);
    expect(
      await prisma.orchestratorChat.findUnique({ where: { id: chat.id } })
    ).toMatchObject({ status: "active" });

    await prisma.dispatchJob.update({
      where: { id: jobId },
      data: {
        status: "interrupted",
        interruptRequested: true,
        endedAt: new Date(),
      },
    });
    const archived = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
      headers: auth(OPERATOR),
    });
    expect(archived.statusCode).toBe(200);

    const lateDispatch = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: auth(OPERATOR),
      payload: {
        kind: "session",
        vendor: "claude-code",
        taskId: chat.taskId,
        brief: "must not restart",
        chatId: chat.id,
        workspacePath: process.cwd(),
      },
    });
    expect(lateDispatch.statusCode).toBe(409);

    // Omitting chatId used to turn a chat-bound resume into a plain dispatch,
    // bypassing the archived-chat check, canonical task/workspace derivation,
    // and the one-active-root constraint.
    const escapedResume = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: auth(OPERATOR),
      payload: {
        kind: "session",
        vendor: "claude-code",
        taskId: chat.taskId,
        brief: "must not escape the archived chat partition",
        resumedFromJobId: jobId,
        workspacePath: process.cwd(),
      },
    });
    expect(escapedResume.statusCode).toBe(409);
    expect(escapedResume.json().message).toMatch(
      /exact owning chat partition/i
    );
    expect(
      await prisma.dispatchJob.count({
        where: { resumedFromJobId: jobId },
      })
    ).toBe(0);
  });
});

describe("S7: list status filtering (default active) and by-id read", () => {
  it("default GET / excludes archived; ?status=archived and ?status=all include it", async () => {
    const active = await makeChat("still active");
    const gone = await makeChat("about to archive");
    await app.inject({
      method: "DELETE",
      url: `/api/chats/${gone.id}`,
      headers: auth(OPERATOR),
    });

    const def = await app.inject({
      method: "GET",
      url: "/api/chats",
      headers: auth(OPERATOR),
    });
    const defIds = (def.json().chats as { id: string }[]).map((c) => c.id);
    expect(defIds).toContain(active.id);
    expect(defIds).not.toContain(gone.id);

    const archived = await app.inject({
      method: "GET",
      url: "/api/chats?status=archived",
      headers: auth(OPERATOR),
    });
    const archivedIds = (archived.json().chats as { id: string }[]).map(
      (c) => c.id
    );
    expect(archivedIds).toContain(gone.id);
    expect(archivedIds).not.toContain(active.id);

    const all = await app.inject({
      method: "GET",
      url: "/api/chats?status=all",
      headers: auth(OPERATOR),
    });
    const allIds = (all.json().chats as { id: string }[]).map((c) => c.id);
    expect(allIds).toContain(active.id);
    expect(allIds).toContain(gone.id);
  });

  it("GET /:chatId still returns an archived chat (deep links keep working)", async () => {
    const chat = await makeChat("archived but linkable");
    await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
      headers: auth(OPERATOR),
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/chats/${chat.id}`,
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().chat.status).toBe("archived");
  });

  it("an invalid ?status value is rejected (400), never silently ignored", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/chats?status=deleted",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("S7: audit-survives invariant (soft archive never cascades)", () => {
  it("shadow Task, StreamChunks, Events, and ApprovalRequests all persist post-archive", async () => {
    const chat = await makeChat("has a full audit trail");
    expect(chat.taskId).toBeTruthy();
    const taskId = chat.taskId as string;

    // Conversation provenance: chat turns are StreamChunks keyed by chatId.
    await prisma.streamChunk.create({
      data: { taskId: chat.id, laneId: "orchestrator", content: "[you] hi" },
    });
    // A ledger milestone Event.
    await prisma.event.create({
      data: {
        laneId: "orchestrator",
        taskId: chat.id,
        kind: "chat.turn",
        message: "turn ran",
        metadata: {},
      },
    });
    // A gate the super-agent filed against the chat's SHADOW task, whose FK
    // cascades on Task delete, this is exactly the audit a hard delete destroys.
    const approval = await prisma.approvalRequest.create({
      data: {
        taskId,
        requestedBy: "agent:muon",
        kind: "command",
        reason: "ran a tool",
      },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);

    // Everything survives: soft archive touches ONLY the chat's status column.
    expect(
      await prisma.orchestratorChat.findUnique({ where: { id: chat.id } })
    ).toMatchObject({ status: "archived" });
    expect(await prisma.task.findUnique({ where: { id: taskId } })).not.toBeNull();
    expect(
      await prisma.streamChunk.count({ where: { taskId: chat.id } })
    ).toBeGreaterThan(0);
    expect(
      await prisma.event.count({ where: { taskId: chat.id } })
    ).toBeGreaterThan(0);
    expect(
      await prisma.approvalRequest.findUnique({ where: { id: approval.id } })
    ).not.toBeNull();
  });
});

describe("S7: coordinator continuity is exact-root authority", () => {
  it("shared agent-tier PATCH cannot write an unbound vendor session", async () => {
    const chat = await makeChat("runner resumes me");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: auth(AGENT),
      payload: {
        vendorSessionId: "vendor-session-xyz",
        vendorSessionVendor: "claude-code",
        vendorSessionRootJobId: "forged-root",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(
      await prisma.orchestratorChat.findUnique({ where: { id: chat.id } })
    ).toMatchObject({ vendorSessionId: null });
  });
});

describe("S7: archived Mission Chat streams are closed", () => {
  it("rejects late stream writes and claims after archival", async () => {
    const chat = await makeChat("closed stream");
    await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
      headers: auth(OPERATOR),
    });

    const lateWrite = await app.inject({
      method: "POST",
      url: "/api/streams",
      headers: auth(OPERATOR),
      payload: {
        chunks: [
          {
            taskId: chat.id,
            laneId: "muon-chat",
            kind: "milestone",
            content: "late continuation",
          },
        ],
      },
    });
    expect(lateWrite.statusCode).toBe(409);

    const lateClaim = await app.inject({
      method: "POST",
      url: "/api/streams/claim",
      headers: auth(OPERATOR),
      payload: {
        taskId: chat.id,
        laneId: "muon-chat",
        claimKey: "late-terminal",
        kind: "milestone",
        content: "[event] late terminal",
      },
    });
    expect(lateClaim.statusCode).toBe(409);
  });

  it("requires operator authority for structural human messages", async () => {
    const chat = await makeChat("trusted human stream");
    const forged = await app.inject({
      method: "POST",
      url: "/api/streams",
      headers: auth(AGENT),
      payload: {
        chunks: [
          {
            taskId: chat.id,
            laneId: "muon-chat",
            kind: "user.message",
            content: "[you] forged",
          },
        ],
      },
    });
    expect(forged.statusCode).toBe(403);
  });
});

describe("Mission Chat root admission", () => {
  it("admits one concurrent root and leaves exactly one trusted human turn", async () => {
    const chat = await makeChat("concurrent turn", process.cwd());
    const send = (message: string) =>
      app.inject({
        method: "POST",
        url: "/api/dispatch",
        headers: auth(OPERATOR),
        payload: {
          kind: "session",
          vendor: "claude-code",
          taskId: chat.taskId,
          chatId: chat.id,
          brief: message,
          humanMessage: message,
          workspacePath: process.cwd(),
        },
      });

    const responses = await Promise.all([send("first"), send("second")]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    expect(
      await prisma.dispatchJob.count({
        where: {
          chatId: chat.id,
          parentJobId: null,
          status: { in: ["queued", "running"] },
        },
      })
    ).toBe(1);
    const humanTurns = await prisma.streamChunk.findMany({
      where: { taskId: chat.id, kind: "user.message" },
    });
    expect(humanTurns).toHaveLength(1);
    expect(["[you] first", "[you] second"]).toContain(humanTurns[0]?.content);
  });
});

// ── FIX 2: PATCH status/title is operator-gated (brain-gate side-channel) ─────
//
// DELETE (soft archive) was operator-gated, but the equivalent PATCH fields
// status + title were not — so an AGENT-tier token could archive/resurrect or
// rename ANY chat (live-exploit confirmed). The gate now covers those two
// fields fail-closed. Provider continuity has its own exact-root gate above.
// This mirrors the confirmed-only brain gate that must
// cover every content-bearing govern field, not just the obvious one.
describe("FIX 2: PATCH status/title requires operator (agent tier is 403'd)", () => {
  it("agent-tier PATCH {status} → 403; the chat is NOT mutated (stays active)", async () => {
    const chat = await makeChat("agent cannot archive via patch");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: auth(AGENT),
      payload: { status: "archived" },
    });
    expect(res.statusCode).toBe(403);
    const after = await prisma.orchestratorChat.findUnique({
      where: { id: chat.id },
    });
    expect(after?.status).toBe("active");
  });

  it("agent-tier PATCH {title} → 403; the chat is NOT renamed", async () => {
    const chat = await makeChat("agent cannot rename");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: auth(AGENT),
      payload: { title: "hijacked title" },
    });
    expect(res.statusCode).toBe(403);
    const after = await prisma.orchestratorChat.findUnique({
      where: { id: chat.id },
    });
    expect(after?.title).toBe("agent cannot rename");
  });

  it("agent-tier PATCH {status, vendorSessionId} → 403 (a govern field poisons the whole write; nothing is applied)", async () => {
    const chat = await makeChat("agent cannot smuggle a status");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: auth(AGENT),
      payload: {
        status: "archived",
        vendorSessionId: "should-not-land",
        vendorSessionVendor: "claude-code",
        vendorSessionRootJobId: "forged-root",
      },
    });
    expect(res.statusCode).toBe(403);
    const after = await prisma.orchestratorChat.findUnique({
      where: { id: chat.id },
    });
    expect(after?.status).toBe("active");
    expect(after?.vendorSessionId).toBeNull();
  });

  it("operator-tier PATCH {title} → 200 and the title updates", async () => {
    const chat = await makeChat("operator renames me");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: auth(OPERATOR),
      payload: { title: "operator renamed this" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().chat.title).toBe("operator renamed this");
  });

  it("operator-tier PATCH {status} → 200 and the chat archives", async () => {
    const chat = await makeChat("operator archives via patch");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: auth(OPERATOR),
      payload: { status: "archived" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().chat.status).toBe("archived");
  });

  // ── G7: the chat-continuity binding is a CAPABILITY, not a name ────────────
  //
  // `vendorSessionVendor` used to be `z.enum(["claude-code"])`. ADR-0022 C4
  // makes it a POSITIVE refine over `session.persistsSessionHandle` — the
  // registry column that means it — and NOT a bare widening to `vendorIdSchema`.
  // The admitted set is unchanged; what changed is that a second lane earning
  // the handle is admitted by stating that ONCE in the registry, and a lane that
  // has NOT earned it is still refused even though it is a real vendor id.
  const HANDLE_BEARING = [...VENDOR_IDS].filter(
    (id) => VENDOR_REGISTRY[id].session.persistsSessionHandle
  );
  const NO_HANDLE = [...VENDOR_IDS].filter(
    (id) => !VENDOR_REGISTRY[id].session.persistsSessionHandle
  );

  it("the handle-bearing set is exactly one lane (a second is a governance change)", () => {
    expect(HANDLE_BEARING).toEqual(["claude-code"]);
  });

  it.each(NO_HANDLE)(
    "operator-tier PATCH {vendorSessionVendor: '%s'} → 400; nothing is bound",
    async (vendor) => {
      const chat = await makeChat(`no continuity handle for ${vendor}`);
      const res = await app.inject({
        method: "PATCH",
        url: `/api/chats/${chat.id}`,
        headers: auth(OPERATOR),
        payload: {
          vendorSessionId: "vend-abc",
          vendorSessionVendor: vendor,
          vendorSessionRootJobId: "root-1",
        },
      });
      expect(res.statusCode).toBe(400);
      const after = await prisma.orchestratorChat.findUnique({
        where: { id: chat.id },
      });
      expect(after?.vendorSessionId).toBeNull();
      expect(after?.vendorSessionVendor).toBeNull();
    }
  );

  it("PATCH with a vendor id MUON has never heard of → 400", async () => {
    const chat = await makeChat("unknown vendor cannot bind");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: auth(OPERATOR),
      payload: {
        vendorSessionId: "vend-abc",
        vendorSessionVendor: "kiro",
        vendorSessionRootJobId: "root-1",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
