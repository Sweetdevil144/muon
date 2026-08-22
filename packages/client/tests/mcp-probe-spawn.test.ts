import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeMcpToolNames } from "../src/mcp-probe-spawn.js";
import { compareLiveTools } from "@muon/client/mcp-probe";

/**
 * The spawn half of the probe, against REAL child processes.
 *
 * Mocking `spawn` here would test nothing: the whole reason this code exists is
 * that a build believed to be current was not, and the only way to know what a
 * process serves is to talk to one. So every case below launches an actual
 * node script that speaks (or refuses to speak) the handshake.
 *
 * Three guarantees, matching the three ways a probe can lie:
 *   - it reports what the server actually listed,
 *   - it always terminates, whatever the server does,
 *   - it never reports an answer it did not receive.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Write a throwaway stdio server and return its path. */
function fakeServer(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muon-probe-"));
  roots.push(root);
  const file = path.join(root, "server.mjs");
  fs.writeFileSync(file, body);
  return file;
}

/**
 * A server that completes the handshake and lists exactly `tools`.
 *
 * ADR-0052: when `whoami` is on offer the probe asks it for the gate state, so
 * the fake answers that too — `gate` is what its `whoami` reports, and `null`
 * models a server that lists `whoami` and never answers the call.
 */
function listing(
  tools: readonly string[],
  gate: string | null = "unarmed",
  /** The WHOLE `structuredContent` whoami answers with, when the default
   *  `{ identityGate: gate }` is not the shape under test — a build from before
   *  the field existed answers the call and says nothing about the gate. */
  structuredContent?: Record<string, unknown>
): string {
  return `
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  for (;;) {
    const cut = buf.indexOf("\\n");
    if (cut === -1) break;
    const line = buf.slice(0, cut); buf = buf.slice(cut + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0" } } }) + "\\n");
    }
    if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: ${JSON.stringify(
        tools.map((name) => ({ name }))
      )} } }) + "\\n");
    }
    if (msg.method === "tools/call" && ${JSON.stringify(gate !== null)}) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { structuredContent: ${JSON.stringify(
        structuredContent ?? { identityGate: gate }
      )} } }) + "\\n");
    }
  }
});
`;
}

const NODE = process.execPath;

describe("the probe reports what the server actually served", () => {
  it("reads the tool list back off a live process", async () => {
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer(listing(["memory_search", "publish_finding"]))],
      timeoutMs: 15_000,
    });
    expect(outcome.toolNames).toEqual(["memory_search", "publish_finding"]);
    expect(outcome.failure).toBeUndefined();
  });

  it("survives a server that logs plain text on stdout", async () => {
    // The real muon-mcp prints a credential notice at startup. A probe that
    // treated any unparseable line as fatal would report every healthy server
    // as unreachable.
    const noisy = `process.stdout.write("muon-mcp: no agent credential found\\n");\n${listing(
      ["whoami"]
    )}`;
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer(noisy)],
      timeoutMs: 15_000,
    });
    expect(outcome.toolNames).toEqual(["whoami"]);
  });

  it("reassembles a list split across reads", async () => {
    // A pipe splits wherever it was full, so a frame can arrive in pieces —
    // the same split-read hazard the TUI key reader was built for.
    const chunked = `
let buf = "";
const slowly = (text) => {
  for (let i = 0; i < text.length; i += 7) {
    process.stdout.write(text.slice(i, i + 7));
  }
};
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  for (;;) {
    const cut = buf.indexOf("\\n");
    if (cut === -1) break;
    const line = buf.slice(0, cut); buf = buf.slice(cut + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") slowly(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
    if (msg.method === "tools/list") slowly(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "a" }, { name: "b" }] } }) + "\\n");
  }
});
`;
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer(chunked)],
      timeoutMs: 15_000,
    });
    expect(outcome.toolNames).toEqual(["a", "b"]);
  });
});

describe("the probe never reports an answer it did not get", () => {
  it("a server that exits at once is a failure, not an empty toolset", async () => {
    // The distinction is the whole point: an empty list would be scored
    // `stale` and blamed on the build; a dead server is a different problem
    // with a different fix.
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer("process.exit(3);")],
      timeoutMs: 15_000,
    });
    expect(outcome.toolNames).toBeNull();
    expect(outcome.failure).toMatch(/exited/);
    expect(compareLiveTools(outcome.toolNames, "base").level).toBe(
      "unevaluated"
    );
  });

  it("a command that does not exist is a failure, not a hang", async () => {
    const outcome = await probeMcpToolNames({
      command: path.join(os.tmpdir(), "muon-no-such-binary-xyz"),
      timeoutMs: 15_000,
    });
    expect(outcome.toolNames).toBeNull();
    expect(outcome.failure).toBeTruthy();
  });

  it("a silent server times out instead of hanging forever", async () => {
    // No handler at all: it accepts the handshake bytes and says nothing. The
    // probe must come back on its own.
    const started = Date.now();
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer("setInterval(() => {}, 1000);")],
      timeoutMs: 1_200,
    });
    expect(outcome.toolNames).toBeNull();
    expect(outcome.failure).toMatch(/did not answer/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a tools/list answer with no tool array is a failure, not zero tools", async () => {
    const malformed = listing([]).replace(
      "result: { tools: []",
      "result: { oops: true"
    );
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer(malformed)],
      timeoutMs: 15_000,
    });
    expect(outcome.toolNames).toBeNull();
    expect(outcome.failure).toMatch(/without a tool array/);
  });
});

describe("the 2026-08-10 regression, end to end", () => {
  it("a server missing three shipped tools is reported STALE by name", async () => {
    const { MUON_CONTEXT_TOOL_NAMES, MUON_COORDINATION_TOOL_NAMES } =
      await import("@muon/protocol");
    const stale = [
      ...MUON_CONTEXT_TOOL_NAMES,
      ...MUON_COORDINATION_TOOL_NAMES,
    ].filter(
      (name) =>
        name !== "publish_finding" &&
        name !== "question_ask" &&
        name !== "question_status"
    );
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer(listing(stale))],
      timeoutMs: 15_000,
    });
    const verdict = compareLiveTools(outcome.toolNames, "base");
    expect(verdict.level).toBe("stale");
    expect(verdict.missing).toEqual([
      "publish_finding",
      "question_ask",
      "question_status",
    ]);
  });
});

/**
 * ADR-0052. A gated `muon-mcp` answers `initialize` and `tools/list` in full —
 * by design, so a vendor can still read the instructions that say it is locked.
 * That is exactly what made the probe report `ok · 31 tools` about a server
 * that would refuse all 31. The gate question closes that, and every case here
 * is about it never costing the measurement the probe already made.
 */
describe("the probe reports whether the server is identity-locked", () => {
  it("reads the state out of whoami's TYPED field", async () => {
    for (const state of ["locked", "open", "unarmed"] as const) {
      const outcome = await probeMcpToolNames({
        command: NODE,
        args: [fakeServer(listing(["whoami", "memory_search"], state))],
        timeoutMs: 15_000,
      });
      expect(outcome.toolNames, state).toEqual(["whoami", "memory_search"]);
      expect(outcome.identityGate, state).toBe(state);
    }
  });

  it("a value this build does not recognise is NAMED, never a guess and never a null", async () => {
    // THE THIRD OUTCOME. A newer server naming a fifth state must not be scored
    // as one of the four — and it must not be folded into `null` either, which
    // means "an older server never reported one" and is read by every caller as
    // no lock. That fold is exactly how `muon mcp probe` printed `ok` and exited
    // 0 against a server whose own permission state it could not read.
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer(listing(["whoami"], "quarantined"))],
      timeoutMs: 15_000,
    });
    expect(outcome.toolNames).toEqual(["whoami"]);
    expect(outcome.identityGate).toBeNull();
    expect(outcome.unknownIdentityGate).toBe("quarantined");
  });

  it("bounds an unrecognised value so a verbose server cannot bury the refusal", async () => {
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer(listing(["whoami"], "z".repeat(5_000)))],
      timeoutMs: 15_000,
    });
    expect(outcome.identityGate).toBeNull();
    expect(outcome.unknownIdentityGate).toBe("z".repeat(64));
  });

  it("does not ask a server that does not list whoami", async () => {
    // An older build, or a lapsed attached seat holding nothing. Calling an
    // unlisted tool answers "unknown tool", which says nothing about the gate —
    // and waiting for that answer would tax every probe of an old server.
    const started = Date.now();
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer(listing(["memory_search"]))],
      timeoutMs: 15_000,
    });
    expect(outcome.toolNames).toEqual(["memory_search"]);
    expect(outcome.identityGate).toBeNull();
    // ABSENT, not unreadable. This is the case that must keep exiting 0: an
    // older server that never reports a gate state is an unknown, not a lock.
    expect(outcome.unknownIdentityGate).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("an answer with NO identityGate field at all stays a plain unknown", async () => {
    // The `whoami` of a build from before the field existed: it answers the call
    // and says nothing about the gate. Distinct from the case above (that server
    // does not list `whoami` at all), and it must read the same way.
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer(listing(["whoami"], "unarmed", { agentId: "a-1" }))],
      timeoutMs: 15_000,
    });
    expect(outcome.toolNames).toEqual(["whoami"]);
    expect(outcome.identityGate).toBeNull();
    expect(outcome.unknownIdentityGate).toBeUndefined();
  });

  it("ignores a stray stdout log line that happens to carry an id", async () => {
    // REPRODUCED BEFORE THE FIX. A server is free to write structured logs on
    // stdout — this suite already pins that it does — and pino-style lines
    // carry an `id`. One `{"id":3,...}` finished the probe with
    // `toolNames: null` and NO `failure` at all, which the CLI renders as
    // `unevaluated` with no `why` line. A JSON-RPC response carries `result`
    // or `error`; a log line carries neither, and that is the whole guard.
    const noisy = `
process.stdout.write(JSON.stringify({ id: 3, level: 30, msg: "req done" }) + "\\n");
process.stdout.write(JSON.stringify({ id: 2, level: 30, msg: "listing" }) + "\\n");
process.stdout.write(JSON.stringify({ id: 1, level: 30, msg: "hello" }) + "\\n");
${listing(["whoami", "memory_search"], "locked")}`;
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer(noisy)],
      timeoutMs: 15_000,
    });
    expect(outcome.toolNames).toEqual(["whoami", "memory_search"]);
    // And the REAL answer survives: a stray id:3 must not be mistaken for the
    // gate answer and blank out a genuine `locked`.
    expect(outcome.identityGate).toBe("locked");
    expect(outcome.failure).toBeUndefined();
  });

  it("does not turn a crash during the gate question into a clean probe", async () => {
    // The regression the gate question introduced: before it existed, a server
    // that died was `toolNames: null` → `unevaluated` → exit 1. Keeping the
    // tool list is right, but it scores `ok`, so `failure` has to survive to
    // the exit code — asserted in the CLI's own test.
    const dies = `${listing(["whoami"], null)}
setTimeout(() => process.exit(7), 300);`;
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer(dies)],
      timeoutMs: 15_000,
    });
    expect(outcome.toolNames).toEqual(["whoami"]);
    expect(outcome.identityGate).toBeNull();
    expect(outcome.failure).toMatch(/exited .*before answering/);
  });

  it("still reports the TOOL LIST when the gate question goes unanswered", async () => {
    // The tool list is the measurement this command exists for. A server that
    // lists whoami and never answers the call must not turn a good probe into
    // "the server did not answer tools/list", which scores as a stale build.
    const outcome = await probeMcpToolNames({
      command: NODE,
      args: [fakeServer(listing(["whoami", "memory_search"], null))],
      timeoutMs: 1_500,
    });
    expect(outcome.toolNames).toEqual(["whoami", "memory_search"]);
    expect(outcome.identityGate).toBeNull();
    expect(outcome.failure).toBeUndefined();
  });
});
