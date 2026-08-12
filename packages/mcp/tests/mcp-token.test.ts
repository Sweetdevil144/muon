import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveApiToken } from "@muon/client";
import { resolveMcpApiToken } from "../src/index.js";

// The MUON MCP server's credential resolution. The governed path (runner-injected
// MUON_API_BASE + MUON_API_TOKEN) was safe only by accident: with an explicit
// base configured, `resolveApiToken` never reached its lockfile branch. Register
// `muon-mcp` by hand in a vendor CLI — no injection — and that branch returned
// the OPERATOR token, so a model held govern tier over memory.

const OPERATOR_TOKEN = "operator-lockfile-token-do-not-hand-to-a-model";
const AGENT_TOKEN = "agent-lockfile-token";

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-mcp-token-"));
  // A LIVE brain (this process's own pid) advertising both tiers, which is
  // exactly what a developer machine looks like while the desktop app is open.
  writeFileSync(
    path.join(dir, "brain.lock"),
    JSON.stringify({
      port: 4000,
      token: OPERATOR_TOKEN,
      agentToken: AGENT_TOKEN,
      pid: process.pid,
      dbPath: path.join(dir, "muon.db"),
      startedAt: new Date().toISOString(),
    })
  );
  process.env.MUON_DATA_DIR = dir;
  delete process.env.MUON_API_BASE;
  delete process.env.NEXT_PUBLIC_MUON_API_BASE;
  delete process.env.MUON_API_TOKEN;
  delete process.env.MUON_AGENT_TOKEN;
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveMcpApiToken", () => {
  it("NEVER presents the operator token, even when the lockfile is the only source", () => {
    // The hole, stated as the test: a hand-registered server, no injection, a
    // live brain publishing the operator credential. It must take the agent
    // token and nothing else.
    const resolved = resolveMcpApiToken();
    expect(resolved).not.toBe(OPERATOR_TOKEN);
    expect(resolved).toBe(AGENT_TOKEN);
    // And the reason this needs its own resolver rather than the shared one:
    // under exactly these conditions the human-surface resolver hands back
    // govern authority, correctly for the CLI/TUI/desktop and never for an MCP
    // server. If this ever stops being true the dedicated resolver can go.
    expect(resolveApiToken()).toBe(OPERATOR_TOKEN);
  });

  it("fails closed rather than falling back when no agent credential exists", () => {
    // A pre-P3-A lockfile carries an operator token and no agentToken. Absence
    // must read as "no capability" — the brain then answers 401, which is a
    // legible refusal instead of a silent tier escalation.
    writeFileSync(
      path.join(dir, "brain.lock"),
      JSON.stringify({
        port: 4000,
        token: OPERATOR_TOKEN,
        pid: process.pid,
        dbPath: path.join(dir, "muon.db"),
        startedAt: new Date().toISOString(),
      })
    );
    expect(resolveMcpApiToken()).toBeUndefined();
  });

  it("takes the runner-injected exact-job token first", () => {
    // The governed path: `withMuonMcpServer` delivers the job-bound token under
    // MUON_API_TOKEN, and that name stays the highest-precedence source so the
    // dispatched-agent path is byte-for-byte what it was.
    process.env.MUON_API_BASE = "http://127.0.0.1:4000";
    process.env.MUON_API_TOKEN = "job-bound-exact-token";
    process.env.MUON_AGENT_TOKEN = "shared-agent-token";
    expect(resolveMcpApiToken()).toBe("job-bound-exact-token");
  });

  it("falls back to an explicit agent token, never past it", () => {
    process.env.MUON_API_BASE = "http://127.0.0.1:4000";
    process.env.MUON_AGENT_TOKEN = "shared-agent-token";
    expect(resolveMcpApiToken()).toBe("shared-agent-token");
  });
});
