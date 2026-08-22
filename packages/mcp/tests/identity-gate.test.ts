import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "@muon/client";
import {
  isIdentityGateState,
  markInstallRegistrationPending,
  writeIdentityCredential,
} from "@muon/client/github-identity-gate";
import { resolveMcpIdentityGate } from "../src/identity-gate.js";
import { createToolDefinitions, type ToolDefinition } from "../src/handlers.js";
import {
  MCP_IDENTITY_GATE_EXEMPT_TOOLS,
  buildMuonServer,
  type McpIdentityGate,
} from "../src/server-factory.js";

/**
 * ADR-0052 at the MCP boundary. Every assertion goes through a REAL client over
 * a real transport pair — initialize, tools/list, tools/call — because the
 * behaviour under test is what an attached vendor session actually observes,
 * and a handler poked directly would not prove the handshake still completes.
 */

const GRANT = {
  token: "b".repeat(64),
  issuedAt: "2026-08-17T00:00:00.000Z",
  version: 1,
};

function tools(): ToolDefinition[] {
  return createToolDefinitions(
    new MuonApiClient("http://127.0.0.1:4000", vi.fn()),
    {}
  );
}

async function connect(gate?: McpIdentityGate) {
  const server = buildMuonServer(tools(), {
    mode: "worker",
    ...(gate ? { identityGate: gate } : {}),
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

function closedGate(): McpIdentityGate {
  return {
    state: () => "locked",
    refusal: () => "MUON is locked (test copy). Run `muon login`.",
  };
}

/** ADR-0052 F3 — verified here, registration not landed. Refuses identically
 *  and must never be described with the sign-in remedy. */
function deferredGate(): McpIdentityGate {
  return {
    state: () => "locked-unregistered",
    refusal: () => "MUON is locked (test copy, deferred).",
  };
}

const openGate: McpIdentityGate = {
  state: () => "open",
  refusal: () => "unused",
};

describe("a GATED muon-mcp still completes the handshake", () => {
  it("initialize answers, and the instructions say the session is locked", async () => {
    const { client, close } = await connect(closedGate());
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("MUON IS LOCKED ON THIS MACHINE");
    expect(instructions).toContain("muon login");
    // The ordinary voice is still there — the gate appends, it does not replace.
    expect(instructions.length).toBeGreaterThan(200);
    await close();
  });

  it("tools/list still answers with the full list — listing is not work", async () => {
    const { client, close } = await connect(closedGate());
    const listed = await client.listTools();
    expect(listed.tools.length).toBe(tools().length);
    expect(listed.tools.map((tool) => tool.name)).toContain("memory_search");
    await close();
  });
});

describe("a GATED muon-mcp refuses tools/call", () => {
  it("refuses EVERY tool outside the positive exempt pair", async () => {
    const { client, close } = await connect(closedGate());
    const gated = tools()
      .map((tool) => tool.name)
      .filter((name) => !MCP_IDENTITY_GATE_EXEMPT_TOOLS.has(name));
    expect(gated.length).toBeGreaterThan(20);

    for (const name of gated) {
      const result = (await client.callTool({ name, arguments: {} })) as {
        isError?: boolean;
        structuredContent?: { error?: string };
      };
      expect(result.isError, name).toBe(true);
      expect(result.structuredContent?.error, name).toContain("MUON is locked");
    }
    await close();
  });

  it("the exempt set is exactly `whoami` — pinned, so it cannot quietly widen", () => {
    // A NUMBER and a name, because every loop below iterates this set: a set that
    // grew by one would silently exempt a tool nobody reviewed, and a set that
    // emptied would make the "still answers" test vacuous.
    expect([...MCP_IDENTITY_GATE_EXEMPT_TOOLS]).toEqual(["whoami"]);
  });

  it("whoami still answers — a locked session must be able to ask why", async () => {
    const { client, close } = await connect(closedGate());
    // Guard first: an exempt name that is not a REAL tool would make every
    // assertion below pass vacuously ("Unknown tool" also lacks the gate copy).
    const registered = new Set(tools().map((tool) => tool.name));
    for (const name of MCP_IDENTITY_GATE_EXEMPT_TOOLS) {
      expect(registered.has(name), `${name} must be a registered tool`).toBe(true);
    }
    for (const name of MCP_IDENTITY_GATE_EXEMPT_TOOLS) {
      const result = (await client.callTool({ name, arguments: {} })) as {
        isError?: boolean;
        structuredContent?: { error?: string };
      };
      expect(result.structuredContent?.error ?? "", name).not.toContain(
        "MUON is locked"
      );
    }
    await close();
  });

  it("capability_preflight is NOT exempt — it reads the crew, and used to do it locked", async () => {
    // The exemption's own justification said it "neither touches memory, the
    // crew, or the filesystem". `collectCapabilityPreflight` fans out to four
    // governed brain reads in a Promise.all — brain health, vendor/fleet
    // readiness, the runner, and `getFleet`, which IS the crew. So a locked
    // install served crew composition and per-vendor readiness to any agent that
    // asked, through the one exemption whose stated reason was that it did not.
    expect(MCP_IDENTITY_GATE_EXEMPT_TOOLS.has("capability_preflight")).toBe(false);
    // And it is still a real tool, so this is a refusal rather than an
    // "Unknown tool" that would pass for the wrong reason.
    expect(tools().some((tool) => tool.name === "capability_preflight")).toBe(true);

    const { client, close } = await connect(closedGate());
    const result = (await client.callTool({
      name: "capability_preflight",
      arguments: {},
    })) as { isError?: boolean; structuredContent?: { error?: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toContain("MUON is locked");
    await close();
  });

  it("refuses just as hard in the locked-unregistered state", async () => {
    // The distinguished state changes the COPY, never the authority. A state
    // that read as permission at any of the three sites that consult it would
    // be the bounded-surface failure this repo has paid for twice.
    const { client, close } = await connect(deferredGate());
    const result = (await client.callTool({
      name: "memory_search",
      arguments: {},
    })) as { isError?: boolean; structuredContent?: { error?: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toContain("deferred");
    // And the handshake still names the lock.
    expect(client.getInstructions() ?? "").toContain("MUON IS LOCKED");
    await close();
  });

  it("refuses an UNKNOWN tool with the gate copy, not with 'unknown tool'", async () => {
    // The gate is checked before resolution on purpose: a gated session must not
    // be able to enumerate which tool names exist by watching which error it gets.
    const { client, close } = await connect(closedGate());
    const result = (await client.callTool({
      name: "definitely_not_a_tool",
      arguments: {},
    })) as { structuredContent?: { error?: string } };
    expect(result.structuredContent?.error).toContain("MUON is locked");
    await close();
  });

  it("opens the moment satisfaction flips, with no restart", async () => {
    let locked = true;
    const { client, close } = await connect({
      state: () => (locked ? "locked" : "open"),
      refusal: () => "MUON is locked (test copy).",
    });
    const first = (await client.callTool({ name: "repo_map", arguments: {} })) as {
      structuredContent?: { error?: string };
    };
    expect(first.structuredContent?.error).toContain("MUON is locked");
    locked = false;
    const second = (await client.callTool({
      name: "repo_map",
      arguments: {},
    })) as { structuredContent?: { error?: string } };
    expect(second.structuredContent?.error ?? "").not.toContain("MUON is locked");
    await close();
  });
});

/**
 * ADR-0052 — `whoami` is where a locked session finds out it is locked.
 *
 * A gated server answers `initialize` and `tools/list` in full, so every
 * surface asking "what does this server serve" got a clean answer about one
 * that will refuse everything. `whoami` is one of exactly two tools still
 * answerable while locked, and is already the honest-identity surface, so the
 * gate state belongs there — as a TYPED value, because `muon mcp probe` reads
 * it back and prose-matching a refusal breaks the first time the copy changes.
 */
describe("whoami reports the identity gate", () => {
  async function whoamiBody(gate?: McpIdentityGate) {
    const { client, close } = await connect(gate);
    const result = (await client.callTool({
      name: "whoami",
      arguments: {},
    })) as { structuredContent?: Record<string, unknown> };
    await close();
    return result.structuredContent ?? {};
  }

  it("says `locked` while the gate is closed, and names `muon login`", async () => {
    const body = await whoamiBody(closedGate());
    expect(body.identityGate).toBe("locked");
    expect(String(body.identityGateNote)).toContain("muon login");
    // Named FROM the enforced set, so the sentence cannot drift away from it.
    for (const exempt of MCP_IDENTITY_GATE_EXEMPT_TOOLS) {
      expect(String(body.identityGateNote)).toContain(exempt);
    }
  });

  it("says `locked-unregistered` with a note TRUE FOR THIS SURFACE — no retry lives here", async () => {
    const body = await whoamiBody(deferredGate());
    expect(body.identityGate).toBe("locked-unregistered");
    const note = String(body.identityGateNote);
    // THIS ASSERTION WAS INVERTED, and it pinned a defect. It required the note
    // to say "do NOT ask the human to run `muon login` — they already have, and
    // it will not help", justified by "MUON retries automatically". Only the
    // DESKTOP retries (`startInstallRegistrationRetry`, and only while that app
    // is open); nothing in `muon login`, the TUI or this `muon-mcp` process
    // retries at all. So on a CLI-only tarball whose first sign-in hit a
    // captive portal, the agent was told to withhold the only remedy there is.
    expect(note).not.toContain("do NOT ask the human to run `muon login`");
    expect(note).not.toContain("will not help");
    expect(note).toContain("muon login");
    // Named, not implied: which surface DOES retry, so "wait" is only ever
    // advice for a machine where waiting can work.
    expect(note).toContain("desktop");
    expect(note).toContain("NOTHING in this process retries it");
    // And the distinguished state is still distinguished — the human is not
    // sent back to redo a step that succeeded.
    expect(note).toContain("NOT for want of a sign-in");
    expect(note).toContain("their sign-in worked");
    // Still named FROM the enforced set, like every other branch.
    for (const exempt of MCP_IDENTITY_GATE_EXEMPT_TOOLS) {
      expect(note).toContain(exempt);
    }
  });

  it("says `open` when the gate is ARMED and satisfied", async () => {
    const body = await whoamiBody(openGate);
    expect(body.identityGate).toBe("open");
  });

  it("says `unarmed` when this build has no gate at all", async () => {
    // Distinct from `open` on purpose: a dev checkout is not a signed-in one,
    // and collapsing the two would report every repo run as authenticated.
    const body = await whoamiBody();
    expect(body.identityGate).toBe("unarmed");
  });

  it("re-reads per call, so a `muon login` elsewhere shows up with no restart", async () => {
    let locked = true;
    const { client, close } = await connect({
      state: () => (locked ? "locked" : "open"),
      refusal: () => "MUON is locked (test copy).",
    });
    const read = async () =>
      (
        (await client.callTool({ name: "whoami", arguments: {} })) as {
          structuredContent?: { identityGate?: string };
        }
      ).structuredContent?.identityGate;
    expect(await read()).toBe("locked");
    locked = false;
    expect(await read()).toBe("open");
    await close();
  });

  it("reports the gate this SERVER enforces, never a second resolution", async () => {
    // The failure this prevents: `whoami` resolving the gate from the
    // environment on its own could answer "unarmed" beside a handler that
    // refuses. The env here says nothing; the built gate says locked.
    const body = await whoamiBody(closedGate());
    expect(body.identityGate).toBe("locked");
    expect(resolveMcpIdentityGate({})).toBeUndefined();
  });

  it("understates rather than overstates when no server bound the surface", async () => {
    // An unbound tool list cannot know, and inventing a lock would be worse
    // than the honest floor.
    const tool = tools().find((entry) => entry.name === "whoami")!;
    const result = await tool.handler({});
    expect(result.structuredContent).toMatchObject({ identityGate: "unarmed" });
  });

  it("emits only values @muon/client can read back", async () => {
    // The wire contract, asserted across the package boundary: the probe
    // decides with `isIdentityGateState`, so an emitter that invented a
    // fourth spelling would be scored `null` — an unknown — forever.
    for (const gate of [closedGate(), deferredGate(), openGate, undefined]) {
      const body = await whoamiBody(gate);
      expect(isIdentityGateState(body.identityGate), String(gate)).toBe(true);
    }
  });
});

describe("an UNGATED muon-mcp is byte-identical to before ADR-0052", () => {
  it("no gate option means no gate sentence and no refusal", async () => {
    const { client, close } = await connect();
    expect(client.getInstructions() ?? "").not.toContain("MUON IS LOCKED");
    const result = (await client.callTool({
      name: "whoami",
      arguments: {},
    })) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    await close();
  });
});

describe("resolveMcpIdentityGate (arming)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-mcp-gate-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.MUON_DATA_DIR;
  });

  it("is UNDEFINED in a dev checkout — the ungated path is not a gate object", () => {
    expect(resolveMcpIdentityGate({})).toBeUndefined();
  });

  it("arms under MUON_REQUIRE_GITHUB_LOGIN=1 and reads satisfaction live", () => {
    process.env.MUON_DATA_DIR = dir;
    const gate = resolveMcpIdentityGate({ MUON_REQUIRE_GITHUB_LOGIN: "1" });
    expect(gate).toBeDefined();
    expect(gate!.state()).toBe("locked");
    expect(gate!.refusal()).toContain("muon login");
    expect(gate!.refusal()).toContain("records this install");

    writeIdentityCredential(
      { github: { login: "octocat", id: 1 }, token: "gho_" + "x".repeat(20), grant: GRANT },
      dir
    );
    // Same gate object, no rebuild: the credential landing opens it.
    expect(gate!.state()).toBe("open");

    // A FORGED grant SHAPE re-gates the SAME live session — and reads `locked`,
    // not `locked-unregistered`: somebody edited the file, so the remedy really
    // is to sign in again.
    const file = path.join(dir, "github-identity.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.grant.token = "forged";
    fs.writeFileSync(file, JSON.stringify(stored));
    expect(gate!.state()).toBe("locked");
  });

  it("reports locked-unregistered with the DEFERRED copy, never the sign-in remedy", () => {
    // ADR-0052 F3. This is the offline-first-sign-in machine: the desktop is
    // satisfied by its own credential and works, while every dispatched agent's
    // MCP session refused with "Run `muon login`" — the exact thing the human
    // had already done. The state and the copy both have to change, and the
    // copy has to be read LIVE (it was a string fixed at construction).
    process.env.MUON_DATA_DIR = dir;
    const gate = resolveMcpIdentityGate({ MUON_REQUIRE_GITHUB_LOGIN: "1" });
    expect(gate!.state()).toBe("locked");
    markInstallRegistrationPending("desktop", dir);
    expect(gate!.state()).toBe("locked-unregistered");
    const copy = gate!.refusal();
    expect(copy).toContain("verified but not yet registered");
    // `muon-mcp` does not retry — nothing in this process does — so the copy
    // must not promise one. It used to, because the sentence was written for
    // the desktop and rendered everywhere.
    expect(copy).toContain("NOTHING here retries it");
    expect(copy).toContain("`muon login` is what files the record");
    expect(copy).not.toContain("Run `muon login` to open it");
    // Still a refusal. The distinguished state opens nothing.
    expect(gate!.state()).not.toBe("open");
  });

  it("MUON_REQUIRE_GITHUB_LOGIN=0 stays the escape hatch", () => {
    expect(
      resolveMcpIdentityGate({ MUON_REQUIRE_GITHUB_LOGIN: "0" })
    ).toBeUndefined();
  });
});
