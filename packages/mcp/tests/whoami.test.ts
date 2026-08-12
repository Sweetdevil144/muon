import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "@muon/client";
import { createToolDefinitions, type ToolDefinition } from "../src/handlers.js";
import { createObserverModeToolDefinitions } from "../src/observer-tools.js";
import { buildMuonServer } from "../src/server-factory.js";

// Feature #10. `whoami` exists so a confused agent can stop guessing. Every
// assertion here is about it answering with what is TRUE of this session —
// never with what a vendor process could assert, and never with a guess in
// place of a missing coordinate.

function client(): MuonApiClient {
  return new MuonApiClient("http://127.0.0.1:4000", vi.fn());
}

function whoamiOf(tools: ToolDefinition[]): ToolDefinition {
  return tools.find((tool) => tool.name === "whoami")!;
}

async function answer(tool: ToolDefinition): Promise<Record<string, any>> {
  const result = await tool.handler({});
  return JSON.parse(result.content[0]!.text as string);
}

describe("the grant it reports is the one the server registered", () => {
  it("reports the FINAL composed list, not the base it was built from", async () => {
    // The bug this prevents: whoami is created inside the base definitions,
    // but observer/coordinator/orchestrator modes extend that list afterwards.
    // Anything computed at creation time under-reports.
    const api = client();
    const base = createToolDefinitions(api, {});
    const composed = createObserverModeToolDefinitions(api, base, {
      apiBase: "http://127.0.0.1:4000",
      apiToken: "agent-token",
      chatId: "chat-a",
    });
    buildMuonServer(composed, { mode: "observer" });

    const body = await answer(whoamiOf(composed));
    expect(body.grant.toolCount).toBe(composed.length);
    expect(body.grant.tools).toContain("fleet_status");
    expect(body.grant.mode).toBe("observer");
  });

  it("understates rather than overstates when nothing bound the surface", async () => {
    // An unbound whoami (no buildMuonServer) still answers, from the base list.
    // Under-reporting a grant is safe; over-reporting invites an agent to
    // attempt a verb it does not hold.
    const tools = createToolDefinitions(client(), {});
    const body = await answer(whoamiOf(tools));
    expect(body.grant.toolCount).toBe(tools.length);
    expect(body.grant.tools).not.toContain("dispatch");
  });
});

describe("the list is an UPPER BOUND, and says so", () => {
  // An earlier revision described this list as "the exact tools you hold" and
  // asserted `grant.tools` equalled what `buildMuonServer` had just bound —
  // a tautology guarding a false claim. This MCP process cannot see a
  // vendor-side removal (codex `disabled_tools`, claude `--disallowedTools`,
  // opencode's hardcoded permission table), each of which really does delete a
  // tool from the model's inventory. Under exactly the scenario feature #10
  // exists for, the old wording had whoami manufacture the confusion it was
  // built to end.

  it("does not claim the list is exactly what the agent holds", async () => {
    const tool = whoamiOf(createToolDefinitions(client(), {}));
    expect(tool.description).not.toMatch(/the exact tools you hold/i);
    expect(tool.description).toMatch(/upper bound/i);
  });

  it("carries a caveat naming vendor-side removal as the reason a listed tool can fail", async () => {
    const tools = createToolDefinitions(client(), {});
    buildMuonServer(tools, {});
    const body = await answer(whoamiOf(tools));
    expect(body.grant.listIs).toBe("upper-bound");
    expect(body.grant.listCaveat).toMatch(/vendor may have removed/i);
    // It must tell the agent what to DO about it, not just that it may happen.
    expect(body.grant.listCaveat).toMatch(/report it, do not retry silently/i);
  });

  it("refuses to echo an unrecognised MUON_MCP_MODE as this session's tier", async () => {
    // `options.mode` originates in an env var the vendor process can set.
    // Echoing it verbatim let `MUON_MCP_MODE=ORCHESTRATOR` sit beside a
    // worker's 27 tools — the tool list stayed honest and the label did not.
    for (const mode of ["ORCHESTRATOR", "root", "admin", "", "  "]) {
      const tools = createToolDefinitions(client(), {});
      buildMuonServer(tools, { mode });
      const body = await answer(whoamiOf(tools));
      expect(body.grant.mode, mode).toBe("worker");
    }
  });

  it("still reports a mode it was genuinely built as", async () => {
    const api = client();
    const base = createToolDefinitions(api, {});
    const composed = createObserverModeToolDefinitions(api, base, {
      apiBase: "http://127.0.0.1:4000",
      apiToken: "agent-token",
      chatId: "chat-a",
    });
    buildMuonServer(composed, { mode: "observer" });
    expect((await answer(whoamiOf(composed))).grant.mode).toBe("observer");
  });
});

describe("no coordinate can be asserted by the caller", () => {
  it("takes no arguments at all", async () => {
    const tool = whoamiOf(createToolDefinitions(client(), {}));
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("ignores anything passed anyway, rather than echoing it as identity", async () => {
    // A2A §2: an agent may not name its own job, chat, or mission. If whoami
    // echoed an argument it would become the ambient-addressing hole every
    // coordination tool is built to avoid.
    const tools = createToolDefinitions(client(), { jobId: "job-real" });
    buildMuonServer(tools, {});
    const result = await whoamiOf(tools).handler({
      jobId: "job-forged",
      chatId: "chat-forged",
      role: "orchestrator",
    });
    const body = JSON.parse(result.content[0]!.text as string);
    expect(JSON.stringify(body)).not.toContain("forged");
    expect(body.identity.jobId).toBe("job-real");
  });
});

describe("an unknown coordinate is reported unknown, never guessed", () => {
  it("says plainly when there is no dispatch lineage", async () => {
    const tools = createToolDefinitions(client(), {});
    buildMuonServer(tools, {});
    const body = await answer(whoamiOf(tools));
    expect(body.identity.governed).toBe(false);
    expect(body.identity.jobId).toBeNull();
    // Ungoverned is legitimate — a human launched this session themselves —
    // so it must read as a fact, not an error.
    expect(body.grant.note).toMatch(/not spawned by MUON/i);
  });

  it("never invents a role, and says where the real one lives", async () => {
    // Roles are keyed by vendor lane in the chat's crew plan; two agents can
    // share a vendor, so inferring one from the lane would sometimes be wrong.
    // A guessed role is worse than a missing one.
    const tools = createToolDefinitions(client(), {
      jobId: "job-1",
      laneKey: "codex",
      chatId: "chat-a",
    });
    buildMuonServer(tools, {});
    const body = await answer(whoamiOf(tools));
    expect(body.identity.role).toBeNull();
    expect(body.identity.roleNote).toContain("crew_roles");
  });

  it("names the memory partition the session is fenced to", async () => {
    const scoped = createToolDefinitions(client(), {
      jobId: "job-1",
      chatId: "chat-a",
    });
    buildMuonServer(scoped, {});
    expect((await answer(whoamiOf(scoped))).scope.memoryPartition).toBe(
      "chat:chat-a"
    );

    const unscoped = createToolDefinitions(client(), { jobId: "job-1" });
    buildMuonServer(unscoped, {});
    expect((await answer(whoamiOf(unscoped))).scope.memoryPartition).toMatch(
      /unpartitioned/
    );
  });
});

describe("it reads, and only reads", () => {
  it("makes no network call", async () => {
    // Its whole value is being answerable when everything else is failing.
    const fetcher = vi.fn();
    const tools = createToolDefinitions(
      new MuonApiClient("http://127.0.0.1:4000", fetcher),
      { jobId: "job-1" }
    );
    buildMuonServer(tools, {});
    await whoamiOf(tools).handler({});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is declared read-only and idempotent in its contract", () => {
    const tool = whoamiOf(createToolDefinitions(client(), {}));
    expect(tool.contract).toMatchObject({
      authority: "read",
      readOnly: true,
      destructive: false,
      idempotent: true,
    });
  });

  it("never returns the session's bearer token or preflight nonce", async () => {
    // Both live on the same scope object this handler reads from.
    const tools = createToolDefinitions(client(), {
      jobId: "job-1",
      apiToken: "secret-bearer-value",
      preflightNonce: "secret-nonce-value",
    });
    buildMuonServer(tools, {});
    const result = await whoamiOf(tools).handler({});
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-bearer-value");
    expect(serialized).not.toContain("secret-nonce-value");
  });
});
