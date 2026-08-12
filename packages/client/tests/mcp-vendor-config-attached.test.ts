import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installMcpServer,
  readVendorEntry,
  resolveInstallableVendor,
  type McpVendorIo,
  type VendorRunResult,
} from "../src/mcp-vendor-config.js";

// ── ADR-0028 Tier C: the attach-mode vendor writer ───────────────────────────
//
// SAFETY RULE (mirrors apps/cli/tests/mcp-install.test.ts): every `McpVendorIo`
// here is rooted at a fresh mkdtemp with `redirectVendorConfigDirs: true`, and
// the fake vendor runner THROWS if handed a spawn without that override — so a
// regression that flipped the seam off fails loudly instead of silently
// writing into the operator's real ~/.claude / ~/.codex / ~/.cursor.

const MCP_BIN = "/opt/muon/bin/muon-mcp";

const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
});

function tempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "muon-mcp-attached-install-")
  );
  tempRoots.push(dir);
  return dir;
}

type Spawned = { command: string; args: string[]; env: Record<string, string> };

function fakeVendorRunner(spawns: Spawned[]) {
  return (
    command: string,
    args: readonly string[],
    extraEnv: Readonly<Record<string, string>>
  ): VendorRunResult => {
    spawns.push({ command, args: [...args], env: { ...extraEnv } });
    if (command === "codex") {
      // Mirrors apps/cli/tests/mcp-install.test.ts's fake `codex mcp add`: codex
      // owns TOML and overwrites `[mcp_servers.muon]` in place at rc 0.
      const home = extraEnv.CODEX_HOME;
      if (!home) {
        throw new Error(
          "SAFETY: a test spawned `codex` with no CODEX_HOME override — it would have written the operator's real ~/.codex/config.toml"
        );
      }
      const file = path.join(home, "config.toml");
      const header = `[mcp_servers.${args[2]}]`;
      const envHeader = `[mcp_servers.${args[2]}.env]`;
      const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const stripped = stripTomlSection(
        stripTomlSection(existing, header),
        envHeader
      );
      const entryEnv: Record<string, string> = {};
      for (let index = 0; index < args.length - 1; index += 1) {
        if (args[index] !== "--env") continue;
        const pair = args[index + 1] ?? "";
        const split = pair.indexOf("=");
        if (split > 0) entryEnv[pair.slice(0, split)] = pair.slice(split + 1);
      }
      const envLines = Object.entries(entryEnv).map(
        ([key, value]) => `${key} = ${JSON.stringify(value)}`
      );
      writeText(
        file,
        `${stripped}${stripped && !stripped.endsWith("\n") ? "\n" : ""}${header}\ncommand = ${JSON.stringify(args[args.length - 1])}\n${envLines.length > 0 ? `${envHeader}\n${envLines.join("\n")}\n` : ""}`
      );
      return {
        code: 0,
        stdout: "Added global MCP server 'muon'.",
        stderr: "",
        spawnFailed: false,
      };
    }
    throw new Error(`unexpected spawn: ${command}`);
  };
}

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function stripTomlSection(text: string, header: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    return text;
  }
  let end = start + 1;
  while (end < lines.length && !lines[end]!.trimStart().startsWith("[")) {
    end += 1;
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

type Harness = { io: McpVendorIo; home: string; spawns: Spawned[] };

function harness(): Harness {
  const home = tempHome();
  const spawns: Spawned[] = [];
  return {
    home,
    spawns,
    io: {
      roots: {
        home,
        configHome: path.join(home, ".config"),
        cwd: home,
        redirectVendorConfigDirs: true,
      },
      run: fakeVendorRunner(spawns),
      which: (command) => `/usr/local/bin/${command}`,
      isExecutableFile: (p) => p === MCP_BIN,
    },
  };
}

describe("installMcpServer with mode: attached-coordinator", () => {
  it("writes ONLY MUON_MCP_MODE and MUON_ATTACHED_CAPABILITY_FILE — no token, no MUON_API_BASE, no chatId", () => {
    const h = harness();
    const capabilityFile = path.join(
      h.home, ".local", "share", "muon", "attached-coordinators", "codex.json"
    );
    const spec = resolveInstallableVendor("codex")!;
    const outcome = installMcpServer(h.io, {
      spec,
      scope: spec.defaultScope,
      command: MCP_BIN,
      dryRun: false,
      mode: "attached-coordinator",
      capabilityFile,
      // Even though chatId is set, attach mode must never persist it —
      // the capability file (not the vendor config) carries the chat.
      chatId: "should-be-ignored",
    });
    expect(outcome.kind).toBe("written");

    const toml = fs.readFileSync(
      path.join(h.home, ".codex", "config.toml"),
      "utf8"
    );
    expect(toml).toContain("[mcp_servers.muon]");
    expect(toml).toContain(`command = "${MCP_BIN}"`);
    expect(toml).toContain("[mcp_servers.muon.env]");
    expect(toml).toContain('MUON_MCP_MODE = "attached-coordinator"');
    expect(toml).toContain(`MUON_ATTACHED_CAPABILITY_FILE = "${capabilityFile}"`);
    expect(toml).not.toContain("MUON_CHAT_ID");
    expect(toml).not.toContain("MUON_API_BASE");
    expect(toml).not.toContain("MUON_API_TOKEN");
    expect(toml).not.toContain("should-be-ignored");

    const entry = readVendorEntry(spec, spec.defaultScope, h.io.roots);
    expect(entry.kind).toBe("present");
    if (entry.kind === "present") {
      expect(entry.environment).toEqual({
        MUON_MCP_MODE: "attached-coordinator",
        MUON_ATTACHED_CAPABILITY_FILE: capabilityFile,
      });
    }
  });

  it("refuses an install with no capabilityFile", () => {
    const h = harness();
    const spec = resolveInstallableVendor("codex")!;
    expect(() =>
      installMcpServer(h.io, {
        spec,
        scope: spec.defaultScope,
        command: MCP_BIN,
        dryRun: false,
        mode: "attached-coordinator",
      })
    ).toThrow(/capabilityFile/);
  });

  it("refuses a relative capabilityFile", () => {
    const h = harness();
    const spec = resolveInstallableVendor("codex")!;
    expect(() =>
      installMcpServer(h.io, {
        spec,
        scope: spec.defaultScope,
        command: MCP_BIN,
        dryRun: false,
        mode: "attached-coordinator",
        capabilityFile: "relative/path.json",
      })
    ).toThrow(/absolute/);
  });

  it("is idempotent: re-running with the same capabilityFile makes no further writes", () => {
    const h = harness();
    const capabilityFile = path.join(h.home, "cap", "codex.json");
    const spec = resolveInstallableVendor("codex")!;
    const request = {
      spec,
      scope: spec.defaultScope,
      command: MCP_BIN,
      dryRun: false,
      mode: "attached-coordinator" as const,
      capabilityFile,
    };
    expect(installMcpServer(h.io, request).kind).toBe("written");
    expect(h.spawns).toHaveLength(1);
    const second = installMcpServer(h.io, request);
    expect(second.kind).toBe("already-current");
    // No second spawn — nothing was rewritten.
    expect(h.spawns).toHaveLength(1);
  });

  it("reattach with a NEW capabilityFile replaces MUON's entry without destroying a sibling MCP server", () => {
    const h = harness();
    // Simulate a sibling server already present in codex's config.toml.
    fs.mkdirSync(path.join(h.home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(h.home, ".codex", "config.toml"),
      '[mcp_servers.sibling]\ncommand = "/opt/other/bin/sibling"\n'
    );
    const spec = resolveInstallableVendor("codex")!;
    const first = path.join(h.home, "cap", "codex-first.json");
    installMcpServer(h.io, {
      spec,
      scope: spec.defaultScope,
      command: MCP_BIN,
      dryRun: false,
      mode: "attached-coordinator",
      capabilityFile: first,
    });
    const second = path.join(h.home, "cap", "codex-second.json");
    const outcome = installMcpServer(h.io, {
      spec,
      scope: spec.defaultScope,
      command: MCP_BIN,
      dryRun: false,
      mode: "attached-coordinator",
      capabilityFile: second,
    });
    expect(outcome.kind).toBe("written");
    if (outcome.kind === "written") {
      expect(outcome.replaced).toBe(true);
    }

    const toml = fs.readFileSync(
      path.join(h.home, ".codex", "config.toml"),
      "utf8"
    );
    // The sibling server survives, byte-identical.
    expect(toml).toContain("[mcp_servers.sibling]");
    expect(toml).toContain('command = "/opt/other/bin/sibling"');
    // MUON's own entry now names ONLY the new capability file.
    expect(toml).toContain(`MUON_ATTACHED_CAPABILITY_FILE = "${second}"`);
    expect(toml).not.toContain(first);
  });

  it("base (no mode) and observer installs are unaffected: still no capability-file key", () => {
    const h = harness();
    const spec = resolveInstallableVendor("codex")!;
    installMcpServer(h.io, {
      spec,
      scope: spec.defaultScope,
      command: MCP_BIN,
      dryRun: false,
    });
    const baseEntry = readVendorEntry(spec, spec.defaultScope, h.io.roots);
    expect(baseEntry.kind).toBe("present");
    if (baseEntry.kind === "present") {
      expect(baseEntry.environment).toEqual({});
    }

    installMcpServer(h.io, {
      spec,
      scope: spec.defaultScope,
      command: MCP_BIN,
      dryRun: false,
      mode: "observer",
      chatId: "chat-1",
    });
    const observerEntry = readVendorEntry(spec, spec.defaultScope, h.io.roots);
    expect(observerEntry.kind).toBe("present");
    if (observerEntry.kind === "present") {
      expect(observerEntry.environment).toEqual({
        MUON_MCP_MODE: "observer",
        MUON_CHAT_ID: "chat-1",
      });
    }
  });
});
