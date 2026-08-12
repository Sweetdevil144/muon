import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitNexusToolDefinitions } from "../src/gitnexus-tools.js";

const workspaces: string[] = [];
const HEAD = "53aca6ff35be1c1b225feb3e60eccf05e220cc2b";

function listOutput(root: string, commit = HEAD): string {
  return [
    "",
    "  Indexed Repositories (1)",
    "",
    "  muon",
    `    Path:    ${root}`,
    "    Indexed: 7/23/2026, 3:01:12 PM",
    `    Commit:  ${commit}`,
    "    Stats:   913 files, 17396 symbols, 28352 edges",
    "",
  ].join("\n");
}

async function workspace() {
  const path = await mkdtemp(join(tmpdir(), "muon-gitnexus-"));
  workspaces.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("governed GitNexus tools", () => {
  it("runs query through exec-file semantics in the exact workspace", async () => {
    const root = await workspace();
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") {
        return { stdout: `${HEAD}\n`, stderr: "" };
      }
      if (args[0] === "list") {
        return { stdout: listOutput(root, HEAD.slice(0, 7)), stderr: "" };
      }
      return {
        stdout: JSON.stringify({ processes: [{ id: "proc-1" }] }),
        stderr: "",
      };
    });
    const tool = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "/opt/gitnexus/bin/gitnexus",
      run,
    }).find((candidate) => candidate.name === "code_query")!;

    const result = await tool.handler({
      query: "approval resolution",
      taskContext: "reviewing command gates",
      goal: "find the execution flow",
      limit: 3,
    });

    expect(run).toHaveBeenCalledWith(
      "/opt/gitnexus/bin/gitnexus",
      [
        "query",
        "approval resolution",
        "--context",
        "reviewing command gates",
        "--goal",
        "find the execution flow",
        "--limit",
        "3",
        "--repo",
        "muon",
      ],
      expect.objectContaining({
        cwd: await realpath(root),
        timeout: 20_000,
        maxBuffer: 1_048_576,
        shell: false,
      })
    );
    expect(result.structuredContent).toEqual({
      result: { processes: [{ id: "proc-1" }] },
      command: "query",
      workspace: await realpath(root),
      repo: {
        name: "muon",
        graphCommit: HEAD.slice(0, 7),
        headCommit: HEAD,
        stale: false,
      },
    });
  });

  it("binds a linked task worktree to the indexed canonical repository", async () => {
    const canonicalRoot = await workspace();
    const linkedWorktree = await workspace();
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") {
        return {
          stdout: args.includes("--git-common-dir")
            ? `${canonicalRoot}/.git\n`
            : `${HEAD}\n`,
          stderr: "",
        };
      }
      if (args[0] === "list") {
        return { stdout: listOutput(canonicalRoot), stderr: "" };
      }
      return {
        stdout: JSON.stringify({ processes: [{ id: "proc-worktree" }] }),
        stderr: "",
      };
    });
    const tool = createGitNexusToolDefinitions({
      workspacePath: linkedWorktree,
      binary: "gitnexus",
      run,
    }).find((candidate) => candidate.name === "code_query")!;

    const result = await tool.handler({ query: "worktree flow" });

    expect(result.isError).not.toBe(true);
    expect(run).toHaveBeenCalledWith(
      "gitnexus",
      ["query", "worktree flow", "--limit", "5", "--repo", "muon"],
      expect.objectContaining({ cwd: await realpath(linkedWorktree) })
    );
    expect(result.structuredContent).toMatchObject({
      repo: {
        name: "muon",
        graphCommit: HEAD,
        headCommit: HEAD,
        stale: false,
      },
    });
  });

  it("keeps impact upstream-only, resolves the exact symbol, and uses the bundled CLI contract", async () => {
    const root = await workspace();
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") {
        return { stdout: `${HEAD}\n`, stderr: "" };
      }
      if (args[0] === "list") {
        return { stdout: listOutput(root), stderr: "" };
      }
      if (args[0] === "context") {
        return {
          stdout: JSON.stringify({
            status: "found",
            symbol: {
              uid: "Function:backend/src/routes/approvals.ts:resolveApproval",
              name: "resolveApproval",
              kind: "Function",
              filePath: "backend/src/routes/approvals.ts",
            },
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          target: {
            id: "Function:backend/src/routes/approvals.ts:resolveApproval",
            name: "resolveApproval",
            type: "Function",
            filePath: "backend/src/routes/approvals.ts",
          },
          risk: "MEDIUM",
          impactedCount: 4,
          affected_modules: [],
          byDepth: {},
        }),
        stderr: "",
      };
    });
    const tool = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    }).find((candidate) => candidate.name === "code_impact")!;

    await tool.handler({
      target: "resolveApproval",
      filePath: "backend/src/routes/approvals.ts",
      kind: "Function",
    });

    expect(run).toHaveBeenCalledWith(
      "gitnexus",
      [
        "context",
        "resolveApproval",
        "--repo",
        "muon",
        "--file",
        "backend/src/routes/approvals.ts",
      ],
      expect.objectContaining({
        cwd: await realpath(root),
        timeout: 30_000,
        shell: false,
      })
    );
    expect(run).toHaveBeenCalledWith(
      "gitnexus",
      [
        "impact",
        "Function:backend/src/routes/approvals.ts:resolveApproval",
        "--repo",
        "muon",
        "--direction",
        "upstream",
        "--depth",
        "3",
      ],
      expect.objectContaining({
        cwd: await realpath(root),
        timeout: 30_000,
        shell: false,
      })
    );
    expect(run.mock.calls.flatMap((call) => call[1] as string[])).not.toContain(
      "--limit"
    );
    expect(run.mock.calls.flatMap((call) => call[1] as string[])).not.toContain(
      "--kind"
    );
  });

  it("refreshes a stale local index once before impact", async () => {
    const root = await workspace();
    let refreshed = false;
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") {
        return { stdout: `${HEAD}\n`, stderr: "" };
      }
      if (args[0] === "list") {
        return {
          stdout: listOutput(root, refreshed ? HEAD : "d148ccc"),
          stderr: "",
        };
      }
      if (args[0] === "analyze") {
        refreshed = true;
        return { stdout: "Repository indexed successfully", stderr: "" };
      }
      return {
        stdout: JSON.stringify({
          target: {
            id: "Function:src/example.ts:changeMe",
            name: "changeMe",
            type: "Function",
            filePath: "src/example.ts",
          },
          risk: "LOW",
          affected_modules: [],
          byDepth: {},
        }),
        stderr: "",
      };
    });
    const tool = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    }).find((candidate) => candidate.name === "code_impact")!;

    const result = await tool.handler({ target: "changeMe" });

    expect(result.isError).not.toBe(true);
    const canonicalRoot = await realpath(root);
    expect(run).toHaveBeenCalledWith(
      "gitnexus",
      ["analyze", canonicalRoot, "--index-only"],
      expect.objectContaining({ cwd: canonicalRoot })
    );
    expect(run).toHaveBeenCalledWith(
      "gitnexus",
      [
        "impact",
        "changeMe",
        "--repo",
        "muon",
        "--direction",
        "upstream",
        "--depth",
        "3",
      ],
      expect.any(Object)
    );
  });

  it("rejects malformed inputs before launching GitNexus", async () => {
    const root = await workspace();
    const run = vi.fn();
    const tools = createGitNexusToolDefinitions({
      workspacePath: root,
      run,
    });

    const query = await tools
      .find((candidate) => candidate.name === "code_query")!
      .handler({ query: "", limit: 100 });
    const context = await tools
      .find((candidate) => candidate.name === "code_context")!
      .handler({ name: "../".repeat(100) });

    expect(query.isError).toBe(true);
    expect(context.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns an actionable bounded failure when the local index is unavailable", async () => {
    const root = await workspace();
    const run = vi.fn().mockRejectedValue(
      Object.assign(new Error("No indexed repository found"), {
        code: 1,
        stderr: "Run gitnexus analyze first",
      })
    );
    const tool = createGitNexusToolDefinitions({
      workspacePath: root,
      run,
    }).find((candidate) => candidate.name === "code_context")!;

    const result = await tool.handler({ name: "runChatTurn" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error:
        "GitNexus is unavailable for this workspace: No indexed repository found",
    });
    expect(result.ui?.degradation).toEqual({
      active: true,
      reason: "No indexed repository found",
      action:
        "Install GitNexus and run `gitnexus analyze --index-only` in this workspace, then retry.",
    });
  });
});
