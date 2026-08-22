import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildMuonServer,
  type McpIdentityGate,
  type McpTelemetryTaps,
} from "../src/server-factory.js";
import type { ToolDefinition } from "../src/handlers.js";

/**
 * ADR-0095 — the muon-mcp observatory tap, at the ONE tools/call choke point.
 *
 * The tap is a callback the ENTRY provides; the factory stays pure (it still
 * reads no token, no mode, no env — it reports facts to whoever asked). What
 * is pinned: usage coordinates only (tool name, duration, coarse outcome),
 * gate_passed at most ONCE per session and ONLY when an armed gate actually
 * passed, gate_refused per refused call, and — the fail-closed case first —
 * a session with NO gate never claims a gate passed, and a throwing tap never
 * breaks the tool call it observes.
 */

function fakeTools(): ToolDefinition[] {
  return [
    {
      name: "memory_search",
      description: "test tool",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }),
    },
    {
      name: "crashy_tool",
      description: "throws",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        throw new Error("boom");
      },
    },
    {
      name: "whoami",
      description: "exempt identity tool",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({
        content: [{ type: "text" as const, text: "locked" }],
      }),
    },
  ];
}

async function connect(options: {
  gate?: McpIdentityGate;
  telemetry?: McpTelemetryTaps;
}) {
  const server = buildMuonServer(fakeTools(), {
    mode: "worker",
    ...(options.gate ? { identityGate: options.gate } : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, close: () => client.close() };
}

const openGate: McpIdentityGate = {
  state: () => "open",
  refusal: () => "unused",
};

const closedGate: McpIdentityGate = {
  state: () => "locked",
  refusal: () => "MUON is locked (test copy).",
};

describe("mcp.tool_call tap", () => {
  it("a successful call reports (tool, duration, 'none'); a throwing handler reports 'unknown'", async () => {
    const toolCall = vi.fn();
    const { client, close } = await connect({ telemetry: { toolCall } });
    await client.callTool({ name: "memory_search", arguments: {} });
    await client.callTool({ name: "crashy_tool", arguments: {} });
    await close();

    expect(toolCall).toHaveBeenCalledTimes(2);
    const [okName, okMs, okError] = toolCall.mock.calls[0]! as [
      string,
      number,
      string,
    ];
    expect(okName).toBe("memory_search");
    expect(okMs).toBeGreaterThanOrEqual(0);
    expect(okError).toBe("none");
    expect(toolCall.mock.calls[1]![0]).toBe("crashy_tool");
    expect(toolCall.mock.calls[1]![2]).toBe("unknown");
  });

  it("an unknown tool reports 'unknown' — and the raw name is the tap's problem to coerce, not to drop", async () => {
    const toolCall = vi.fn();
    const { client, close } = await connect({ telemetry: { toolCall } });
    await client.callTool({ name: "no_such_tool", arguments: {} });
    await close();
    expect(toolCall).toHaveBeenCalledWith("no_such_tool", expect.any(Number), "unknown");
  });

  it("a gate-refused call reports 'refused' and fires gateRefused", async () => {
    const toolCall = vi.fn();
    const gateRefused = vi.fn();
    const gatePassed = vi.fn();
    const { client, close } = await connect({
      gate: closedGate,
      telemetry: { toolCall, gateRefused, gatePassed },
    });
    await client.callTool({ name: "memory_search", arguments: {} });
    await close();
    expect(toolCall).toHaveBeenCalledWith("memory_search", expect.any(Number), "refused");
    expect(gateRefused).toHaveBeenCalledTimes(1);
    expect(gatePassed).not.toHaveBeenCalled();
  });
});

describe("identity.gate_passed tap", () => {
  it("fires ONCE per session, on the first call an armed-open gate admits", async () => {
    const gatePassed = vi.fn();
    const { client, close } = await connect({
      gate: openGate,
      telemetry: { gatePassed },
    });
    await client.callTool({ name: "memory_search", arguments: {} });
    await client.callTool({ name: "memory_search", arguments: {} });
    await close();
    expect(gatePassed).toHaveBeenCalledTimes(1);
  });

  it("NEVER fires on an ungated session — no gate ran, so no gate passed", async () => {
    const gatePassed = vi.fn();
    const { client, close } = await connect({ telemetry: { gatePassed } });
    await client.callTool({ name: "memory_search", arguments: {} });
    await close();
    expect(gatePassed).not.toHaveBeenCalled();
  });

  it("NEVER fires for an EXEMPT call through a LOCKED gate — whoami on a locked machine is not a pass", async () => {
    // cubic's finding on the first draft, and it was real: the exempt carve-out
    // skips the refusal guard, and the naive "armed gate + call ran" check then
    // minted identity.gate_passed for a machine that is still locked.
    const gatePassed = vi.fn();
    const gateRefused = vi.fn();
    const { client, close } = await connect({
      gate: closedGate,
      telemetry: { gatePassed, gateRefused },
    });
    await client.callTool({ name: "whoami", arguments: {} });
    await close();
    expect(gatePassed).not.toHaveBeenCalled();
    // Nor is it a refusal — the call was admitted by the exempt carve-out.
    expect(gateRefused).not.toHaveBeenCalled();
  });
});

describe("the tap can never break the surface it observes", () => {
  it("a throwing tap does not fail the tool call", async () => {
    const { client, close } = await connect({
      gate: openGate,
      telemetry: {
        toolCall: () => {
          throw new Error("telemetry exploded");
        },
        gatePassed: () => {
          throw new Error("telemetry exploded");
        },
      },
    });
    const result = (await client.callTool({
      name: "memory_search",
      arguments: {},
    })) as { isError?: boolean };
    await close();
    expect(result.isError ?? false).toBe(false);
  });
});
