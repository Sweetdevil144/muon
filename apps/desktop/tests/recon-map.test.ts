import { describe, expect, it } from "vitest";
import { loadReconMap, type ReconMapDependencies } from "../src/lib/recon-map.js";

const env = (markdown: string, rowCount: number) =>
  JSON.stringify({ markdown, row_count: rowCount });

function deps(over: Partial<ReconMapDependencies> = {}): ReconMapDependencies {
  return {
    canonicalize: async (p) => p,
    resolveCli: () => ({ binary: "/fake/node", commandPrefix: ["/cli.js"] }),
    gnxExec: async (_binary, args) => {
      const command = args.find((a) => a === "list" || a === "cypher");
      if (command === "list") {
        return {
          stdout: "\n  Indexed Repositories (1)\n\n  muon\n    Path:    /ws\n    Indexed: now\n    Commit:  abc\n",
          stderr: "",
        };
      }
      const query = args[args.length - 1] ?? "";
      if (query.includes("c:Community")) {
        return { stdout: env("| id | symbols | cohesion | label |\n| --- |\n| comm_0 | 40 | 0.8 | Commands |\n| comm_1 | 30 | 0.8 | Renderer |", 2), stderr: "" };
      }
      if (query.includes("MEMBER_OF")) {
        return { stdout: env("| cid | fp |\n| --- |\n| comm_0 | src/cli/a.ts |\n| comm_0 | src/cli/b.ts |\n| comm_1 | src/ui/x.tsx |", 3), stderr: "" };
      }
      if (query.includes("f:File")) {
        return { stdout: env("| fp |\n| --- |\n| src/cli/a.ts |", 1), stderr: "" };
      }
      if (query.includes("count(r)")) {
        return { stdout: env("| edges |\n| --- |\n| 100 |", 1), stderr: "" };
      }
      // labelCounts
      return { stdout: env("| label | c |\n| --- |\n| Function | 500 |\n| Community | 2 |\n| File | 1 |", 3), stderr: "" };
    },
    ...over,
  };
}

describe("loadReconMap", () => {
  it("reconnoiters the workspace repo into a map + crew recommendation", async () => {
    const result = await loadReconMap("/ws", deps());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.map.repos).toHaveLength(1);
    expect(result.map.repos[0]!.name).toBe("muon");
    expect(result.map.repos[0]!.clusters.map((c) => c.label)).toEqual(["Commands", "Renderer"]);
    expect(result.recommendation.crewSize).toBeGreaterThanOrEqual(1);
    expect(result.recommendation.caps.maxChildren).toBe(3);
  });

  it("degrades (not throws) when the CLI is missing", async () => {
    const result = await loadReconMap("/ws", deps({ resolveCli: () => null }));
    expect(result.status).toBe("degraded");
  });

  it("degrades when no indexed repo is under the workspace", async () => {
    const result = await loadReconMap(
      "/elsewhere",
      deps({ canonicalize: async (p) => p })
    );
    expect(result.status).toBe("degraded");
  });
});
