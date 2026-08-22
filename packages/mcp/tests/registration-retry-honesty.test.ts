import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "@muon/client";
import { GATE_SURFACES } from "@muon/client/github-identity-gate";
import {
  createToolDefinitions,
  lockedUnregisteredNote,
  type ToolDefinition,
} from "../src/handlers.js";
import { muonServerInstructions } from "../src/instructions.js";
import {
  MCP_IDENTITY_GATE_EXEMPT_TOOLS,
  buildMuonServer,
  type McpIdentityGate,
} from "../src/server-factory.js";

/**
 * TWO HONESTY DEFECTS, both in copy every agent reads before it does anything.
 *
 * 1. `whoami`'s `locked-unregistered` note told the agent "MUON retries
 *    automatically; do NOT ask the human to run `muon login`". The only retry
 *    loop in the tree is the DESKTOP's (`startInstallRegistrationRetry`, alive
 *    only while that app is open) — so on a CLI-only tarball whose first
 *    sign-in hit a captive portal, the agent was told to withhold the one
 *    remedy that exists.
 * 2. `initialize` opened with "a code graph over this repository" and then said
 *    "THE CODE GRAPH IS ABSENT FROM THIS INSTALL" two sentences later.
 *
 * Behaviour only: every assertion reads what a surface RETURNS, and `whoami` is
 * exercised through a real client over a real transport pair, because the thing
 * under test is what an attached session actually receives.
 */

function tools(): ToolDefinition[] {
  return createToolDefinitions(
    new MuonApiClient("http://127.0.0.1:4000", vi.fn()),
    {}
  );
}

const deferredGate: McpIdentityGate = {
  state: () => "locked-unregistered",
  refusal: () => "MUON is locked (test copy, deferred).",
};

async function whoamiNote(): Promise<string> {
  const server = buildMuonServer(tools(), {
    mode: "worker",
    identityGate: deferredGate,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const result = (await client.callTool({
    name: "whoami",
    arguments: {},
  })) as { structuredContent?: Record<string, unknown> };
  await client.close();
  return String(result.structuredContent?.identityGateNote ?? "");
}

describe("the deferred-registration note is true for the surface reading it", () => {
  const note = (surface: (typeof GATE_SURFACES)[number]) =>
    lockedUnregisteredNote({
      surface,
      stillAvailable: [...MCP_IDENTITY_GATE_EXEMPT_TOOLS],
    });

  it("a surface WITH a retry and one WITHOUT do not read the same", () => {
    // The whole defect was one sentence serving both, so the states must be
    // distinguishable at all before anything else is worth asserting.
    expect(note("desktop")).not.toBe(note("mcp"));
  });

  it("NEVER tells the reader to skip the only remedy the surface has", () => {
    for (const surface of GATE_SURFACES) {
      const text = note(surface);
      // The exact instruction that shipped, in the two ways it can be phrased.
      expect(text, surface).not.toMatch(/do NOT ask the human to run/);
      expect(text, surface).not.toMatch(/will not help/);
      // `muon login` is named on EVERY surface: where a retry exists it is the
      // fallback, and where none does it is the only thing that files the
      // record. A note that omits it sends the reader nowhere.
      expect(text, surface).toContain("muon login");
    }
  });

  it("a NO-RETRY surface says nothing here retries, and names the remedy", () => {
    const text = note("mcp");
    expect(text).toMatch(/NOTHING in this process retries it/);
    expect(text).toContain("ONLY thing that files the record");
    // Still the distinguished state: the sign-in is not what is missing, so the
    // agent must not report this as "the human never signed in".
    expect(text).toContain("NOT for want of a sign-in");
    expect(text).toContain("their sign-in worked");
  });

  it("a RETRYING surface says so, and does not promise it for the others", () => {
    const desktop = note("desktop");
    expect(desktop).toContain("retries automatically while it is open");
    expect(desktop).not.toMatch(/NOTHING in this process retries it/);
    // And the no-retry copy must not claim an automatic retry for ITSELF — it
    // may only attribute one to the surface that really has it.
    expect(note("cli")).not.toMatch(/This surface retries automatically/);
  });

  it("names the exempt tools FROM the enforced set, on every surface", () => {
    for (const surface of GATE_SURFACES) {
      for (const exempt of MCP_IDENTITY_GATE_EXEMPT_TOOLS) {
        expect(note(surface), surface).toContain(exempt);
      }
    }
  });

  it("`whoami` serves the MCP surface's note, through a real session", async () => {
    // The composer being right is worth nothing if the tool renders something
    // else, which is how this copy drifted in the first place.
    expect(await whoamiNote()).toBe(note("mcp"));
  });
});

describe("`initialize` cannot claim a code graph this install lacks", () => {
  const text = (codeGraph: "available" | "unavailable") =>
    muonServerInstructions({ toolCount: 30, codeGraph });

  it("claims the dual graph only where the CLI is reachable", () => {
    expect(text("available")).toContain("a code graph over this repository");
  });

  it("says the memory half ALONE when it is not", () => {
    const degraded = text("unavailable");
    expect(degraded).not.toContain("a code graph over this repository");
    expect(degraded).toContain("that half alone");
    // The rest of the opening sentence is unchanged — the tier and the derived
    // tool count are not collateral damage.
    expect(degraded).toContain("30 tools");
    expect(degraded).toContain("MUON is the shared brain for this machine");
  });

  it("the two sentences can NEVER both appear", () => {
    // The failure mode is additive: append the degrade and leave the assertion
    // standing, so the first thing a session reads is still false.
    for (const state of ["available", "unavailable"] as const) {
      const both =
        text(state).includes("a code graph over this repository") &&
        text(state).includes("THE CODE GRAPH IS ABSENT FROM THIS INSTALL");
      expect(both, state).toBe(false);
    }
  });
});
