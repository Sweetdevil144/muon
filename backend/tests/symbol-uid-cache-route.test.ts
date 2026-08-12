import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// ROADMAP M3 / D2 option B (docs/design/memory-index-decisions.md): a
// reader-owned, commit-stamped CACHE of GitNexus uids. This route is the ONLY
// write path into `Symbol.symbolUid`/`symbolUidAt` outside the graph's own
// tests — it must persist through `MuonGraph.cacheSymbolUid` (never the
// relational ledger) and must never overwrite a hit with a stale-commit miss.

const AGENT = "agent-token-symbol-uid-cache";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-symbol-uid-cache-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_OPERATOR_TOKEN;
  delete process.env.MUON_API_TOKEN;

  const db = await import("../src/lib/db.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await graphLib.closeGraph();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/memory/symbol-uid-cache", () => {
  it("persists each entry through MuonGraph.cacheSymbolUid, readable at the same commit", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/symbol-uid-cache",
      headers: auth(AGENT),
      payload: {
        graphCommit: "commit-route-a",
        entries: [
          {
            localId: "src/auth/guard.ts#authorize",
            gitnexusUid: "Function:src/auth/guard.ts:authorize",
          },
          {
            localId: "src/auth/session.ts#readSession",
            gitnexusUid: "Function:src/auth/session.ts:readSession",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ cached: 2 });

    const graph = graphLib.getGraph();
    await expect(
      graph.readSymbolUidCache("src/auth/guard.ts#authorize", "commit-route-a")
    ).resolves.toBe("Function:src/auth/guard.ts:authorize");
    await expect(
      graph.readSymbolUidCache(
        "src/auth/session.ts#readSession",
        "commit-route-a"
      )
    ).resolves.toBe("Function:src/auth/session.ts:readSession");
  });

  it("a later commit for the same symbol overwrites the earlier stamp", async () => {
    await app.inject({
      method: "POST",
      url: "/api/memory/symbol-uid-cache",
      headers: auth(AGENT),
      payload: {
        graphCommit: "commit-route-b",
        entries: [
          {
            localId: "src/pay/charge.ts#applyCharge",
            gitnexusUid: "Function:src/pay/charge.ts:applyCharge",
          },
        ],
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/symbol-uid-cache",
      headers: auth(AGENT),
      payload: {
        graphCommit: "commit-route-c",
        entries: [
          {
            localId: "src/pay/charge.ts#applyCharge",
            gitnexusUid: "Function:src/pay/charge.ts:applyCharge#2",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    const graph = graphLib.getGraph();
    await expect(
      graph.readSymbolUidCache("src/pay/charge.ts#applyCharge", "commit-route-b")
    ).resolves.toBeUndefined();
    await expect(
      graph.readSymbolUidCache("src/pay/charge.ts#applyCharge", "commit-route-c")
    ).resolves.toBe("Function:src/pay/charge.ts:applyCharge#2");
  });

  it("refuses an empty entries array and an oversized batch", async () => {
    const empty = await app.inject({
      method: "POST",
      url: "/api/memory/symbol-uid-cache",
      headers: auth(AGENT),
      payload: { graphCommit: "commit-route-d", entries: [] },
    });
    expect(empty.statusCode).toBe(400);

    const tooMany = await app.inject({
      method: "POST",
      url: "/api/memory/symbol-uid-cache",
      headers: auth(AGENT),
      payload: {
        graphCommit: "commit-route-e",
        entries: Array.from({ length: 129 }, (_, i) => ({
          localId: `src/bulk.ts#fn${i}`,
          gitnexusUid: `Function:src/bulk.ts:fn${i}`,
        })),
      },
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it("refuses an unauthenticated request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/symbol-uid-cache",
      payload: {
        graphCommit: "commit-route-f",
        entries: [
          {
            localId: "src/anon.ts#fn",
            gitnexusUid: "Function:src/anon.ts:fn",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a uid that does not independently map to its submitted local id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/symbol-uid-cache",
      headers: auth(AGENT),
      payload: {
        graphCommit: "commit-route-g",
        entries: [
          {
            localId: "src/auth/guard.ts#authorize",
            gitnexusUid: "Function:src/auth/guard.ts:deleteEverything",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);

    await expect(
      graphLib
        .getGraph()
        .readSymbolUidCache(
          "src/auth/guard.ts#authorize",
          "commit-route-g"
        )
    ).resolves.toBeUndefined();
  });
});
