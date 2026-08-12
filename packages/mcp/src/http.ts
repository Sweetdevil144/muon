#!/usr/bin/env node
/**
 * ROADMAP P14 — `muon-mcp-http`, the OPT-IN loopback Streamable HTTP/SSE
 * companion to the default stdio `muon-mcp` binary (`index.ts`). Nothing
 * about vendor installation (`muon mcp install`) touches this file: stdio
 * stays the only transport a vendor CLI is ever registered against. This is
 * for a local script, a browser dev tool, or another same-host process that
 * wants the MUON MCP surface without spawning a stdio child.
 *
 * Every request must present `Authorization: Bearer <agent-or-job-token>` —
 * there is no lockfile fallback here, unlike stdio's `resolveMcpApiToken()`.
 * See `http-transport.ts` for the full invariant list.
 */
import { resolveApiBase } from "@muon/client";
import { startLoopbackMcpHttpServer } from "./http-transport.js";

export { startLoopbackMcpHttpServer, assertLoopbackHost } from "./http-transport.js";
export type {
  LoopbackMcpHttpServer,
  LoopbackMcpHttpServerOptions,
} from "./http-transport.js";

async function main() {
  const apiBase = resolveApiBase();
  const host = process.env.MUON_MCP_HTTP_HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(
    process.env.MUON_MCP_HTTP_PORT?.trim() || "0",
    10
  );
  const running = await startLoopbackMcpHttpServer({
    apiBase,
    host,
    port: Number.isFinite(port) ? port : 0,
  });
  process.stderr.write(
    `muon-mcp-http: loopback Streamable HTTP transport listening on ${running.url}\n` +
      "muon-mcp-http: every request requires 'Authorization: Bearer <agent-or-job-token>'; " +
      "MUON never widens to operator tier over this transport.\n"
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    running
      .close()
      .catch(() => undefined)
      .finally(async () => {
        process.exit(0);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isDirectRun =
  process.argv[1]?.endsWith("muon-mcp-http") ||
  process.argv[1]?.endsWith("http.js") ||
  process.argv[1]?.endsWith("http.ts");

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(
      `muon-mcp-http failed: ${error instanceof Error ? error.message : error}\n`
    );
    process.exit(1);
  });
}
