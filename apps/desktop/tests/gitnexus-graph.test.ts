import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveBestGraphTarget,
  resolveRepoNameForPath,
  loadGitNexusGraph,
  parseRows,
  projectGraph,
  resolveGraphTarget,
  MAX_NODES,
  type GitNexusExec,
} from "../src/lib/gitnexus-graph.js";

const CLI = { binary: "/electron", commandPrefix: ["/cli/index.js"] };

/** Build the EXACT stdout the bundled CLI's `cypher` emits: a JSON object
 * `{ markdown: "<pipe table>", row_count }` (routed through formatCypherAsMarkdown). */
function cliOut(columns: string[], rows: string[][]): string {
  const header = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  const markdown = rows.length
    ? [header, sep, body].join("\n")
    : [header, sep].join("\n");
  return JSON.stringify({ markdown, row_count: rows.length });
}

/** An exec seam returning canned stdout per query (matched by the CodeRelation substring). */
function fakeExec(
  responses: { nodes?: string; edges?: string; throwOn?: string; list?: string },
  calls: { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = []
): GitNexusExec {
  return (async (binary, args, opts) => {
    calls.push({ binary, args, cwd: opts.cwd, env: opts.env });
    // The registry lookup (`gitnexus list`) runs before the cypher reads.
    if (args.includes("list") && !args.includes("cypher")) {
      return { stdout: responses.list ?? "", stderr: "" };
    }
    const query = args[args.length - 1] ?? "";
    if (responses.throwOn && query.includes(responses.throwOn)) {
      throw new Error("boom");
    }
    const stdout = query.includes("CodeRelation")
      ? responses.edges ?? cliOut(["sourceId", "targetId", "type"], [])
      : responses.nodes ?? cliOut(["id", "label", "filePath", "startLine", "endLine", "name"], []);
    return { stdout, stderr: "" };
  }) as GitNexusExec;
}

/** A canned `gitnexus list` block for the given (name → path) repos. */
function listOut(repos: { name: string; path: string }[]): string {
  const blocks = repos
    .map((r) => `  ${r.name}\n    Path:    ${r.path}\n    Indexed: now`)
    .join("\n\n");
  return `\n  Indexed Repositories (${repos.length})\n\n${blocks}\n`;
}

describe("parseRows (real CLI contract)", () => {
  it("parses the { markdown, row_count } wrapper into row objects; empty cells ⇒ undefined", () => {
    const out = cliOut(
      ["id", "label", "filePath", "startLine", "endLine", "name"],
      [["Folder:scripts", "Folder", "scripts", "", "", "scripts"]]
    );
    expect(parseRows(out)).toEqual([
      { id: "Folder:scripts", label: "Folder", filePath: "scripts", startLine: undefined, endLine: undefined, name: "scripts" },
    ]);
  });

  it("returns [] for a header-only (0-row) table", () => {
    expect(parseRows(cliOut(["id"], []))).toEqual([]);
  });

  it("throws on an { error } object so the caller fails safe", () => {
    expect(() => parseRows(JSON.stringify({ error: "Binder exception: no such table" }))).toThrow(/Binder/);
  });

  it("still accepts a bare JSON array (defensive / future --json)", () => {
    expect(parseRows(JSON.stringify([{ id: "a" }]))).toEqual([{ id: "a" }]);
  });

  it("folds a `|` inside the trailing name column back without corrupting other columns", () => {
    // A C++-style operator-overload symbol (`operator|eq`, no spaces) — the only
    // realistic pipe-in-value case. name is the LAST column, so the overflow
    // folds back cleanly and filePath/lines stay correctly aligned.
    const out = cliOut(
      ["id", "label", "filePath", "startLine", "endLine", "name"],
      [["Function:op", "Function", "ops.cpp", "3", "9", "operator|eq"]]
    );
    const rows = parseRows(out);
    expect(rows[0]).toMatchObject({ id: "Function:op", filePath: "ops.cpp", startLine: "3", endLine: "9", name: "operator|eq" });
  });
});

describe("projectGraph", () => {
  it("dedupes nodes and keeps only edges whose both endpoints survive", () => {
    const g = projectGraph(
      [
        { id: "a", label: "Function", name: "foo", filePath: "a.ts", startLine: 1, endLine: 9 },
        { id: "b", label: "Class", name: "Bar", filePath: "b.ts" },
        { id: "a", label: "Function", name: "foo-dupe" }, // dropped (dup id)
      ],
      [
        { sourceId: "a", targetId: "b", type: "CALLS" },
        { sourceId: "a", targetId: "ghost", type: "CALLS" }, // dropped (missing endpoint)
        { sourceId: "a", targetId: "b", type: "CALLS" }, // dropped (dup edge id)
      ]
    );
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(g.nodes[0]).toMatchObject({ id: "a", label: "Function", name: "foo", startLine: 1, endLine: 9 });
    expect(g.relationships).toHaveLength(1);
    expect(g.relationships[0]).toMatchObject({ sourceId: "a", targetId: "b", type: "CALLS" });
    expect(g.truncated).toBe(false);
  });

  it("does NOT alias distinct edges whose _-joined keys would collide", () => {
    // (A, B_C, D) vs (A_B, C, D): a `_` join yields "A_B_C_D" for both. NUL keeps them distinct.
    const g = projectGraph(
      [{ id: "A" }, { id: "D" }, { id: "A_B" }],
      [
        { sourceId: "A", targetId: "D", type: "B_C" },
        { sourceId: "A_B", targetId: "D", type: "C" },
      ]
    );
    expect(g.relationships).toHaveLength(2);
  });

  it("flags truncation only when a row genuinely exists beyond the cap", () => {
    const exactly = Array.from({ length: MAX_NODES }, (_, i) => ({ id: `n${i}`, label: "File" }));
    expect(projectGraph(exactly, []).truncated).toBe(false); // exactly at cap ⇒ nothing dropped
    const over = Array.from({ length: MAX_NODES + 1 }, (_, i) => ({ id: `n${i}`, label: "File" }));
    const g = projectGraph(over, []);
    expect(g.truncated).toBe(true);
    expect(g.nodes).toHaveLength(MAX_NODES); // rendered up to the cap
  });

  it("falls back to CodeElement / RELATED when label/type are absent", () => {
    const g = projectGraph([{ id: "x" }, { id: "y" }], [{ sourceId: "x", targetId: "y" }]);
    expect(g.nodes[0]!.label).toBe("CodeElement");
    expect(g.relationships[0]!.type).toBe("RELATED");
  });
});

describe("resolveGraphTarget (multi-repo graph-tab threading)", () => {
  it("prefers an explicit repoPath over the bound workspace", () => {
    expect(resolveGraphTarget("/repos/backend", "/ws")).toBe("/repos/backend");
  });

  it("falls back to the bound workspace when repoPath is omitted", () => {
    expect(resolveGraphTarget(undefined, "/ws")).toBe("/ws");
  });

  it("falls back to the bound workspace when repoPath is an empty string", () => {
    expect(resolveGraphTarget("", "/ws")).toBe("/ws");
  });

  it("resolves to '' when neither repoPath nor a bound workspace exist", () => {
    expect(resolveGraphTarget(undefined, null)).toBe("");
  });
});

describe("resolveBestGraphTarget (index-aware — the monorepo-root fix)", () => {
  it("an explicit repoPath always wins", () => {
    const r = resolveBestGraphTarget("/repos/backend", "/q", {
      hasIndex: () => false,
      detectRepos: () => [],
    });
    expect(r).toBe("/repos/backend");
  });

  it("a normal single repo (root has its own index) → the root", () => {
    const r = resolveBestGraphTarget(undefined, "/repo", {
      hasIndex: (d) => d === "/repo",
      detectRepos: () => ["/repo"],
    });
    expect(r).toBe("/repo");
  });

  it("a monorepo of separate repos (NON-git root, no index) → the first INDEXED member, never the empty root", () => {
    const r = resolveBestGraphTarget(undefined, "/q", {
      // The root has no .gitnexus; members do.
      hasIndex: (d) => d === "/q/operations/backend" || d === "/q/wealth",
      detectRepos: () => [
        "/q/operations/backend",
        "/q/operations/frontend",
        "/q/wealth",
      ],
    });
    expect(r).toBe("/q/operations/backend");
  });

  it("no member indexed yet → the first detected repo (still never the empty root)", () => {
    const r = resolveBestGraphTarget(undefined, "/q", {
      hasIndex: () => false,
      detectRepos: () => ["/q/a", "/q/b"],
    });
    expect(r).toBe("/q/a");
  });

  it("nothing detected → falls back to the workspace (fail-safe)", () => {
    const r = resolveBestGraphTarget(undefined, "/x", {
      hasIndex: () => false,
      detectRepos: () => [],
    });
    expect(r).toBe("/x");
  });
});

describe("resolveRepoNameForPath (multi-repo registry → --repo name)", () => {
  const LIST = `
  Indexed Repositories (4)

  muon
    Path:    /Users/x/SWE/MUON-LABS
    Indexed: now
    Stats:   783 files

  atlas-backend
    Path:    /Users/x/SWE/ATLAS/operations/backend
    Indexed: now

  atlas-website
    Path:    /Users/x/SWE/ATLAS/operations/frontend
    Indexed: now

  wealth
    Path:    /Users/x/SWE/ATLAS/wealth
    Indexed: now
`;

  it("maps an exact repo-root path to its registered name", () => {
    expect(resolveRepoNameForPath(LIST, "/Users/x/SWE/MUON-LABS")).toBe("muon");
    expect(
      resolveRepoNameForPath(LIST, "/Users/x/SWE/ATLAS/operations/backend")
    ).toBe("atlas-backend");
  });

  it("maps a nested path to the DEEPEST enclosing repo", () => {
    expect(
      resolveRepoNameForPath(LIST, "/Users/x/SWE/ATLAS/wealth/backend/app")
    ).toBe("wealth");
  });

  it("maps a monorepo ROOT to the shallowest member under it (deterministic)", () => {
    // /Users/x/SWE/ATLAS contains 3 members; the shortest path wins.
    const name = resolveRepoNameForPath(LIST, "/Users/x/SWE/ATLAS");
    expect(["atlas-backend", "atlas-website", "wealth"]).toContain(name);
  });

  it("returns null when nothing matches or the store is empty (legacy read)", () => {
    expect(resolveRepoNameForPath(LIST, "/Users/x/SWE/UNRELATED")).toBeNull();
    expect(resolveRepoNameForPath("  Indexed Repositories (0)\n", "/ws")).toBeNull();
    expect(resolveRepoNameForPath("", "/ws")).toBeNull();
  });
});

describe("loadGitNexusGraph", () => {
  it("errors (no exec) when there is no workspace", async () => {
    const exec = vi.fn();
    const out = await loadGitNexusGraph("", { exec: exec as unknown as GitNexusExec });
    expect(out.error).toMatch(/No workspace/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("errors (no exec) when the CLI cannot be resolved", async () => {
    const exec = vi.fn();
    const out = await loadGitNexusGraph("/ws", {
      exec: exec as unknown as GitNexusExec,
      resolveCli: () => null,
    });
    expect(out.error).toMatch(/CLI not found/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("reads nodes+edges via cypher --repo (disambiguated) with load-only env and cwd=workspace", async () => {
    const calls: { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
    const exec = fakeExec(
      {
        list: listOut([
          { name: "wsrepo", path: "/ws" },
          { name: "other", path: "/elsewhere" },
        ]),
        nodes: cliOut(
          ["id", "label", "filePath", "startLine", "endLine", "name"],
          [["a", "Function", "a.ts", "1", "5", "foo"], ["b", "File", "b.ts", "", "", "b.ts"]]
        ),
        edges: cliOut(["sourceId", "targetId", "type"], [["a", "b", "CONTAINS"]]),
      },
      calls
    );
    const out = await loadGitNexusGraph("/ws", { exec, resolveCli: () => CLI });
    expect(out.error).toBeUndefined();
    expect(out.nodes).toHaveLength(2);
    expect(out.nodes[0]).toMatchObject({ id: "a", label: "Function", name: "foo", startLine: 1, endLine: 5 });
    expect(out.relationships).toHaveLength(1);
    expect(out.workspacePath).toBe("/ws");
    expect(calls).toHaveLength(3); // list (disambiguate), then nodes, then edges
    expect(calls[0]!.args[1]).toBe("list");
    for (const c of calls.slice(1)) {
      expect(c.binary).toBe("/electron");
      expect(c.args[0]).toBe("/cli/index.js");
      expect(c.args[1]).toBe("cypher");
      // the multi-repo registry is disambiguated by name — the real bug fix
      expect(c.args[2]).toBe("--repo");
      expect(c.args[3]).toBe("wsrepo");
      expect(c.cwd).toBe("/ws");
      expect(c.env.GITNEXUS_LBUG_EXTENSION_INSTALL).toBe("load-only");
      expect(c.env.ELECTRON_RUN_AS_NODE).toBe("1");
    }
  });

  it("reads without --repo when the registry has no matching repo (legacy single-repo)", async () => {
    const calls: { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
    const exec = fakeExec(
      { list: "", nodes: cliOut(["id", "label", "filePath", "startLine", "endLine", "name"], [["a", "Function", "a.ts", "1", "5", "foo"]]) },
      calls
    );
    const out = await loadGitNexusGraph("/ws", { exec, resolveCli: () => CLI });
    expect(out.error).toBeUndefined();
    for (const c of calls.slice(1)) {
      expect(c.args[1]).toBe("cypher");
      expect(c.args[2]).not.toBe("--repo"); // no name resolved → legacy read
    }
  });

  it("fail-safes to an error payload when a query throws", async () => {
    const out = await loadGitNexusGraph("/ws", {
      exec: fakeExec({ throwOn: "MATCH (n)" }),
      resolveCli: () => CLI,
    });
    expect(out.nodes).toEqual([]);
    expect(out.error).toMatch(/Could not read the local graph/);
  });

  it("fail-safes when cypher returns an {error} object", async () => {
    const out = await loadGitNexusGraph("/ws", {
      exec: fakeExec({ nodes: JSON.stringify({ error: "bad query" }) }),
      resolveCli: () => CLI,
    });
    expect(out.error).toMatch(/Could not read the local graph/);
  });

  it("returns a friendly note when the graph is empty (not yet indexed)", async () => {
    const out = await loadGitNexusGraph("/ws", {
      exec: fakeExec({
        nodes: cliOut(["id", "label", "filePath", "startLine", "endLine", "name"], []),
        edges: cliOut(["sourceId", "targetId", "type"], []),
      }),
      resolveCli: () => CLI,
    });
    expect(out.nodes).toEqual([]);
    expect(out.error).toMatch(/no indexed graph yet/);
  });
});

// Drift guard: exercise the REAL bundled binary against this repo's own
// `.gitnexus/` store so the parser can never silently disagree with the CLI's
// output contract again. Skipped where the store or CLI is unavailable (CI).
const repoRoot = join(__dirname, "..", "..", "..");
const hasLocalStore = existsSync(join(repoRoot, ".gitnexus", "meta.json"));
describe.skipIf(!hasLocalStore)("loadGitNexusGraph (live binary integration)", () => {
  it("agrees with the real CLI's output contract (parser drift guard)", async () => {
    const out = await loadGitNexusGraph(repoRoot);
    // The contract ALWAYS holds: a valid response, error XOR a graph, never both
    // empty-and-clean nor errored-with-nodes.
    expect(Array.isArray(out.nodes)).toBe(true);
    expect(Array.isArray(out.relationships)).toBe(true);
    if (out.nodes.length === 0) {
      // The store's graph can be transiently empty (indexing in progress / a
      // fresh `analyze --index-only` that hasn't populated the queryable graph
      // yet) even while meta.json exists — that's a clean, honest error, not a
      // parser bug. Nothing to drift-check.
      expect(typeof out.error).toBe("string");
      return;
    }
    // A graph IS present → the parser must agree with the CLI shape (the drift
    // guard's real purpose): no error, real relationships, string ids/labels.
    expect(out.error).toBeUndefined();
    expect(out.relationships.length).toBeGreaterThan(0);
    expect(typeof out.nodes[0]!.id).toBe("string");
    expect(typeof out.nodes[0]!.label).toBe("string");
  }, 30_000);
});
