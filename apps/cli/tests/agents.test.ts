import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuonApiHttpError } from "@muon/client";
import { registerAgentsCommand } from "../src/commands/agents.js";
import type { MuonApiClient } from "../src/lib/api-client.js";

function stubClient(overrides: Partial<MuonApiClient> = {}): MuonApiClient {
  return {
    listAgents: vi.fn(async () => [
      {
        id: "agt_abc",
        vendor: "claude-code",
        name: "claude-1",
        ordinal: 1,
        status: "idle",
        currentTaskId: null,
        currentJobId: null,
      },
    ]),
    getFleetReadinessReport: vi.fn(async () => ({
      vendors: [
        {
          vendor: "claude-code",
          installed: true,
          authenticated: true,
          detail: "ok",
        },
      ],
      anyReady: true,
      generatedAt: new Date().toISOString(),
    })),
    ...overrides,
  } as unknown as MuonApiClient;
}

describe("muon agents (TODO 7.4 / 7.6 / 7.7)", () => {
  const writes: string[] = [];
  const errors: string[] = [];

  afterEach(() => {
    writes.length = 0;
    errors.length = 0;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function run(argv: string[], client: MuonApiClient) {
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    const program = new Command();
    program.exitOverride();
    registerAgentsCommand(program, () => client);
    return program.parseAsync(["node", "muon", ...argv]);
  }

  it("prints a discovery table and a next command", async () => {
    await run(["agents"], stubClient());
    const out = writes.join("");
    expect(out).toContain("claude-1");
    expect(out).toContain("agt_abc");
    expect(out).toContain("ready");
    expect(out).toMatch(/next: muon stream read --agent-id agt_abc/);
  });

  it("supports --json", async () => {
    await run(["agents", "--json"], stubClient());
    const payload = JSON.parse(writes.join(""));
    expect(payload.agents[0].id).toBe("agt_abc");
    expect(payload.agents[0].handle).toBe("claude-code");
    expect(payload.next).toContain("agt_abc");
  });

  it("renders authz refusals with an actionable next step (exit 2)", async () => {
    const client = stubClient({
      listAgents: vi.fn(async () => {
        throw new MuonApiHttpError(403, "Forbidden", "403 Forbidden, agent tier");
      }),
    });
    await run(["agents"], client);
    expect(errors.join("")).toMatch(/muon agents/);
    expect(errors.join("")).toMatch(/you can only reach/i);
    expect(process.exitCode).toBe(2);
  });
});
