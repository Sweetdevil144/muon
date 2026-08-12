import { randomUUID } from "node:crypto";
import { createServer, type Server as NodeHttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { MuonMcpClient } from "../src/mcp-sdk.js";

/**
 * A minimal Streamable HTTP MCP server, standing in for `muon-mcp-http`
 * (`packages/mcp/src/http-transport.ts`) so `MuonMcpClient` can be exercised
 * end to end without `@muon/client` depending on `@muon/mcp` (that dependency
 * runs the other way). Records every Authorization header it observes so the
 * test can assert the SDK actually carried the bearer it was given.
 */
async function startFakeMcpServer(): Promise<{
  url: string;
  seenAuthorization: string[];
  close: () => Promise<void>;
}> {
  const seenAuthorization: string[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer: NodeHttpServer = createServer(async (req, res) => {
    seenAuthorization.push(req.headers.authorization ?? "");
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(req, res);
      return;
    }

    if (req.method === "POST" && !sessionId) {
      const mcp = new McpServer({ name: "fake-muon-mcp", version: "0.1.0" });
      mcp.registerTool(
        "memory_search",
        {
          description: "fake memory_search",
          inputSchema: { query: z.string() },
        },
        async ({ query }) => ({
          content: [{ type: "text", text: `found: ${query}` }],
        })
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => sessions.set(sid, transport),
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(400).end();
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenAuthorization,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("MuonMcpClient", () => {
  let fake: Awaited<ReturnType<typeof startFakeMcpServer>> | undefined;

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("refuses to connect with an empty token, before any network call", async () => {
    await expect(
      MuonMcpClient.connect({ baseUrl: "http://127.0.0.1:1/mcp", token: "  " })
    ).rejects.toThrow(/non-empty agent\/job token/);
  });

  it("connects, lists tools, and calls a tool, carrying the exact bearer", async () => {
    fake = await startFakeMcpServer();
    const client = await MuonMcpClient.connect({
      baseUrl: fake.url,
      token: "agent-token-123",
    });

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["memory_search"]);

    const result = await client.memorySearch("palette");
    expect(result.content).toEqual([{ type: "text", text: "found: palette" }]);

    expect(client.sessionId).toBeTruthy();
    expect(
      fake.seenAuthorization.every((header) => header === "Bearer agent-token-123")
    ).toBe(true);

    await client.close();
  });
});
