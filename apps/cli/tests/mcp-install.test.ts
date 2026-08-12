import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMcpCommands } from "../src/commands/mcp.js";
import {
  fakeVendorRunner,
  type Spawned,
} from "./helpers/fake-vendor-cli.js";
import {
  MUON_MCP_ENTRY_NAME,
  installMcpServer,
  resolveInstallableVendor,
  uninstallMcpServer,
  type McpVendorIo,
  type VendorRunResult,
} from "@muon/client/mcp-vendor-config";

/**
 * `muon mcp install|uninstall` — S1 of docs/design/cc-as-superagent-delivery.md.
 *
 * SAFETY RULE THIS FILE ENFORCES STRUCTURALLY, not by convention: no test may
 * touch `~/.claude`, `~/.codex`, `~/.cursor` or `~/.config/opencode`. Those are
 * the operator's real vendor configs; MUON reads them for credentials and must
 * never modify them.
 *
 * Two independent guards:
 *  1. every `McpVendorIo` here is rooted at a fresh mkdtemp, with
 *     `redirectVendorConfigDirs: true`, so the vendor-dir override env is set;
 *  2. `fakeVendorRunner` THROWS if it is handed a spawn without that override —
 *     so a regression that flipped the seam off would fail the suite loudly
 *     rather than silently writing into the real home.
 *
 * The vendor-CLI runner is a FAITHFUL MODEL of behaviour measured live on
 * 2026-07-30 (claude 2.1.220, codex-cli 0.145.0) and is documented per branch.
 * The real binaries are exercised separately by `mcp-install.live.test.ts`,
 * which self-skips unless MUON_TEST_VENDOR_CLIS=1.
 */

const MCP_BIN = "/opt/muon/bin/muon-mcp";

const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
  vi.restoreAllMocks();
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-mcp-install-"));
  tempRoots.push(dir);
  return dir;
}


/**
 * Models exactly what the two vendor writers were measured to do.
 *
 * claude 2.1.220:
 *   `mcp add <name> -s <scope> -- <cmd>`  → rc 0 and writes; rc **1** with
 *     "already exists" when the name is present in that scope (this is why
 *     install does remove-then-add for an update).
 *   `mcp remove <name> -s <scope>`        → rc 0 when it removed something,
 *     rc **1** with 'No MCP server named "muon" in user scope' when absent. So
 *     rc 1 means BOTH "was not there" and "could not remove", which is why the
 *     code treats a failed remove as a note and lets `add` / the read-back be
 *     the gate. (Measured live; an earlier reading of this probe was wrong
 *     because `claude … | head` reports the pipe's status, not claude's.)
 *   user scope   → top-level `mcpServers` in <CLAUDE_CONFIG_DIR>/.claude.json
 *   project scope→ `mcpServers` in <cwd>/.mcp.json
 *   the written entry is `{type:"stdio", command, args:[], env:{}}`.
 *
 * codex-cli 0.145.0:
 *   `mcp add <name> -- <cmd>` → rc 0 ALWAYS, overwriting in place, into
 *   <CODEX_HOME>/config.toml as `[mcp_servers.<name>]` + `command = "..."`.
 *   `mcp remove <name>`       → rc 0.
 */
function ok(stdout: string): VendorRunResult {
  return { code: 0, stdout, stderr: "", spawnFailed: false };
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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

type Harness = {
  io: McpVendorIo;
  home: string;
  cwd: string;
  spawns: Spawned[];
};

function harness(opts: { cliOnPath?: boolean } = {}): Harness {
  const home = tempHome();
  const cwd = path.join(home, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  const spawns: Spawned[] = [];
  const run = fakeVendorRunner(spawns);
  return {
    home,
    cwd,
    spawns,
    io: {
      roots: {
        home,
        configHome: path.join(home, ".config"),
        cwd,
        // The explicit isolation seam. Everything in this file depends on it.
        redirectVendorConfigDirs: true,
      },
      run: (command, args, extraEnv) =>
        run(command, args, { ...extraEnv, MUON_TEST_CWD: cwd }),
      which: (command) =>
        opts.cliOnPath === false ? null : `/usr/local/bin/${command}`,
      isExecutableFile: (p) => p === MCP_BIN,
    },
  };
}

function install(
  h: Harness,
  vendor: string,
  opts: {
    scope?: "user" | "project";
    dryRun?: boolean;
    mode?: "observer";
    chatId?: string;
  } = {}
) {
  const spec = resolveInstallableVendor(vendor)!;
  return installMcpServer(h.io, {
    spec,
    scope: opts.scope ?? spec.defaultScope,
    command: MCP_BIN,
    dryRun: opts.dryRun === true,
    mode: opts.mode,
    chatId: opts.chatId,
  });
}

// ─────────────────────── what is written, per vendor ────────────────────────

describe("install writes the verified command and NOTHING authority-bearing", () => {
  it("claude: passes -s user EXPLICITLY, because the vendor default is local", () => {
    const h = harness();
    const outcome = install(h, "claude");
    expect(outcome.kind).toBe("written");
    // The whole point of the sub-decision. Without `-s user` a user who installs
    // from one repo finds the tools missing in the next one.
    expect(h.spawns[0]).toMatchObject({
      command: "claude",
      args: ["mcp", "add", "muon", "-s", "user", "--", MCP_BIN],
    });
    const doc = readJson(path.join(h.home, ".claude.json"));
    expect(doc.mcpServers).toEqual({
      muon: { type: "stdio", command: MCP_BIN, args: [], env: {} },
    });
    // The entry must NOT be under projects.<cwd> (local scope).
    expect(doc.projects).toBeUndefined();
  });

  it("claude --scope project writes the repo's .mcp.json instead", () => {
    const h = harness();
    expect(install(h, "claude", { scope: "project" }).kind).toBe("written");
    expect(h.spawns[0]!.args).toContain("project");
    expect(readJson(path.join(h.cwd, ".mcp.json")).mcpServers).toMatchObject({
      muon: { command: MCP_BIN },
    });
  });

  it("codex: global only, through the vendor's own writer", () => {
    const h = harness();
    const outcome = install(h, "codex");
    expect(outcome.kind).toBe("written");
    expect(h.spawns[0]).toMatchObject({
      command: "codex",
      args: ["mcp", "add", "muon", "--", MCP_BIN],
    });
    const toml = fs.readFileSync(path.join(h.home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.muon]");
    expect(toml).toContain(`command = "${MCP_BIN}"`);
  });

  it("codex refuses --scope project rather than pretending it exists", () => {
    const h = harness();
    const outcome = install(h, "codex", { scope: "project" });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason).toContain("no 'project' MCP scope");
    expect(h.spawns).toHaveLength(0);
  });

  it("cursor: MUON writes the JSON itself, then runs the vendor's enable", () => {
    const h = harness();
    const outcome = install(h, "cursor");
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;
    expect(readJson(path.join(h.home, ".cursor", "mcp.json")).mcpServers).toEqual({
      muon: { command: MCP_BIN, args: [] },
    });
    // The write happens first; `enable` is best-effort and only clears a prior
    // `mcp disable`.
    expect(h.spawns).toEqual([
      expect.objectContaining({
        command: "cursor-agent",
        args: ["mcp", "enable", "muon"],
      }),
    ]);
    expect(outcome.followUps.join(" ")).toContain("mcp enable muon");
  });

  it("cursor still writes when cursor-agent is missing, and says enable was skipped", () => {
    const h = harness({ cliOnPath: false });
    const outcome = install(h, "cursor");
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;
    expect(h.spawns).toHaveLength(0);
    expect(outcome.followUps.join(" ")).toContain("not on PATH");
  });

  it("opencode: the live-verified local shape, plus the schema pointer", () => {
    const h = harness();
    expect(install(h, "opencode").kind).toBe("written");
    const doc = readJson(
      path.join(h.home, ".config", "opencode", "opencode.json")
    );
    expect(doc.mcp).toEqual({
      muon: { type: "local", command: [MCP_BIN], enabled: true },
    });
    expect(doc.$schema).toBe("https://opencode.ai/config.json");
    // MUON does not drive opencode's interactive `mcp add`.
    expect(h.spawns).toHaveLength(0);
  });

  it("writes NO MUON_API_BASE, NO token and NO MUON_MCP_MODE, for any vendor", () => {
    // §1.4a/b + §2.2. `MUON_API_BASE` is the dangerous one: writing it makes
    // explicitBase() true, which turns OFF the lockfile branch muon-mcp's token
    // resolution depends on — so the session silently 401s. See the paired
    // "token resolution" assertion in mcp-status.test.ts.
    for (const vendor of ["claude", "codex", "cursor", "opencode"]) {
      const h = harness();
      expect(install(h, vendor).kind).toBe("written");
      const spec = resolveInstallableVendor(vendor)!;
      const file = spec.id === "codex"
        ? path.join(h.home, ".codex", "config.toml")
        : spec.id === "cursor"
          ? path.join(h.home, ".cursor", "mcp.json")
          : spec.id === "opencode"
            ? path.join(h.home, ".config", "opencode", "opencode.json")
            : path.join(h.home, ".claude.json");
      const text = fs.readFileSync(file, "utf8");
      expect(text).not.toContain("MUON_API_BASE");
      expect(text).not.toContain("MUON_API_TOKEN");
      expect(text).not.toContain("MUON_AGENT_TOKEN");
      expect(text).not.toContain("MUON_MCP_MODE");
      expect(text).not.toContain("NEXT_PUBLIC_MUON_API_BASE");
      // And nothing that looks like a 32-byte hex credential.
      expect(text).not.toMatch(/[0-9a-f]{64}/);
      // Nor any of the vendor CLI argv.
      for (const spawn of h.spawns) {
        expect(spawn.args.join(" ")).not.toContain("MUON_API_BASE");
        expect(spawn.args.join(" ")).not.toContain("TOKEN");
        expect(spawn.args.join(" ")).not.toContain("MUON_MCP_MODE");
      }
    }
  });

  it("and the --dry-run PREVIEW is held to the same rule, for every vendor", () => {
    // Found by mutating the preview renderer and watching all 287 tests pass.
    //
    // The assertion above reads the file that was actually WRITTEN, which is the
    // invariant that matters — but for a vendor whose own CLI does the writing the
    // preview is a hand-built PREDICTION of what that CLI will produce, and nothing
    // held it to the same rule. A preview that printed `MUON_API_BASE` would be
    // telling the operator MUON does the one thing §1.4b says breaks token
    // resolution, whether or not the write agrees.
    //
    // A prediction and a write are two evaluators of one fact. This does not merge
    // them; it holds both to the same rule, which is the cheap half.
    for (const vendor of ["claude", "codex", "cursor", "opencode"]) {
      const h = harness();
      const outcome = install(h, vendor, { dryRun: true });
      expect(outcome.kind).toBe("dry-run");
      if (outcome.kind !== "dry-run") return;
      // Both halves of the plan: the ENTRY it predicts and the VIA line (a vendor
      // CLI's argv, where a credential would ride as a flag rather than a key).
      const preview = `${outcome.entry}\n${outcome.via}`;
      expect(preview).toContain(MCP_BIN);
      expect(preview).not.toContain("MUON_API_BASE");
      expect(preview).not.toContain("MUON_API_TOKEN");
      expect(preview).not.toContain("MUON_AGENT_TOKEN");
      expect(preview).not.toContain("MUON_MCP_MODE=");
      expect(preview).not.toMatch(/[0-9a-f]{64}/);
    }
  });
});

describe("Tier B observer mode and S4 chat partition", () => {
  for (const vendor of ["claude", "codex", "cursor", "opencode"]) {
    it(`${vendor}: writes only observer mode + chat coordinates and is idempotent`, () => {
      const h = harness();
      const first = install(h, vendor, {
        mode: "observer",
        chatId: "chat-observed",
      });
      expect(first.kind).toBe("written");
      if (first.kind !== "written") return;
      expect(first.entry).toContain("MUON_MCP_MODE");
      expect(first.entry).toContain("observer");
      expect(first.entry).toContain("MUON_CHAT_ID");
      expect(first.entry).toContain("chat-observed");
      expect(first.entry).not.toContain("MUON_API_BASE");
      expect(first.entry).not.toContain("TOKEN");

      const second = install(h, vendor, {
        mode: "observer",
        chatId: "chat-observed",
      });
      expect(second.kind).toBe("already-current");
    });
  }

  it("replaces an observer coordinate when the requested chat changes", () => {
    const h = harness();
    expect(
      install(h, "cursor", { mode: "observer", chatId: "chat-a" }).kind
    ).toBe("written");
    const changed = install(h, "cursor", {
      mode: "observer",
      chatId: "chat-b",
    });
    expect(changed.kind).toBe("written");
    const text = fs.readFileSync(
      path.join(h.home, ".cursor", "mcp.json"),
      "utf8"
    );
    expect(text).toContain("chat-b");
    expect(text).not.toContain("chat-a");
  });
});

// ─────────────────────────────── idempotence ────────────────────────────────

describe("install is idempotent — byte-identical after a second run", () => {
  for (const vendor of ["claude", "codex", "cursor", "opencode"]) {
    it(`${vendor}: running install twice leaves the config byte-identical`, () => {
      const h = harness();
      const spec = resolveInstallableVendor(vendor)!;
      const file =
        spec.id === "codex"
          ? path.join(h.home, ".codex", "config.toml")
          : spec.id === "cursor"
            ? path.join(h.home, ".cursor", "mcp.json")
            : spec.id === "opencode"
              ? path.join(h.home, ".config", "opencode", "opencode.json")
              : path.join(h.home, ".claude.json");

      expect(install(h, vendor).kind).toBe("written");
      const afterFirst = fs.readFileSync(file);
      const spawnsAfterFirst = h.spawns.length;

      const second = install(h, vendor);
      // The uniform rule: when the entry already names exactly this command,
      // NOTHING is touched — not the file, not the vendor CLI. That is what
      // makes "byte-identical" a guarantee rather than a coincidence.
      expect(second.kind).toBe("already-current");
      expect(fs.readFileSync(file).equals(afterFirst)).toBe(true);
      expect(h.spawns.length).toBe(spawnsAfterFirst);
    });
  }

  it("claude: an entry whose command MOVED is replaced via remove-then-add", () => {
    // The D-cmd update path. `claude mcp add` exits 1 on an existing name
    // (measured), so a naive re-add would report failure and leave the stale
    // path in place — a silent MCP failure inside the user's own CLI.
    const h = harness();
    writeJson(path.join(h.home, ".claude.json"), {
      keepMe: true,
      mcpServers: {
        muon: { type: "stdio", command: "/old/gone/muon-mcp", args: [], env: {} },
      },
    });
    const outcome = install(h, "claude");
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;
    expect(outcome.replaced).toBe(true);
    expect(h.spawns.map((s) => s.args.slice(0, 2).join(" "))).toEqual([
      "mcp remove",
      "mcp add",
    ]);
    const doc = readJson(path.join(h.home, ".claude.json"));
    expect(doc.keepMe).toBe(true);
    expect(doc.mcpServers).toMatchObject({ muon: { command: MCP_BIN } });
  });

  it("--dry-run prints the plan and writes nothing at all", () => {
    const h = harness();
    const outcome = install(h, "cursor", { dryRun: true });
    expect(outcome.kind).toBe("dry-run");
    if (outcome.kind !== "dry-run") return;
    expect(outcome.entry).toContain(MCP_BIN);
    expect(outcome.via).toContain("direct JSON write");
    expect(fs.existsSync(path.join(h.home, ".cursor", "mcp.json"))).toBe(false);
    expect(h.spawns).toHaveLength(0);
  });

  it("--dry-run for a vendor-CLI writer spawns nothing", () => {
    const h = harness();
    const outcome = install(h, "claude", { dryRun: true });
    expect(outcome.kind).toBe("dry-run");
    if (outcome.kind !== "dry-run") return;
    expect(outcome.via).toBe(`claude mcp add muon -s user -- ${MCP_BIN}`);
    expect(h.spawns).toHaveLength(0);
    expect(fs.existsSync(path.join(h.home, ".claude.json"))).toBe(false);
  });
});

// ───────────────── uninstall removes exactly one entry ──────────────────────

describe("uninstall removes exactly the entry MUON wrote", () => {
  it("cursor: a foreign server and every sibling key survive", () => {
    const h = harness();
    const file = path.join(h.home, ".cursor", "mcp.json");
    writeJson(file, {
      mcpServers: {
        somebodyElse: {
          command: "/opt/homebrew/bin/other-mcp",
          env: { OTHER_TOKEN: "keep-me" },
        },
      },
      unrelatedTopLevelKey: { deep: ["value"] },
    });
    expect(install(h, "cursor").kind).toBe("written");
    // The install itself must not have disturbed the neighbour.
    expect(readJson(file).mcpServers).toMatchObject({
      somebodyElse: { command: "/opt/homebrew/bin/other-mcp" },
      muon: { command: MCP_BIN },
    });

    const outcome = uninstallMcpServer(
      h.io,
      resolveInstallableVendor("cursor")!,
      "user"
    );
    expect(outcome.kind).toBe("removed");
    const after = readJson(file);
    expect(after.mcpServers).toEqual({
      somebodyElse: {
        command: "/opt/homebrew/bin/other-mcp",
        env: { OTHER_TOKEN: "keep-me" },
      },
    });
    expect(after.unrelatedTopLevelKey).toEqual({ deep: ["value"] });
  });

  it("opencode: a foreign remote server survives", () => {
    const h = harness();
    const file = path.join(h.home, ".config", "opencode", "opencode.json");
    writeJson(file, {
      $schema: "https://opencode.ai/config.json",
      mcp: { other: { type: "remote", url: "https://example.invalid/mcp" } },
      theme: "dark",
    });
    expect(install(h, "opencode").kind).toBe("written");
    expect(
      uninstallMcpServer(h.io, resolveInstallableVendor("opencode")!, "user").kind
    ).toBe("removed");
    const after = readJson(file);
    expect(after.mcp).toEqual({
      other: { type: "remote", url: "https://example.invalid/mcp" },
    });
    expect(after.theme).toBe("dark");
    expect(after.$schema).toBe("https://opencode.ai/config.json");
  });

  it("claude: goes through the vendor's own remove, scoped", () => {
    const h = harness();
    writeJson(path.join(h.home, ".claude.json"), {
      mcpServers: { gitnexus: { type: "stdio", command: "/x/gitnexus-mcp" } },
    });
    expect(install(h, "claude").kind).toBe("written");
    h.spawns.length = 0;
    const outcome = uninstallMcpServer(
      h.io,
      resolveInstallableVendor("claude")!,
      "user"
    );
    expect(outcome.kind).toBe("removed");
    // `-s user` keeps the removal from reaching into another scope the user set
    // up deliberately.
    expect(h.spawns[0]!.args).toEqual(["mcp", "remove", "muon", "-s", "user"]);
    expect(readJson(path.join(h.home, ".claude.json")).mcpServers).toEqual({
      gitnexus: { type: "stdio", command: "/x/gitnexus-mcp" },
    });
  });

  it("codex: strips only the muon TOML section", () => {
    const h = harness();
    const file = path.join(h.home, ".codex", "config.toml");
    writeText(
      file,
      'model = "gpt-5"\n\n[mcp_servers.gitnexus]\ncommand = "/x/gnx"\n\n[mcp_servers.gitnexus.env]\nGNX = "1"\n'
    );
    expect(install(h, "codex").kind).toBe("written");
    expect(
      uninstallMcpServer(h.io, resolveInstallableVendor("codex")!, "user").kind
    ).toBe("removed");
    const after = fs.readFileSync(file, "utf8");
    expect(after).toContain('model = "gpt-5"');
    expect(after).toContain("[mcp_servers.gitnexus]");
    expect(after).toContain('GNX = "1"');
    expect(after).not.toContain("[mcp_servers.muon]");
  });

  it("reports 'absent' rather than failing when there is nothing to remove", () => {
    const h = harness();
    const outcome = uninstallMcpServer(
      h.io,
      resolveInstallableVendor("cursor")!,
      "user"
    );
    expect(outcome.kind).toBe("absent");
  });

  it("refuses, and writes nothing, when the config cannot be parsed", () => {
    const h = harness();
    const file = path.join(h.home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json");
    const before = fs.readFileSync(file);

    expect(install(h, "cursor").kind).toBe("refused");
    expect(
      uninstallMcpServer(h.io, resolveInstallableVendor("cursor")!, "user").kind
    ).toBe("refused");
    // A rewrite that dropped keys MUON failed to read would be unrecoverable.
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("creates a new MUON-written config 0600", () => {
    const h = harness();
    expect(install(h, "cursor").kind).toBe("written");
    const file = path.join(h.home, ".cursor", "mcp.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("PRESERVES a wider existing mode and reports it instead of narrowing it", () => {
    // Silently changing the visibility of a file the user chose to share is not
    // MUON's call — but these files routinely hold OTHER servers' bearer tokens,
    // so the mode has to be said out loud.
    const h = harness();
    const file = path.join(h.home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }), { mode: 0o644 });
    const outcome = install(h, "cursor");
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    const note = outcome.followUps.find((n) => n.includes("mode 0644"))!;
    expect(note).toContain("preserved it rather than narrowing");
    expect(note).toContain("chmod 600");
  });
});

// ───────────────────────── the command surface ──────────────────────────────

describe("the muon mcp command surface", () => {
  function run(argv: string[], h: Harness, env: Record<string, string> = {}) {
    const program = new Command();
    program.exitOverride();
    registerMcpCommands(program, { io: h.io, env });
    return program.parseAsync(["node", "muon", ...argv]);
  }

  it("install prints the file, the entry, the tier, the tool count and the next step", async () => {
    const h = harness();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    // The sibling probe must land on our fake bin, so point argv[1] at it.
    const argv = process.argv[1];
    process.argv[1] = "/opt/muon/bin/muon";
    try {
      await run(["mcp", "install", "cursor"], h);
    } finally {
      process.argv[1] = argv;
    }
    const text = out.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain(path.join(h.home, ".cursor", "mcp.json"));
    expect(text).toContain(MCP_BIN);
    expect(text).toContain("Tier this entry gets: agent");
    expect(text).toContain("30 tools"); // +2: ADR-0043 question_ask/question_status
    expect(text).toContain("restart cursor-agent");
    // §2.2: the two booleans, never conflated.
    expect(text).toContain("holds NO coordinator seat");
    // §3.1: the omissions are explained where the user reads them.
    expect(text).toContain("no MUON_API_BASE");
    expect(text).toContain("no MUON_MCP_MODE");
  });

  it("install claude names the seat it DOES hold", async () => {
    const h = harness();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const argv = process.argv[1];
    process.argv[1] = "/opt/muon/bin/muon";
    try {
      await run(["mcp", "install", "claude"], h);
    } finally {
      process.argv[1] = argv;
    }
    const text = out.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("holds the coordinator seat");
  });

  it("installs the read-only observer and chat partition explicitly", async () => {
    const h = harness();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const argv = process.argv[1];
    process.argv[1] = "/opt/muon/bin/muon";
    try {
      await run(
        [
          "mcp",
          "install",
          "cursor",
          "--mode",
          "observer",
          "--chat",
          "chat-a",
        ],
        h
      );
    } finally {
      process.argv[1] = argv;
    }
    const text = out.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("MUON_MCP_MODE=observer");
    expect(text).toContain("MUON_CHAT_ID=chat-a");
    expect(text).toContain("37 tools"); // +2: ADR-0043 question_ask/question_status
    expect(text).toContain("no dispatch, steer, interrupt");
  });

  it("refuses authority-bearing install modes", async () => {
    const h = harness();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await run(["mcp", "install", "cursor", "--mode", "orchestrator"], h);
    expect(err.mock.calls.map((call) => String(call[0])).join(""))
      .toContain("authority-bearing modes cannot be installed");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(h.spawns).toHaveLength(0);
  });

  it("refuses --scope local by name, and says why", async () => {
    const h = harness();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await run(["mcp", "install", "claude", "--scope", "local"], h);
    const text = err.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("does not install at 'local' scope");
    expect(text).toContain("per-directory");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(h.spawns).toHaveLength(0);
  });

  it("refuses an unknown vendor and lists the ones it can install", async () => {
    const h = harness();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await run(["mcp", "install", "nope"], h);
    const text = err.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("Unknown vendor 'nope'");
    expect(text).toContain("opencode");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("refuses when muon-mcp cannot be resolved, and lists what it searched", async () => {
    const h = harness();
    h.io.isExecutableFile = () => false;
    h.io.which = () => null;
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await run(["mcp", "install", "cursor"], h);
    const text = err.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("Could not find an executable 'muon-mcp'");
    expect(text).toContain("does not write a bare 'muon-mcp'");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(fs.existsSync(path.join(h.home, ".cursor", "mcp.json"))).toBe(false);
  });
});
