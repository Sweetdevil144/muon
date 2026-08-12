import { describe, expect, it, vi } from "vitest";
import {
  createGitNexusToolDefinitions,
  isUnderWorkspace,
  parseCypherRows,
  parseRepoList,
  type GitNexusRunner,
} from "../src/gitnexus-tools.js";

// Real fixtures captured from the bundled OSS CLI (`gitnexus list`, and
// `cypher --repo <name>` which returns `{ markdown, row_count }`).

const LIST_OUTPUT = `
  Indexed Repositories (4)

  muon
    Path:    /Users/dev/code/muon
    Indexed: 20/7/2026, 5:53:10 am
    Commit:  7ed0bbd
    Stats:   783 files, 14532 symbols, 23669 edges
    Clusters:   598
    Processes:  300

  atlas-backend
    Path:    /Users/dev/code/atlas/operations/backend
    Indexed: 20/7/2026, 7:06:04 am
    Commit:  b4bc444
    Stats:   216 files, 8484 symbols, 15163 edges
    Clusters:   271
    Processes:  300

  atlas-website
    Path:    /Users/dev/code/atlas/operations/frontend
    Indexed: 20/7/2026, 7:19:04 am
    Commit:  634d691
    Stats:   220 files, 2374 symbols, 5036 edges

  wealth
    Path:    /Users/dev/code/atlas/wealth
    Indexed: 20/7/2026, 7:20:00 am
`;

const cypherEnvelope = (markdown: string, rowCount: number) =>
  JSON.stringify({ markdown, row_count: rowCount });
const WORKSPACE = process.cwd();

describe("parseRepoList", () => {
  it("extracts every indexed repo's name + path from the human block", () => {
    expect(parseRepoList(LIST_OUTPUT)).toEqual([
      { name: "muon", path: "/Users/dev/code/muon" },
      {
        name: "atlas-backend",
        path: "/Users/dev/code/atlas/operations/backend",
      },
      {
        name: "atlas-website",
        path: "/Users/dev/code/atlas/operations/frontend",
      },
      { name: "wealth", path: "/Users/dev/code/atlas/wealth" },
    ]);
  });

  it("returns nothing for an empty / no-repos listing", () => {
    expect(parseRepoList("  Indexed Repositories (0)\n")).toEqual([]);
    expect(parseRepoList("")).toEqual([]);
  });
});

describe("parseCypherRows", () => {
  it("parses a { markdown, row_count } pipe table into typed rows", () => {
    const stdout = cypherEnvelope(
      "| id | label | symbols | cohesion |\n| --- | --- | --- | --- |\n| comm_0 | Commands | 43 | 0.8428571428571429 |\n| comm_45 | Renderer | 36 | 0.81 |",
      2
    );
    expect(parseCypherRows(stdout)).toEqual([
      { id: "comm_0", label: "Commands", symbols: 43, cohesion: 0.8428571428571429 },
      { id: "comm_45", label: "Renderer", symbols: 36, cohesion: 0.81 },
    ]);
  });

  it("keeps file-path cells as strings, coerces only wholly-numeric cells", () => {
    const stdout = cypherEnvelope(
      "| cid | fp |\n| --- | --- |\n| comm_0 | src/cli/a.ts |\n| comm_9 | src/db/store.ts |",
      2
    );
    expect(parseCypherRows(stdout)).toEqual([
      { cid: "comm_0", fp: "src/cli/a.ts" },
      { cid: "comm_9", fp: "src/db/store.ts" },
    ]);
  });

  it("returns [] for a header-only (zero-row) result", () => {
    expect(
      parseCypherRows(cypherEnvelope("| edges |\n| --- |", 0))
    ).toEqual([]);
    expect(parseCypherRows(cypherEnvelope("", 0))).toEqual([]);
  });

  it("throws on a non-JSON envelope so the repo degrades honestly", () => {
    expect(() => parseCypherRows("not json at all")).toThrow(/not valid JSON/i);
  });

  it("folds a literal `|` in the LAST (free-text) column instead of misaligning", () => {
    // clusters return label LAST for exactly this reason; a `|` in the label
    // must not shift symbols/cohesion. Here fp (last) holds a pipe.
    const stdout = cypherEnvelope(
      "| cid | fp |\n| --- | --- |\n| comm_0 | src/a|b.ts |",
      1
    );
    expect(parseCypherRows(stdout)).toEqual([
      { cid: "comm_0", fp: "src/a|b.ts" },
    ]);
  });
});

describe("isUnderWorkspace", () => {
  it("matches the workspace itself and nested repos, not siblings", () => {
    const ws = "/Users/dev/code/atlas";
    expect(isUnderWorkspace(ws, ws)).toBe(true);
    expect(isUnderWorkspace(`${ws}/operations/backend`, ws)).toBe(true);
    expect(isUnderWorkspace("/Users/dev/code/muon", ws)).toBe(false);
    // a path that merely shares a string prefix is NOT under the workspace
    expect(isUnderWorkspace("/Users/dev/code/atlas-other", ws)).toBe(
      false
    );
  });
});

describe("repo_map tool (end-to-end over an injected CLI runner)", () => {
  // A fake CLI: `list` returns the human block; `cypher --repo X <query>`
  // returns a { markdown } envelope shaped by the query. Only the workspace's
  // OWN repo is exercised here (single-repo workspace).
  const clustersMd =
    "| id | label | symbols | cohesion |\n| --- | --- | --- |\n| comm_0 | Commands | 43 | 0.84 |\n| comm_45 | Renderer | 36 | 0.81 |";
  const membersMd =
    "| cid | fp |\n| --- | --- |\n| comm_0 | src/cli/a.ts |\n| comm_0 | src/cli/b.ts |\n| comm_45 | src/renderer/x.tsx |";
  const filesMd =
    "| fp |\n| --- |\n| src/cli/a.ts |\n| src/renderer/x.tsx |";
  const labelsMd =
    "| label | c |\n| --- | --- |\n| Function | 500 |\n| Const | 300 |\n| File | 2 |\n| Community | 2 |\n| Process | 10 |";
  const edgesMd = "| edges |\n| --- |\n| 1200 |";

  const fakeRun: GitNexusRunner = async (_binary, args) => {
    // args = [...commandPrefix, command, ...rest] — the prefix is present only
    // for the bundled CLI, so locate the command by keyword, not by index.
    const command = args.find((a) => a === "list" || a === "cypher");
    if (command === "list") {
      return {
        stdout: `
  Indexed Repositories (1)

  muon
    Path:    ${WORKSPACE}
    Indexed: now
`,
        stderr: "",
      };
    }
    if (command === "cypher") {
      const query = args[args.length - 1] ?? "";
      const md = query.includes(":Community")
        ? query.includes("MEMBER_OF")
          ? membersMd
          : clustersMd
        : query.includes(":File")
          ? filesMd
          : query.includes("count(r)")
            ? edgesMd
            : labelsMd;
      return { stdout: cypherEnvelope(md, 3), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  it("reconnoiters the workspace repo into a RepoMap + recommendation", async () => {
    const memoryAnalytics = vi.fn().mockResolvedValue({
      hotModules: [
        { module: "src/renderer/x.tsx", score: 0.9, noteCount: 3 },
      ],
      communities: [
        { id: "community-1", noteCount: 3, moduleCount: 1 },
      ],
    });
    const tools = createGitNexusToolDefinitions({
      workspacePath: WORKSPACE,
      binary: "/fake/node",
      run: fakeRun,
      memoryAnalytics,
    });
    const repoMapTool = tools.find((t) => t.name === "repo_map");
    expect(repoMapTool).toBeDefined();
    const result = await repoMapTool!.handler({});
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as unknown as {
      repoMap: {
        repos: { name: string; clusters: { label: string }[] }[];
        confidence: string;
        totals: { symbols: number };
      };
      recommendation: {
        crewSize: number;
        workUnits: { scope: string }[];
        memory?: {
          hotModules: { module: string }[];
          communityCount: number;
        };
      };
    };
    expect(payload.repoMap.repos).toHaveLength(1);
    expect(payload.repoMap.repos[0]!.name).toBe("muon");
    expect(payload.repoMap.repos[0]!.clusters.map((c) => c.label)).toEqual([
      "Commands",
      "Renderer",
    ]);
    // symbols = Function(500) + Const(300); File/Community/Process excluded
    expect(payload.repoMap.totals.symbols).toBe(800);
    expect(payload.repoMap.confidence).toBe("full");
    expect(payload.recommendation.crewSize).toBeGreaterThanOrEqual(1);
    expect(memoryAnalytics).toHaveBeenCalledOnce();
    expect(payload.recommendation.memory).toEqual({
      hotModules: [
        { module: "src/renderer/x.tsx", score: 0.9, noteCount: 3 },
      ],
      communityCount: 1,
    });
  });

  it("returns a scope-fenced crew plan when a mission is given", async () => {
    const tools = createGitNexusToolDefinitions({
      workspacePath: WORKSPACE,
      binary: "/fake/node",
      run: fakeRun,
    });
    const result = await tools
      .find((t) => t.name === "repo_map")!
      .handler({ mission: "examine codebase for security issues" });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as unknown as {
      plan?: {
        strategy: string;
        crewSize: number;
        units: { prompt: string; ownedPaths: string[] }[];
      };
    };
    expect(payload.plan).toBeDefined();
    expect(payload.plan!.strategy).toBe("fan-out");
    expect(payload.plan!.units.length).toBe(payload.plan!.crewSize);
    for (const unit of payload.plan!.units) {
      expect(unit.prompt).toContain("examine codebase for security issues");
      expect(unit.prompt).toMatch(/ONLY these paths/);
    }
  });

  it("omits the plan when no mission is given", async () => {
    const tools = createGitNexusToolDefinitions({
      workspacePath: WORKSPACE,
      binary: "/fake/node",
      run: fakeRun,
    });
    const result = await tools.find((t) => t.name === "repo_map")!.handler({});
    const payload = result.structuredContent as unknown as {
      plan?: unknown;
      critique?: unknown;
    };
    expect(payload.plan).toBeUndefined();
    expect(payload.critique).toBeUndefined();
  });

  it("includes an honest coverage critique alongside the plan", async () => {
    const tools = createGitNexusToolDefinitions({
      workspacePath: WORKSPACE,
      binary: "/fake/node",
      run: fakeRun,
    });
    const result = await tools
      .find((t) => t.name === "repo_map")!
      .handler({ mission: "examine" });
    const payload = result.structuredContent as unknown as {
      critique?: {
        totalClusters: number;
        symbolCoverage: number;
        recommendFollowUp: boolean;
        gaps: string[];
      };
    };
    expect(payload.critique).toBeDefined();
    expect(typeof payload.critique!.symbolCoverage).toBe("number");
    expect(Array.isArray(payload.critique!.gaps)).toBe(true);
  });

  it("cannot report full confidence when the graph answers with an empty payload", async () => {
    // C4, at the boundary the coordinator actually reads. Every cypher call
    // SUCCEEDS here and returns zero rows — a stale or half-built index, which
    // is what the founder's session hit. Nothing throws, so no repo is marked
    // degraded by the collector, and the old rule called this "full" while
    // handing back zero clusters and zero ownedPaths.
    const emptyRun: GitNexusRunner = async (_binary, args) => {
      const command = args.find((a) => a === "list" || a === "cypher");
      if (command === "list") {
        return {
          stdout: `
  Indexed Repositories (1)

  muon
    Path:    ${WORKSPACE}
    Indexed: now
`,
          stderr: "",
        };
      }
      if (command === "cypher") {
        return { stdout: cypherEnvelope("", 0), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const tools = createGitNexusToolDefinitions({
      workspacePath: WORKSPACE,
      binary: "/fake/node",
      run: emptyRun,
    });
    const result = await tools
      .find((t) => t.name === "repo_map")!
      .handler({ mission: "examine codebase" });
    const payload = result.structuredContent as unknown as {
      repoMap: { confidence: string; totals: { clusters: number } };
      plan?: { confidence: string };
    };
    expect(payload.repoMap.totals.clusters).toBe(0);
    expect(payload.repoMap.confidence).not.toBe("full");
    expect(payload.plan!.confidence).not.toBe("full");
    // The zero arrives with its cause and its repair, not silently.
    const degradation = result.ui!.degradation!;
    expect(degradation.active).toBe(true);
    expect(degradation.reason).toMatch(/no functional clusters|index is empty/i);
    expect(degradation.action).toMatch(/analyze/);
  });

  it("fails cleanly (degraded) when no repo is under the workspace", async () => {
    const tools = createGitNexusToolDefinitions({
      workspacePath: "/some/unrelated/workspace",
      binary: "/fake/node",
      run: fakeRun,
    });
    const result = await tools
      .find((t) => t.name === "repo_map")!
      .handler({});
    expect(result.isError).toBe(true);
  });
});
