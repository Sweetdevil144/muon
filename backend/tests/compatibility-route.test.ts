import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-0038 D1 slice 1 — the tier and the shape of the discovery route.
//
// The enumerator is MOCKED here on purpose: this file is about who may call the
// route and what the route lets them steer, and a real call would read the
// developer's own ~/.claude.json. The enumerator's own behaviour is covered in
// compatibility-discovery.test.ts against a temp directory.

const OPERATOR = "operator-token-compatibility";
const AGENT = "agent-token-compatibility";

const discover = vi.hoisted(() =>
  vi.fn(() => ({
    items: [
      {
        kind: "mcp_server" as const,
        name: "linear",
        provenance: { vendor: "claude-code", sourcePath: "/home/dev/.claude.json" },
        shape: {
          transport: "stdio" as const,
          command: "npx",
          args: ["-y", "linear-mcp"],
          envKeys: ["LINEAR_API_KEY"],
          headerKeys: [],
        },
        secretsRefused: ["LINEAR_API_KEY"],
        state: "discovered" as const,
      },
    ],
    unreadable: [],
    sources: [
      {
        vendor: "claude-code" as const,
        scope: "user" as const,
        sourcePath: "/home/dev/.claude.json",
        status: "read" as const,
        items: 1,
      },
    ],
  }))
);

vi.mock("../src/lib/compatibility-discovery.js", () => ({
  discoverCompatibilityInventory: discover,
}));
vi.mock("../src/lib/db.js", () => ({
  prisma: { delegationGrant: { findFirst: vi.fn() } },
}));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("GET /api/compatibility/mcp", () => {
  // ONE app for the file. Building it imports the whole route graph, which is
  // seconds of cold transform — paid once in a hook (whose budget is separate
  // from a test's) rather than five times inside the tests.
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.MUON_OPERATOR_TOKEN = OPERATOR;
    process.env.MUON_AGENT_TOKEN = AGENT;
    delete process.env.MUON_API_TOKEN;
    vi.resetModules();
    const { buildApp } = await import("../src/app.js");
    app = buildApp();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    discover.mockClear();
  });

  it("refuses an unauthenticated read", async () => {
    const read = await app.inject({
      method: "GET",
      url: "/api/compatibility/mcp",
    });
    expect(read.statusCode).toBe(401);
    expect(discover).not.toHaveBeenCalled();
  });

  it("refuses the AGENT tier", async () => {
    // ADR-0038 D1 PERMITS an agent to read the inventory; this slice does not
    // build that path. The enumerator reads the human's home directory, and the
    // response is a census of their third-party tooling — server names, the
    // absolute commands they launch, the hosts they reach. Widening this later
    // is one deleted line; narrowing it after an agent depends on it is not.
    const read = await app.inject({
      method: "GET",
      url: "/api/compatibility/mcp",
      headers: auth(AGENT),
    });
    expect(read.statusCode).toBe(403);
    expect(discover).not.toHaveBeenCalled();
  });

  it("returns the inventory to the operator", async () => {
    const read = await app.inject({
      method: "GET",
      url: "/api/compatibility/mcp",
      headers: auth(OPERATOR),
    });
    expect(read.statusCode).toBe(200);
    const body = read.json() as {
      items: { name: string; state: string }[];
      sources: { status: string }[];
    };
    expect(body.items.map((item) => item.name)).toEqual(["linear"]);
    expect(body.items[0]!.state).toBe("discovered");
    expect(body.sources).toHaveLength(1);
  });

  it("passes NOTHING from the request into the enumerator", async () => {
    // The handler reaches the filesystem. Any request field that could steer it
    // is an arbitrary-file-read oracle, so the call site must take no argument
    // at all — not a sanitized one.
    const read = await app.inject({
      method: "GET",
      url: "/api/compatibility/mcp?vendor=claude&sourcePath=%2Fetc%2Fpasswd",
      headers: auth(OPERATOR),
    });
    expect(read.statusCode).toBe(200);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0]).toHaveLength(0);
  });

  it("exposes no UNLANED and no BULK enable route", async () => {
    // Slice 2 exists now (ADR-0038 D7/D8, 2026-08-09) and every one of its
    // verbs names a lane. What must never appear is an enable that does not:
    // D6/D8 build a lane's imported set by listing what it holds, so an
    // un-laned or vendor-wide enable is not a convenience, it is a
    // workspace-wide grant with a shorter URL.
    for (const [method, url] of [
      ["POST", "/api/compatibility/mcp"],
      ["POST", "/api/compatibility/mcp/enable"],
      ["POST", "/api/compatibility/mcp/enable-all"],
      ["POST", "/api/compatibility/mcp/linear/enable"],
      ["POST", "/api/compatibility/mcp/vendors/claude/enable"],
      ["PUT", "/api/compatibility/mcp"],
      ["DELETE", "/api/compatibility/mcp"],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: auth(OPERATOR),
        payload: {},
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});
