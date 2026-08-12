import { describe, expect, it } from "vitest";
import { GOVERNED_MCP_SERVER_NAME } from "@muon/protocol";
import { MUON_MCP_SERVER_NAME } from "../src/muon-mcp-injection.js";

/**
 * `narrowProfileForRole` drops every MCP server except MUON's own governed one
 * when a role is read-only — an MCP server is a tool surface the vendor sandbox
 * does not reach, and codex ignores `deniedTools` entirely, so a stray
 * filesystem server would be a "read-only" reviewer's unbounded write path.
 *
 * Protocol cannot import core (core depends on protocol), so the name is
 * declared in both places. This test is the joint: if they ever drift, the
 * narrowing would silently strip MUON's OWN brain from every read-only role —
 * no memory, no graph, no coordination tools — and the failure would look like
 * a confusing vendor error rather than a governance regression.
 */
describe("governed MCP server name", () => {
  it("is identical in protocol and core", () => {
    expect(GOVERNED_MCP_SERVER_NAME).toBe(MUON_MCP_SERVER_NAME);
  });
});
