import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { validateWorkspacePath, workspaceRoots } from "../src/lib/workspace.js";

const prismaMock = vi.hoisted(() => ({
  dispatchJob: { create: vi.fn() },
  task: { create: vi.fn() },
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const HOME = os.homedir();
const IN_ROOT = path.join(HOME, "muon-workspace-test-repo");

describe("validateWorkspacePath (P3-B / audit M2)", () => {
  it("accepts a path inside the home subtree (always-allowed root)", () => {
    const result = validateWorkspacePath(IN_ROOT, { env: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.resolve(IN_ROOT));
    }
  });

  it("rejects an absolute escape like /etc", () => {
    const result = validateWorkspacePath("/etc", { env: {} });
    expect(result.ok).toBe(false);
  });

  it("rejects a .. traversal that climbs out of the allowed roots", () => {
    const result = validateWorkspacePath(
      path.join(HOME, "..", "..", "..", "..", "etc"),
      { env: {} }
    );
    expect(result.ok).toBe(false);
  });

  it("honors the configurable allowlist (explicit roots)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "muon-ws-roots-"));
    try {
      expect(validateWorkspacePath(path.join(root, "sub"), { roots: [root] }).ok).toBe(
        true
      );
      expect(validateWorkspacePath("/etc", { roots: [root] }).ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors MUON_WORKSPACE_ROOTS, same path rejected without it, accepted with it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "muon-ws-env-"));
    const target = path.join(root, "repo");
    try {
      // tmpdir is outside home/cwd, so without configuration → rejected.
      expect(validateWorkspacePath(target, { env: {} }).ok).toBe(false);
      // MUON_WORKSPACE_ROOTS widens the allowlist → accepted.
      expect(
        validateWorkspacePath(target, {
          env: { MUON_WORKSPACE_ROOTS: root },
        }).ok
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink that resolves outside the allowed roots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "muon-ws-symlink-"));
    try {
      const escape = path.join(root, "escape");
      fs.symlinkSync("/etc", escape); // points outside `root`
      const result = validateWorkspacePath(path.join(escape, "passwd"), {
        roots: [root],
      });
      expect(result.ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists the canonical real path instead of a retargetable symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "muon-ws-canonical-"));
    const real = path.join(root, "real");
    const alias = path.join(root, "alias");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias);
    try {
      const result = validateWorkspacePath(alias, { roots: [root] });
      expect(result).toEqual({ ok: true, path: fs.realpathSync(real) });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("workspaceRoots always includes cwd + home and adds configured roots", () => {
    const roots = workspaceRoots({ MUON_WORKSPACE_ROOTS: "/opt/ci, ~/work" });
    expect(roots).toContain(path.resolve(process.cwd()));
    expect(roots).toContain(path.resolve(HOME));
    expect(roots).toContain(path.resolve("/opt/ci"));
    expect(roots).toContain(path.join(HOME, "work"));
  });
});

describe("workspacePath enforcement on the write routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.dispatchJob.create.mockResolvedValue({
      id: "job-1",
      status: "queued",
    });
    prismaMock.task.create.mockResolvedValue({
      id: "task-1",
      title: "A task",
      status: "backlog",
    });
  });

  afterEach(() => {
    delete process.env.MUON_WORKSPACE_ROOTS;
  });

  it("POST /api/dispatch rejects an escaping workspacePath with 400", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        vendor: "claude-code",
        taskId: "task-1",
        brief: "do the thing",
        workspacePath: "/etc",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("POST /api/dispatch accepts an in-root workspacePath (201)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        vendor: "claude-code",
        taskId: "task-1",
        brief: "do the thing",
        workspacePath: IN_ROOT,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(prismaMock.dispatchJob.create).toHaveBeenCalled();
    await app.close();
  });

  it("POST /api/tasks rejects an escaping workspacePath with 400", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "A task",
        description: "A sufficiently long description",
        workspacePath: "/etc",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.task.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("POST /api/tasks accepts an in-root workspacePath (201)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "A task",
        description: "A sufficiently long description",
        workspacePath: IN_ROOT,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(prismaMock.task.create).toHaveBeenCalled();
    await app.close();
  });

  it("POST /api/tasks persists the canonical path, not a symlink alias", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "muon-task-canonical-"));
    const real = path.join(root, "real");
    const alias = path.join(root, "alias");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias);
    process.env.MUON_WORKSPACE_ROOTS = root;
    try {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          title: "Canonical task",
          description: "Persist the real workspace coordinate",
          workspacePath: alias,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(prismaMock.task.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ workspacePath: fs.realpathSync(real) }),
      });
      await app.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
