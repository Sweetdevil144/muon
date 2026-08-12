import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTALLABLE_VENDORS,
  installMcpServer,
  type McpVendorIo,
} from "../src/mcp-vendor-config.js";

const CLAUDE = INSTALLABLE_VENDORS.find((s) => s.id === "claude-code")!;

// `claude mcp add` refuses an existing name, so UPDATING claude's entry is a
// remove-then-add. If the add then fails, the vendor is left with NO muon
// server at all — strictly worse than before a command that documents itself as
// idempotent. The realistic trigger is ordinary: a MUON reinstall moves the
// recorded `muon-mcp` path, so every install becomes an update.

type Spawn = { command: string; args: string[] };

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "muon-mcp-rollback-"));
}

const MCP_BIN = "/opt/muon/bin/muon-mcp";

/**
 * A claude-shaped io whose `mcp add` fails ONCE (the update) and succeeds on
 * the restore, so the test observes the rollback rather than a happy path.
 */
function harness(failAdds: number) {
  const home = tempHome();
  const configPath = path.join(home, ".claude.json");
  const spawns: Spawn[] = [];
  let addsSeen = 0;
  // A pre-existing entry: this is what makes the write an UPDATE.
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        muon: { command: "/old/path/muon-mcp", args: [], env: {} },
      },
    })
  );
  const io: McpVendorIo = {
    roots: {
      home,
      configHome: path.join(home, ".config"),
      cwd: home,
      redirectVendorConfigDirs: true,
    },
    run: (command, args) => {
      spawns.push({ command, args });
      if (args[1] === "remove") {
        const doc = JSON.parse(fs.readFileSync(configPath, "utf8"));
        delete doc.mcpServers.muon;
        fs.writeFileSync(configPath, JSON.stringify(doc));
        return { code: 0, stdout: "Removed", stderr: "", spawnFailed: false };
      }
      if (args[1] === "add") {
        addsSeen += 1;
        if (addsSeen <= failAdds) {
          return {
            code: 1,
            stdout: "",
            stderr: "boom",
            spawnFailed: false,
          };
        }
        const doc = JSON.parse(fs.readFileSync(configPath, "utf8"));
        doc.mcpServers.muon = {
          command: args[args.length - 1],
          args: [],
          env: {},
        };
        fs.writeFileSync(configPath, JSON.stringify(doc));
        return { code: 0, stdout: "Added", stderr: "", spawnFailed: false };
      }
      throw new Error(`unexpected spawn: ${command} ${args.join(" ")}`);
    },
    which: (command) => `/usr/local/bin/${command}`,
    isExecutableFile: (p) => p === MCP_BIN,
  };
  return { io, home, configPath, spawns };
}

describe("mcp install rollback (vendor-CLI writer)", () => {
  it("restores the previous entry when the update's add fails", () => {
    const h = harness(1);
    const result = installMcpServer(h.io, {
      spec: CLAUDE,
      scope: CLAUDE.defaultScope,
      command: MCP_BIN,
      dryRun: false,
    });

    expect(result.kind).toBe("refused");
    // The refusal SAYS the entry came back — a caller must not have to guess.
    if (result.kind === "refused") {
      expect(result.reason).toMatch(/previous entry was restored/i);
    }
    // …and it really did: the vendor still has a muon server.
    const doc = JSON.parse(fs.readFileSync(h.configPath, "utf8"));
    expect(doc.mcpServers.muon.command).toBe("/old/path/muon-mcp");
    fs.rmSync(h.home, { recursive: true, force: true });
  });

  it("says so plainly when the restore ALSO fails — never implies it worked", () => {
    const h = harness(2); // both the update and the restore fail
    const result = installMcpServer(h.io, {
      spec: CLAUDE,
      scope: CLAUDE.defaultScope,
      command: MCP_BIN,
      dryRun: false,
    });

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.reason).toMatch(/could NOT be restored/i);
    }
    fs.rmSync(h.home, { recursive: true, force: true });
  });
});
