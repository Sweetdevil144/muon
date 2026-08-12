import { describe, expect, it } from "vitest";
import {
  RECON_QUERIES,
  buildRepoMap,
  collectRepoSignals,
  partitionRepo,
  partitionWorkspace,
  planReconMission,
  completenessCritique,
  recommendCrewSize,
  deriveOwnedPaths,
  deriveDisjointOwnedPaths,
  languagesOf,
  type CypherRunner,
  type RepoSignals,
} from "../src/repo-map.js";

// Fixtures shaped like the REAL local GitNexus graph (Community nodes with
// heuristicLabel + symbolCount + cohesion; MEMBER_OF links to member files).
const signals = (over: Partial<RepoSignals> = {}): RepoSignals => ({
  path: "/repo",
  name: "repo",
  indexed: true,
  stale: false,
  totals: { symbols: 100, files: 20, edges: 300, processes: 5 },
  clusters: [
    { id: "comm_0", label: "Commands", symbolCount: 43, cohesion: 0.84 },
    { id: "comm_45", label: "Renderer", symbolCount: 36, cohesion: 0.81 },
    { id: "comm_9", label: "Storage", symbolCount: 21, cohesion: 0.7 },
  ],
  members: [
    { communityId: "comm_0", filePath: "src/cli/a.ts" },
    { communityId: "comm_0", filePath: "src/cli/b.ts" },
    { communityId: "comm_0", filePath: "src/cli/c.ts" },
    { communityId: "comm_45", filePath: "src/renderer/x.tsx" },
    { communityId: "comm_45", filePath: "src/renderer/y.tsx" },
    { communityId: "comm_9", filePath: "src/db/schema.sql" },
    { communityId: "comm_9", filePath: "src/db/store.ts" },
  ],
  files: ["src/cli/a.ts", "src/renderer/x.tsx", "src/db/schema.sql", "readme.md"],
  ...over,
});

describe("languagesOf", () => {
  it("extracts distinct extensions, most-common first", () => {
    expect(languagesOf(["a.ts", "b.ts", "c.tsx", "d.sql", "Makefile"])).toEqual([
      "ts",
      "tsx",
      "sql",
    ]);
  });
});

describe("deriveOwnedPaths", () => {
  it("prefers directories that hold multiple files (as globs)", () => {
    expect(
      deriveOwnedPaths(["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"])
    ).toEqual(["src/auth/"]);
  });

  it("names loose files that live outside the chosen dirs", () => {
    const owned = deriveOwnedPaths([
      "src/auth/a.ts",
      "src/auth/b.ts",
      "src/middleware/auth.ts",
    ]);
    expect(owned).toContain("src/auth/");
    expect(owned).toContain("src/middleware/auth.ts");
  });

  it("caps the number of owned paths", () => {
    const many = Array.from({ length: 40 }, (_, i) => `d${i}/f1.ts`).concat(
      Array.from({ length: 40 }, (_, i) => `d${i}/f2.ts`)
    );
    expect(deriveOwnedPaths(many, 8).length).toBeLessThanOrEqual(8);
  });
});

describe("buildRepoMap (Recon M1)", () => {
  it("projects clusters with sizes, owned paths, languages and weight", () => {
    const map = buildRepoMap({ workspacePath: "/repo", repos: [signals()] });
    expect(map.repos).toHaveLength(1);
    const repo = map.repos[0]!;
    expect(repo.clusters.map((c) => c.label)).toEqual([
      "Commands",
      "Renderer",
      "Storage",
    ]); // ranked by symbolCount desc
    const commands = repo.clusters[0]!;
    expect(commands.ownedPaths).toEqual(["src/cli/"]);
    expect(commands.fileCount).toBe(3);
    expect(commands.weight).toBeCloseTo(0.43, 2); // 43/100
    const storage = repo.clusters[2]!;
    expect(storage.languages).toEqual(expect.arrayContaining(["sql", "ts"]));
  });

  it("full confidence when every repo is indexed; totals aggregate", () => {
    const map = buildRepoMap({ workspacePath: "/repo", repos: [signals()] });
    expect(map.confidence).toBe("full");
    expect(map.totals).toEqual({ repos: 1, symbols: 100, clusters: 3 });
  });

  it("multi-repo monorepo: one RepoUnit per member, symbols summed", () => {
    const map = buildRepoMap({
      workspacePath: "/q",
      repos: [
        signals({ path: "/q/backend", name: "backend" }),
        signals({
          path: "/q/frontend",
          name: "frontend",
          totals: { symbols: 50, files: 10, edges: 120, processes: 2 },
        }),
      ],
    });
    expect(map.repos.map((r) => r.name)).toEqual(["backend", "frontend"]);
    expect(map.totals.repos).toBe(2);
    expect(map.totals.symbols).toBe(150);
  });

  it("partial confidence when a member is unindexed / degraded (never an error)", () => {
    const map = buildRepoMap({
      workspacePath: "/q",
      repos: [
        signals({ name: "backend" }),
        signals({
          name: "frontend",
          indexed: false,
          degraded: "not indexed yet",
          clusters: [],
          members: [],
          files: [],
          totals: { symbols: 0, files: 0, edges: 0, processes: 0 },
        }),
      ],
    });
    expect(map.confidence).toBe("partial");
    expect(map.repos[1]!.degraded).toBe("not indexed yet");
  });

  it("never reports full confidence for an EMPTY payload the collector called clean", () => {
    // C4. `collectRepoSignals` only sets `degraded` when a query THREW. A stale
    // or half-built index answers every query successfully with zero rows, so a
    // repo came back indexed, un-degraded and completely empty — and confidence,
    // which read only those flags, called it "full". The coordinator was handed
    // full confidence with zero clusters and zero ownedPaths and had to find the
    // entrypoint by hand. Confidence now derives from the payload.
    const map = buildRepoMap({
      workspacePath: "/repo",
      repos: [signals({ clusters: [], members: [], clusterCount: 0 })],
    });
    expect(map.totals.clusters).toBe(0);
    expect(map.confidence).not.toBe("full");
    expect(map.confidence).toBe("coarse");
    // And it says WHY, with the repair — an empty scope that arrives with its
    // cause attached is a signal; a silent zero at full confidence is not.
    expect(map.repos[0]!.degraded).toMatch(/no functional clusters/i);
    expect(map.repos[0]!.degraded).toMatch(/analyze --force/);
  });

  it("never reports full confidence for a wholly empty index", () => {
    const map = buildRepoMap({
      workspacePath: "/repo",
      repos: [
        signals({
          clusters: [],
          members: [],
          files: [],
          clusterCount: 0,
          totals: { symbols: 0, files: 0, edges: 0, processes: 0 },
        }),
      ],
    });
    expect(map.confidence).toBe("coarse");
    expect(map.repos[0]!.degraded).toMatch(/index is empty \(0 files, 0 symbols\)/i);
  });

  it("a stale index is never full confidence, and staleness is named as the reason", () => {
    // The map is complete but BEHIND HEAD, which is a different caveat from a
    // coarse one and a different repair. It was collected and then ignored.
    const map = buildRepoMap({
      workspacePath: "/repo",
      repos: [signals({ stale: true })],
    });
    expect(map.repos[0]!.clusters.length).toBeGreaterThan(0);
    expect(map.confidence).toBe("partial");
    const plan = planReconMission({
      map,
      mission: "examine",
      caps: { maxChildren: 3, maxDescendants: 8 },
    });
    expect(plan.notes.join(" ")).toMatch(/Indexed before the current HEAD: repo/);
  });

  it("a full-confidence map still requires a real payload behind it", () => {
    // The other direction, so the rule cannot be satisfied by weakening it: a
    // fresh, clustered, path-carrying index is still "full".
    const map = buildRepoMap({ workspacePath: "/repo", repos: [signals()] });
    expect(map.confidence).toBe("full");
    expect(map.repos[0]!.degraded).toBeUndefined();
    expect(
      map.repos[0]!.clusters.some((cluster) => cluster.ownedPaths.length > 0)
    ).toBe(true);
  });

  it("coarse confidence when EVERY repo is degraded (no graph anywhere)", () => {
    const map = buildRepoMap({
      workspacePath: "/x",
      repos: [
        signals({ degraded: "gitnexus CLI not found", clusters: [], members: [] }),
      ],
    });
    expect(map.confidence).toBe("coarse");
  });

  it("caps clusters per repo and flags truncation", () => {
    const clusters = Array.from({ length: 40 }, (_, i) => ({
      id: `comm_${i}`,
      label: `C${i}`,
      symbolCount: 40 - i,
      cohesion: 0.8,
    }));
    const map = buildRepoMap({
      workspacePath: "/big",
      repos: [signals({ clusters, members: [] })],
    });
    expect(map.repos[0]!.clusters.length).toBeLessThanOrEqual(24);
    expect(map.repos[0]!.clustersTruncated).toBe(true);
  });
});

describe("collectRepoSignals (offline Cypher collector)", () => {
  // A fake cypher runner returning rows shaped like the REAL local GitNexus
  // graph (from the schema probe): Community rows, MEMBER_OF member rows, File
  // rows, label counts, edge count.
  const fakeCypher: CypherRunner = async (query) => {
    if (query === RECON_QUERIES.clusters) {
      return [
        { id: "comm_0", label: "Commands", symbols: 43, cohesion: 0.84 },
        { id: "comm_45", label: "Renderer", symbols: 36, cohesion: 0.81 },
      ];
    }
    if (query === RECON_QUERIES.members) {
      return [
        { cid: "comm_0", fp: "src/cli/a.ts" },
        { cid: "comm_0", fp: "src/cli/b.ts" },
        { cid: "comm_45", fp: "src/renderer/x.tsx" },
      ];
    }
    if (query === RECON_QUERIES.files) {
      return [{ fp: "src/cli/a.ts" }, { fp: "src/renderer/x.tsx" }];
    }
    if (query === RECON_QUERIES.labelCounts) {
      return [
        { label: "Function", c: 2858 },
        { label: "Const", c: 8260 },
        { label: "File", c: 783 },
        { label: "Process", c: 300 },
        { label: "Community", c: 311 }, // NOT counted as a symbol
      ];
    }
    if (query === RECON_QUERIES.edgeCount) return [{ edges: 12000 }];
    return [];
  };

  it("projects real Cypher rows into RepoSignals (symbols exclude File/Community/Process)", async () => {
    const s = await collectRepoSignals(
      { path: "/repo", name: "muon", indexed: true, stale: false },
      fakeCypher
    );
    expect(s.totals.symbols).toBe(2858 + 8260); // Function + Const only
    expect(s.totals.files).toBe(783);
    expect(s.totals.processes).toBe(300);
    expect(s.clusters.map((c) => c.label)).toEqual(["Commands", "Renderer"]);
    expect(s.members).toHaveLength(3);
    expect(s.clusterCount).toBe(311); // Community label count
    // end-to-end into the map:
    const map = buildRepoMap({ workspacePath: "/repo", repos: [s] });
    expect(map.repos[0]!.clusters[0]!.ownedPaths).toEqual(["src/cli/"]);
  });

  it("an unindexed repo degrades to coarse, never throws", async () => {
    const s = await collectRepoSignals(
      { path: "/q/frontend", name: "frontend", indexed: false, stale: null },
      fakeCypher
    );
    expect(s.degraded).toMatch(/not indexed/i);
    expect(s.clusters).toEqual([]);
  });

  it("a cypher failure degrades to coarse with the reason, never throws", async () => {
    const boom: CypherRunner = async () => {
      throw new Error("Multiple repositories indexed. Specify --repo");
    };
    const s = await collectRepoSignals(
      { path: "/repo", name: "muon", indexed: true, stale: false },
      boom
    );
    expect(s.degraded).toMatch(/multiple repositories/i);
  });
});

describe("recommendCrewSize (Recon M2)", () => {
  const caps = { maxChildren: 3, maxDescendants: 8 };
  const mapWith = (over: Partial<RepoSignals>[] ) =>
    buildRepoMap({ workspacePath: "/w", repos: over.map((o) => signals(o)) });

  it("0 for a trivial repo the superagent should just examine itself", () => {
    const map = buildRepoMap({
      workspacePath: "/w",
      repos: [
        signals({
          totals: { symbols: 120, files: 4, edges: 30, processes: 0 },
          clusters: [{ id: "comm_0", label: "All", symbolCount: 120, cohesion: 0.9 }],
          members: [],
        }),
      ],
    });
    expect(recommendCrewSize({ map, caps })).toBe(0);
  });

  it("clamps a big single repo's cluster count to maxChildren", () => {
    const clusters = Array.from({ length: 12 }, (_, i) => ({
      id: `comm_${i}`,
      label: `C${i}`,
      symbolCount: 100,
      cohesion: 0.8,
    }));
    const map = mapWith([{ clusters, members: [], totals: { symbols: 1200, files: 200, edges: 5000, processes: 40 } }]);
    expect(recommendCrewSize({ map, caps })).toBe(3); // 12 clusters clamped to maxChildren
  });

  it("a monorepo fans out per-repo, clamped by caps", () => {
    const map = mapWith([
      { path: "/w/a", name: "a" },
      { path: "/w/b", name: "b" },
    ]);
    expect(recommendCrewSize({ map, caps })).toBe(2);
  });

  it("a tight budget shrinks the crew below the cap", () => {
    const clusters = Array.from({ length: 12 }, (_, i) => ({
      id: `comm_${i}`, label: `C${i}`, symbolCount: 100, cohesion: 0.8,
    }));
    const map = mapWith([{ clusters, members: [], totals: { symbols: 1200, files: 200, edges: 5000, processes: 40 } }]);
    // budget only affords 1 agent at 10min each
    expect(recommendCrewSize({ map, caps, budgetMs: 10 * 60_000, perAgentMs: 10 * 60_000 })).toBe(1);
  });

  it("never exceeds maxDescendants even if maxChildren is generous", () => {
    const clusters = Array.from({ length: 30 }, (_, i) => ({
      id: `comm_${i}`, label: `C${i}`, symbolCount: 50, cohesion: 0.8,
    }));
    const map = mapWith([{ clusters, members: [], totals: { symbols: 1500, files: 300, edges: 6000, processes: 40 } }]);
    expect(recommendCrewSize({ map, caps: { maxChildren: 20, maxDescendants: 8 } })).toBe(8);
  });
});

describe("partitionRepo / partitionWorkspace (Recon M3)", () => {
  it("n >= clusters: one disjoint work-unit per cluster", () => {
    const map = buildRepoMap({ workspacePath: "/repo", repos: [signals()] });
    const units = partitionRepo(map.repos[0]!, 3);
    expect(units).toHaveLength(3);
    expect(units.map((u) => u.scope)).toEqual(["Commands", "Renderer", "Storage"]);
    expect(units[0]!.ownedPaths).toEqual(["src/cli/"]);
    // disjoint: no path appears in two units
    const all = units.flatMap((u) => u.ownedPaths);
    expect(new Set(all).size).toBe(all.length);
  });

  it("n < clusters: largest-first balanced packing into n buckets", () => {
    const map = buildRepoMap({ workspacePath: "/repo", repos: [signals()] });
    const units = partitionRepo(map.repos[0]!, 2);
    expect(units).toHaveLength(2);
    // biggest cluster (Commands=43) alone; Renderer(36)+Storage(21)=57 together,
    // OR balanced: 43 vs 57. Every cluster is placed exactly once.
    const ids = units.flatMap((u) => u.clusterIds).sort();
    expect(ids).toEqual(["comm_0", "comm_45", "comm_9"]);
    expect(units.every((u) => u.clusterIds.length >= 1)).toBe(true);
  });

  it("a repo with no clusters yields one whole-repo unit", () => {
    const map = buildRepoMap({
      workspacePath: "/repo",
      repos: [signals({ clusters: [], members: [] })],
    });
    const units = partitionRepo(map.repos[0]!, 3);
    expect(units).toHaveLength(1);
    expect(units[0]!.clusterIds).toEqual([]);
  });

  it("partitionWorkspace: multi-repo scopes each unit to its own directory", () => {
    const map = buildRepoMap({
      workspacePath: "/q",
      repos: [
        signals({ path: "/q/operations/backend", name: "backend" }),
        signals({ path: "/q/operations/frontend", name: "frontend",
          totals: { symbols: 50, files: 10, edges: 120, processes: 2 } }),
      ],
    });
    const units = partitionWorkspace(map, 2);
    expect(units.map((u) => u.ownedPaths[0])).toEqual([
      "operations/backend/",
      "operations/frontend/",
    ]);
  });

  it("partitionWorkspace: n < repos picks the largest repos", () => {
    const map = buildRepoMap({
      workspacePath: "/q",
      repos: [
        signals({ path: "/q/small", name: "small", totals: { symbols: 10, files: 2, edges: 5, processes: 0 } }),
        signals({ path: "/q/big", name: "big", totals: { symbols: 500, files: 80, edges: 900, processes: 20 } }),
      ],
    });
    const units = partitionWorkspace(map, 1);
    expect(units).toHaveLength(1);
    expect(units[0]!.scope).toBe("big");
  });
});

describe("planReconMission (Recon M4 — pure planner)", () => {
  const caps = { maxChildren: 3, maxDescendants: 8 };

  it("fan-out plan: one scope-fenced unit per disjoint work-unit", () => {
    const map = buildRepoMap({ workspacePath: "/repo", repos: [signals()] });
    const plan = planReconMission({ map, mission: "examine codebase", caps });
    expect(plan.strategy).toBe("fan-out");
    expect(plan.crewSize).toBeGreaterThanOrEqual(1);
    expect(plan.units.length).toBe(plan.crewSize);
    // every unit's prompt fences to its own paths + carries the mission
    for (const unit of plan.units) {
      expect(unit.prompt).toContain("examine codebase");
      expect(unit.prompt).toContain(unit.ownedPaths[0]!);
      expect(unit.prompt).toMatch(/ONLY these paths/);
    }
    // disjoint owned paths across units
    const all = plan.units.flatMap((u) => u.ownedPaths);
    expect(new Set(all).size).toBe(all.length);
    // weights sum to ~1 (share of mission symbols)
    const w = plan.units.reduce((s, u) => s + u.weight, 0);
    expect(w).toBeGreaterThan(0);
  });

  it("solo plan for a trivial repo (no fan-out, honest note)", () => {
    const map = buildRepoMap({
      workspacePath: "/repo",
      repos: [
        signals({
          totals: { symbols: 120, files: 4, edges: 20, processes: 0 },
          clusters: [{ id: "comm_0", label: "All", symbolCount: 120, cohesion: 0.9 }],
          members: [],
        }),
      ],
    });
    const plan = planReconMission({ map, mission: "examine", caps });
    expect(plan.strategy).toBe("solo");
    expect(plan.crewSize).toBe(0);
    expect(plan.units).toEqual([]);
    expect(plan.notes.join(" ")).toMatch(/examine.*directly|small enough/i);
  });

  it("monorepo plan: per-repo scopes with directory ownedPaths", () => {
    const map = buildRepoMap({
      workspacePath: "/q",
      repos: [
        signals({ path: "/q/operations/backend", name: "backend" }),
        signals({ path: "/q/operations/frontend", name: "frontend",
          totals: { symbols: 50, files: 10, edges: 120, processes: 2 } }),
      ],
    });
    const plan = planReconMission({ map, mission: "audit", caps });
    expect(plan.strategy).toBe("fan-out");
    expect(plan.units.map((u) => u.ownedPaths[0]).sort()).toEqual([
      "operations/backend/",
      "operations/frontend/",
    ]);
  });

  it("records honesty notes for a degraded (partial) map, still runnable", () => {
    const map = buildRepoMap({
      workspacePath: "/q",
      repos: [
        signals({ name: "backend" }),
        signals({ name: "frontend", indexed: false, degraded: "not indexed yet",
          clusters: [], members: [], files: [],
          totals: { symbols: 0, files: 0, edges: 0, processes: 0 } }),
      ],
    });
    const plan = planReconMission({ map, mission: "examine", caps });
    expect(plan.confidence).toBe("partial");
    expect(plan.notes.join(" ")).toMatch(/partial|not indexed/i);
    expect(plan.units.length).toBeGreaterThanOrEqual(1); // still dispatchable
  });
});

describe("disjointness hardening (review finding #1)", () => {
  it("deriveDisjointOwnedPaths: two communities sharing a dir do NOT emit the same glob", () => {
    // Both communities live under src/core/ — the naive per-cluster projection
    // emitted ["src/core/"] for BOTH (overlap). The disjoint deriver must not.
    const paths = deriveDisjointOwnedPaths([
      { id: "comm_0", files: ["src/core/auth1.ts", "src/core/auth2.ts"] },
      { id: "comm_1", files: ["src/core/bill1.ts", "src/core/bill2.ts"] },
    ]);
    const a = paths.get("comm_0")!;
    const b = paths.get("comm_1")!;
    // no path in a overlaps any path in b (identical, ancestor, or descendant)
    const overlaps = (x: string, y: string) => {
      const sx = x.replace(/\/$/, ""), sy = y.replace(/\/$/, "");
      return sx === sy || sx.startsWith(sy + "/") || sy.startsWith(sx + "/");
    };
    for (const x of a) for (const y of b) expect(overlaps(x, y)).toBe(false);
    // and every file is still covered by exactly one side
    expect([...a, ...b].length).toBeGreaterThan(0);
  });

  it("nested dirs across communities stay disjoint (parent falls back to files)", () => {
    const paths = deriveDisjointOwnedPaths([
      { id: "comm_0", files: ["src/a.ts", "src/b.ts"] }, // wants src/
      { id: "comm_1", files: ["src/sub/x.ts", "src/sub/y.ts"] }, // wants src/sub/
    ]);
    const a = paths.get("comm_0")!;
    const b = paths.get("comm_1")!;
    // comm_1 can own src/sub/; comm_0 must NOT own src/ (it contains src/sub/)
    expect(b).toContain("src/sub/");
    expect(a).not.toContain("src/");
    expect(a).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
  });

  it("buildRepoMap yields pairwise-disjoint cluster ownedPaths on shared dirs", () => {
    const map = buildRepoMap({
      workspacePath: "/r",
      repos: [
        signals({
          clusters: [
            { id: "comm_0", label: "Auth", symbolCount: 30, cohesion: 0.8 },
            { id: "comm_1", label: "Billing", symbolCount: 20, cohesion: 0.8 },
          ],
          members: [
            { communityId: "comm_0", filePath: "src/core/auth1.ts" },
            { communityId: "comm_0", filePath: "src/core/auth2.ts" },
            { communityId: "comm_1", filePath: "src/core/bill1.ts" },
            { communityId: "comm_1", filePath: "src/core/bill2.ts" },
          ],
          files: ["src/core/auth1.ts"],
        }),
      ],
    });
    const units = partitionRepo(map.repos[0]!, 2);
    const all = units.flatMap((u) => u.ownedPaths);
    expect(new Set(all).size).toBe(all.length); // no duplicate path across units
  });
});

describe("robustness hardening (review findings #2, #3)", () => {
  it("uses load-bearing memory to avoid a false solo recommendation", () => {
    const map = buildRepoMap({
      workspacePath: "/small",
      repos: [
        signals({
          totals: { symbols: 120, files: 4, edges: 20, processes: 0 },
          clusters: [
            { id: "comm_0", label: "All", symbolCount: 120, cohesion: 0.9 },
          ],
          members: [],
          clusterCount: 1,
        }),
      ],
    });
    const memory = {
      hotModules: [{ module: "src/core.ts", score: 0.9, noteCount: 3 }],
      communities: [{ id: "community-1", noteCount: 3, moduleCount: 1 }],
    };
    const caps = { maxChildren: 3, maxDescendants: 8 };

    expect(recommendCrewSize({ map, caps })).toBe(0);
    expect(recommendCrewSize({ map, caps, memory })).toBe(1);
    expect(
      planReconMission({ map, mission: "audit", caps, memory }).notes.join(" ")
    ).toMatch(/load-bearing/i);
  });

  it("recommendCrewSize never returns NaN for a NaN/Infinity/0 budget", () => {
    const map = buildRepoMap({ workspacePath: "/r", repos: [signals()] });
    const caps = { maxChildren: 3, maxDescendants: 8 };
    for (const budgetMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      const n = recommendCrewSize({ map, caps, budgetMs });
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  it("planReconMission does not throw on a NaN budget (was a TypeError)", () => {
    const map = buildRepoMap({ workspacePath: "/r", repos: [signals()] });
    const caps = { maxChildren: 3, maxDescendants: 8 };
    expect(() =>
      planReconMission({ map, mission: "x", caps, budgetMs: Number.NaN })
    ).not.toThrow();
  });

  it("deriveOwnedPaths drops absolute paths and `..` traversal", () => {
    expect(deriveOwnedPaths(["/etc/passwd", "/etc/shadow"])).toEqual([]);
    expect(deriveOwnedPaths(["../../secrets/a.ts", "../../secrets/b.ts"])).toEqual([]);
    expect(deriveOwnedPaths(["C:\\Windows\\a.ts", "C:\\Windows\\b.ts"])).toEqual([]);
    // safe relative paths still work
    expect(deriveOwnedPaths(["src/a.ts", "src/b.ts"])).toEqual(["src/"]);
  });
});

describe("completenessCritique (Recon M5 — coverage diagnostic)", () => {
  const caps = { maxChildren: 3, maxDescendants: 8 };

  it("flags a follow-up when clusters are truncated (big repo, small crew)", () => {
    const clusters = Array.from({ length: 60 }, (_, i) => ({
      id: `comm_${i}`, label: `C${i}`, symbolCount: 100, cohesion: 0.8,
    }));
    const map = buildRepoMap({
      workspacePath: "/big",
      repos: [signals({
        clusters, members: [], clusterCount: 60,
        totals: { symbols: 6000, files: 400, edges: 9000, processes: 40 },
      })],
    });
    const plan = planReconMission({ map, mission: "examine", caps });
    const critique = completenessCritique(map, plan);
    expect(critique.totalClusters).toBe(60);
    expect(critique.coveredClusters).toBeLessThan(60); // cap-3 crew of top-24
    expect(critique.symbolCoverage).toBeLessThan(0.9);
    expect(critique.recommendFollowUp).toBe(true);
    expect(critique.gaps.join(" ")).toMatch(/uncovered|symbols|waves/i);
  });

  it("a solo plan is complete by construction", () => {
    const map = buildRepoMap({
      workspacePath: "/small",
      repos: [signals({
        totals: { symbols: 120, files: 4, edges: 20, processes: 0 },
        clusters: [{ id: "comm_0", label: "All", symbolCount: 120, cohesion: 0.9 }],
        members: [], clusterCount: 1,
      })],
    });
    const plan = planReconMission({ map, mission: "x", caps });
    const critique = completenessCritique(map, plan);
    expect(plan.strategy).toBe("solo");
    expect(critique.recommendFollowUp).toBe(false);
    expect(critique.symbolCoverage).toBe(1);
  });

  it("a monorepo plan that covers every member repo needs no follow-up", () => {
    const map = buildRepoMap({
      workspacePath: "/q",
      repos: [
        signals({ path: "/q/a", name: "a", clusterCount: 3 }),
        signals({ path: "/q/b", name: "b", clusterCount: 3,
          totals: { symbols: 50, files: 10, edges: 120, processes: 2 } }),
      ],
    });
    const plan = planReconMission({ map, mission: "audit", caps });
    const critique = completenessCritique(map, plan);
    // both repos are units → symbols fully covered
    expect(critique.symbolCoverage).toBe(1);
    expect(critique.recommendFollowUp).toBe(false);
  });
});
