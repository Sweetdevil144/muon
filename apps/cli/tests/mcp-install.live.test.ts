import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultVendorIo,
  installMcpServer,
  resolveInstallableVendor,
  resolveMuonMcpCommand,
  uninstallMcpServer,
  type McpVendorIo,
} from "@muon/client/mcp-vendor-config";

/**
 * OPT-IN live verification of the vendor writers, S1 of
 * docs/design/cc-as-superagent-delivery.md §2.2 D-writer.
 *
 * WHY THIS EXISTS SEPARATELY. `mcp-install.test.ts` drives a faithful MODEL of
 * each vendor CLI, which is fast, hermetic and CI-safe — and is a model, so it
 * cannot notice the vendor changing its behaviour. This file runs the REAL
 * binaries. Two of the three vendor behaviours S1 depends on are
 * counter-intuitive enough that inferring them from `--help` would have been
 * wrong (`claude mcp add` exits 1 on an existing name; `cursor-agent` exits 0
 * while logged OUT), so the real thing has to be exercised somewhere.
 *
 * It is OFF by default (`MUON_TEST_VENDOR_CLIS=1` to enable) because it spawns
 * third-party binaries whose presence and version are properties of the machine,
 * not of the change under test.
 *
 * SAFETY. Every run is rooted at a fresh mkdtemp with
 * `redirectVendorConfigDirs: true`, so each vendor's own config-dir override
 * (CLAUDE_CONFIG_DIR / CODEX_HOME / HOME) points into that temp dir. Nothing
 * under the operator's real `~/.claude`, `~/.codex`, `~/.cursor` or
 * `~/.config/opencode` is written. The assertions below re-read only the temp
 * paths, so a seam regression would fail rather than silently pass.
 */

const LIVE = process.env.MUON_TEST_VENDOR_CLIS === "1";
/** These spawn third-party binaries; several take seconds on a cold start. */
const LIVE_TIMEOUT_MS = 180_000;
const describeLive = LIVE ? describe : describe.skip;

const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
});

/**
 * The REAL runner/which/exec probes, with ONLY `roots` overridden — a spread of
 * the actual factory rather than a hand-enumerated stand-in, so a new field on
 * `McpVendorIo` cannot silently go missing here.
 */
function liveIo(): McpVendorIo {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muon-mcp-live-"));
  tempRoots.push(home);
  const cwd = path.join(home, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  const base = defaultVendorIo();
  return {
    ...base,
    roots: {
      home,
      configHome: path.join(home, ".config"),
      cwd,
      redirectVendorConfigDirs: true,
    },
  };
}

function realMuonMcp(io: McpVendorIo): string {
  const resolved = resolveMuonMcpCommand(io);
  if (!resolved.ok) {
    throw new Error(
      `this machine has no resolvable muon-mcp; searched ${resolved.searched.join(", ")}`
    );
  }
  return resolved.command;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

describeLive("live vendor writers (MUON_TEST_VENDOR_CLIS=1)", () => {
  it("claude: writes user scope, is idempotent, and leaves a foreign entry alone", () => {
    const io = liveIo();
    if (!io.which("claude")) {
      return;
    }
    const spec = resolveInstallableVendor("claude")!;
    const command = realMuonMcp(io);
    const configPath = path.join(io.roots.home, ".claude.json");

    // Seed a foreign user-scope server through the vendor's own writer, so the
    // starting state is one the vendor itself produced.
    const seeded = io.run(
      "claude",
      ["mcp", "add", "not-muon", "-s", "user", "--", "/bin/echo"],
      { CLAUDE_CONFIG_DIR: io.roots.home }
    );
    expect(seeded.code).toBe(0);

    const first = installMcpServer(io, { spec, scope: "user", command, dryRun: false });
    expect(first.kind).toBe("written");
    const afterFirst = fs.readFileSync(configPath);
    const doc = readJson(configPath);
    // Top-level `mcpServers` (user scope), NOT `projects.<cwd>` (local scope).
    expect((doc.mcpServers as Record<string, unknown>).muon).toMatchObject({
      command,
    });
    expect(doc.projects).toBeUndefined();

    const second = installMcpServer(io, { spec, scope: "user", command, dryRun: false });
    expect(second.kind).toBe("already-current");
    expect(fs.readFileSync(configPath).equals(afterFirst)).toBe(true);

    const removed = uninstallMcpServer(io, spec, "user");
    expect(removed.kind).toBe("removed");
    const after = readJson(configPath);
    expect((after.mcpServers as Record<string, unknown>).muon).toBeUndefined();
    expect((after.mcpServers as Record<string, unknown>)["not-muon"]).toBeDefined();

    // Nothing was written into the real home.
    expect(fs.existsSync(path.join(os.homedir(), ".claude.json"))).toBe(true);
  }, LIVE_TIMEOUT_MS);

  it("claude: pins the two exit codes install's branching depends on", () => {
    // If a future claude makes `add` overwrite at rc 0, this test says so rather
    // than letting the remove-then-add branch rot unnoticed.
    const io = liveIo();
    if (!io.which("claude")) {
      return;
    }
    const env = { CLAUDE_CONFIG_DIR: io.roots.home };
    const args = ["mcp", "add", "muon", "-s", "user", "--", "/bin/echo"];
    expect(io.run("claude", args, env).code).toBe(0);
    // rc 1 on an existing name: the whole reason an UPDATE needs a remove first.
    expect(io.run("claude", args, env).code).toBe(1);
    const removeArgs = ["mcp", "remove", "muon", "-s", "user"];
    expect(io.run("claude", removeArgs, env).code).toBe(0);
    // And rc 1 when it was ALREADY absent — so rc 1 from `remove` means both
    // "was not there" and "could not remove". This is exactly why install treats
    // a failed remove as a note and lets `add` (and uninstall's read-back) be the
    // gate. An earlier hand-read of this probe recorded rc 0 because the shell
    // pipeline's status was being read instead of claude's.
    expect(io.run("claude", removeArgs, env).code).toBe(1);
  }, LIVE_TIMEOUT_MS);

  it("codex: writes the global TOML section and overwrites in place at rc 0", () => {
    const io = liveIo();
    if (!io.which("codex")) {
      return;
    }
    const spec = resolveInstallableVendor("codex")!;
    const command = realMuonMcp(io);
    const configPath = path.join(io.roots.home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      'model = "keep-me"\n\n[mcp_servers.not-muon]\ncommand = "/bin/echo"\n'
    );

    expect(
      installMcpServer(io, { spec, scope: "user", command, dryRun: false }).kind
    ).toBe("written");
    const afterFirst = fs.readFileSync(configPath);
    expect(afterFirst.toString()).toContain("[mcp_servers.muon]");

    expect(
      installMcpServer(io, { spec, scope: "user", command, dryRun: false }).kind
    ).toBe("already-current");
    expect(fs.readFileSync(configPath).equals(afterFirst)).toBe(true);

    expect(uninstallMcpServer(io, spec, "user").kind).toBe("removed");
    const after = fs.readFileSync(configPath, "utf8");
    expect(after).not.toContain("[mcp_servers.muon]");
    expect(after).toContain("[mcp_servers.not-muon]");
    expect(after).toContain('model = "keep-me"');
  }, LIVE_TIMEOUT_MS);

  it("cursor: MUON's JSON write is accepted by cursor-agent, and enable is a no-op", () => {
    const io = liveIo();
    if (!io.which("cursor-agent")) {
      return;
    }
    const spec = resolveInstallableVendor("cursor")!;
    const command = realMuonMcp(io);
    const outcome = installMcpServer(io, {
      spec,
      scope: "user",
      command,
      dryRun: false,
    });
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;
    expect(outcome.followUps.join(" ")).toContain("mcp enable muon");

    // cursor-agent's own reader must see it. NOTE its exit code is 0 even when
    // logged out, so the OUTPUT is the evidence, not the code.
    const listed = io.run("cursor-agent", ["mcp", "list"], { HOME: io.roots.home });
    expect(listed.stdout + listed.stderr).toContain("muon");

    expect(uninstallMcpServer(io, spec, "user").kind).toBe("removed");
  }, LIVE_TIMEOUT_MS);

  it("opencode: MUON's JSON write is reported as connected by opencode's own reader", () => {
    const io = liveIo();
    if (!io.which("opencode")) {
      return;
    }
    const spec = resolveInstallableVendor("opencode")!;
    const command = realMuonMcp(io);
    expect(
      installMcpServer(io, { spec, scope: "user", command, dryRun: false }).kind
    ).toBe("written");

    const listed = io.run("opencode", ["mcp", "list"], {
      XDG_CONFIG_HOME: io.roots.configHome,
    });
    // This is the whole reason opencode is claimed at all: its own reader
    // confirms the shape MUON writes.
    expect(listed.stdout + listed.stderr).toContain("muon");

    expect(uninstallMcpServer(io, spec, "user").kind).toBe("removed");
  }, LIVE_TIMEOUT_MS);
});
