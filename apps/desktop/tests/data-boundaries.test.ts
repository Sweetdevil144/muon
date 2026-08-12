import { describe, expect, it } from "vitest";
import { loadDataBoundaries, type DataBoundaryDependencies } from "../src/lib/data-boundaries.js";

const env = (markdown: string, rowCount: number) => JSON.stringify({ markdown, row_count: rowCount });

function deps(over: Partial<DataBoundaryDependencies> = {}): DataBoundaryDependencies {
  return {
    canonicalize: async (p) => p,
    resolveCli: () => ({ binary: "/fake/node", commandPrefix: ["/cli.js"] }),
    gnxExec: async (_b, args) => {
      const command = args.find((a) => a === "list" || a === "cypher");
      if (command === "list")
        return { stdout: "\n  Indexed Repositories (1)\n\n  muon\n    Path:    /ws\n    Indexed: now\n    Commit:  abc\n", stderr: "" };
      const q = args[args.length - 1] ?? "";
      if (q.includes("f.filePath ="))
        return { stdout: env("| tbl |\n| --- |\n| memoryNote |", 1), stderr: "" };
      return {
        stdout: env("| tbl | file |\n| --- |\n| memoryNote | src/a.ts |\n| memoryNote | src/b.ts |", 2),
        stderr: "",
      };
    },
    ...over,
  };
}

describe("loadDataBoundaries", () => {
  it("resolves a file's tables + co-writers", async () => {
    const r = await loadDataBoundaries("/ws", "src/a.ts", deps());
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.boundary.hasDataBoundary).toBe(true);
    expect(r.boundary.tables[0]!.table).toBe("memoryNote");
    expect(r.boundary.tables[0]!.otherWriters).toEqual(["src/b.ts"]);
  });
  it("degrades when the CLI is missing", async () => {
    const r = await loadDataBoundaries("/ws", "src/a.ts", deps({ resolveCli: () => null }));
    expect(r.status).toBe("degraded");
  });
});
