import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildEventAuditStamp,
  parseEventPrincipal,
} from "../src/lib/event-audit.js";

/**
 * TODO 5.15 — Event principal / payloadDiff / requestId.
 *
 * Pure stamp helpers (no db) + route-level proof that POST /api/events stamps
 * the auth-derived principal and that an operator approval resolution writes
 * the dual-keyed audit row.
 */

describe("parseEventPrincipal / buildEventAuditStamp", () => {
  it("maps human / agent conventions to stable Principal ids", () => {
    expect(parseEventPrincipal("human").id).toBe("principal-human-human");
    expect(parseEventPrincipal("human:carol").kind).toBe("human");
    expect(parseEventPrincipal("codex").kind).toBe("agent");
    expect(parseEventPrincipal("agent:muon").id).toBe("principal-agent-muon");
  });

  it("dual-keys: human actor is also accountable; agent actor leaves accountable null unless named", () => {
    const human = buildEventAuditStamp({ actor: "human:carol" });
    expect(human.principalKind).toBe("human");
    expect(human.accountablePrincipalId).toBe(human.principalId);

    const agent = buildEventAuditStamp({ actor: "codex" });
    expect(agent.principalKind).toBe("agent");
    expect(agent.accountablePrincipalId).toBeNull();

    const agentWithHuman = buildEventAuditStamp({
      actor: "codex",
      accountable: "human",
      requestId: "apr_1",
      payloadDiff: { status: { from: "pending", to: "approved" } },
    });
    expect(agentWithHuman.accountablePrincipalId).toBe("principal-human-human");
    expect(agentWithHuman.requestId).toBe("apr_1");
    expect(agentWithHuman.payloadDiff).toEqual({
      status: { from: "pending", to: "approved" },
    });
  });

  it("refuses to stamp an agent as the accountable principal", () => {
    const stamp = buildEventAuditStamp({
      actor: "human",
      accountable: "codex",
    });
    expect(stamp.principalKind).toBe("human");
    expect(stamp.accountablePrincipalId).toBeNull();
  });
});

const OPERATOR = "operator-token-event-audit";
const AGENT = "agent-token-event-audit";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("POST /api/events stamps auth-derived principal (TODO 5.15)", () => {
  let dir: string;
  let db: typeof import("../src/lib/db.js");
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "muon-event-audit-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
    process.env.MUON_GRAPH_DISABLE_FTS = "1";
    process.env.MUON_OPERATOR_TOKEN = OPERATOR;
    process.env.MUON_AGENT_TOKEN = AGENT;
    delete process.env.MUON_API_TOKEN;

    db = await import("../src/lib/db.js");
    await db.ensureSchema();

    await db.prisma.task.create({
      data: {
        id: "task-audit",
        title: "audit task",
        description: "d",
        status: "todo",
        workspacePath: process.cwd(),
      },
    });
    await db.prisma.lane.create({
      data: {
        id: "lane-muon",
        key: "muon",
        name: "MUON",
        provider: "local",
        role: "orchestrator",
      },
    });

    app = (await import("../src/app.js")).buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("operator write stamps human principal + requestId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/events",
      headers: auth(OPERATOR),
      payload: {
        laneId: "muon",
        taskId: "task-audit",
        kind: "task.progress",
        message: "operator noted progress",
        requestId: "req-op-1",
      },
    });
    expect(res.statusCode).toBe(201);
    const event = res.json().event;
    expect(event.principalKind).toBe("human");
    expect(event.principalId).toBe("principal-human-human");
    expect(event.accountablePrincipalId).toBe("principal-human-human");
    expect(event.requestId).toBe("req-op-1");

    const row = await db.prisma.event.findUnique({ where: { id: event.id } });
    expect(row?.principalKind).toBe("human");
    expect(row?.requestId).toBe("req-op-1");
  });

  it("approval resolve writes dual-keyed audit with payloadDiff", async () => {
    const approval = await db.prisma.approvalRequest.create({
      data: {
        id: "apr-audit-1",
        taskId: "task-audit",
        requestedBy: "codex",
        kind: "command",
        reason: "run ls",
        status: "pending",
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/approvals/${approval.id}`,
      headers: auth(OPERATOR),
      payload: { status: "approved", decisionNotes: "looks fine" },
    });
    expect(res.statusCode).toBe(200);

    const audit = await db.prisma.event.findFirst({
      where: { kind: "approval.resolved", requestId: approval.id },
      orderBy: { timestamp: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.principalKind).toBe("human");
    expect(audit!.principalId).toBe("principal-human-human");
    expect(audit!.accountablePrincipalId).toBe("principal-human-human");
    expect(audit!.requestId).toBe(approval.id);
    expect(audit!.payloadDiff).toEqual({
      status: { from: "pending", to: "approved" },
      kind: "command",
      decisionNotesPresent: true,
    });
  });

  it("F5: a memory adjudication writes a stamped audit row naming fields, never text", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(OPERATOR),
      payload: {
        kind: "decision",
        text: "SECRET-PROSE the audit row must never carry",
        modules: ["audit/f5.ts"],
        createdBy: "human",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const noteId = created.json().note.id as string;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/memory/${noteId}`,
      headers: auth(OPERATOR),
      payload: { confirmed: true },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const row = await db.prisma.event.findFirst({
      where: { kind: "memory.adjudicated" },
      orderBy: { timestamp: "desc" },
    });
    expect(row).toBeTruthy();
    expect(row!.principalKind).toBe("human");
    expect(row!.accountablePrincipalId).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain("SECRET-PROSE");
    expect((row!.payloadDiff as { fields: string[] }).fields).toContain("confirmed");
  });

  it("F5: the JSONL export is operator-only and carries the stamped columns", async () => {
    const denied = await app.inject({
      method: "GET",
      url: "/api/events/audit/export",
      headers: auth(AGENT),
    });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({
      method: "GET",
      url: "/api/events/audit/export?kind=memory.adjudicated",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("jsonl");
    const lines = res.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].kind).toBe("memory.adjudicated");
    expect(lines[0].principalId).toBeTruthy();
  });

});
