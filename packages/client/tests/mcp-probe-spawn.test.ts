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

/** A server that completes the handshake and lists exactly `tools`. */
function listing(tools: readonly string[]): string {
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
