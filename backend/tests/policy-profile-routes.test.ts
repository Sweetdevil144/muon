import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

// ── P0.4 slice 2: workspace policy profile residence ─────────────────────────
//
// The profile ledger is operator-authored (agents must never author policy —
// the same govern precedent as lane profiles) and agent-readable (the runner
// sources it at execution). The always-ask fence is enforced AT WRITE TIME by
// the shipped `policyProfileSchema`: a profile that tries to `allow`
// network/merge/ship fails to parse and the PUT 400s. Precedence at read:
// task-scoped row > workspace-scoped row > no profile (= today's ask-everything).

const OPERATOR = "operator-token-policy-profile-1";
const AGENT = "agent-token-policy-profile-1";

type StoredRow = {
  workspacePath: string;
  taskScope: string;
  profile: unknown;
  version: number;
};

const rowStore = new Map<string, StoredRow>();
const rowKey = (workspacePath: string, taskScope: string) =>
  `${workspacePath}${taskScope}`;

const prismaMock = vi.hoisted(() => ({
  approvalRequest: { updateMany: vi.fn() },
  agent: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  event: { create: vi.fn() },
  workflowRun: { findUnique: vi.fn(), update: vi.fn() },
  task: { create: vi.fn() },
  workspacePolicyProfile: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

async function buildTieredApp() {
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const { buildApp } = await import("../src/app.js");
  return buildApp();
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

const WORKSPACE = process.cwd();

const PROFILE = {
  version: 1,
  label: "workspace-default",
  postures: {
    read: "allow",
    test: "allow",
    edit: "gate",
    network: "gate",
    merge: "gate",
    ship: "gate",
  },
  editInRadius: "allow",
  taskRadius: ["src"],
};

const TASK_PROFILE = {
  ...PROFILE,
  label: "task-override",
  taskRadius: ["src", "tests"],
};

describe("P0.4 workspace policy profile routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rowStore.clear();

    prismaMock.workspacePolicyProfile.findUnique.mockImplementation(
      async (args: {
        where: {
          workspacePath_taskScope: { workspacePath: string; taskScope: string };
        };
      }) => {
        const { workspacePath, taskScope } = args.where.workspacePath_taskScope;
        const stored = rowStore.get(rowKey(workspacePath, taskScope));
        return stored
          ? {
              id: `row-${taskScope || "ws"}`,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...stored,
            }
          : null;
      }
    );
    prismaMock.workspacePolicyProfile.upsert.mockImplementation(
      async (args: {
        where: {
          workspacePath_taskScope: { workspacePath: string; taskScope: string };
        };
        create: StoredRow;
        update: { profile: unknown };
      }) => {
        const { workspacePath, taskScope } = args.where.workspacePath_taskScope;
        const key = rowKey(workspacePath, taskScope);
        const existing = rowStore.get(key);
        const next: StoredRow = existing
          ? {
              ...existing,
              profile: args.update.profile,
              version: existing.version + 1,
            }
          : {
              workspacePath,
              taskScope,
              profile: args.create.profile,
              version: 1,
            };
        rowStore.set(key, next);
        return {
          id: `row-${taskScope || "ws"}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...next,
        };
      }
    );
    prismaMock.workspacePolicyProfile.deleteMany.mockImplementation(
      async (args: {
        where: { workspacePath: string; taskScope: string };
      }) => {
        const key = rowKey(args.where.workspacePath, args.where.taskScope);
        const existed = rowStore.delete(key);
        return { count: existed ? 1 : 0 };
      }
    );
  });

  it("rejects an agent-tier PUT with 403 (agents never author policy)", async () => {
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/policy/profile",
      headers: auth(AGENT),
      payload: { workspacePath: WORKSPACE, profile: PROFILE },
    });
    expect(response.statusCode).toBe(403);
    expect(rowStore.size).toBe(0);
  });

  it("rejects a profile that tries to allow an always-ask class (schema fence)", async () => {
    const app = await buildTieredApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/policy/profile",
      headers: auth(OPERATOR),
      payload: {
        workspacePath: WORKSPACE,
        profile: {
          ...PROFILE,
          postures: { ...PROFILE.postures, network: "allow" },
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(rowStore.size).toBe(0);
  });

  it("operator PUT upserts; agent GET resolves it as the workspace-scoped profile", async () => {
    const app = await buildTieredApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/policy/profile",
      headers: auth(OPERATOR),
      payload: { workspacePath: WORKSPACE, profile: PROFILE },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ scope: "workspace", version: 1 });

    const get = await app.inject({
      method: "GET",
      url: `/api/policy/profile?workspacePath=${encodeURIComponent(WORKSPACE)}`,
      headers: auth(AGENT),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      profile: { label: "workspace-default" },
      scope: "workspace",
      version: 1,
    });
  });

  it("precedence: task row beats workspace row beats no row", async () => {
    const app = await buildTieredApp();
    await app.inject({
      method: "PUT",
      url: "/api/policy/profile",
      headers: auth(OPERATOR),
      payload: { workspacePath: WORKSPACE, profile: PROFILE },
    });
    const taskPut = await app.inject({
      method: "PUT",
      url: "/api/policy/profile",
      headers: auth(OPERATOR),
      payload: {
        workspacePath: WORKSPACE,
        taskId: "task-9",
        profile: TASK_PROFILE,
      },
    });
    expect(taskPut.statusCode).toBe(200);
    expect(taskPut.json()).toMatchObject({ scope: "task" });

    const taskGet = await app.inject({
      method: "GET",
      url: `/api/policy/profile?workspacePath=${encodeURIComponent(WORKSPACE)}&taskId=task-9`,
      headers: auth(AGENT),
    });
    expect(taskGet.json()).toMatchObject({
      profile: { label: "task-override" },
      scope: "task",
    });

    const workspaceGet = await app.inject({
      method: "GET",
      url: `/api/policy/profile?workspacePath=${encodeURIComponent(WORKSPACE)}`,
      headers: auth(AGENT),
    });
    expect(workspaceGet.json()).toMatchObject({
      profile: { label: "workspace-default" },
      scope: "workspace",
    });

    // A task with no override falls back to the workspace row.
    const otherTaskGet = await app.inject({
      method: "GET",
      url: `/api/policy/profile?workspacePath=${encodeURIComponent(WORKSPACE)}&taskId=task-other`,
      headers: auth(AGENT),
    });
    expect(otherTaskGet.json()).toMatchObject({
      profile: { label: "workspace-default" },
      scope: "workspace",
    });
  });

  it("GET canonicalizes workspacePath so writer and reader key identically", async () => {
    const app = await buildTieredApp();
    await app.inject({
      method: "PUT",
      url: "/api/policy/profile",
      headers: auth(OPERATOR),
      payload: { workspacePath: WORKSPACE, profile: PROFILE },
    });
    const uncanonical = `${WORKSPACE}${path.sep}.`;
    const get = await app.inject({
      method: "GET",
      url: `/api/policy/profile?workspacePath=${encodeURIComponent(uncanonical)}`,
      headers: auth(AGENT),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      profile: { label: "workspace-default" },
      scope: "workspace",
    });
  });

  it("no row means profile null (today's ask-everything), never a default", async () => {
    const app = await buildTieredApp();
    const get = await app.inject({
      method: "GET",
      url: `/api/policy/profile?workspacePath=${encodeURIComponent(WORKSPACE)}`,
      headers: auth(AGENT),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ profile: null, scope: null, version: 0 });
  });

  it("rejects a workspacePath outside the allowed roots with 400", async () => {
    const app = await buildTieredApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/policy/profile",
      headers: auth(OPERATOR),
      payload: { workspacePath: "/", profile: PROFILE },
    });
    expect(put.statusCode).toBe(400);
    const get = await app.inject({
      method: "GET",
      url: `/api/policy/profile?workspacePath=${encodeURIComponent("/")}`,
      headers: auth(AGENT),
    });
    expect(get.statusCode).toBe(400);
  });

  it("DELETE is operator-only and degrades the workspace back to ask-everything", async () => {
    const app = await buildTieredApp();
    await app.inject({
      method: "PUT",
      url: "/api/policy/profile",
      headers: auth(OPERATOR),
      payload: { workspacePath: WORKSPACE, profile: PROFILE },
    });

    const agentDelete = await app.inject({
      method: "DELETE",
      url: "/api/policy/profile",
      headers: auth(AGENT),
      payload: { workspacePath: WORKSPACE },
    });
    expect(agentDelete.statusCode).toBe(403);

    const operatorDelete = await app.inject({
      method: "DELETE",
      url: "/api/policy/profile",
      headers: auth(OPERATOR),
      payload: { workspacePath: WORKSPACE },
    });
    expect(operatorDelete.statusCode).toBe(200);
    expect(operatorDelete.json()).toMatchObject({ deleted: 1 });

    const get = await app.inject({
      method: "GET",
      url: `/api/policy/profile?workspacePath=${encodeURIComponent(WORKSPACE)}`,
      headers: auth(AGENT),
    });
    expect(get.json()).toMatchObject({ profile: null, scope: null });
  });
});
