import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MCP_STATUS_CHECK_IDS,
  buildMcpStatusReport,
} from "@muon/client/mcp-status";
import {
  MUON_MCP_ENTRY_NAME,
  type McpVendorIo,
} from "@muon/client/mcp-vendor-config";
import { githubIdentityGateRefusal } from "@muon/client/github-identity-gate";
import {
  installMcpForVendor,
  probeMcpServer,
  readMcpStatus,
} from "../src/lib/mcp-bridge.js";

/**
 * The main-process side of Settings → Connections, S1 §5.
 *
 * THIS FILE EXISTS BECAUSE OF A SURVIVED MUTATION. When both handler bodies were
 * inline in `main.ts`, replacing the shared `buildMcpStatusReport` call with a
 * hand-built report object passed the entire desktop suite — `main.ts` wires
 * Electron at import time and is unreachable from a test, so a restated
 * evaluator on that surface was invisible. The bodies moved to
 * `src/lib/mcp-bridge.ts`; these are the assertions that now fail.
 *
 * SAFETY, structurally: every root is a fresh `mkdtemp`, `redirectVendorConfigDirs`
 * is TRUE so any vendor process would write under it, and `run` THROWS — so
 * neither function here can touch the operator's real `~/.claude`, `~/.codex`,
 * `~/.cursor` or `~/.config/opencode`. The install test asserts the file was
 * written UNDER the temp root, which is the same thing said positively.
 */

const MCP_BIN = "/opt/muon/bin/muon-mcp";

const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function io(overrides: Partial<McpVendorIo> = {}): McpVendorIo {
  const home = tempDir("muon-desktop-bridge-");
  return {
    roots: {
      home,
      configHome: path.join(home, ".config"),
      cwd: path.join(home, "repo"),
      redirectVendorConfigDirs: true,
    },
    run: () => {
      throw new Error("this test must not spawn a vendor process");
    },
    which: (command) =>
      command === "muon-mcp" ? MCP_BIN : `/usr/local/bin/${command}`,
    isExecutableFile: (p) => p === MCP_BIN,
    ...overrides,
  };
}

describe("readMcpStatus — delegates wholly to the shared evaluator", () => {
  it("returns exactly what buildMcpStatusReport returns for the same input", () => {
    // The anti-restatement assertion. A hand-built report — the mutation that
    // once passed the whole suite — cannot satisfy a deep equality against the
    // shared evaluator's own output.
    const vendorIo = io();
    const env = { MUON_DATA_DIR: tempDir("muon-desktop-bridge-data-") };
    expect(readMcpStatus({ io: vendorIo, env })).toEqual(
      buildMcpStatusReport({ io: vendorIo, env })
    );
  });

  it("carries every declared check, so the desktop can never show a subset", () => {
    const report = readMcpStatus({
      io: io(),
      env: { MUON_DATA_DIR: tempDir("muon-desktop-bridge-data-") },
    });
    expect(report.checks.map((check) => check.id)).toEqual([
      ...MCP_STATUS_CHECK_IDS,
    ]);
    expect(report.vendors).toHaveLength(4);
    for (const row of report.vendors) {
      // Both booleans reach the renderer, always.
      expect(row.installable).toBe(true);
      expect(typeof row.coordinatorSeat).toBe("boolean");
    }
  });

  it("spawns no vendor process and starts no brain", () => {
    // The runner throws on any spawn; a live lockfile is absent and must stay
    // absent — a read that reports whether a brain is running must not start one.
    const dataDir = tempDir("muon-desktop-bridge-data-");
    const report = readMcpStatus({ io: io(), env: { MUON_DATA_DIR: dataDir } });
    expect(report.brainRunning).toBe(false);
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });
});

describe("installMcpForVendor — the shared writer, never a second one", () => {
  it("writes MUON's entry through the shared JSON writer, under the temp root", () => {
    // cursor is the `muon-json` writer, so no vendor binary is involved and the
    // throwing runner stays untripped except for the best-effort `mcp enable`,
    // which is why `which` is nulled for it below.
    const vendorIo = io({ which: (c) => (c === "muon-mcp" ? MCP_BIN : null) });
    const result = installMcpForVendor("cursor", { io: vendorIo });
    expect(result.vendor).toBe("cursor");
    expect(result.scope).toBe("user");
    expect(result.command).toBe(MCP_BIN);
    expect(result.outcome.kind).toBe("written");

    const file = path.join(vendorIo.roots.home, ".cursor", "mcp.json");
    expect(file.startsWith(vendorIo.roots.home)).toBe(true);
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    // The exact entry §2.2 specifies: a verified absolute command, empty args,
    // and NO token, NO MUON_API_BASE, NO MUON_MCP_MODE.
    expect(written.mcpServers[MUON_MCP_ENTRY_NAME]).toEqual({
      command: MCP_BIN,
      args: [],
    });
    expect(JSON.stringify(written)).not.toContain("MUON_API_BASE");
    expect(JSON.stringify(written)).not.toContain("MUON_MCP_MODE");
  });

  it("refuses an unknown vendor instead of writing anything", () => {
    const vendorIo = io();
    const result = installMcpForVendor("fake" as never, { io: vendorIo });
    expect(result.outcome.kind).toBe("refused");
    if (result.outcome.kind !== "refused") throw new Error("unreachable");
    expect(result.outcome.reason).toContain("does not install");
    expect(fs.readdirSync(vendorIo.roots.home)).toEqual([]);
  });

  it("refuses with the CLI's own words when no muon-mcp resolves", () => {
    // §1.4c, the `.dmg`-only case. The text is authored once, in
    // `muonMcpUnresolvedRefusal`, so the desktop and `muon mcp install` cannot
    // explain the same failure differently.
    const result = installMcpForVendor("cursor", {
      io: io({ isExecutableFile: () => false }),
    });
    expect(result.command).toBeNull();
    if (result.outcome.kind !== "refused") throw new Error("expected a refusal");
    expect(result.outcome.reason).toContain(
      "Could not find an executable 'muon-mcp' to register."
    );
    expect(result.outcome.reason).toContain("Searched:");
  });

  it("never offers 'local' scope, and never a scope the vendor lacks", () => {
    // §2.2 correction 6: a per-directory entry is invisible from every other
    // repo, so it is not an offered scope on any surface.
    for (const vendor of ["claude-code", "codex", "cursor", "opencode"] as const) {
      const result = installMcpForVendor(vendor, {
        io: io({ isExecutableFile: () => false }),
      });
      expect(result.scope).toBe("user");
    }
  });
});

/**
 * ADR-0052 on the desk's probe, against REAL child processes.
 *
 * Mocking the spawn would test nothing here for the same reason it tests
 * nothing in `@muon/client`'s own probe suite: the point of the measurement is
 * that a build believed to be current, or a gate believed to be open, may not
 * be — and the only witness is a process. So each case below launches an actual
 * stdio server that answers `whoami` the way a real `muon-mcp` would.
 */
function fakeMuonMcp(gate: string | null): string {
  const root = tempDir("muon-desktop-probe-");
  const file = path.join(root, "muon-mcp");
  // The interpreter is named ABSOLUTELY (`process.execPath`), not looked up
  // through `env node`: these cases deliberately spawn with a near-empty
  // environment, and a PATH-dependent shebang would fail as "the server never
  // answered" — a passing-looking failure for a test about honest reporting.
  fs.writeFileSync(
    file,
    `#!${process.execPath}
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
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\\n");
    }
    if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "whoami" }] } }) + "\\n");
    }
    if (msg.method === "tools/call" && ${JSON.stringify(gate !== null)}) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { structuredContent: { identityGate: ${JSON.stringify(
        gate
      )} } } }) + "\\n");
    }
  }
});
`,
    { mode: 0o755 }
  );
  return file;
}

function probeIo(command: string): McpVendorIo {
  return io({
    which: (c) => (c === "muon-mcp" ? command : null),
    isExecutableFile: (p) => p === command,
  });
}

describe("probeMcpServer — the desk reports the GATE, not just the tool count", () => {
  it("carries a LOCKED gate with the CLI's exact refusal copy", async () => {
    const report = await probeMcpServer(
      { timeoutMs: 15_000 },
      { io: probeIo(fakeMuonMcp("locked")), env: {} }
    );
    // A gated server answers `initialize` and `tools/list` in full, on purpose.
    // Before this field existed the desk showed exactly this verdict and said
    // nothing about the lock.
    expect(report.identityGate).toBe("locked");
    // AUTHORED ONCE. The same three sentences `muon mcp probe` prints for the
    // same server — composed here rather than in the renderer only because the
    // renderer is a browser bundle and this module reaches node:fs.
    expect(report.identityGateRefusal).toBe(
      githubIdentityGateRefusal({ what: "every MUON tool", surface: "mcp" })
    );
  }, 30_000);

  it("an OPEN or UNARMED gate carries no refusal to show", async () => {
    for (const gate of ["open", "unarmed"] as const) {
      const report = await probeMcpServer(
        { timeoutMs: 15_000 },
        { io: probeIo(fakeMuonMcp(gate)), env: {} }
      );
      expect(report.identityGate, gate).toBe(gate);
      expect(report.identityGateRefusal, gate).toBeNull();
    }
  }, 30_000);

  it("an UNANSWERED gate question is NULL — an unknown, never an 'open'", async () => {
    // A server that lists `whoami` and never answers the call: an old build, or
    // one that died mid-conversation. The tool list it did serve still reports.
    const report = await probeMcpServer(
      { timeoutMs: 6_000 },
      { io: probeIo(fakeMuonMcp(null)), env: {} }
    );
    expect(report.verdict.liveCount).toBe(1);
    expect(report.identityGate).toBeNull();
    expect(report.identityGateRefusal).toBeNull();
  }, 30_000);

  it("an unresolvable command reports null, not a gate it never asked about", async () => {
    const report = await probeMcpServer(
      {},
      { io: io({ isExecutableFile: () => false }), env: {} }
    );
    expect(report.command).toBeNull();
    expect(report.verdict.level).toBe("unevaluated");
    expect(report.identityGate).toBeNull();
    expect(report.identityGateRefusal).toBeNull();
  });
});
