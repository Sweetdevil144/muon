import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "@muon/client";
import { MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER } from "@muon/protocol";
import { MUON_EXCHANGE_CONTRACTS } from "@muon/protocol";
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

  it("discloses the exchange contracts this install speaks (ADR-0070)", async () => {
    const api = client();
    const tools = createToolDefinitions(api, {});
    const body = await answer(whoamiOf(tools));
    expect(body.contracts).toEqual({
      packetFamily: MUON_EXCHANGE_CONTRACTS.packetFamily,
      memoryPack: MUON_EXCHANGE_CONTRACTS.memoryPack,
    });
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

// ── H14: the seat, its lease, and what it deliberately cannot do ─────────────
//
// "What may I do, and what must I not" has to be answerable in ONE call. The
// failure these pin is the confident wrong answer in either direction: a
// hand-launched session describing itself as MUON's coordinator, or a real
// attached seat unable to say when its lease runs out or which verbs are absent.
describe("whoami names the seat, its lease, and its remainder", () => {
  const attachedScope = {
    seat: "attached-coordinator" as const,
    jobId: "attached-root-job",
    chatId: "attached-chat",
    attached: {
      expiresAt: "2026-08-17T09:30:00.000Z",
      bootstrap: true,
      vendor: "claude-code",
    },
  };

  it("an ATTACHED seat reports chat, job, lease expiry, bootstrap state and vendor", async () => {
    const tools = createToolDefinitions(client(), attachedScope);
    buildMuonServer(tools, { mode: "attached-coordinator" });
    const body = await answer(whoamiOf(tools));
    expect(body.seat.kind).toBe("attached-coordinator");
    expect(body.seat.chatId).toBe("attached-chat");
    expect(body.seat.jobId).toBe("attached-root-job");
    expect(body.seat.leaseExpiresAt).toBe("2026-08-17T09:30:00.000Z");
    // ADR-0049: the pre-first-heartbeat window is a DIFFERENT horizon, and a
    // seat that cannot tell the two apart mis-reads how long it has.
    expect(body.seat.bootstrap).toBe(true);
    expect(body.seat.vendor).toBe("claude-code");
  });

  it("an ATTACHED seat names the three control verbs it does NOT hold, and where they are answered", async () => {
    const tools = createToolDefinitions(client(), attachedScope);
    buildMuonServer(tools, { mode: "attached-coordinator" });
    const body = await answer(whoamiOf(tools));
    // Pinned against the protocol constant, not a literal: if the remainder
    // ever changes, this must change with it rather than quietly disagree.
    expect(body.seat.remainder).toEqual([
      ...MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER,
    ]);
    expect(body.seat.remainder).toEqual([
      "set_fleet",
      "raise_budget",
      "apply_workflow",
    ]);
    // ABSENT, not withheld: a seat told a verb is withheld tries it anyway and
    // routes around the refusal. It must also learn where the verb IS answered,
    // or "absent" reads as "impossible".
    expect(body.seat.remainderNote).toMatch(/absent/i);
    expect(body.seat.remainderNote).toMatch(/operator surface/i);
  });

  it("a seat whose lease facts never arrived says UNKNOWN rather than inventing an expiry", async () => {
    // The failure this prevents: a composed-but-unwired seat answering with a
    // reassuring default. A missing expiry must read as missing.
    const tools = createToolDefinitions(client(), {
      seat: "attached-coordinator",
      jobId: "attached-root-job",
      chatId: "attached-chat",
    });
    buildMuonServer(tools, { mode: "attached-coordinator" });
    const body = await answer(whoamiOf(tools));
    expect(body.seat.kind).toBe("attached-coordinator");
    expect(body.seat.leaseExpiresAt).toBeNull();
    expect(body.seat.bootstrap).toBeNull();
    expect(body.seat.vendor).toBeNull();
  });

  it("a plain base install is told plainly that it is NOT a coordinator", async () => {
    // The H14 acceptance criterion: a human Claude session without attach must
    // not be described as a coordinator, and must not have seat facts invented
    // for it. Silence would read as yes.
    const tools = createToolDefinitions(client(), {});
    buildMuonServer(tools, {});
    const body = await answer(whoamiOf(tools));
    expect(body.seat.kind).toBe("not-a-coordinator");
    expect(body.seat.leaseExpiresAt).toBeNull();
    expect(body.seat.vendor).toBeNull();
    expect(body.seat.remainder).toEqual([]);
    expect(body.seat.leaseNote).toMatch(/NO coordinator seat/);
    // It must name the HUMAN action that mints one, and say the session cannot.
    expect(body.seat.leaseNote).toMatch(/muon mcp attach/);
    expect(body.seat.leaseNote).toMatch(/cannot mint one for yourself/);
  });

  it("a DISPATCHED orchestrator is neither an attached seat nor a non-coordinator", async () => {
    // The two wrong answers this rules out: quoting an attach lease it never
    // had, and telling a real coordinator it holds no seat.
    const tools = createToolDefinitions(client(), {
      jobId: "orchestrator-job",
      chatId: "chat-a",
    });
    buildMuonServer(tools, { mode: "orchestrator" });
    const body = await answer(whoamiOf(tools));
    expect(body.seat.kind).toBe("dispatched-orchestrator");
    expect(body.seat.jobId).toBe("orchestrator-job");
    expect(body.seat.leaseExpiresAt).toBeNull();
    expect(body.seat.remainder).toEqual([]);
    expect(body.seat.leaseNote).toMatch(/no lease expiry to report/);
  });

  it("answers the whole seat question without a network call", async () => {
    // The lease is read from the session's own scope, never fetched: whoami's
    // value is being answerable exactly when the brain is not.
    const fetcher = vi.fn();
    const tools = createToolDefinitions(
      new MuonApiClient("http://127.0.0.1:4000", fetcher),
      attachedScope
    );
    buildMuonServer(tools, { mode: "attached-coordinator" });
    await whoamiOf(tools).handler({});
    expect(fetcher).not.toHaveBeenCalled();
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

  it("never returns the attached seat's capability token, only its coordinates", async () => {
    // H14 threaded the ATTACHED CAPABILITY's facts into whoami. The capability
    // file also holds the exact-job bearer and the delegation token, and both
    // sit on the same scope object this handler reads — so the one thing that
    // must be proved is that widening whoami's answer did not widen its
    // disclosure. The lease is a coordinate; the bearer is not.
    const tools = createToolDefinitions(client(), {
      seat: "attached-coordinator",
      jobId: "attached-root-job",
      chatId: "attached-chat",
      apiToken: "attached-capability-bearer",
      attached: {
        expiresAt: "2026-08-17T12:00:00.000Z",
        bootstrap: false,
        vendor: "claude-code",
      },
    });
    buildMuonServer(tools, { mode: "attached-coordinator" });
    const serialized = JSON.stringify(await whoamiOf(tools).handler({}));
    expect(serialized).not.toContain("attached-capability-bearer");
    expect(serialized).toContain("2026-08-17T12:00:00.000Z");
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
