import { describe, expect, it } from "vitest";
import { laneProfileSchema } from "@muon/protocol";
import { withMuonMcpServer } from "../src/muon-mcp-injection.js";

const context = {
  taskId: "task-1",
  laneKey: "codex",
  jobId: "job-1",
  workspacePath: "/repo",
  preflightNonce: "runner-proof",
  apiBase: "http://localhost:4000",
};

describe("withMuonMcpServer", () => {
  it("injects the muon MCP server into an empty profile", () => {
    const profile = withMuonMcpServer(undefined, context);
    expect(profile.mcpServers).toHaveLength(1);
    expect(profile.mcpServers[0]).toMatchObject({
      name: "muon",
      command: "muon-mcp",
      env: {
        MUON_API_BASE: "http://localhost:4000",
        MUON_TASK_ID: "task-1",
        MUON_LANE_KEY: "codex",
        MUON_JOB_ID: "job-1",
        MUON_WORKSPACE: "/repo",
        MUON_PREFLIGHT_NONCE: "runner-proof",
      },
    });
  });

  it("preserves user servers and replaces stale muon entries", () => {
    const existing = laneProfileSchema.parse({
      mcpServers: [
        { name: "github", command: "gh-mcp" },
        { name: "muon", command: "muon-mcp", env: { MUON_TASK_ID: "old-task" } },
      ],
    });

    const profile = withMuonMcpServer(existing, context);

    expect(profile.mcpServers.map((s) => s.name)).toEqual(["github", "muon"]);
    const muon = profile.mcpServers.find((s) => s.name === "muon")!;
    expect(muon.env.MUON_TASK_ID).toBe("task-1");
  });

  it("passes the API token through when provided", () => {
    const profile = withMuonMcpServer(undefined, {
      ...context,
      apiToken: "secret-token",
    });
    expect(profile.mcpServers[0]!.env.MUON_API_TOKEN).toBe("secret-token");
  });
});
