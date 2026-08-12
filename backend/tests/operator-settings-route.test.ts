import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── #133 operator-only crew-visible toggle (autoConfirmAgentMemory) ───────────
//
// The setting is a HUMAN govern posture: OPERATOR-tier for BOTH read and write,
// default ON, and it is NOT settable via an agent-facing request body OR an
// env var an agent controls. Its ONLY effect is server-side in POST /preedit,
// which resolves the value itself and hard-wires the per-chat blast radius. These
// assert the ROUTE-level tier guards + the "not body/env settable" invariant; the
// store is mocked so the test isolates the auth + wiring boundary.

const OPERATOR = "operator-token-opset-1";
const AGENT = "agent-token-opset-1";
const JOB_TOKEN = `job-opset-${"j".repeat(55)}`;

const settingRows = new Map<string, { key: string; value: string }>();

const prismaMock = vi.hoisted(() => ({
  operatorSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  delegationGrant: {
    findFirst: vi.fn(),
  },
  dispatchJob: {
    findUnique: vi.fn(),
  },
}));
const preeditMock = vi.hoisted(() => ({ preEditContext: vi.fn() }));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/preedit.js", () => preeditMock);
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
  getEmbedder: () => undefined,
}));
vi.mock("../src/lib/codegraph.js", () => ({
  selectCodeGraphProvider: async () => null,
}));
vi.mock("../src/lib/activity.js", () => ({ readActivity: () => async () => [] }));
vi.mock("../src/lib/duplicate-work.js", () => ({
  readDuplicateWork: () => async () => [],
}));

async function buildTieredApp() {
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const { buildApp } = await import("../src/app.js");
  return buildApp();
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const SETTING_URL = "/api/memory/settings/auto-confirm-agent-memory";

describe("#133 autoConfirmAgentMemory operator setting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingRows.clear();
    prismaMock.operatorSetting.findUnique.mockImplementation(
      async (args: { where: { key: string } }) =>
        settingRows.get(args.where.key) ?? null
    );
    prismaMock.operatorSetting.upsert.mockImplementation(
      async (args: {
        where: { key: string };
        create: { key: string; value: string };
        update: { value: string };
      }) => {
        const existing = settingRows.get(args.where.key);
        const row = existing
          ? { ...existing, value: args.update.value }
          : { ...args.create };
        settingRows.set(args.where.key, row);
        return row;
      }
    );
    preeditMock.preEditContext.mockResolvedValue({
      memories: [],
      warnings: [],
      pendingProposals: [],
      activity: [],
      duplicateWork: [],
      blastRadius: { modules: [], symbols: [], depth: 0, source: "target-only" },
      target: {},
      // D14: the route re-tallies coverage after its ledger re-gate, so the gate
      // library's contract now includes it and a stub without it is not a
      // preEditContext result at all.
      coverage: {
        anchors: {
          modules: { requested: 0, resolved: 0 },
          symbols: { requested: 0, resolved: 0 },
          unreadable: 0,
        },
        notes: { considered: 0, admitted: 0, surfaced: 0 },
        admittedBy: { humanConfirmed: 0, crewVouched: 0, trustFloor: 0 },
        crewChat: false,
        emptyReason: "no_anchors",
      },
    });
    prismaMock.delegationGrant.findFirst.mockResolvedValue({
      jobId: "job-opset",
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      id: "job-opset",
      taskId: "task-opset",
      vendor: "codex",
      chatId: "chat-a",
      parentJobId: null,
      rootJobId: "job-opset",
      capabilityMode: "orchestrator",
      workspacePath: "/repo",
      status: "running",
      interruptRequested: false,
    });
  });

  it("DEFAULT ON: an unset toggle reads true (crew-visible admission is on out of the box)", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: SETTING_URL,
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ autoConfirmAgentMemory: true });
    await app.close();
  });

  it("operator PUT persists the value; a later GET reflects it", async () => {
    const app = await buildTieredApp();
    const put = await app.inject({
      method: "PUT",
      url: SETTING_URL,
      headers: auth(OPERATOR),
      payload: { enabled: false },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ autoConfirmAgentMemory: false });

    const get = await app.inject({
      method: "GET",
      url: SETTING_URL,
      headers: auth(OPERATOR),
    });
    expect(get.json()).toEqual({ autoConfirmAgentMemory: false });
    await app.close();
  });

  it("(g) OPERATOR-ONLY: an agent-tier GET and PUT are both 403; the store is never written", async () => {
    const app = await buildTieredApp();
    const agentGet = await app.inject({
      method: "GET",
      url: SETTING_URL,
      headers: auth(AGENT),
    });
    expect(agentGet.statusCode).toBe(403);

    const agentPut = await app.inject({
      method: "PUT",
      url: SETTING_URL,
      headers: auth(AGENT),
      payload: { enabled: false },
    });
    expect(agentPut.statusCode).toBe(403);
    expect(prismaMock.operatorSetting.upsert).not.toHaveBeenCalled();
    expect(settingRows.size).toBe(0);
    await app.close();
  });

  it("(g) NOT body-settable: an agent /preedit body claiming the flag is IGNORED — the server-side value (default ON) is used", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/preedit",
      headers: auth(JOB_TOKEN),
      // A hostile body tries to force the flag off via several plausible names.
      payload: {
        module: "src/x/y.ts",
        chatId: "chat-a",
        autoConfirmAgentMemory: false,
        crewVisibleMemory: false,
        enabled: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(preeditMock.preEditContext).toHaveBeenCalledOnce();
    const opts = preeditMock.preEditContext.mock.calls[0][2] as {
      crewVisibleMemory?: boolean;
    };
    // The body field is stripped by the schema; the handler passes the server-side
    // resolved value (default ON), never the agent-supplied one.
    expect(opts.crewVisibleMemory).toBe(true);
    // And the store was never mutated by the agent request.
    expect(prismaMock.operatorSetting.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("(g) NOT env-settable: an agent-controllable env var does not toggle the setting", async () => {
    // Whatever an agent could set in its own process env has no effect: the read
    // path consults ONLY the operator-written store, never the environment.
    process.env.autoConfirmAgentMemory = "false";
    process.env.MUON_AUTO_CONFIRM_AGENT_MEMORY = "false";
    try {
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "GET",
        url: SETTING_URL,
        headers: auth(OPERATOR),
      });
      expect(res.json()).toEqual({ autoConfirmAgentMemory: true });
      await app.close();
    } finally {
      delete process.env.autoConfirmAgentMemory;
      delete process.env.MUON_AUTO_CONFIRM_AGENT_MEMORY;
    }
  });
});
