import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMcpCommands } from "../src/commands/mcp.js";
import {
  MCP_STATUS_CHECK_IDS,
  MCP_VENDOR_REASON_IDS,
  buildMcpStatusReport,
  mcpStatusCheckIds,
  type McpStatusReport,
} from "@muon/client/mcp-status";
import type { McpVendorIo } from "@muon/client/mcp-vendor-config";
import { writeAttachedCoordinatorCapabilityFile } from "@muon/client/attached-coordinator-capability";

/**
 * `muon mcp status` — the §3.2 OUTPUT CONTRACT of
 * docs/design/cc-as-superagent-delivery.md.
 *
 * Same safety rule as mcp-install.test.ts: every root here is a fresh mkdtemp
 * and the runner throws on any spawn, so nothing under the operator's real
 * `~/.claude`, `~/.codex`, `~/.cursor` or `~/.config/opencode` is read for
 * assertions or written at all.
 */

const MCP_BIN = "/opt/muon/bin/muon-mcp";

const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
  vi.restoreAllMocks();
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function io(overrides: Partial<McpVendorIo> = {}): McpVendorIo {
  const home = tempDir("muon-mcp-status-");
  return {
    roots: {
      home,
      configHome: path.join(home, ".config"),
      cwd: path.join(home, "repo"),
      redirectVendorConfigDirs: true,
    },
    // `status` must not spawn a vendor process: it has to render on exactly the
    // broken machine it exists to diagnose.
    run: () => {
      throw new Error("muon mcp status must not spawn a vendor process");
    },
    which: (command) => `/usr/local/bin/${command}`,
    isExecutableFile: (p) => p === MCP_BIN,
    ...overrides,
  };
}

/** A LIVE lockfile: pid is ours, so readLiveLockfile's liveness probe passes. */
function writeLockfile(opts: { agentToken?: string } = {}): string {
  const dataDir = tempDir("muon-datadir-");
  fs.writeFileSync(
    path.join(dataDir, "brain.lock"),
    JSON.stringify({
      port: 51234,
      token: "operator-token-must-never-be-used-here",
      agentToken: opts.agentToken,
      pid: process.pid,
      dbPath: path.join(dataDir, "muon.db"),
      startedAt: new Date().toISOString(),
    })
  );
  return dataDir;
}

function writeCapabilityFile(): string {
  const dataDir = tempDir("muon-attached-capability-");
  return writeAttachedCoordinatorCapabilityFile(
    {
      version: 1,
      apiBase: "http://127.0.0.1:4317",
      apiToken: "a".repeat(64),
      jobId: "job-attached-root",
      delegationToken: "a".repeat(64),
      chatId: "chat-attached",
      chatTaskId: "task-attached-shadow",
      workspacePath: "/repo",
      vendor: "codex",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
    dataDir
  );
}

function report(
  env: Record<string, string | undefined>,
  vendorIo = io()
): McpStatusReport {
  return buildMcpStatusReport({ io: vendorIo, env });
}

function check(rep: McpStatusReport, id: string) {
  const found = rep.checks.find((c) => c.id === id);
  if (!found) {
    throw new Error(`no check '${id}' in the report`);
  }
  return found;
}

// ─────────────────────── the contract itself is locked ──────────────────────

describe("§3.2 output contract", () => {
  it("names EVERY check, every time, with its state — not only the failures", () => {
    // A status command that says "OK" without being able to say "and here is
    // what I checked" is the thing this stage exists to avoid. So the drift lock
    // is: the built report carries exactly the declared id list, in order.
    const healthy = report(
      { MUON_DATA_DIR: writeLockfile({ agentToken: "a".repeat(64) }) },
      io()
    );
    expect(mcpStatusCheckIds(healthy)).toEqual([...MCP_STATUS_CHECK_IDS]);

    const broken = report({ MUON_DATA_DIR: tempDir("muon-empty-") }, io({
      which: () => null,
      isExecutableFile: () => false,
    }));
    expect(mcpStatusCheckIds(broken)).toEqual([...MCP_STATUS_CHECK_IDS]);

    // Every check has an ok branch AND a warn/fail branch, and the id must be
    // identical on both — a mutation that renamed the id on only one branch got
    // past an earlier version of this lock, so both are exercised here.
    const warned = report(
      {
        MUON_DATA_DIR: writeLockfile({ agentToken: "z".repeat(64) }),
        MUON_API_BASE: "http://localhost:4000",
        MUON_MCP_MODE: "orchestrator",
      },
      io()
    );
    expect(mcpStatusCheckIds(warned)).toEqual([...MCP_STATUS_CHECK_IDS]);
    expect(warned.checks.filter((c) => c.level === "warn").map((c) => c.id)).toEqual([
      "api-base-source",
      "mcp-mode-env",
    ]);
  });

  it("declares every per-vendor reason id it can emit", () => {
    // Positive list, never a remainder: a new failure mode has to be declared.
    expect(new Set(MCP_VENDOR_REASON_IDS).size).toBe(MCP_VENDOR_REASON_IDS.length);
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") });
    for (const row of rep.vendors) {
      for (const reason of row.reasons) {
        expect(MCP_VENDOR_REASON_IDS).toContain(reason.id);
      }
    }
  });

  it("reports all four vendors with BOTH booleans", () => {
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") });
    expect(rep.vendors.map((row) => row.vendor)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "opencode",
    ]);
    for (const row of rep.vendors) {
      expect(row.installable).toBe(true);
    }
    expect(
      rep.vendors.filter((row) => row.coordinatorSeat).map((row) => row.vendor)
    ).toEqual(["claude-code", "codex"]);
  });

  it("is honest about Tier C when nothing is attached (ADR-0028)", () => {
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") });
    expect(rep.wouldGetTierC).toBe(false);
    expect(rep.tierCReason).toMatch(/not attached/i);
    expect(rep.tierCReason).toMatch(/muon mcp attach/i);
    expect(check(rep, "tier-c-attachment").level).toBe("ok");
  });

  it("reports Tier C when MUON_MCP_MODE=attached-coordinator with a capability file", () => {
    const capabilityFile = writeCapabilityFile();
    const rep = report({
      MUON_DATA_DIR: tempDir("muon-empty-"),
      MUON_MCP_MODE: "attached-coordinator",
      MUON_ATTACHED_CAPABILITY_FILE: capabilityFile,
    });
    expect(rep.wouldGetTierC).toBe(true);
    expect(rep.mode).toBe("attached-coordinator");
    expect(rep.toolCount).toBe(44); // +2: ADR-0043, +1: publish_finding
    expect(check(rep, "mcp-mode-env").level).toBe("ok");
    expect(check(rep, "tier-c-attachment").level).toBe("warn");
    expect(check(rep, "tier-c-attachment").detail).toMatch(/non-hermetic/i);
  });

  it("fails closed instead of claiming Tier C when the configured capability file is absent", () => {
    const rep = report({
      MUON_DATA_DIR: tempDir("muon-empty-"),
      MUON_MCP_MODE: "attached-coordinator",
      MUON_ATTACHED_CAPABILITY_FILE: path.join(
        tempDir("muon-missing-capability-"),
        "codex.json"
      ),
    });
    expect(rep.wouldGetTierC).toBe(false);
    expect(check(rep, "mcp-mode-env").level).toBe("fail");
    expect(check(rep, "tier-c-attachment").level).toBe("fail");
    expect(rep.tierCReason).toMatch(/missing|unusable/i);
  });
});

// ─────────────────── the ambient conditions that silently bite ──────────────

describe("brain + token resolution branches (§3.2 rows 1-4)", () => {
  it("no live lockfile ⇒ brain-not-running AND no token AND tier none", () => {
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") });
    expect(rep.brainRunning).toBe(false);
    expect(rep.tokenSource).toBe("none");
    expect(rep.tier).toBe("none");
    expect(check(rep, "brain-running").level).toBe("fail");
    expect(check(rep, "agent-token").level).toBe("fail");
    expect(check(rep, "agent-token").detail).toContain("401");
  });

  it("a live lockfile with an agentToken ⇒ lockfile.agentToken, tier agent", () => {
    const dataDir = writeLockfile({ agentToken: "b".repeat(64) });
    const rep = report({ MUON_DATA_DIR: dataDir });
    expect(rep.brainRunning).toBe(true);
    expect(rep.port).toBe(51234);
    expect(rep.baseSource).toBe("lockfile");
    expect(rep.apiBase).toBe("http://127.0.0.1:51234");
    expect(rep.tokenSource).toBe("lockfile.agentToken");
    expect(rep.tier).toBe("agent");
    expect(check(rep, "agent-token").level).toBe("ok");
  });

  it("MUON_API_BASE turns OFF the lockfile branch — the §1.4b failure, named", () => {
    // THE load-bearing assertion for the "write no MUON_API_BASE" decision.
    // `resolveAgentToken()` short-circuits on explicitBase() and never reads the
    // lockfile, so a base in the environment silently degrades an otherwise
    // healthy machine to unauthenticated. If `muon mcp install` ever wrote a
    // base into a vendor's entry env, every such session would look like this.
    const dataDir = writeLockfile({ agentToken: "c".repeat(64) });
    const rep = report({
      MUON_DATA_DIR: dataDir,
      MUON_API_BASE: "http://localhost:4000/",
    });
    expect(rep.baseSource).toBe("explicit-env");
    expect(rep.apiBase).toBe("http://localhost:4000");
    // The brain IS running and DOES have an agent token, and it is still none.
    expect(rep.brainRunning).toBe(true);
    expect(rep.tokenSource).toBe("none");
    expect(rep.tier).toBe("none");
    expect(check(rep, "api-base-source").level).toBe("warn");
    expect(check(rep, "api-base-source").detail).toContain("turns OFF the lockfile branch");
  });

  it("NEXT_PUBLIC_MUON_API_BASE is the same trap and is reported the same way", () => {
    const dataDir = writeLockfile({ agentToken: "d".repeat(64) });
    const rep = report({
      MUON_DATA_DIR: dataDir,
      NEXT_PUBLIC_MUON_API_BASE: "http://127.0.0.1:9999",
    });
    expect(rep.baseSource).toBe("explicit-env");
    expect(rep.tokenSource).toBe("none");
  });

  it("with an explicit base, MUON_AGENT_TOKEN is the only surviving branch", () => {
    const dataDir = writeLockfile({ agentToken: "e".repeat(64) });
    const rep = report({
      MUON_DATA_DIR: dataDir,
      MUON_API_BASE: "http://remote.invalid",
      MUON_AGENT_TOKEN: "explicit-agent",
    });
    expect(rep.tokenSource).toBe("MUON_AGENT_TOKEN");
    expect(rep.tier).toBe("agent");
  });

  it("MUON_API_TOKEN wins, and the tier is STILL agent, never operator", () => {
    const rep = report({
      MUON_DATA_DIR: writeLockfile({ agentToken: "f".repeat(64) }),
      MUON_API_TOKEN: "job-bound",
    });
    expect(rep.tokenSource).toBe("MUON_API_TOKEN");
    // `resolveMcpApiToken()` has no operator branch, and a regression in
    // packages/mcp pins it. `status` must state that positively.
    expect(rep.tier).toBe("agent");
  });

  it("never surfaces the operator token from the lockfile, in any field", () => {
    const rep = report({ MUON_DATA_DIR: writeLockfile({ agentToken: "g".repeat(64) }) });
    const serialised = JSON.stringify(rep);
    expect(serialised).not.toContain("operator-token-must-never-be-used-here");
    expect(serialised).not.toContain("g".repeat(64));
    expect(rep.tier).not.toBe("operator");
  });
});

describe("MUON_MCP_MODE and the tool count (§3.2 row 5)", () => {
  it("unset ⇒ 30 tools and no authority-bearing mode", () => {
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") });
    expect(rep.mode).toBeNull();
    expect(rep.toolCount).toBe(30); // +2: ADR-0043, +1: publish_finding
    expect(check(rep, "mcp-mode-env").level).toBe("ok");
  });

  it("orchestrator ⇒ 47 tools AND a warning that the server will refuse to start", () => {
    const rep = report({
      MUON_DATA_DIR: tempDir("muon-empty-"),
      MUON_MCP_MODE: "orchestrator",
    });
    expect(rep.toolCount).toBe(47); // +2: ADR-0043, +1: publish_finding
    expect(check(rep, "mcp-mode-env").level).toBe("warn");
    expect(check(rep, "mcp-mode-env").detail).toContain("REFUSE TO START");
    expect(check(rep, "mcp-mode-env").detail).toContain("MUON_JOB_ID lineage");
  });

  it("observer ⇒ 37 tools, agent tier and no lineage warning", () => {
    const rep = report({
      MUON_DATA_DIR: writeLockfile({ agentToken: "o".repeat(64) }),
      MUON_MCP_MODE: "observer",
    });
    expect(rep.toolCount).toBe(37); // +2: ADR-0043
    expect(rep.tier).toBe("agent");
    expect(check(rep, "mcp-mode-env").level).toBe("ok");
    expect(check(rep, "mcp-mode-env").detail).toContain("bounded read-only");
    expect(check(rep, "mcp-mode-env").detail).not.toContain("MUON_JOB_ID");
  });
});

describe("installed observer coordinates", () => {
  it("reads the mode and chat from the vendor entry without spawning it", () => {
    const vendorIo = io();
    const config = path.join(vendorIo.roots.home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          muon: {
            command: MCP_BIN,
            args: [],
            env: {
              MUON_MCP_MODE: "observer",
              MUON_CHAT_ID: "chat-a",
            },
          },
        },
      })
    );
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") }, vendorIo);
    const cursor = rep.vendors.find((row) => row.vendor === "cursor")!;
    expect(cursor.mode).toBe("observer");
    expect(cursor.chatId).toBe("chat-a");
  });

  it("fails a vendor entry that requests an authority-bearing mode", () => {
    const vendorIo = io();
    const config = path.join(vendorIo.roots.home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          muon: {
            command: MCP_BIN,
            args: [],
            env: { MUON_MCP_MODE: "orchestrator" },
          },
        },
      })
    );
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") }, vendorIo);
    const cursor = rep.vendors.find((row) => row.vendor === "cursor")!;
    expect(cursor.reasons).toContainEqual(
      expect.objectContaining({ id: "authority-bearing-mode", level: "fail" })
    );
    expect(check(rep, "vendor-registration").level).toBe("fail");
  });

  it("rejects an attached vendor entry that points at another vendor's capability", () => {
    const vendorIo = io();
    const capabilityFile = writeCapabilityFile();
    const config = path.join(vendorIo.roots.home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          muon: {
            command: MCP_BIN,
            args: [],
            env: {
              MUON_MCP_MODE: "attached-coordinator",
              MUON_ATTACHED_CAPABILITY_FILE: capabilityFile,
            },
          },
        },
      })
    );

    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") }, vendorIo);
    const cursor = rep.vendors.find((row) => row.vendor === "cursor")!;
    expect(cursor.reasons).toContainEqual(
      expect.objectContaining({ id: "attached-coordinator", level: "fail" })
    );
    expect(rep.wouldGetTierC).toBe(false);
    expect(check(rep, "tier-c-attachment").level).toBe("fail");
  });
});

// ─────────────────── D-cmd: re-verification on every run ────────────────────

describe("D-cmd: status re-verifies the recorded command path every run", () => {
  function withClaudeEntry(command: string): McpVendorIo {
    const vendorIo = io();
    fs.writeFileSync(
      path.join(vendorIo.roots.home, ".claude.json"),
      JSON.stringify({ mcpServers: { muon: { type: "stdio", command, args: [] } } })
    );
    return vendorIo;
  }

  it("a resolving absolute path reads clean", () => {
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") }, withClaudeEntry(MCP_BIN));
    const claude = rep.vendors.find((row) => row.vendor === "claude-code")!;
    expect(claude.installed).toBe(true);
    expect(claude.command).toBe(MCP_BIN);
    expect(claude.commandResolves).toBe(true);
    expect(claude.reasons.map((r) => r.id)).not.toContain("command-path-moved");
    expect(check(rep, "vendor-registration").level).toBe("ok");
  });

  it("a path that MOVED is named as command-path-moved and fails the run", () => {
    // The exact silent failure D-cmd exists to catch: this breaks INSIDE the
    // user's own vendor CLI, where MUON has no interpose.
    const rep = report(
      { MUON_DATA_DIR: tempDir("muon-empty-") },
      withClaudeEntry("/Applications/MUON.app/old/muon-mcp")
    );
    const claude = rep.vendors.find((row) => row.vendor === "claude-code")!;
    expect(claude.installed).toBe(true);
    expect(claude.commandResolves).toBe(false);
    const reason = claude.reasons.find((r) => r.id === "command-path-moved")!;
    expect(reason.level).toBe("fail");
    expect(reason.detail).toContain("muon mcp install claude");
    expect(check(rep, "vendor-registration").level).toBe("fail");
  });

  it("a BARE command name is flagged even when it resolves in this shell", () => {
    // §1.4c: a vendor CLI launched from Finder inherits a bare PATH.
    const vendorIo = io({ which: () => "/usr/local/bin/muon-mcp" });
    fs.writeFileSync(
      path.join(vendorIo.roots.home, ".claude.json"),
      JSON.stringify({ mcpServers: { muon: { command: "muon-mcp", args: [] } } })
    );
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") }, vendorIo);
    const claude = rep.vendors.find((row) => row.vendor === "claude-code")!;
    const reason = claude.reasons.find((r) => r.id === "command-not-absolute")!;
    expect(reason.detail).toContain("bare 'muon-mcp'");
    expect(reason.detail).toContain("Finder");
  });

  it("reports the command an install would record right now", () => {
    const argv = process.argv[1];
    process.argv[1] = "/opt/muon/bin/muon";
    try {
      const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") });
      expect(rep.resolvedCommand).toBe(MCP_BIN);
      expect(check(rep, "muon-mcp-command").level).toBe("ok");
    } finally {
      process.argv[1] = argv;
    }
  });

  it("names the .dmg-only case when muon-mcp resolves nowhere", () => {
    const rep = report(
      { MUON_DATA_DIR: tempDir("muon-empty-") },
      io({ which: () => null, isExecutableFile: () => false })
    );
    expect(rep.resolvedCommand).toBeNull();
    const c = check(rep, "muon-mcp-command");
    expect(c.level).toBe("fail");
    expect(c.detail).toContain(".dmg-only install");
  });
});

// ─────────────────────── the vendor-specific reasons ────────────────────────

describe("per-vendor reasons status can name", () => {
  it("not-registered, with the exact command to fix it", () => {
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") });
    for (const row of rep.vendors) {
      const reason = row.reasons.find((r) => r.id === "not-registered")!;
      expect(reason.detail).toContain(row.configPath);
      expect(reason.detail).toContain("muon mcp install");
    }
    expect(check(rep, "vendor-registration").level).toBe("fail");
  });

  it("vendor-cli-missing says MUON will never log you in", () => {
    const rep = report(
      { MUON_DATA_DIR: tempDir("muon-empty-") },
      io({ which: () => null, isExecutableFile: () => false })
    );
    for (const row of rep.vendors) {
      expect(row.cliInstalled).toBe(false);
      const reason = row.reasons.find((r) => r.id === "vendor-cli-missing")!;
      expect(reason.detail).toContain("never installs or logs in");
    }
  });

  it("scope-local-invisible-elsewhere fires on a claude LOCAL-scope entry", () => {
    // The measured trap: the vendor's default scope is `local`.
    const vendorIo = io();
    fs.writeFileSync(
      path.join(vendorIo.roots.home, ".claude.json"),
      JSON.stringify({
        projects: {
          [vendorIo.roots.cwd]: { mcpServers: { muon: { command: MCP_BIN } } },
        },
      })
    );
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") }, vendorIo);
    const claude = rep.vendors.find((row) => row.vendor === "claude-code")!;
    // User scope is still empty, so it reads as not registered AND explains why
    // the user might believe otherwise.
    expect(claude.installed).toBe(false);
    const reason = claude.reasons.find(
      (r) => r.id === "scope-local-invisible-elsewhere"
    )!;
    expect(reason.level).toBe("fail");
    expect(reason.detail).toContain("invisible from any other repo");
  });

  it("vendor-approval-list is reported for an installed cursor", () => {
    const vendorIo = io();
    const file = path.join(vendorIo.roots.home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ mcpServers: { muon: { command: MCP_BIN, args: [] } } })
    );
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") }, vendorIo);
    const cursor = rep.vendors.find((row) => row.vendor === "cursor")!;
    const reason = cursor.reasons.find((r) => r.id === "vendor-approval-list")!;
    expect(reason.detail).toContain("cursor-agent mcp enable muon");
    // The live-measured gotcha, recorded where a user will read it.
    expect(reason.detail).toContain("exits 0 even when logged OUT");
  });

  it("opencode is always labelled vendor-writer-unverified", () => {
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") });
    const opencode = rep.vendors.find((row) => row.vendor === "opencode")!;
    const reason = opencode.reasons.find((r) => r.id === "vendor-writer-unverified")!;
    expect(reason.detail).toContain("interactive");
  });

  it("config-unreadable is reported instead of a silent 'not registered'", () => {
    const vendorIo = io();
    fs.writeFileSync(path.join(vendorIo.roots.home, ".claude.json"), "{ broken");
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") }, vendorIo);
    const claude = rep.vendors.find((row) => row.vendor === "claude-code")!;
    const reason = claude.reasons.find((r) => r.id === "config-unreadable")!;
    expect(reason.level).toBe("fail");
    expect(reason.detail).toContain("refuses to rewrite");
  });

  it("reads codex's TOML section without spawning codex", () => {
    const vendorIo = io();
    const file = path.join(vendorIo.roots.home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `model = "gpt-5"\n\n[mcp_servers.muon]\ncommand = "${MCP_BIN}"\n\n[mcp_servers.muon.env]\nX = "1"\n`
    );
    const rep = report({ MUON_DATA_DIR: tempDir("muon-empty-") }, vendorIo);
    const codex = rep.vendors.find((row) => row.vendor === "codex")!;
    expect(codex.installed).toBe(true);
    expect(codex.command).toBe(MCP_BIN);
    expect(codex.commandResolves).toBe(true);
  });
});

// ───────────────────────────── the CLI surface ──────────────────────────────

describe("muon mcp status output", () => {
  function run(argv: string[], vendorIo: McpVendorIo, env: Record<string, string>) {
    const program = new Command();
    program.exitOverride();
    registerMcpCommands(program, { io: vendorIo, env });
    return program.parseAsync(["node", "muon", ...argv]);
  }

  it("renders the tier, the branch names and every check", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await run(["mcp", "status"], io(), {
      MUON_DATA_DIR: writeLockfile({ agentToken: "h".repeat(64) }),
    });
    const text = out.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("Tier:        agent");
    expect(text).toContain("Bearer from: lockfile.agentToken");
    expect(text).toContain("never operator, by construction");
    for (const id of MCP_STATUS_CHECK_IDS) {
      expect(text).toContain(id);
    }
    // The honest boundary (§3.3 point 5).
    expect(text).toContain("does NOT govern what that session does to your filesystem");
    process.exitCode = 0;
  });

  it("--json emits the whole report and exits 1 when a check fails", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await run(["mcp", "status", "--json"], io(), {
      MUON_DATA_DIR: tempDir("muon-empty-"),
    });
    const parsed = JSON.parse(
      out.mock.calls.map((call) => String(call[0])).join("")
    ) as McpStatusReport;
    expect(parsed.tier).toBe("none");
    expect(parsed.vendors).toHaveLength(4);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
