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

// ── An answer MUON could not READ is not an answer of "nothing" ──────────────
//
// `parsedOutput` wraps unparseable stdout as `{output: "<text>"}`, and
// `code_impact` refused only on a JSON `error` field — so a `gitnexus` that
// exited 0 while printing a human-readable diagnostic, or printing nothing at
// all, arrived as `ok({result: {output: ""}})` with `degradation.active: false`.
// An agent reads that as "no upstream callers, safe to edit", which is the same
// defect class as an unmeasured index: UNKNOWN wearing a positive answer. The
// distinction that makes the fix worth anything is pinned here too: a REAL
// answer with zero callers is still a genuine ok.

describe("code_impact never reports an unreadable graph read as a clean one", () => {
  /** A fresh index, and whatever the `impact` subprocess printed. */
  const toolOver = async (impactStdout: string, name = "code_impact") => {
    const root = await workspace();
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "list") return { stdout: listOutput(root), stderr: "" };
      return { stdout: impactStdout, stderr: "" };
    });
    return createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    }).find((candidate) => candidate.name === name)!;
  };

  it("exit 0 with EMPTY stdout is a refusal that names the unknown, not an all-clear", async () => {
    const tool = await toolOver("");
    const result = await tool.handler({ target: "registerReviewThreadRoutes" });
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: string }).error;
    // The one sentence an agent must not be able to read out of this.
    expect(error).toMatch(/UNKNOWN/);
    expect(error).toMatch(/do NOT read this as "no callers"/);
    expect(error).toMatch(/printed nothing at all/);
    expect(result.ui?.degradation).toMatchObject({ active: true });
    expect(JSON.stringify(result.ui?.degradation)).toMatch(
      /muon graph reindex/
    );
  });

  it("exit 0 with a NON-JSON diagnostic quotes what the CLI said and still refuses", async () => {
    const tool = await toolOver("error: symbol 'changeMe' is ambiguous\n");
    const result = await tool.handler({ target: "changeMe" });
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: string }).error;
    expect(error).toMatch(/is ambiguous/);
    expect(error).toMatch(/do NOT read this as "no callers"/);
    expect(result.ui?.degradation).toMatchObject({ active: true });
  });

  it("a REAL answer with zero callers is still a genuine ok — the whole distinction", async () => {
    const tool = await toolOver(
      JSON.stringify({ risk: "LOW", byDepth: {}, callers: [] })
    );
    const result = await tool.handler({ target: "somethingNobodyCalls" });
    expect(result.isError).toBeFalsy();
    expect(
      (result.structuredContent as { result: { risk: string } }).result.risk
    ).toBe("LOW");
    expect(result.ui?.degradation).toEqual({ active: false });
  });

  it("code_query says the graph did not answer instead of reporting no matches", async () => {
    const tool = await toolOver("", "code_query");
    const result = await tool.handler({ query: "approval resolution" });
    // The search read still returns (its own contract), but never as an empty
    // result: the envelope says the graph did not answer.
    expect(result.ui?.degradation).toMatchObject({ active: true });
    expect(JSON.stringify(result.ui?.degradation)).toMatch(
      /UNKNOWN, not an empty result/
    );
  });
});
